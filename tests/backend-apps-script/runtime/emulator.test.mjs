import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createFirestoreAdapter,toFirestoreValue,fromFirestoreValue} from '../../../backend/apps-script/runtime/adapters.mjs';
import {normalizeClient,publicSnapshot,prepareSecureSave} from '../../../portal/data.js';
import {REVIEW_POLICY} from '../../../portal/review-policy.js';
import {prepareNotificationSave} from '../../../portal/notification-publication.js';

const project='demo-visionflow-runtime';
const root=`projects/${project}/databases/(default)/documents`;
// UrlFetchApp is synchronous. Use a separate bounded local Node process for the
// real REST transport; adapter URLs/payloads/response conversion stay untouched.
const child=`import{readFileSync}from'node:fs';const q=JSON.parse(readFileSync(0,'utf8'));if(!q.url.startsWith('http://127.0.0.1:8088/v1/projects/demo-visionflow-runtime/'))throw Error('Non-demo request forbidden');const r=await fetch(q.url,{method:q.method,headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:q.body,signal:AbortSignal.timeout(8000)});process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}));`;
const calls=[];
const urlFetch={fetch:(url,options)=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  assert.ok(url.startsWith(`https://firestore.googleapis.com/v1/projects/${project}/`));
  assert.equal(options.headers.Authorization,'Bearer synthetic-owner');
  calls.push({url,options});
  const result=spawnSync(process.execPath,['--input-type=module','-e',child],{input:JSON.stringify({url:url.replace('https://firestore.googleapis.com','http://127.0.0.1:8088'),method:options.method||'GET',body:options.payload}),encoding:'utf8',timeout:10000,windowsHide:true});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout);
  return {getResponseCode:()=>response.status,getContentText:()=>response.body};
}};
const scriptApp={getOAuthToken:()=> 'synthetic-owner'};

test('built owner diagnostic uses only bounded reads through the actual REST adapter',{timeout:30000},async()=>{
  const props={PROJECT_ID:project,ADMIN_UID:'synthetic',ACTIVATION_BOUNDARY:'2026-09-28T00:00:00Z',EXPECTED_SENDER:'synthetic@example.invalid'},logs=[];
  const context={UrlFetchApp:urlFetch,ScriptApp:{...scriptApp,AuthorizationStatus:{NOT_REQUIRED:'granted'},AuthMode:{FULL:'full'},getAuthorizationInfo:()=>({getAuthorizationStatus:()=> 'granted'}),getProjectTriggers:()=>[],EventType:{CLOCK:'clock'}},
    Session:{getEffectiveUser:()=>({getEmail:()=> 'synthetic@example.invalid'})},
    PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:key=>props[key]})},Logger:{log:value=>logs.push(value)},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:()=>assert.fail('no real mail')}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  const start=calls.length,report=await context.ownerReadinessCheck();
  assert.equal(report.readChecksPassed,true);assert.equal(report.productionReady,false);assert.equal(report.checks.senderIdentity.status,'pass');
  assert.equal(report.checks.ownedTriggers.workerCount,0);assert.equal(logs.length,1);
  assert.equal(calls.length-start,6);
  for(const call of calls.slice(start)){
    assert.ok(!call.options.method||call.options.method==='POST'&&call.url.endsWith(':runQuery'));
    if(call.options.payload)assert.equal(JSON.parse(call.options.payload).structuredQuery.limit,1);
  }
});

test('actual runtime REST adapter preserves types, preconditions, paging and atomic rollback',{timeout:60000},async()=>{
  const fs=createFirestoreAdapter({urlFetch,scriptApp,projectId:project});
  const id=encodeURIComponent(JSON.stringify(['delivery','p/1','v1']));
  const path='runtime/'+id,iso='2026-09-28T12:00:00.123456Z';
  await fs.set(path,{id:'business-id',text:iso,stamp:fromFirestoreValue({timestampValue:iso}),nested:{_path:'business-field'},'dotted.key':'preserved'},{exists:false});
  const first=await fs.get(path);
  assert.equal(first.id,'business-id');assert.equal(first.text,iso);
  assert.deepEqual(toFirestoreValue(first.stamp),{timestampValue:iso});
  assert.equal(first.nested._path,'business-field');
  assert.equal((await fs.query('runtime'))[0].id,id);
  await fs.set(path,{'dotted.key':'updated'},{merge:true,precondition:{updateTime:first._updateTime}});
  await assert.rejects(fs.set(path,{text:'stale'},{merge:true,precondition:{updateTime:first._updateTime}}),/Firestore REST/);
  assert.equal((await fs.get(path)).text,iso);assert.equal((await fs.get(path))['dotted.key'],'updated');
  const updated=await fs.get(path);
  await fs.set(path,{only:'replacement'},{precondition:{updateTime:updated._updateTime}});
  assert.equal((await fs.get(path)).text,undefined);
  assert.equal(await fs.get('runtime/missing'),null);
  await fs.set('runtime/empty',{});assert.ok(await fs.get('runtime/empty'));
  for(const id of ['a','b','c'])await fs.set('paging/'+id,{rank:1});
  const orderBy=[['rank','asc'],['__name__','asc']];
  const page1=await fs.query('paging',{orderBy,limit:1});assert.equal(page1[0].id,'a');
  const page2=await fs.query('paging',{orderBy,limit:1,startAfter:{values:[{integerValue:'1'},{referenceValue:root+'/paging/a'}]}});
  assert.equal(page2[0].id,'b');
  const namedPage=await fs.query('paging',{orderBy:['__name__','asc'],limit:1,startAfterId:'b'});
  assert.equal(namedPage[0].id,'c');
  await fs.set('parents/p/events/a',{rank:1});
  await fs.set('parents/p/events/b',{rank:2});
  const matched=await fs.runTransaction(tx=>tx.query('parents/p/events',{where:[['rank','>=',2]],limit:1}));
  assert.equal(matched[0].id,'b');assert.ok(calls.at(-1).url.endsWith(':rollback'));
  await assert.rejects(fs.runTransaction(async tx=>{
    assert.equal((await tx.get(path)).only,'replacement');
    tx.set('runtime/atomic',{shouldNotExist:true},{exists:false});
    tx.set(path,{collision:true},{precondition:{exists:false}});
  }),/Firestore REST/);
  assert.equal(await fs.get('runtime/atomic'),null);
  await fs.runTransaction(async tx=>{const current=await tx.get(path);tx.set(path,{only:'committed'},{merge:true,precondition:{updateTime:current._updateTime}});});
  assert.equal((await fs.get(path)).only,'committed');
});

test('built Code.gs executes actual review worker with actual adapter REST transactions',{timeout:60000},async()=>{
  const fs=createFirestoreAdapter({urlFetch,scriptApp,projectId:project});
  const client=normalizeClient({name:'Synthetic runtime',accessToken:'runtime-token',reviewEpoch:0,projects:{p:{name:'Project',budget:400,rate:400,items:[]}}},'runtime-client');
  prepareSecureSave(client);const portal=publicSnapshot(client,'runtime-client');
  const request={id:'runtime-review',portalToken:'runtime-token',clientSlug:'runtime-client',projectKey:'p',sourceId:'approval',sourceVersion:'v1',reviewEpoch:0,schemaVersion:1,policyVersion:REVIEW_POLICY.version,reviewHours:72,masterVersion:portal.masterAgreement.version,publishedAt:'2026-09-28T00:00:00Z',status:'pending',notificationSent:true,portalNoticeShown:true};
  portal.projects.p.notificationRevision=1;
  await fs.set('portal_clients/runtime-client',client);
  await fs.set('portal_public/runtime-token',portal);
  await fs.set('portal_public/runtime-token/consent/'+portal.consentTerms.version,{termsSnapshot:portal.consentTerms});
  await fs.set('portal_public/runtime-token/agreements/'+portal.masterAgreement.version,{name:'Synthetic signer',signedAt:'2026-09-27T00:00:00Z',termsSnapshot:portal.masterAgreement,projectTerms:portal.projectTerms});
  const noticeRevision=portal.projects?.p?.notificationRevision||1;
  const runtimeRequest={...request,sourceCollection:'portal_public/runtime-token/notices',projectRevision:noticeRevision};
  await fs.set('portal_public/runtime-token/notices/approval',{schemaVersion:1,eventType:'project-notification',clientSlug:'runtime-client',projectKey:'p',version:'v1',reviewEpoch:0,projectRevision:noticeRevision,createdAt:'2026-09-28T00:00:00Z'});
  await fs.set('portal_reviews/runtime-review',runtimeRequest);
  await fs.set('portal_public/runtime-token/reviews/runtime-review',{requestId:'runtime-review',projectKey:'p',sourceVersion:'v1',publishedAt:request.publishedAt,status:'pending',revision:0});
  await fs.set('portal_public/runtime-token/review_guards/p',{revision:0});
  const props={ENABLED:'true',REVIEW_STATE_READY:'true',PROJECT_ID:project,ADMIN_UID:'synthetic',ACTIVATION_BOUNDARY:'2026-09-28T00:00:00Z'};
  const context={UrlFetchApp:urlFetch,ScriptApp:scriptApp,PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:key=>props[key]})},Logger:{log:()=>{}},MailApp:{getRemainingDailyQuota:()=>1,sendEmail:()=>{throw Error('Test must never send email.');}}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  context.createClockAdapter=()=>({now:()=> '2026-10-01T00:00:00Z'});
  const result=await context.scheduledWorker();
  assert.equal(result.outbox.processed,0);
  assert.equal(result.reviews.results[0].status,'deemed-accepted');
  const outcome=await fs.get('portal_public/runtime-token/reviews/runtime-review');
  assert.equal(outcome.status,'deemed-accepted');assert.equal(outcome.confirmedAt,undefined);
  assert.equal(await fs.get('portal_public/runtime-token/confirms/approval'),null);
  assert.equal((await fs.query('portal_outbox')).length,1);
});

test('built runtime activates a newly published notice only after both client handoffs and current signature',{timeout:90000},async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  await fetch(`http://127.0.0.1:8088/emulator/v1/projects/${project}/databases/(default)/documents`,{method:'DELETE'});
  const fs=createFirestoreAdapter({urlFetch,scriptApp,projectId:project,maxCalls:300}),at='2026-10-01T12:00:00.000Z';
  const token='activation-runtime',publicRoot=`portal_public/${token}`,id='save-live-p';
  const client=normalizeClient({name:'Synthetic activation',email:'synthetic@example.invalid',accessToken:token,reviewEpoch:0,_lastMutationId:'save-live',projects:{p:{name:'Test',items:[],rate:400,budget:400}}},'runtime-client');
  prepareSecureSave(client);const plan=prepareNotificationSave(client,{},{timestamp:fromFirestoreValue({timestampValue:at})}),portal=publicSnapshot(client,client.slug);
  await fs.set('portal_clients/runtime-client',client);await fs.set(publicRoot,portal);
  await fs.set('portal_settings/notifications',{enabled:true,clientEnabled:true,adminEnabled:false});
  for(const w of plan.writes)await fs.set(w.path,w.data);await fs.set(`${publicRoot}/review_guards/p`,{revision:0});
  const props={ENABLED:'true',REVIEW_STATE_READY:'true',PROJECT_ID:project,ADMIN_UID:'synthetic',ACTIVATION_BOUNDARY:at,EXPECTED_SENDER:'owner@example.invalid'},messages=[];
  const context={UrlFetchApp:urlFetch,ScriptApp:scriptApp,PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:key=>props[key]})},Logger:{log:()=>{}},MailApp:{getRemainingDailyQuota:()=>100,sendEmail:message=>messages.push(message)}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  let now=at;context.createClockAdapter=()=>({now:()=>now});
  context.Session={getEffectiveUser:()=>({getEmail:()=> 'owner@example.invalid'})};
  await context.scheduledWorker();assert.equal(messages.length,1);assert.equal((await fs.get('portal_reviews/'+id)).status,'awaiting-notification');
  now='2026-10-05T12:00:00.000Z';
  await fs.set(`${publicRoot}/consent/${portal.consentTerms.version}`,{termsSnapshot:portal.consentTerms,agreedAt:now});
  await fs.set(`${publicRoot}/agreements/${portal.masterAgreement.version}`,{termsSnapshot:portal.masterAgreement,projectTerms:portal.projectTerms,signedAt:now});
  await context.scheduledWorker();assert.equal(messages.length,1);assert.equal((await fs.get('portal_reviews/'+id)).status,'awaiting-review-notification');
  await context.scheduledWorker();assert.equal(messages.length,2);
  const request=await fs.get('portal_reviews/'+id);assert.equal(request.status,'pending');assert.equal(request.publishedAt,now);assert.equal(request.deadline,'2026-10-08T12:00:00.000Z');
  assert.match(messages[1].body,/at least until 2026-10-08T12:00:00.000Z/);
  assert.equal((await fs.get(`${publicRoot}/reviews/${id}`)).publishedAt,now);
  now=request.deadline;await context.scheduledWorker();assert.equal((await fs.get('portal_reviews/'+id)).status,'deemed-accepted');
  assert.equal((await fs.query('portal_outbox')).filter(e=>e.eventType==='deemed-accepted').length,1);
});

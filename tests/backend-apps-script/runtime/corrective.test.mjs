import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import {createFirestoreAdapter,createMailAdapter,toFirestoreValue,fromFirestoreValue,toDocumentFields} from '../../../backend/apps-script/runtime/adapters.mjs';
const adapter=handler=>createFirestoreAdapter({projectId:'demo-runtime',scriptApp:{getOAuthToken:()=> 'synthetic'},urlFetch:{fetch:(url,options)=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(handler(url,options))})}});
test('all query endpoints are absolute HTTPS including transactional nested queries',async()=>{
  const fs=adapter((url)=>{assert.match(url,/^https:\/\/firestore.googleapis.com\/v1\/projects\//);return url.endsWith(':beginTransaction')?{transaction:'tx'}:[];});
  await fs.query('events');await fs.runTransaction(tx=>tx.query('portal_public/token/reviews'));
});
test('ISO text remains text and timestamps retain submillisecond precision',()=>{
  const iso='2026-09-28T12:00:00.123456789Z';
  assert.deepEqual(toFirestoreValue(iso),{stringValue:iso});
  assert.deepEqual(toFirestoreValue(fromFirestoreValue({timestampValue:iso})),{timestampValue:iso});
  assert.deepEqual(toDocumentFields({id:'business-id'}),{id:{stringValue:'business-id'}});
});
test('read-only transactions release their locks',async()=>{
  const calls=[],fs=adapter(url=>{calls.push(url);return url.endsWith(':beginTransaction')?{transaction:'tx'}:[];});
  await fs.runTransaction(()=>{});assert.ok(calls.some(url=>url.endsWith(':rollback')));
});
test('provider exception text is never proof that mail was not accepted',async()=>{
  const mail=createMailAdapter({expectedSender:'owner@example.invalid',session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.invalid'})},mailApp:{sendEmail:()=>{throw Error('daily limit exceeded');}}});
  await assert.rejects(mail.send({to:'synthetic@example.invalid'}),e=>e.notAccepted!==true);
});
test('built scheduled entrypoint awaits completion and returns result, with no overlap',async()=>{
  const context={PropertiesService:{getScriptProperties:()=>({getProperties:()=>({ENABLED:'true',PROJECT_ID:'demo-runtime',ADMIN_UID:'synthetic',ACTIVATION_BOUNDARY:'2026-09-28T00:00:00Z'}),getProperty:()=>''})},Logger:{log:()=>{}},UrlFetchApp:{},ScriptApp:{},MailApp:{}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  const order=[];context.processOutbox=async()=>{order.push('outbox-start');await Promise.resolve();order.push('outbox-end');return {ok:true,processed:2};};
  context.settleReviewTimers=async()=>{order.push('review');return {processed:1};};
  const result=await context.scheduledWorker();
  assert.deepEqual(order,['outbox-start','outbox-end','review']);assert.equal(result.outbox.processed,2);
});
test('nested business metadata and typed values survive round trips',()=>{
  const map={id:'business',nested:{_path:'keep',_updateTime:'also keep'}};
  assert.deepEqual(fromFirestoreValue(toFirestoreValue(map)),map);
  for(const wire of [{integerValue:'9223372036854775807'},{bytesValue:'AAEC'},{referenceValue:'projects/p/databases/(default)/documents/c/d'},{geoPointValue:{latitude:2,longitude:3}}])assert.deepEqual(toFirestoreValue(fromFirestoreValue(wire)),wire);
  assert.throws(()=>toFirestoreValue(Number.MAX_SAFE_INTEGER+1),/Unsafe/);
  assert.throws(()=>toFirestoreValue({seconds:1,nanoseconds:1e9}),/Invalid/);
});
test('request count and elapsed time are bounded, transaction cleanup still runs',async()=>{
  let time=0;const calls=[];
  const fs=createFirestoreAdapter({projectId:'demo-runtime',now:()=>time,maxCalls:1,maxRuntimeMs:100,scriptApp:{getOAuthToken:()=> 'synthetic'},urlFetch:{fetch:url=>{calls.push(url);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(url.endsWith(':beginTransaction')?{transaction:'tx'}:[])};}}});
  await assert.rejects(fs.runTransaction(tx=>tx.get('c/d')),/budget/);
  assert.ok(calls.at(-1).endsWith(':rollback'));assert.equal(calls.length,2);
  const expired=createFirestoreAdapter({projectId:'demo-runtime',now:()=>time,maxRuntimeMs:100,urlFetch:{fetch:()=>assert.fail('must not fetch')},scriptApp:{getOAuthToken:()=>assert.fail('must not read token')}});
  time=100;await assert.rejects(expired.get('c/d'),/budget/);
});
test('private HTTP and transport error details are not exposed',async()=>{
  for(const mode of ['http','transport','json']){
    const fs=createFirestoreAdapter({projectId:'demo-runtime',scriptApp:{getOAuthToken:()=> 'synthetic'},urlFetch:{fetch:()=>{if(mode==='transport')throw Error('private-content');return {getResponseCode:()=>mode==='http'?403:200,getContentText:()=> 'private-content'};}}});
    await assert.rejects(fs.get('c/d'),error=>!error.message.includes('private-content'));
  }
});
test('invalid query operators and document paths fail without HTTP',async()=>{
  const fs=adapter(()=>assert.fail('must not fetch'));
  await assert.rejects(fs.get('c/../x/d'),/Invalid/);
  await assert.rejects(fs.query('c',{where:[['x','contains-secret',1]]}),/Unsupported/);
  await assert.rejects(fs.set('c/d',{}, {merge:true}),/Empty/);
  await assert.rejects(fs.set('c/d',{x:1}, {precondition:{exists:true,updateTime:'ambiguous'}}),/Invalid/);
});

test('Firestore diagnostics allow only fixed provider reasons and omit private metadata',async()=>{
  for(const reason of ['IAM_PERMISSION_DENIED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','SERVICE_DISABLED','CONSUMER_INVALID','private-token']){
    const fs=createFirestoreAdapter({projectId:'demo-runtime',scriptApp:{getOAuthToken:()=> 'synthetic'},urlFetch:{fetch:()=>({getResponseCode:()=>403,getContentText:()=>JSON.stringify({error:{message:'private-record',details:[{reason,metadata:{secret:'private-token'}}]}})})}});
    await assert.rejects(fs.get('c/d'),error=>{
      assert.equal(error.httpCode,403);assert.equal(error.reason,reason==='private-token'?undefined:reason);
      assert.doesNotMatch(JSON.stringify(error),/private-token|private-record/);return true;
    });
  }
});
test('built public endpoints invoke the tested worker logic with no database or mail access',()=>{
  const context={ContentService:{MimeType:{JSON:'json'},createTextOutput:body=>({body,setMimeType:function(mime){this.mime=mime;return this;}})},PropertiesService:{getScriptProperties:()=>({getProperties:()=>({})})}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  for(const body of ['{}','{','{"action":"enqueue","idToken":"fake","to":"external@example.invalid"}']){
    const response=context.doPost({postData:{contents:body}});assert.equal(response.mime,'json');assert.equal(JSON.parse(response.body).ok,false);
  }
  assert.equal(JSON.parse(context.doGet({}).body).status,'healthy');
});
test('built worker remains disabled without explicit config and propagates async failure',async()=>{
  const props={},context={Logger:{log:()=>{}},PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:()=>''})}};
  runInNewContext(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),context);
  assert.equal((await context.scheduledWorker()).disabled,true);
  props.ENABLED='true';await assert.rejects(context.scheduledWorker(),/configuration/);
  Object.assign(props,{PROJECT_ID:'demo-runtime',ADMIN_UID:'synthetic',ACTIVATION_BOUNDARY:'2026-09-28T00:00:00Z'});
  Object.assign(context,{UrlFetchApp:{},ScriptApp:{},MailApp:{},processOutbox:async()=>{await Promise.resolve();throw Error('test-failure');},settleReviewTimers:()=>assert.fail('must not overlap or run after failure')});
  await assert.rejects(context.scheduledWorker(),/test-failure/);
});
test('build is reproducible for identical inputs',()=>{
  const before=readFileSync('backend/apps-script/runtime/Code.gs','utf8');
  const result=spawnSync(process.execPath,['backend/apps-script/runtime/build.mjs'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync('backend/apps-script/runtime/Code.gs','utf8'),before);
});
test('built retry delay avoids numeric separators rejected by the Apps Script editor parser',()=>{
  const source=readFileSync('backend/apps-script/runtime/Code.gs','utf8');
  assert.match(source,/const BACKOFF_BASE_MS = 30000;/);
  assert.doesNotMatch(source,/\b\d[\d]*_\d/);
});
test('missing transaction identity never degrades to an unguarded write',async()=>{
  let ran=false;
  await assert.rejects(adapter(()=>({})).runTransaction(()=>{ran=true;}),/transaction identity/);
  assert.equal(ran,false);
});
test('invalid quota fails closed',async()=>{
  for(const quota of [NaN,Infinity,-1,'100',undefined])assert.equal(await createMailAdapter({mailApp:{getRemainingDailyQuota:()=>quota}}).remainingQuota(),0);
});

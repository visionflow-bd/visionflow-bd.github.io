import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processReviewTimers} from '../../backend/apps-script/worker.mjs';
import {notificationEventId} from '../../backend/apps-script/source-binding.mjs';
import {normalizeClient,publicSnapshot,prepareSecureSave} from '../../portal/data.js';
import {REVIEW_POLICY} from '../../portal/review-policy.js';

test('actual worker review transaction respects current terms, objections and concurrent client writes',{timeout:60000},async()=>{
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  const root='projects/demo-visionflow-backend/databases/(default)/documents',url='http://127.0.0.1:8088/v1/'+root;
  const encode=x=>x===null?{nullValue:null}:typeof x==='string'?{stringValue:x}:typeof x==='boolean'?{booleanValue:x}:typeof x==='number'?{integerValue:String(x)}:Array.isArray(x)?{arrayValue:{values:x.map(encode)}}:{mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encode(v)]))}};
  const decode=x=>x.mapValue?Object.fromEntries(Object.entries(x.mapValue.fields||{}).map(([k,v])=>[k,decode(v)])):x.arrayValue?(x.arrayValue.values||[]).map(decode):x.integerValue!==undefined?Number(x.integerValue):x.timestampValue??x.stringValue??x.booleanValue??null;
  async function api(suffix,method='GET',body){const r=await fetch(url+suffix,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer owner','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status===404)return null;const data=await r.json();if(!r.ok)throw Error(data.error?.status||'REST failure');return data;}
  const write=(p,data,opts={})=>({update:{name:root+'/'+p,fields:encode(data).mapValue.fields},...(opts.merge?{updateMask:{fieldPaths:Object.keys(data)}}:{}),...(opts.exists===false?{currentDocument:{exists:false}}:{})});
  const put=(p,data)=>api(':commit','POST',{writes:[write(p,data)]});
  // batchGet carries the bytes transaction ID in JSON; the emulator's GET
  // query-parameter adapter cannot decode that bytes field (BYTE_STRING).
  const get=async(p,transaction)=>{const d=transaction?(await api(':batchGet','POST',{documents:[root+'/'+p],transaction})).find(r=>r.found)?.found:await api('/'+encodeURI(p));return d?{...decode({mapValue:{fields:d.fields}}),id:d.name.split('/').at(-1)}:null;};
  const query=async(p,options={},transaction)=>{
    const pieces=p.split('/'),collection=pieces.pop(),parent=pieces.length?'/'+pieces.join('/'):'';
    const filters=(options.where||[]).map(([field,op,value])=>({fieldFilter:{field:{fieldPath:field},op:op==='in'?'IN':'EQUAL',value:encode(value)}}));
    const structuredQuery={from:[{collectionId:collection}],...(filters.length?{where:filters.length===1?filters[0]:{compositeFilter:{op:'AND',filters}}}:{}),...(options.limit?{limit:options.limit}:{})};
    const result=await api(parent+':runQuery','POST',{structuredQuery,...(transaction?{transaction}:{})});
    return result.filter(r=>r.document).map(r=>({...decode({mapValue:{fields:r.document.fields}}),id:r.document.name.split('/').at(-1)}));
  };
  let beforeTransaction=null;
  const firestore={get,query,set:put,runTransaction:async fn=>{
    if(beforeTransaction)await beforeTransaction();
    const {transaction}=await api(':beginTransaction','POST',{}),writes=[];
    try{await fn({get:p=>get(p,transaction),query:(p,o)=>query(p,o,transaction),set:async(p,d,o)=>writes.push(write(p,d,o))});
      if(writes.length)await api(':commit','POST',{transaction,writes});else await api(':rollback','POST',{transaction});
    }catch(error){await api(':rollback','POST',{transaction}).catch(()=>{});throw error;}
  }};
  const client=normalizeClient({name:'Synthetic',accessToken:'token',projects:{p:{name:'Project',budget:400,rate:400,items:[]}}},'client');prepareSecureSave(client);
  const portal=publicSnapshot(client,'client'),signedAt='2026-09-27T00:00:00Z',master={name:'Test signer',signedAt,termsSnapshot:portal.masterAgreement,projectTerms:portal.projectTerms};
  portal.projects.p.notificationRevision=1;
  const request={id:'review',portalToken:'token',clientSlug:'client',projectKey:'p',sourceId:'approval',sourceVersion:'v1',reviewEpoch:0,schemaVersion:1,policyVersion:REVIEW_POLICY.version,reviewHours:72,masterVersion:portal.masterAgreement.version,publishedAt:'2026-09-28T00:00:00Z',status:'pending',notificationSent:true,portalNoticeShown:true};
  const state={requestId:'review',projectKey:'p',sourceVersion:'v1',publishedAt:request.publishedAt,status:'pending',revision:0};
  const adapters={firestore,clock:{now:()=> '2026-10-01T00:00:00Z'},config:{enabled:true,reviewStateReady:true}};
  const seed=async()=>{
    await fetch('http://127.0.0.1:8088/emulator/v1/projects/demo-visionflow-backend/databases/(default)/documents',{method:'DELETE'});
    await put('portal_clients/client',client);await put('portal_public/token',portal);
    await put('portal_public/token/consent/'+portal.consentTerms.version,{termsSnapshot:portal.consentTerms});
    await put('portal_public/token/agreements/'+portal.masterAgreement.version,master);
    await put('portal_reviews/review',request);await put('portal_public/token/reviews/review',state);
    await put('portal_public/token/review_guards/p',{revision:0});
  };
  // Seed the notice document that reviewSourceCurrent validates
  const noticeDoc={schemaVersion:1,eventType:'project-notification',clientSlug:'client',projectKey:'p',version:'v1',reviewEpoch:0,projectRevision:portal.projects.p.notificationRevision||1,createdAt:'2026-09-28T00:00:00Z'};
  const seedNotice=async()=>put('portal_public/token/notices/approval',noticeDoc);
  // Update request to reference notices collection
  const requestWithNotice={...request,sourceCollection:'portal_public/token/notices',projectRevision:noticeDoc.projectRevision};
  const seedFull=async()=>{await seed();await seedNotice();await put('portal_reviews/review',requestWithNotice);};
  await seedFull();let result=await processReviewTimers(adapters);assert.equal(result.results[0].status,'deemed-accepted');
  const outcome=await get('portal_public/token/reviews/review');assert.equal(outcome.status,'deemed-accepted');assert.equal('confirmedAt' in outcome,false);
  assert.equal(await get('portal_public/token/confirms/review'),null);
  assert.equal((await query('portal_outbox')).length,1);
  result=await processReviewTimers(adapters);assert.equal(result.processed,0);
  await seedFull();await put('portal_public/token',{...portal,enabled:false});assert.equal((await processReviewTimers(adapters)).results[0].status,'workspace-inactive');
  await seedFull();const changed=structuredClone(portal);changed.projectTerms.p.budget=900;await put('portal_public/token',changed);
  assert.equal((await processReviewTimers(adapters)).results[0].status,'blocked');
  await seedFull();await put('portal_public/token/consent/'+portal.consentTerms.version,{termsSnapshot:{version:portal.consentTerms.version}});
  assert.equal((await processReviewTimers(adapters)).results[0].status,'blocked');
  await seedFull();await put('portal_public/token/confirms/feedback',{kind:'feedback',projectKey:'p',message:'Please revise this.'});
  assert.equal((await processReviewTimers(adapters)).results[0].status,'objected');
  await seedFull();await put('portal_public/token/confirms/approval',{kind:'rejection-pending',rejectReason:'Please revise this.'});
  assert.equal((await processReviewTimers(adapters)).results[0].status,'objected');
  await seedFull();await put('portal_public/token/confirms/approval',{kind:'',confirmedAt:'2026-09-29T00:00:00Z'});
  assert.equal((await processReviewTimers(adapters)).results[0].status,'client-confirmed');
  // A client writes AFTER candidate discovery but BEFORE the transaction reads
  // authoritative state. This uses real REST commits, not a pre-filled mock.
  await seedFull();beforeTransaction=async()=>put('portal_public/token/reviews/review',{...state,status:'objected',revision:1});
  result=await processReviewTimers(adapters);assert.equal(result.results[0].status,'objected');
  assert.equal((await get('portal_public/token/reviews/review')).status,'objected');assert.equal((await query('portal_outbox')).length,0);
  assert.equal((await get('portal_reviews/review')).status,'objected');
  beforeTransaction=null;
  await seedFull();await put('portal_clients/client',{...client,reviewEpoch:1});
  result=await processReviewTimers(adapters);assert.equal(result.results[0].status,'cancelled');
  assert.equal((await get('portal_public/token/reviews/review')).status,'cancelled');
  assert.equal((await query('portal_outbox')).length,0);
  // Cancelled review must not produce an outbox notification
  const cancelledReview=await get('portal_reviews/review');
  assert.equal(cancelledReview.status,'cancelled');
  assert.ok(cancelledReview.cancelledAt);
  await seedFull();
  const collision=notificationEventId({eventType:'deemed-accepted',clientSlug:'client',sourceCollection:'portal_reviews',sourceId:'review',sourceVersion:'v1',projectKey:'p'});
  await put('portal_outbox/'+collision,{alreadyExists:true});
  result=await processReviewTimers(adapters);assert.equal(result.results[0].status,'race-or-validation-blocked');
  assert.equal((await get('portal_public/token/reviews/review')).status,'pending');
  assert.equal((await get('portal_reviews/review')).status,'pending');
  // Cancelled notice must not be emailable
  await seedFull();await put('portal_public/token/notices/approval',{...noticeDoc,cancelledAt:'2026-09-30T00:00:00Z'});
  result=await processReviewTimers(adapters);assert.equal(result.results[0].status,'cancelled');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeClient,prepareSecureSave,publicSnapshot} from '../../portal/data.js';
import {prepareNotificationSave} from '../../portal/notification-publication.js';
import {submitReviewEvidence} from '../../portal/review-submissions.js';
import {settleReviewTimers} from '../../backend/apps-script/review-worker.mjs';
import {processOutbox} from '../../backend/apps-script/worker.mjs';
import {createFakeFirestore} from './fake-firestore.mjs';

const created='2026-10-01T12:00:00.000Z',root='portal_public/token',reviewId='save-new-p';
function fixture(agreementMode='agency-partner'){
  const client=normalizeClient({name:'Synthetic',email:'synthetic@example.invalid',accessToken:'token',reviewEpoch:0,agreementMode,_lastMutationId:'save-new',projects:{p:{name:'Demo',rate:400,budget:400,items:[]}}},'client');
  prepareSecureSave(client);const publication=prepareNotificationSave(client,{},{timestamp:created}),portal=publicSnapshot(client,'client');
  const db=createFakeFirestore({'portal_settings/notifications':{enabled:true},[root]:portal,'portal_clients/client':client,[`${root}/review_guards/p`]:{revision:0},...Object.fromEntries(publication.writes.map(w=>[w.path,w.data]))});
  let now=created;const messages=[];
  const adapters={firestore:db,clock:{now:()=>now},config:{enabled:true,reviewStateReady:true,activationBoundary:created,projectId:'demo',adminUid:'test'},mail:{remainingQuota:async()=>100,send:async message=>messages.push(message)}};
  const sign=async()=>{
    await db.set(`${root}/consent/${portal.consentTerms.version}`,{termsSnapshot:portal.consentTerms,agreedAt:now});
    await db.set(`${root}/agreements/${portal.masterAgreement.version}`,{name:'Synthetic',termsSnapshot:portal.masterAgreement,projectTerms:portal.projectTerms,signedAt:now});
  };
  return {client,portal,db,adapters,messages,sign,setNow:value=>{now=value;},read:()=>db.get('portal_reviews/'+reviewId),tick:()=>settleReviewTimers(adapters),send:()=>processOutbox(adapters)};
}
test('recovery maintenance prevents claims and reviews, including a lock acquired after candidate scan',async()=>{
  const f=fixture();await f.db.set('portal_settings/recovery',{active:true});
  await f.send();await f.tick();assert.equal(f.messages.length,0);assert.equal((await f.read()).status,'awaiting-notification');
  await f.db.set('portal_settings/recovery',{active:false});await f.send();await f.sign();
  const transaction=f.db.runTransaction.bind(f.db);
  f.db.runTransaction=async fn=>{await f.db.set('portal_settings/recovery',{active:true});return transaction(fn);};
  await f.tick();assert.equal((await f.read()).status,'awaiting-notification');
});

test('owner client scope leaves other-client review records untouched',async()=>{
  const f=fixture();
  f.adapters.config.clientScopeSlug='other-client';
  await f.tick();
  assert.equal((await f.read()).status,'awaiting-notification');
  assert.ok(await f.db.get('portal_backend_state/review-scan-other-client'));
  assert.equal(await f.db.get('portal_backend_state/review-scan'),null);
});

test('project-only signing activates and settles its own72h window without a master',async()=>{
  const f=fixture('project');
  await f.db.set(`${root}/consent/${f.portal.consentTerms.version}`,{termsSnapshot:f.portal.consentTerms,agreedAt:created});
  await f.db.set(`${root}/sigs/${f.portal.projects.p.signatureId}`,{projectKey:'p',termsSnapshot:f.portal.projectTerms.p,reviewPolicy:f.portal.masterAgreement.reviewPolicy,signedAt:created});
  await f.send();await f.tick();assert.equal((await f.read()).status,'awaiting-review-notification');
  await f.send();await f.tick();assert.equal((await f.read()).status,'pending');
  f.setNow((await f.read()).deadline);await f.tick();assert.equal((await f.read()).status,'deemed-accepted');
  assert.equal(await f.db.get(`${root}/agreements/${f.portal.masterAgreement.version}`),null);
});

test('project signatures without captured policy, void signatures and route changes cannot start timers',async()=>{
  for(const kind of ['missing-policy','void','wrong-project','wrong-policy','optional-unsigned','changed-route']){
    const f=fixture('project'),id=f.portal.projects.p.signatureId;
    await f.db.set(`${root}/consent/${f.portal.consentTerms.version}`,{termsSnapshot:f.portal.consentTerms,agreedAt:created});
    if(kind!=='optional-unsigned')await f.db.set(`${root}/sigs/${id}`,{projectKey:kind==='wrong-project'?'another':'p',termsSnapshot:f.portal.projectTerms.p,signedAt:created,...(kind==='missing-policy'?{}:{reviewPolicy:{...f.portal.masterAgreement.reviewPolicy,...(kind==='wrong-policy'?{hours:48}:{})}})});
    if(kind==='void')await f.db.set(root,{signatureReviews:{[id]:{state:'void'}}},{merge:true});
    if(kind==='changed-route')await f.db.set('portal_reviews/'+reviewId,{agreementMode:'agency-partner',agreementVersion:f.portal.masterAgreement.version},{merge:true});
    if(kind==='optional-unsigned')await f.db.set(root,{projects:{p:{...f.portal.projects.p,signatureRequired:false}}},{merge:true});
    await f.send();await f.tick();assert.equal((await f.read()).publishedAt,undefined,kind);assert.equal((await f.read()).status,'awaiting-notification',kind);
  }
});

test('real portal publication -> mail -> late signing -> review email -> fresh full72h -> one deemed outcome',async()=>{
  const f=fixture();await f.send();assert.equal(f.messages.length,1);
  await f.tick();assert.equal((await f.read()).publishedAt,undefined);
  f.setNow('2026-10-05T12:00:00.000Z');await f.sign();
  await f.tick();assert.equal((await f.read()).status,'awaiting-review-notification');
  assert.equal((await f.read()).publishedAt,undefined);assert.equal(f.messages.length,1);
  await f.send();assert.equal(f.messages.length,2);assert.match(f.messages[1].body,/at least until 2026-10-08T12:00:00.000Z/);
  f.setNow('2026-10-05T12:05:00.000Z');await f.tick();
  const review=await f.read();assert.equal(review.status,'pending');assert.equal(review.publishedAt,'2026-10-05T12:05:00.000Z');assert.equal(review.deadline,'2026-10-08T12:05:00.000Z');
  assert.equal((await f.db.get(`${root}/reviews/${reviewId}`)).deadline,review.deadline);
  f.setNow('2026-10-08T12:04:59.999Z');await f.tick();assert.equal((await f.read()).status,'pending');
  f.setNow(review.deadline);await f.tick();assert.equal((await f.read()).status,'deemed-accepted');
  const outcomes=(await f.db.query('portal_outbox')).filter(e=>e.eventType==='deemed-accepted');assert.equal(outcomes.length,1);
  await f.tick();assert.equal((await f.db.query('portal_outbox')).filter(e=>e.eventType==='deemed-accepted').length,1);
  const shared=await f.db.get(`${root}/reviews/${reviewId}`);for(const field of ['confirmedAt','signedAt','paymentVerified','downloadAuthorized'])assert.equal(shared[field],undefined);
});
test('missing, failed, admin-only and uncertain initial handoff cannot start a review',async()=>{
  for(const result of [null,{status:'needs-reconciliation',deliveryResults:[{to:'client',status:'unknown'}]},
    {status:'sent-partial',deliveryResults:[{to:'admin',status:'handed-to-provider'},{to:'client',status:'failed'}]}]){
    const f=fixture();await f.sign();const r=await f.read();
    if(result)await f.db.set('portal_outbox/'+r.notificationEventId,{...result,sentAt:created,recipientClient:f.client.email},{merge:true});
    await f.tick();assert.equal((await f.read()).status,'awaiting-notification');assert.equal((await f.read()).publishedAt,undefined);
  }
});
test('uncertain second handoff and mail quota do not activate/backdate review',async()=>{
  const f=fixture();await f.sign();await f.send();await f.tick();
  f.adapters.mail.remainingQuota=async()=>0;await f.send();await f.tick();assert.equal((await f.read()).status,'awaiting-review-notification');
  f.adapters.mail.remainingQuota=async()=>100;f.adapters.mail.send=async()=>{throw Error('Unknown provider acceptance');};
  await f.send();f.setNow('2026-10-09T00:00:00.000Z');await f.tick();assert.equal((await f.read()).publishedAt,undefined);
  assert.equal((await f.read()).status,'awaiting-review-notification');
});
test('current recipient change requires reconciliation instead of using old delivered notice',async()=>{
  const f=fixture();await f.sign();await f.send();await f.tick();await f.send();
  await f.db.set('portal_clients/client',{email:'changed@example.invalid'},{merge:true});await f.tick();assert.equal((await f.read()).status,'manual-review');
});
test('supersession, pause and rotation cancel a waiting review',async()=>{
  for(const change of [
    f=>f.db.set(root,{projects:{...f.portal.projects,p:{...f.portal.projects.p,notificationRevision:2}}},{merge:true}),
    f=>f.db.set(root,{projects:{...f.portal.projects,p:{...f.portal.projects.p,status:'paused'}}},{merge:true}),
    f=>f.db.set('portal_clients/client',{reviewEpoch:1},{merge:true}),
  ]){const f=fixture();await f.sign();await f.send();await change(f);await f.tick();assert.equal((await f.read()).status,'cancelled');}
});
test('objection after preparation prevents review-start email and acceptance',async()=>{
  const f=fixture();await f.sign();await f.send();await f.tick();
  await submitReviewEvidence({transaction:f.db.runTransaction,root,collection:'feedback',id:'fb1',data:{projectKey:'p',message:'Please revise before acceptance.',submittedAt:created},timestamp:created});
  await f.send();assert.equal(f.messages.length,2);assert.equal(f.messages[1].subject,'Feedback received');
  assert.ok(!f.messages.some(m=>m.subject==='Your 72-hour review window'));
  await f.tick();assert.equal((await f.read()).status,'objected');
});
test('explicit review confirmation commits source, guard, shared state and queue without pretending signature/payment',async()=>{
  const f=fixture();const r=await f.read();
  await submitReviewEvidence({transaction:f.db.runTransaction,root,collection:'confirms',id:reviewId,data:{projectKey:'p',requestId:reviewId,sourceVersion:r.sourceVersion,confirmedAt:created},timestamp:created});
  assert.equal((await f.db.get(`${root}/reviews/${reviewId}`)).status,'client-confirmed');
  assert.equal((await f.db.get(`${root}/review_guards/p`)).revision,1);
  await f.tick();assert.equal((await f.read()).status,'client-confirmed');
  assert.equal((await f.read()).publishedAt,undefined);
  const events=await f.db.query('portal_outbox');assert.equal(events.filter(e=>e.eventType==='confirmation-received').length,1);assert.equal(events.filter(e=>e.eventType==='deemed-accepted').length,0);
});
test('all pending candidates beyond20 are visited even with20 broken records first',async()=>{
  const f=fixture();for(let n=0;n<25;n++)await f.db.set('portal_reviews/broken-'+String(n).padStart(2,'0'),{status:'pending',projectKey:'missing'});
  await f.sign();await f.send();let result=await f.tick();assert.equal(result.results.length,20);
  assert.equal((await f.read()).status,'awaiting-notification');
  result=await f.tick();assert.ok(result.results.some(r=>r.id===reviewId));assert.equal((await f.read()).status,'awaiting-review-notification');
});
test('concurrent preparation cannot queue the second notice twice',async()=>{
  const f=fixture();await f.sign();await f.send();await Promise.all([f.tick(),f.tick()]);
  assert.equal((await f.db.query('portal_outbox')).filter(e=>e.eventType==='review-window').length,1);
  assert.equal((await f.read()).status,'awaiting-review-notification');
});
test('workspace pause after explicit response cannot relabel it as cancelled',async()=>{
  const f=fixture(),r=await f.read();
  await submitReviewEvidence({transaction:f.db.runTransaction,root,collection:'confirms',id:reviewId,data:{projectKey:'p',requestId:reviewId,sourceVersion:r.sourceVersion,confirmedAt:created},timestamp:created});
  await f.db.set('portal_clients/client',{reviewEpoch:1,accessEnabled:false},{merge:true});
  await f.tick();assert.equal((await f.read()).status,'client-confirmed');
  assert.equal((await f.db.get(`${root}/reviews/${reviewId}`)).status,'client-confirmed');
});
test('late acknowledgement cannot authorize expiry of an old pending window',async()=>{
  const f=fixture();await f.sign();await f.send();await f.tick();await f.send();await f.tick();
  f.setNow('2026-10-06T00:00:00.000Z');
  const masterPath=`${root}/agreements/${f.portal.masterAgreement.version}`;
  await f.db.set(masterPath,{projectTerms:{}},{merge:true});
  await f.db.set(`${root}/acknowledgements/${f.portal.projects.p.ackId}`,{masterVersion:f.portal.masterAgreement.version,termsSnapshot:f.portal.projectTerms.p,acknowledgedAt:f.adapters.clock.now()});
  await f.tick();assert.equal((await f.read()).status,'manual-review');
});
test('new activation rejects inherited legacy dates and non72 policies',async()=>{
  for(const patch of [{createdAt:'2020-01-01T00:00:00.000Z'},{reviewHours:48},{policyVersion:'legacy'}]){
    const f=fixture();await f.sign();await f.db.set('portal_reviews/'+reviewId,patch,{merge:true});await f.tick();assert.equal((await f.read()).status,'manual-review');
  }
});
test('scan checkpoints survive a bounded runtime and allow the next run to progress',async()=>{
  const f=fixture();for(let n=0;n<21;n++)await f.db.set('portal_reviews/broken-'+String(n).padStart(2,'0'),{status:'pending'});
  let capacity=3;f.db.checkBudget=()=>{if(capacity--<=0)throw Error('bounded run');};
  await f.tick();assert.equal((await f.db.get('portal_backend_state/review-scan')).lastId,'broken-02');
  capacity=3;await f.tick();assert.equal((await f.db.get('portal_backend_state/review-scan')).lastId,'broken-05');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clone,normalizeClient,prepareSecureSave,publicSnapshot} from '../portal/data.js';
import {prepareNotificationSave} from '../portal/notification-publication.js';
import {clientSourceEvent,writeClientRecord} from '../portal/notification-events.js';
import {submitReviewEvidence} from '../portal/review-submissions.js';
import {resolveEventSource,notificationEventId} from '../backend/apps-script/source-binding.mjs';
import {createFakeFirestore} from './backend-apps-script/fake-firestore.mjs';

const stamp='2026-09-30T16:00:00.000Z',token='synthetic-token',root=`portal_public/${token}`;
const clock={now:()=>stamp},config={activationBoundary:'2026-09-30T00:00:00.000Z'};
function fixture(){
  const c=normalizeClient({name:'Synthetic Client',accessToken:token,reviewEpoch:0,projects:{p:{name:'Test',items:[{n:1,s:'pending',no:'PRIVATE NOTE'}],rate:400,budget:400}}},'test');
  prepareSecureSave(c);return c;
}
function savePlan(previous,change,options={}){
  const next=clone(previous);next._lastMutationId='save-test';change(next);
  prepareSecureSave(next,previous);
  return {next,plan:prepareNotificationSave(next,previous,{timestamp:stamp,...options})};
}
test('actual project change publishes bound notice, public/private review and outbox together',async()=>{
  const previous=fixture(),{next,plan}=savePlan(previous,c=>c.projects.p.payments.push({id:'pay1',amount:100,date:'2026-09-30'}));
  assert.equal(plan.writes.length,4);assert.deepEqual(plan.guardKeys,['p']);
  const records=Object.fromEntries(plan.writes.map(w=>[w.path,w.data]));
  const event=plan.writes.find(w=>w.path.startsWith('portal_outbox/')).data;
  assert.equal(event.eventType,'payment-notification');assert.equal(event.id,notificationEventId(event));
  assert.deepEqual(plan.writes[0].data.paymentChanges.items,[{kind:'added',before:null,after:{id:'pay1',amount:10000,date:'2026-09-30',type:''}}]);
  assert.equal(next.projects.p.notificationRevision,1);
  const portal=publicSnapshot(next,next.slug);
  assert.equal(portal.projects.p.notificationRevision,1);
  const db=createFakeFirestore({...records,[root]:portal,'portal_clients/test':next});
  assert.equal((await resolveEventSource(event,{firestore:db,clock,config})).ok,true);
  const review=records['portal_reviews/save-test-p'];
  assert.equal(review.reviewHours,72);assert.equal(review.status,'awaiting-notification');
  assert.equal(review.publishedAt,undefined);assert.equal(review.deadline,undefined);
  assert.ok(!JSON.stringify(records).includes('PRIVATE NOTE'));
});
test('no-op, legacy migration and private-note edits do not create review windows',()=>{
  const previous=fixture();
  for(const change of [()=>{},c=>{c.projects.p.items[0].no='changed secret';},c=>{c.lastUpdated=stamp;}]){
    const {plan}=savePlan(previous,change);assert.equal(plan.writes.length,0);
  }
});
test('replaced final URL republishes without disclosing either secret',()=>{
  const previous=fixture();previous.projects.p.items[0].s='delivered';previous.projects.p.items[0].dl='https://example.invalid/old-final';prepareSecureSave(previous);
  const {next,plan}=savePlan(previous,c=>{c.projects.p.items[0].dl='https://example.invalid/new-final';},{manualNotice:{projectKey:'p',message:'See https://example.invalid/old-final and https://example.invalid/new-final'}});
  assert.equal(plan.writes[0].data.eventType,'delivery-notification');
  assert.equal(plan.writes.length,4);
  for(const secret of ['https://example.invalid/old-final','https://example.invalid/new-final'])assert.ok(!JSON.stringify(plan).includes(secret));
  assert.ok(!JSON.stringify(publicSnapshot(next,next.slug)).includes('https://example.invalid/new-final'));
});
test('newly created project queues once; identical transaction retry has identical identities',()=>{
  const previous=fixture(),change=c=>{c.projects.second=clone(c.projects.p);};
  const one=savePlan(previous,change),two=savePlan(previous,change);
  assert.deepEqual(one.plan,two.plan);assert.deepEqual(one.plan.guardKeys,['second']);
  assert.equal(one.plan.writes[0].data.eventType,'project-notification');
});
test('pause and protected recovery invalidate revisions without sending fresh reviews',()=>{
  const previous=fixture();previous.projects.p.notificationRevision=3;
  for(const [change,options] of [
    [c=>{c.projects.p.status='paused';},{}],
    [c=>{c.accessEnabled=false;c.reviewEpoch=1;},{}],
    [c=>{c.projects.p.name='Restored';},{suppress:true}],
  ]){
    const {next,plan}=savePlan(previous,change,options);
    assert.equal(plan.writes.length,0);assert.equal(next.projects.p.notificationRevision,4);
  }
});
test('client helper writes onboarding source and exactly one deterministic event',async()=>{
  const c=fixture(),portal=publicSnapshot(c,c.slug),db=createFakeFirestore({[root]:portal,'portal_clients/test':c});
  const id=portal.consentTerms.version,data={type:'terms-acceptance',termsVersion:id,termsSnapshot:portal.consentTerms,agreedAt:stamp,userAgent:'test'};
  const args={transaction:db.runTransaction,root,collection:'consent',id,data,timestamp:stamp};
  await writeClientRecord(args);
  const queued=await db.query('portal_outbox');assert.equal(queued.length,1);
  assert.equal(queued[0].id,`client:${token}:consent:${id}`);
  assert.equal((await resolveEventSource(queued[0],{firestore:db,clock,config})).ok,true);
  await assert.rejects(writeClientRecord(args),/already recorded/);
  assert.equal((await db.query('portal_outbox')).length,1);
});
test('client feedback serializes guard and durable event with its source',async()=>{
  const c=fixture(),db=createFakeFirestore({[root]:publicSnapshot(c,c.slug),[`${root}/review_guards/p`]:{revision:7}});
  await submitReviewEvidence({transaction:db.runTransaction,root,collection:'feedback',id:'feedback1',data:{projectKey:'p',message:'Needs revision',submittedAt:stamp},timestamp:stamp});
  assert.equal((await db.get(`${root}/review_guards/p`)).revision,8);
  const event=(await db.query('portal_outbox'))[0];assert.equal(event.eventType,'objection-received');
  assert.equal(event.projectKey,'p');assert.equal(event.reviewEpoch,0);
});
test('event payload cannot carry caller recipients, arbitrary content, or final links',()=>{
  const portal=publicSnapshot(fixture(),'test');
  const event=clientSourceEvent({portal,token,collection:'confirms',id:'a1',data:{projectKey:'p',to:'attacker@example.invalid',dl:'https://example.invalid/final',message:'secret'},timestamp:stamp});
  assert.equal(event.to,undefined);assert.equal(event.message,undefined);assert.equal(event.dl,undefined);
});

test('project signature queues a current source-bound event atomically and rejects superseded signatures',async()=>{
  const c=fixture();c.agreementMode='project';const portal=publicSnapshot(c,c.slug),id=portal.projects.p.signatureId;
  const db=createFakeFirestore({[root]:portal,'portal_clients/test':c});
  await writeClientRecord({transaction:db.runTransaction,root,collection:'sigs',id,data:{projectKey:'p',termsSnapshot:portal.projectTerms.p,reviewPolicy:portal.masterAgreement.reviewPolicy,signedAt:stamp},timestamp:stamp});
  const [event]=await db.query('portal_outbox');assert.equal(event.eventType,'project-signed');
  assert.equal(event.id,`client:${token}:sigs:${id}`);
  assert.equal((await resolveEventSource(event,{firestore:db,clock,config})).ok,true);
  await db.set(root,{signatureReviews:{[id]:{state:'void'}}},{merge:true});
  assert.equal((await resolveEventSource(event,{firestore:db,clock,config})).ok,false);
});
test('approval request publishes a named notice with its description',()=>{
  const previous=fixture(),{plan}=savePlan(previous,c=>{c.projects.p.approvals=[{id:'ap1',title:'Approve storyboard',desc:'Check scenes 1-3.',createdAt:stamp}];});
  const notice=plan.writes.find(w=>w.path.includes('/notices/'));
  assert.ok(notice,'notice written');
  assert.equal(notice.data.eventType,'update-notification');
  assert.equal(notice.data.title,'Please confirm: Approve storyboard');
  assert.ok(notice.data.message.startsWith('Check scenes 1-3.'));
});
test('new project notice names the project',()=>{
  const previous=fixture(),{plan}=savePlan(previous,c=>{c.projects.q={name:'Launch Reel',items:[{n:1,s:'pending'}],rate:100,budget:100};});
  const notice=plan.writes.find(w=>w.path.includes('/notices/')&&w.data.projectKey==='q');
  assert.equal(notice.data.eventType,'project-notification');
  assert.equal(notice.data.title,'New project: Launch Reel');
});
test('payment records stay sendable after a later save; plain updates collapse to the latest',async()=>{
  const previous=fixture();
  const first=savePlan(previous,c=>c.projects.p.payments.push({id:'pay1',amount:100,date:'2026-09-30'}));
  const second=(()=>{const next=clone(first.next);next._lastMutationId='save-two';next.projects.p.items[0].s='in-progress';prepareSecureSave(next,first.next);return {next,plan:prepareNotificationSave(next,first.next,{timestamp:stamp})};})();
  const third=(()=>{const next=clone(second.next);next._lastMutationId='save-three';next.projects.p.items[0].t='Renamed';prepareSecureSave(next,second.next);return {next,plan:prepareNotificationSave(next,second.next,{timestamp:stamp})};})();
  const records=Object.fromEntries([...first.plan.writes,...second.plan.writes,...third.plan.writes].map(w=>[w.path,w.data]));
  const db=createFakeFirestore({...records,[root]:publicSnapshot(third.next,third.next.slug),'portal_clients/test':third.next});
  const outbox=plan=>plan.writes.find(w=>w.path.startsWith('portal_outbox/')).data;
  assert.equal((await resolveEventSource(outbox(first.plan),{firestore:db,clock,config})).ok,true);
  const stale=await resolveEventSource(outbox(second.plan),{firestore:db,clock,config});
  assert.equal(stale.ok,false);assert.equal(stale.status,'source-version-mismatch');
});
test('automatic update message matches the worker collapse rule',async()=>{
  const {AUTO_UPDATE_MESSAGE}=await import('../backend/apps-script/source-binding.mjs');
  const previous=fixture(),{plan}=savePlan(previous,c=>{c.projects.p.items[0].s='in-progress';});
  const notice=plan.writes.find(w=>w.path.includes('/notices/')).data;
  assert.equal(notice.title,'Project update');assert.equal(notice.message,AUTO_UPDATE_MESSAGE);
});
test('notices and reviews carry a typed kind and the approvals they publish',()=>{
  const previous=fixture();
  const ask=savePlan(previous,c=>{c.projects.p.approvals=[{id:'ap1',title:'Approve storyboard',createdAt:stamp}];});
  const byPath=part=>ask.plan.writes.find(w=>w.path.includes(part)).data;
  assert.equal(byPath('/notices/').noticeKind,'approval-request');assert.deepEqual(byPath('/notices/').approvalIds,['ap1']);
  assert.deepEqual(byPath('portal_reviews/').approvalIds,['ap1']);assert.equal(byPath('/reviews/').noticeKind,'approval-request');
  const reply=savePlan(previous,()=>{},{manualNotice:{projectKey:'p',kind:'feedback-reply',title:'Your feedback on "X" was reviewed',message:'Closed.'}});
  assert.equal(reply.plan.writes[0].data.noticeKind,'feedback-reply');assert.deepEqual(reply.plan.writes[0].data.approvalIds,[]);
  const custom=savePlan(previous,()=>{},{manualNotice:{projectKey:'p',title:'Your feedback on "X" - please confirm',message:'Please confirm.'}});
  assert.equal(custom.plan.writes[0].data.noticeKind,'custom');
});
test('server review follows the linked approval and ignores unrelated or closed rejections',async()=>{
  const {loadReviewContext}=await import('../backend/apps-script/review-context.mjs');
  const c=fixture();c.projects.p.approvals=[{id:'ap1',title:'A',createdAt:stamp},{id:'ap2',title:'B',createdAt:stamp,closure:'dismissed'}];prepareSecureSave(c);
  const portal=publicSnapshot(c,c.slug),base={portalToken:token,projectKey:'p',id:'rev1',sourceId:'rev1'};
  const run=async(request,confirms)=>loadReviewContext(request,{firestore:createFakeFirestore(Object.fromEntries(Object.entries(confirms).map(([id,d])=>[`${root}/confirms/${id}`,{projectKey:'p',...d}]))),portal,clock});
  let ctx=await run({...base,approvalIds:['ap1']},{ap1:{kind:'rejection-pending',rejectReason:'Please change it.',confirmedAt:stamp}});
  assert.equal(ctx.decision?.kind,'rejection-pending');assert.equal(ctx.objections.length,0);
  ctx=await run({...base,approvalIds:['ap1']},{ap1:{kind:'',confirmedAt:stamp}});
  assert.equal(ctx.decision?.kind,'');
  ctx=await run({...base,approvalIds:[]},{ap1:{kind:'rejection-pending',rejectReason:'Please change it.',confirmedAt:stamp}});
  assert.equal(ctx.decision,undefined);assert.equal(ctx.objections.length,0,'an approval rejection never objects to an unrelated payment review');
  ctx=await run({...base,approvalIds:[]},{fb1:{kind:'feedback',message:'General concern'}});
  assert.equal(ctx.objections.length,1,'general feedback still objects project-wide');
  ctx=await run(base,{ap1:{kind:'rejected',rejectReason:'x'.repeat(12),confirmedAt:stamp},ap2:{kind:'rejection-pending',rejectReason:'y'.repeat(12),confirmedAt:stamp}});
  assert.equal(ctx.objections.length,0,'legacy review: closed approvals are not unresolved objections');
  ctx=await run(base,{ap1:{kind:'rejection-pending',rejectReason:'x'.repeat(12),confirmedAt:stamp}});
  assert.equal(ctx.objections.length,1,'legacy review keeps the old open-objection behaviour');
});

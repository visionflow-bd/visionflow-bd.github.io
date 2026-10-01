import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REVIEW_POLICY} from '../portal/review-policy.js';
import {masterAgreementTerms} from '../portal/data.js';
import {assessReview,reviewDeadline,explicitReviewDecision} from '../backend/review-engine.mjs';
const fixture=()=>({request:{id:'review1',schemaVersion:1,policyVersion:REVIEW_POLICY.version,reviewHours:72,projectKey:'k9',sourceVersion:'v1',masterVersion:'master1',publishedAt:'2026-09-28T00:00:00Z'},now:'2026-10-01T00:00:00Z',portalActive:true,master:{id:'master1',signedAt:'2026-09-27T00:00:00Z',termsSnapshot:{reviewPolicy:{...REVIEW_POLICY}}},consentValid:true,projectAcknowledged:true,notificationReady:true});
test('signed master captures the user-approved 72-hour policy',()=>{
  const terms=masterAgreementTerms({name:'Synthetic'});
  assert.deepEqual(terms.reviewPolicy,REVIEW_POLICY);
  assert.match(terms.clauses.find(c=>c.title.startsWith('5.')).body,/72 hours/);
});
test('72-hour deadline is exact across month boundary; no browser clock or old defaults',()=>{
  const f=fixture();assert.equal(reviewDeadline(f.request),'2026-10-01T00:00:00.000Z');
  f.now='2026-09-30T23:59:59.999Z';assert.equal(assessReview(f).status,'pending');
  f.now='2026-10-01T00:00:00.000Z';assert.equal(assessReview(f).status,'deemed-accepted');
  for(const hours of [0,48,71,73,NaN])assert.equal(reviewDeadline({...f.request,reviewHours:hours}),null);
  assert.equal(reviewDeadline({createdAt:'2020-01-01T00:00:00Z',verifyDeadline:'2020-01-04T00:00:00Z'}),null);
});
test('deemed outcome cannot impersonate confirmation, signature, payment verification or download access',()=>{
  const result=assessReview(fixture());
  for(const field of ['confirmedAt','signedAt','paymentVerified','downloadAuthorized'])assert.equal(Object.hasOwn(result.record,field),false);
  assert.equal(result.record.actor,'trusted-server');assert.equal(result.record.status,'deemed-accepted');
});
test('missing consent, revoked/master mismatch, paused portal or failed notice blocks expiry',()=>{
  for(const patch of [{portalActive:false},{master:null},{consentValid:false},{projectAcknowledged:false},{notificationReady:false}])assert.equal(assessReview({...fixture(),...patch}).status,'blocked');
  const f=fixture();f.master.revoked=true;assert.equal(assessReview(f).status,'blocked');
  delete f.master.revoked;f.master.id='replacement';assert.equal(assessReview(f).status,'blocked');
  f.master.id='master1';f.master.signedAt='2026-09-29T00:00:00Z';assert.equal(assessReview(f).status,'blocked');
});
test('unresolved objections block automatic acceptance without rewriting explicit decisions',()=>{
  const f=fixture();f.objections=[{projectKey:'k9',id:'feedback1'}];assert.equal(assessReview(f).status,'objected');
  f.objections[0].resolvedAt='2026-09-29T00:00:00Z';assert.equal(assessReview(f).status,'deemed-accepted');
  for(const status of ['client-confirmed','objected','deemed-accepted'])assert.deepEqual(assessReview({...f,decision:{status}}),{status,terminal:true,deadline:'2026-10-01T00:00:00.000Z'});
});
test('client confirmation and objection remain distinct and validate objection text',()=>{
  const f=fixture();assert.equal(explicitReviewDecision(f.request,{action:'confirm',now:f.now}).status,'client-confirmed');
  assert.equal(explicitReviewDecision(f.request,{action:'reject',reason:'Please revise this delivery.',now:f.now}).status,'objected');
  assert.throws(()=>explicitReviewDecision(f.request,{action:'reject',reason:'bad',now:f.now}),/Explain/);
  assert.throws(()=>explicitReviewDecision(f.request,{action:'auto',now:f.now}),/Unknown/);
});

import {REVIEW_POLICY} from '../portal/review-policy.js';

// Pure trusted-backend decisions. No timer running in a browser calls this to
// write an outcome. The runtime adapter must read and commit transactionally.
export function reviewTimestamp(value) {
  if(value&&typeof value.toMillis==='function')return value.toMillis();
  if(value&&typeof value==='object'&&Number.isInteger(value.seconds))return value.seconds*1000+(Number(value.nanoseconds)||0)/1e6;
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))return Date.parse(value);
  return NaN;
}

export function reviewDeadline(request) {
  const published=reviewTimestamp(request?.publishedAt);
  const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!value.includes('/');
  if(!request||![request.id,request.projectKey,request.sourceVersion,request.masterVersion].every(id)||request.schemaVersion!==1||request.policyVersion!==REVIEW_POLICY.version||request.reviewHours!==REVIEW_POLICY.hours||!Number.isFinite(published))return null;
  return new Date(published+REVIEW_POLICY.hours*3600000).toISOString();
}

// The caller supplies ONLY server timestamps and rule-validated source records.
// A feedback record arriving while the worker commits must invalidate its
// transaction/precondition, so rejection can never lose a race to a worker.
export function assessReview({request,now,portalActive,master,consentValid,projectAcknowledged,objections=[],decision=null,notificationReady=false}) {
  const deadline=reviewDeadline(request);
  if(!deadline)return {status:'manual-review',reason:'No valid, newly published 72-hour review request.'};
  if(decision)return {status:decision.status,terminal:true,deadline};
  const clock=reviewTimestamp(now),published=reviewTimestamp(request.publishedAt);
  if(!Number.isFinite(clock)||clock<published)return {status:'blocked',reason:'Invalid server time.',deadline};
  if(!portalActive)return {status:'blocked',reason:'Workspace is paused or archived.',deadline};
  if(request.cancelledAt)return {status:'cancelled',deadline};
  if(!master||master.revoked||!consentValid||!projectAcknowledged||master.termsSnapshot?.reviewPolicy?.version!==REVIEW_POLICY.version||master.termsSnapshot.reviewPolicy.hours!==72||master.id!==request.masterVersion)return {status:'blocked',reason:'Current consent, signed review policy and project acknowledgement are required.',deadline};
  if(!Number.isFinite(reviewTimestamp(master.signedAt))||reviewTimestamp(master.signedAt)>published)return {status:'blocked',reason:'Signing after publication cannot authorize a retroactive review window.',deadline};
  // Any unresolved project objection is conservative evidence to stop expiry.
  // Do not infer that a client's objection is irrelevant from its free text.
  const objection=objections.find(o=>o.projectKey===request.projectKey&&!o.resolvedAt);
  if(objection)return {status:'objected',reason:'An unresolved project objection exists.',deadline};
  if(!notificationReady)return {status:'blocked',reason:'The visible portal notice and email handoff are not both recorded.',deadline};
  if(clock<Date.parse(deadline))return {status:'pending',deadline};
  return {status:'deemed-accepted',deadline,record:{status:'deemed-accepted',requestId:request.id,projectKey:request.projectKey,policyVersion:REVIEW_POLICY.version,sourceVersion:request.sourceVersion,deadline,decidedAt:now,actor:'trusted-server'}};
}

export function explicitReviewDecision(request,{action,reason='',now}) {
  if(!reviewDeadline(request)||!Number.isFinite(reviewTimestamp(now)))throw Error('A published review and server timestamp are required.');
  if(!['confirm','reject'].includes(action))throw Error('Unknown client decision.');
  if(action==='reject'&&(typeof reason!=='string'||reason.trim().length<10||reason.trim().length>2000))throw Error('Explain the objection in 10 to 2,000 characters.');
  // These fields intentionally never include confirmedAt on a deemed outcome,
  // or signedAt/paymentVerified/downloadAuthorized on any review decision.
  return {status:action==='confirm'?'client-confirmed':'objected',requestId:request.id,projectKey:request.projectKey,sourceVersion:request.sourceVersion,decidedAt:now,actor:'client',...(action==='reject'?{reason:reason.trim()}:{})};
}

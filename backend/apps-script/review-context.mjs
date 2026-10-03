import {sameRecord,currentMaster,projectAcknowledged} from '../../portal/data.js';
import {REVIEW_POLICY} from '../../portal/review-policy.js';
import {reviewTimestamp} from '../review-engine.mjs';

export async function loadReviewContext(request,{firestore,portal,clock}) {
  const root=`portal_public/${request.portalToken}`,key=request.projectKey;
  const consentId=portal.consentTerms?.version,masterId=portal.masterAgreement?.version,ackId=portal.projects?.[key]?.ackId;
  const projectMode=portal.agreementMode==='project',signatureId=portal.projects?.[key]?.signatureId;
  const valid=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!value.includes('/');
  if(![consentId,...(projectMode?[signatureId]:[masterId,ackId])].every(valid))throw Error('Missing current agreement context.');
  const [consent,masterRecord,ack,feedback,confirms,direct]=await Promise.all([
    firestore.get(`${root}/consent/${consentId}`),firestore.get(projectMode?`${root}/sigs/${signatureId}`:`${root}/agreements/${masterId}`),projectMode?null:firestore.get(`${root}/acknowledgements/${ackId}`),
    firestore.query(`${root}/feedback`,{where:[['projectKey','==',key]]}),
    firestore.query(`${root}/confirms`,{where:[['projectKey','==',key]]}),
    valid(request.sourceId)?firestore.get(`${root}/confirms/${request.sourceId}`):null,
  ]);
  const existing=[...confirms,...(direct?[{...direct,id:request.sourceId}]:[])];
  // Legacy approval responses live at confirms/{approvalId} without a requestId.
  const approvalById=new Map((portal.projects?.[key]?.approvals||[]).filter(a=>a&&valid(a.id)).map(a=>[a.id,a]));
  const approvalResponse=r=>approvalById.has(r.id)&&!r.requestId;
  const bridged=Array.isArray(request.approvalIds);
  let decision=existing.find(r=>(r.id===request.sourceId||r.requestId===request.id)&&r.kind!=='feedback');
  // A review that published approvals follows the client's answer to those approvals.
  const linked=bridged?request.approvalIds.filter(id=>approvalById.has(id)):[];
  if(!decision&&linked.length){
    const responses=linked.map(id=>existing.find(r=>r.id===id&&approvalResponse(r)));
    const objection=responses.find(r=>r&&['rejection-pending','rejected'].includes(r.kind));
    if(objection)decision=objection;
    else if(responses.every(r=>r&&['',undefined,'confirmed','verified'].includes(r.kind)))
      decision=responses.slice().sort((a,b)=>(reviewTimestamp(b.confirmedAt)||0)-(reviewTimestamp(a.confirmedAt)||0))[0];
  }
  // An approval rejection is item-specific: it never objects to unrelated reviews, and a
  // closed one (dismissed, or rejection confirmed by the admin) is no longer unresolved.
  const itemOnly=r=>approvalResponse(r)&&(bridged||r.kind==='rejected'||approvalById.get(r.id)?.closure==='dismissed');
  const objections=[...feedback,...existing.filter(r=>['feedback','rejection-pending','rejected'].includes(r.kind)&&!itemOnly(r))]
    .filter(r=>!['resolved','closed'].includes(portal.feedbackReviews?.[r.id]?.status))
    .map(r=>({...r,projectKey:key}));
  const master=projectMode?null:currentMaster(portal,masterRecord?[{...masterRecord,id:masterId}]:[]);
  const projectSignature=projectMode&&masterRecord&&!masterRecord.revoked&&masterRecord.projectKey===key
    &&!['void','deleted'].includes(portal.signatureReviews?.[signatureId]?.state)
    &&sameRecord(masterRecord.termsSnapshot,portal.projectTerms?.[key])?{...masterRecord,id:signatureId}:null;
  const agreement=projectMode?projectSignature:master;
  const consentValid=!!consent&&!consent.revoked&&sameRecord(consent.termsSnapshot,portal.consentTerms);
  const acknowledged=projectMode?!!projectSignature:projectAcknowledged(portal,key,master,ack?[{...ack,id:ackId}]:[]);
  const now=reviewTimestamp(clock.now()),signatureTime=reviewTimestamp(agreement?.signedAt);
  const policy=projectMode?agreement?.reviewPolicy:agreement?.termsSnapshot?.reviewPolicy;
  const ready=consentValid&&acknowledged&&agreement?.id===(request.agreementVersion||request.masterVersion)
    &&(!projectMode||request.agreementMode==='project')
    &&sameRecord(policy,REVIEW_POLICY)
    &&Number.isFinite(signatureTime)&&signatureTime<=now;
  // New activation must also validate timestamps; historic pending records keep
  // their existing assessment path and never acquire a retroactive new window.
  const times=[consent?.agreedAt,agreement?.signedAt,...(projectMode||sameRecord(master?.projectTerms?.[key],portal.projectTerms?.[key])?[]:[ack?.acknowledgedAt])];
  const canActivate=!!ready&&times.every(t=>Number.isFinite(reviewTimestamp(t))&&reviewTimestamp(t)<=now);
  return {master,agreement,consentValid,projectAcknowledged:acknowledged,objections,decision,canActivate,latestPrerequisiteAt:canActivate?Math.max(...times.map(reviewTimestamp)):null};
}

export function clientMailHandedOff(event) {
  return !!event&&['sent-unconfirmed','sent-partial'].includes(event.status)
    &&event.deliveryResults?.some(r=>r.to==='client'&&r.status==='handed-to-provider')
    &&Number.isFinite(reviewTimestamp(event.sentAt));
}

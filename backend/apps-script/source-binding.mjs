import {sameRecord} from '../../portal/data.js';
import {reviewTimestamp} from '../review-engine.mjs';
import {notificationEventId} from '../../portal/notification-events.js';
import {loadReviewContext} from './review-context.mjs';
export {notificationEventId};

const sourceIdValid=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!value.includes('/')&&!['.','..'].includes(value);
const sourceProjectEvents=new Set(['project-notification','payment-notification','delivery-notification','update-notification']);

// The outbox carries identities, never recipients or trusted email text. Resolve
// ONLY allowlisted, current, same-client records. Also used inside the final
// sending transaction, so a mutation before that commit invalidates the read.
export async function resolveEventSource(event,{firestore,clock,config}) {
  const failure=status=>({ok:false,status});
  if(!event||event.id!==notificationEventId(event)||![event.clientSlug,event.portalToken,event.sourceId,event.sourceVersion].every(sourceIdValid)||!Number.isSafeInteger(event.reviewEpoch)||event.reviewEpoch<0)return failure('source-binding-invalid');
  if(event.projectKey!==null&&event.projectKey!==undefined&&!sourceIdValid(event.projectKey))return failure('source-binding-invalid');
  const root=`portal_public/${event.portalToken}`;
  const expected={
    'consent-complete':`${root}/consent`,
    'master-signed':`${root}/agreements`,
    'project-acknowledged':`${root}/acknowledgements`,
    'confirmation-received':`${root}/confirms`,
    'objection-received':[`${root}/feedback`,`${root}/confirms`],
    'deemed-accepted':'portal_reviews',
    'review-window':'portal_reviews',
  }[event.eventType] || (sourceProjectEvents.has(event.eventType)?`${root}/notices`:null);
  if(!(Array.isArray(expected)?expected:[expected]).includes(event.sourceCollection))return failure('source-binding-invalid');
  const [client,portal,source]=await Promise.all([
    firestore.get(`portal_clients/${event.clientSlug}`),firestore.get(root),firestore.get(`${event.sourceCollection}/${event.sourceId}`),
  ]);
  if(!client||client._deleted||client.accessEnabled===false||client.accessToken!==event.portalToken||!portal||portal.portalVersion!==7||portal.enabled!==true||portal.clientSlug!==event.clientSlug)return failure('workspace-inactive');
  if(event.reviewEpoch!==(client.reviewEpoch||0))return failure('source-superseded');
  const project=event.projectKey?portal.projects?.[event.projectKey]:null;
  if(event.projectKey&&(!project||!client.projects?.[event.projectKey]||client.projects[event.projectKey].deleted))return failure('source-project-mismatch');
  if(!source)return failure('source-missing');
  let sourceTime;
  switch(event.eventType){
    case 'consent-complete':
      if(event.projectKey||event.sourceId!==portal.consentTerms?.version||event.sourceVersion!==source.termsVersion||source.termsVersion!==event.sourceId||source.revoked||!sameRecord(source.termsSnapshot,portal.consentTerms))return failure('source-version-mismatch');
      sourceTime=source.agreedAt;break;
    case 'master-signed':
      if(event.projectKey||event.sourceId!==portal.masterAgreement?.version||event.sourceVersion!==event.sourceId||source.revoked||!sameRecord(source.termsSnapshot,portal.masterAgreement))return failure('source-version-mismatch');
      sourceTime=source.signedAt;break;
    case 'project-acknowledged':
      if(!project||source.projectKey!==event.projectKey||event.sourceId!==project.ackId||event.sourceVersion!==event.sourceId||source.masterVersion!==portal.masterAgreement?.version||!sameRecord(source.termsSnapshot,portal.projectTerms?.[event.projectKey]))return failure('source-version-mismatch');
      sourceTime=source.acknowledgedAt;break;
    case 'confirmation-received':
    case 'objection-received':{
      const objection=event.sourceCollection===`${root}/feedback`||['feedback','rejected','rejection-pending'].includes(source.kind);
      if(!project||source.projectKey!==event.projectKey||event.sourceVersion!==event.sourceId||objection!==(event.eventType==='objection-received')||(!objection&&!['',undefined,'confirmed','client-confirmed'].includes(source.kind)))return failure('source-version-mismatch');
      sourceTime=source.submittedAt||source.confirmedAt;break;
    }
    case 'deemed-accepted':
      if(!project||source.status!=='deemed-accepted'||source.clientSlug!==event.clientSlug||source.portalToken!==event.portalToken||source.projectKey!==event.projectKey||source.sourceVersion!==event.sourceVersion||source.reviewEpoch!==event.reviewEpoch)return failure('source-version-mismatch');
      if(!await reviewSourceCurrent(source,{firestore,portal}))return failure('source-superseded');
      sourceTime=source.decidedAt;break;
    case 'review-window': {
      if(!project||source.status!=='awaiting-review-notification'||source.clientSlug!==event.clientSlug||source.portalToken!==event.portalToken||source.projectKey!==event.projectKey||source.sourceVersion!==event.sourceVersion||source.reviewEpoch!==event.reviewEpoch||project.status==='paused')return failure('source-version-mismatch');
      if(!await reviewSourceCurrent(source,{firestore,portal}))return failure('source-superseded');
      const [shared,guard,context]=await Promise.all([
        firestore.get(`${root}/reviews/${event.sourceId}`),firestore.get(`${root}/review_guards/${event.projectKey}`),
        loadReviewContext({...source,id:event.sourceId},{firestore,portal,clock}),
      ]);
      if(shared?.status!=='awaiting-review-notification'||shared.requestId!==event.sourceId||shared.sourceVersion!==event.sourceVersion||!Number.isSafeInteger(guard?.revision)||guard.revision<0||!context.canActivate||context.decision||context.objections.length)return failure('review-prerequisites-changed');
      sourceTime=source.notificationPreparedAt;break;
    }
    default:
      if(!project||source.schemaVersion!==1||source.eventType!==event.eventType||source.clientSlug!==event.clientSlug||source.projectKey!==event.projectKey||source.version!==event.sourceVersion||source.reviewEpoch!==event.reviewEpoch||!Number.isSafeInteger(source.projectRevision)||source.projectRevision<1||source.projectRevision!==project.notificationRevision||source.cancelledAt)return failure('source-version-mismatch');
      sourceTime=source.createdAt;
  }
  const sourceMs=reviewTimestamp(sourceTime),eventMs=reviewTimestamp(event.createdAt),nowMs=reviewTimestamp(clock.now()),boundary=reviewTimestamp(config.activationBoundary);
  if(![sourceMs,eventMs,nowMs,boundary].every(Number.isFinite)||sourceMs<boundary||sourceMs>eventMs||eventMs>nowMs)return failure('source-time-invalid');
  return {ok:true,client,portal,project,source,portalToken:event.portalToken};
}

// Review expiry must observe the current notice and project revision INSIDE
// the same transaction as its outcome. A replaced update never gains acceptance.
export async function reviewSourceCurrent(request,{firestore,portal}) {
  if(!sourceIdValid(request.sourceId)||!sourceIdValid(request.sourceVersion)||!sourceIdValid(request.portalToken)||request.sourceCollection!==`portal_public/${request.portalToken}/notices`)return false;
  const project=portal.projects?.[request.projectKey];
  if(!project||!Number.isSafeInteger(request.projectRevision)||request.projectRevision<1||project.notificationRevision!==request.projectRevision)return false;
  const notice=await firestore.get(`${request.sourceCollection}/${request.sourceId}`);
  return !!notice&&notice.schemaVersion===1&&notice.clientSlug===request.clientSlug&&notice.projectKey===request.projectKey&&notice.version===request.sourceVersion&&notice.projectRevision===request.projectRevision&&notice.reviewEpoch===request.reviewEpoch&&sourceProjectEvents.has(notice.eventType)&&!notice.cancelledAt;
}

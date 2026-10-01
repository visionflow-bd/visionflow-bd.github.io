import {assessReview,reviewTimestamp} from '../review-engine.mjs';
import {REVIEW_POLICY} from '../../portal/review-policy.js';
import {reviewSourceCurrent,notificationEventId} from './source-binding.mjs';
import {loadReviewContext,clientMailHandedOff} from './review-context.mjs';

const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!value.includes('/');
const terminal=new Set(['client-confirmed','objected','deemed-accepted','cancelled','manual-review']);
const waiting=new Set(['awaiting-notification','awaiting-review-notification']);
const scanPath='portal_backend_state/review-scan';

// A document-name cursor visits every request, including blocked/malformed ones.
// No oldest-request starvation, composite-index dependency or unbounded scan.
async function reviewCandidates(firestore) {
  const cursor=await firestore.get(scanPath);
  let page=await firestore.query('portal_reviews',{orderBy:['__name__','asc'],limit:20,...(validId(cursor?.lastId)?{startAfterId:cursor.lastId}:{})});
  if(!page.length&&cursor?.lastId)page=await firestore.query('portal_reviews',{orderBy:['__name__','asc'],limit:20});
  return page;
}

export async function settleReviewTimers({firestore,clock,config}) {
  if(config?.enabled!==true||config.reviewStateReady!==true)return {processed:0,results:[],disabled:true};
  if((await firestore.get('portal_settings/recovery'))?.active===true)return {processed:0,results:[],disabled:true};
  const candidates=await reviewCandidates(firestore),results=[];
  for(const candidate of candidates){
    try{firestore.checkBudget?.(30);}catch{break;}
    if(!validId(candidate.id)||terminal.has(candidate.status)){
      await firestore.set(scanPath,{lastId:candidate.id,checkedAt:clock.now()});continue;
    }
    let outcome={id:candidate.id,status:'blocked'};
    try{
      await firestore.runTransaction(async tx=>{
        if((await tx.get('portal_settings/recovery'))?.active===true){outcome={id:candidate.id,status:'recovery-paused'};return;}
        const request=await tx.get(`portal_reviews/${candidate.id}`);
        if(!request||terminal.has(request.status)){outcome={id:candidate.id,status:request?.status||'source-missing'};return;}
        if(![request.portalToken,request.clientSlug,request.projectKey].every(validId))throw Error('Invalid review binding.');
        const root=`portal_public/${request.portalToken}`,statePath=`${root}/reviews/${candidate.id}`;
        const [portal,client,state,guard]=await Promise.all([tx.get(root),tx.get(`portal_clients/${request.clientSlug}`),tx.get(statePath),tx.get(`${root}/review_guards/${request.projectKey}`)]);
        const sharedValid=state?.requestId===candidate.id&&state.projectKey===request.projectKey&&state.sourceVersion===request.sourceVersion&&Number.isSafeInteger(state.revision);
        const persist=async(status,extra={})=>{
          outcome={id:candidate.id,status};
          await tx.set(`portal_reviews/${candidate.id}`,{status,...extra},{merge:true});
          if(sharedValid)await tx.set(statePath,{status,...extra,revision:state.revision+1},{merge:true});
        };
        if(sharedValid&&terminal.has(state.status)){
          outcome={id:candidate.id,status:state.status};
          await tx.set(`portal_reviews/${candidate.id}`,{status:state.status},{merge:true});return;
        }
        if(!Number.isSafeInteger(request.reviewEpoch)||request.reviewEpoch<0){await persist('manual-review',{reason:'Invalid review epoch.'});return;}
        if(client&&request.reviewEpoch!==(client.reviewEpoch||0)){
          await persist('cancelled',{cancelledAt:clock.now(),cancellationReason:'workspace-interrupted'});return;
        }
        if(!portal||portal.enabled!==true||!client||client._deleted||client.accessEnabled===false||client.accessToken!==request.portalToken||portal.clientSlug!==request.clientSlug){outcome={id:candidate.id,status:'workspace-inactive'};return;}
        if(!portal.projects?.[request.projectKey]||!sharedValid)throw Error('Shared review state is missing or mismatched.');
        if(!guard||!Number.isSafeInteger(guard.revision)||guard.revision<0)throw Error('Atomic client submission guard is missing.');
        if(!await reviewSourceCurrent(request,{firestore:tx,portal})||portal.projects[request.projectKey].status==='paused'){
          await persist('cancelled',{cancelledAt:clock.now(),cancellationReason:'source-superseded'});return;
        }
        const context=await loadReviewContext({...request,id:candidate.id},{firestore:tx,portal,clock});
        if(context.decision){
          const decision=context.decision,status=['rejected','rejection-pending'].includes(decision.kind)?'objected':decision.kind==='deemed-accepted'?'deemed-accepted':'client-confirmed';
          await persist(status,{decidedAt:decision.confirmedAt||clock.now(),actor:status==='deemed-accepted'?'trusted-server':'client'});return;
        }
        if(context.objections.length||state.objectionPending===true){await persist('objected',{decidedAt:clock.now(),actor:'client',reason:'An unresolved project objection exists.'});return;}
        if(waiting.has(request.status)){
          if(state.status!==request.status)throw Error('Review activation state mismatch.');
          const nowMs=reviewTimestamp(clock.now()),created=reviewTimestamp(request.createdAt),boundary=reviewTimestamp(config.activationBoundary);
          if(![nowMs,created,boundary].every(Number.isFinite)||created<boundary||created>nowMs||request.schemaVersion!==1||request.policyVersion!==REVIEW_POLICY.version||request.reviewHours!==72){await persist('manual-review',{reason:'A valid newly published review is required.'});return;}
          if(!context.canActivate){outcome={id:candidate.id,status:request.status,reason:'Current consent, signed policy and project acknowledgement are required.'};return;}
          if(request.status==='awaiting-notification'){
            const notice=await tx.get(`${request.sourceCollection}/${request.sourceId}`);
            const originalEvent={eventType:notice.eventType,clientSlug:request.clientSlug,sourceCollection:request.sourceCollection,sourceId:request.sourceId,sourceVersion:request.sourceVersion,projectKey:request.projectKey};
            const originalId=notificationEventId(originalEvent);
            if(request.notificationEventId!==originalId)throw Error('Original notice event mismatch.');
            const mail=await tx.get(`portal_outbox/${originalId}`);
            if(!clientMailHandedOff(mail)){outcome={id:candidate.id,status:'awaiting-notification'};return;}
            if(mail.recipientClient!==client.email||reviewTimestamp(mail.sentAt)>nowMs){await persist('manual-review',{reason:'Notification recipient or time changed; publish a new review.'});return;}
            // This second notice follows signing. Its handoff cannot inherit an
            // old, pre-signing review window.
            const event={eventType:'review-window',clientSlug:request.clientSlug,portalToken:request.portalToken,reviewEpoch:request.reviewEpoch,projectKey:request.projectKey,sourceCollection:'portal_reviews',sourceId:candidate.id,sourceVersion:request.sourceVersion,status:'queued',createdAt:clock.now(),retryCount:0};
            event.id=notificationEventId(event);
            await persist('awaiting-review-notification',{notificationPreparedAt:event.createdAt,reviewNotificationId:event.id});
            await tx.set(`portal_outbox/${event.id}`,event,{exists:false});return;
          }
          const expectedId=notificationEventId({eventType:'review-window',clientSlug:request.clientSlug,sourceCollection:'portal_reviews',sourceId:candidate.id,sourceVersion:request.sourceVersion,projectKey:request.projectKey});
          if(request.reviewNotificationId!==expectedId)throw Error('Review notification binding mismatch.');
          const sent=await tx.get(`portal_outbox/${expectedId}`);
          if(!clientMailHandedOff(sent)){outcome={id:candidate.id,status:'awaiting-review-notification'};return;}
          if(sent.recipientClient!==client.email||reviewTimestamp(sent.sentAt)<reviewTimestamp(request.notificationPreparedAt)||reviewTimestamp(sent.sentAt)>nowMs){await persist('manual-review',{reason:'Review notification needs administrator reconciliation.'});return;}
          const publishedAt=clock.now(),deadline=new Date(reviewTimestamp(publishedAt)+72*3600000).toISOString();
          await persist('pending',{publishedAt,deadline,masterVersion:request.masterVersion,policyVersion:REVIEW_POLICY.version,reviewHours:72,notificationSent:true,portalNoticeShown:true,notificationSentAt:sent.sentAt});return;
        }
        if(!['pending','blocked'].includes(request.status)||!['pending','blocked'].includes(state.status)||reviewTimestamp(state.publishedAt)!==reviewTimestamp(request.publishedAt))throw Error('Review is not published.');
        if(request.notificationEventId&&(!context.canActivate||context.latestPrerequisiteAt>reviewTimestamp(request.publishedAt))){
          await persist('manual-review',{reason:'Agreement prerequisites changed after activation. Publish a fresh review.'});return;
        }
        const assessment=assessReview({request:{...request,id:candidate.id},now:clock.now(),portalActive:true,...context,
          notificationReady:request.notificationSent===true&&request.portalNoticeShown===true});
        outcome={id:candidate.id,status:assessment.status};
        if(!assessment.record){
          if(assessment.status!==request.status)await persist(assessment.status,{reason:assessment.reason||''});
          return;
        }
        const event={eventType:'deemed-accepted',clientSlug:request.clientSlug,portalToken:request.portalToken,reviewEpoch:request.reviewEpoch,projectKey:request.projectKey,sourceCollection:'portal_reviews',sourceId:candidate.id,sourceVersion:request.sourceVersion,status:'queued',createdAt:assessment.record.decidedAt,retryCount:0};
        event.id=notificationEventId(event);
        await persist('deemed-accepted',assessment.record);
        await tx.set(`portal_outbox/${event.id}`,event,{exists:false});
      });
    }catch{outcome={id:candidate.id,status:'race-or-validation-blocked'};}
    results.push(outcome);
    await firestore.set(scanPath,{lastId:candidate.id,checkedAt:clock.now()});
  }
  // Save progress per candidate so a runtime deadline cannot starve later work.
  if(!candidates.length)await firestore.set(scanPath,{lastId:null,checkedAt:clock.now()});
  return {processed:results.length,results};
}

import {publicSnapshot,sameRecord,deliveryLinks,redactDeliverySecrets,projectsOf} from './data.js?v=20261003-a4';
import {notificationEventId} from './notification-events.js?v=20261002-r2';
import {REVIEW_POLICY} from './review-policy.js?v=20260928-r1';
import {paymentChanges} from './payment-notification.js?v=20261003-a1';

const visibleProject = project => Object.fromEntries(Object.entries(project||{}).filter(([key])=>!['lastUpdated','notificationRevision','deliveryVersion','ackId'].includes(key)));
const readyItems = (old,project) => {const a=deliveryLinks(old),b=deliveryLinks(project);return Object.keys(b).filter(n=>a[n]!==b[n]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y);};
const deliveryTitle = ready => ready.length===1?`Deliverable ${ready[0]} is ready for your review`:ready.length>1?`${ready.length} deliverables are ready for your review`:'Delivery updated';
export const APPROVAL_PREFIX = 'Please confirm: ';
const DELIVERY_MESSAGE = 'Open the Production log in your workspace and use the button next to the deliverable to confirm receipt and open the file. You have 72 hours to report any problem; after that the delivery counts as accepted.';

// Returned writes join the same transaction as private/public data + manifests.
// A migration, private note edit, or recovery must not backdate a review window.
export function prepareNotificationSave(next,previous,{timestamp,manualNotice=null,suppress=false}={}) {
  const before=publicSnapshot(previous,previous.slug||next.slug),after=publicSnapshot(next,next.slug),writes=[],guardKeys=[];
  for(const [key,project] of projectsOf(next)) {
    const old=previous.projects?.[key],oldRevision=Number(old?.notificationRevision)||0;
    project.notificationRevision=oldRevision;
    const changed=!sameRecord(visibleProject(before.projects[key]),visibleProject(after.projects[key]))
      || !sameRecord(deliveryLinks(old),deliveryLinks(project))
      || before.masterAgreement.version!==after.masterAgreement.version
      || (previous.reviewEpoch||0)!==(next.reviewEpoch||0);
    const requested=manualNotice?.projectKey===key;
    if(!changed&&!requested)continue;
    project.notificationRevision=oldRevision+1;
    if(suppress||next._deleted||next.accessEnabled===false||project.status==='paused')continue;
    const id=`${next._lastMutationId}-${key}`;
    if(!next._lastMutationId||id.length>200||id.includes('/'))throw Error('Invalid publication identity.');
    const paymentsChanged=!sameRecord(before.projects[key]?.payments||[],after.projects[key]?.payments||[]);
    const deliveryChanged=!sameRecord(deliveryLinks(old),deliveryLinks(project));
    const oldApprovalIds=new Set((old?.approvals||[]).map(a=>a.id)),askedApprovals=(project.approvals||[]).filter(a=>a&&a.kind!=='delivery'&&a.id&&!oldApprovalIds.has(a.id));
    const approvalTitle=askedApprovals.length===1?`${APPROVAL_PREFIX}${String(askedApprovals[0].title||'Project approval').replace(/[\r\n]/g,' ').slice(0,170)}`:`${APPROVAL_PREFIX}${askedApprovals.length} approvals`;
    const approvalMessage=askedApprovals.length===1&&askedApprovals[0].desc?`${String(askedApprovals[0].desc).slice(0,3800)}\n\nOpen Approvals in your workspace to confirm or reject. No response within 72 hours counts as accepted.`:'Open Approvals in your workspace to confirm or reject. No response within 72 hours counts as accepted.';
    const eventType=!old?'project-notification':paymentsChanged?'payment-notification':deliveryChanged?'delivery-notification':'update-notification';
    // Typed, admin-written kind: the UI branches on this, never on the title.
    const noticeKind=requested?(manualNotice.kind==='feedback-reply'?'feedback-reply':'custom'):!old?'new-project':paymentsChanged?'payment':deliveryChanged?'delivery':askedApprovals.length?'approval-request':'update';
    // Legacy approvals answered by this update: the server review follows their client response.
    const ready=deliveryChanged?new Set(readyItems(old,project)):new Set();
    const approvalIds=requested?[]:[...askedApprovals.map(a=>a.id),...(project.approvals||[]).filter(a=>a&&a.kind==='delivery'&&a.id&&ready.has(Number(a.itemNumber))).map(a=>a.id)].filter(id=>typeof id==='string'&&id.length<=200&&!id.includes('/')).slice(0,50);
    const root=`portal_public/${next.accessToken}`,version=`revision-${project.notificationRevision}`;
    const notice={schemaVersion:1,eventType,noticeKind,approvalIds,clientSlug:next.slug,projectKey:key,
      version,projectRevision:project.notificationRevision,reviewEpoch:next.reviewEpoch||0,createdAt:timestamp,
      ...(paymentsChanged?{paymentChanges:paymentChanges(before.projects[key]?.payments||[],after.projects[key]?.payments||[])}:{}),
      ...(requested&&manualNotice.responseTarget?{responseTarget:manualNotice.responseTarget}:{}),
      ...redactDeliverySecrets({
      title:requested?String(manualNotice.title||'Project update').slice(0,200):!old?`New project: ${String(project.name||'Your project').replace(/[\r\n]/g,' ').slice(0,180)}`:paymentsChanged?'Payment record updated':deliveryChanged?deliveryTitle(readyItems(old,project)):askedApprovals.length?approvalTitle:'Project update',
      message:requested?String(manualNotice.message||'Please review the current project details.').slice(0,4000):!old?'Please check the scope, payment terms and timeline. You can confirm, object, or send feedback in this workspace.':deliveryChanged&&!paymentsChanged&&readyItems(old,project).length?DELIVERY_MESSAGE:!paymentsChanged&&!deliveryChanged&&askedApprovals.length?approvalMessage:'Please review the current project details. You can confirm, object, or send feedback in this workspace.',
      },next)};
    const event={eventType,clientSlug:next.slug,portalToken:next.accessToken,reviewEpoch:next.reviewEpoch||0,
      projectKey:key,sourceCollection:`${root}/notices`,sourceId:id,sourceVersion:version,status:'queued',createdAt:timestamp,retryCount:0};
    event.id=notificationEventId(event);
    if(event.id.length>1400)throw Error('Notification identity is too long.');
    const shared={schemaVersion:1,requestId:id,projectKey:key,sourceVersion:version,title:notice.title,noticeKind,approvalIds,
      projectRevision:project.notificationRevision,reviewEpoch:next.reviewEpoch||0,
      policyVersion:REVIEW_POLICY.version,reviewHours:REVIEW_POLICY.hours,status:'awaiting-notification',revision:0,createdAt:timestamp};
    const request={...shared,clientSlug:next.slug,portalToken:next.accessToken,reviewEpoch:next.reviewEpoch||0,
      sourceCollection:event.sourceCollection,sourceId:id,projectRevision:project.notificationRevision,
      masterVersion:after.masterAgreement.version,agreementMode:after.agreementMode,
      agreementVersion:after.agreementMode==='project'?after.projects[key].signatureId:after.masterAgreement.version,
      ackId:after.projects[key].ackId,notificationEventId:event.id};
    writes.push({path:`${root}/notices/${id}`,data:notice},{path:`${root}/reviews/${id}`,data:shared},
      {path:`portal_reviews/${id}`,data:request},{path:`portal_outbox/${event.id}`,data:event});
    guardKeys.push(key);
  }
  return {writes,guardKeys};
}

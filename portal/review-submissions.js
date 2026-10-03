import {clientSourceEvent} from './notification-events.js?v=20261002-r2';
import {validateAttachmentSubmission} from './feedback-attachments.js?v=20260930-r1';

// One project guard serializes client submissions with trusted timer decisions.
// Existing projects without a published review guard retain their legacy flow.
export async function submitReviewEvidence({transaction,root,collection,id,data,timestamp,attachments=[]}) {
  if(!['confirms','feedback'].includes(collection)||!id||id.includes('/')||!data.projectKey||data.projectKey.includes('/'))throw Error('Invalid client submission identity.');
  validateAttachmentSubmission({attachments:data.attachments||[],records:attachments,id,collection,projectKey:data.projectKey,itemNumber:data.itemNumber});
  if(attachments.length&&data.kind!=='feedback')throw Error('Only feedback requests can include attachments.');
  const path=`${root}/${collection}/${id}`,guardPath=`${root}/review_guards/${data.projectKey}`;
  return transaction(async tx=>{
    const existing=await tx.get(path),guard=await tx.get(guardPath);
    const portal=await tx.get(root);
    const reviewPath=data.requestId?`${root}/reviews/${data.requestId}`:null;
    if(data.requestId&&(collection!=='confirms'||data.requestId!==id))throw Error('Invalid review response identity.');
    const review=reviewPath?await tx.get(reviewPath):null;
    if(existing)throw Error('This response was already recorded. Refresh to view it.');
    if(guard&&(!Number.isSafeInteger(guard.revision)||guard.revision<0))throw Error('Review state needs administrator attention.');
    if(reviewPath&&(!guard||!review||review.requestId!==id||review.projectKey!==data.projectKey||review.sourceVersion!==data.sourceVersion||review.projectRevision!==portal?.projects?.[data.projectKey]?.notificationRevision||review.reviewEpoch!==portal.reviewEpoch||!['awaiting-notification','awaiting-review-notification','pending','blocked'].includes(review.status)))throw Error('This review changed or is already closed. Refresh before responding.');
    const event=portal?.eventQueueVersion===1?clientSourceEvent({portal,token:root.split('/')[1],collection,id,data,timestamp}):null;
    await tx.set(path,data);
    for(const attachment of attachments)await tx.set(`${root}/attachments/${attachment.id}`,attachment);
    if(guard)await tx.set(guardPath,{revision:guard.revision+1,lastSubmissionId:id,lastSubmissionCollection:collection,updatedAt:timestamp});
    if(event)await tx.set(`portal_outbox/${event.id}`,event);
    if(reviewPath)await tx.set(reviewPath,{...review,status:data.kind==='rejection-pending'?'objected':'client-confirmed',decidedAt:timestamp,actor:'client',revision:review.revision+1});
  });
}

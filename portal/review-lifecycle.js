// Private epoch invalidates unattended review windows across interruptions.
// Restarting a workspace does not silently restart or backdate its old timers.
export function nextReviewEpoch(next,previous={}) {
  const epoch=Number.isSafeInteger(previous.reviewEpoch)&&previous.reviewEpoch>=0?previous.reviewEpoch:0;
  const active=c=>c.accessEnabled!==false&&!c._deleted&&!c.accessRotation&&!c.archiveState&&!c.purgeState;
  const interrupted=active(previous)&&!active(next);
  const rotated=!!previous.accessToken&&next.accessToken!==previous.accessToken;
  return epoch+(interrupted||rotated?1:0);
}

export function retainedReviewRecord(record,reason,at) {
  if(record.collection!=='reviews'||!['pending','blocked','awaiting-notification','awaiting-review-notification'].includes(record.status))return record;
  return {...record,status:'cancelled',cancellationReason:reason,cancelledAt:at,revision:(Number(record.revision)||0)+1};
}

export function belongsToReviewProject(record,key) {
  return record.projectKey===key||(record.collection==='review_guards'&&record.id===key);
}

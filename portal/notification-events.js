const clientEventCollections = Object.freeze({
  'consent-complete':'consent', 'master-signed':'agreements',
  'project-signed':'sigs',
  'project-acknowledged':'acknowledgements',
  'confirmation-received':'confirms', 'objection-received':null,
});
const eventPart = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/') && !['.','..'].includes(value);

// Client identities are reproducible by Firestore rules, not chosen by callers.
// One immutable source can enqueue exactly one notification, even across devices.
export function notificationEventId(event) {
  if (Object.hasOwn(clientEventCollections,event.eventType)) {
    const parts = String(event.sourceCollection || '').split('/');
    return `client:${parts[1]}:${parts[2]}:${event.sourceId}`;
  }
  return encodeURIComponent(JSON.stringify([event.eventType,event.clientSlug,event.sourceCollection,event.sourceId,event.sourceVersion||null,event.projectKey||null]));
}

export function clientSourceEvent({portal,token,collection,id,data,timestamp}) {
  if (![token,id,portal?.clientSlug].every(eventPart)) throw Error('Invalid notification source identity.');
  const eventType = {consent:'consent-complete',agreements:'master-signed',sigs:'project-signed',acknowledgements:'project-acknowledged'}[collection]
    || (collection==='feedback'||collection==='confirms'&&['feedback','rejected','rejection-pending'].includes(data.kind)?'objection-received':collection==='confirms'?'confirmation-received':null);
  if (!eventType) throw Error('Unsupported notification source.');
  const event = {
    eventType,clientSlug:portal.clientSlug,portalToken:token,reviewEpoch:portal.reviewEpoch||0,
    projectKey:data.projectKey||null,sourceCollection:`portal_public/${token}/${collection}`,
    sourceId:id,sourceVersion:id,status:'queued',createdAt:timestamp,retryCount:0,
  };
  return {id:notificationEventId(event),...event};
}

export async function writeClientRecord({transaction,root,collection,id,data,timestamp}) {
  return transaction(async tx => {
    const portal = await tx.get(root),path = `${root}/${collection}/${id}`;
    const existing = await tx.get(path);
    if (existing) throw Error('This response was already recorded. Refresh to view it.');
    if (!portal || portal.enabled !== true) throw Error('This workspace is no longer active.');
    const event = portal.eventQueueVersion === 1 ? clientSourceEvent({portal,token:root.split('/')[1],collection,id,data,timestamp}) : null;
    tx.set(path,data);
    if (event) tx.set(`portal_outbox/${event.id}`,event);
  });
}

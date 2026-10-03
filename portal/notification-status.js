import {esc} from './data.js?v=20260928-r10';

export function notificationStatus(record) {
  const labels={queued:'Waiting to send',processing:'Preparing',sending:'Sending',retry:'Retry scheduled',
    'quota-exhausted':'Daily Gmail limit reached - sends tomorrow','settings-paused':'Emails paused in settings',
    'sent-unconfirmed':'Sent - inbox delivery unconfirmed','sent-partial':'Partly sent - check recipients',
    'needs-reconciliation':'Uncertain handoff - reconcile before any resend','failed-permanent':'Send failed - administrator action required',
    'attachment-blocked':'Payment proof cannot be attached - review its upload location and publish a corrected update',
    'no-recipients':'No configured recipient','source-superseded':'Superseded update - not sent','workspace-inactive':'Inactive workspace - not sent',
    'source-version-mismatch':'Source changed - not sent','review-prerequisites-changed':'Review prerequisites changed - not sent',
    deduplicated:'Already processed','skipped-pre-activation':'Historical event - not sent'};
  return labels[record?.status]||'Source validation needs administrator review';
}

export const EVENT_LABELS={'project-notification':'New project shared','update-notification':'Project update','payment-notification':'Payment recorded','delivery-notification':'Delivery ready',
  'confirmation-received':'Client confirmed an update','objection-received':'Client rejection / feedback','master-signed':'Client signed the master agreement',
  'project-signed':'Client signed a project agreement','project-acknowledged':'Client acknowledged project particulars','consent-complete':'Client accepted portal terms',
  'review-deemed-accepted':'Review window ended (deemed accepted)','manual-notice':'Message from Vision Flow'};
const tone=status=>['sent-unconfirmed','deduplicated'].includes(status)?'delivered':['failed-permanent','needs-reconciliation','attachment-blocked','no-recipients'].includes(status)?'danger':['queued','processing','sending','retry','quota-exhausted','settings-paused'].includes(status)?'pending':'active';
const when=value=>{const d=value?.toDate?.()||(typeof value==='string'?new Date(value):null);return d&&!Number.isNaN(d.valueOf())?d.toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'';};

export function notificationStatusHtml(records,clients={}) {
  if(!records.length)return '<p>No email notifications yet.</p>';
  return records.map(record=>{
    const c=clients[record.clientSlug],project=c?.projects?.[record.projectKey]?.name||record.projectKey||'';
    const results=(record.deliveryResults||[]).map(result=>`<p class="small muted">${esc(result.to==='admin'?'Admin alert':result.to==='client'?'Client email':result.to)}: ${esc(['sent-unconfirmed','handed-to-provider'].includes(result.status)?'sent':result.status)}</p>`).join('');
    return `<article class="list-row"><div class="panel-head"><strong>${esc(EVENT_LABELS[record.eventType]||record.eventType||'Notification')}</strong><span class="badge ${tone(record.status)}">${esc(notificationStatus(record))}</span></div><p>${esc(c?.name||record.clientSlug||'Unknown client')}${project?` · ${esc(project)}`:''}</p><p class="small muted">Created ${esc(when(record.createdAt)||'—')}${record.sentAt?` · Sent ${esc(when(record.sentAt)||String(record.sentAt))}`:''}</p>${results}</article>`;
  }).join('');
}

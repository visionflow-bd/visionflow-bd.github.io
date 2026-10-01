import {esc} from './data.js?v=20260928-r10';

export function notificationStatus(record) {
  const labels={queued:'Queued',processing:'Preparing',sending:'Provider handoff in progress',retry:'Retry scheduled',
    'quota-exhausted':'Waiting for sender quota','settings-paused':'Sending paused',
    'sent-unconfirmed':'Handed to provider - inbox delivery unconfirmed','sent-partial':'Partially handed to provider - check recipients',
    'needs-reconciliation':'Uncertain handoff - reconcile before any resend','failed-permanent':'Send failed - administrator action required',
    'no-recipients':'No configured recipient','source-superseded':'Superseded update - not sent','workspace-inactive':'Inactive workspace - not sent',
    'source-version-mismatch':'Source changed - not sent','review-prerequisites-changed':'Review prerequisites changed - not sent',
    deduplicated:'Already processed','skipped-pre-activation':'Historical event - not sent'};
  return labels[record?.status]||'Source validation needs administrator review';
}

export function notificationStatusHtml(records,clients={}) {
  if(!records.length)return '<p>No notification events in this page.</p>';
  return records.map(record=>`<article class="list-row"><strong>${esc(record.eventType||'Notification')}</strong><p>${esc(clients[record.clientSlug]?.name||record.clientSlug||'Unknown client')}${record.projectKey?` / ${esc(record.projectKey)}`:''}</p><p>${esc(notificationStatus(record))}</p><p class="small muted">${esc(record.createdAt?.toDate?.().toLocaleString('en-GB')||record.createdAt||'Timestamp unavailable')}${record.sentAt?` | Handoff: ${esc(record.sentAt)}`:''}</p>${(record.deliveryResults||[]).map(result=>`<p class="small muted">${esc(result.to)}: ${esc(result.status)}</p>`).join('')}</article>`).join('');
}

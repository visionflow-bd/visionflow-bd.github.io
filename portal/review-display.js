import {REVIEW_POLICY} from './review-policy.js?v=20260928-r1';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>typeof value?.toMillis==='function'?value.toMillis():value&&Number.isInteger(value.seconds)?value.seconds*1000+(value.nanoseconds||0)/1e6:typeof value==='string'?Date.parse(value):NaN;

// Display only. Expiry NEVER mutates a record or implies verification.
export function reviewPresentation(record,now=Date.now()) {
  const labels={'client-confirmed':'Client confirmed','objected':'Objection received','deemed-accepted':'Deemed accepted — not explicitly confirmed','cancelled':'Review cancelled','blocked':'Review paused','awaiting-notification':'Waiting for notification and agreement prerequisites','awaiting-review-notification':'Preparing your full 72-hour review window','manual-review':'Manual review required'};
  if(labels[record?.status])return {label:labels[record.status],countdown:null};
  const published=time(record?.publishedAt),deadline=published+72*3600000;
  if(record?.status!=='pending'||record.policyVersion!==REVIEW_POLICY.version||record.reviewHours!==72||!Number.isFinite(published)||!Number.isFinite(now)||
    (record.deadline!==undefined&&time(record.deadline)!==deadline))return {label:'Manual review required',countdown:null};
  if(now>=deadline)return {label:'Review period ended — awaiting server decision',countdown:null,deadline};
  const minutes=Math.ceil((deadline-now)/60000),hours=Math.floor(minutes/60);
  return {label:'Awaiting your review',deadline,countdown:`${hours}h ${minutes%60}m remaining`};
}

export function renderReviewPanel({reviews=[],notices=[],confirms=[],feedbackReviews={},projectKey=null,now=Date.now(),canRespond=false,canManage=false}={}) {
  const relevant=rows=>rows.filter(r=>!projectKey||r.projectKey===projectKey).slice().sort((a,b)=>(time(b.publishedAt||b.createdAt)||0)-(time(a.publishedAt||a.createdAt)||0));
  const rows=relevant(reviews),updates=relevant(notices);
  const evidence=r=>{
    const response=confirms.find(c=>c.requestId===(r.id||r.requestId));
    if(!response)return '';
    const management=feedbackReviews[response.id]||{};
    return `<p class="small muted">Explicit client response: ${escape(['rejected','rejection-pending'].includes(response.kind)?'Objection':'Confirmed')}</p>${response.rejectReason?`<p class="prewrap">${escape(response.rejectReason)}</p>`:''}${management.response?`<div class="response"><strong>Vision Flow</strong><p class="prewrap">${escape(management.response)}</p><p>${escape(management.status||'new')}</p></div>`:''}`;
  };
  if(!rows.length&&!updates.length)return '';
  const reviewHtml=rows.map(r=>{const view=reviewPresentation(r,now),actions=canRespond&&r.requestId&&['pending','blocked','awaiting-notification','awaiting-review-notification'].includes(r.status)?`<div class="actions wrap"><button type="button" class="button primary" data-action="confirm-review" data-id="${escape(r.requestId)}">Confirm this update</button><button type="button" class="button" data-action="reject-review" data-id="${escape(r.requestId)}">Object / request changes</button></div>`:'';return `<article class="list-row" id="review-${escape(r.id||r.requestId||'')}"><strong>${escape(r.title||'Project review')}</strong><p>${escape(view.label)}</p>${view.countdown?`<p data-review-countdown="${view.deadline}">${escape(view.countdown)}</p>`:''}${view.deadline?`<p class="small muted">72-hour review deadline: ${escape(new Date(view.deadline).toLocaleString('en-GB'))}. Display uses this device’s clock; the server determines the outcome.</p>`:''}${evidence(r)}${actions}</article>`;}).join('');
  const noticesHtml=updates.map(n=>`<article class="list-row" id="notice-${escape(n.id||'')}"><strong>${escape(n.title||'Workspace update')}</strong><p class="prewrap">${escape(n.message||'Open the relevant project details to review this update.')}</p></article>`).join('');
  const management=canManage?rows.filter(r=>r.requestId).map(r=>`<p>${escape(r.title||'Project review')}: <button type="button" class="button small" data-action="restart-review" data-id="${escape(r.requestId)}">Publish a fresh review</button></p>`).join(''):'';
  return `<section class="panel" id="review-updates" style="margin-top:16px"><h3>Updates &amp; review history</h3>${reviewHtml}${noticesHtml}${management}<p class="small muted">A review outcome is not a signature, payment verification or download authorization. Use the project’s confirm/reject or feedback controls to respond.</p></section>`;
}

export function refreshReviewCountdowns(root,now=Date.now()) {
  root.querySelectorAll('[data-review-countdown]').forEach(node=>{
    const left=Number(node.dataset.reviewCountdown)-now;
    if(left<=0){node.textContent='Review period ended — awaiting server decision';return;}
    const minutes=Math.ceil(left/60000);node.textContent=`${Math.floor(minutes/60)}h ${minutes%60}m remaining`;
  });
}

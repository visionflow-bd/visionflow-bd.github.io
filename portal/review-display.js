import {REVIEW_POLICY} from './review-policy.js?v=20260928-r1';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>typeof value?.toMillis==='function'?value.toMillis():value&&Number.isInteger(value.seconds)?value.seconds*1000+(value.nanoseconds||0)/1e6:typeof value==='string'?Date.parse(value):NaN;

// Display only. Expiry NEVER mutates a record or implies verification.
export function reviewPresentation(record,now=Date.now()) {
  const labels={'client-confirmed':'Client confirmed','objected':'Objection received','deemed-accepted':'Deemed accepted — not explicitly confirmed','cancelled':'Closed - replaced by a newer update. No action needed.','blocked':'Review paused — agreement step pending','awaiting-notification':'Update recorded — the 72-hour review window starts when the email notification is sent','awaiting-review-notification':'Preparing your full 72-hour review window','manual-review':'Manual review required'};
  if(labels[record?.status])return {label:labels[record.status],countdown:null};
  const published=time(record?.publishedAt),deadline=published+72*3600000;
  if(record?.status!=='pending'||record.policyVersion!==REVIEW_POLICY.version||record.reviewHours!==72||!Number.isFinite(published)||!Number.isFinite(now)||
    (record.deadline!==undefined&&time(record.deadline)!==deadline))return {label:'Manual review required',countdown:null};
  if(now>=deadline)return {label:'Review period ended — awaiting server decision',countdown:null,deadline};
  const totalSeconds=Math.ceil((deadline-now)/1000),hours=Math.floor(totalSeconds/3600),minutes=Math.floor((totalSeconds%3600)/60),seconds=totalSeconds%60;
  return {label:'Awaiting your review',deadline,countdown:`${hours}h ${minutes}m remaining`,countdownParts:{hours,minutes,seconds}};
}

export function countdownHtml(deadline,now=Date.now(),expiredText='Review period ended — awaiting server decision'){
  if(!Number.isFinite(deadline)||now>=deadline)return '';
  const total=Math.ceil((deadline-now)/1000),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;
  return countdownMarkup({deadline,countdown:`${hours}h ${minutes}m remaining`,countdownParts:{hours,minutes,seconds}}).replace('class="countdown-wrap"',`class="countdown-wrap" data-expired-text="${escape(expiredText)}"`);
}
const countdownMarkup=view=>view.countdownParts?`<div class="countdown-wrap" data-review-countdown="${view.deadline}" aria-label="${view.countdown}"><span class="countdown-label">Time remaining</span><div class="countdown-boxes"><span class="cd-box"><strong class="cd-num" data-countdown-hours>${String(view.countdownParts.hours).padStart(2,'0')}</strong><span class="cd-lbl">Hours</span></span><span class="cd-sep" aria-hidden="true">:</span><span class="cd-box"><strong class="cd-num" data-countdown-minutes>${String(view.countdownParts.minutes).padStart(2,'0')}</strong><span class="cd-lbl">Minutes</span></span><span class="cd-sep" aria-hidden="true">:</span><span class="cd-box"><strong class="cd-num" data-countdown-seconds>${String(view.countdownParts.seconds).padStart(2,'0')}</strong><span class="cd-lbl">Seconds</span></span></div></div>`:'';

export function renderReviewPanel({reviews=[],notices=[],confirms=[],feedbackReviews={},projectKey=null,projectNames={},now=Date.now(),canRespond=false,canManage=false,visible=4}={}) {
  const relevant=rows=>rows.filter(r=>!projectKey||r.projectKey===projectKey).slice().sort((a,b)=>(time(b.publishedAt||b.createdAt)||0)-(time(a.publishedAt||a.createdAt)||0));
  const rows=relevant(reviews),reviewIds=new Set(rows.map(r=>r.id||r.requestId)),noticeById=new Map(notices.map(n=>[n.id,n]));
  // A published update writes a notice AND its review with the same id. Show it once.
  const updates=relevant(notices).filter(n=>!reviewIds.has(n.id));
  const when=r=>{const t=time(r.publishedAt||r.createdAt);return Number.isFinite(t)?new Date(t).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'';};
  const meta=r=>{const parts=[!projectKey&&projectNames[r.projectKey]?projectNames[r.projectKey]:'',when(r)].filter(Boolean);return parts.length?`<p class="small muted">${escape(parts.join(' · '))}</p>`:'';};
  const restartable=r=>canManage&&r.requestId&&!['pending','client-confirmed','deemed-accepted'].includes(r.status);
  const evidence=r=>{
    const response=confirms.find(c=>c.requestId===(r.id||r.requestId));
    if(!response)return '';
    const management=feedbackReviews[response.id]||{};
    return `<p class="small muted">Explicit client response: ${escape(['rejected','rejection-pending'].includes(response.kind)?'Objection':'Confirmed')}</p>${response.rejectReason?`<p class="prewrap">${escape(response.rejectReason)}</p>`:''}${management.response?`<div class="response"><strong>Vision Flow</strong><p class="prewrap">${escape(management.response)}</p><p>${escape(management.status||'new')}</p></div>`:''}`;
  };
  if(!rows.length&&!updates.length)return '';
  const reviewCards=rows.map(r=>{const view=reviewPresentation(r,now),label=canManage&&r.status==='pending'?'Awaiting client review':view.label,notice=noticeById.get(r.id||r.requestId),message=notice?.message&&notice.message!==r.title?`<p class="prewrap">${escape(notice.message)}</p>`:'',actions=canRespond&&r.requestId&&['pending','blocked','awaiting-notification','awaiting-review-notification'].includes(r.status)?`<div class="actions wrap"><button type="button" class="button primary" data-action="confirm-review" data-id="${escape(r.requestId)}">Confirm this update</button><button type="button" class="button" data-action="reject-review" data-id="${escape(r.requestId)}">Object / request changes</button></div>`:'',manage=restartable(r)?`<div class="actions wrap"><button type="button" class="button small" data-action="restart-review" data-id="${escape(r.requestId)}">Publish a fresh review</button></div>`:'';return `<article class="list-row" id="review-${escape(r.id||r.requestId||'')}"><strong>${escape(r.title||'Project review')}</strong>${meta(r)}${message}<p>${escape(label)}</p>${countdownMarkup(view)}${view.deadline?`<p class="small muted">Review deadline: ${escape(new Date(view.deadline).toLocaleString('en-GB'))}.</p>`:''}${evidence(r)}${actions}${manage}</article>`;});
  const noticeCards=updates.map(n=>`<article class="list-row" id="notice-${escape(n.id||'')}"><strong>${escape(n.title||'Workspace update')}</strong>${meta(n)}<p class="prewrap">${escape(n.message||'Open the relevant project details to review this update.')}</p></article>`);
  const cards=[...reviewCards,...noticeCards],shown=cards.slice(0,visible).join(''),older=cards.slice(visible);
  const olderHtml=older.length?`<details class="history-more"><summary>Show ${older.length} older update${older.length>1?'s':''}</summary>${older.join('')}</details>`:'';
  const footer=canManage?'':'<p class="small muted">Confirming or objecting here records your response to the update. It is not a signature, payment verification or download authorization.</p>';
  return `<section class="panel" id="review-updates" style="margin-top:16px"><h3>Updates &amp; review history</h3>${shown}${olderHtml}${footer}</section>`;
}

export function refreshReviewCountdowns(root,now=Date.now()) {
  root.querySelectorAll('[data-review-countdown]').forEach(node=>{
    const left=Number(node.dataset.reviewCountdown)-now;
    if(left<=0){node.textContent=node.dataset.expiredText||'Review period ended — awaiting server decision';return;}
    const totalSeconds=Math.ceil(left/1000),hours=Math.floor(totalSeconds/3600),minutes=Math.floor((totalSeconds%3600)/60),seconds=totalSeconds%60;
    const hoursNode=node.querySelector?.('[data-countdown-hours]'),minutesNode=node.querySelector?.('[data-countdown-minutes]'),secondsNode=node.querySelector?.('[data-countdown-seconds]');
    if(hoursNode&&minutesNode&&secondsNode){hoursNode.textContent=String(hours).padStart(2,'0');minutesNode.textContent=String(minutes).padStart(2,'0');secondsNode.textContent=String(seconds).padStart(2,'0');node.setAttribute('aria-label',`${hours}h ${minutes}m ${seconds}s remaining`);}
    else node.textContent=`${hours}h ${minutes}m ${seconds}s remaining`;
  });
}

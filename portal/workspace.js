import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocFromServer, getDocs, onSnapshot, runTransaction, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, deleteField, query, orderBy, limit, startAfter, documentId } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { ADMIN_UID, STATUS, LABEL, clone, esc, text, asValidDate, money, safeUrl, signatureImage, uid, newToken, itemsOf, projectsOf, metrics, normalizeClient, publicSnapshot, agreementTerms, signatureOutdated, validateAmount, resizeItems, isDone, deliveryColumns, prepareSecureSave, redactDeliverySecrets, sameRecord } from './data.js?v=20261004-d1';
import { buildProjectReport, buildProjectAgreement, buildMasterAgreement } from './report.js?v=20261004-d1';
import { createOnboarding } from './onboarding.js?v=20261004-d1';
import { submitReviewEvidence } from './review-submissions.js?v=20261002-r2';
import { nextReviewEpoch, retainedReviewRecord, belongsToReviewProject } from './review-lifecycle.js?v=20260928-r1';
import { renderReviewPanel, refreshReviewCountdowns, countdownHtml, isFeedbackReply } from './review-display.js?v=20261004-c1';
import { approvalState, downloadDecision, ensureDeliveryApprovals, deliveryDocId, deliveryAccessDocs } from './approval-state.js?v=20261004-d1';
import { writeClientRecord } from './notification-events.js?v=20261002-r2';
import { prepareNotificationSave } from './notification-publication.js?v=20261004-d1';
import { notificationSettings, validateNotificationSettings } from './notification-settings.js?v=20260930-r1';
import { notificationStatusHtml } from './notification-status.js?v=20261004-d1';
import { ATTACHMENT_ACCEPT, prepareFeedbackAttachments, attachmentMeta, attachmentSize, attachmentDownloadBytes } from './feedback-attachments.js?v=20260930-r1';
import {uploadPortalImage} from './image-upload.js?v=20261001-r1';
import {founderBranding,saveFounderBranding} from './founder-branding.js?v=20261004-d1';
import {REVIEW_POLICY,REVIEW_POLICY_TEXT} from './review-policy.js?v=20260928-r1';

const initialAccess = new URLSearchParams(location.search).get('access');
const firebaseConfig = { apiKey:'AIzaSyCFzQL7oBNA49r2xGh7DwiFmcTBFr1qqiM', authDomain:'visionflow-bd.firebaseapp.com', projectId:'visionflow-bd', storageBucket:'visionflow-bd.firebasestorage.app', messagingSenderId:'233587493754', appId:'1:233587493754:web:a9d064de81f356ab81e4c3' };
const DEFAULT_FOUNDER = { signatureUrl:'https://res.cloudinary.com/dohlemsrz/image/upload/v1790295612/visionflow/signatures/founder-signature-20260925.png', name:'HM Shihabuddin Jashory', title:'Founder & CEO' };

const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">$1</a>');

// ── Email notification helper ──
// Sender URLs live in an admin-only document.  They must never be stored in
// the public website document, because a private client link is not a safe
// place to expose a mail relay endpoint.
const EMAIL_SETTINGS = () => doc(db,'portal_settings','notifications');
async function readEmailSettings(){
  requireAdmin();
  const snap=await getDoc(EMAIL_SETTINGS());
  return snap.exists()?snap.data():{};
}
async function sendNotification(payload){
  // Saves already publish their notification atomically. Explicit reminders
  // get a fresh source record; a browser never calls an opaque mail relay.
  if(!admin()) return false;
  try{
    const c=client();
    if(!c){throw new Error('Open a client workspace before sending an email.');}
    if(payload.warnIfUnavailable){
      if(!state.projectKey)throw new Error('Open the project before publishing a reminder.');
      await saveClient(clone(c),'Notification queued',[],{manualNotice:{projectKey:state.projectKey,...(payload.kind?{kind:payload.kind}:{}),title:payload.subject||'Project update',message:payload.message}});
    }
    notify('Saved. The client will be emailed within about 5 minutes.');
    return true;
  }catch(error){console.warn('Notification error:',error);notify('Notification could not be queued. Please retry.',true);return false;}
}
// A named Firebase app keeps the public client route outside the administrator
// Auth persistence namespace, even when both views are open in one browser.
const firebaseApp = initialAccess ? initializeApp(firebaseConfig,'client-view') : initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp), db = getFirestore(firebaseApp);
const $ = id => document.getElementById(id);
const state = { mode:'loading', loaded:false, clients:{}, publicClient:null, clientKey:null, projectKey:null, tab:'overview', page:'workspace', token:null, user:null, busy:false, filter:'', status:'', batch:'', artifacts:{}, founder:{...DEFAULT_FOUNDER}, error:'' };
let rootStop, brandingStop, artifactStops = {}, modalReturnFocus, pad, previewObjectUrl, founderPreparedBlob, toastTimer;
let founderPreparationId=0;
const MAX_SAVE_OPERATIONS=498;
const hasPendingTrashRestore = c => Object.values(c?.trash||{}).some(entry=>entry?.restoreState?.status==='restoring');
const hasPendingTrashPurge = c => Object.values(c?.trash||{}).some(entry=>entry?.purgeState?.status==='purging');
const recoveryPending = c => Boolean(c?.accessRotation||c?.archiveState||c?.purgeState||hasPendingTrashRestore(c)||hasPendingTrashPurge(c));
const activeArchiveEntry = (c,id) => Boolean(id&&c?.archiveState?.trashId===id);
function assertLifecycleIdle(c=client()){
  if(c?.accessRotation)throw new Error('A private-link replacement is still moving protected records. Resume it from Link settings before making other changes.');
  if(c?.archiveState)throw new Error('A protected archive is still in progress. Resume it from Link settings before making other changes.');
  if(c?.purgeState)throw new Error('Permanent deletion is already in progress for this recycled client. Resume or finish it before making other changes.');
  if(hasPendingTrashRestore(c)||hasPendingTrashPurge(c))throw new Error('A recycle-bin recovery task is in progress. Resume or finish it before making other changes.');
}
const now = () => new Date().toISOString();
const localDay = () => new Date().toLocaleDateString('sv-SE');
const dateText = value => { const d = asValidDate(value); return d ? d.toLocaleString('en-GB') : text(value)||'—'; };
const fmtDate = value => { const d = asValidDate(value); return d ? d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : text(value)||'—'; };
const dateValue = value => asValidDate(value)?.valueOf()||0;

// A browser clock cannot safely verify a payment, delivery, or contract. The
// portal therefore records only an explicit client action; no timer may turn a
// pending request into a verified record.
const responseFor = (approval, projectKey) => artifacts(state.clientKey).confirms.find(c => c.kind !== 'feedback' && c.id === approval.id && (!c.projectKey || c.projectKey === projectKey));
// A receipt is the client's server-timed download click (delivery approvals only).
const receiptFor = (approval, projectKey = state.projectKey) => (artifacts(state.clientKey).receipts || []).find(r => r.id === approval?.id && (!r.projectKey || r.projectKey === projectKey)) || null;
const approvalInfo = (approval, projectKey = state.projectKey) => approvalState(approval, responseFor(approval, projectKey), Date.now(), receiptFor(approval, projectKey));
const isoText = ms => Number.isFinite(ms) ? dateText(new Date(ms).toISOString()) : '—';
const client = () => state.mode === 'client' ? state.publicClient : state.clients[state.clientKey];
const project = () => client()?.projects?.[state.projectKey];
const deliveryLabels = p => ({ item:text(p?.itemLabel)||'Item / subject', title:text(p?.titleLabel)||'Deliverable title', showItem:p?.showItemField!==false });
const admin = () => state.mode === 'admin' && state.user?.uid === ADMIN_UID;
const requireAdmin = () => { if (!admin()) throw new Error('Administrator sign-in is required.'); };
const artifacts = key => state.artifacts[key] || { sigs:[], confirms:[], feedback:[], receipts:[] };
const projectSigs = () => artifacts(state.clientKey).sigs.filter(s => s.projectKey === state.projectKey || (!s.projectKey && s.id === state.projectKey));
const requests = (key = state.clientKey, projectKey = state.projectKey) => [...artifacts(key).confirms.filter(a => a.kind === 'feedback'||a.requestId&&['rejection-pending','rejected'].includes(a.kind)), ...artifacts(key).feedback].filter(a => !projectKey || a.projectKey === projectKey).map(a=>({...a,message:a.message||a.rejectReason||'',submittedAt:a.submittedAt||a.confirmedAt,requestType:a.requestType||(a.requestId?'Review objection':'feedback')})).sort((a,b) => dateValue(b.submittedAt)-dateValue(a.submittedAt));
const reviewOf = entry => client()?.feedbackReviews?.[entry.id] || {};
const visibleRequests = () => requests().filter(r => reviewOf(r).status !== 'deleted');
const sigReview = sig => client()?.signatureReviews?.[sig.id] || {};
const activeSignature = () => {
  const candidates = projectSigs().filter(s => !['void','deleted'].includes(sigReview(s).state) && !signatureOutdated(s,project()));
  const expectedId = project()?.signatureId;
  return (expectedId ? candidates.find(s => s.id === expectedId) : candidates.sort((a,b) => dateValue(b.signedAt)-dateValue(a.signedAt))[0]) || null;
};
const confirmation = approval => responseFor(approval, state.projectKey);
const button = (label, action, data = '', classes = '') => `<button class="button ${classes}" type="button" data-action="${action}" ${data}>${esc(label)}</button>`;
const field = (label,name,value='',type='text',extra='') => `<div class="field"><label for="f-${name}">${esc(label)}</label><input class="input" id="f-${name}" name="${name}" type="${type}" value="${type === 'file' ? '' : esc(value)}" ${extra}></div>`;
const area = (label,name,value='',extra='') => `<div class="field"><label for="f-${name}">${esc(label)}</label><textarea class="textarea" id="f-${name}" name="${name}" ${extra}>${esc(value)}</textarea></div>`;
const select = (label,name,options,value='') => `<div class="field"><label for="f-${name}">${esc(label)}</label><select class="select" id="f-${name}" name="${name}">${options.map(o => { const [v,l] = Array.isArray(o) ? o : [o,LABEL[o]||o]; return `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></div>`;
const link = (value,label) => safeUrl(value) ? `<a href="${esc(safeUrl(value))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '';
const badge = (value,label=LABEL[value]||value) => `<span class="badge ${esc(value)}">${esc(label)}</span>`;
const empty = (title,body) => `<section class="empty"><h2>${esc(title)}</h2><p>${esc(body)}</p></section>`;

function notify(message,error=false) { $('toast').textContent=message; $('toast').className=`toast show${error?' error':''}`; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').className='toast',5500); }
function errorMessage(error) { const code=typeof error?.code==='string'?error.code:'';if (code.includes('permission-denied')) return 'Access could not be verified. Refresh or sign in again.'; if (code.includes('invalid-credential')) return 'Email or password is incorrect.'; if (code.includes('network')) return 'Connection failed. Your form is still here; please retry.'; return typeof error?.message==='string'&&error.message || 'Could not complete this action. Please retry.'; }
function fail(error) { console.error(error); notify(errorMessage(error),true); }
function setRoute() { const q=new URLSearchParams(); if(state.mode==='client') q.set('access',state.token); else if(state.clientKey) q.set('c',state.clientKey); if(state.projectKey) q.set('p',state.projectKey); if(state.tab==='log') q.set('tab','log'); if(state.page==='trash') q.set('v','trash'); history.replaceState(null,'',`${location.pathname}${q.size?'?'+q:''}${location.hash}`); }
function clientUrl(c, projectKey) { const token=c?.accessToken||state.token;if(!token)throw new Error('The private client link is unavailable. Refresh the workspace and try again.');const u=new URL(location.pathname,location.origin);u.searchParams.set('access',token);if(projectKey)u.searchParams.set('p',projectKey);return u.href; }

// Client action centre: every open task across projects, rendered inside the
// page flow (never floating over navigation), plus the welcome/spam reminder.
function actionCenter() {
  if(state.mode!=='client'||!client())return '';
  let waiting=0;const c=client(),items=[],agency=onboarding.isAgencyPartner(),masterMissing=agency&&!onboarding.master();
  if(masterMissing)items.push({urgent:true,text:'Sign your master agreement once to unlock final downloads',project:'',hash:'master-agreement'});
  const arts=artifacts(state.clientKey)||{},answered=new Set((arts.confirms||[]).map(x=>x.requestId));
  for(const [key,p] of projectsOf(c)){
    if(state.projectKey&&key!==state.projectKey)continue;
    const open=(p.approvals||[]).filter(a=>approvalInfo(a,key).state==='pending');waiting+=(p.approvals||[]).filter(a=>approvalInfo(a,key).state==='rejection-pending').length;
    const deliveries=open.filter(a=>a.kind==='delivery'&&!receiptFor(a,key)).length,updates=open.filter(a=>a.kind!=='delivery').length;
    // Delivery and approval-request review cards mirror their Approvals item (confirm/reject + 72h auto-accept); never ask twice.
    const deliveryNotice=new Set((arts.notices||[]).filter(n=>n.eventType==='delivery-notification'||n.noticeKind==='approval-request'||isFeedbackReply(n)).map(n=>n.id));
    const reviewsOpen=(arts.reviews||[]).filter(r=>r.projectKey===key&&r.requestId&&['pending','blocked','awaiting-notification','awaiting-review-notification'].includes(r.status)&&!answered.has(r.requestId)&&!deliveryNotice.has(r.id||r.requestId)).length;
    if(reviewsOpen)items.push({text:`${p.name}: ${reviewsOpen} project update${reviewsOpen>1?'s':''} to review`,project:key,hash:'review-updates'});
    if(!masterMissing&&!onboarding.projectReady(key))items.push({urgent:true,text:agency?`${p.name}: acknowledge the project particulars`:`${p.name}: review and sign the project agreement`,project:key,hash:'agreement'});
    if(updates)items.push({text:`${p.name}: ${updates} update${updates>1?'s':''} awaiting your confirmation`,project:key,hash:'approvals'});
    if(deliveries)items.push({text:`${p.name}: ${deliveries} deliver${deliveries>1?'ies':'y'} ready to download`,project:key,hash:'approvals'});
  }
  const list=items.map(it=>`<li class="action-item${it.urgent?' urgent':''}"><span>${esc(it.text)}</span>${button('Open','go-action',`data-project="${esc(it.project)}" data-hash="${esc(it.hash)}"`,'small'+(it.urgent?' primary':''))}</li>`).join('');
  return `<section class="action-center" id="action-center" aria-label="Your next steps"><div class="action-head"><div><p class="eyebrow">Welcome, ${esc(c.name)}</p><h2>${items.length?`${items.length} thing${items.length>1?'s':''} need${items.length>1?'':'s'} your attention`:waiting?'Nothing needs your action right now':'You are all caught up'}</h2></div></div>${items.length?`<ul class="action-list">${list}</ul>`:waiting?`<p class="muted">We are reviewing your feedback on ${waiting} item${waiting>1?'s':''} and will reply by email.</p>`:'<p class="muted">Every update and delivery is confirmed. New items will appear here.</p>'}<p class="small muted action-mail">We also email you every important update with a direct link. Our emails come from <strong>visionflow.agency.bd@gmail.com</strong> - please add it to your contacts. If you cannot find an email, check Spam or Promotions and mark it “Not spam”.</p><p class="small action-tour">${button('Take the quick tour','welcome-tour','','small')}</p></section>`;
}

function hashScroll(){if(location.hash){let id;try{id=decodeURIComponent(location.hash.slice(1));}catch{return;}let el=document.getElementById(id);if(!el&&id.startsWith('notice-'))el=document.getElementById(`review-${id.slice(7)}`);if(!el&&id.startsWith('review-'))el=document.getElementById(`notice-${id.slice(7)}`);if(el){const fold=el.closest('details');if(fold)fold.open=true;el.scrollIntoView({behavior:'smooth',block:'start'});el.style.outline='2px solid var(--accent)';setTimeout(()=>el.style.outline='',2000);}}}



function render() {
  if (!$('modalLayer').hidden || state.busy) return;
  $('topActions').innerHTML = state.mode==='admin' ? `${badge('active','Admin')}${button('Dashboard','dashboard')}${button('Notifications','notification-status')}${button('Recycle bin','trash')}${button('Sign out','logout')}` : state.mode==='client' ? badge('completed','Private client view') : '';
  document.getElementById('notif-wrap')?.remove();
  if(state.mode==='login') return renderLogin();
  if(state.mode==='error') { $('view').innerHTML=`<section class="empty"><h2>Workspace unavailable</h2><p>${esc(state.error)}</p><p class="muted" style="margin-top:12px;font-size:11px">If you believe this is a mistake, contact your Vision Flow administrator or request a new private link.</p></section>`+button('Try again','refresh'); return; }
  if(state.mode==='loading')return;
  state.loaded=true;
  if(showTermsPopup()) return;
  setRoute();
  if(admin() && state.page==='trash') return renderTrash();
  if(state.mode==='admin' && !state.clientKey) return renderDashboard();
  if(!client()) { $('view').innerHTML=empty('This workspace is not available','The private link may have been disabled. Ask Vision Flow for the current link.'); return; }
  if(state.projectKey && !project())state.projectKey=null;
  $('view').innerHTML=actionCenter()+(state.projectKey ? projectView() : clientView())+renderReviewPanel({...artifacts(state.clientKey),feedbackReviews:client().feedbackReviews,projectKey:state.projectKey,projectNames:Object.fromEntries(projectsOf(client()).map(([k,p])=>[k,p.name])),canRespond:state.mode==='client',canManage:admin()})+`<p class="footer-note">Vision Flow · Live project workspace · ${client().lastUpdated ? `Updated ${esc(dateText(client().lastUpdated))}` : 'Ready for your next update'}</p>`;
  $('view').querySelectorAll('[data-id]').forEach(control=>{const row=control.closest('.list-row');if(row&&!row.id)row.id=`evidence-${control.dataset.id}`;});
  if(state.tab==='log') applyFilters();
  setTimeout(hashScroll,500);
  if(state.mode==='client')setTimeout(maybeWelcome,800);
}
setInterval(()=>{if(!document.hidden)refreshReviewCountdowns(document);},1000);
// Consent is a current server record, not a browser flag.
function showTermsPopup(){return onboarding.showConsent();}

function renderLogin(message='') {
  $('view').innerHTML=`<section class="empty login-card"><img class="login-logo" src="../logo.png" alt="Vision Flow"><p class="eyebrow">Vision Flow workspace</p><h1>Welcome back</h1><p>Sign in to manage your clients, projects and delivery records.</p><form id="loginForm" class="form-grid">${field('Email','email','','email','autocomplete="username" required')}${field('Password','password','','password','autocomplete="current-password" required')}<p class="form-error" role="alert">${esc(message)}</p><button class="button primary" type="submit">Sign in securely</button></form></section>`;
}
function renderDashboard() {
  const entries=Object.entries(state.clients).filter(([,c])=>!c._deleted);
  const totals={projects:0,total:0,done:0,paid:0,budget:0,requests:0,signatures:0};
  for(const [key,c] of entries) { for(const [,p] of projectsOf(c)) { const m=metrics(p); totals.projects++; for(const k of ['total','done','paid','budget'])totals[k]+=m[k]; } totals.requests+=requests(key,null).filter(r=>!['resolved','closed','deleted'].includes(c.feedbackReviews?.[r.id]?.status)).length; totals.signatures+=artifacts(key).sigs.filter(s=>!c.signatureReviews?.[s.id]?.state||c.signatureReviews[s.id].state==='pending').length; }
  $('view').innerHTML=`<section class="hero"><p class="eyebrow">Agency workspace</p><h1>Your work, clearly in view.</h1><p class="hero-copy">Manage delivery, conversations and payments from one place.</p><div class="actions wrap" style="margin-top:18px">${button('Founder signature','founder-signature','','primary')}${button('Email settings','email-settings')}</div></section><section class="stats">${stat('Clients',entries.length)}${stat('Projects',totals.projects)}${stat('Open requests',totals.requests)}${stat('Signatures to review',totals.signatures)}${stat('Balance due',money(totals.budget-totals.paid))}</section><div class="section-head"><h2>Client workspaces</h2><div class="actions">${button('Add client','add-client','','primary')}${button('Export client archive','export-all')}${button('Refresh','refresh')}</div></div><section class="cards">${entries.map(([key,c])=>{const ms=projectsOf(c).map(([,p])=>metrics(p)); const total=ms.reduce((a,m)=>a+m.total,0),done=ms.reduce((a,m)=>a+m.done,0);return `<button class="card" data-action="open-client" data-client="${esc(key)}"><div class="card-top"><div><div class="card-name">${esc(c.name||key)}</div><p>${ms.length} projects · ${done}/${total} delivered</p></div>${badge('active',c.accessEnabled===false?'Link paused':'Shared')}</div><p style="margin-top:12px">Open workspace →</p></button>`;}).join('')||empty('Your first client starts here','Create a client to get a private share link and start a project.')}</section>`;
}
function stat(label,value){return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;}
function clientView(){return onboarding.clientPanel()+originalClientView();}
function originalClientView() {
  const c=client(); const ps=projectsOf(c); const sum=ps.reduce((a,[,p])=>{const m=metrics(p);for(const k of ['total','done','budget','paid'])a[k]+=m[k];return a;},{total:0,done:0,budget:0,paid:0});
  return `<div class="breadcrumb">${admin()?button('All clients','dashboard'):''}<span>${esc(c.name)}</span></div><section class="hero"><p class="eyebrow">${admin()?'Client workspace':'Your private workspace'}</p><h1>${esc(c.name)}</h1><p class="hero-copy">Projects, delivery updates, payments and conversations—together in one place.</p><div class="actions wrap" style="margin-top:18px">${admin()?button('Copy client link','copy-client')+button('Preview client view','preview-client')+button('Edit client','edit-client')+button('Link settings','link-settings')+button('All submitted records','all-records')+button('Move client to bin','archive-client','','danger'):button('Refresh','refresh')}</div></section><section class="stats">${stat('Projects',ps.length)}${stat('Delivered',`${sum.done}/${sum.total}`)}${stat('Budget',money(sum.budget))}${stat('Paid',money(sum.paid))}${stat(sum.budget-sum.paid<0?'Credit':'Due',money(Math.abs(sum.budget-sum.paid)))}</section><div class="section-head"><h2>Projects</h2>${admin()?button('Add project','add-project','','primary'):''}</div><section class="cards">${ps.map(([key,p])=>{const m=metrics(p);return `<button class="card" data-action="open-project" data-project="${esc(key)}"><div class="card-top"><div class="card-name">${esc(p.name)}</div>${badge(p.status||'active')}</div><p>${m.total} deliverables · ${money(p.budget)}</p><div class="progress"><i style="width:${m.percent}%"></i></div><p>${m.done} complete · ${m.percent}%</p></button>`;}).join('')||empty('No projects yet','Your project details will appear here when a project is created.')}</section>`;
}
function projectView() {
  const p=project(), m=metrics(p);
  const recent=visibleRequests().filter(r=>!['resolved','closed'].includes(reviewOf(r).status)).length;
  const actions=admin()?button('Edit project','edit-project')+button('Record payment','add-payment')+button('Request approval','add-approval')+button('WhatsApp','wa-send')+button('Email','email-send')+button('Copy project link','copy-project')+button('Move project to bin','archive-project','','danger'):button('Project feedback / revision','feedback-project','','primary');
  return `<div class="breadcrumb">${admin()?button('All clients','dashboard'):''}${button(`${client().name} · All projects`,'open-client')}<span>/ ${esc(p.name)}</span></div><section class="hero"><p class="eyebrow">${admin()?'Project management':'Project overview'}</p><h1>${esc(p.name)}</h1><p class="hero-copy">${m.total} deliverables · ${money(p.rate)} each · ${badge(p.status||'active')}</p><div class="actions wrap" style="margin-top:18px">${button('Project report / PDF','report')}${button('Terms & agreement PDF','agreement')}${actions}</div></section><div class="tabbar">${button('Overview','tab-overview','',state.tab==='overview'?'active':'')}${button(`Production log · ${m.total} deliverables`,'tab-log','',state.tab==='log'?'active':'')}${recent?badge('revision',`${recent} open requests`):''}</div>${state.tab==='log'?productionView():`<section class="stats">${stat('Complete',m.percent+'%')}${stat('Delivered',`${m.done}/${m.total}`)}${stat('Budget',money(m.budget))}${stat('Paid',money(m.paid))}${stat(m.due<0?'Credit':'Due',money(Math.abs(m.due)))}</section>${scopeView(p)}<div class="two-col"><section class="panel" id="payments">${paymentView(p)}</section><section class="panel" id="approvals">${approvalView(p)}</section></div>${signatureView(p)}${feedbackView()}`}`;
}
function scopeView(p){return `<section class="panel" style="margin-top:16px"><div class="panel-head"><h3>Project particulars</h3>${button('Open terms & agreement','agreement')}</div><div class="scope-grid"><p><strong>Scope / description</strong><br><span class="prewrap">${esc(p.scope||'Project scope can be confirmed with Vision Flow before signing.')}</span></p><p><strong>Target date</strong><br>${p.deadline?fmtDate(p.deadline):'Not set'}</p><p><strong>Weekly target</strong><br>${p.weeklyTarget?esc(p.weeklyTarget)+' deliverables':'Not set'}</p><p><strong>Next milestone</strong><br><span class="prewrap">${esc(p.milestoneText||'Not set')}</span></p><p><strong>Payment & delivery terms</strong><br><span class="prewrap">${esc(p.terms||'No additional project-specific terms recorded.')}</span></p><p><strong>Source material</strong><br>${link(p.sourceScriptUrl,'Source scripts')||'—'}<br>${link(p.avatarFolderUrl,'Character references')||'—'}</p></div></section>`;}
function paymentView(p){const rows=p.payments||[];return `<div class="panel-head"><h3>Payments</h3>${badge('active',money(metrics(p).paid)+' recorded')}</div>${[...rows].reverse().map(pay=>`<div class="list-row"><div class="record"><span class="record-mark ok">৳</span><div><strong>${money(pay.amount)} · ${esc(pay.type)}</strong><p>${fmtDate(pay.date)}${pay.note?' · '+esc(pay.note):''}</p>${safeUrl(pay.proofUrl)?`<a href="${esc(safeUrl(pay.proofUrl))}" target="_blank" rel="noopener noreferrer"><img class="payment-proof" src="${esc(safeUrl(pay.proofUrl))}" alt="Payment proof for ${fmtDate(pay.date)}"></a>`:''}</div>${admin()?`<div class="row-actions">${button('Edit','edit-payment',`data-id="${esc(pay.id)}"`)}${button('Bin','archive-payment',`data-id="${esc(pay.id)}"`,'danger')}</div>`:''}</div></div>`).join('')||'<p class="muted">No payment recorded yet.</p>'}`;}
function approvalCard(a){
  const v=approvalInfo(a),c=v.response,id=`data-id="${esc(a.id)}"`,delivery=a.kind==='delivery';
  const rejection=(cls,label,heading)=>`<div class="rejection-card${cls}"><div class="rejection-header">${badge(cls?'warn':'danger',label)} <span class="rejection-date">${esc(dateText(c.confirmedAt))}</span></div><div class="rejection-reason"><strong>${heading}</strong><p class="prewrap">${esc(c.rejectReason||'No reason was recorded with this older rejection.')}</p></div></div>`;
  const closed=`<p class="small muted">${delivery?'This delivery stands as final and the download is available. ':''}Any further change will arrive as a new update with its own 72-hour review window.</p>`;
  const status=v.state==='dismissed'?`<div class="rejection-card dismissed"><div class="rejection-header">${badge('completed','Closed')} <span class="rejection-date">${esc(dateText(a.closedAt))}</span></div>${c?.rejectReason?`<div class="rejection-reason"><strong>${admin()?'Client’s reason:':'Your feedback:'}</strong><p class="prewrap">${esc(c.rejectReason)}</p></div>`:''}<div class="rejection-reason"><strong>Vision Flow response:</strong><p class="prewrap">${esc(a.closeReason||'Reviewed by Vision Flow.')}</p></div>${closed}</div>`
    :v.state==='rejected'?rejection('','Rejected','Reason for rejection:')+`<p class="small muted">${admin()?'Rejection accepted. Publish the revision as a new update; it starts a fresh 72-hour window.':'Vision Flow accepted your feedback. The revised version will arrive as a new update with a fresh 72-hour review window.'}</p>`
    :v.state==='rejection-pending'?rejection(' rejection-pending','Rejection submitted',admin()?'Client’s reason:':'Your reason:')+`<p class="small muted">${admin()?'Timer paused. Confirm the rejection (a revision will follow as a new update) or dismiss it with a reason (the item closes).':'The review timer is paused while Vision Flow reviews your feedback.'}</p>`
    :v.state==='confirmed'?`<p>${badge('delivered',delivery?'Verified':'Confirmed')} <span class="small muted">${esc(dateText(c.confirmedAt))}</span></p>`
    :v.state==='deemed'?`<p>${badge('completed','Deemed accepted')} <span class="small muted">No response within 72 hours · window ended ${esc(isoText(v.deadline))}</span></p>`
    :`<p>${badge('pending',delivery&&v.receipt?(admin()?'Downloaded by client':'Received'):admin()?(delivery?'Awaiting client download':'Awaiting client confirmation'):delivery?'Ready to download':'Awaiting your confirmation')}${delivery&&v.receipt?` <span class="small muted">${esc(dateText(v.receipt.receivedAt))}</span>`:''}</p>${countdownHtml(v.deadline,Date.now(),'Review window ended — counted as accepted')}${v.deadline?`<p class="small muted">${delivery&&v.receipt?(admin()?`The client may report a problem until ${esc(isoText(v.deadline))}. After that it counts as accepted.`:`Report any problem by ${esc(isoText(v.deadline))}. After that the delivery counts as accepted.`):`${admin()?'No client response by':'Please respond by'} ${esc(isoText(v.deadline))}${admin()?' counts as accepted.':'. No response within 72 hours counts as accepted.'}`}</p>`:''}`;
  const actions=admin()?(v.state==='pending'?button('Edit','edit-approval',id):'')+(v.state==='rejection-pending'?button('Confirm rejection','confirm-rejection',id,'danger')+button('Dismiss rejection','reset-approval',id):c&&v.state!=='dismissed'?button('Reset response','reset-approval',id):'')+button('Bin','archive-approval',id,'danger')
    :(delivery&&itemsOf(project()).some(i=>Number(i.n)===Number(a.itemNumber)&&i.hasDelivery)&&['pending','confirmed','deemed','dismissed'].includes(v.state)?button('Download','gated-download',`data-delivery="${esc(String(a.itemNumber))}"`,v.state==='pending'&&!v.receipt?'primary':''):'')
      +(v.state==='pending'?(delivery?button('Confirm received','confirm-approval',id)+button('Report a problem','reject-approval',id,'danger'):button('Confirm update','confirm-approval',id,'primary')+button('Reject','reject-approval',id,'danger')):'');
  return `<div class="list-row approval-row" id="approval-${esc(a.id)}"><strong>${esc(a.title)}</strong>${a.createdAt?`<p class="small muted">Requested ${esc(dateText(a.createdAt))}</p>`:''}<p class="prewrap">${linkify(a.desc)}</p>${status}${actions?`<div class="actions wrap">${actions}</div>`:''}</div>`;
}
function approvalView(p){
  const order=a=>dateValue(a.createdAt||a.updatedAt);
  const rows=[...(p.approvals||[])].sort((a,b)=>order(b)-order(a));
  const open=rows.filter(a=>['pending','rejection-pending'].includes(approvalInfo(a).state)),done=rows.filter(a=>!open.includes(a));
  return `<div class="panel-head"><h3>Approvals</h3>${badge(open.length?'pending':'active',open.length?`${open.length} open · ${rows.length} total`:`${rows.length} total`)}</div>${open.map(approvalCard).join('')||'<p class="muted">Nothing is waiting for confirmation.</p>'}${done.length?`<details class="history-more"><summary>Approval history (${done.length})</summary>${done.map(approvalCard).join('')}</details>`:''}`;
}
function signatureView(p){return onboarding.projectPanel()+(projectSigs().length?`<section class="panel" style="margin-top:16px">${button('Historical project signatures','legacy-signatures')}</section>`:'');}
function legacySignatureView(p){
  const sig=activeSignature(); const historical=projectSigs().filter(s=>!['void','deleted'].includes(sigReview(s).state)).sort((a,b)=>dateValue(b.signedAt)-dateValue(a.signedAt));const list=admin()?projectSigs():(sig?[sig]:historical.slice(0,1));
  const founder=safeUrl(state.founder.signatureUrl)?`<div class="founder-authority"><img src="${esc(safeUrl(state.founder.signatureUrl))}" alt="Signature of ${esc(state.founder.name)}"><div><strong>${esc(state.founder.name)}</strong><p>${esc(state.founder.title)} · Vision Flow</p></div></div>`:'';
  return `<section class="agreement" id="agreement"><div class="panel-head"><h3>Project agreement</h3>${!admin()&&!sig?button('Review & sign','sign','','primary'):''}${admin()&&!sig?button('Request client signature','request-signature','','primary'):''}</div>${list.map(s=>{const r=sigReview(s),outdated=signatureOutdated(s,p);return `<div class="list-row"><div class="record"><div><strong>${esc(r.displayName||s.name)}</strong><p>Signed ${esc(dateText(s.signedAt))} · ${esc(r.state||'Awaiting verification')}${outdated?' · Project terms have changed since signing':''}</p>${signatureImage(s.image)?`<img class="signature-image" src="${signatureImage(s.image)}" alt="Signature by ${esc(s.name)}">`:''}${r.message?`<p>${esc(r.message)}</p>`:''}<p class="small muted">${s.termsSnapshot?'Signed terms are retained with this record.':'Legacy signature: original terms were not captured.'}</p></div><div class="row-actions">${button('View signed terms','signed-terms',`data-id="${esc(s.id)}"`)}${admin()?button('Verify / manage','manage-signature',`data-id="${esc(s.id)}"`):''}</div></div></div>`;}).join('')||'<p>Review the scope, budget, milestones and payment terms above before signing.</p>'}${sig&&signatureOutdated(sig,p)&&!admin()?button('Sign updated terms','sign','','primary'):''}${founder}<p class="small muted">A time-stamped project record, available in your report.</p></section>`;
}
function feedbackView(){const rs=admin()?requests():visibleRequests();return `<section class="panel" style="margin-top:16px"><div class="panel-head"><h3>Feedback & revisions</h3>${badge('revision',rs.length+' requests')}</div>${rs.map(r=>{const review=reviewOf(r);return `<div class="list-row"><strong>${esc(r.requestType||'Feedback')} · ${r.itemNumber?'Deliverable '+esc(r.itemNumber):'Project-wide'}</strong><p class="prewrap">${esc(review.displayMessage??r.message)}</p><p>${esc(dateText(r.submittedAt))} · ${esc(review.status||'new')}</p>${feedbackAttachmentButtons(r)}${review.response?`<div class="response"><strong>Vision Flow</strong><p class="prewrap">${esc(review.response)}</p></div>`:''}${admin()?button('Edit / respond','review-feedback',`data-id="${esc(r.id)}" data-collection="${r.collection}"`):''}</div>`;}).join('')||'<p class="muted">No requests yet. Send project feedback here or use the button beside any deliverable.</p>'}${!admin()?button('Send feedback / revision','feedback-project'):''}</section>`;}
function productionView(){
  const p=project(),columns=deliveryColumns(p,{includeInternal:admin()}),searchLabels=columns.filter(column=>['b','t'].includes(column.key)).map(column=>column.label).join(', ')||'deliverable number';
  const cell=(item,column)=>{
    if(column.type==='link'){
      // Gated delivery: client dl requires active signature
      if(column.key==='dl' && !admin()) {
        if(!item.hasDelivery) return item.s==='revision'?'<span class="small muted cell-note" title="We will email you as soon as the revised file is delivered.">Revision in progress</span>':item.s&&item.s!=='delivered'?'<span class="small muted cell-note" title="The file appears here once this item is delivered. We will notify you by email.">After delivery</span>':'—';
        const attr=`type="button" data-action="gated-download" data-delivery="${esc(String(item.n))}"`;
        // Agreement pending: the same Download button opens a guide to the missing step.
        if(!onboarding.projectReady(state.projectKey)) return `<button class="button small primary" ${attr}>Download</button><span class="small muted cell-note">Agreement step needed</span>`;
        const d=downloadDecision(p,item,confirmation,Date.now(),receiptFor);
        if(d.allowed)return `<button class="button small" ${attr}>Download</button>${d.reason==='deemed'?'<span class="small muted cell-note">Auto-approved</span>':d.reason==='received'?'<span class="small muted cell-note">Received - 72h review open</span>':''}`;
        if(d.reason==='pending')return `<button class="button small primary" ${attr}>Download</button>`;
        return `<button class="button small" ${attr}>${d.reason==='rejection-pending'?'Rejection under review':'Revision in progress'}</button>`;
      }
      const url = safeUrl(item[column.key]);
      if(!url) return '—';
      if(column.key==='dl'&&admin()){if(item.s!=='delivered')return link(url,'Open')+'<span class="small muted cell-note">Hidden from client until status is Delivered</span>';const d=downloadDecision(p,{...item,hasDelivery:true},confirmation,Date.now(),receiptFor);const note=d.reason==='legacy'?'':{confirmed:'Verified',deemed:'Auto-approved (72h)',pending:'Awaiting client download',received:`Downloaded ${dateText(d.view?.receipt?.receivedAt)} - 72h review open`,'rejection-pending':'Rejection submitted',rejected:'Rejected',dismissed:'Closed - delivery stands'}[d.reason]||'';return link(url,'Open')+(note?`<span class="small muted cell-note">${esc(note)}</span>`:'');}
      return link(url, 'Open');
    }
    return column.type==='date'&&item[column.key]?fmtDate(item[column.key]):esc(item[column.key]||'—');
  };
  return `<section id="deliveries" class="panel" style="margin-top:18px"><div class="panel-head"><div><h3>Production log</h3><p class="muted small">Only populated fields appear. Each attached file type gets its own column; blank rows show a dash only after that column is in use.</p></div>${admin()?button('Archived rows','archived-rows')+button('Export CSV','export-csv'):button('Export CSV','export-csv')}</div><div class="filter-row"><input class="input" id="itemSearch" aria-label="Search production log" placeholder="Search ${esc(searchLabels)}" value="${esc(state.filter)}"><select class="select" id="itemStatus" aria-label="Filter status"><option value="">All statuses</option>${STATUS.map(s=>`<option value="${s}" ${s===state.status?'selected':''}>${LABEL[s]}</option>`).join('')}</select><select class="select" id="itemBatch" aria-label="Filter batch"><option value="">All batches</option><option value="1" ${state.batch==='1'?'selected':''}>Batch 1</option><option value="2" ${state.batch==='2'?'selected':''}>Batch 2</option></select></div><p class="small muted" id="filterCount"></p><div class="table-wrap"><table><thead><tr><th>#</th>${columns.map(column=>`<th>${esc(column.label)}</th>`).join('')}<th>Status</th><th>Actions</th></tr></thead><tbody>${itemsOf(p).map(i=>`<tr data-item-row data-status="${i.s}" data-batch="${i.batch||(i.n<=50?1:2)}" data-search="${esc(`${i.n} ${i.b||''} ${i.t||''}`.toLowerCase())}"><td class="item-no" data-label="#">${String(i.n).padStart(3,'0')}</td>${columns.map(column=>{const v=cell(i,column);return `<td data-label="${esc(column.label)}"${v==='\u2014'?' class="is-empty"':''}>${v}</td>`;}).join('')}<td data-label="Status">${badge(i.s)}</td><td class="item-actions" data-label="Actions">${admin()?button('Edit','edit-item',`data-number="${i.n}"`):button('Feedback / revision','feedback-item',`data-number="${i.n}"`)}</td></tr>`).join('')}</tbody></table></div></section>`;}
function applyFilters(){let count=0;document.querySelectorAll('[data-item-row]').forEach(r=>{r.hidden=!!((state.filter&&!r.dataset.search.includes(state.filter.toLowerCase()))||(state.status&&r.dataset.status!==state.status)||(state.batch&&r.dataset.batch!==state.batch));if(!r.hidden)count++;});if($('filterCount'))$('filterCount').textContent=`${count} of ${itemsOf(project()).length} deliverables shown`;}

function clearSubscriptions(){rootStop?.();rootStop=null;brandingStop?.();brandingStop=null;Object.values(artifactStops).forEach(x=>x.stop());artifactStops={};state.artifacts={};}
function watchBranding(){brandingStop=onSnapshot(doc(db,'site','main'),snap=>{state.founder=founderBranding(snap.data()?.site?.agency,DEFAULT_FOUNDER);if(state.loaded)render();},fail);}
function watchArtifacts(key,c){
  if(artifactStops[key]?.token===c.accessToken)return;artifactStops[key]?.stop();
  const names=['sigs','confirms','feedback','consent','agreements','acknowledgements','reviews','notices','receipts'];
  state.artifacts[key]=Object.fromEntries(names.map(name=>[name,[]]));state.artifacts[key].ready={};if(!c.accessToken)return;
  const stops=names.map(name=>onSnapshot(collection(db,'portal_public',c.accessToken,name),{includeMetadataChanges:true},snap=>{
    // Local optimistic writes are not evidence of stored consent or signatures.
    if(snap.metadata.hasPendingWrites)return;
    state.artifacts[key][name]=snap.docs.map(d=>({...d.data(),id:d.id,collection:name}));
    state.artifacts[key].ready[name]=true;render();
  },error=>{state.error=errorMessage(error);fail(error);}));
  artifactStops[key]={token:c.accessToken,stop:()=>stops.forEach(s=>s())};
}
function startAdmin(){
  clearSubscriptions();watchBranding();state.mode='admin';const q=new URLSearchParams(location.search);state.clientKey=q.get('c');state.projectKey=q.get('p');state.tab=q.get('tab')==='log'?'log':'overview';state.page=q.get('v')==='trash'?'trash':'workspace';
  rootStop=onSnapshot(collection(db,'portal_clients'),snap=>{state.clients={};snap.forEach(d=>state.clients[d.id]=normalizeClient(d.data(),d.id));for(const [key,c] of Object.entries(state.clients)){if(!c._deleted){watchArtifacts(key,c);syncDeliveryAccess(key,c);}}for(const key of Object.keys(artifactStops)){if(!state.clients[key]||state.clients[key]._deleted){artifactStops[key].stop();delete artifactStops[key];delete state.artifacts[key];}}if(state.clientKey&&(!client()||client()._deleted)){state.clientKey=null;state.projectKey=null;}render();},error=>{state.mode='error';state.error=errorMessage(error);render();});
}
function startClient(access){
  clearSubscriptions();watchBranding();state.mode='client';state.token=access;const q=new URLSearchParams(location.search);state.projectKey=q.get('p');state.tab=q.get('tab')==='log'?'log':'overview';
  rootStop=onSnapshot(doc(db,'portal_public',access),snap=>{if(!snap.exists()||snap.data().enabled===false){state.mode='error';state.error='This private link is no longer active. It may have been replaced or disabled by the administrator. Please contact Vision Flow for a current link.';render();return;}state.publicClient=normalizeClient(snap.data(),snap.data().clientSlug);state.clientKey=state.publicClient.clientSlug;watchArtifacts(state.clientKey,{accessToken:access});render();},error=>{state.mode='error';state.error=error.code?.includes('permission-denied')?'This private link is unavailable or has been disabled. Ask Vision Flow for a current link.':errorMessage(error);render();});
}
async function saveClient(draft,notice='Saved',operations=[],{allowRecovery=false,manualNotice=null}={}){
  requireAdmin();const next=normalizeClient(draft,draft.slug);const expected=Number(draft._revision)||0;next.lastUpdated=now();
  if(!allowRecovery&&!next._deleted)operations=[...operations,...ensureDeliveryApprovals(next,next.lastUpdated).flatMap(id=>[{path:['confirms',id],delete:true},{path:['receipts',id],delete:true}])];next._revision=expected+1;next._lastMutationId=uid('save');next.accessToken ||= newToken();
  if(operations.length>MAX_SAVE_OPERATIONS)throw new Error('This operation is too large for one save. Export a backup and process records in smaller groups.');
  await runTransaction(db,async tx=>{
    const ref=doc(db,'portal_clients',next.slug),current=await tx.get(ref),persisted=current.data();
    if(persisted?._lastMutationId===next._lastMutationId)return;
    if(persisted?.purgeState&&!allowRecovery)throw new Error('Permanent deletion is already in progress for this recycled client. Resume or finish it before making other changes.');
    if(recoveryPending(persisted)&&!allowRecovery)throw new Error('A protected recovery task is in progress. Resume or finish it from Link settings or the recycle bin before making other changes.');
    if(current.exists()&&(Number(persisted._revision)||0)!==expected)throw new Error('This client changed in another tab. Close this form, review the latest details, then retry.');
    if(!current.exists()&&expected>0)throw new Error('This client has been removed. Refresh the workspace.');
    next.reviewEpoch=nextReviewEpoch(next,persisted||{});
    const manifests=prepareSecureSave(next,persisted||{});
    const publication=prepareNotificationSave(next,persisted||{},{timestamp:serverTimestamp(),manualNotice,
      suppress:allowRecovery||recoveryPending(next)||Boolean(persisted?.accessToken&&persisted.accessToken!==next.accessToken)});
    const guards=[];
    for(const key of publication.guardKeys){const target=doc(db,'portal_public',next.accessToken,'review_guards',key);if(!(await tx.get(target)).exists())guards.push(target);}
    if(operations.length+manifests.length+publication.writes.length+guards.length>MAX_SAVE_OPERATIONS)throw new Error('This operation exceeds one atomic save. Process fewer project changes at a time.');
    tx.set(ref,next);tx.set(doc(db,'portal_public',next.accessToken),publicSnapshot(next,next.slug));
    for(const op of [...operations,...manifests]){const target=doc(db,'portal_public',op.token||next.accessToken,...op.path);op.delete?tx.delete(target):tx.set(target,op.data);}
    for(const op of publication.writes)tx.set(doc(db,op.path),op.data);
    for(const target of guards)tx.set(target,{revision:0});
  });
  state.clients[next.slug]=next;notify(notice);return next;
}
function modal(title,subtitle,body,submit,label='Save'){
  modalReturnFocus=document.activeElement;$('modalLayer').hidden=false;document.body.classList.add('modal-open');
  $('modalContent').innerHTML=`<h2 id="modalTitle">${esc(title)}</h2><p class="modal-sub">${esc(subtitle)}</p><form id="modalForm"><div class="form-grid">${body}</div><p class="form-error" role="alert"></p><div class="form-actions">${button('Cancel','close-modal')}${submit?`<button class="button primary" type="submit">${esc(label)}</button>`:''}</div></form>`;
  const form=$('modalForm');form.addEventListener('submit',async event=>{event.preventDefault();if(state.busy||!submit)return;state.busy=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);const send=form.querySelector('[type=submit]');send.textContent='Saving…';form.querySelector('.form-error').textContent='';
    try { await submit(new FormData(form),form); } catch(error){form.querySelector('.form-error').textContent=errorMessage(error);fail(error);} finally {state.busy=false;if(form.isConnected){buttons.forEach(b=>b.disabled=false);send.textContent=label;}else render();}
  });
  queueMicrotask(()=>($('modalContent').querySelector('input,textarea,select,button'))?.focus());
}
function closeModal(){if(state.busy)return;founderPreparationId++;$('modalLayer').hidden=true;$('modalLayer').querySelector('.modal').classList.remove('report-modal');document.body.classList.remove('modal-open');if(previewObjectUrl){URL.revokeObjectURL(previewObjectUrl);previewObjectUrl=null;}pad=null;founderPreparedBlob=null;modalReturnFocus?.focus();render();}
function finishModal(){state.busy=false;closeModal();}
function confirmAction(message){
  return new Promise(resolve=>{
    const previous=document.activeElement,dialog=document.createElement('dialog');
    dialog.className='confirmation-dialog';
    dialog.innerHTML='<h2>Confirm action</h2><p></p><div class="actions"><button type="button" class="button" data-choice="cancel">Cancel</button><button type="button" class="button primary" data-choice="continue">Continue</button></div>';
    dialog.querySelector('p').textContent=message;
    const done=value=>{dialog.close();dialog.remove();previous?.focus();resolve(value);};
    dialog.addEventListener('cancel',event=>{event.preventDefault();done(false);});
    dialog.addEventListener('click',event=>{const choice=event.target.closest('[data-choice]');if(choice)done(choice.dataset.choice==='continue');});
    document.body.append(dialog);dialog.showModal();dialog.querySelector('button').focus();
  });
}
function waLink(){const c=client();let phone=(c.phone||'').replace(/[^0-9]/g,'');if(/^01[3-9][0-9]{8}$/.test(phone))phone='88'+phone;else if(/^00/.test(phone))phone=phone.slice(2);if(!phone){notify('No phone number saved for this client.');return;}const msg=encodeURIComponent('Hello '+c.name+', please check your project portal for updates: '+clientUrl(c,state.projectKey)+'\n\nOur emails come from visionflow.agency.bd@gmail.com. Please add it to your contacts so our updates do not go to Spam.');window.open('https://wa.me/'+phone+'?text='+msg,'_blank');}
function mailLink(){
  requireAdmin();const c=client();if(!c.email){notify('Save this client\'s email before sending.');return;}
  modal('Email this project','The agency worker sends this message to the saved client address. This creates a new reviewable update; the old history stays intact.',`${field('Update title','title','Project update','text','required maxlength="200"')}${area('Message visible to the client','message','','required minlength="10" maxlength="4000"')}<p class="small muted">The email includes this project\'s private action link. It is emailed within about 5 minutes.</p>`,async data=>{
    await saveClient(clone(c),'Email queued; open Notification queue to check its status.',[],{manualNotice:{projectKey:state.projectKey,title:text(data.get('title')),message:text(data.get('message'))}});finishModal();
  },'Queue agency email');
}
function openClientForm(edit=false){
  requireAdmin();const draft=edit?clone(client()):normalizeClient({name:'',accessEnabled:true},'');draft.agreementMode=draft.agreementMode==='project'?'project':'agency-partner';
  modal(edit?'Edit client':'Create a client','A private share link is created automatically.',`${field('Client name','name',draft.name,'text','required maxlength="120"')}${!edit?field('URL label','slug','','text','required pattern="[a-z0-9-]+" maxlength="80"'):''}${field('Email','email',draft.email||'','email')}${field('Phone','phone',draft.phone||'')}${select('Agreement route','agreementMode',[['agency-partner','Agency partner — one master signature across projects'],['project','Project-by-project signature']],draft.agreementMode)}`,async data=>{const c=clone(draft);if(!edit){c.slug=text(data.get('slug'));if(state.clients[c.slug])throw new Error('This URL label already exists, including the recycle bin. Choose a different label.');c.createdAt=now();}c.name=text(data.get('name'));c.email=text(data.get('email'));c.phone=text(data.get('phone'));c.agreementMode=data.get('agreementMode')==='project'?'project':'agency-partner';await saveClient(c,edit?'Client updated':'Client created');state.clientKey=c.slug;state.projectKey=null;finishModal();});
}
function approvalSuggestion(title,desc){modal('Request client confirmation?','Your change is saved. Add a review request only when the client needs to explicitly confirm it.',`${field('Approval title','title',title,'text','required maxlength="200"')}${area('Message','desc',desc,'required maxlength="4000"')}`,async data=>{const c=clone(client());c.projects[state.projectKey].approvals.push({id:uid('approval'),title:text(data.get('title')),desc:text(data.get('desc')),createdAt:now()});await saveClient(c,'Approval request sent');await sendNotification({type:'approval',projectName:c.projects[state.projectKey].name,message:text(data.get('title'))+' - '+text(data.get('desc'))});finishModal();},'Send approval request');}
function openProjectForm(edit=false){
  requireAdmin();const draft=clone(client()), p=edit?clone(project()):{name:'',items:[],payments:[],approvals:[],rate:500,budget:50000,status:'active',weeklyTarget:12,itemLabel:'Item / subject',titleLabel:'Deliverable title',showItemField:true};
  modal(edit?'Edit project':'Create a project','Choose labels that match this project. Scope and payment terms are visible to the client.',`${field('Project name','name',p.name,'text','required maxlength="160"')}${!edit?field('Project URL label','slug','','text','required pattern="[a-z0-9-]+" maxlength="80"'):''}<div class="form-grid two">${field('Total deliverables','total',edit?itemsOf(p).length:100,'number','min="0" max="1000" required')}${field('Rate (BDT)','rate',p.rate??0,'number','min="0" step="0.01" required')}${field('Budget (BDT)','budget',p.budget??0,'number','min="0" step="0.01" required')}${select('Status','status',['active','paused','completed'],p.status||'active')}${field('Target date','deadline',p.deadline||'','date')}${field('Weekly target','weeklyTarget',p.weeklyTarget||0,'number','min="0" max="1000"')}</div><div class="form-grid two">${field('Item / subject label','itemLabel',p.itemLabel||'Item / subject','text','required maxlength="60"')}${field('Deliverable title label','titleLabel',p.titleLabel||'Deliverable title','text','required maxlength="60"')}</div><label class="check-field"><input type="checkbox" name="showItemField" ${p.showItemField!==false?'checked':''}> Use a separate item / subject field for each deliverable</label>${area('Scope / description','scope',p.scope||'','maxlength="4000"')}${area('Payment & delivery terms','terms',p.terms||'','maxlength="6000"')}${area('Next milestone','milestoneText',p.milestoneText||'','maxlength="2000"')}${field('Source script folder / document URL','sourceScriptUrl',p.sourceScriptUrl||'','url')}${field('Avatar / character folder URL','avatarFolderUrl',p.avatarFolderUrl||'','url')}`,async data=>{const c=clone(draft),key=edit?state.projectKey:text(data.get('slug'));if(!edit&&c.projects[key])throw new Error('A project already uses this label.');const n=clone(p);resizeItems(n,Number(data.get('total')));for(const f of ['name','status','scope','terms','deadline','milestoneText','sourceScriptUrl','avatarFolderUrl'])n[f]=text(data.get(f));n.itemLabel=text(data.get('itemLabel'))||'Item / subject';n.titleLabel=text(data.get('titleLabel'))||'Deliverable title';n.showItemField=data.get('showItemField')==='on';n.rate=validateAmount(data.get('rate'),'Rate');n.budget=validateAmount(data.get('budget'),'Budget');n.weeklyTarget=validateAmount(data.get('weeklyTarget'),'Weekly target');n.slug=key;n.createdAt ||= now();n.lastUpdated=now();c.projects[key]=n;await saveClient(c,edit?'Project updated':'Project created');state.projectKey=key;if(!edit)sendNotification({type:'project_created',projectName:n.name,deliverables:String(itemsOf(n).length),rate:n.rate,budget:n.budget});finishModal();approvalSuggestion(`${n.name} — ${edit?'updated project details':'project scope'}`,`${n.totalItems} deliverables at ${money(n.rate)} each. Agreed budget: ${money(n.budget)}. ${n.milestoneText||''}\nPlease review the project overview and confirm these details.`);});
}
function openItem(number){
  requireAdmin();const draft=clone(client()),p=draft.projects[state.projectKey],i=p.items.find(x=>Number(x.n)===number);if(!i)return;const labels=deliveryLabels(p);
  modal(`Edit deliverable ${number}`,'Every source and delivery link you add is shown to the client in its own column. Internal notes never leave the administrator workspace.',`<div class="form-grid two">${labels.showItem?field(labels.item,'b',i.b||''):''}${field(labels.title,'t',i.t||'')}${select('Status','s',STATUS,i.s)}${field('Batch','batch',i.batch||(number<=50?1:2),'number','min="1" max="100"')}${field('Started date','sd',i.sd||'','date')}${field('Delivered date','dd',i.dd||'','date')}${field('Duration','dur',i.dur||'')}</div>${field('Final delivery / Drive link','dl',i.dl||'','url')}${field('Script URL','scriptUrl',i.scriptUrl||'','url')}${field('Character / avatar URL','avatarUrl',i.avatarUrl||'','url')}${field('Reference URL','referenceUrl',i.referenceUrl||'','url')}${area('Client-visible delivery note','clientNote',i.clientNote||'','maxlength="4000"')}${area('Internal admin note — never visible to the client','no',i.no||'','maxlength="4000"')}${button('Move row to bin','archive-item',`data-number="${number}"`,'danger')}`,async data=>{const c=clone(draft),item=c.projects[state.projectKey].items.find(x=>Number(x.n)===number);for(const f of ['t','s','sd','dd','dur','dl','scriptUrl','avatarUrl','referenceUrl','clientNote','no'])item[f]=text(data.get(f));if(labels.showItem)item.b=text(data.get('b'));item.batch=Number(data.get('batch'));await saveClient(c,'Deliverable updated');finishModal();if(isDone(item)&&item.s!==i.s){const name=[labels.showItem&&item.b,item.t].filter(Boolean).join(' — ');sendNotification({type:'delivery',projectName:c.projects[state.projectKey].name,videoTitle:name,deliveryNum:number,note:item.clientNote||''});}});
}
function portalUploadOptions(form){
  return {authorize:requireAdmin,observeAuth:listener=>onAuthStateChanged(auth,user=>listener(user?.uid===ADMIN_UID)),
    onProgress:percent=>{const button=form.querySelector('[type=submit]');if(button)button.textContent=percent===100?'Processing image...':`Uploading ${percent}%`;}};
}
function uploadProof(file,form){
  return uploadPortalImage(file,'proofs',portalUploadOptions(form));
}
const canvasBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not prepare the signature image.')),'image/png'));
async function normalizeSignatureFile(file){
  if(!/^image\/(png|jpeg|webp)$/i.test(file.type)||file.size>20*1024*1024)throw new Error('Use a PNG, JPEG or WebP image under 20 MB.');
  const source=await createImageBitmap(file),scale=Math.min(1,1600/source.width,1000/source.height),w=Math.max(1,Math.round(source.width*scale)),h=Math.max(1,Math.round(source.height*scale));
  const input=document.createElement('canvas');input.width=w;input.height=h;const ctx=input.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);source.close?.();
  const image=ctx.getImageData(0,0,w,h),pixels=image.data,sample=[];const step=Math.max(1,Math.floor(Math.min(w,h)/180));
  for(let x=0;x<w;x+=step){sample.push([pixels[x*4],pixels[x*4+1],pixels[x*4+2]]);const i=((h-1)*w+x)*4;sample.push([pixels[i],pixels[i+1],pixels[i+2]]);}for(let y=0;y<h;y+=step){let i=y*w*4;sample.push([pixels[i],pixels[i+1],pixels[i+2]]);i=(y*w+w-1)*4;sample.push([pixels[i],pixels[i+1],pixels[i+2]]);}
  const median=channel=>sample.map(p=>p[channel]).sort((a,b)=>a-b)[Math.floor(sample.length/2)]||255,bg=[median(0),median(1),median(2)],transparent=[...Array(Math.min(w*h,3000)).keys()].some(n=>pixels[Math.floor(n*(w*h-1)/Math.min(w*h-1,2999))*4+3]<220);
  let left=w,top=h,right=-1,bottom=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,a=pixels[i+3],distance=Math.hypot(pixels[i]-bg[0],pixels[i+1]-bg[1],pixels[i+2]-bg[2]),strength=transparent?a:Math.max(0,Math.min(255,(distance-13)*5));pixels[i]=5;pixels[i+1]=20;pixels[i+2]=60;pixels[i+3]=strength<18?0:Math.round(strength);if(pixels[i+3]>24){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}}
  if(right<left||bottom<top)throw new Error('No clear signature could be detected. Use darker ink and even lighting.');ctx.putImageData(image,0,0);
  const inkW=right-left+1,inkH=bottom-top+1,pad=Math.max(10,Math.round(Math.max(inkW,inkH)*.045)),cropW=inkW+pad*2,cropH=inkH+pad*2,outScale=Math.min(1,1200/cropW,460/cropH),output=document.createElement('canvas');output.width=Math.max(1,Math.round(cropW*outScale));output.height=Math.max(1,Math.round(cropH*outScale));output.getContext('2d').drawImage(input,left-pad,top-pad,cropW,cropH,0,0,output.width,output.height);return canvasBlob(output);
}
function uploadFounderSignature(blob,form){return uploadPortalImage(blob,'signatures',portalUploadOptions(form));}
function openFounderSignature(){
  requireAdmin();founderPreparationId++;founderPreparedBlob=null;const current={...state.founder};
  modal('Founder signature','Draw or upload a signature, then review the prepared preview before saving.',`${field('Authorized name','founderName',current.name,'text','required maxlength="160"')}${field('Title','founderTitle',current.title,'text','required maxlength="120"')}<div class="field"><label>Current signature</label><img id="founderSignaturePreview" class="founder-signature-preview ${safeUrl(current.signatureUrl)?'visible':''}" ${safeUrl(current.signatureUrl)?`src="${esc(safeUrl(current.signatureUrl))}"`:''} alt="Founder signature preview"></div><div class="field"><label for="f-founderSignatureFile">Upload signature photo or PNG</label><input class="input" id="f-founderSignatureFile" name="founderSignatureFile" type="file" accept="image/png,image/jpeg,image/webp"><small>Best result: dark ink, steady top-down photo and an uncluttered background.</small></div><div class="field"><label>Or draw a fresh signature</label><canvas id="signatureCanvas" class="signature-pad" aria-label="Draw founder signature with mouse or touch"></canvas>${button('Clear drawing','clear-signature')}</div><label class="check-field"><input type="checkbox" name="removeSignature"> Remove the founder signature from public views and future documents</label>`,async(data,form)=>{
    requireAdmin();
    if(form.dataset.signaturePreparing==='true')throw Error('Wait for the signature preview before saving.');
    let signatureUrl=current.signatureUrl;
    if(data.get('removeSignature'))signatureUrl='';
    else{
      if(pad?.drawn)founderPreparedBlob=await normalizeSignatureFile(new File([await canvasBlob(pad.canvas)],'drawn-signature.png',{type:'image/png'}));
      else if(form.elements.founderSignatureFile.files.length&&!founderPreparedBlob)throw Error('The selected signature could not be prepared. Choose another image or draw a signature.');
      if(founderPreparedBlob)signatureUrl=await uploadFounderSignature(founderPreparedBlob,form);
      if(!safeUrl(signatureUrl))throw Error('Draw or upload a signature before saving.');
    }
    const next={signatureUrl,name:text(data.get('founderName')),title:text(data.get('founderTitle'))};
    await saveFounderBranding({expected:current,next,fallback:DEFAULT_FOUNDER,authorize:requireAdmin,transaction:fn=>runTransaction(db,tx=>fn({
      get:async path=>{const snap=await tx.get(doc(db,path));return snap.exists()?snap.data():null;},update:(path,value)=>tx.update(doc(db,path),value)
    }))});
    state.founder=next;notify('Founder branding saved. Future document previews use the updated signature.');finishModal();
  },'Save founder signature');initPad();
}

async function prepareFounderPreview(input){
  requireAdmin();const file=input.files[0],form=input.form;if(!file||!form)return;
  const generation=++founderPreparationId,canvas=pad?.canvas,send=form.querySelector('[type=submit]');
  const current=()=>generation===founderPreparationId&&form.isConnected&&$('modalForm')===form&&!$('modalLayer').hidden&&admin();
  founderPreparedBlob=null;form.dataset.signaturePreparing='true';input.disabled=true;send.disabled=true;
  if(canvas)canvas.style.pointerEvents='none';form.querySelector('.form-error').textContent='';
  try{
    notify('Preparing signature preview...');const prepared=await normalizeSignatureFile(file);
    if(!current())return;
    founderPreparedBlob=prepared;if(previewObjectUrl)URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl=URL.createObjectURL(prepared);$('founderSignaturePreview').src=previewObjectUrl;$('founderSignaturePreview').classList.add('visible');
    if(pad)pad.drawn=false;notify('Review the prepared signature before saving.');
  }catch(error){if(current()){founderPreparedBlob=null;form.querySelector('.form-error').textContent=errorMessage(error);fail(error);}}
  finally{input.disabled=false;if(canvas)canvas.style.pointerEvents='';if(generation===founderPreparationId){delete form.dataset.signaturePreparing;if(!state.busy)send.disabled=false;}}
}
let notificationPageCursor=null;
async function openNotificationStatus(next=false){
  requireAdmin();
  const snapshot=await getDocs(query(collection(db,'portal_outbox'),orderBy('createdAt','desc'),...(next&&notificationPageCursor?[startAfter(notificationPageCursor)]:[]),limit(40)));
  notificationPageCursor=snapshot.docs.at(-1)||null;
  modal('Email notifications','Newest first, 40 per page. “Sent” means Gmail accepted the message; the recipient inbox is not confirmed.',
    `${notificationStatusHtml(snapshot.docs.map(d=>({...d.data(),id:d.id})),state.clients)}<div class="actions wrap">${button('First page / refresh','notification-status')}${snapshot.size===40?button('Next page','notification-next'):''}${button('Notification preferences','email-settings')}</div><p class="small muted">If a message shows an uncertain status, check the sender’s Gmail “Sent” folder before sending again.</p>`,null);
}
async function openEmailSettings(){
  requireAdmin();
  const privateSnap=await getDoc(EMAIL_SETTINGS()),siteSnap=await getDoc(doc(db,'site','main'));
  const existing=privateSnap.exists()?privateSnap.data():{},settings=notificationSettings(existing);
  const site=siteSnap.data()||{},legacyKeys=['emailWebhookUrl','adminWebhookUrl','adminEmail','senders','enableEmail'];
  const hasLegacy=legacyKeys.some(key=>Object.hasOwn(site.notifications||{},key)||Object.hasOwn(site.site?.notifications||{},key));
  modal('Email settings','Choose who receives automatic emails. Emails are sent from the agency Gmail account by the Vision Flow email service.',
    `<label class="check-field"><input type="checkbox" name="enabled" ${settings.enabled?'checked':''}> Send automatic emails</label>
    <p class="small muted">Turn this off to pause all emails; nothing is lost — paused emails wait and send when you turn it back on. The display name and reply-to change how emails look, not the sending Gmail account.</p>
    <h3>Client notifications</h3><label class="check-field"><input type="checkbox" name="clientEnabled" ${settings.clientEnabled?'checked':''}> Email clients about updates, deliveries, payments and approvals</label>
    ${field('Sender name shown to clients','clientSenderName',settings.clientSenderName,'text','required maxlength="120"')}
    ${field('Client replies go to (optional)','clientReplyTo',settings.clientReplyTo,'email','maxlength="254"')}
    <h3>Admin alerts</h3><label class="check-field"><input type="checkbox" name="adminEnabled" ${settings.adminEnabled?'checked':''}> Email me when a client confirms, rejects, signs or sends feedback</label>
    ${field('Admin alert email','adminEmail',settings.adminEmail,'email','maxlength="254"')}
    ${field('Sender name for admin alerts','adminSenderName',settings.adminSenderName,'text','required maxlength="120"')}
    ${field('Admin alert reply-to (optional)','adminReplyTo',settings.adminReplyTo,'email','maxlength="254"')}
    <p class="small muted">Gmail allows about 100 recipients per day on this account.</p>
    ${hasLegacy?'<p class="small muted">Saving also removes retired relay settings from public website data. No browser will send to those endpoints.</p>':''}`,
    async data=>{
      const value=validateNotificationSettings(notificationSettings({...Object.fromEntries(data),enabled:data.get('enabled')==='on',clientEnabled:data.get('clientEnabled')==='on',adminEnabled:data.get('adminEnabled')==='on'}));
      const batch=writeBatch(db);
      batch.set(EMAIL_SETTINGS(),{...value,clientWebhookUrl:deleteField(),updatedAt:serverTimestamp(),updatedBy:state.user.uid},{merge:true});
      if(hasLegacy)batch.update(doc(db,'site','main'),{'notifications.emailWebhookUrl':deleteField(),'notifications.adminWebhookUrl':deleteField(),'notifications.adminEmail':deleteField(),'notifications.senders':deleteField(),'notifications.enableEmail':deleteField(),'site.notifications.emailWebhookUrl':deleteField(),'site.notifications.adminWebhookUrl':deleteField(),'site.notifications.adminEmail':deleteField(),'site.notifications.senders':deleteField(),'site.notifications.enableEmail':deleteField(),'meta.updatedAt':Date.now()});
      await batch.commit();notify(value.enabled?'Notification preferences saved; the configured worker can process the queue.':'Notification sending paused. Queued source records are retained.');finishModal();
    },'Save notification preferences');
}
function openPayment(id){
  requireAdmin();const draft=clone(client()),existing=project().payments.find(p=>p.id===id),p=clone(existing||{date:localDay(),amount:'',type:'Advance',note:''});
  modal(existing?'Edit payment':'Record payment','Upload proof here. The preview appears before saving.',`<div class="form-grid two">${field('Payment date','date',p.date,'date','required')}${field('Amount (BDT)','amount',p.amount,'number','min="0" step="0.01" required')}${select('Payment type','type',['Advance','Milestone','bKash','Nagad','Bank transfer','Final','Other'],p.type)}</div>${area('Payment note','note',p.note||'','maxlength="2000"')}${field('Payment proof image','proof','','file','accept="image/png,image/jpeg,image/webp,image/gif"')}${p.proofUrl?`<label><input type="checkbox" name="removeProof"> Remove existing proof</label>`:''}<img id="proofPreview" class="preview ${p.proofUrl?'visible':''}" ${safeUrl(p.proofUrl)?`src="${esc(safeUrl(p.proofUrl))}"`:''} alt="Payment proof preview">`,async(data,form)=>{const c=clone(draft),pay=clone(p);pay.date=text(data.get('date'));pay.amount=validateAmount(data.get('amount'));pay.type=text(data.get('type'));pay.note=text(data.get('note'));if(data.get('removeProof'))delete pay.proofUrl;const file=form.elements.proof.files[0];if(file)pay.proofUrl=await uploadProof(file,form);pay.id ||= uid('payment');pay.recordedAt ||= now();delete pay.verifyDeadline;const rows=c.projects[state.projectKey].payments;const index=rows.findIndex(x=>x.id===id);index<0?rows.push(pay):rows.splice(index,1,pay);await saveClient(c,'Payment saved');const pm=metrics(c.projects[state.projectKey]);await sendNotification({type:'payment',projectName:c.projects[state.projectKey].name,amount:pay.amount,paymentType:pay.type,date:fmtDate(pay.date),method:pay.type,totalPaid:pm.paid,totalDue:pm.budget-pm.paid,budget:pm.budget,proofUrl:pay.proofUrl||''});finishModal();});
}
function openApproval(id){requireAdmin();const draft=clone(client()),a=clone(project().approvals.find(a=>a.id===id)||{title:'',desc:''});modal(id?'Edit approval':'Request approval','The client can explicitly confirm or reject this update from the overview.',`${field('Title','title',a.title,'text','required maxlength="200"')}${area('What should the client review?','desc',a.desc,'required maxlength="4000"')}`,async data=>{const c=clone(draft),rows=c.projects[state.projectKey].approvals;const entry={...a,id:id?uid('approval'):a.id||uid('approval'),title:text(data.get('title')),desc:text(data.get('desc')),createdAt:id?now():a.createdAt||now(),updatedAt:now()};delete entry.verifyDeadline;const index=rows.findIndex(x=>x.id===id);index<0?rows.push(entry):rows.splice(index,1,entry);const ops=id?[{path:['confirms',id],delete:true}]:[];await saveClient(c,id?'Approval updated; client review restarted':'Approval requested',ops);finishModal();});}
async function submitClientEvidence(id,data,attachments=[]){
  const root=`portal_public/${state.token}`;
  return submitReviewEvidence({root,collection:'confirms',id,data,attachments,timestamp:serverTimestamp(),transaction:fn=>runTransaction(db,tx=>fn({get:async path=>{const snap=await tx.get(doc(db,path));return snap.exists()?snap.data():null;},set:(path,value)=>tx.set(doc(db,path),value)}))});
}
function feedbackAttachmentButtons(record){
  return (record.attachments||[]).map(file=>button(`Download ${file.name} (${attachmentSize(file.size)})`,'download-feedback-attachment',`data-id="${esc(record.id)}" data-collection="${esc(record.collection)}" data-attachment="${esc(file.id)}"`)).join('');
}
function openFeedback(number=0){
  const projectKey=state.projectKey,id=uid('feedback');
  modal(number?`Feedback for deliverable ${number}`:'Project feedback','Send a question, delivery note or revision request. Your reply will appear here.',`${select('Request type','requestType',[['feedback','Feedback / note'],['revision','Revision request'],['question','Question']],'feedback')}${area('Message','message','','required maxlength="4000"')}${field('Optional documents / images','attachments','','file',`multiple accept="${ATTACHMENT_ACCEPT}"`)}<p class="muted">Up to 3 files, 512 KiB each: PDF, DOCX, TXT, PNG or JPG. Files are available to the team and anyone with this private workspace link. Files are not malware-scanned; open only expected documents from a trusted sender. Larger files are not supported here.</p>`,async(data,form)=>{
    const message=text(data.get('message'));if(!message)throw new Error('Please enter your message.');
    const timestamp=serverTimestamp(),attachments=await prepareFeedbackAttachments(form.elements.attachments.files,{id,projectKey,itemNumber:number,timestamp});
    await submitClientEvidence(id,{kind:'feedback',requestType:text(data.get('requestType')),projectKey,itemNumber:number,message,submittedAt:timestamp,userAgent:navigator.userAgent,...(attachments.length?{attachments:attachments.map(attachmentMeta)}:{})},attachments);
    notify('Your request and attachments have been saved');finishModal();
  },'Send request');
}
async function downloadFeedbackAttachment(source){
  const {id,collection:kind,attachment}=source.dataset,record=requests().find(r=>r.id===id&&r.collection===kind),meta=record?.attachments?.find(f=>f.id===attachment);
  if(!meta)throw new Error('This attachment is no longer available. Refresh the workspace.');
  const token=admin()?client().accessToken:state.token,snap=await getDocFromServer(doc(db,'portal_public',token,'attachments',meta.id));
  const bytes=await attachmentDownloadBytes(snap.exists()?snap.data():null,meta,{id,collection:kind,projectKey:record.projectKey,itemNumber:record.itemNumber});
  // Never execute or embed client documents in the authenticated portal origin.
  download(meta.name,bytes,'application/octet-stream');
}
function openFeedbackReview(id,collectionName){
  requireAdmin();const draft=clone(client()),entry=requests().find(r=>r.id===id&&r.collection===collectionName);if(!entry)throw new Error('Request no longer exists.');
  const r=reviewOf(entry);
  modal('Manage client request',`Received ${dateText(entry.submittedAt||entry.confirmedAt)}`,`${area('Client request text','message',r.displayMessage??entry.message??entry.rejectReason??'Client response','required maxlength="4000"')}${select('Status','status',[['new','New'],['in-progress','In progress'],['resolved','Resolved'],['closed','Closed']],r.status||'new')}${select('Optional reply starter','replyStarter',[['','Write a custom reply'],['Please clarify the requested changes so we can proceed.','Clarification needed'],['The requested changes are outside the agreed scope. Please contact us to confirm the revised scope and cost.','Scope change'],['We have addressed your feedback. Please review the updated project and tell us if anything remains.','Changes ready for review']], '')}${area('Reply visible to client','response',r.response||'','maxlength="4000"')}${button('Move request to bin','archive-feedback',`data-id="${esc(id)}" data-collection="${collectionName}"`,'danger')}`,async data=>{
    const c=clone(draft),response=[text(data.get('replyStarter')),text(data.get('response'))].filter(Boolean).join('\n\n'),status=text(data.get('status'));
    if(['resolved','closed'].includes(status)&&response.length<10)throw Error('Explain the resolution or closure in at least 10 characters.');
    if(response.length>4000)throw Error('Keep the combined reply within 4,000 characters.');
    c.feedbackReviews[id]={status,displayMessage:text(data.get('message')),response,updatedAt:now()};
    await saveClient(c,'Client reply saved and email queued',[],{manualNotice:{projectKey:entry.projectKey,kind:'feedback-reply',title:'Response to your feedback',message:response||'Your request is being reviewed. Please check its current status.',responseTarget:{kind:entry.requestId?'review':'evidence',id:entry.requestId||entry.id}}});finishModal();
  });
}
function termsHtml(t){return `<div class="agreement"><p class="eyebrow">Project agreement · ${esc(t.agreementVersion||'Legacy record')}</p><h3>${esc(t.projectName)}</h3><p>${t.totalItems} deliverables · ${money(t.rate)} each · Agreed budget ${money(t.budget)}</p><div class="scope-grid"><p><strong>Scope / description</strong><br><span class="prewrap">${esc(t.scope||'To be confirmed in writing')}</span></p><p><strong>Payment & delivery terms</strong><br><span class="prewrap">${esc(t.terms||'No additional project-specific terms recorded.')}</span></p><p><strong>Schedule</strong><br>Target date: ${esc(t.deadline||'Not set')}<br>Weekly target: ${t.weeklyTarget||'Not set'}</p><p><strong>Next milestone</strong><br><span class="prewrap">${esc(t.milestoneText||'Not set')}</span></p></div><p class="small muted">The complete numbered Terms & Agreement PDF is available from the project overview.</p></div>`;}
function openSignature(){
  const terms=agreementTerms(project()),signatureId=project()?.signatureId;
  if(!signatureId)throw new Error('This project signature route is unavailable. Refresh the workspace and retry.');
  modal('Review and sign','Your signature records these project terms and the signing time.',`${termsHtml(terms)}<h3>72-hour review policy</h3><p>${esc(REVIEW_POLICY_TEXT)}</p>${field('Full name','name','','text','required maxlength="200"')}<canvas id="signatureCanvas" class="signature-pad" aria-label="Draw your signature with mouse or touch"></canvas>${button('Clear signature','clear-signature')}<label><input type="checkbox" name="agree" required> I have reviewed these details and the 72-hour review policy and agree to this project record.</label>`,async data=>{
    if(!pad?.drawn)throw new Error('Please draw your signature before submitting.');
    await writeClientRecord({root:`portal_public/${state.token}`,collection:'sigs',id:signatureId,
      data:{id:signatureId,projectKey:state.projectKey,name:text(data.get('name')),image:pad.canvas.toDataURL('image/png'),signedAt:serverTimestamp(),userAgent:navigator.userAgent,termsSnapshot:terms,reviewPolicy:clone(REVIEW_POLICY)},timestamp:serverTimestamp(),
      transaction:fn=>runTransaction(db,tx=>fn({get:async path=>{const snap=await tx.get(doc(db,path));return snap.exists()?snap.data():null;},set:(path,value)=>tx.set(doc(db,path),value)}))});
    notify('Signature saved; notification queued.');finishModal();
  },'Save signature');initPad();
}
function initPad(){const canvas=$('signatureCanvas');const rect=canvas.getBoundingClientRect(),ratio=Math.min(window.devicePixelRatio||1,2);canvas.width=rect.width*ratio;canvas.height=180*ratio;const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.strokeStyle='#167aa6';ctx.lineWidth=2.4;ctx.lineCap='round';pad={canvas,ctx,drawn:false};let drawing=false;const pt=e=>{const b=canvas.getBoundingClientRect();return{x:e.clientX-b.left,y:e.clientY-b.top};};canvas.onpointerdown=e=>{drawing=true;canvas.setPointerCapture(e.pointerId);const p=pt(e);ctx.beginPath();ctx.moveTo(p.x,p.y);};canvas.onpointermove=e=>{if(!drawing)return;const p=pt(e);ctx.lineTo(p.x,p.y);ctx.stroke();pad.drawn=true;};canvas.onpointerup=canvas.onpointercancel=()=>drawing=false;}
function openSignatureReview(id){requireAdmin();const draft=clone(client()),s=projectSigs().find(s=>s.id===id);if(!s)return;const r=sigReview(s);modal('Manage signature',`Signed ${dateText(s.signedAt)}`,`${field('Signer display name','displayName',r.displayName||s.name,'text','required maxlength="200"')}${select('Review state','state',[['pending','Awaiting verification'],['verified','Verified'],['void','Void / request replacement']],r.state||'pending')}${area('Note visible to client','message',r.message||'','maxlength="2000"')}${button('Move signature to bin','archive-signature',`data-id="${esc(id)}"`,'danger')}`,async data=>{const c=clone(draft);c.signatureReviews[id]={state:text(data.get('state')),displayName:text(data.get('displayName')),message:text(data.get('message')),updatedAt:now()};await saveClient(c,'Signature updated');finishModal();});}

// Archived client submissions live in their own admin-only documents. Keeping
// a captured PNG or a long feedback history out of portal_clients prevents a
// recycle-bin action from exceeding Firestore's per-document size limit.
const ARCHIVE_RECORD_BATCH_SIZE=8;
const archiveRecordCollection=(clientKey,archiveKey)=>collection(db,'portal_archives',clientKey,'entries',archiveKey,'records');
const archiveEntryCollection=clientKey=>collection(db,'portal_archives',clientKey,'entries');
async function stageTrashRecords(clientKey,trashId,entry){
  const records=entry.records||[];if(!records.length)return;
  const archiveKey=entry.archiveKey||trashId;
  entry.archiveKey=archiveKey;
  const index=writeBatch(db);index.set(doc(db,'portal_archives',clientKey,'entries',archiveKey),{archiveKey,recordCount:0,updatedAt:now()});await index.commit();
  for(let offset=0;offset<records.length;offset+=ARCHIVE_RECORD_BATCH_SIZE){
    const batch=writeBatch(db);
    for(const [index,record] of records.slice(offset,offset+ARCHIVE_RECORD_BATCH_SIZE).entries()){
      const {id,collection:recordCollection,...payload}=record,archiveId=`record-${offset+index}`;
      batch.set(doc(db,'portal_archives',clientKey,'entries',archiveKey,'records',archiveId),{recordCollection,recordId:id,payload});
    }
    await batch.commit();
  }
  const complete=writeBatch(db);complete.set(doc(db,'portal_archives',clientKey,'entries',archiveKey),{archiveKey,recordCount:records.length,updatedAt:now()});await complete.commit();entry.archivedRecordCount=records.length;entry.records=[];
}
async function archivedTrashRecords(clientKey,entry){
  if(!entry.archiveKey)return clone(entry.records||[]);
  const snap=await getDocs(archiveRecordCollection(clientKey,entry.archiveKey));
  return snap.docs.map(document=>{const stored=document.data();return {...clone(stored.payload||{}),id:stored.recordId,collection:stored.recordCollection};});
}
async function restorePublicRecords(accessToken,records,cancelledAt=now()){
  // Manifests are regenerated from current private project rows by saveClient.
  const submissions=records.filter(record=>record.collection!=='deliveries').map(record=>retainedReviewRecord(record,'archive-restored',cancelledAt));
  for(let offset=0;offset<submissions.length;offset+=ARCHIVE_RECORD_BATCH_SIZE){
    const group=submissions.slice(offset,offset+ARCHIVE_RECORD_BATCH_SIZE);
    await runTransaction(db,async tx=>{
      const targets=group.map(({id,collection:recordCollection,...payload})=>({ref:doc(db,'portal_public',accessToken,recordCollection,id),payload:recordCollection==='attachments'?{...payload,id}:payload}));
      const existing=await Promise.all(targets.map(target=>tx.get(target.ref)));
      for(let i=0;i<targets.length;i++)if(existing[i].exists()&&!sameRecord(existing[i].data(),targets[i].payload))throw new Error('A newer submission already uses this record ID. Its evidence was preserved; review the active record before restoring this archive.');
      targets.forEach((target,i)=>{if(!existing[i].exists())tx.set(target.ref,target.payload);});
    });
  }
}
async function deleteArchivedTrashRecords(clientKey,entry){
  if(!entry.archiveKey)return;
  const snap=await getDocs(archiveRecordCollection(clientKey,entry.archiveKey));
  for(let offset=0;offset<snap.docs.length;offset+=400){const batch=writeBatch(db);for(const record of snap.docs.slice(offset,offset+400))batch.delete(record.ref);await batch.commit();}
  const batch=writeBatch(db);batch.delete(doc(db,'portal_archives',clientKey,'entries',entry.archiveKey));await batch.commit();
}
async function deleteAllClientArchives(clientKey,entries=[]){
  const known=new Set(entries.map(entry=>entry?.archiveKey).filter(Boolean));
  for(const entry of entries)await deleteArchivedTrashRecords(clientKey,entry);
  const snap=await getDocs(archiveEntryCollection(clientKey));
  for(const document of snap.docs)if(!known.has(document.id))await deleteArchivedTrashRecords(clientKey,{archiveKey:document.id});
}
async function deletePublicRecords(accessToken,records){
  for(let offset=0;offset<records.length;offset+=400){const batch=writeBatch(db);for(const record of records.slice(offset,offset+400))batch.delete(doc(db,'portal_public',accessToken,record.collection,record.id));await batch.commit();}
}
function matchesArchivedEntry(entry,record){
  if(entry.kind==='project'){const approvals=new Set((entry.value?.approvals||[]).map(approval=>approval.id));return belongsToReviewProject(record,entry.projectKey)||(record.collection==='sigs'&&record.id===entry.projectKey)||(record.collection==='confirms'&&approvals.has(record.id));}
  if(entry.kind==='approval')return record.collection==='confirms'&&record.id===entry.value?.id;
  if(['record','signature','feedback'].includes(entry.kind))return record.collection===entry.value?.collection&&record.id===entry.value?.id;
  return false;
}
async function retainLateArchivedRecords(c,entry){
  const late=(await allRecords(c.accessToken)).filter(record=>matchesArchivedEntry(entry,record));if(!late.length)return 0;
  const retained=await archivedTrashRecords(c.slug,entry),positions=new Map(retained.map((record,index)=>[`${record.collection}/${record.id}`,index]));
  for(const record of late){const key=`${record.collection}/${record.id}`,index=positions.get(key);if(index===undefined){positions.set(key,retained.length);retained.push(clone(record));}else retained[index]=clone(record);}
  entry.records=retained;await stageTrashRecords(c.slug,entry.archiveKey||entry.id||uid('trash'),entry);await deletePublicRecords(c.accessToken,late);return late.length;
}
async function resumeLargeArchive(c=clone(client())){
  requireAdmin();const job=c.archiveState;if(!['large-archive','reconcile'].includes(job?.kind))return false;const entry=c.trash?.[job.trashId];if(!entry)throw new Error('The protected archive entry is missing. Refresh and review the recycle bin before retrying.');
  if(job.kind==='large-archive')await deletePublicRecords(c.accessToken,await archivedTrashRecords(c.slug,entry));const late=await retainLateArchivedRecords(c,entry);if(late)await saveClient(c,'Late client submissions retained in the protected archive',[],{allowRecovery:true});
  const latest=clone(state.clients[c.slug]||c);if(latest.archiveState?.trashId!==job.trashId)return false;if(job.previousAccessEnabled===undefined)delete latest.accessEnabled;else latest.accessEnabled=job.previousAccessEnabled;delete latest.archiveState;await saveClient(latest,'Protected archive completed and private sharing restored',[],{allowRecovery:true});return true;
}
const archivePreview = record => {const {image,content,...preview}=record||{};return preview;};
function trashEntry(c,kind,label,value,projectKey=state.projectKey,extra={}){const id=uid('trash');c.trash[id]={kind,label,value:clone(value),projectKey:projectKey||'',deletedAt:now(),...extra};return id;}
async function archive(kind,source){
  requireAdmin();const c=clone(client()),p=c.projects[state.projectKey],ops=[];let trashId='',lateRecordMatch=null;
  if(kind==='record'){
    const record=(await allRecords(c.accessToken)).find(r=>r.id===source.dataset.id&&r.collection===source.dataset.collection);
    if(!record)throw new Error('Record no longer exists.');
    if(['deliveries','reviews','review_guards','notices','attachments'].includes(record.collection))throw new Error('Workflow records and attachments are managed by the project. Edit or archive the parent project or feedback instead.');
    const reviews={signatureReviews:{},feedbackReviews:{}};
    for(const map of Object.keys(reviews)){if(c[map][record.id]){reviews[map][record.id]=c[map][record.id];delete c[map][record.id];}}
    const linked=(await allRecords(c.accessToken)).filter(r=>r.collection==='attachments'&&r.feedbackCollection===record.collection&&r.feedbackId===record.id);
    trashId=trashEntry(c,'record',record.collection+' · '+(record.name||record.id),archivePreview(record),record.projectKey||'',{records:[record,...linked],reviews});
    for(const retained of [record,...linked])ops.push({path:[retained.collection,retained.id],delete:true});
  }
  if(kind==='client'){c._deleted=true;await saveClient(c,'Client moved to recycle bin');state.clientKey=null;state.projectKey=null;return;}
  if(kind==='project'){const approvalIds=new Set(p.approvals.map(a=>a.id)),match=r=>belongsToReviewProject(r,state.projectKey)||(r.collection==='sigs'&&r.id===state.projectKey)||(r.collection==='confirms'&&approvalIds.has(r.id)),records=(await allRecords(c.accessToken)).filter(match),reviews={signatureReviews:{},feedbackReviews:{}};for(const r of records){const map=r.collection==='sigs'?'signatureReviews':'feedbackReviews';if(c[map][r.id]){reviews[map][r.id]=c[map][r.id];delete c[map][r.id];}}trashId=trashEntry(c,kind,p.name,p,state.projectKey,{records,reviews});lateRecordMatch=match;for(const r of records)ops.push({path:[r.collection,r.id],delete:true});delete c.projects[state.projectKey];}
  if(kind==='payment'||kind==='approval'){const list=kind==='payment'?p.payments:p.approvals;const index=list.findIndex(x=>x.id===source.dataset.id);if(index<0)throw new Error('Record not found.');const value=list[index];let conf=null;if(kind==='approval'){const snap=await getDoc(doc(db,'portal_public',c.accessToken,'confirms',value.id));conf=snap.exists()?{...snap.data(),id:snap.id,collection:'confirms'}:null;lateRecordMatch=record=>record.collection==='confirms'&&record.id===value.id;}trashId=trashEntry(c,kind,kind==='payment'?`${money(value.amount)} payment`:value.title,value,state.projectKey,conf?{records:[conf]}:{});if(conf)ops.push({path:['confirms',conf.id],delete:true});list.splice(index,1);}
  if(kind==='item'){const item=p.items.find(i=>Number(i.n)===Number(source.dataset.number));item.deleted=true;item.deletedAt=now();p.totalItems=itemsOf(p).length;}
  if(kind==='signature'||kind==='feedback'){
    const stored=await allRecords(c.accessToken),record=stored.find(r=>r.id===source.dataset.id&&r.collection===(kind==='signature'?'sigs':source.dataset.collection));
    if(!record)throw new Error('Record not found.');
    const reviews=kind==='signature'?c.signatureReviews:c.feedbackReviews,records=[record,...stored.filter(r=>r.collection==='attachments'&&r.feedbackCollection===record.collection&&r.feedbackId===record.id)];
    trashId=trashEntry(c,kind,kind==='signature'?record.name:record.message||record.rejectReason,archivePreview(record),record.projectKey||state.projectKey,{review:reviews[record.id]||{},records});
    for(const retained of records)ops.push({path:[retained.collection,retained.id],delete:true});delete reviews[record.id];
  }
  const entry=trashId?c.trash[trashId]:null;if(entry?.records?.length)try{await stageTrashRecords(c.slug,trashId,entry);}catch(error){if(entry.archiveKey)await deleteArchivedTrashRecords(c.slug,entry).catch(()=>{});throw error;}
  const needsProtectedSweep=Boolean(lateRecordMatch),largeArchive=ops.length+Object.keys(c.projects).length+1>MAX_SAVE_OPERATIONS;
  if(largeArchive||needsProtectedSweep){
    c.archiveState={kind:largeArchive?'large-archive':'reconcile',trashId,previousAccessEnabled:c.accessEnabled,startedAt:now()};c.accessEnabled=false;
    let saved;try{saved=await saveClient(c,largeArchive?'Private sharing paused while a large protected archive is completed.':'Private sharing paused while the archive is being verified.',largeArchive?[]:ops);}catch(error){if(entry?.archiveKey)await deleteArchivedTrashRecords(c.slug,entry).catch(()=>{});throw error;}
    if(kind==='project')state.projectKey=null;
    try{await resumeLargeArchive(saved);}catch(error){notify('Private sharing stays paused and the protected archive can be resumed from Link settings.',true);throw error;}
  }else{try{await saveClient(c,'Moved to recycle bin',ops);}catch(error){if(entry?.archiveKey)await deleteArchivedTrashRecords(c.slug,entry).catch(()=>{});throw error;}}
  if(kind==='project')state.projectKey=null;if(!$('modalLayer').hidden)finishModal();
}
function renderTrash(){
  const entries=[];for(const [key,c] of Object.entries(state.clients)){if(c._deleted){const purging=c.purgeState?.status==='purging';entries.push(`<div class="list-row"><strong>${esc(c.name)} · Client workspace</strong><p>${purging?'Permanent deletion is in progress. The client cannot be restored while protected records are being removed.':'Private link disabled while in recycle bin.'}</p><div class="actions">${button('View details','preview-client-trash',`data-client="${esc(key)}"`)}${purging?button('Resume permanent deletion','purge-client',`data-client="${esc(key)}"`,'danger'):button('Restore client','restore-client',`data-client="${esc(key)}"`)+button('Permanently delete','purge-client',`data-client="${esc(key)}"`,'danger')}</div></div>`);}else for(const [id,t] of Object.entries(c.trash||{})){const count=t.archivedRecordCount??t.records?.length??0,protectedArchive=activeArchiveEntry(c,id),purging=t.purgeState?.status==='purging',restoring=t.restoreState?.status==='restoring',status=protectedArchive?'Protected archive is paused; resume it from Link settings or here.':purging?'Permanent deletion is in progress.':restoring?'Restore is in progress; finish it before choosing another recovery action.':'Ready for review.';const actions=protectedArchive?button('Resume protected archive','resume-archive',`data-client="${esc(key)}"`,'danger'):purging?button('Resume permanent deletion','purge-trash',`data-client="${esc(key)}" data-id="${esc(id)}"`,'danger'):restoring?button('Resume restore','restore-trash',`data-client="${esc(key)}" data-id="${esc(id)}"`):button('Restore','restore-trash',`data-client="${esc(key)}" data-id="${esc(id)}"`)+button('Permanently delete','purge-trash',`data-client="${esc(key)}" data-id="${esc(id)}"`,'danger');entries.push(`<div class="list-row"><strong>${esc(c.name)} · ${esc(t.kind)} · ${esc(t.label).slice(0,180)}</strong><p>${esc(dateText(t.deletedAt))} · ${count} linked submission${count===1?'':'s'} retained for restore · ${status}</p><div class="actions">${button('View details','preview-trash',`data-client="${esc(key)}" data-id="${esc(id)}"`)}${actions}</div></div>`);}}
  $('view').innerHTML=`<section class="hero"><p class="eyebrow">Administrator recovery</p><h1>Recycle bin</h1><p>Restore removed records here. Permanently deleted records cannot be restored.</p>${button('Back to dashboard','dashboard')}</section><section class="panel" style="margin-top:18px">${entries.join('')||'<p class="muted">The recycle bin is empty.</p>'}</section>`;
}
function trashDetails(entry){const value=entry.value||{},display=value=>{if(value===undefined||value===null||value==='')return '—';if(value&&typeof value.toDate==='function')return dateText(value);if(typeof value==='object'){try{return JSON.stringify(value,null,2);}catch{return String(value);}}return String(value);},line=(label,value)=>`<p><strong>${esc(label)}:</strong> <span class="prewrap">${esc(display(value))}</span></p>`,source=(label,value)=>safeUrl(value)?`<p><strong>${esc(label)}:</strong> ${link(value,'Open link')}</p>`:'',allFields=(record,skip=[])=>Object.entries(record||{}).filter(([key])=>!skip.includes(key)&&key!=='image').map(([key,fieldValue])=>line(key.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()),fieldValue)).join('');let body=`<div class="agreement"><p class="eyebrow">Recoverable record</p>${line('Type',entry.kind)}${line('Original label',entry.label)}${line('Deleted',dateText(entry.deletedAt))}${entry.projectKey?line('Parent project',entry.projectKey):''}`;
  if(entry.kind==='project'){body+=line('Project name',value.name)+line('Deliverables',itemsOf(value).length)+line('Scope / description',value.scope)+line('Payment & delivery terms',value.terms)+line('Next milestone',value.milestoneText);}
  else if(entry.kind==='item'){body+=line('Deliverable number',value.n)+line('Item / subject',value.b)+line('Title',value.t)+line('Status',LABEL[value.s]||value.s)+line('Started date',value.sd)+line('Delivered date',value.dd)+line('Duration',value.dur)+source('Final delivery',value.dl)+source('Script',value.scriptUrl)+source('Character / avatar',value.avatarUrl)+source('Reference',value.referenceUrl)+line('Client-visible note',value.clientNote)+line('Internal admin note',value.no);}
  else if(entry.kind==='payment'){body+=line('Date',value.date)+line('Amount',money(value.amount))+line('Type',value.type)+line('Note',value.note)+source('Payment proof',value.proofUrl);}
  else if(entry.kind==='approval'){body+=line('Approval title',value.title)+line('Request details',value.desc);}
  else if(entry.kind==='signature'){body+=line('Signer',value.name)+line('Signed',dateText(value.signedAt))+line('Project',value.projectKey)+(signatureImage(value.image)?`<p><strong>Captured signature:</strong><br><img class="signature-image" src="${signatureImage(value.image)}" alt="Archived client signature"></p>`:'');}
  else if(entry.kind==='feedback'){body+=line('Request type',value.requestType)+line('Message',value.message)+line('Submitted',dateText(value.submittedAt));}
  else if(entry.kind==='record'){body+=line('Collection',value.collection)+line('Record ID',value.id)+allFields(value,['collection','id']);if(signatureImage(value.image))body+=`<p><strong>Captured signature:</strong><br><img class="signature-image" src="${signatureImage(value.image)}" alt="Archived client signature"></p>`;}
  const records=[...(entry.records||[])];if(records.length)body+=`<h3>Linked submissions retained for restore</h3>${records.map(record=>`<details class="record"><summary><strong>${esc(record.collection||'record')} · ${esc(record.id||'')}</strong> — ${esc(record.name||record.title||record.message||record.projectKey||'Submission record')}</summary>${allFields(record,['collection','id','content'])}${signatureImage(record.image)?`<p><strong>Captured signature:</strong><br><img class="signature-image" src="${signatureImage(record.image)}" alt="Archived client signature"></p>`:''}</details>`).join('')}`;
  if(entry.review)body+=`<h3>Administrator review retained</h3>${allFields(entry.review)}`;
  return body+'</div>';}
async function openTrashPreview(key,id){
  requireAdmin();const entry=state.clients[key]?.trash?.[id];if(!entry)throw new Error('This recycled record is no longer available.');
  const preview=clone(entry);preview.records=await archivedTrashRecords(key,entry);
  const files=preview.records.filter(r=>r.collection==='attachments').map(file=>button(`Download archived ${file.name}`,'download-archived-attachment',`data-client="${esc(key)}" data-trash="${esc(id)}" data-id="${esc(file.id)}"`)).join('');
  modal('Recycle-bin details','Review the original fields before you restore or permanently delete this record.',trashDetails(preview)+files,null);
}
async function downloadArchivedAttachment(source){
  requireAdmin();const key=source.dataset.client,entry=state.clients[key]?.trash?.[source.dataset.trash];
  if(!entry)throw new Error('This recycled record is no longer available.');
  const file=(await archivedTrashRecords(key,entry)).find(r=>r.collection==='attachments'&&r.id===source.dataset.id);
  if(!file)throw new Error('This attachment is no longer available.');
  const bytes=await attachmentDownloadBytes(file,attachmentMeta(file),{id:file.feedbackId,collection:file.feedbackCollection,projectKey:file.projectKey,itemNumber:file.itemNumber});
  download(file.name,bytes,'application/octet-stream');
}
async function openClientTrashPreview(key){requireAdmin();const c=state.clients[key];if(!c?._deleted)throw new Error('This client is no longer in the recycle bin.');const line=(label,value)=>`<p><strong>${esc(label)}:</strong> <span class="prewrap">${esc(value===undefined||value===null||value===''?'—':value)}</span></p>`,projectDetails=Object.entries(c.projects||{}).map(([slug,p])=>`<details class="record"><summary><strong>${esc(p.name||slug)}</strong> — ${itemsOf(p).length} deliverables · ${money(p.budget)}</summary>${line('URL label',slug)}${line('Status',LABEL[p.status]||p.status)}${line('Rate',money(p.rate))}${line('Budget',money(p.budget))}${line('Scope / description',p.scope)}${line('Payment & delivery terms',p.terms)}${line('Next milestone',p.milestoneText)}${line('Source script URL',p.sourceScriptUrl)}${line('Avatar / character URL',p.avatarFolderUrl)}<p><strong>Production rows:</strong> ${itemsOf(p).map(row=>`#${esc(row.n)} ${esc(row.t||row.b||'Untitled')}`).join(', ')||'—'}</p></details>`).join('')||'<p>No projects recorded.</p>';
  const tokens=[...new Set([c.accessToken,c.accessRotation?.from].filter(Boolean))],records=(await Promise.all(tokens.map(allRecords))).flat(),seen=new Set(),unique=records.filter(record=>{const key=`${record.collection}/${record.id}`;if(seen.has(key))return false;seen.add(key);return true;}),recordDetails=unique.length?`<h3>Protected submitted records</h3>${unique.map(record=>{const fields=Object.entries(record).filter(([field])=>!['collection','id','image','content'].includes(field)).map(([field,value])=>line(field.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()),typeof value==='object'?JSON.stringify(value):value)).join('');return `<details class="record"><summary><strong>${esc(record.collection)} · ${esc(record.id)}</strong> — ${esc(record.name||record.title||record.message||record.projectKey||'Submitted record')}</summary>${fields}${signatureImage(record.image)?`<p><strong>Captured signature:</strong><br><img class="signature-image" src="${signatureImage(record.image)}" alt="Archived client signature"></p>`:''}</details>`;}).join('')}`:'<p>No public submission records remain on the protected link.</p>';
  modal('Recycled client details','Review the complete client record and every retained submission before restoring or permanently deleting it. Its private link is disabled.',`<div class="agreement"><p class="eyebrow">Client workspace</p><h3>${esc(c.name)}</h3>${line('URL label',key)}${line('Email',c.email)}${line('Phone',c.phone)}${line('Share state',c.accessEnabled===false?'Paused':'Active before recycling')}${line('Projects',Object.keys(c.projects||{}).length)}${c.purgeState?line('Permanent deletion state',c.purgeState.status):''}${projectDetails}${recordDetails}</div>`,null);
}
function assertTrashRestorePossible(c,t){if(t.kind==='project'&&c.projects[t.projectKey])throw new Error('A project already uses this label. Rename/remove it before restoring.');if(!['project','record'].includes(t.kind)&&!c.projects[t.projectKey])throw new Error('Restore the parent project first.');}
function restoreTrashStructure(c,id,t,records){
  if(t.kind==='project'){if(c.projects[t.projectKey])throw new Error('A project already uses this label. Rename/remove it before restoring.');c.projects[t.projectKey]=t.value;}
  else if(t.kind!=='record'){const p=c.projects[t.projectKey];if(!p)throw new Error('Restore the parent project first.');if(t.kind==='payment'||t.kind==='approval')p[t.kind==='payment'?'payments':'approvals'].push(t.value);if(t.kind==='signature'||t.kind==='feedback'){const record=records[0]||t.value;if(record?.id)c[t.kind==='signature'?'signatureReviews':'feedbackReviews'][record.id]=t.review||{};}}
  for(const map of ['signatureReviews','feedbackReviews'])Object.assign(c[map],t.reviews?.[map]||{});
  delete c.trash[id];
}
async function restoreTrash(key,id){
  const c=clone(state.clients[key]),t=c.trash[id];if(!t)throw new Error('This record is no longer in the bin.');assertTrashRestorePossible(c,t);
  if(c.archiveState?.trashId===id)throw new Error('This protected archive is still in progress. Resume it before restoring this record.');
  if(t.purgeState?.status==='purging')throw new Error('Permanent deletion is in progress. Resume or finish it before restoring this record.');
  const records=await archivedTrashRecords(key,t);if(!records.length&&['record','signature','feedback'].includes(t.kind)&&t.value?.id&&t.value?.collection)records.push(clone(t.value));
  if(!t.restoreState){t.restoreState={status:'restoring',startedAt:now()};await saveClient(c,'Restoring protected records…');}
  try{await restorePublicRecords(c.accessToken,records,t.restoreState.startedAt);}catch(error){notify('Restore is paused safely. Use Restore again to resume it.',true);throw error;}
  const latest=clone(state.clients[key]),current=latest.trash?.[id];if(!current)throw new Error('This recycled record changed in another tab. Refresh and review it before retrying.');if(current.purgeState?.status==='purging')throw new Error('Permanent deletion claimed this record in another tab.');restoreTrashStructure(latest,id,current,records);await saveClient(latest,'Record restored',[],{allowRecovery:true});
  await deleteArchivedTrashRecords(key,current).catch(()=>notify('Record restored. A private archive cleanup retry may be needed later.',true));
}
async function purgeTrash(key,id){
  requireAdmin();const initial=clone(state.clients[key]),entry=initial?.trash?.[id];if(!entry)throw new Error('Recycled record not found.');
  if(initial.archiveState?.trashId===id)throw new Error('This protected archive is still in progress. Resume it before permanent deletion.');
  if(!entry.purgeState){if(!await confirmAction('Permanently delete this recycled record? It cannot be restored.'))return;const claimed=clone(state.clients[key]),current=claimed.trash?.[id];if(!current)throw new Error('Recycled record changed in another tab. Refresh and retry.');if(current.restoreState?.status==='restoring')throw new Error('Restore is in progress. Resume it before permanent deletion.');current.purgeState={status:'purging',startedAt:now()};await saveClient(claimed,'Permanent deletion started for this recycled record.',[],{allowRecovery:true});}
  const c=clone(state.clients[key]),current=c.trash?.[id];if(!current)throw new Error('Recycled record changed in another tab. Refresh and retry.');if(c.archiveState?.trashId===id)throw new Error('This protected archive is still in progress. Resume it before permanent deletion.');
  // The archive owns its private copies, not any newer live submission reusing
  // the same deterministic consent/acknowledgement ID.
  await deleteArchivedTrashRecords(key,current);
  const latest=clone(state.clients[key]),finalEntry=latest.trash?.[id];if(!finalEntry)throw new Error('Recycled record changed in another tab. Refresh and review the recycle bin.');delete latest.trash[id];await saveClient(latest,'Recycled record permanently deleted',[],{allowRecovery:true});render();
}
function openArchivedRows(){requireAdmin();const p=project(),rows=p.items.filter(i=>i.deleted);modal('Archived production rows','Review exact row fields before restoring or permanently deleting them.',rows.map(i=>`<div class="list-row"><strong>Deliverable ${i.n} · ${esc(i.t||i.b||'Untitled')}</strong><div class="actions">${button('View details','preview-archived-row',`data-number="${i.n}"`)}${button('Restore row','restore-row',`data-number="${i.n}"`)}${button('Permanently delete','purge-row',`data-number="${i.n}"`,'danger')}</div></div>`).join('')||'<p>No archived rows.</p>',null);}
function openArchivedRowPreview(number){requireAdmin();const item=project()?.items.find(row=>Number(row.n)===Number(number));if(!item?.deleted)throw new Error('Archived production row not found.');modal('Archived production-row details','Review every stored field before restoring or permanently deleting this row.',trashDetails({kind:'item',label:`Deliverable ${item.n}`,value:item,projectKey:state.projectKey,deletedAt:item.deletedAt}),null);}
function linkSettings(){requireAdmin();const c=client(),pending=c.accessRotation?.from,archiving=Boolean(c.archiveState);modal('Private link settings','Anyone with this private link can view this client workspace. Pause sharing or replace a leaked link.',`<p>Sharing is ${c.accessEnabled===false?'paused':'active'}.</p>${archiving?'<p class="notice">A protected archive is in progress. Sharing remains paused until every submitted record is safely moved.</p>':pending?'<p class="notice">A previous replacement safely disabled the old link. Resume the protected record transfer to finish it.</p>':''}${archiving?button('Resume protected archive','resume-archive','','danger'):button(c.accessEnabled===false?'Enable sharing':'Pause sharing','toggle-sharing')+button(pending?'Resume protected record transfer':'Replace private link','rotate-link','','danger')}`,null);}
async function allRecords(accessToken,{includeDeliveries=true,includeInternal=true,includeAttachments=true}={}){
  const names=['sigs','confirms','feedback','consent','agreements','acknowledgements','reviews','notices','receipts',...(includeInternal?['review_guards']:[]),...(includeDeliveries?['deliveries']:[]),...(includeAttachments?['attachments']:[])];
  const groups=await Promise.all(names.map(async name=>(await getDocs(collection(db,'portal_public',accessToken,name))).docs.map(d=>({...d.data(),id:d.id,collection:name}))));
  return groups.flat();
}
// A Firestore batch has both a write-count and a payload-size ceiling. Eight
// records is deliberately conservative because one captured PNG signature can
// be large; it keeps a link rotation resumable instead of failing mid-transfer.
const ROTATION_BATCH_SIZE=8;
async function migrateRotatedRecords(c,from,to){
  const records=await allRecords(from);
  for(let offset=0;offset<records.length;offset+=ROTATION_BATCH_SIZE){
    const batch=writeBatch(db);
    for(const record of records.slice(offset,offset+ROTATION_BATCH_SIZE)){
      const {id,collection:col,...data}=retainedReviewRecord(record,'private-link-replaced',c.accessRotation?.startedAt||now());
      if(col!=='deliveries')batch.set(doc(db,'portal_public',to,col,id),col==='attachments'?{...data,id}:data);
      batch.delete(doc(db,'portal_public',from,col,id));
    }
    await batch.commit();
  }
  // The old parent remains disabled until every child record is copied. A
  // client therefore cannot add another submission after the scan above, and
  // a failed transfer can simply be resumed without losing its source data.
  const finish=writeBatch(db);finish.delete(doc(db,'portal_public',from));await finish.commit();
  const latest=clone(state.clients[c.slug]||c);
  if(latest.accessToken===to&&latest.accessRotation?.from===from){
    delete latest.accessRotation;
    await saveClient(latest,`Private link replaced. ${records.length} saved record${records.length===1?'':'s'} transferred.`,[],{allowRecovery:true});
  }
  return records.length;
}
async function rotateLink(){
  requireAdmin();const c=clone(client());if(c.archiveState)throw new Error('Resume the protected archive before replacing this private link.');if(c.purgeState)throw new Error('Permanent deletion is in progress. Resume or finish it before replacing this private link.');
  if(c.accessRotation?.from){await migrateRotatedRecords(c,c.accessRotation.from,c.accessToken);finishModal();return;}
  const old=c.accessToken,nextToken=newToken();c.accessToken=nextToken;c.accessRotation={from:old,startedAt:now()};
  // First atomically publish the new link and withdraw the old one. This is
  // intentionally a tiny transaction; records are copied afterwards in safe,
  // resumable batches so large workspaces do not exceed Firestore limits.
  const retired=clone(c);retired.accessToken=old;retired.accessEnabled=false;
  await saveClient(c,'Old private link disabled. Moving saved records…',[{token:old,path:[],data:publicSnapshot(retired,retired.slug)}]);
  try{await migrateRotatedRecords(c,old,nextToken);finishModal();}
  catch(error){notify('Old link is disabled. The protected record transfer can be resumed from Link settings.',true);throw error;}
}
async function claimClientPurge(key){
  const c=clone(state.clients[key]);if(!c?._deleted)throw new Error('Move the client to the recycle bin first.');
  if(!c.purgeState){c.purgeState={status:'purging',startedAt:now(),tokens:[...new Set([c.accessToken,c.accessRotation?.from].filter(Boolean))]};await saveClient(c,'Permanent deletion started. Removing protected records…',[],{allowRecovery:true});}
  return clone(state.clients[key]||c);
}
async function purgeClient(key){
  const c=await claimClientPurge(key),tokens=[...new Set((c.purgeState?.tokens||[c.accessToken,c.accessRotation?.from]).filter(Boolean))];
  // Each committed delete batch is safe to retry. The persisted purge claim
  // prevents a restore or ordinary edit from racing a partial permanent delete.
  for(const token of tokens){const records=await allRecords(token);for(let offset=0;offset<records.length;offset+=400){const batch=writeBatch(db);for(const r of records.slice(offset,offset+400))batch.delete(doc(db,'portal_public',token,r.collection,r.id));await batch.commit();}}
  await deleteAllClientArchives(key,Object.values(c.trash||{}));
  const batch=writeBatch(db);for(const token of tokens)batch.delete(doc(db,'portal_public',token));batch.delete(doc(db,'portal_clients',key));await batch.commit();delete state.clients[key];notify('Client permanently deleted');
}
function download(name,content,type){const a=document.createElement('a'),u=URL.createObjectURL(new Blob([content],{type}));a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function exportCsv(){const p=project(),columns=deliveryColumns(p,{includeInternal:admin()}).filter(c => admin() || c.key !== 'dl'),headers=['Number',...columns.map(column=>column.label),'Status'],keys=['n',...columns.map(column=>column.key),'s'];const safe=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};download(`${state.projectKey}-deliveries.csv`,'\uFEFF'+[headers,...itemsOf(p).map(i=>keys.map(k=>i[k]))].map(row=>row.map(safe).join(',')).join('\r\n'),'text/csv;charset=utf-8');notify('Delivery CSV downloaded');}
async function loadProjectArtifacts({includeHistoricalSignature=false}={}){
  const freshRecords=await allRecords(state.mode==='client'?state.token:client().accessToken,{includeDeliveries:false,includeInternal:admin(),includeAttachments:false});
  const names=['sigs','confirms','feedback','consent','agreements','acknowledgements','reviews','notices','receipts'];
  state.artifacts[state.clientKey]=Object.fromEntries(names.map(col=>[col,freshRecords.filter(r=>r.collection===col)]));
  state.artifacts[state.clientKey].ready=Object.fromEntries(names.map(name=>[name,true]));
  const current=activeSignature(),historical=projectSigs().sort((a,b)=>dateValue(b.signedAt)-dateValue(a.signedAt))[0],s=current||(includeHistoricalSignature?historical:null),r=s?sigReview(s):{};
  return s?{...s,review:r,displayName:r.displayName||s.name,outdated:signatureOutdated(s,project())}:null;
}
function openDocument(title,subtitle,html){modal(title,subtitle,`<iframe class="report-frame" title="${esc(title)}" srcdoc="${esc(html)}"></iframe>`,null);$('modalLayer').querySelector('.modal').classList.add('report-modal');}
async function report(){notify('Loading complete report…');const signature=await loadProjectArtifacts({includeHistoricalSignature:true}),founder=state.founder;const html=buildProjectReport({client:client(),project:project(),items:itemsOf(project()),isAdmin:admin(),masterSignature:onboarding.isAgencyPartner()?onboarding.master():null,projectAcknowledged:onboarding.projectReady(state.projectKey),approvals:project().approvals.map(a=>({...a,confirmation:confirmation(a)})),signature,feedback:visibleRequests().map(f=>({...f,...reviewOf(f)})),logoUrl:new URL('../logo.png',location.href).href,founderSignatureUrl:founder.signatureUrl,authorizedName:founder.name,authorizedTitle:founder.title,pdfLibraryUrl:new URL('./html2pdf.bundle.min.js',location.href).href,exportScriptUrl:new URL('./report-export.js?v=20261001-r2',location.href).href,generatedAt:now()});openDocument('Project report','Complete delivery, payment, approval and feedback record. Use the preview to download a PDF.',html);notify('Project report ready. No pop-up permission is needed.');}
async function agreement(){notify('Loading agreement…');const signature=await loadProjectArtifacts(),founder=state.founder;const html=buildProjectAgreement({client:client(),project:project(),signature,masterSignature:onboarding.isAgencyPartner()?onboarding.master():null,projectAcknowledged:onboarding.projectReady(state.projectKey),logoUrl:new URL('../logo.png',location.href).href,founderSignatureUrl:founder.signatureUrl,authorizedName:founder.name,authorizedTitle:founder.title,pdfLibraryUrl:new URL('./html2pdf.bundle.min.js',location.href).href,exportScriptUrl:new URL('./report-export.js?v=20261001-r2',location.href).href,generatedAt:now()});openDocument('Terms & agreement','A clean, numbered agreement with project particulars and signature blocks. Use the preview to download a PDF.',html);notify('Terms & agreement ready.');}

async function downloadDelivery(source){
  if(admin())throw new Error('Open the private client view to use this action.');
  const p=project(),item=itemsOf(p).find(i=>String(i.n)===source.dataset.delivery);
  if(!item?.hasDelivery)return modal('Not delivered yet',`Deliverable ${source.dataset.delivery}`,`<p>${esc(item?.s==='revision'?'This item is being revised. We will email you as soon as the corrected file is delivered.':'This file becomes available once the item is marked Delivered. We will notify you by email.')}</p>`,null);
  // Owner gate: only steps the client must do personally (agreement/signature)
  // block a download. Payments and 72h approvals never block it.
  if(!onboarding.projectReady(state.projectKey))return deliveryGate(item);
  const decision=downloadDecision(p,item,confirmation,Date.now(),receiptFor);
  if(decision.allowed)return openDeliveryLink(item,true);
  if(decision.reason==='pending')return receiveDelivery(decision.approval,item);
  const message=decision.reason==='rejection-pending'?'You reported a problem with this deliverable. Vision Flow is reviewing your reason. The download unlocks after the revised file is ready.':'This deliverable was rejected and is being revised. You will be notified when the corrected file is ready.';
  return modal('Download locked',`Deliverable ${item.n}${item.t?` · ${item.t}`:''}`,`<p>${esc(message)}</p>`,null);
}
function deliveryGate(item){
  const agency=onboarding.isAgencyPartner(),acknowledge=agency&&Boolean(onboarding.master());
  const [title,detail,action]=acknowledge?['Acknowledge this project’s particulars','Your master signature is already on record. Confirm this project’s scope, price and timeline - it takes a few seconds.','Review & acknowledge']
    :agency?['Sign your master partner agreement','Sign once with your finger, mouse or trackpad. It covers every project you run with Vision Flow.','Open signature pad']
    :['Sign this project’s agreement','Review the scope, price and timeline, then sign with your finger, mouse or trackpad.','Open signature pad'];
  modal('One step before your download',`Deliverable ${item.n}${item.t?` · ${item.t}`:''} is ready`,`<div class="gate-guide full"><p>Your file is ready. Final files unlock once this step is complete:</p><ol class="gate-steps"><li class="gate-step"><strong>${esc(title)}</strong><span class="small muted">${esc(detail)}</span></li></ol><p class="small muted">Payments never block a download. When the step is done, press Download again and the file opens straight away.</p></div>`,
    async()=>{finishModal();acknowledge?onboarding.acknowledge():onboarding.sign();},action);
}
// Silent verification: with nothing personal pending, the Download click is
// recorded as a server-timed receipt and the file opens. The client then has
// 72 hours to report a problem; silence counts as accepted.
async function receiveDelivery(approval,item){
  const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
  try{
    try{await setDoc(doc(db,'portal_public',state.token,'receipts',approval.id),{projectKey:state.projectKey,itemNumber:Number(item.n),receivedAt:serverTimestamp(),userAgent:navigator.userAgent.slice(0,2048)});}
    catch(error){if(!(receiptFor(approval)||error?.code==='permission-denied'))throw error;}
    await openDeliveryLink(item,false,popup);
    notify('Download opened. You have 72 hours to report any problem; after that the delivery counts as accepted.');
  }catch(error){popup?.close();throw error;}
}
async function openDeliveryLink(item,usePopup,existingPopup=null){
  const popup=existingPopup||(usePopup?window.open('about:blank','_blank'):null);if(popup&&!existingPopup)popup.opener=null;
  try{
    const snap=await getDocFromServer(doc(db,'portal_public',state.token,'deliveries',deliveryDocId(state.projectKey,item.n)));
    const target=safeUrl(snap.data()?.link);
    if(!target)throw new Error('This delivery is unavailable. Contact Vision Flow.');
    if(popup)popup.location.replace(target);else modal('Your delivery is ready',`Deliverable ${item.n} is ready. Open the authorized file below.`,`<p>${link(target,'Open delivery file')}</p>`,null);
  }catch(error){popup?.close();throw error?.code==='permission-denied'?new Error('This download is not available yet. Refresh the page and try again, or contact Vision Flow.'):error;}
}
// Admin-only: keep per-item delivery access records in step with the private
// client record (first run also retires the legacy all-links manifests).
const deliverySyncs={};
async function syncDeliveryAccess(key,c){
  if(!admin()||!c?.accessToken||c._deleted||recoveryPending(c))return;
  const mark=`${c.accessToken}:${c._revision||0}`;if(deliverySyncs[key]===mark)return;deliverySyncs[key]=mark;
  try{
    const snap=await getDocs(collection(db,'portal_public',c.accessToken,'deliveries'));
    const current=new Map(snap.docs.map(d=>[d.id,d.data()]));
    const expected=new Map(projectsOf(c).flatMap(([k,p])=>deliveryAccessDocs(p,k)).map(d=>[d.id,d.data]));
    const ops=[...[...expected].filter(([id,data])=>!sameRecord(current.get(id),data)).map(([id,data])=>({id,data})),...[...current.keys()].filter(id=>!expected.has(id)).map(id=>({id}))];
    if(!ops.length)return;
    for(let i=0;i<ops.length;i+=400){const batch=writeBatch(db);for(const op of ops.slice(i,i+400)){const ref=doc(db,'portal_public',c.accessToken,'deliveries',op.id);op.data?batch.set(ref,op.data):batch.delete(ref);}await batch.commit();}
  }catch(error){delete deliverySyncs[key];console.warn('Delivery access sync failed',error);}
}
// First visit: a short, skippable welcome tour (stored per private link).
const SENDER_EMAIL='visionflow.agency.bd@gmail.com';
const TOUR=[
  ['Your next steps','The panel at the top lists anything that needs you: signing an agreement, confirming an update or downloading a delivery. When it says “You are all caught up”, nothing is waiting.'],
  ['Projects & production log','Open a project to see its scope, payments and every deliverable. A file appears in the Production log as soon as its item is marked Delivered.'],
  ['One click to download','Press Download and the file opens. The click is saved as your receipt; you then have 72 hours to report any problem, after which the delivery counts as accepted.'],
  ['Approvals & feedback','Updates that need your answer show a 72-hour timer. Confirm, reject with a reason, or send feedback and revision requests from the same page.'],
  ['We keep you posted',`Every important update is also sent by email and WhatsApp. Our emails come from ${SENDER_EMAIL} - please add it to your contacts and check Spam or Promotions if a message seems missing.`]
];
function welcomeTour(step=-1){
  const intro=step<0,last=step===TOUR.length-1,name=client()?.name||'';
  const body=intro?`<div class="welcome-hero full"><img class="welcome-logo" src="../logo.png" alt="Vision Flow"><p class="welcome-tagline">Crafted with vision. Delivered in flow.</p><p>This private workspace keeps your projects, agreements, approvals and final files in one place. Take a 30-second tour, or skip it and explore - you can reopen the tour any time.</p><p class="small muted">We will also send every important update by email and WhatsApp. Emails come from <strong>${esc(SENDER_EMAIL)}</strong>; please check Spam or Promotions if you do not see them.</p></div>`
    :`<div class="tour-step full"><p class="eyebrow">Step ${step+1} of ${TOUR.length}</p><h3>${esc(TOUR[step][0])}</h3><p>${esc(TOUR[step][1])}</p><div class="tour-dots" aria-hidden="true">${TOUR.map((_,i)=>`<span class="${i===step?'on':''}"></span>`).join('')}</div></div>`;
  modal(intro?`Welcome to Vision Flow${name?`, ${name}`:''}`:'Quick tour',intro?'Your private client workspace':'A quick look around',body+`<div class="full actions">${button(intro?'Take the quick tour':last?'Get started':'Next','tour-next',`data-step="${step+1}"`,'primary')}</div>`,null);
  const skip=$('modalContent').querySelector('.form-actions [data-action="close-modal"]');if(skip)skip.textContent=intro||!last?'Skip tour':'Close';
}
function maybeWelcome(){
  if(state.mode!=='client'||!client()||!onboarding.consent()||!$('modalLayer').hidden||state.busy)return;
  const key=`vf-welcome-v1-${state.token}`;
  try{if(localStorage.getItem(key))return;localStorage.setItem(key,new Date().toISOString());}catch{return;}
  welcomeTour(-1);
}
async function masterPdf(){
  await loadProjectArtifacts();const p=onboarding.portal(),s=onboarding.master(),f=state.founder;
  openDocument('Master Partner Agreement','Your master agreement and the project particulars captured when you signed.',buildMasterAgreement({client:client(),terms:s?.termsSnapshot||p.masterAgreement,projectTerms:s?.projectTerms||p.projectTerms,signature:s,logoUrl:new URL('../logo.png',location.href).href,founderSignatureUrl:f.signatureUrl,authorizedName:f.name,authorizedTitle:f.title,pdfLibraryUrl:new URL('./html2pdf.bundle.min.js',location.href).href,exportScriptUrl:new URL('./report-export.js?v=20261001-r2',location.href).href}));
}
async function action(name,source){
  if(name==='notification-status'||name==='notification-next')return openNotificationStatus(name==='notification-next');
  if(name==='restart-review'){
    requireAdmin();const review=artifacts(state.clientKey).reviews.find(r=>r.requestId===source.dataset.id);
    if(!review||!client().projects[review.projectKey]||client().projects[review.projectKey].deleted)throw Error('This review project is no longer available.');
    return modal('Publish a fresh review','The original evidence is retained. The new window starts only after current agreement requirements and its email handoff. Unresolved objections still prevent automatic acceptance.',`${field('Review title','title',review.title||'Project update','text','required maxlength="200"')}${area('Explain what changed or why another review is needed','reason','','required minlength="10" maxlength="4000"')}`,async form=>{
      await saveClient(clone(client()),'Fresh review published and notification queued',[],{manualNotice:{projectKey:review.projectKey,title:text(form.get('title')),message:text(form.get('reason'))}});finishModal();
    },'Publish new review');
  }
  if(name==='confirm-review'||name==='reject-review'){
    if(state.mode!=='client')throw Error('Open the private client workspace to respond.');
    const review=artifacts(state.clientKey).reviews.find(r=>r.requestId===source.dataset.id);
    if(!review)throw Error('Review unavailable. Refresh and try again.');
    const reject=name==='reject-review';
    return modal(reject?'Object to this update':'Confirm this update',review.title||'Project review',reject?area('Explain the changes needed','reason','','required minlength="10" maxlength="2000"'):'<p>Your explicit confirmation is recorded separately from your signature, payment verification and download permissions.</p><label class="check-field"><input type="checkbox" required> I have reviewed this update and confirm it.</label>',async form=>{
      const data={projectKey:review.projectKey,requestId:review.requestId,sourceVersion:review.sourceVersion,confirmedAt:serverTimestamp(),userAgent:navigator.userAgent};
      if(reject){data.kind='rejection-pending';data.rejectReason=text(form.get('reason'));}
      await submitClientEvidence(review.requestId,data);notify(reject?'Objection saved. Automatic acceptance is stopped.':'Your explicit confirmation is saved.');finishModal();
    },reject?'Submit objection':'Confirm update');
  }
  if(name==='master-sign'||name==='sign')return onboarding.sign();
  if(name==='project-sign')return onboarding.sign();
  if(name==='master-details')return onboarding.details();
  if(name==='master-pdf')return masterPdf();
  if(name==='portal-policy')return modal('Terms & Privacy',onboarding.portal().consentTerms.version,onboarding.sections(onboarding.portal().consentTerms),null);
  if(name==='project-ack')return onboarding.acknowledge();
  if(name==='master-manage'){requireAdmin();return onboarding.manage();}
  if(name==='legacy-signatures')return modal('Historical project signatures','These original records are separate from the master agreement.',legacySignatureView(project()),null);
  if(name==='sign-required')return onboarding.isAgencyPartner()&&onboarding.master()?onboarding.acknowledge():onboarding.sign();
  if(name==='gated-download')return downloadDelivery(source);
  if(name==='welcome-tour')return welcomeTour(-1);
  if(name==='tour-next'){closeModal();const step=Number(source.dataset.step);if(step<TOUR.length)welcomeTour(step);return;}
  if(name==='go-action'){state.projectKey=source.dataset.project||null;state.tab='overview';render();const target=source.dataset.hash;setTimeout(()=>{history.replaceState(null,'',`${location.pathname}${location.search}#${target}`);hashScroll();},60);return;}
  if(name==='all-records'){
    requireAdmin();const records=(await allRecords(client().accessToken)).filter(record=>record.collection!=='deliveries');
    modal('All submitted records','Includes legacy and unlinked records. Archive to the recycle bin before permanent deletion.',records.map(r=>'<div class="record"><strong>'+esc(r.collection+' · '+r.id)+'</strong><p>'+esc(r.name||r.message||r.projectKey||'Legacy / unlinked record')+'</p>'+button('Move record to bin','archive-record',`data-id="${esc(r.id)}" data-collection="${esc(r.collection)}"`,'danger')+'</div>').join('')||'<p>No submitted records.</p>',null);return;
  }
  if(name==='close-modal')return closeModal();
  if(name==='founder-signature')return openFounderSignature();
  if(name==='email-settings')return openEmailSettings();
  if(name==='dashboard'){state.clientKey=null;state.projectKey=null;state.page='workspace';return render();}
  if(name==='trash'){requireAdmin();state.page='trash';return render();}
  if(name==='preview-trash')return openTrashPreview(source.dataset.client,source.dataset.id);
  if(name==='preview-client-trash')return openClientTrashPreview(source.dataset.client);
  if(name==='preview-archived-row')return openArchivedRowPreview(source.dataset.number);
  if(name==='refresh')return location.reload();
  if(name==='logout'){clearSubscriptions();state.clients={};state.user=null;await signOut(auth);state.mode='login';return render();}
  if(name==='open-client'){state.clientKey=source.dataset.client||state.clientKey;state.projectKey=null;state.tab='overview';state.page='workspace';return render();}
  if(name==='open-project'){state.projectKey=source.dataset.project;state.tab='overview';return render();}
  if(name==='tab-log'||name==='tab-overview'){state.tab=name==='tab-log'?'log':'overview';return render();}
  if(name==='add-client'||name==='edit-client')return openClientForm(name==='edit-client');
  if(name==='add-project'||name==='edit-project')return openProjectForm(name==='edit-project');
  if(name==='edit-item')return openItem(Number(source.dataset.number));
  if(name==='add-payment'||name==='edit-payment')return openPayment(source.dataset.id);
  if(name==='add-approval'||name==='edit-approval')return openApproval(source.dataset.id);
  if(name==='feedback-project'||name==='feedback-item')return openFeedback(Number(source.dataset.number)||0);
  if(name==='download-feedback-attachment')return downloadFeedbackAttachment(source);
  if(name==='download-archived-attachment')return downloadArchivedAttachment(source);
  if(name==='review-feedback')return openFeedbackReview(source.dataset.id,source.dataset.collection);
  if(name==='manage-signature')return openSignatureReview(source.dataset.id);
  if(name==='signed-terms'){const s=projectSigs().find(s=>s.id===source.dataset.id);return modal('Signed project record',`Signed by ${s.name} on ${dateText(s.signedAt)}`,s.termsSnapshot?termsHtml(s.termsSnapshot):'<p>This legacy record did not include a terms snapshot.</p>',null);}
  if(name==='clear-signature'){if(pad){pad.ctx.clearRect(0,0,pad.canvas.width,pad.canvas.height);pad.drawn=false;}return;}
  if(name==='copy-client'||name==='copy-project'){notify('Copying private link…');const url=clientUrl(client(),name==='copy-project'?state.projectKey:null);try{await navigator.clipboard.writeText(url);notify('Private link copied');}catch{modal('Copy private link','Select and copy this link.',field('Private URL','url',url,'text','readonly'),null);}return;}
  if(name==='wa-send')return waLink();
  if(name==='email-send')return mailLink();
  if(name==='preview-client'){const win=window.open(clientUrl(client(),state.projectKey),'_blank','noopener');notify('Opening private client view…');return win;}
  if(name==='link-settings')return linkSettings();
  if(name==='archived-rows')return openArchivedRows();
  if(name==='report')return report();
  if(name==='agreement')return agreement();
  if(name==='export-csv')return exportCsv();
  if(name==='export-all'){requireAdmin();const fresh={},records={},archives={};for(const d of (await getDocs(collection(db,'portal_clients'))).docs){const current=fresh[d.id]=normalizeClient(d.data(),d.id);records[d.id]=await allRecords(current.accessToken);archives[d.id]={};for(const [trashId,entry] of Object.entries(current.trash||{})){const archived=await archivedTrashRecords(d.id,entry);if(archived.length)archives[d.id][trashId]=archived;}}download(`vision-flow-backup-${localDay()}.json`,JSON.stringify({exportedAt:now(),version:5,clients:fresh,artifacts:records,archives},null,2),'application/json');return notify('Client archive downloaded. Keep it secure. Full recovery also needs the separate database/settings/backend snapshot.');}
  requireAdmin();
  if(name.startsWith('archive-')){if(!await confirmAction('Move this record to the recycle bin? You can restore it later.'))return;await archive(name.slice(8),source);return render();}
  if(name==='restore-client'){const c=clone(state.clients[source.dataset.client]);if(c.purgeState)throw new Error('Permanent deletion is in progress. Resume or finish it before restoring this client.');c._deleted=false;await saveClient(c,'Client restored');return render();}
  if(name==='restore-trash'){await restoreTrash(source.dataset.client,source.dataset.id);return render();}
  if(name==='purge-trash'){await purgeTrash(source.dataset.client,source.dataset.id);return;}
  if(name==='purge-client'){if(await confirmAction('Permanently delete this client and every project, signature, request and payment? This cannot be undone.'))await purgeClient(source.dataset.client);return render();}
  if(name==='restore-row'||name==='purge-row'){const c=clone(client()),p=c.projects[state.projectKey],number=Number(source.dataset.number),i=p.items.find(i=>Number(i.n)===number),ops=[];if(!i?.deleted)throw new Error('Archived row not found.');if(name==='purge-row'){if(!await confirmAction('Permanently delete this archived production row and its linked feedback?'))return;const linked=(await allRecords(c.accessToken)).filter(record=>record.projectKey===state.projectKey&&Number(record.itemNumber)===number&&(record.collection==='feedback'||record.collection==='confirms'||record.collection==='attachments'||record.kind==='feedback'));for(const record of linked){ops.push({path:[record.collection,record.id],delete:true});delete c.feedbackReviews[record.id];}p.items=p.items.filter(x=>x!==i);}else{delete i.deleted;delete i.deletedAt;}p.totalItems=itemsOf(p).length;await saveClient(c,name==='restore-row'?'Row restored':'Row permanently deleted',ops);finishModal();return;}
  if(name==='reset-approval'){const id=source.dataset.id;const c=client();let wasRejPending=false;try{const tk=c.accessToken||state.token;if(tk){const snap=await getDoc(doc(db,'portal_public',tk,'confirms',id));wasRejPending=snap.exists()&&snap.data()?.kind==='rejection-pending';}}catch(e){}if(wasRejPending){modal('Dismiss Client Rejection','This closes the item and stops its timer for good. The client sees your reason in the portal and by email. Any later change must be published as a new update, which starts a fresh 72-hour window.','<div class="form-grid"><label>Quick Reason</label><select name="preset" onchange="this.form.querySelector(\'[name=reason]\').value=this.value"><option value="">Select a reason...</option><option value="The update was necessary for project compliance.">Project compliance requirement</option><option value="This change was agreed upon in our earlier discussion.">Previously agreed change</option><option value="The terms have been updated to reflect current project scope.">Updated project scope</option><option value="Your feedback has been noted. However, this update is required to proceed.">Required to proceed</option></select>'+area('Custom Reason','reason','','required minlength="10" maxlength="2000" placeholder="Or write your own reason..."')+'</div>',async data=>{const reason=data.get('reason');if(!reason||!reason.trim())throw new Error('Please provide a reason.');const c2=clone(c),ap=c2.projects?.[state.projectKey]?.approvals?.find(x=>x.id===id);if(!ap)throw new Error('This approval was not found. Refresh and retry.');ap.closure='dismissed';ap.closedAt=new Date().toISOString();ap.closeReason=reason.trim().slice(0,2000);await saveClient(c2,'Rejection dismissed',[],{manualNotice:{projectKey:state.projectKey,kind:'feedback-reply',title:`Your feedback on "${String(ap.title||'an update').slice(0,120)}" was reviewed`,message:`Thank you for your feedback. Our response: ${ap.closeReason}\n\nThis item is now closed. Any further change will arrive as a new update with its own 72-hour review window.`}});finishModal();render();},'Dismiss & close');}else{if(!await confirmAction('Reset this confirmation? The client will need to re-confirm.'))return;const tk=c.accessToken||state.token;if(tk)await deleteDoc(doc(db,'portal_public',tk,'confirms',id));render();}return;}    if(name==='toggle-sharing'){const c=clone(client());c.accessEnabled=c.accessEnabled===false;await saveClient(c,c.accessEnabled?'Sharing enabled':'Sharing paused');return finishModal();}
  if(name==='resume-archive'){const key=source.dataset.client||state.clientKey;if(!key)throw new Error('Select the affected client first.');state.clientKey=key;state.projectKey=null;await resumeLargeArchive(clone(state.clients[key]));finishModal();return render();}
  if(name==='rotate-link'){if(await confirmAction('Replace the private link? The old link will stop working.'))await rotateLink();return;}
    throw new Error(`Unsupported portal action: ${name}`);
}

document.addEventListener('click',event=>{const source=event.target.closest('[data-action]');if(!source||state.busy)return;const name=source.dataset.action;
  if(name==='request-signature'){const url=clientUrl(client(),state.projectKey)+'#master-agreement';modal('Invite client to sign','Share this private project link with the client. The portal records their time-stamped signature and current terms.',field('Private agreement link','url',url,'text','readonly'),null);return;}
  if(name==='confirm-rejection'){const id=source.dataset.id;const tk=client().accessToken||state.token;if(!tk){notify('Error: client token not found',true);return;}source.disabled=true;source.textContent='Confirming...';(async()=>{const ref=doc(db,'portal_public',tk,'confirms',id),prev=(await getDoc(ref)).data()||{};// Keep the client's original confirmedAt: the queued objection alert is bound to it.
return setDoc(ref,{...prev,projectKey:prev.projectKey||state.projectKey,confirmedAt:prev.confirmedAt||serverTimestamp(),kind:'rejected',rejectReason:prev.rejectReason||source.closest('.rejection-card')?.querySelector('.rejection-reason p')?.textContent||'',adminConfirmedAt:serverTimestamp(),userAgent:prev.userAgent||'admin-confirmed'});})().then(async()=>{const ap=project()?.approvals?.find(x=>x.id===id);await sendNotification({warnIfUnavailable:true,kind:'feedback-reply',subject:`Your feedback on "${String(ap?.title||'an update').slice(0,120)}" was accepted`,message:'Thank you - we accepted your feedback. We are preparing a revised version. It will arrive as a new update with a fresh 72-hour review window.'});render();}).catch(fail).finally(()=>{source.disabled=false;source.textContent='Confirm rejection';});return;}
  if(name==='accept-terms')return;
  if(name==='confirm-approval'){source.disabled=true;source.textContent='Confirming…';submitClientEvidence(source.dataset.id,{projectKey:state.projectKey,confirmedAt:serverTimestamp(),userAgent:navigator.userAgent}).then(()=>{notify('Update confirmed');}).catch(fail).finally(()=>{source.disabled=false;source.textContent='Confirm update';});return;}
  if(name==='reject-approval'){const id=source.dataset.id;modal('Reject this update','Explain why you are rejecting. Your reason will be shared with the project team.','<div class="form-grid">'+area('Rejection reason','reason','','required minlength="10" maxlength="2000" placeholder="Describe why..."')+'</div>',async data=>{const reason=data.get('reason');if(!reason||!reason.trim())throw new Error('Reason required.');await submitClientEvidence(id,{projectKey:state.projectKey,confirmedAt:serverTimestamp(),userAgent:navigator.userAgent,kind:'rejection-pending',rejectReason:reason.trim()});notify('Rejection submitted for administrator review.');finishModal();render();},'Submit rejection');return;}
  const old=source.textContent;let result;try{result=action(name,source);}catch(error){fail(error);return;}if(result?.then){source.disabled=true;source.textContent='Working…';result.catch(fail).finally(()=>{source.disabled=false;source.textContent=old;render();});}
});
document.addEventListener('submit',async event=>{if(event.target.id!=='loginForm')return;event.preventDefault();const form=event.target,send=form.querySelector('[type=submit]'),data=new FormData(form);send.disabled=true;send.textContent='Signing in…';try{await signInWithEmailAndPassword(auth,text(data.get('email')),String(data.get('password')));}catch(error){form.querySelector('.form-error').textContent=errorMessage(error);fail(error);}finally{send.disabled=false;send.textContent='Sign in securely';}});
document.addEventListener('input',e=>{if(e.target.id!=='itemSearch')return;state.filter=e.target.value;applyFilters();});
document.addEventListener('change',async e=>{if(e.target.id==='itemStatus'){state.status=e.target.value;applyFilters();return;}if(e.target.id==='itemBatch'){state.batch=e.target.value;applyFilters();return;}if(e.target.name==='proof'){const file=e.target.files[0];if(!file)return;if(previewObjectUrl)URL.revokeObjectURL(previewObjectUrl);previewObjectUrl=URL.createObjectURL(file);$('proofPreview').src=previewObjectUrl;$('proofPreview').classList.add('visible');return;}if(e.target.name!=='founderSignatureFile')return;try{await prepareFounderPreview(e.target);}catch(error){fail(error);}});
$('modalLayer').addEventListener('click',event=>{if(event.target===$('modalLayer'))closeModal();});
document.addEventListener('keydown',event=>{if(document.querySelector('.confirmation-dialog[open]')||$('modalLayer').hidden)return;if(event.key==='Escape'){event.preventDefault();closeModal();}if(event.key==='Tab'){const nodes=[...$('modalLayer').querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(x=>!x.hidden);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});
const onboarding=createOnboarding({
  state,getClient:client,isAdmin:admin,artifacts:()=>artifacts(state.clientKey),button,field,modal,finishModal,notify,fail,render,dateText,termsHtml,initPad,getPad:()=>pad,saveClient,projectSign:openSignature,timestamp:serverTimestamp,
  writeRecord:(col,id,data)=>writeClientRecord({root:`portal_public/${state.token}`,collection:col,id,data,timestamp:serverTimestamp(),transaction:fn=>runTransaction(db,tx=>fn({get:async path=>{const snap=await tx.get(doc(db,path));return snap.exists()?snap.data():null;},set:(path,value)=>tx.set(doc(db,path),value)}))}),
  readRecord:async(col,id)=>{const snap=await getDocFromServer(doc(db,'portal_public',state.token,col,id));return snap.exists()?snap.data():null;}
});
if(initialAccess)startClient(initialAccess);else onAuthStateChanged(auth,async user=>{state.user=user;if(!user){clearSubscriptions();state.mode='login';render();return;}if(user.uid!==ADMIN_UID){await signOut(auth);state.mode='login';renderLogin('This account does not have administrator access.');return;}startAdmin();});
setTimeout(()=>{if(!state.loaded&&!['login','error'].includes(state.mode)){$('view').innerHTML=empty('Taking longer than expected','Check your connection and try again.')+button('Retry','refresh');}},15000);

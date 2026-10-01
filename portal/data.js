import {REVIEW_POLICY,REVIEW_POLICY_TEXT} from './review-policy.js?v=20260928-r1';
export const ADMIN_UID = 'm1PGSw7ViEb1xOJoj8INQllra3p1';
export const STATUS = ['pending', 'progress', 'completed', 'delivered', 'revision'];
export const LABEL = { pending: 'Pending', progress: 'In progress', completed: 'Completed', delivered: 'Delivered', revision: 'Revision', active: 'Active', paused: 'Paused' };
// Firestore Timestamp instances are immutable but structuredClone turns them
// into plain { seconds, nanoseconds } objects. Keep them intact so a record
// moved through the recycle bin can be restored with its original Firestore
// timestamp type (and not silently change schema on the way back).
const isFirestoreTimestamp = value => Boolean(value) && typeof value === 'object'
  && typeof value.toDate === 'function' && typeof value.toMillis === 'function'
  && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds);
export const clone = value => {
  if (value === null || typeof value !== 'object' || isFirestoreTimestamp(value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [clone(key), clone(entry)]));
  if (value instanceof Set) return new Set([...value].map(clone));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
};
export const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const text = value => String(value ?? '').trim();
const validCalendarDate = raw => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === raw;
};
// Browsers will coerce malformed legacy strings such as 10-52-52 into a
// different calendar date. Preserve noncanonical values for human review.
export const asValidDate = value => {
  let date;
  if (value?.toDate instanceof Function) date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (value && typeof value === 'object' && Number.isFinite(Number(value.seconds))) date = new Date(Number(value.seconds) * 1000);
  else if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?:\:\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
    if (!match || !validCalendarDate(match[1])) return null;
    date = new Date(value);
  } else return null;
  return Number.isNaN(date?.valueOf()) ? null : date;
};
export const money = value => new Intl.NumberFormat('en-BD', { style: 'currency', currency: 'BDT', maximumFractionDigits: 2 }).format(Number(value) || 0);
export const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
export const signatureImage = value => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(value)) ? value : '';
export const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2,'0')).join('');
export const itemsOf = project => (project?.items || []).filter(i => !i.deleted);
export const projectsOf = client => Object.entries(client?.projects || {}).filter(([,p]) => !p.deleted);
export const isDone = item => ['completed','delivered'].includes(item.s);
export const AGREEMENT_VERSION = 'VF-2026-09';
export const PORTAL_VERSION = 7;
export const TERMS_VERSION = 'VF-PORTAL-2026-09-v3';
export const PORTAL_TERMS = {
  version: TERMS_VERSION,
  sections: [
    ['Terms of access', 'This private project workspace is provided by Vision Flow for your projects, deliverables, payments and communications. Review the applicable agreement and project particulars before signing. Deliverables will be reviewed and confirmed through this portal as stated in the project agreement. Contact Vision Flow with questions before accepting.'],
    ['Privacy and confidentiality', 'Your unique private URL is personal and must not be shared with unauthorized parties. Project files, scripts, creative assets, pricing, payment records and communications in this workspace are confidential. Each party will use non-public project information only for this engagement and take reasonable care not to disclose it except where required for production, law or a written agreement.'],
    ['Records', 'The workspace retains your consent, signatures, approvals and feedback with their recorded dates. These records are available to you and the Vision Flow administrator as the shared record of the engagement. Contact Vision Flow about access, corrections or questions concerning these records.'],
  ].map(([title,body])=>({title,body})),
};
export const STANDARD_AGREEMENT_CLAUSES = [
  ['1. Project scope', 'Vision Flow will provide the project deliverables described in this agreement and the project particulars. Any work outside that scope requires written confirmation before work begins.'],
  ['2. Client inputs and approvals', 'The client will provide the materials, access, decisions and approvals reasonably needed for production. A delivery date may move when required inputs or approvals are delayed.'],
  ['3. Review and revisions', 'The client should review each submitted deliverable promptly and send consolidated, actionable feedback through the project workspace. Revisions that are outside the agreed scope may require a revised timeline or fee.'],
  ['4. Fees and payment', 'The agreed rate, budget and any project-specific payment arrangement are shown in the project particulars. Unless a project-specific term says otherwise, completed work and final deliverables remain subject to the agreed payment schedule.'],
  ['5. Delivery and acceptance', REVIEW_POLICY_TEXT],
  ['6. Intellectual property and third-party materials', 'Client-supplied materials remain the client’s responsibility. Ownership or usage rights for final work transfer only as stated in the project-specific terms and after the applicable fees are paid in full. Third-party licences, platform rules and source-material rights remain subject to their own terms.'],
  ['7. Confidentiality', 'Each party will use non-public project information only for this engagement and will take reasonable care not to disclose it except where required for production, law or a written agreement.'],
  ['8. Changes, suspension and cancellation', 'Either party should communicate a material change, pause or cancellation in writing. Work already completed, approved or committed to production remains payable according to the project record and any agreed changes.'],
  ['9. Records and electronic acceptance', 'The project workspace, its dated approvals and signature records are the shared record of this engagement. Electronic acceptance and signatures are intended to evidence the parties’ agreement to this project record.'],
];
export function metrics(project) {
  const items = itemsOf(project); const total = items.length; const done = items.filter(isDone).length;
  const paid = (project.payments || []).reduce((a,p) => a + (Number(p.amount) || 0), 0);
  const budget = Number(project.budget) || 0;
  return { total, done, paid, budget, due: budget - paid, percent: total ? Math.round(done / total * 100) : 0 };
}
export function deliveryColumns(project,{includeInternal=false}={}) {
  const items=itemsOf(project),itemLabel=text(project?.itemLabel)||'Item / subject',titleLabel=text(project?.titleLabel)||'Deliverable title',showItem=project?.showItemField!==false;
  const populated=key=>items.some(item=>key==='dl'?Boolean(safeUrl(item[key]))||Boolean(item.hasDelivery):key==='scriptUrl'||key==='avatarUrl'||key==='referenceUrl'?Boolean(safeUrl(item[key])):Boolean(text(item[key])));
  return [
    { key:'b', label:itemLabel, type:'text', show:showItem&&populated('b') },
    { key:'t', label:titleLabel, type:'text', show:populated('t') },
    { key:'sd', label:'Started', type:'date', show:populated('sd') },
    { key:'dd', label:'Delivered', type:'date', show:populated('dd') },
    { key:'dur', label:'Duration', type:'text', show:populated('dur') },
    { key:'dl', label:'Final delivery', type:'link', show:populated('dl') },
    { key:'scriptUrl', label:'Script', type:'link', show:populated('scriptUrl') },
    { key:'avatarUrl', label:'Character / avatar', type:'link', show:populated('avatarUrl') },
    { key:'referenceUrl', label:'Reference', type:'link', show:populated('referenceUrl') },
    { key:'clientNote', label:'Client note', type:'text', show:populated('clientNote') },
    { key:'no', label:'Internal admin note', type:'text', show:includeInternal&&populated('no') },
  ].filter(column=>column.show);
}
export function normalizeClient(input, slug) {
  const c = clone(input || {}); c.slug = slug; c.projects ||= {}; c.trash ||= {}; c.feedbackReviews ||= {}; c.signatureReviews ||= {}; c._revision ||= 0;
  for (const [key,p] of Object.entries(c.projects)) {
    p.slug = key; p.items ||= []; p.payments ||= []; p.approvals ||= [];
    p.itemLabel = text(p.itemLabel) || 'Item / subject';
    p.titleLabel = text(p.titleLabel) || 'Deliverable title';
    p.showItemField = p.showItemField !== false;
    p.items.forEach((item,i) => { item.n ||= i + 1; if (!STATUS.includes(item.s)) item.s = 'pending'; });
    p.payments.forEach((payment,i) => { payment.id ||= `payment-${key}-${i}`; });
    p.approvals.forEach((approval,i) => { approval.id ||= `approval-${key}-${i}`; });
    p.totalItems = itemsOf(p).length;
  }
  return c;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k,clone(value[k])]));
export function publicSnapshot(client, slug) {
  const projects = {}; const approvalIds = []; const approvalProjects = {};
  for (const [key,p] of projectsOf(client)) {
    projects[key] = pick(p,['slug','name','rate','budget','status','createdAt','lastUpdated','scope','terms','deadline','weeklyTarget','milestoneText','sourceScriptUrl','avatarFolderUrl','itemLabel','titleLabel','showItemField']);
    projects[key].items = itemsOf(p).map(item => { const pub = pick(item,['n','b','t','s','sd','dd','dur','clientNote','scriptUrl','avatarUrl','referenceUrl','batch']); if (safeUrl(item.dl)) pub.hasDelivery = true; return pub; });
    projects[key].deliveryVersion = Number(p.deliveryVersion)||0;
    projects[key].notificationRevision = Number(p.notificationRevision)||0;
    projects[key].ackId = `${key}-${Number(p.agreementRevision)||1}-${Number(client.masterRevision)||1}`;
    projects[key].itemNumbers = projects[key].items.map(item => Number(item.n)).filter(Number.isInteger);
    projects[key].totalItems = projects[key].items.length;
    projects[key].payments = (p.payments || []).map(payment => pick(payment,['id','date','amount','type','note','proofUrl','recordedAt','confirmedAt']));
    projects[key].approvals = (p.approvals || []).map(approval => pick(approval,['id','title','desc','createdAt','updatedAt']));
    for (const approval of p.approvals || []) { approvalIds.push(approval.id); approvalProjects[approval.id] = key; }
  }
  // Archived payloads live in the admin-only archive collection. The parent
  // document only needs the directly archived id (when present) plus legacy
  // inline records; never mirror an unbounded id list into the public/client
  // document.
  const hiddenIds = new Set(Object.values(client.trash || {}).flatMap(entry => [entry.value?.id, ...(entry.records || []).map(r=>r.id)]).filter(Boolean));
  const visibleReviews = reviews => Object.fromEntries(Object.entries(reviews || {}).filter(([id])=>!hiddenIds.has(id)).map(([id,value])=>[id,clone(value)]));
  const snapshot = { clientSlug:slug, name:client.name || slug, enabled:!client._deleted && client.accessEnabled !== false, projects,
    feedbackReviews:visibleReviews(client.feedbackReviews), signatureReviews:visibleReviews(client.signatureReviews),
    approvalIds, approvalProjects, lastUpdated:client.lastUpdated || new Date().toISOString(), portalVersion:PORTAL_VERSION,
    consentTerms:clone(PORTAL_TERMS), masterAgreement:masterAgreementTerms(client), eventQueueVersion:1, reviewEpoch:Number(client.reviewEpoch)||0 };
  const clean = redactDeliverySecrets(snapshot,client);
  clean.projectTerms=Object.fromEntries(Object.entries(clean.projects).map(([key,p])=>[key,agreementTerms(p)]));
  return clean;
}
export function agreementTerms(project) {
  return { projectName:project.name || project.slug, totalItems:itemsOf(project).length, rate:Number(project.rate)||0, budget:Number(project.budget)||0,
    scope:project.scope || '', terms:project.terms || '', deadline:project.deadline || '', weeklyTarget:Number(project.weeklyTarget)||0, milestoneText:project.milestoneText || '', agreementVersion:AGREEMENT_VERSION };
}
export function signatureOutdated(signature, project) {
  const signed=signature?.termsSnapshot;
  if(!signed || signed.agreementVersion!==AGREEMENT_VERSION) return true;
  return Object.entries(agreementTerms(project)).some(([key,value])=>signed[key]!==value);
}
export function validateAmount(value, label = 'Amount') { const n=Number(value); if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be zero or greater.`); return n; }
export function resizeItems(project, count) {
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error('Enter between 0 and 1,000 deliverables.');
  itemsOf(project).slice(count).forEach(item => { item.deleted = true; item.deletedAt = new Date().toISOString(); });
  let number = Math.max(0,...project.items.map(i => Number(i.n)||0));
  while (itemsOf(project).length < count) project.items.push({ n:++number,b:'',t:'',s:'pending',sd:'',dd:'',dur:'',dl:'',no:'' });
  project.totalItems = count;
}

export function deliveryManifest(project, projectKey) {
  return itemsOf(project)
    .filter(item => Boolean(safeUrl(item.dl)))
    .map(item => ({
      id: projectKey + '-' + String(item.n),
      projectKey,
      itemNumber: Number(item.n),
      dl: item.dl,
      updatedAt: new Date().toISOString()
    }));
}

export function masterAgreementTerms(client) {
  return { version:`VF-MASTER-2026-09-r2-${Number(client.masterRevision)||1}`, clientName:client.name||client.slug||'',
    termsVersion:TERMS_VERSION,
    reviewPolicy:clone(REVIEW_POLICY),
    application:'This master agreement applies to the service relationship between this client and Vision Flow across projects in this workspace. Project scope, price, schedule and payment terms are recorded separately. New or materially changed project particulars require a separate acknowledgement; they do not require another drawing of the master signature.',
    clauses:STANDARD_AGREEMENT_CLAUSES.map(([title,body])=>({title,body})) };
}
export function sameRecord(a,b) {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&sameRecord(a[key],b[key]));
}
function driveFileId(value) {
  try {const u=new URL(value);if(!['drive.google.com','docs.google.com','drive.usercontent.google.com'].includes(u.hostname))return '';return u.pathname.match(/\/d\/([^/]+)/)?.[1]||u.searchParams.get('id')||'';}catch{return '';}
}
// Include archived items: a historical approval must not republish its old final URL.
function deliverySecretUrls(client) {
  const urls=new Set((client?.deliverySecretUrls||[]).filter(value=>safeUrl(value)));
  const collect=x=>{if(!x||typeof x!=='object')return;if(safeUrl(x.dl)){urls.add(x.dl);urls.add(safeUrl(x.dl));}Object.values(x).forEach(collect);};collect(client);
  return [...urls];
}
export function redactDeliverySecrets(value,client) {
  const urls=new Set(deliverySecretUrls(client)),ids=new Set([...urls].map(driveFileId).filter(Boolean));
  const scrub=x=>{
    if(typeof x==='string'){
      let clean=x.replace(/https?:\/\/[^\s<>"']+/g,u=>(urls.has(u)||ids.has(driveFileId(u)))?'[Final delivery available through the workspace Download action]':u);
      for(const u of urls)clean=clean.split(u).join('[Final delivery available through the workspace Download action]');return clean;
    }
    if(Array.isArray(x))return x.map(scrub);
    if(x&&typeof x==='object'&&!isFirestoreTimestamp(x)&&!(x instanceof Date))return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,scrub(v)]));
    return x;
  };return scrub(value);
}
export const deliveryLinks = project => Object.fromEntries(itemsOf(project).filter(i=>safeUrl(i.dl)).map(i=>[String(i.n),safeUrl(i.dl)]));
// One manifest per project supports 1,000 deliverables without 1,000 writes.
// Private client, public summary and changed manifests commit atomically.
export function prepareSecureSave(next,previous={}) {
  // Private redaction-only denylist: replacing/removing a final link must not
  // reveal its old copies in descriptions or reports. It is never published
  // and never grants access; final file bytes are not retained here.
  next.deliverySecretUrls=[...new Set([...deliverySecretUrls(previous),...deliverySecretUrls(next)])];
  const writes=[],oldPublic=publicSnapshot(previous,previous.slug||next.slug);
  if(previous.name&&previous.name!==next.name)next.masterRevision=Math.max(Number(next.masterRevision)||1,(Number(previous.masterRevision)||1)+1);
  const proposed=publicSnapshot(next,next.slug);
  for(const [key,p] of projectsOf(next)) {
    const old=previous.projects?.[key];
    const termsChanged=!sameRecord(proposed.projectTerms[key],oldPublic.projectTerms[key]);
    p.agreementRevision=old?(Number(old.agreementRevision)||1)+(termsChanged?1:0):(Number(p.agreementRevision)||1);
    const links=deliveryLinks(p),changed=!old?.deliveryVersion||!sameRecord(links,deliveryLinks(old))||previous.accessToken!==next.accessToken;
    p.deliveryVersion=changed?(Number(old?.deliveryVersion)||Number(p.deliveryVersion)||0)+1:Number(old.deliveryVersion);
    if(changed)writes.push({path:['deliveries',key],data:{projectKey:key,version:p.deliveryVersion,links}});
  }
  for(const [key] of projectsOf(previous))if(!next.projects?.[key]||next.projects[key].deleted)writes.push({path:['deliveries',key],delete:true});
  return writes;
}
export function currentMaster(portal,records=[]) {
  return records.find(r=>r.id===portal?.masterAgreement?.version&&!r.revoked&&sameRecord(r.termsSnapshot,portal.masterAgreement));
}
export function projectAcknowledged(portal,key,master,records=[]) {
  const terms=portal?.projectTerms?.[key];if(!terms||!master)return false;
  return sameRecord(master.projectTerms?.[key],terms)||records.some(r=>r.id===portal.projects[key].ackId&&r.masterVersion===portal.masterAgreement.version&&sameRecord(r.termsSnapshot,terms));
}

export const ADMIN_UID = 'm1PGSw7ViEb1xOJoj8INQllra3p1';
export const STATUS = ['pending', 'progress', 'completed', 'delivered', 'revision'];
export const LABEL = { pending: 'Pending', progress: 'In progress', completed: 'Completed', delivered: 'Delivered', revision: 'Revision', active: 'Active', paused: 'Paused' };
export const clone = value => structuredClone(value);
export const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const text = value => String(value ?? '').trim();
export const money = value => new Intl.NumberFormat('en-BD', { style: 'currency', currency: 'BDT', maximumFractionDigits: 2 }).format(Number(value) || 0);
export const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
export const signatureImage = value => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(value)) ? value : '';
export const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2,'0')).join('');
export const itemsOf = project => (project?.items || []).filter(i => !i.deleted);
export const projectsOf = client => Object.entries(client?.projects || {}).filter(([,p]) => !p.deleted);
export const isDone = item => ['completed','delivered'].includes(item.s);
export const AGREEMENT_VERSION = 'VF-2026-09';
export const STANDARD_AGREEMENT_CLAUSES = [
  ['1. Project scope', 'Vision Flow will provide the project deliverables described in this agreement and the project particulars. Any work outside that scope requires written confirmation before work begins.'],
  ['2. Client inputs and approvals', 'The client will provide the materials, access, decisions and approvals reasonably needed for production. A delivery date may move when required inputs or approvals are delayed.'],
  ['3. Review and revisions', 'The client should review each submitted deliverable promptly and send consolidated, actionable feedback through the project workspace. Revisions that are outside the agreed scope may require a revised timeline or fee.'],
  ['4. Fees and payment', 'The agreed rate, budget and any project-specific payment arrangement are shown in the project particulars. Unless a project-specific term says otherwise, completed work and final deliverables remain subject to the agreed payment schedule.'],
  ['5. Delivery and acceptance', 'Vision Flow will provide delivery links or files through the project workspace. A deliverable is treated as accepted when the client confirms it, requests no further revision within the agreed review period, or uses it publicly.'],
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
  const populated=key=>items.some(item=>key==='dl'||key==='scriptUrl'||key==='avatarUrl'||key==='referenceUrl'?Boolean(safeUrl(item[key])):Boolean(text(item[key])));
  return [
    { key:'b', label:itemLabel, type:'text', show:showItem&&populated('b') },
    { key:'t', label:titleLabel, type:'text', show:populated('t') },
    { key:'sd', label:'Started', type:'text', show:populated('sd') },
    { key:'dd', label:'Delivered', type:'text', show:populated('dd') },
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
    projects[key].items = itemsOf(p).map(item => pick(item,['n','b','t','s','sd','dd','dur','dl','clientNote','scriptUrl','avatarUrl','referenceUrl','batch']));
    projects[key].totalItems = projects[key].items.length;
    projects[key].payments = (p.payments || []).map(payment => pick(payment,['id','date','amount','type','note','proofUrl','recordedAt']));
    projects[key].approvals = (p.approvals || []).map(approval => pick(approval,['id','title','desc','createdAt','updatedAt']));
    for (const approval of p.approvals || []) { approvalIds.push(approval.id); approvalProjects[approval.id] = key; }
  }
  const hiddenIds = new Set(Object.values(client.trash || {}).flatMap(entry => [entry.value?.id, ...(entry.records || []).map(r=>r.id)]).filter(Boolean));
  const visibleReviews = reviews => Object.fromEntries(Object.entries(reviews || {}).filter(([id])=>!hiddenIds.has(id)).map(([id,value])=>[id,clone(value)]));
  return { clientSlug:slug, name:client.name || slug, enabled:!client._deleted && client.accessEnabled !== false, projects,
    feedbackReviews:visibleReviews(client.feedbackReviews), signatureReviews:visibleReviews(client.signatureReviews),
    approvalIds, approvalProjects, lastUpdated:client.lastUpdated || new Date().toISOString(), portalVersion:4 };
}
export function agreementTerms(project) {
  return { projectName:project.name || project.slug, totalItems:itemsOf(project).length, rate:Number(project.rate)||0, budget:Number(project.budget)||0,
    scope:project.scope || '', terms:project.terms || '', deadline:project.deadline || '', weeklyTarget:Number(project.weeklyTarget)||0, milestoneText:project.milestoneText || '', agreementVersion:AGREEMENT_VERSION };
}
export function signatureOutdated(signature, project) { const signed=signature?.termsSnapshot; return Boolean(signed && Object.entries(agreementTerms(project)).some(([key,value])=>signed[key]!==value)); }
export function validateAmount(value, label = 'Amount') { const n=Number(value); if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be zero or greater.`); return n; }
export function resizeItems(project, count) {
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error('Enter between 0 and 1,000 deliverables.');
  itemsOf(project).slice(count).forEach(item => { item.deleted = true; item.deletedAt = new Date().toISOString(); });
  let number = Math.max(0,...project.items.map(i => Number(i.n)||0));
  while (itemsOf(project).length < count) project.items.push({ n:++number,b:'',t:'',s:'pending',sd:'',dd:'',dur:'',dl:'',no:'' });
  project.totalItems = count;
}

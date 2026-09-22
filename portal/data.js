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
export function metrics(project) {
  const items = itemsOf(project); const total = items.length; const done = items.filter(isDone).length;
  const paid = (project.payments || []).reduce((a,p) => a + (Number(p.amount) || 0), 0);
  const budget = Number(project.budget) || 0;
  return { total, done, paid, budget, due: budget - paid, percent: total ? Math.round(done / total * 100) : 0 };
}
export function normalizeClient(input, slug) {
  const c = clone(input || {}); c.slug = slug; c.projects ||= {}; c.trash ||= {}; c.feedbackReviews ||= {}; c.signatureReviews ||= {}; c._revision ||= 0;
  for (const [key,p] of Object.entries(c.projects)) {
    p.slug = key; p.items ||= []; p.payments ||= []; p.approvals ||= [];
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
    projects[key] = pick(p,['slug','name','rate','budget','status','createdAt','lastUpdated','scope','terms','deadline','weeklyTarget','milestoneText','sourceScriptUrl','avatarFolderUrl']);
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
    scope:project.scope || '', terms:project.terms || '', deadline:project.deadline || '', weeklyTarget:Number(project.weeklyTarget)||0, milestoneText:project.milestoneText || '' };
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

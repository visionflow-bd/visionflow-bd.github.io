const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, setLogLevel, serverTimestamp, Timestamp, writeBatch, runTransaction } = require('firebase/firestore');

const ADMIN_UID = 'm1PGSw7ViEb1xOJoj8INQllra3p1';
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const portalPath = `portal_public/${TOKEN}`;
const instant = '2026-09-22T02:00:00.000Z';
let environment;
let admin;
let visitor;

before(async () => {
  // Always a demo project and a local emulator: these tests cannot reach production.
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use npm run test:rules to start the local emulator.');
  setLogLevel('silent');
  environment = await initializeTestEnvironment({
    projectId: 'demo-visionflow-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
  admin = environment.authenticatedContext(ADMIN_UID, { email: 'shihabjessore7@gmail.com', email_verified: false }).firestore();
  visitor = environment.unauthenticatedContext().firestore();
});

after(async () => { if (environment) await environment.cleanup(); });

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'site/main'), { title: 'Vision Flow' }),
      setDoc(doc(db, 'portal_clients/client-one'), { name: 'Private client', internalNotes: 'Admin only' }),
      setDoc(doc(db, portalPath), portalFixture()),
      setDoc(doc(db, `${portalPath}/sigs/legacy-signature`), { name: 'Legacy', image: 'historic-format' }),
    ]);
  });
});

function termsSnapshot() {
  return {projectName:'Project',totalItems:1,rate:400,budget:400,scope:'',terms:'',deadline:'',weeklyTarget:0,milestoneText:'',agreementVersion:'VF-2026-09'};
}
// Deliberately independent of publicSnapshot(): rule regressions must not pass
// just because both the implementation and its fixture make the same mistake.
function portalFixture() {
  const first = termsSnapshot();
  const second = { ...first, projectName: 'Other project', rate: 500, budget: 500 };
  const project = (terms, key) => ({ name: terms.projectName, totalItems: 1, rate: terms.rate, budget: terms.budget, items: [{ n: 1, hasDelivery: true }], itemNumbers: [1], ackId: `${key}-1-1`, deliveryVersion: 1 });
  return {
    enabled: true, portalVersion: 7, name: 'Client portal',
    projects: { 'project-one': project(first, 'project-one'), 'project-two': project(second, 'project-two') },
    approvalIds: ['approval-one'], approvalProjects: { 'approval-one': 'project-one' },
    consentTerms: { version: 'VF-PORTAL-2026-09-v3', sections: [{title:'Terms',body:'Review project particulars.'}, {title:'Privacy',body:'Keep the private workspace confidential.'}] },
    masterAgreement: { version: 'VF-MASTER-2026-09-1', clientName: 'Client portal', termsVersion: 'VF-PORTAL-2026-09-v3', application: 'One master agreement across projects.', clauses: [{title:'Scope',body:'Project particulars require acknowledgement.'}] },
    projectTerms: { 'project-one': first, 'project-two': second },
  };
}
function consent(portal = portalFixture(), patch = {}) {
  return { type: 'terms-acceptance', agreedAt: serverTimestamp(), termsVersion: portal.consentTerms.version, termsSnapshot: portal.consentTerms, userAgent: 'rules-tests', ...patch };
}
function master(portal = portalFixture(), patch = {}) {
  return { name: 'Test Client', image: 'data:image/png;base64,aGVsbG8gd29ybGQ=', signedAt: serverTimestamp(), userAgent: 'rules-tests', termsSnapshot: portal.masterAgreement, projectTerms: portal.projectTerms, ...patch };
}
function acknowledgement(portal, key, patch = {}) {
  return { projectKey: key, masterVersion: portal.masterAgreement.version, termsSnapshot: portal.projectTerms[key], acknowledgedAt: serverTimestamp(), userAgent: 'rules-tests', ...patch };
}
const record = (db, kind, id) => doc(db, `${portalPath}/${kind}/${id}`);
async function guardedSubmission(kind,id,data,attachments=[]){
  const {submitReviewEvidence}=await import('../portal/review-submissions.js');
  return submitReviewEvidence({root:portalPath,collection:kind,id,data,attachments,timestamp:serverTimestamp(),transaction:fn=>runTransaction(visitor,tx=>fn({get:async p=>{const snap=await tx.get(doc(visitor,p));return snap.exists()?snap.data():null;},set:(p,d)=>tx.set(doc(visitor,p),d)}))});
}

async function attachmentFixture(id='with-files',count=1,size=40){
  const {prepareFeedbackAttachments,attachmentMeta}=await import('../portal/feedback-attachments.js');
  const attachments=await prepareFeedbackAttachments(Array.from({length:count},(_,i)=>new File(['a'.repeat(size)],`notes-${i}.txt`)),{id,collection:'confirms',projectKey:'project-one',itemNumber:1,timestamp:serverTimestamp()});
  const data={kind:'feedback',projectKey:'project-one',itemNumber:1,message:'Please revise',submittedAt:serverTimestamp(),attachments:attachments.map(attachmentMeta)};
  return {id,data,attachments};
}
test('three max-size feedback files commit atomically with guard and queue, but cannot be listed or mutated',async()=>{
  await enableEventQueue();await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  const f=await attachmentFixture('with-files',3,524288);
  await assertSucceeds(guardedSubmission('confirms',f.id,f.data,f.attachments));
  for(const a of f.attachments){
    assert.equal((await assertSucceeds(getDoc(record(visitor,'attachments',a.id)))).data().content,a.content);
    await assertFails(updateDoc(record(visitor,'attachments',a.id),{name:'changed.txt'}));
    await assertFails(deleteDoc(record(visitor,'attachments',a.id)));
  }
  await assertFails(getDocs(collection(visitor,`${portalPath}/attachments`)));
  await updateDoc(doc(admin,portalPath),{enabled:false});
  await assertFails(getDoc(record(visitor,'attachments',f.attachments[0].id)));
  await assertSucceeds(getDoc(record(admin,'attachments',f.attachments[0].id)));
});
test('feedback attachments reject orphaned uploads, dangling metadata and cross-request/source reuse',async()=>{
  const f=await attachmentFixture();
  await assertFails(setDoc(record(visitor,'attachments',f.attachments[0].id),f.attachments[0]));
  await assertFails(setDoc(record(visitor,'confirms',f.id),f.data));
  await assertSucceeds(guardedSubmission('confirms',f.id,f.data,f.attachments));
  await assertFails(setDoc(record(visitor,'confirms','borrowed'),{...f.data,submittedAt:serverTimestamp()}));
  await deleteDoc(record(admin,'confirms',f.id));
  await assertFails(getDoc(record(visitor,'attachments',f.attachments[0].id)));
  const otherToken='different-token';await setDoc(doc(admin,'portal_public',otherToken),portalFixture());
  await assertFails(getDoc(doc(visitor,'portal_public',otherToken,'attachments',f.attachments[0].id)));
});
test('raw client writes cannot bypass file bounds, immutable binding or metadata allowlists',async()=>{
  for(const patch of [{size:524289},{size:0},{content:'!bad'},{mime:'text/html'},{sha256:'bad'},{feedbackId:'other'},{itemNumber:99},{url:'https://public.invalid/file'}]){
    const f=await attachmentFixture(),batch=writeBatch(visitor),bad={...f.attachments[0],...patch};
    batch.set(record(visitor,'confirms',f.id),f.data);batch.set(record(visitor,'attachments',bad.id),bad);
    await assertFails(batch.commit());
  }
  const f=await attachmentFixture(),batch=writeBatch(visitor);
  batch.set(record(visitor,'confirms',f.id),{...f.data,attachments:[...f.data.attachments,...f.data.attachments]});
  batch.set(record(visitor,'attachments',f.attachments[0].id),f.attachments[0]);await assertFails(batch.commit());
});
async function enableEventQueue(){
  const portal={...portalFixture(),clientSlug:'client-one',reviewEpoch:0,eventQueueVersion:1};
  await setDoc(doc(admin,portalPath),portal);return portal;
}
test('recovery maintenance blocks cached admin writes and client access; only IAM owner can finish recovery',async()=>{
  await setDoc(doc(admin,'portal_settings/recovery'),{active:true,operationId:'test-recovery'});
  await assertSucceeds(getDoc(doc(admin,'portal_clients/client-one')));
  await assertSucceeds(getDoc(doc(admin,'portal_settings/recovery')));
  await assertFails(updateDoc(doc(admin,'portal_clients/client-one'),{name:'Stale admin write'}));
  await assertFails(setDoc(doc(admin,'site/main'),{title:'Stale website edit'}));
  await assertFails(updateDoc(doc(admin,'portal_settings/recovery'),{active:false}));
  await assertFails(deleteDoc(doc(admin,'portal_settings/recovery')));
  await assertFails(getDoc(doc(visitor,portalPath)));
  await assertFails(getDoc(record(visitor,'sigs','legacy-signature')));
  await assertFails(setDoc(record(visitor,'consent',portalFixture().consentTerms.version),consent()));
  await environment.withSecurityRulesDisabled(async c=>updateDoc(doc(c.firestore(),'portal_settings/recovery'),{active:false}));
  await assertSucceeds(getDoc(doc(visitor,portalPath)));
  await assertSucceeds(updateDoc(doc(admin,'portal_clients/client-one'),{name:'Resumed'}));
});
async function onboardingSubmission(kind,id,data){
  const {writeClientRecord}=await import('../portal/notification-events.js');
  return writeClientRecord({root:portalPath,collection:kind,id,data,timestamp:serverTimestamp(),transaction:fn=>runTransaction(visitor,tx=>fn({get:async p=>{const snap=await tx.get(doc(visitor,p));return snap.exists()?snap.data():null;},set:(p,d)=>tx.set(doc(visitor,p),d)}))});
}
test('queued consent is atomic and immutable; visitor cannot inspect the outbox',async()=>{
  const p=await enableEventQueue(),id=p.consentTerms.version;
  await assertFails(setDoc(record(visitor,'consent',id),consent(p)));
  await assertSucceeds(onboardingSubmission('consent',id,consent(p)));
  const eventRef=doc(admin,`portal_outbox/client:${TOKEN}:consent:${id}`),event=(await getDoc(eventRef)).data();
  assert.equal(event.eventType,'consent-complete');assert.equal(event.status,'queued');
  assert.equal(event.createdAt.toMillis(),(await getDoc(record(admin,'consent',id))).data().agreedAt.toMillis());
  await assertFails(getDoc(doc(visitor,eventRef.path)));
  await assertFails(getDocs(collection(visitor,'portal_outbox')));
  await assertFails(updateDoc(doc(visitor,eventRef.path),{status:'sent'}));
  await assertFails(deleteDoc(doc(visitor,eventRef.path)));
});
test('a retired admin save cannot downgrade the atomic event queue or publish an invalid epoch',async()=>{
  await enableEventQueue();
  await assertFails(setDoc(doc(admin,portalPath),portalFixture()));
  await assertFails(updateDoc(doc(admin,portalPath),{eventQueueVersion:0}));
  await assertFails(updateDoc(doc(admin,portalPath),{reviewEpoch:-1}));
  await assertFails(updateDoc(doc(admin,portalPath),{reviewEpoch:1.5}));
  await assertSucceeds(updateDoc(doc(admin,portalPath),{reviewEpoch:1}));
});
test('master and acknowledgement use the real atomic client helper',async()=>{
  const p=await enableEventQueue();
  await onboardingSubmission('consent',p.consentTerms.version,consent(p));
  await assertSucceeds(onboardingSubmission('agreements',p.masterAgreement.version,master(p)));
  await assertSucceeds(onboardingSubmission('acknowledgements',p.projects['project-one'].ackId,acknowledgement(p,'project-one')));
  assert.equal((await getDocs(collection(admin,'portal_outbox'))).size,3);
});
test('feedback, confirmations and objections require source + queue + existing guard atomically',async()=>{
  await enableEventQueue();await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  await assertSucceeds(guardedSubmission('feedback','new-feedback',feedback()));
  await assertSucceeds(guardedSubmission('confirms','approval-one',{projectKey:'project-one',confirmedAt:serverTimestamp(),kind:'rejection-pending',rejectReason:'Please revise the requested update.'}));
  assert.equal((await getDoc(record(admin,'review_guards','project-one'))).data().revision,2);
  const events=(await getDocs(collection(admin,'portal_outbox'))).docs.map(d=>d.data());
  assert.equal(events.length,2);assert.ok(events.every(e=>e.eventType==='objection-received'));
});
test('queued client confirmations keep the explicit action distinct from automatic decisions',async()=>{
  await enableEventQueue();
  await assertSucceeds(guardedSubmission('confirms','approval-one',{projectKey:'project-one',confirmedAt:serverTimestamp()}));
  const event=(await getDoc(doc(admin,`portal_outbox/client:${TOKEN}:confirms:approval-one`))).data();
  assert.equal(event.eventType,'confirmation-received');assert.equal(event.sourceVersion,'approval-one');
});
test('outbox injection, forged binding, recipients and arbitrary event IDs roll back evidence',async()=>{
  const p=await enableEventQueue(),id=p.consentTerms.version;
  const {clientSourceEvent}=await import('../portal/notification-events.js');
  const original=clientSourceEvent({portal:p,token:TOKEN,collection:'consent',id,data:consent(p),timestamp:serverTimestamp()});
  for(const patch of [{to:'attacker@example.invalid'},{status:'sent'},{retryCount:1},{clientSlug:'other-client'},
    {projectKey:'project-two'},{reviewEpoch:99},{sourceVersion:'other-version'},{sourceCollection:`${portalPath}/feedback`},
    {eventType:'deemed-accepted'},{portalToken:'other-token'},{createdAt:Timestamp.fromDate(new Date('2025-01-01'))}]){
    const batch=writeBatch(visitor);batch.set(record(visitor,'consent',id),consent(p));
    batch.set(doc(visitor,'portal_outbox',original.id),{...original,...patch});
    await assertFails(batch.commit());assert.equal((await getDoc(record(admin,'consent',id))).exists(),false);
  }
  const batch=writeBatch(visitor);batch.set(record(visitor,'consent',id),consent(p));
  batch.set(doc(visitor,'portal_outbox','arbitrary-id'),{...original,id:'arbitrary-id'});await assertFails(batch.commit());
});
test('existing client evidence cannot be replayed into a new event or multiple IDs',async()=>{
  const p=await enableEventQueue(),id=p.consentTerms.version;
  await onboardingSubmission('consent',id,consent(p));
  const eventId=`client:${TOKEN}:consent:${id}`,data=(await getDoc(doc(admin,'portal_outbox',eventId))).data();
  await deleteDoc(doc(admin,'portal_outbox',eventId));
  await assertFails(setDoc(doc(visitor,'portal_outbox',eventId),{...data,createdAt:serverTimestamp()}));
  await assertFails(setDoc(doc(visitor,'portal_outbox','another'),{...data,id:'another',createdAt:serverTimestamp()}));
});
test('invalid source cannot be smuggled in with a valid-looking event',async()=>{
  const p=await enableEventQueue();
  await assertFails(onboardingSubmission('consent',p.consentTerms.version,consent(p,{type:'forged'})));
  assert.equal((await getDocs(collection(admin,'portal_outbox'))).size,0);
  await updateDoc(doc(admin,portalPath),{enabled:false});
  await assert.rejects(onboardingSubmission('consent',p.consentTerms.version,consent(p)));
});
test('real server timestamps survive admin publication and resolve to the current source',async()=>{
  const {normalizeClient,prepareSecureSave,publicSnapshot}=await import('../portal/data.js');
  const {prepareNotificationSave}=await import('../portal/notification-publication.js');
  const {resolveEventSource}=await import('../backend/apps-script/source-binding.mjs');
  const next=normalizeClient({name:'Synthetic',accessToken:TOKEN,_lastMutationId:'publication-test',projects:{p:{name:'Test project',items:[]}}},'client-one');
  prepareSecureSave(next);const plan=prepareNotificationSave(next,{},{timestamp:serverTimestamp()});
  const batch=writeBatch(admin);batch.set(doc(admin,'portal_clients/client-one'),next);
  batch.set(doc(admin,portalPath),publicSnapshot(next,next.slug));
  for(const op of plan.writes)batch.set(doc(admin,op.path),op.data);
  batch.set(record(admin,'review_guards','p'),{revision:0});
  await assertSucceeds(batch.commit());
  const notice=(await getDoc(record(admin,'notices','publication-test-p'))).data();
  assert.equal(typeof notice.createdAt.toMillis,'function');
  const queued=(await getDocs(collection(admin,'portal_outbox'))).docs[0].data();
  assert.equal(queued.createdAt.toMillis(),notice.createdAt.toMillis());
  const result=await resolveEventSource(queued,{firestore:{get:async path=>(await getDoc(doc(admin,path))).data()},clock:{now:()=>new Date().toISOString()},config:{activationBoundary:'2026-01-01T00:00:00.000Z'}});
  assert.equal(result.ok,true,result.status);
});
async function seedClientReview(status='pending'){
  const portal=await enableEventQueue();portal.projects['project-one'].notificationRevision=1;
  await setDoc(doc(admin,portalPath),portal);
  const review={schemaVersion:1,requestId:'review-one',projectKey:'project-one',sourceVersion:'revision-1',projectRevision:1,reviewEpoch:0,
    policyVersion:'VF-REVIEW-72H-v1',reviewHours:72,status,revision:0,publishedAt:instant};
  await setDoc(record(admin,'reviews','review-one'),review);
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});return review;
}
const reviewResponse=(patch={})=>({projectKey:'project-one',requestId:'review-one',sourceVersion:'revision-1',confirmedAt:serverTimestamp(),userAgent:'rules-test',...patch});
test('review confirm and reject atomically update only outcome fields with matching immutable evidence',async()=>{
  for(const reject of [false,true]){
    await environment.clearFirestore();await seedClientReview('awaiting-review-notification');
    const response=reviewResponse(reject?{kind:'rejection-pending',rejectReason:'Please correct these project details.'}:{});
    await assertSucceeds(guardedSubmission('confirms','review-one',response));
    const review=(await getDoc(record(admin,'reviews','review-one'))).data();
    assert.equal(review.status,reject?'objected':'client-confirmed');assert.equal(review.revision,1);assert.equal(review.actor,'client');
    assert.equal(review.publishedAt,instant);assert.equal(review.decidedAt.toMillis(),(await getDoc(record(admin,'confirms','review-one'))).data().confirmedAt.toMillis());
    assert.equal((await getDoc(record(admin,'review_guards','project-one'))).data().revision,1);
    assert.equal((await getDocs(collection(admin,'portal_outbox'))).size,1);
  }
});
test('review response without atomic state, guard or queue is refused',async()=>{
  await seedClientReview();
  await assertFails(setDoc(record(visitor,'confirms','review-one'),reviewResponse()));
  await assertFails(updateDoc(record(visitor,'reviews','review-one'),{status:'client-confirmed',actor:'client',decidedAt:serverTimestamp(),revision:1}));
});
test('client cannot overwrite deadline or forge deemed acceptance through a response transaction',async()=>{
  const review=await seedClientReview(),portal=(await getDoc(doc(admin,portalPath))).data();
  const {clientSourceEvent}=await import('../portal/notification-events.js');
  for(const patch of [{status:'deemed-accepted'},{publishedAt:'2000-01-01T00:00:00Z'},{deadline:'tomorrow'},{revision:5},{actor:'trusted-server'},{downloadAuthorized:true}]){
    const response=reviewResponse(),event=clientSourceEvent({portal,token:TOKEN,collection:'confirms',id:'review-one',data:response,timestamp:serverTimestamp()});
    const batch=writeBatch(visitor);batch.set(record(visitor,'confirms','review-one'),response);
    batch.set(doc(visitor,'portal_outbox',event.id),event);
    batch.set(record(visitor,'review_guards','project-one'),{revision:1,lastSubmissionCollection:'confirms',lastSubmissionId:'review-one',updatedAt:serverTimestamp()});
    batch.set(record(visitor,'reviews','review-one'),{...review,status:'client-confirmed',actor:'client',decidedAt:serverTimestamp(),revision:1,...patch});
    await assertFails(batch.commit());assert.equal((await getDoc(record(admin,'confirms','review-one'))).exists(),false);
  }
});
test('superseded closed paused and cross-project review responses fail closed',async()=>{
  for(const status of ['cancelled','client-confirmed','objected','deemed-accepted']){
    await seedClientReview(status);await assert.rejects(guardedSubmission('confirms','review-one',reviewResponse()));
  }
  await seedClientReview();await assert.rejects(guardedSubmission('confirms','review-one',reviewResponse({projectKey:'project-two'})));
  await assert.rejects(guardedSubmission('confirms','review-one',reviewResponse({sourceVersion:'wrong'})));
  await updateDoc(record(admin,'reviews','review-one'),{projectRevision:0});await assert.rejects(guardedSubmission('confirms','review-one',reviewResponse()));
  await seedClientReview();await updateDoc(doc(admin,portalPath),{'projects.project-one.status':'paused'});
  await assertFails(guardedSubmission('confirms','review-one',reviewResponse()));
});
test('published project guard requires atomic feedback and works with real browser helper',async()=>{
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  await assertFails(setDoc(record(visitor,'confirms','f1'),feedback()));
  await assertSucceeds(guardedSubmission('confirms','f1',feedback()));
  const guard=(await getDoc(record(visitor,'review_guards','project-one'))).data();
  assert.equal(guard.revision,1);assert.equal(guard.lastSubmissionId,'f1');
  await assert.rejects(guardedSubmission('confirms','f1',feedback()),/already recorded/);
  assert.equal((await getDoc(record(visitor,'review_guards','project-one'))).data().revision,1);
});
test('legacy feedback collection also cannot bypass a published guard',async()=>{
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  await assertFails(setDoc(record(visitor,'feedback','f1'),feedback()));
  await assertSucceeds(guardedSubmission('feedback','f1',feedback()));
});
test('confirmation and rejection touch the same guard as timer transactions',async()=>{
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  const decision={projectKey:'project-one',confirmedAt:serverTimestamp(),userAgent:'rules-tests',kind:'rejection-pending',rejectReason:'Please correct this item.'};
  await assertFails(setDoc(record(visitor,'confirms','approval-one'),decision));
  await assertSucceeds(guardedSubmission('confirms','approval-one',decision));
  assert.equal((await getDoc(record(visitor,'review_guards','project-one'))).data().revision,1);
});
test('clients cannot create delete or forge/replay a guard update',async()=>{
  const ref=record(visitor,'review_guards','project-one');
  await assertFails(setDoc(ref,{revision:0}));
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  await assertFails(deleteDoc(ref));
  await assertFails(setDoc(ref,{revision:1,lastSubmissionId:'missing',lastSubmissionCollection:'confirms',updatedAt:serverTimestamp()}));
  await assertSucceeds(guardedSubmission('confirms','f1',feedback()));
  await assertFails(setDoc(ref,{revision:2,lastSubmissionId:'f1',lastSubmissionCollection:'confirms',updatedAt:serverTimestamp()}));
});
test('guard refuses cross-project evidence and skipped revisions atomically',async()=>{
  await setDoc(record(admin,'review_guards','project-one'),{revision:0});
  for(const patch of [{revision:2},{lastSubmissionId:'other'},{lastSubmissionCollection:'agreements'}]){
    const batch=writeBatch(visitor);
    batch.set(record(visitor,'confirms','f1'),feedback());
    batch.set(record(visitor,'review_guards','project-one'),{revision:1,lastSubmissionId:'f1',lastSubmissionCollection:'confirms',updatedAt:serverTimestamp(),...patch});
    await assertFails(batch.commit());
    assert.equal((await getDoc(record(visitor,'confirms','f1'))).exists(),false);
  }
  const batch=writeBatch(visitor);
  batch.set(record(visitor,'confirms','f1'),feedback({projectKey:'project-two'}));
  batch.set(record(visitor,'review_guards','project-one'),{revision:1,lastSubmissionId:'f1',lastSubmissionCollection:'confirms',updatedAt:serverTimestamp()});
  await assertFails(batch.commit());
});
test('browser helper preserves old projects without retroactively enabling review guards',async()=>{
  await assertSucceeds(guardedSubmission('confirms','f1',feedback()));
  assert.equal((await getDoc(record(visitor,'review_guards','project-one'))).exists(),false);
});
test('published review outcomes and notices are readable but clients cannot forge them',async()=>{
  for(const kind of ['reviews','notices']){
    const ref=record(visitor,kind,'r1');
    await assertFails(setDoc(ref,{projectKey:'project-one',status:'deemed-accepted'}));
    await assertSucceeds(setDoc(record(admin,kind,'r1'),{projectKey:'project-one',status:'pending'}));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(getDocs(collection(visitor,`${portalPath}/${kind}`)));
    await assertFails(updateDoc(ref,{status:'deemed-accepted'}));await assertFails(deleteDoc(ref));
  }
  await updateDoc(doc(admin,portalPath),{enabled:false});
  await assertFails(getDoc(record(visitor,'reviews','r1')));
  await assertFails(getDoc(record(visitor,'notices','r1')));
});
async function acceptTerms(portal = portalFixture()) {
  await assertSucceeds(setDoc(record(visitor, 'consent', portal.consentTerms.version), consent(portal)));
}
async function signMaster(portal = portalFixture()) {
  await acceptTerms(portal);
  await assertSucceeds(setDoc(record(visitor, 'agreements', portal.masterAgreement.version), master(portal)));
}
// Per-item access records. approvalId '' = published before delivery
// verification existed, so only the agreement gate applies.
function access(key, patch = {}) {
  return { projectKey: key, itemNumber: 1, link: `https://drive.google.com/file/d/test-${key}/view`, approvalId: '', releaseAtMs: 253402300799000, released: false, ...patch };
}
async function seedDeliveries(portal = portalFixture()) {
  for (const key of Object.keys(portal.projects)) {
    await assertSucceeds(setDoc(record(admin, 'deliveries', key), access(key)));
  }
}
function signature(id = 'signature-one', patch = {}) {
  return { id, projectKey: 'project-one', name: 'Test Client', image: 'data:image/png;base64,aGVsbG8gd29ybGQ=', signedAt: serverTimestamp(), userAgent: 'rules-tests', termsSnapshot:termsSnapshot(), ...patch };
}
function feedback(patch = {}) {
  return { kind: 'feedback', requestType: 'revision', projectKey: 'project-one', itemNumber: 1, message: 'Please revise this scene.', submittedAt: serverTimestamp(), userAgent: 'rules-tests', ...patch };
}
function confirmation(patch = {}) {
  return { projectKey: 'project-one', confirmedAt: serverTimestamp(), userAgent: 'rules-tests', ...patch };
}

test('UID-pinned owner can manage all data despite unverified email', async () => {
  await assertSucceeds(getDocs(collection(admin, 'portal_clients')));
  await assertSucceeds(getDocs(collection(admin, 'portal_public')));
  await assertSucceeds(setDoc(doc(admin, 'portal_clients/new-client'), { internal: true }));
  await assertSucceeds(updateDoc(doc(admin, `${portalPath}/sigs/legacy-signature`), { name: 'Corrected' }));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/sigs/legacy-signature`)));
  await assertSucceeds(setDoc(doc(admin, `${portalPath}/confirms/admin-record`), { corrected: true }));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/confirms/admin-record`)));
});

test('matching email on a different UID cannot acquire owner access', async () => {
  const impostor = environment.authenticatedContext('another-uid', { email: 'shihabjessore7@gmail.com', email_verified: true }).firestore();
  await assertFails(getDocs(collection(impostor, 'portal_clients')));
  await assertFails(setDoc(doc(impostor, 'site/main'), { altered: true }));
  await assertFails(deleteDoc(doc(impostor, portalPath)));
});

test('public can open one token, but cannot enumerate tokens or private records', async () => {
  await assertSucceeds(getDoc(doc(visitor, portalPath)));
  await assertSucceeds(getDocs(collection(visitor, `${portalPath}/sigs`)));
  await assertFails(getDocs(collection(visitor, 'portal_public')));
  await assertFails(getDoc(doc(visitor, 'portal_clients/client-one')));
  await assertFails(getDocs(collection(visitor, 'portal_clients')));
  await assertFails(updateDoc(doc(visitor, portalPath), { name: 'Tampered' }));
});

test('valid new client signature is readable but cannot be overwritten or deleted', async () => {
  const ref = doc(visitor, `${portalPath}/sigs/signature-one`);
  await assertSucceeds(setDoc(ref, signature()));
  await assertSucceeds(getDoc(ref));
  await assertFails(updateDoc(ref, { name: 'Changed by client' }));
  await assertFails(setDoc(ref, signature('signature-one', { name: 'Overwrite' })));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/sigs/signature-one`)));
});

test('reject malformed signatures, unknown projects and injected admin fields', async () => {
  const cases = [
    { id: 'wrong-id' }, { projectKey: 'missing' }, { name: '' }, { name: 'x'.repeat(201) },
    { image: 'https://attacker.invalid/x.png' }, { image: 'data:image/png;base64,' + 'A'.repeat(500000) },
    { signedAt: 'yesterday' }, { userAgent: 'x'.repeat(2049) }, { verified: true },
  ];
  for (let index = 0; index < cases.length; index++) {
    const id = `invalid-${index}`;
    await assertFails(setDoc(doc(visitor, `${portalPath}/sigs/${id}`), signature(id, cases[index])));
  }
});

test('captured terms must match the project; new schema needs no redundant ID', async () => {
  const termsSnapshot={projectName:'Project',totalItems:1,rate:400,budget:400,scope:'',terms:'',deadline:'',weeklyTarget:0,milestoneText:'',agreementVersion:'VF-2026-09'};
  const data=signature('captured',{termsSnapshot});delete data.id;
  await assertSucceeds(setDoc(doc(visitor,`${portalPath}/sigs/captured`),data));
  await assertFails(setDoc(doc(visitor,`${portalPath}/sigs/forged`),{...data,termsSnapshot:{...termsSnapshot,budget:0}}));
  await assertSucceeds(setDoc(doc(visitor,`${portalPath}/sigs/cached-legacy-hash`),{...data,termsDigest:'a'.repeat(64)}));
  await assertFails(setDoc(doc(visitor,`${portalPath}/sigs/malformed-legacy-hash`),{...data,termsDigest:'wrong'}));
  const legacy=signature('legacy-new');delete legacy.termsSnapshot;
  await assertFails(setDoc(doc(visitor,`${portalPath}/sigs/legacy-new`),legacy));
});

test('project-by-project signing uses the published deterministic signature route', async () => {
  const portal = portalFixture();
  portal.agreementMode = 'project';
  portal.projects['project-one'].signatureRequired = true;
  portal.projects['project-one'].signatureId = 'project-project-one-1-1-1';
  await setDoc(doc(admin, portalPath), portal);
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'project-one'), access('project-one')));
  await acceptTerms(portal);
  const expected = signature(portal.projects['project-one'].signatureId);
  await assertSucceeds(setDoc(record(visitor, 'sigs', portal.projects['project-one'].signatureId), expected));
  await assertFails(setDoc(record(visitor, 'sigs', 'random-project-signature'), expected));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
});

test('queued project signatures and notifications are atomic and cannot invent a review policy',async()=>{
  const p=await enableEventQueue();p.agreementMode='project';p.projects['project-one'].signatureId='project-project-one-1-1-1';
  p.masterAgreement.reviewPolicy={version:'VF-REVIEW-72H-v1',hours:72,outcome:'deemed-accepted'};
  await setDoc(doc(admin,portalPath),p);await onboardingSubmission('consent',p.consentTerms.version,consent(p));
  const id=p.projects['project-one'].signatureId,data={...signature(id),reviewPolicy:p.masterAgreement.reviewPolicy};
  await assertFails(setDoc(record(visitor,'sigs',id),data));
  await assertFails(onboardingSubmission('sigs',id,{...data,reviewPolicy:{...data.reviewPolicy,hours:48}}));
  await assertSucceeds(onboardingSubmission('sigs',id,data));
  const queued=await getDocs(collection(admin,'portal_outbox'));assert.ok(queued.docs.some(d=>d.data().eventType==='project-signed'));
});

test('project and item feedback can be created, and only admin can edit/delete', async () => {
  await assertSucceeds(setDoc(doc(visitor, `${portalPath}/confirms/item-feedback`), feedback()));
  await assertSucceeds(setDoc(doc(visitor, `${portalPath}/confirms/project-feedback`), feedback({ itemNumber: 0, requestType: 'question' })));
  await assertFails(updateDoc(doc(visitor, `${portalPath}/confirms/item-feedback`), { message: 'Edited' }));
  await assertFails(deleteDoc(doc(visitor, `${portalPath}/confirms/item-feedback`)));
  await assertSucceeds(updateDoc(doc(admin, `${portalPath}/confirms/item-feedback`), { message: 'Admin correction' }));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/confirms/item-feedback`)));
});

test('feedback schema rejects invalid target, empty/oversized text and admin review injection', async () => {
  const cases = [{ projectKey: 'unknown' }, { message: '' }, { message: 'x'.repeat(4001) }, { itemNumber: -1 }, { itemNumber: 1.5 }, { itemNumber: 2 }, { requestType: 'admin' }, { status: 'resolved' }, { response: 'spoofed' }, { submittedAt: 'invalid' }];
  for (let index = 0; index < cases.length; index++) {
    await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/bad-feedback-${index}`), feedback(cases[index])));
  }
});

test('known approval can be confirmed once; reset/delete remain admin-controlled', async () => {
  const ref = doc(visitor, `${portalPath}/confirms/approval-one`);
  await assertSucceeds(setDoc(ref, confirmation()));
  await assertFails(setDoc(ref, confirmation()));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/confirms/approval-one`)));
  await assertSucceeds(setDoc(ref, confirmation()));
});

test('approval confirmation rejects arbitrary IDs, wrong projects and invalid payload', async () => {
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/unknown-approval`), confirmation()));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ projectKey: 'project-two' })));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ confirmedAt: '' })));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ approvedByAdmin: true })));
});

test('a client can submit a reasoned rejection but cannot auto-verify or finalise a rejection', async () => {
  await assertSucceeds(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ kind: 'rejection-pending', rejectReason: 'The date and scope need to be corrected before I can approve.' })));
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), portalPath), portalFixture());
  });
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ kind: 'auto' })));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ kind: 'rejected', rejectReason: 'I am trying to finalise this.' })));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation({ kind: 'rejection-pending', rejectReason: 'short' })));
});

test('private notification settings are administrator-only', async () => {
  const settings=doc(admin,'portal_settings/notifications');
  await assertSucceeds(setDoc(settings,{enabled:false,clientWebhookUrl:'',updatedAt:instant}));
  await assertSucceeds(getDoc(settings));
  await assertFails(getDoc(doc(visitor,'portal_settings/notifications')));
  await assertFails(setDoc(doc(visitor,'portal_settings/notifications'),{enabled:true,clientWebhookUrl:'https://attacker.invalid'}));
});

test('recycle-bin archive payloads are visible only to the administrator', async () => {
  const path='portal_archives/client-one/entries/trash-one/records/record-one';
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(),path),{recordCollection:'sigs',recordId:'signature-one',payload:{name:'Private signer'}});
  });
  await assertFails(getDoc(doc(visitor,path)));
  await assertFails(getDocs(collection(visitor,'portal_archives/client-one/entries/trash-one/records')));
  await assertSucceeds(getDoc(doc(admin,path)));
  await assertSucceeds(deleteDoc(doc(admin,path)));
});

test('legacy schema data remains readable and legacy feedback remains manageable', async () => {
  await assertSucceeds(getDoc(doc(visitor, `${portalPath}/sigs/legacy-signature`)));
  const legacyFeedback = feedback();
  delete legacyFeedback.kind;
  delete legacyFeedback.requestType;
  await assertSucceeds(setDoc(doc(visitor, `${portalPath}/feedback/legacy-feedback`), legacyFeedback));
  await assertSucceeds(getDocs(collection(visitor, `${portalPath}/feedback`)));
  await assertFails(deleteDoc(doc(visitor, `${portalPath}/feedback/legacy-feedback`)));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/feedback/legacy-feedback`)));
  const legacyApproval = confirmation();
  delete legacyApproval.projectKey;
  await assertSucceeds(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), legacyApproval));
});

test('disabled link denies parent and all subcollection access, owner retains management', async () => {
  await updateDoc(doc(admin, portalPath), { enabled: false });
  await assertFails(getDoc(doc(visitor, portalPath)));
  for (const path of ['sigs', 'confirms', 'feedback', 'consent', 'agreements', 'acknowledgements']) {
    await assertFails(getDocs(collection(visitor, `${portalPath}/${path}`)));
    await assertSucceeds(getDocs(collection(admin, `${portalPath}/${path}`)));
  }
  await assertFails(setDoc(doc(visitor, `${portalPath}/sigs/signature-one`), signature()));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/new-feedback`), feedback()));
  await assertFails(setDoc(doc(visitor, `${portalPath}/confirms/approval-one`), confirmation()));
});

test('deleted parent denies orphan signature reads and creation', async () => {
  await deleteDoc(doc(admin, portalPath));
  await assertFails(getDoc(doc(visitor, `${portalPath}/sigs/legacy-signature`)));
  await assertFails(getDocs(collection(visitor, `${portalPath}/sigs`)));
  await assertFails(setDoc(doc(visitor, `${portalPath}/sigs/signature-one`), signature()));
  await assertSucceeds(deleteDoc(doc(admin, `${portalPath}/sigs/legacy-signature`)));
});

test('website public content and contact submission work without revealing leads', async () => {
  await assertSucceeds(getDoc(doc(visitor, 'site/main')));
  await assertFails(setDoc(doc(visitor, 'site/main'), { altered: true }));
  const lead = { id: 'lead-one', name: 'Visitor', email: 'visitor@example.invalid', phone: '', interest: 'Video', message: 'Contact me', source: 'Agency', createdAt: Date.now(), status: 'new' };
  await assertSucceeds(setDoc(doc(visitor, 'leads/lead-one'), lead));
  await assertFails(getDoc(doc(visitor, 'leads/lead-one')));
  await assertFails(getDocs(collection(visitor, 'leads')));
  await assertFails(setDoc(doc(visitor, 'leads/bad-lead'), { ...lead, status: 'approved' }));
  await assertFails(setDoc(doc(visitor, 'leads/oversized-lead'), { ...lead, message: 'x'.repeat(3001) }));
  await assertSucceeds(getDoc(doc(admin, 'leads/lead-one')));
  await assertSucceeds(updateDoc(doc(admin, 'leads/lead-one'), { status: 'contacted' }));
  await assertSucceeds(deleteDoc(doc(admin, 'leads/lead-one')));
});

test('unmatched collections deny access', async () => {
  await assertFails(getDocs(collection(visitor, 'arbitrary')));
  await assertFails(setDoc(doc(visitor, 'arbitrary/document'), { payload: true }));
});

test('retired admin tabs cannot republish unsafe legacy snapshots', async () => {
  await assertFails(setDoc(doc(admin,portalPath),{name:'Unsafe old snapshot',projects:{},portalVersion:3}));
});

// ── Server-enforced consent, master agreement and project acknowledgement ──

test('unsigned delivery denied; a legacy project signature cannot substitute for the master', async () => {
  await seedDeliveries();
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(setDoc(record(visitor, 'sigs', 'signature-one'), signature()));
  await acceptTerms();
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
});

test('one real master captures two project particulars and permits each current manifest', async () => {
  await seedDeliveries();
  await signMaster();
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-two')));
  const agreements = await assertSucceeds(getDocs(collection(visitor, `${portalPath}/agreements`)));
  assert.equal(agreements.size, 1);
  assert.equal((await getDocs(collection(visitor, `${portalPath}/acknowledgements`))).size, 0);
});

test('new project needs only its exact acknowledgement, not another master signature', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  portal.projects['project-three'] = { ...portal.projects['project-two'], name: 'New project', ackId: 'project-three-1-1' };
  portal.projectTerms['project-three'] = { ...portal.projectTerms['project-two'], projectName: 'New project' };
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await seedDeliveries(portal);
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-three')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(setDoc(record(visitor, 'acknowledgements', portal.projects['project-three'].ackId), acknowledgement(portal, 'project-three')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-three')));
  assert.equal((await getDocs(collection(visitor, `${portalPath}/agreements`))).size, 1);
});

test('material changes invalidate old particulars and require a fresh immutable acknowledgement', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  portal.projects['project-one'].budget = 800;
  portal.projects['project-one'].ackId = 'project-one-2-1';
  portal.projectTerms['project-one'].budget = 800;
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-two')));
  const ref = record(visitor, 'acknowledgements', portal.projects['project-one'].ackId);
  await assertFails(setDoc(ref, acknowledgement(portal, 'project-one', { termsSnapshot: termsSnapshot() })));
  await assertSucceeds(setDoc(ref, acknowledgement(portal, 'project-one')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertFails(updateDoc(ref, { userAgent: 'changed' }));
  await assertFails(deleteDoc(ref));
  await assertFails(setDoc(ref, acknowledgement(portal, 'project-one')));
  portal.projects['project-one'].budget = 900;
  portal.projects['project-one'].ackId = 'project-one-3-1';
  portal.projectTerms['project-one'].budget = 900;
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(setDoc(record(visitor, 'acknowledgements', portal.projects['project-one'].ackId), acknowledgement(portal, 'project-one')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  assert.equal((await getDocs(collection(visitor, `${portalPath}/agreements`))).size, 1);
});

test('acknowledgements reject missing master, wrong ID/project/version, forged terms and timestamps', async () => {
  const portal = portalFixture();
  const ref = record(visitor, 'acknowledgements', portal.projects['project-one'].ackId);
  await assertFails(setDoc(ref, acknowledgement(portal, 'project-one')));
  await signMaster();
  await assertFails(setDoc(record(visitor, 'acknowledgements', 'wrong-id'), acknowledgement(portal, 'project-one')));
  for (const patch of [
    { projectKey: 'missing' }, { projectKey: 'project-two' }, { masterVersion: 'old-master' },
    { termsSnapshot: { ...termsSnapshot(), budget: 0 } }, { acknowledgedAt: Timestamp.fromDate(new Date(instant)) },
    { acknowledgedAt: 'yesterday' }, { userAgent: 'x'.repeat(2049) }, { approved: true },
  ]) await assertFails(setDoc(ref, acknowledgement(portal, 'project-one', patch)));
  await assertSucceeds(setDoc(ref, acknowledgement(portal, 'project-one')));
});

test('master creation requires exact current consent; local flags and arbitrary consent IDs do not count', async () => {
  const portal = portalFixture();
  const ref = record(visitor, 'agreements', portal.masterAgreement.version);
  await assertFails(setDoc(ref, master(portal)));
  await assertSucceeds(setDoc(record(admin, 'consent', 'unrelated-consent'), consent(portal)));
  await assertFails(setDoc(ref, master(portal)));
  await assertFails(updateDoc(doc(visitor, portalPath), { masterSignatureComplete: true }));
  await assertFails(updateDoc(doc(admin, portalPath), { masterSignatureComplete: true }));
  await acceptTerms();
  await assertSucceeds(setDoc(ref, master(portal)));
});

test('master rejects malformed evidence, altered/missing project terms and spoofed timestamps', async () => {
  const portal = portalFixture();
  await acceptTerms();
  const ref = record(visitor, 'agreements', portal.masterAgreement.version);
  await assertFails(setDoc(record(visitor, 'agreements', 'wrong-version'), master(portal)));
  for (const patch of [
    { name: '' }, { name: 'x'.repeat(201) }, { image: 'https://example.invalid/signature.png' },
    { image: 'data:image/png;base64,' + 'A'.repeat(500000) },
    { termsSnapshot: { ...portal.masterAgreement, clientName: 'Someone else' } },
    { projectTerms: {} }, { projectTerms: { 'project-one': termsSnapshot() } },
    { projectTerms: { ...portal.projectTerms, 'project-one': { ...termsSnapshot(), budget: 0 } } },
    { signedAt: Timestamp.fromDate(new Date(instant)) }, { signedAt: Timestamp.fromMillis(Date.now() + 86400000) },
    { userAgent: 'x'.repeat(2049) }, { revoked: false }, { administratorApproved: true },
  ]) await assertFails(setDoc(ref, master(portal, patch)));
  const missing = master(portal); delete missing.image;
  await assertFails(setDoc(ref, missing));
  await assertSucceeds(setDoc(ref, master(portal)));
});

test('master signature is immutable for client; administrator revocation denies deliveries', async () => {
  const portal = portalFixture();
  await seedDeliveries();
  await signMaster();
  const ref = record(visitor, 'agreements', portal.masterAgreement.version);
  await assertFails(updateDoc(ref, { name: 'Replacement' }));
  await assertFails(setDoc(ref, master(portal)));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(updateDoc(record(admin, 'agreements', portal.masterAgreement.version), { revoked: true }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-two')));
  await assertFails(setDoc(record(visitor, 'acknowledgements', portal.projects['project-one'].ackId), acknowledgement(portal, 'project-one')));
});

test('new master version invalidates older master and cannot reuse its acknowledgements', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  portal.masterAgreement.version = 'VF-MASTER-2026-09-2';
  for (const [key, project] of Object.entries(portal.projects)) project.ackId = `${key}-1-2`;
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(setDoc(record(visitor, 'agreements', portal.masterAgreement.version), master(portal)));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  assert.equal((await getDocs(collection(visitor, `${portalPath}/agreements`))).size, 2);
});

test('legacy all-links manifests, wrong project binding and removed projects deny delivery access', async () => {
  await seedDeliveries();
  await signMaster();
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'legacy'), { projectKey: 'project-one', version: 1, links: { 1: 'https://example.invalid/all-links' } }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'legacy')));
  await assertSucceeds(updateDoc(record(admin, 'deliveries', 'project-one'), { projectKey: 'missing-project' }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(updateDoc(record(admin, 'deliveries', 'project-one'), { projectKey: 'project-one' }));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  const portal = portalFixture();
  delete portal.projects['project-one']; delete portal.projectTerms['project-one'];
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(getDoc(record(admin, 'deliveries', 'project-one')));
});

function receipt(patch = {}) {
  return { projectKey: 'project-one', itemNumber: 1, receivedAt: serverTimestamp(), userAgent: 'rules-tests', ...patch };
}
test('RT-01: a signed client cannot read a file link until THIS item is received, confirmed, released or past 72h', async () => {
  await signMaster();
  const id = 'project-one~1', future = Date.now() + 72 * 3600000;
  await assertSucceeds(setDoc(record(admin, 'deliveries', id), access('project-one', { approvalId: 'approval-one', releaseAtMs: future })));
  await assertFails(getDoc(record(visitor, 'deliveries', id)));
  await assertSucceeds(setDoc(record(visitor, 'receipts', 'approval-one'), receipt()));
  const opened = await assertSucceeds(getDoc(record(visitor, 'deliveries', id)));
  assert.equal(opened.data().link, 'https://drive.google.com/file/d/test-project-one/view');
  await assertFails(setDoc(record(visitor, 'receipts', 'approval-one'), receipt({ userAgent: 'rewritten' })));
  await assertFails(deleteDoc(record(visitor, 'receipts', 'approval-one')));
  await assertSucceeds(setDoc(record(admin, 'confirms', 'approval-one'), { projectKey: 'project-one', confirmedAt: new Date(), kind: 'rejection-pending', rejectReason: 'The colour grade is wrong.' }));
  await assertFails(getDoc(record(visitor, 'deliveries', id)), 'a reported problem locks the file again');
  await assertSucceeds(updateDoc(record(admin, 'deliveries', id), { released: true }));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', id)), 'an administrator closure releases it');
});

test('RT-01: explicit confirmation or an elapsed 72h window releases only that item', async () => {
  await signMaster();
  const future = Date.now() + 72 * 3600000;
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'project-one~1'), access('project-one', { approvalId: 'approval-one', releaseAtMs: future })));
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'project-one~2'), access('project-one', { itemNumber: 2, approvalId: 'approval-two', releaseAtMs: future })));
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'project-one~3'), access('project-one', { itemNumber: 3, approvalId: 'approval-three', releaseAtMs: Date.now() - 3600000 })));
  await assertSucceeds(setDoc(record(admin, 'confirms', 'approval-one'), { projectKey: 'project-one', confirmedAt: new Date() }));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one~1')));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one~2')));
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one~3')));
  await assertSucceeds(setDoc(record(admin, 'confirms', 'approval-two'), { projectKey: 'project-one', confirmedAt: new Date(), kind: 'rejected', rejectReason: 'Confirmed rejection.' }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one~2')));
});

test('receipts require the agreement, a published approval of that project and server time', async () => {
  await assertFails(setDoc(record(visitor, 'receipts', 'approval-one'), receipt()), 'no receipt before the agreement');
  await signMaster();
  await assertFails(setDoc(record(visitor, 'receipts', 'unknown-approval'), receipt()));
  await assertFails(setDoc(record(visitor, 'receipts', 'approval-one'), receipt({ projectKey: 'project-two' })));
  await assertFails(setDoc(record(visitor, 'receipts', 'approval-one'), receipt({ receivedAt: new Date('2026-01-01T00:00:00Z') })));
  await assertFails(setDoc(record(visitor, 'receipts', 'approval-one'), receipt({ note: 'extra field' })));
  await assertSucceeds(setDoc(record(visitor, 'receipts', 'approval-one'), receipt()));
  await assertSucceeds(getDoc(record(visitor, 'receipts', 'approval-one')));
});

test('delivery enumeration and all client writes remain denied even after valid signing', async () => {
  await seedDeliveries();
  await assertFails(getDocs(collection(visitor, `${portalPath}/deliveries`)));
  await signMaster();
  await assertFails(getDocs(collection(visitor, `${portalPath}/deliveries`)));
  await assertFails(setDoc(record(visitor, 'deliveries', 'project-one'), { projectKey: 'project-one', version: 1, links: { 1: 'https://attacker.invalid' } }));
  await assertFails(updateDoc(record(visitor, 'deliveries', 'project-one'), { version: 500 }));
  await assertFails(deleteDoc(record(visitor, 'deliveries', 'project-one')));
  await assertSucceeds(getDocs(collection(admin, `${portalPath}/deliveries`)));
  await assertSucceeds(setDoc(record(admin, 'deliveries', 'project-one-1'), { projectKey: 'project-one', itemNumber: 1, dl: 'https://example.invalid/legacy' }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one-1')));
  await assertSucceeds(deleteDoc(record(admin, 'deliveries', 'project-one-1')));
});

test('terms consent stores the exact published snapshot at server time and is immutable', async () => {
  const portal = portalFixture();
  const ref = record(visitor, 'consent', portal.consentTerms.version);
  await assertSucceeds(setDoc(ref, consent(portal)));
  const saved = await assertSucceeds(getDoc(ref));
  assert.deepEqual(saved.data().termsSnapshot, portal.consentTerms);
  assert.ok(saved.data().agreedAt instanceof Timestamp);
  await assertFails(updateDoc(ref, { termsVersion: 'tampered' }));
  await assertFails(setDoc(ref, consent(portal)));
  await assertFails(deleteDoc(ref));
  await assertSucceeds(deleteDoc(record(admin, 'consent', portal.consentTerms.version)));
});

test('consent rejects arbitrary IDs, incomplete or forged snapshots, versions, fields and timestamps', async () => {
  const portal = portalFixture();
  const ref = record(visitor, 'consent', portal.consentTerms.version);
  await assertFails(setDoc(record(visitor, 'consent', 'arbitrary-id'), consent(portal)));
  for (const patch of [
    { type: 'privacy-policy' }, { type: 'admin-override' }, { termsVersion: 'old-version' },
    { termsSnapshot: { version: portal.consentTerms.version } },
    { termsSnapshot: { ...portal.consentTerms, sections: [] } },
    { agreedAt: Timestamp.fromDate(new Date(instant)) }, { agreedAt: Timestamp.fromMillis(Date.now() + 86400000) },
    { agreedAt: 'yesterday' }, { userAgent: 'x'.repeat(2049) }, { masterSignatureComplete: true },
  ]) await assertFails(setDoc(ref, consent(portal, patch)));
  for (const key of ['type', 'agreedAt', 'termsVersion', 'termsSnapshot', 'userAgent']) {
    const payload = consent(portal); delete payload[key];
    await assertFails(setDoc(ref, payload));
  }
  await assertSucceeds(setDoc(ref, consent(portal)));
});

test('refreshed consent version blocks old access until exact current consent is accepted', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  portal.consentTerms = { version: 'VF-PORTAL-2026-09-v4', sections: [{title:'Privacy',body:'Updated published privacy statement.'}] };
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertFails(setDoc(record(visitor, 'consent', portal.consentTerms.version), consent(portalFixture())));
  await acceptTerms(portal);
  await assertSucceeds(getDoc(record(visitor, 'deliveries', 'project-one')));
  assert.equal((await getDocs(collection(visitor, `${portalPath}/agreements`))).size, 1);
});

test('same consent version with altered text does not falsely accept the old stored snapshot', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  portal.consentTerms.sections.push({title:'New clause',body:'Material new text must not reuse a consent version.'});
  await assertSucceeds(setDoc(doc(admin, portalPath), portal));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  // Version reuse fails closed; the publisher must issue a new consent version.
  await assertFails(setDoc(record(visitor, 'consent', portal.consentTerms.version), consent(portal)));
});

test('disabled or deleted portal blocks signed download and all new onboarding records', async () => {
  await seedDeliveries();
  await signMaster();
  const portal = portalFixture();
  await assertSucceeds(updateDoc(doc(admin, portalPath), { enabled: false }));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertFails(getDoc(record(visitor, 'agreements', portal.masterAgreement.version)));
  await assertFails(setDoc(record(visitor, 'acknowledgements', portal.projects['project-one'].ackId), acknowledgement(portal, 'project-one')));
  await assertSucceeds(getDoc(record(admin, 'agreements', portal.masterAgreement.version)));
  await assertSucceeds(deleteDoc(doc(admin, portalPath)));
  await assertFails(getDoc(record(visitor, 'deliveries', 'project-one')));
  await assertFails(getDoc(record(visitor, 'consent', portal.consentTerms.version)));
  await assertSucceeds(getDoc(record(admin, 'deliveries', 'project-one')));
});

test('retired v5 and v6 admin tabs cannot write or expose old unsafe snapshots', async () => {
  for (const version of [5, 6]) {
    const portal = portalFixture(); portal.portalVersion = version;
    portal.projects['project-one'].items[0].dl = 'https://example.invalid/secret';
    await assertFails(setDoc(doc(admin, portalPath), portal));
    const stalePath = `portal_public/stale-v${version}`;
    await environment.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), stalePath), portal));
    await assertFails(getDoc(doc(visitor, stalePath)));
    await assertFails(setDoc(doc(visitor, `${stalePath}/consent/${portal.consentTerms.version}`), consent(portal)));
    await assertFails(setDoc(doc(visitor, `${stalePath}/sigs/signature-one`), signature()));
    await assertSucceeds(getDoc(doc(admin, stalePath)));
  }
  await assertSucceeds(setDoc(doc(admin, portalPath), portalFixture()));
  await assertSucceeds(getDoc(doc(visitor, portalPath)));
});

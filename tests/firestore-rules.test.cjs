const { before, after, beforeEach, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, setLogLevel } = require('firebase/firestore');

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
      setDoc(doc(db, portalPath), {
        enabled: true,
        portalVersion: 4,
        name: 'Client portal',
        projects: { 'project-one': { name: 'Project', totalItems:1, rate:400, budget:400, items: [{ n: 1 }], approvals: [{ id: 'approval-one' }] }, 'project-two': { name: 'Other project' } },
        approvalIds: ['approval-one'],
        approvalProjects: { 'approval-one': 'project-one' },
      }),
      setDoc(doc(db, `${portalPath}/sigs/legacy-signature`), { name: 'Legacy', image: 'historic-format' }),
    ]);
  });
});

function signature(id = 'signature-one', patch = {}) {
  return { id, projectKey: 'project-one', name: 'Test Client', image: 'data:image/png;base64,aGVsbG8gd29ybGQ=', signedAt: instant, userAgent: 'rules-tests', ...patch };
}
function feedback(patch = {}) {
  return { kind: 'feedback', requestType: 'revision', projectKey: 'project-one', itemNumber: 1, message: 'Please revise this scene.', submittedAt: instant, userAgent: 'rules-tests', ...patch };
}
function confirmation(patch = {}) {
  return { projectKey: 'project-one', confirmedAt: instant, userAgent: 'rules-tests', ...patch };
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
  const data=signature('captured',{termsSnapshot,termsDigest:'a'.repeat(64)});delete data.id;
  await assertSucceeds(setDoc(doc(visitor,`${portalPath}/sigs/captured`),data));
  await assertFails(setDoc(doc(visitor,`${portalPath}/sigs/forged`),{...data,termsSnapshot:{...termsSnapshot,budget:0}}));
  await assertFails(setDoc(doc(visitor,`${portalPath}/sigs/invalid-digest`),{...data,termsDigest:'wrong'}));
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
  const cases = [{ projectKey: 'unknown' }, { message: '' }, { message: 'x'.repeat(4001) }, { itemNumber: -1 }, { itemNumber: 1.5 }, { requestType: 'admin' }, { status: 'resolved' }, { response: 'spoofed' }, { submittedAt: 'invalid' }];
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
  for (const path of ['sigs', 'confirms', 'feedback']) {
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

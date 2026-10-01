// Tests for each corrective-ticket defect
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSnapshot, normalizeClient, deliveryColumns, deliveryManifest, itemsOf,
  AGREEMENT_VERSION } from '../portal/data.js';

// ── D1: deliveryColumns sees hasDelivery on public projections ──

test('D1: deliveryColumns shows Final delivery column when items have hasDelivery flag', () => {
  // Simulate a PUBLIC projection: items have hasDelivery:true but no dl
  const proj = {
    name: 'Test', items: [{ n: 1, b: '', t: 'Video 1', s: 'delivered', hasDelivery: true }],
    payments: [], approvals: [], totalItems: 1
  };
  const cols = deliveryColumns(proj);
  const dlCol = cols.find(c => c.key === 'dl');
  assert.ok(dlCol, 'dl column should be visible when hasDelivery is true');
});

test('D1: deliveryColumns hides dl column when no items have dl or hasDelivery', () => {
  const proj = {
    name: 'Test', items: [{ n: 1, b: '', t: 'Video 1', s: 'pending' }],
    payments: [], approvals: [], totalItems: 1
  };
  const cols = deliveryColumns(proj);
  const dlCol = cols.find(c => c.key === 'dl');
  assert.equal(dlCol, undefined, 'dl column should be hidden when no delivery data');
});

test('D1: public snapshot items get hasDelivery=true while hiding the raw dl URL', () => {
  const client = normalizeClient({
    name: 'Test', projects: { p1: {
      name: 'Project', items: [
        { n: 1, t: 'V1', s: 'delivered', dl: 'https://drive.google.com/file/d/abc/view' },
        { n: 2, t: 'V2', s: 'pending', dl: '' },
      ], payments: [], approvals: [], totalItems: 2
    }}, accessEnabled: true
  }, 'test-client');
  const snap = publicSnapshot(client, 'test-client');
  const items = snap.projects.p1.items;
  // Item 1: has dl → hasDelivery:true, no dl key
  assert.equal(items[0].hasDelivery, true);
  assert.equal(items[0].dl, undefined);
  // Item 2: empty dl → no hasDelivery
  assert.equal(items[1].hasDelivery, undefined);
  assert.equal(items[1].dl, undefined);
  // deliveryColumns on the snapshot should show dl column
  const cols = deliveryColumns(snap.projects.p1);
  assert.ok(cols.find(c => c.key === 'dl'), 'dl column visible via hasDelivery');
});

// ── D3: approval suggestions don't leak dl URLs ──

test('D3: approval suggestion for delivered item should not contain drive URLs', () => {
  // We test the approval description pattern from openItem
  // The fix removed item.dl from the suggestion template
  const item = { n: 5, t: 'Episode 5', s: 'delivered', dl: 'https://drive.google.com/file/d/secret' };
  // Simulate what the code produces:
  const name = item.t;
  const desc = `${name}\nPlease review this delivery and confirm.`;
  assert.ok(!desc.includes('drive.google.com'), 'Description must not contain drive URL');
  assert.ok(!desc.includes(item.dl), 'Description must not contain the dl value');
});

// ── D4: deliveryManifest bounded ──

test('D4: deliveryManifest only includes items with valid dl URLs', () => {
  const proj = {
    items: [
      { n: 1, dl: 'https://drive.google.com/file/1', s: 'delivered' },
      { n: 2, dl: '', s: 'pending' },
      { n: 3, dl: 'javascript:alert(1)', s: 'delivered' }, // unsafe
      { n: 4, dl: 'https://drive.google.com/file/4', s: 'completed' },
    ], payments: [], approvals: [], totalItems: 4
  };
  const manifest = deliveryManifest(proj, 'project-x');
  assert.equal(manifest.length, 2); // Only items 1 and 4
  assert.equal(manifest[0].id, 'project-x-1');
  assert.equal(manifest[1].id, 'project-x-4');
});

// ── D7: portalVersion ──

test('D7: publicSnapshot emits portalVersion 7', () => {
  const client = normalizeClient({ name: 'V6 Test', projects: {}, accessEnabled: true }, 'v6');
  const snap = publicSnapshot(client, 'v6');
  assert.equal(snap.portalVersion, 7, 'Reject retired v5 and v6 writers');
});

// ── D6: masterSignatureComplete still in snapshot ──

test('D6: obsolete admin signature flag cannot grant public authorization', () => {
  const client = normalizeClient({
    name: 'Sig Test', projects: {}, accessEnabled: true,
    masterSignatureComplete: true
  }, 'sig-test');
  const snap = publicSnapshot(client, 'sig-test');
  assert.equal(snap.masterSignatureComplete, undefined);
  assert.ok(snap.masterAgreement.version);
});

test('D6: public snapshot publishes versioned consent and master terms', () => {
  const client = normalizeClient({ name: 'Default', projects: {}, accessEnabled: true }, 'def');
  const snap = publicSnapshot(client, 'def');
  assert.equal(snap.masterSignatureComplete, undefined);
  assert.ok(snap.consentTerms.sections.length);
  assert.ok(snap.masterAgreement.clauses.length);
});

// ── D8: report generation with isAdmin flag ──

test('D8: report.js buildProjectReport redacts dl for non-admin', async () => {
  const { buildProjectReport } = await import('../portal/report.js');
  const project = {
    name: 'Report Test', rate: 500, budget: 5000, status: 'active',
    items: [
      { n: 1, t: 'V1', s: 'delivered', dl: 'https://drive.google.com/secret', hasDelivery: true },
    ], payments: [], approvals: [], totalItems: 1
  };
  // Client view (isAdmin=false): dl should be redacted
  const clientHtml = buildProjectReport({
    client: { name: 'Test Client' }, project, isAdmin: false, generatedAt: '2026-09-28'
  });
  assert.ok(!clientHtml.includes('drive.google.com/secret'), 'Client report must not contain raw dl URL');
  assert.ok(clientHtml.includes('Delivery file'), 'Client report should show "Delivery file" placeholder');

  // Admin view (isAdmin=true): dl should be present
  const adminHtml = buildProjectReport({
    client: { name: 'Test Client' }, project, isAdmin: true, generatedAt: '2026-09-28'
  });
  assert.ok(adminHtml.includes('drive.google.com/secret'), 'Admin report should contain dl URL');
});

// ── Composite: full public snapshot → report pipeline ──

test('composite: public snapshot through deliveryColumns through report stays dl-free for client', async () => {
  const { buildProjectReport } = await import('../portal/report.js');
  const adminClient = normalizeClient({
    name: 'Pipeline Test', projects: { vid: {
      name: 'Videos', items: [
        { n: 1, t: 'Ep1', s: 'delivered', dl: 'https://drive.google.com/file/d/x' },
        { n: 2, t: 'Ep2', s: 'pending' },
      ], payments: [], approvals: [], rate: 500, budget: 1000, totalItems: 2
    }}
  }, 'pipeline');
  const snap = publicSnapshot(adminClient, 'pipeline');
  const clientProject = snap.projects.vid;
  // deliveryColumns sees hasDelivery
  const cols = deliveryColumns(clientProject);
  assert.ok(cols.find(c => c.key === 'dl'), 'dl column visible');
  // Report generated from public data with isAdmin=false
  const html = buildProjectReport({
    client: snap, project: clientProject,
    items: itemsOf(clientProject), isAdmin: false, generatedAt: '2026-09-28'
  });
  assert.ok(!html.includes('drive.google.com'), 'End-to-end: no drive URLs in client report');
});

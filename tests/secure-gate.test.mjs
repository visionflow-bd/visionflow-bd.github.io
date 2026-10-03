import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicSnapshot, normalizeClient, deliveryManifest, itemsOf, prepareSecureSave, clone, currentMaster, projectAcknowledged, redactDeliverySecrets} from '../portal/data.js';

// ────────────────────────────────────────────────────────────
// Fixture: client with delivery links
// ────────────────────────────────────────────────────────────
const gateFixture = () => normalizeClient({
  name: 'Gate Test Client',
  masterSignatureComplete: false,
  projects: {
    k9: {
      name: 'K9 Kollege',
      rate: 500,
      budget: 5000,
      items: [
        { n: 1, s: 'delivered', dl: 'https://drive.google.com/file/d/abc123/view', clientNote: 'First video' },
        { n: 2, s: 'delivered', dl: 'https://drive.google.com/file/d/def456/view' },
        { n: 3, s: 'pending' }, // no dl
      ]
    }
  }
}, 'gate-test');

test('one captured master covers current projects; material changes only require acknowledgement', () => {
  const c=gateFixture();c.projects.second=clone(c.projects.k9);
  prepareSecureSave(c);const p=publicSnapshot(c,c.slug);
  const signed={id:p.masterAgreement.version,termsSnapshot:clone(p.masterAgreement),projectTerms:clone(p.projectTerms),name:'Test signatory'};
  assert.equal(currentMaster(p,[signed]),signed);
  assert.equal(projectAcknowledged(p,'k9',signed),true);
  assert.equal(projectAcknowledged(p,'second',signed),true);
  const changed=clone(c);changed.projects.k9.budget+=500;prepareSecureSave(changed,c);
  const updated=publicSnapshot(changed,c.slug);
  assert.equal(currentMaster(updated,[signed]),signed,'Material project edit must not require another master signature');
  assert.equal(projectAcknowledged(updated,'k9',signed),false);
  assert.equal(projectAcknowledged(updated,'second',signed),true);
  const ack={id:updated.projects.k9.ackId,masterVersion:signed.id,termsSnapshot:updated.projectTerms.k9};
  assert.equal(projectAcknowledged(updated,'k9',signed,[ack]),true);
  const replacement=clone(changed);replacement.masterRevision=2;prepareSecureSave(replacement,changed);
  assert.equal(currentMaster(publicSnapshot(replacement,c.slug),[signed]),undefined);
  assert.equal(currentMaster(p,[{...signed,revoked:true}]),undefined);
});

test('new projects get acknowledgement without changing the signed master', () => {
  const c=gateFixture();prepareSecureSave(c);const p=publicSnapshot(c,c.slug);
  const s={id:p.masterAgreement.version,termsSnapshot:p.masterAgreement,projectTerms:p.projectTerms};
  const next=clone(c);next.projects.newProject=clone(c.projects.k9);prepareSecureSave(next,c);
  const p2=publicSnapshot(next,next.slug);
  assert.equal(currentMaster(p2,[s]),s);
  assert.equal(projectAcknowledged(p2,'newProject',s),false);
});

test('each delivered file gets its own access record; ordinary edits do not rewrite them', () => {
  const c=gateFixture();c.projects.k9.items.push({n:4,s:'revision',dl:'https://example.invalid/not-yet'});
  const initial=prepareSecureSave(c);
  assert.deepEqual(initial.filter(w=>w.data).map(w=>w.path),[['deliveries','k9~1'],['deliveries','k9~2']]);
  assert.deepEqual(initial.find(w=>w.path[1]==='k9').delete,true,'legacy all-links manifest is retired');
  assert.equal(initial[0].data.link,'https://drive.google.com/file/d/abc123/view');
  assert.ok(!JSON.stringify(initial).includes('not-yet'),'a revision item never publishes its attached link');
  assert.ok(!JSON.stringify(initial).includes('links'));
  const next=clone(c);next.projects.k9.items[0].clientNote='Progress';
  assert.equal(prepareSecureSave(next,c).length,0);
  const back=clone(c);back.projects.k9.items[0].s='revision';
  const revoke=prepareSecureSave(back,c);
  assert.deepEqual(revoke.filter(w=>w.delete).map(w=>w.path[1]).sort(),['k9','k9~1']);
  const archived=clone(c);archived.projects.k9.deleted=true;
  assert.deepEqual(prepareSecureSave(archived,c).map(w=>w.path[1]).sort(),['k9','k9~1','k9~2']);
});

test('1000 delivered files never overflow one save; the admin sync completes them', () => {
  const c=gateFixture();c.projects.k9.items=Array.from({length:1000},(_,n)=>({n:n+1,s:'delivered',dl:`https://example.invalid/final/${n}`}));
  const initial=prepareSecureSave(c);
  assert.ok(initial.length<=2);
  const one=clone(c);one.projects.k9.items[5].dl='https://example.invalid/replaced';
  const delta=prepareSecureSave(one,c);
  assert.deepEqual(delta.filter(w=>w.data).map(w=>w.path[1]),['k9~6']);
});

test('link rotation writes current access records under the new token', () => {
  const c=gateFixture();c.accessToken='old';prepareSecureSave(c);
  const next=clone(c);next.accessToken='new';const writes=prepareSecureSave(next,c);
  assert.deepEqual(writes.filter(w=>w.data).map(w=>w.path[1]),['k9~1','k9~2']);
  assert.equal(writes.filter(w=>w.delete).length,1);
  assert.equal(next.projects.k9.deliveryVersion,c.projects.k9.deliveryVersion+1);
});

test('only Delivered items are published as downloadable', () => {
  const c=gateFixture();c.projects.k9.items.push({n:4,s:'completed',dl:'https://example.invalid/done'},{n:5,s:'revision',dl:'https://example.invalid/rev'});
  const items=publicSnapshot(c,c.slug).projects.k9.items;
  assert.deepEqual(items.filter(i=>i.hasDelivery).map(i=>i.n),[1,2]);
});

test('replaced and removed final links stay redacted without hiding unrelated source files',()=>{
  const before=gateFixture();prepareSecureSave(before);
  const next=clone(before);
  next.projects.k9.items[0].dl='https://example.invalid/new-final';
  next.projects.k9.items[0].scriptUrl='https://drive.google.com/file/d/unrelated-source/view';
  next.projects.k9.approvals=[{id:'old-link',desc:'Previous delivery https://drive.google.com/open?id=abc123'}];
  next.projects.k9.items=next.projects.k9.items.filter(item=>item.n!==2);
  next.projects.k9.scope='Retired delivery https://drive.google.com/uc?id=def456';
  prepareSecureSave(next,before);
  const pub=publicSnapshot(next,next.slug),serialized=JSON.stringify(pub);
  for(const secret of ['abc123','def456','new-final','deliverySecretUrls'])assert.equal(serialized.includes(secret),false);
  assert.equal(pub.projects.k9.items[0].scriptUrl,'https://drive.google.com/file/d/unrelated-source/view');
  assert.ok(next.deliverySecretUrls.some(u=>u.includes('abc123')));
});

test('final links in historic descriptions, aliases, source fields and archived items are redacted', () => {
  const c=gateFixture();c.projects.k9.items[0].scriptUrl='https://drive.google.com/open?id=abc123';
  c.projects.k9.approvals=[{id:'a',desc:'Download https://drive.google.com/uc?export=download&id=abc123'}];
  c.projects.k9.items.push({n:9,deleted:true,dl:'https://drive.google.com/file/d/archived/view'});
  c.projects.k9.scope='Prior final: https://drive.google.com/open?id=archived';
  const snap=publicSnapshot(c,c.slug),encoded=JSON.stringify(snap);
  assert.equal(encoded.includes('abc123'),false);assert.equal(encoded.includes('id=archived'),false);
  assert.equal(JSON.stringify(redactDeliverySecrets({message:c.projects.k9.approvals[0].desc},c)).includes('abc123'),false);
  assert.equal(c.projects.k9.items[0].dl,'https://drive.google.com/file/d/abc123/view','private evidence unchanged');
});

// ────────────────────────────────────────────────────────────
// 1. publicSnapshot MUST NOT expose raw dl links
// ────────────────────────────────────────────────────────────
test('publicSnapshot excludes raw dl links from client-visible data', () => {
  const c = gateFixture();
  const snap = publicSnapshot(c, 'gate-test');
  const json = JSON.stringify(snap);

  // Raw Drive URLs must NOT appear anywhere in the public snapshot
  assert.ok(!json.includes('drive.google.com'), 'Drive URL leaked into public snapshot');
  assert.ok(!json.includes('abc123'), 'File ID leaked into public snapshot');
  assert.ok(!json.includes('def456'), 'File ID leaked into public snapshot');

  // But hasDelivery flag should be present for items with dl
  const items = snap.projects.k9.items;
  assert.equal(items[0].hasDelivery, true, 'Item 1 should have hasDelivery=true');
  assert.equal(items[1].hasDelivery, true, 'Item 2 should have hasDelivery=true');
  assert.equal(items[2].hasDelivery, undefined, 'Item 3 should NOT have hasDelivery');

  // dl field must not be present on any item
  for (const item of items) {
    assert.ok(!('dl' in item), `Item ${item.n} should not have dl field in public snapshot`);
  }
});

// ────────────────────────────────────────────────────────────
// 2. masterSignatureComplete field in snapshot
// ────────────────────────────────────────────────────────────
test('publicSnapshot never treats an admin Boolean as a signature', () => {
  const c = gateFixture();
  const snap = publicSnapshot(c, 'gate-test');
  assert.equal(snap.masterSignatureComplete, undefined);

  c.masterSignatureComplete = true;
  const snap2 = publicSnapshot(c, 'gate-test');
  assert.equal(snap2.masterSignatureComplete, undefined);
  assert.deepEqual(snap2.masterAgreement, snap.masterAgreement);
});

// ────────────────────────────────────────────────────────────
// 3. deliveryManifest creates correct gated records
// ────────────────────────────────────────────────────────────
test('deliveryManifest extracts only items with valid dl URLs', () => {
  const c = gateFixture();
  const manifest = deliveryManifest(c.projects.k9, 'k9');

  assert.equal(manifest.length, 2, 'Only 2 items have dl links');

  assert.equal(manifest[0].id, 'k9-1');
  assert.equal(manifest[0].projectKey, 'k9');
  assert.equal(manifest[0].itemNumber, 1);
  assert.ok(manifest[0].dl.includes('abc123'));

  assert.equal(manifest[1].id, 'k9-2');
  assert.equal(manifest[1].dl.includes('def456'), true);

  // Each manifest entry must have an updatedAt timestamp
  for (const m of manifest) {
    assert.ok(m.updatedAt, 'Must have updatedAt');
  }
});

test('deliveryManifest returns empty array for project with no deliveries', () => {
  const c = normalizeClient({ projects: { empty: { name: 'Empty', items: [{ n: 1, s: 'pending' }] } } }, 'test');
  const manifest = deliveryManifest(c.projects.empty, 'empty');
  assert.equal(manifest.length, 0);
});

// ────────────────────────────────────────────────────────────
// 4. Other public snapshot fields preserved
// ────────────────────────────────────────────────────────────
test('publicSnapshot preserves other item fields while removing dl', () => {
  const c = gateFixture();
  const snap = publicSnapshot(c, 'gate-test');
  const item1 = snap.projects.k9.items[0];

  // These fields should still be present
  assert.equal(item1.n, 1);
  assert.equal(item1.s, 'delivered');
  assert.equal(item1.clientNote, 'First video');
  assert.equal(item1.hasDelivery, true);
});

// ────────────────────────────────────────────────────────────
// 5. CSV columns exclusion test (pure function test)
// ────────────────────────────────────────────────────────────
import {deliveryColumns} from '../portal/data.js';

test('deliveryColumns includes dl when populated', () => {
  const c = gateFixture();
  const columns = deliveryColumns(c.projects.k9);
  const dlCol = columns.find(col => col.key === 'dl');
  assert.ok(dlCol, 'dl column should be present when items have dl');
  assert.equal(dlCol.type, 'link');
  assert.equal(dlCol.label, 'Final delivery');
});

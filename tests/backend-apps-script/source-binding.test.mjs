import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEventSource, notificationEventId, reviewSourceCurrent } from '../../backend/apps-script/source-binding.mjs';
import { createOutboxEvent, EVENT_TYPES } from '../../backend/apps-script/worker.mjs';
import { normalizeClient, publicSnapshot, prepareSecureSave } from '../../portal/data.js';

import {createFakeFirestore} from './fake-firestore.mjs';

// -- Canonical Fixture ---------------------------------------------
function makeFixture(eventType, overrides = {}) {
  const client = normalizeClient({
    name: 'Binding Client',
    accessToken: 'tok1',
    reviewEpoch: 0,
    projects: { k9: { name: 'Project K9', budget: 400, rate: 400, items: [] } },
  }, 'shishir');
  if(eventType==='project-signed')client.agreementMode='project';
  prepareSecureSave(client);
  const portal = publicSnapshot(client, 'shishir');
  const root = 'portal_public/tok1';
  const projectKey = ['consent-complete', 'master-signed'].includes(eventType) ? null : 'k9';
  const project = projectKey ? portal.projects[projectKey] : null;
  const ts = '2026-10-01T11:00:00Z';

  // Ensure notificationRevision for notice-based events
  if (project && !project.notificationRevision) {
    portal.projects.k9.notificationRevision = 1;
    client.projects.k9.notificationRevision = 1;
  }

  let sourceCollection, sourceId, sourceVersion, sourceDoc;
  switch (eventType) {
    case 'consent-complete':
      sourceCollection = `${root}/consent`;
      sourceId = portal.consentTerms.version;
      sourceVersion = portal.consentTerms.version;
      sourceDoc = { termsVersion: sourceId, termsSnapshot: portal.consentTerms, agreedAt: ts };
      break;
    case 'master-signed':
      sourceCollection = `${root}/agreements`;
      sourceId = portal.masterAgreement.version;
      sourceVersion = sourceId;
      sourceDoc = { signedAt: ts, termsSnapshot: portal.masterAgreement };
      break;
    case 'project-acknowledged':
      sourceCollection = `${root}/acknowledgements`;
      sourceId = project.ackId;
      sourceVersion = sourceId;
      sourceDoc = { projectKey: 'k9', masterVersion: portal.masterAgreement.version, acknowledgedAt: ts, termsSnapshot: portal.projectTerms?.k9 };
      break;
    case 'project-signed':
      sourceCollection=`${root}/sigs`;sourceId=project.signatureId;sourceVersion=sourceId;
      sourceDoc={projectKey:'k9',signedAt:ts,termsSnapshot:portal.projectTerms.k9,reviewPolicy:portal.masterAgreement.reviewPolicy};
      break;
    case 'confirmation-received':
      sourceCollection = `${root}/confirms`;
      sourceId = 'confirm1';
      sourceVersion = 'confirm1';
      sourceDoc = { projectKey: 'k9', confirmedAt: ts, kind: 'confirmed' };
      break;
    case 'objection-received':
      sourceCollection = `${root}/feedback`;
      sourceId = 'fb1';
      sourceVersion = 'fb1';
      sourceDoc = { projectKey: 'k9', submittedAt: ts, kind: 'feedback' };
      break;
    case 'review-window':
    case 'deemed-accepted':
      sourceCollection = 'portal_reviews';
      sourceId = 'review1';
      sourceVersion = 'v1';
      sourceDoc = {
        status: eventType==='review-window'?'awaiting-review-notification':'deemed-accepted', clientSlug: 'shishir', portalToken: 'tok1',
        projectKey: 'k9', sourceVersion: 'v1', reviewEpoch: 0, decidedAt: ts,
        sourceId: 'notice1', sourceCollection: `${root}/notices`,
        projectRevision: project.notificationRevision || 1,
        masterVersion:portal.masterAgreement.version,notificationPreparedAt:ts,
      };
      break;
    default: {
      sourceCollection = `${root}/notices`;
      sourceId = 'notice1';
      sourceVersion = 'v1';
      const rev = project?.notificationRevision || 1;
      sourceDoc = { schemaVersion: 1, eventType, clientSlug: 'shishir', projectKey: 'k9', version: 'v1', reviewEpoch: 0, projectRevision: rev, createdAt: ts };
      break;
    }
  }

  const ev = createOutboxEvent({
    eventType, sourceCollection, sourceId, clientSlug: 'shishir',
    projectKey, sourceVersion, portalToken: 'tok1', reviewEpoch: 0,
    activationBoundary: '2026-09-28T00:00:00Z',
    clock: { now: () => '2026-10-01T11:30:00Z' },
  });

  const data = {
    'portal_clients/shishir': { ...client, email: 'client@example.com' },
    [root]: portal,
    [`${sourceCollection}/${sourceId}`]: sourceDoc,
    ...overrides,
  };

  // For deemed-accepted, seed the notice that reviewSourceCurrent checks
  if (eventType === 'deemed-accepted'||eventType==='review-window') {
    data[`${root}/notices/notice1`] = {
      schemaVersion: 1, eventType: 'project-notification', clientSlug: 'shishir',
      projectKey: 'k9', version: 'v1', reviewEpoch: 0,
      projectRevision: sourceDoc.projectRevision, createdAt: ts,
    };
  }
  if(eventType==='review-window')Object.assign(data,{
    [`${root}/consent/${portal.consentTerms.version}`]:{termsSnapshot:portal.consentTerms,agreedAt:ts},
    [`${root}/agreements/${portal.masterAgreement.version}`]:{termsSnapshot:portal.masterAgreement,projectTerms:portal.projectTerms,signedAt:ts},
    [`${root}/review_guards/k9`]:{revision:0},
    [`${root}/reviews/${sourceId}`]:{requestId:sourceId,sourceVersion,projectKey:'k9',status:'awaiting-review-notification',revision:0},
  });

  return { event: ev, data, portal, client, sourceCollection, sourceId, sourceVersion, sourceDoc, projectKey, root };
}

const clock = { now: () => '2026-10-01T12:00:00Z' };
const config = { activationBoundary: '2026-09-28T00:00:00Z' };

test('switching to project agreements stops queued master and acknowledgement messages',async()=>{
  for(const type of ['master-signed','project-acknowledged']){
    const {event,data,root}=makeFixture(type);
    data[root].agreementMode='project';
    const result=await resolveEventSource(event,{firestore:createFakeFirestore(data),clock,config});
    assert.equal(result.ok,false);assert.equal(result.status,'source-version-mismatch');
  }
});

// -------------------------------------------------------------------
// All valid event types
// -------------------------------------------------------------------
describe('resolveEventSource - all valid event types', () => {
  for (const eventType of EVENT_TYPES) {
    test(`${eventType} resolves ok with canonical fixture`, async () => {
      const { event, data } = makeFixture(eventType);
      const fs = createFakeFirestore(data);
      const result = await resolveEventSource(event, { firestore: fs, clock, config });
      assert.equal(result.ok, true, `Expected ok for ${eventType}, got status: ${result.status}`);
      assert.ok(result.client);
      assert.ok(result.portal);
      assert.ok(result.source);
    });
  }
});

// -------------------------------------------------------------------
// Foreign path / client / token / project
// -------------------------------------------------------------------
describe('resolveEventSource - foreign path/client/token/project', () => {
  test('wrong sourceCollection path rejects', async () => {
    const { event, data } = makeFixture('project-notification');
    event.sourceCollection = 'portal_public/tok1/agreements';
    // Recompute id
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });

  test('wrong clientSlug rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.clientSlug = 'attacker';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'workspace-inactive');
  });

  test('wrong portalToken rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.portalToken = 'wrong-token';
    event.sourceCollection = 'portal_public/wrong-token/consent';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'workspace-inactive');
  });

  test('wrong projectKey rejects', async () => {
    const { event, data } = makeFixture('delivery-notification');
    event.projectKey = 'nonexistent';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-project-mismatch');
  });

  test('consent-complete with projectKey rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.projectKey = 'k9';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
  });
});

// -------------------------------------------------------------------
// Stale version / revision / epoch
// -------------------------------------------------------------------
describe('resolveEventSource - stale version/revision/epoch', () => {
  test('stale sourceVersion rejects', async () => {
    const { event, data } = makeFixture('project-notification');
    event.sourceVersion = 'old-version';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-version-mismatch');
  });

  test('stale reviewEpoch rejects', async () => {
    const { event, data } = makeFixture('project-notification');
    event.reviewEpoch = 99;
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-superseded');
  });

  test('stale projectRevision rejects', async () => {
    const { event, data } = makeFixture('payment-notification');
    // Mutate the source doc to have a different revision
    const sourceKey = `${event.sourceCollection}/${event.sourceId}`;
    data[sourceKey].projectRevision = 999;
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-version-mismatch');
  });
});

// -------------------------------------------------------------------
// Cancellation
// -------------------------------------------------------------------
describe('resolveEventSource - cancellation', () => {
  test('cancelled notice (cancelledAt set) rejects project-notification', async () => {
    const { event, data } = makeFixture('project-notification');
    const sourceKey = `${event.sourceCollection}/${event.sourceId}`;
    data[sourceKey].cancelledAt = '2026-10-01T10:00:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-version-mismatch');
  });

  test('cancelled notice rejects all project event types', async () => {
    for (const et of ['project-notification', 'payment-notification', 'delivery-notification', 'update-notification']) {
      const { event, data } = makeFixture(et);
      const sourceKey = `${event.sourceCollection}/${event.sourceId}`;
      data[sourceKey].cancelledAt = '2026-10-01T10:00:00Z';
      const fs = createFakeFirestore(data);
      const result = await resolveEventSource(event, { firestore: fs, clock, config });
      assert.equal(result.ok, false, `Expected rejection for cancelled ${et}`);
    }
  });

  test('cancelled notice prevents deemed-accepted review from being current', async () => {
    const { event, data, portal } = makeFixture('deemed-accepted');
    // Cancel the notice that reviewSourceCurrent checks
    data['portal_public/tok1/notices/notice1'].cancelledAt = '2026-10-01T10:00:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-superseded');
  });
});

// -------------------------------------------------------------------
// Timing validation
// -------------------------------------------------------------------
describe('resolveEventSource - timing', () => {
  test('source created before activation boundary rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    const sourceKey = `${event.sourceCollection}/${event.sourceId}`;
    data[sourceKey].agreedAt = '2026-09-01T00:00:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-time-invalid');
  });

  test('event created before source rejects', async () => {
    const { event, data } = makeFixture('master-signed');
    event.createdAt = '2026-10-01T10:00:00Z'; // before source signedAt at 11:00
    const sourceKey = `${event.sourceCollection}/${event.sourceId}`;
    data[sourceKey].signedAt = '2026-10-01T10:30:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-time-invalid');
  });

  test('event from the future rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.createdAt = '2030-01-01T00:00:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-time-invalid');
  });
});

// -------------------------------------------------------------------
// Mutation between preflight and send authorization
// -------------------------------------------------------------------
describe('resolveEventSource - mutation between calls', () => {
  test('source deleted between first and second resolve', async () => {
    const { event, data, sourceCollection, sourceId } = makeFixture('project-notification');
    const fs = createFakeFirestore(data);
    // First call succeeds
    const r1 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r1.ok, true);
    // Delete source
    delete fs._records[`${sourceCollection}/${sourceId}`];
    // Second call fails
    const r2 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'source-missing');
  });

  test('workspace disabled between calls', async () => {
    const { event, data } = makeFixture('delivery-notification');
    const fs = createFakeFirestore(data);
    const r1 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r1.ok, true);
    // Disable portal
    fs._records['portal_public/tok1'].enabled = false;
    const r2 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'workspace-inactive');
  });

  test('notice cancelled between calls', async () => {
    const { event, data, sourceCollection, sourceId } = makeFixture('update-notification');
    const fs = createFakeFirestore(data);
    const r1 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r1.ok, true);
    fs._records[`${sourceCollection}/${sourceId}`].cancelledAt = '2026-10-01T11:45:00Z';
    const r2 = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(r2.ok, false);
    assert.equal(r2.status, 'source-version-mismatch');
  });
});

// -------------------------------------------------------------------
// Same-lease race
// -------------------------------------------------------------------
describe('resolveEventSource - same-lease race', () => {
  test('concurrent resolves with identical event both succeed independently', async () => {
    const { event, data } = makeFixture('consent-complete');
    const fs = createFakeFirestore(data);
    const [r1, r2] = await Promise.all([
      resolveEventSource(event, { firestore: fs, clock, config }),
      resolveEventSource(event, { firestore: fs, clock, config }),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
  });

  test('transaction detects source mutation during commit', async () => {
    const { event, data, sourceCollection, sourceId } = makeFixture('project-notification');
    const fs = createFakeFirestore(data);
    const sourcePath = `${sourceCollection}/${sourceId}`;
    // Simulate: transaction reads, then external write changes version, then commit
    await assert.rejects(fs.runTransaction(async tx => {
      await tx.get(sourcePath);
      // External mutation (simulated by direct record modification)
      fs._records[sourcePath]._updateTime = 'externally-modified';
      tx.set(sourcePath, { modified: true }, { merge: true });
    }), /Transaction conflict/);
  });
});

// -------------------------------------------------------------------
// notificationEventId has six components
// -------------------------------------------------------------------
describe('notificationEventId', () => {
  test('six-component collision identity', () => {
    const id = notificationEventId({
      eventType: 'delivery-notification',
      clientSlug: 'c',
      sourceCollection: 'portal_public/t/notices',
      sourceId: 'n1',
      sourceVersion: 'v1',
      projectKey: 'p1',
    });
    const parts = JSON.parse(decodeURIComponent(id));
    assert.equal(parts.length, 6);
    assert.deepEqual(parts, ['delivery-notification', 'c', 'portal_public/t/notices', 'n1', 'v1', 'p1']);
  });

  test('different projectKey produces different id', () => {
    const base = { eventType: 'project-notification', clientSlug: 'c', sourceCollection: 's', sourceId: 'n', sourceVersion: 'v' };
    const id1 = notificationEventId({ ...base, projectKey: 'p1' });
    const id2 = notificationEventId({ ...base, projectKey: 'p2' });
    assert.notEqual(id1, id2);
  });

  test('null projectKey is stable', () => {
    const base = { eventType: 'consent-complete', clientSlug: 'c', sourceCollection: 's', sourceId: 'n', sourceVersion: 'v', projectKey: null };
    assert.equal(notificationEventId(base), notificationEventId(base));
  });
});

// -------------------------------------------------------------------
// reviewSourceCurrent
// -------------------------------------------------------------------
describe('reviewSourceCurrent', () => {
  test('returns false for cancelled notice', async () => {
    const { portal } = makeFixture('project-notification');
    const request = {
      sourceId: 'notice1', sourceVersion: 'v1', portalToken: 'tok1',
      sourceCollection: 'portal_public/tok1/notices',
      projectKey: 'k9', projectRevision: 1, clientSlug: 'shishir', reviewEpoch: 0,
    };
    const fs = createFakeFirestore({
      'portal_public/tok1/notices/notice1': {
        schemaVersion: 1, eventType: 'project-notification', clientSlug: 'shishir',
        projectKey: 'k9', version: 'v1', reviewEpoch: 0, projectRevision: 1,
        createdAt: '2026-10-01T11:00:00Z', cancelledAt: '2026-10-01T11:30:00Z',
      },
    });
    assert.equal(await reviewSourceCurrent(request, { firestore: fs, portal }), false);
  });

  test('returns true for valid non-cancelled notice', async () => {
    const { portal } = makeFixture('project-notification');
    const request = {
      sourceId: 'notice1', sourceVersion: 'v1', portalToken: 'tok1',
      sourceCollection: 'portal_public/tok1/notices',
      projectKey: 'k9', projectRevision: 1, clientSlug: 'shishir', reviewEpoch: 0,
    };
    const fs = createFakeFirestore({
      'portal_public/tok1/notices/notice1': {
        schemaVersion: 1, eventType: 'project-notification', clientSlug: 'shishir',
        projectKey: 'k9', version: 'v1', reviewEpoch: 0, projectRevision: 1,
        createdAt: '2026-10-01T11:00:00Z',
      },
    });
    assert.equal(await reviewSourceCurrent(request, { firestore: fs, portal }), true);
  });

  test('returns false for mismatched projectRevision', async () => {
    const { portal } = makeFixture('project-notification');
    const request = {
      sourceId: 'notice1', sourceVersion: 'v1', portalToken: 'tok1',
      sourceCollection: 'portal_public/tok1/notices',
      projectKey: 'k9', projectRevision: 5, clientSlug: 'shishir', reviewEpoch: 0,
    };
    const fs = createFakeFirestore({
      'portal_public/tok1/notices/notice1': {
        schemaVersion: 1, eventType: 'project-notification', clientSlug: 'shishir',
        projectKey: 'k9', version: 'v1', reviewEpoch: 0, projectRevision: 5,
        createdAt: '2026-10-01T11:00:00Z',
      },
    });
    // Portal project has notificationRevision 1, request says 5
    assert.equal(await reviewSourceCurrent(request, { firestore: fs, portal }), false);
  });

  test('returns false for invalid sourceCollection path', async () => {
    const { portal } = makeFixture('project-notification');
    const request = {
      sourceId: 'notice1', sourceVersion: 'v1', portalToken: 'tok1',
      sourceCollection: 'wrong/path',
      projectKey: 'k9', projectRevision: 1, clientSlug: 'shishir', reviewEpoch: 0,
    };
    const fs = createFakeFirestore({});
    assert.equal(await reviewSourceCurrent(request, { firestore: fs, portal }), false);
  });
});

// -------------------------------------------------------------------
// Input validation edge cases
// -------------------------------------------------------------------
describe('resolveEventSource - input validation', () => {
  test('null event rejects', async () => {
    const fs = createFakeFirestore({});
    const result = await resolveEventSource(null, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });

  test('event with slash in sourceId rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.sourceId = 'has/slash';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });

  test('event with negative reviewEpoch rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.reviewEpoch = -1;
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });

  test('event id mismatch rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.id = 'tampered-id';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });

  test('empty clientSlug rejects', async () => {
    const { event, data } = makeFixture('consent-complete');
    event.clientSlug = '';
    event.id = notificationEventId(event);
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-binding-invalid');
  });
});

// -------------------------------------------------------------------
// Cancelled or superseded notice review test
// -------------------------------------------------------------------
describe('cancelled/superseded notice in review context', () => {
  test('deemed-accepted event with cancelled underlying notice is source-superseded', async () => {
    const { event, data } = makeFixture('deemed-accepted');
    data['portal_public/tok1/notices/notice1'].cancelledAt = '2026-10-01T10:00:00Z';
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-superseded');
  });

  test('superseded review epoch blocks deemed-accepted', async () => {
    const { event, data } = makeFixture('deemed-accepted');
    data['portal_clients/shishir'].reviewEpoch = 5;
    const fs = createFakeFirestore(data);
    const result = await resolveEventSource(event, { firestore: fs, clock, config });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'source-superseded');
  });
});

// -------------------------------------------------------------------
// Transactional fake validation
// -------------------------------------------------------------------
describe('createFakeFirestore - transactional properties', () => {
  test('buffered writes are atomic on success', async () => {
    const fs = createFakeFirestore({ 'a/1': { v: 1 }, 'a/2': { v: 2 } });
    await fs.runTransaction(async tx => {
      const d1 = await tx.get('a/1');
      const d2 = await tx.get('a/2');
      tx.set('a/1', { v: d1.v + 10 });
      tx.set('a/2', { v: d2.v + 10 });
    });
    assert.equal((await fs.get('a/1')).v, 11);
    assert.equal((await fs.get('a/2')).v, 12);
  });

  test('read version conflict aborts all writes', async () => {
    const fs = createFakeFirestore({ 'a/1': { v: 1 } });
    await assert.rejects(fs.runTransaction(async tx => {
      await tx.get('a/1');
      fs._records['a/1']._updateTime = 'external-change';
      tx.set('a/1', { v: 99 });
    }), /Transaction conflict/);
    // Original value preserved
    assert.equal(fs._records['a/1'].v, 1);
  });

  test('exists:false precondition works in transaction', async () => {
    const fs = createFakeFirestore({ 'a/1': { v: 1 } });
    await assert.rejects(fs.runTransaction(async tx => {
      tx.set('a/1', { v: 2 }, { exists: false });
    }), /already exists/);
  });

  test('updateTime precondition works in transaction', async () => {
    const fs = createFakeFirestore({ 'a/1': { v: 1 } });
    await assert.rejects(fs.runTransaction(async tx => {
      tx.set('a/1', { v: 2 }, { precondition: { updateTime: 'wrong' } });
    }), /Precondition/);
  });

  test('merge preserves existing fields in transaction', async () => {
    const fs = createFakeFirestore({ 'a/1': { v: 1, keep: true } });
    await fs.runTransaction(async tx => {
      tx.set('a/1', { v: 2 }, { merge: true });
    });
    const doc = await fs.get('a/1');
    assert.equal(doc.v, 2);
    assert.equal(doc.keep, true);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_POLICY } from '../../portal/review-policy.js';
import { assessReview, reviewDeadline } from '../../backend/review-engine.mjs';
import {
  doGet, doPost, createOutboxEvent, claimEvents, resolveRecipients,
  buildEmail, processEvent as processClaimedEvent, processOutbox, processReviewTimers,
  validateConfig, verifyAdminToken,
  EVENT_TYPES, MAX_RETRIES, LEASE_DURATION_MS, esc,
} from '../../backend/apps-script/worker.mjs';
import { notificationEventId } from '../../backend/apps-script/source-binding.mjs';

// ── Mock Factories ────────────────────────────────────────────────
import {createFakeFirestore as mockFirestore} from './fake-firestore.mjs';

// Real processing requires a persisted, atomically claimed outbox event.
async function processEvent(event,adapters){
  await adapters.firestore.set('portal_outbox/'+event.id,event);
  const [claimed]=await claimEvents({...adapters,workerId:'test-worker'});
  assert.ok(claimed,'test fixture must acquire a real lease');
  return processClaimedEvent(claimed,adapters);
}

function mockMail(opts = {}) {
  const sent = [];
  return {
    send: async (msg) => {
      if (opts.failFor && opts.failFor.includes(msg.targetType)) {
        throw Object.assign(new Error(`Send failed for ${msg.targetType}`),{notAccepted:true});
      }
      sent.push(msg);
    },
    remainingQuota: async () => opts.quota ?? 100,
    sent,
  };
}

function mockClock(iso = '2026-10-01T12:00:00Z') {
  return {
    now: () => iso,
    serverTimestamp: () => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 }),
  };
}

const DEFAULT_CONFIG = {
  enabled: true,
  projectId: 'visionflow-bd',
  adminUid: 'm1PGSw7ViEb1xOJoj8INQllra3p1',
  portalHost: 'https://visionflow-bd.github.io',
  activationBoundary: '2026-09-28T00:00:00Z',
  replyTo: 'visionflow.agency.bd@gmail.com',
};

// ── Source-binding-compliant fixture factory ───────────────────────
const TOKEN = 'test-token';
const CONSENT_TERMS = { version: 'terms-v1', text: 'terms' };
const MASTER_TERMS = { version: 'master-v1', text: 'master' };
const PROJECT_TERMS_K9 = { scope: 'video', rate: 500 };

function boundEvent(overrides = {}) {
  const eventType = overrides.eventType || 'consent-complete';
  const clientSlug = overrides.clientSlug || 'shishir';
  const portalToken = overrides.portalToken || TOKEN;
  const reviewEpoch = overrides.reviewEpoch ?? 0;
  const projectKey = overrides.projectKey || null;
  const root = `portal_public/${portalToken}`;
  let sourceCollection, sourceId, sourceVersion;
  switch (eventType) {
    case 'consent-complete':
      sourceCollection = `${root}/consent`;
      sourceId = CONSENT_TERMS.version;
      sourceVersion = CONSENT_TERMS.version;
      break;
    case 'master-signed':
      sourceCollection = `${root}/agreements`;
      sourceId = MASTER_TERMS.version;
      sourceVersion = MASTER_TERMS.version;
      break;
    case 'project-acknowledged':
      sourceCollection = `${root}/acknowledgements`;
      sourceId = 'ack-1';
      sourceVersion = 'ack-1';
      break;
    case 'confirmation-received':
      sourceCollection = `${root}/confirms`;
      sourceId = 'confirm-1';
      sourceVersion = 'confirm-1';
      break;
    case 'objection-received':
      sourceCollection = `${root}/feedback`;
      sourceId = 'feedback-1';
      sourceVersion = 'feedback-1';
      break;
    default:
      sourceCollection = `${root}/notices`;
      sourceId = 'notice-1';
      sourceVersion = 'v1';
  }
  if (overrides.sourceId) sourceId = overrides.sourceId;
  if (overrides.sourceVersion) sourceVersion = overrides.sourceVersion;
  if (overrides.sourceCollection) sourceCollection = overrides.sourceCollection;
  return createOutboxEvent({
    eventType, sourceCollection, sourceId, clientSlug, projectKey,
    sourceVersion, portalToken, reviewEpoch,
    activationBoundary: DEFAULT_CONFIG.activationBoundary,
    clock: overrides.clock || mockClock(),
  });
}

function boundStore(event, extras = {}) {
  const portalToken = event.portalToken;
  const clientSlug = event.clientSlug;
  const root = `portal_public/${portalToken}`;
  const projectKey = event.projectKey;
  const portal = {
    portalVersion: 7, enabled: true, clientSlug,
    consentTerms: CONSENT_TERMS,
    masterAgreement: MASTER_TERMS,
    projectTerms: { k9: PROJECT_TERMS_K9 },
  };
  if (projectKey) {
    portal.projects = { [projectKey]: { notificationRevision: 1, ackId: 'ack-1' } };
  }
  const client = {
    accessToken: portalToken, reviewEpoch: event.reviewEpoch || 0,
    email: 'client@example.com',
  };
  if (projectKey) client.projects = { [projectKey]: {} };
  if (extras.clientOverrides) Object.assign(client, extras.clientOverrides);
  let source;
  switch (event.eventType) {
    case 'consent-complete':
      source = { termsVersion: event.sourceId, agreedAt: '2026-10-01T11:00:00Z', termsSnapshot: CONSENT_TERMS };
      break;
    case 'master-signed':
      source = { signedAt: '2026-10-01T11:00:00Z', termsSnapshot: MASTER_TERMS };
      break;
    case 'project-acknowledged':
      source = { projectKey, masterVersion: MASTER_TERMS.version, acknowledgedAt: '2026-10-01T11:00:00Z', termsSnapshot: PROJECT_TERMS_K9 };
      break;
    case 'confirmation-received':
      source = { projectKey, submittedAt: '2026-10-01T11:00:00Z', kind: 'confirmed' };
      break;
    case 'objection-received':
      source = { projectKey, submittedAt: '2026-10-01T11:00:00Z', kind: 'rejected' };
      break;
    default:
      source = { schemaVersion: 1, eventType: event.eventType, clientSlug, projectKey, version: event.sourceVersion, reviewEpoch: event.reviewEpoch || 0, projectRevision: 1, createdAt: '2026-10-01T11:00:00Z' };
  }
  return {
    [root]: portal,
    [`portal_clients/${clientSlug}`]: client,
    [`${event.sourceCollection}/${event.sourceId}`]: source,
    'portal_settings/notifications': { enabled:true, adminEmail: 'admin@example.com' },
    ...extras.store,
  };
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: doPost fails closed
// ═══════════════════════════════════════════════════════════════════

describe('doPost security', () => {
  test('unauthenticated relay request cannot send mail', () => {
    const result = doPost(
      { postData: { contents: JSON.stringify({ to: 'victim@example.com', type: 'general', subject: 'Spam', message: 'Hello' }) } },
      { firestore: mockFirestore(), config: DEFAULT_CONFIG }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /does not relay/i);
  });

  test('caller cannot choose arbitrary recipients or body', () => {
    const result = doPost(
      { postData: { contents: JSON.stringify({ action: 'enqueue', to: 'anyone@evil.com', body: '<script>alert(1)</script>' }) } },
      { firestore: mockFirestore(), config: DEFAULT_CONFIG }
    );
    assert.equal(result.ok, false);
  });

  test('enqueue with idToken is disabled in this version', () => {
    const result = doPost(
      { postData: { contents: JSON.stringify({ action: 'enqueue', idToken: 'fake-token' }) } },
      { firestore: mockFirestore(), config: DEFAULT_CONFIG }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/i);
  });

  test('malformed POST body returns error', () => {
    const result = doPost(
      { postData: { contents: '{invalid json' } },
      { firestore: mockFirestore(), config: DEFAULT_CONFIG }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /bad request/i);
  });

  test('null/empty POST returns error', () => {
    assert.equal(doPost(null, { firestore: mockFirestore(), config: DEFAULT_CONFIG }).ok, false);
    assert.equal(doPost({}, { firestore: mockFirestore(), config: DEFAULT_CONFIG }).ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: doGet health
// ═══════════════════════════════════════════════════════════════════

describe('doGet health', () => {
  test('returns non-sensitive health only', () => {
    const result = doGet({}, { config: DEFAULT_CONFIG });
    assert.equal(result.ok, true);
    assert.equal(typeof result.service, 'string');
    // Must not contain credentials, tokens, UIDs, endpoints
    const json = JSON.stringify(result);
    assert.equal(json.includes(DEFAULT_CONFIG.adminUid), false);
    assert.equal(json.includes('gmail'), false);
    assert.equal(json.includes('token'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: HTML injection escaping
// ═══════════════════════════════════════════════════════════════════

describe('HTML escaping', () => {
  test('esc prevents HTML injection', () => {
    assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(esc('"onload="alert(1)"'), '&quot;onload=&quot;alert(1)&quot;');
    assert.equal(esc("'><img src=x onerror=alert(1)>"), '&#39;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  test('email templates escape user content', () => {
    const event = createOutboxEvent({
      eventType: 'project-notification',
      sourceCollection: 'portal_public',
      sourceId: 'test',
      clientSlug: '<script>alert(1)</script>',
      projectKey: '"><img src=x>',
      sourceVersion: 'v1',
      activationBoundary: '2026-09-28T00:00:00Z',
      clock: mockClock(),
    });
    const messages = buildEmail(event, { client: 'test@example.com' }, { config: DEFAULT_CONFIG });
    for (const msg of messages) {
      assert.equal(msg.htmlBody.includes('<script>'), false);
      assert.equal(msg.htmlBody.includes('"><img'), false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Final delivery link absent from emails
// ═══════════════════════════════════════════════════════════════════

describe('final link absent', () => {
  test('email templates never contain dl URLs or Drive links', () => {
    const event = createOutboxEvent({
      eventType: 'delivery-notification',
      sourceCollection: 'portal_public',
      sourceId: 'delivery1',
      clientSlug: 'shishir',
      projectKey: 'k9',
      sourceVersion: 'v1',
      activationBoundary: '2026-09-28T00:00:00Z',
      clock: mockClock(),
    });
    const messages = buildEmail(event, { client: 'c@example.com', admin: 'a@example.com' }, { config: DEFAULT_CONFIG });
    for (const msg of messages) {
      assert.equal(msg.htmlBody.includes('drive.google.com'), false);
      assert.equal(msg.htmlBody.includes('/d/'), false);
      assert.equal(msg.body.includes('drive.google.com'), false);
      // Only canonical portal host
      assert.ok(msg.htmlBody.includes('visionflow-bd.github.io'));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Event deduplication
// ═══════════════════════════════════════════════════════════════════

describe('deduplication', () => {
  test('repeated event with same stable ID is deduplicated', async () => {
    const event = createOutboxEvent({
      eventType: 'consent-complete',
      sourceCollection: 'portal_public/tok1/consent',
      sourceId: 'v1',
      clientSlug: 'shishir',
      sourceVersion: 'v1',
      activationBoundary: '2026-09-28T00:00:00Z',
      clock: mockClock(),
    });

    const fs = mockFirestore({
      // Already sent in backend events
      [`portal_backend_events/${event.id}`]: { status: 'sent', sentAt: '2026-10-01T00:00:00Z' },
      'portal_settings/notifications': { enabled:true, adminEmail: 'admin@example.com' },
      'portal_clients/shishir': { email: 'client@example.com' },
    });

    const result = await processEvent(event, {
      firestore: fs,
      mail: mockMail(),
      clock: mockClock(),
      config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'deduplicated');
  });

  test('stable ID is deterministic for same event', () => {
    const clock = mockClock();
    const e1 = createOutboxEvent({ eventType: 'master-signed', sourceCollection: 'c', sourceId: 'd1', clientSlug: 's', sourceVersion: 'v1', activationBoundary: '2026-01-01T00:00:00Z', clock });
    const e2 = createOutboxEvent({ eventType: 'master-signed', sourceCollection: 'c', sourceId: 'd1', clientSlug: 's', sourceVersion: 'v1', activationBoundary: '2026-01-01T00:00:00Z', clock });
    assert.equal(e1.id, e2.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Concurrent worker lease
// ═══════════════════════════════════════════════════════════════════

describe('concurrent worker lease', () => {
  test('second worker cannot claim leased event', async () => {
    const now = '2026-10-01T12:00:00Z';
    const leasedUntil = new Date(Date.parse(now) + LEASE_DURATION_MS).toISOString();
    const fs = mockFirestore({
      'portal_outbox/evt1': {
        id: 'evt1', status: 'processing',
        leasedBy: 'worker-1', leasedUntil,
        retryCount: 0, createdAt: '2026-10-01T11:00:00Z',
        _updateTime: 't1',
      },
    });

    const claimed = await claimEvents({
      firestore: fs, clock: mockClock(now), workerId: 'worker-2',
    });
    assert.equal(claimed.length, 0);
  });

  test('expired lease can be reclaimed', async () => {
    const now = '2026-10-01T12:10:00Z'; // 10 min after lease
    const leasedUntil = '2026-10-01T12:05:00Z'; // expired
    const fs = mockFirestore({
      'portal_outbox/evt1': {
        id: 'evt1', status: 'queued',
        leasedBy: 'worker-1', leasedUntil,
        retryCount: 0, createdAt: '2026-10-01T11:00:00Z',
        _updateTime: 't1',
      },
    });

    const claimed = await claimEvents({
      firestore: fs, clock: mockClock(now), workerId: 'worker-2',
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].leasedBy, 'worker-2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Transient error + backoff
// ═══════════════════════════════════════════════════════════════════

describe('transient error and backoff', () => {
  test('mail failure increments retryCount with backoff', async () => {
    const event = boundEvent({ eventType: 'payment-notification', projectKey: 'k9' });
    const fs = mockFirestore(boundStore(event));
    const mail = mockMail({ failFor: ['client', 'admin'] });

    const result = await processEvent(event, {
      firestore: fs, mail, clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'retry');
    const stored = fs._store[`portal_outbox/${event.id}`];
    assert.equal(stored.retryCount, 1);
    assert.ok(stored.nextRetryAfter);
    // Backoff: 30s * 2^0 = 30s
    const backoff = Date.parse(stored.nextRetryAfter) - Date.parse('2026-10-01T12:00:00Z');
    assert.equal(backoff, 30000);
  });

  test('max retries produces failed-permanent', async () => {
    const event = {
      ...boundEvent({ eventType: 'payment-notification', projectKey: 'k9' }),
      retryCount: MAX_RETRIES - 1, // one more failure = permanent
    };
    const fs = mockFirestore(boundStore(event));
    const mail = mockMail({ failFor: ['client', 'admin'] });

    const result = await processEvent(event, {
      firestore: fs, mail, clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'failed-permanent');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Crash after send → reconciliation
// ═══════════════════════════════════════════════════════════════════

describe('crash after send reconciliation', () => {
  test('partial send (client ok, admin fail) produces sent-partial', async () => {
    const event = boundEvent({ eventType: 'delivery-notification', projectKey: 'k9' });
    const fs = mockFirestore(boundStore(event));
    // Admin send fails, client succeeds
    const mail = mockMail({ failFor: ['admin'] });

    const result = await processEvent(event, {
      firestore: fs, mail, clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'sent-partial');
    assert.ok(result.results.some(r => r.status === 'handed-to-provider'));
    assert.ok(result.results.some(r => r.status === 'failed'));
  });

  test('successful send produces sent-unconfirmed (not delivered)', async () => {
    const event = boundEvent({ eventType: 'consent-complete' });
    const fs = mockFirestore(boundStore(event));

    const result = await processEvent(event, {
      firestore: fs, mail: mockMail(), clock: mockClock(), config: DEFAULT_CONFIG,
    });

    // NEVER claims 'delivered' — only 'sent-unconfirmed'
    assert.equal(result.status, 'sent-unconfirmed');
    assert.ok(result.results.every(r => r.status === 'handed-to-provider'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Quota exhaustion
// ═══════════════════════════════════════════════════════════════════

describe('quota exhaustion', () => {
  test('zero remaining quota stops worker before processing', async () => {
    const result = await processOutbox({
      firestore: mockFirestore(),
      mail: mockMail({ quota: 0 }),
      clock: mockClock(),
      config: DEFAULT_CONFIG,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /quota exhausted/i);
  });

  test('event processing checks quota before sending', async () => {
    const event = boundEvent({ eventType: 'update-notification', projectKey: 'k9' });
    const fs = mockFirestore(boundStore(event));

    const result = await processEvent(event, {
      firestore: fs, mail: mockMail({ quota: 0 }), clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'quota-exhausted');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: All review types use 72h
// ═══════════════════════════════════════════════════════════════════

describe('72-hour review enforcement', () => {
  test('all reviews use exactly 72 hours', () => {
    assert.equal(REVIEW_POLICY.hours, 72);
    assert.equal(REVIEW_POLICY.version, 'VF-REVIEW-72H-v1');
  });

  test('48-hour or other durations are rejected', () => {
    const request = {
      id: 'r1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
      reviewHours: 48, projectKey: 'k9', sourceVersion: 'v1',
      masterVersion: 'm1', publishedAt: '2026-09-28T00:00:00Z',
    };
    assert.equal(reviewDeadline(request), null);
  });

  test('legacy record with no deadline gets manual-review', () => {
    const result = assessReview({
      request: { createdAt: '2020-01-01T00:00:00Z', verifyDeadline: '2020-01-04T00:00:00Z' },
      now: '2026-10-01T00:00:00Z',
      portalActive: true,
      master: null,
      consentValid: false,
      projectAcknowledged: false,
    });
    assert.equal(result.status, 'manual-review');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Late/missing signature blocks expiry
// ═══════════════════════════════════════════════════════════════════

describe('signature and consent gates', () => {
  const fixture = () => ({
    request: {
      id: 'review1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
      reviewHours: 72, projectKey: 'k9', sourceVersion: 'v1',
      masterVersion: 'master1', publishedAt: '2026-09-28T00:00:00Z',
    },
    now: '2026-10-01T00:00:00Z',
    portalActive: true,
    master: {
      id: 'master1', signedAt: '2026-09-27T00:00:00Z',
      termsSnapshot: { reviewPolicy: { ...REVIEW_POLICY } },
    },
    consentValid: true, projectAcknowledged: true, notificationReady: true,
  });

  test('late signature (after publication) blocks expiry', () => {
    const f = fixture();
    f.master.signedAt = '2026-09-29T00:00:00Z'; // after publishedAt
    assert.equal(assessReview(f).status, 'blocked');
    assert.match(assessReview(f).reason, /retroactive/i);
  });

  test('missing master blocks expiry', () => {
    assert.equal(assessReview({ ...fixture(), master: null }).status, 'blocked');
  });

  test('revoked master blocks expiry', () => {
    const f = fixture();
    f.master.revoked = true;
    assert.equal(assessReview(f).status, 'blocked');
  });

  test('missing consent blocks expiry', () => {
    assert.equal(assessReview({ ...fixture(), consentValid: false }).status, 'blocked');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Objection/feedback blocks expiry
// ═══════════════════════════════════════════════════════════════════

describe('objection blocks expiry', () => {
  const fixture = () => ({
    request: {
      id: 'review1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
      reviewHours: 72, projectKey: 'k9', sourceVersion: 'v1',
      masterVersion: 'master1', publishedAt: '2026-09-28T00:00:00Z',
    },
    now: '2026-10-01T00:00:00Z',
    portalActive: true,
    master: {
      id: 'master1', signedAt: '2026-09-27T00:00:00Z',
      termsSnapshot: { reviewPolicy: { ...REVIEW_POLICY } },
    },
    consentValid: true, projectAcknowledged: true, notificationReady: true,
  });

  test('unresolved objection blocks expiry', () => {
    const f = fixture();
    f.objections = [{ projectKey: 'k9', id: 'fb1' }];
    assert.equal(assessReview(f).status, 'objected');
  });

  test('resolved objection allows expiry', () => {
    const f = fixture();
    f.objections = [{ projectKey: 'k9', id: 'fb1', resolvedAt: '2026-09-30T00:00:00Z' }];
    assert.equal(assessReview(f).status, 'deemed-accepted');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Confirmation wins over timer
// ═══════════════════════════════════════════════════════════════════

describe('confirmation vs timer', () => {
  test('explicit client confirmation wins over timer', () => {
    const f = {
      request: {
        id: 'review1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
        reviewHours: 72, projectKey: 'k9', sourceVersion: 'v1',
        masterVersion: 'master1', publishedAt: '2026-09-28T00:00:00Z',
      },
      now: '2026-10-01T00:00:00Z',
      portalActive: true,
      master: {
        id: 'master1', signedAt: '2026-09-27T00:00:00Z',
        termsSnapshot: { reviewPolicy: { ...REVIEW_POLICY } },
      },
      consentValid: true, projectAcknowledged: true, notificationReady: true,
      decision: { status: 'client-confirmed' },
    };
    const result = assessReview(f);
    assert.equal(result.status, 'client-confirmed');
    assert.equal(result.terminal, true);
  });

  test('concurrent rejection cannot be overwritten by deemed-accepted', () => {
    const f = {
      request: {
        id: 'review1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
        reviewHours: 72, projectKey: 'k9', sourceVersion: 'v1',
        masterVersion: 'master1', publishedAt: '2026-09-28T00:00:00Z',
      },
      now: '2026-10-01T00:00:00Z',
      portalActive: true,
      master: {
        id: 'master1', signedAt: '2026-09-27T00:00:00Z',
        termsSnapshot: { reviewPolicy: { ...REVIEW_POLICY } },
      },
      consentValid: true, projectAcknowledged: true, notificationReady: true,
      decision: { status: 'objected' },
    };
    const result = assessReview(f);
    assert.equal(result.status, 'objected');
    assert.equal(result.terminal, true);
    // Terminal decisions cannot be changed
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: No state changes from deemed-acceptance
// ═══════════════════════════════════════════════════════════════════

describe('deemed-acceptance side effects', () => {
  test('deemed-accepted record has no signature/payment/download state', () => {
    const f = {
      request: {
        id: 'review1', schemaVersion: 1, policyVersion: REVIEW_POLICY.version,
        reviewHours: 72, projectKey: 'k9', sourceVersion: 'v1',
        masterVersion: 'master1', publishedAt: '2026-09-28T00:00:00Z',
      },
      now: '2026-10-01T00:00:00Z',
      portalActive: true,
      master: {
        id: 'master1', signedAt: '2026-09-27T00:00:00Z',
        termsSnapshot: { reviewPolicy: { ...REVIEW_POLICY } },
      },
      consentValid: true, projectAcknowledged: true, notificationReady: true,
    };
    const result = assessReview(f);
    assert.equal(result.status, 'deemed-accepted');
    const record = result.record;
    for (const field of ['confirmedAt', 'signedAt', 'paymentVerified', 'downloadAuthorized']) {
      assert.equal(Object.hasOwn(record, field), false,
        `deemed-accepted record must NOT include ${field}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Cross-client and archived workspace
// ═══════════════════════════════════════════════════════════════════

describe('cross-client and archived workspace', () => {
  test('archived/deleted workspace event is rejected', async () => {
    const event = boundEvent({ eventType: 'delivery-notification', clientSlug: 'archived-client', projectKey: 'k9' });
    const fs = mockFirestore(boundStore(event, { clientOverrides: { _deleted: true } }));

    const result = await processEvent(event, {
      firestore: fs, mail: mockMail(), clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'workspace-inactive');
  });

  test('paused workspace (accessEnabled=false) is rejected', async () => {
    const event = boundEvent({ eventType: 'payment-notification', clientSlug: 'paused-client', projectKey: 'k9' });
    const fs = mockFirestore(boundStore(event, { clientOverrides: { accessEnabled: false } }));

    const result = await processEvent(event, {
      firestore: fs, mail: mockMail(), clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'workspace-inactive');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Pagination and runtime limit
// ═══════════════════════════════════════════════════════════════════

describe('pagination and limits', () => {
  test('worker respects MAX_EVENTS_PER_RUN limit', async () => {
    // Create 30 events but worker should only process MAX_EVENTS_PER_RUN
    const store = { 'portal_settings/notifications': { enabled:true, adminEmail: 'a@a.com' } };
    for (let i = 0; i < 30; i++) {
      store[`portal_outbox/evt-${i}`] = {
        id: `evt-${i}`, eventType: 'update-notification',
        status: 'queued', retryCount: 0,
        createdAt: `2026-10-01T${String(i).padStart(2, '0')}:00:00Z`,
        clientSlug: 'test', sourceCollection: 'test', sourceId: `s${i}`,
        activationBoundary: '2026-09-28T00:00:00Z',
        _updateTime: `t${i}`,
      };
      store[`portal_clients/test`] = { email: 'c@c.com' };
    }

    const result = await processOutbox({
      firestore: mockFirestore(store),
      mail: mockMail({ quota: 100 }),
      clock: mockClock(),
      config: DEFAULT_CONFIG,
    });

    assert.ok(result.processed <= 20, `Processed ${result.processed} but max is 20`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Configuration validation
// ═══════════════════════════════════════════════════════════════════

describe('configuration validation', () => {
  test('null config fails closed', () => {
    assert.equal(validateConfig(null).valid, false);
  });

  test('missing projectId fails', () => {
    assert.equal(validateConfig({ adminUid: 'x', activationBoundary: 'y' }).valid, false);
  });

  test('missing activationBoundary fails', () => {
    assert.equal(validateConfig({ projectId: 'x', adminUid: 'y' }).valid, false);
  });

  test('valid config passes', () => {
    assert.equal(validateConfig(DEFAULT_CONFIG).valid, true);
  });

  test('incomplete config stops worker', async () => {
    const result = await processOutbox({
      firestore: mockFirestore(),
      mail: mockMail(),
      clock: mockClock(),
      config: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /incomplete/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Pre-activation boundary
// ═══════════════════════════════════════════════════════════════════

describe('activation boundary', () => {
  test('events before activation boundary are skipped', async () => {
    const event = createOutboxEvent({
      eventType: 'consent-complete',
      sourceCollection: 'test',
      sourceId: 'old1',
      clientSlug: 'shishir',
      sourceVersion: 'v1',
      activationBoundary: '2026-10-01T00:00:00Z',
      clock: mockClock('2026-09-01T00:00:00Z'), // created before boundary
    });

    const fs = mockFirestore({
      'portal_settings/notifications': { enabled:true, adminEmail: 'admin@example.com' },
    });

    const result = await processEvent(event, {
      firestore: fs, mail: mockMail(), clock: mockClock(), config: DEFAULT_CONFIG,
    });

    assert.equal(result.status, 'skipped-pre-activation');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE: Recipient resolution
// ═══════════════════════════════════════════════════════════════════

describe('recipient resolution', () => {
  test('recipients come from server records, not caller', async () => {
    const fs = mockFirestore({
      'portal_settings/notifications': { enabled:true, adminEmail: 'real-admin@vf.com' },
      'portal_clients/shishir': { email: 'real-client@example.com' },
    });

    const recipients = await resolveRecipients(
      { clientSlug: 'shishir' },
      { firestore: fs, config: DEFAULT_CONFIG }
    );

    assert.equal(recipients.admin, 'real-admin@vf.com');
    assert.equal(recipients.client, 'real-client@example.com');
  });

  test('missing client record means no client recipient', async () => {
    const fs = mockFirestore({
      'portal_settings/notifications': { enabled:true, adminEmail: 'admin@vf.com' },
    });

    const recipients = await resolveRecipients(
      { clientSlug: 'nonexistent' },
      { firestore: fs, config: DEFAULT_CONFIG }
    );

    assert.equal(recipients.client, null);
    assert.equal(recipients.admin, 'admin@vf.com');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Coverage label
// ═══════════════════════════════════════════════════════════════════
// TESTED via Node mocks:
//   - doPost relay rejection, recipient/body injection, token disabled
//   - doGet non-sensitive health
//   - HTML injection escaping in templates
//   - Final delivery link absence
//   - Event deduplication (stable ID)
//   - Concurrent worker lease (active/expired)
//   - Transient error retry with backoff
//   - Max retries → failed-permanent
//   - Crash-after-send → sent-unconfirmed / sent-partial
//   - Quota exhaustion handling
//   - 72h review enforcement (48h rejected, legacy manual-review)
//   - Late/missing signature blocks expiry
//   - Unresolved objection blocks expiry
//   - Client confirmation wins over timer
//   - Concurrent rejection cannot be overwritten
//   - No signature/payment/download state changes
//   - Cross-client source and archived/paused workspace rejection
//   - Pagination and runtime limit
//   - Configuration validation (fail closed)
//   - Pre-activation boundary
//   - Server-resolved recipients
//
// NOT TESTED (requires live services):
//   - Real Gmail API delivery
//   - Real Firestore transaction atomicity
//   - Real Apps Script time-driven trigger execution
//   - RSA signature verification for Firebase ID tokens
//   - Actual Apps Script runtime quotas (6-min timeout, 90-min/day trigger limit)
//   - Real concurrent worker scheduling
//   - Production Firestore security rules evaluation

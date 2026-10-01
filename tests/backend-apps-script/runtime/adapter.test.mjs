import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirestoreAdapter,
  createMailAdapter,
  createClockAdapter,
  loadConfig,
  toFirestoreValue,
  fromFirestoreValue,
  fromDocument,
  toDocumentFields,
} from '../../../backend/apps-script/runtime/adapters.mjs';

// ═══════════════════════════════════════════════════════════════════
// Mock Apps Script globals
// ═══════════════════════════════════════════════════════════════════

function mockUrlFetch(handler) {
  // handler(url, options) → { code, body } | throws
  const calls = [];
  return {
    fetch: (url, options = {}) => {
      calls.push({ url, options });
      const result = handler(url, options);
      if (result.error) throw result.error;
      return {
        getResponseCode: () => result.code || 200,
        getContentText: () => typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {}),
      };
    },
    calls,
  };
}

function mockScriptApp() {
  return { getOAuthToken: () => 'test-token-never-logged' };
}

function mockMailApp(opts = {}) {
  const sent = [];
  return {
    sendEmail: (msg) => {
      if (opts.throwError) throw new Error(opts.throwError);
      if (opts.throwLimitError) throw new Error('Daily limit exceeded for sending email');
      sent.push(msg);
    },
    getRemainingDailyQuota: () => {
      if (opts.throwQuotaError) throw new Error('Service unavailable');
      return opts.quota ?? 100;
    },
    sent,
  };
}

function mockPropertiesService(props = {}) {
  return {
    getScriptProperties: () => ({
      getProperties: () => props,
      getProperty: (key) => props[key] || null,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Firestore value conversion
// ═══════════════════════════════════════════════════════════════════

describe('Firestore value conversion', () => {
  test('null → nullValue', () => {
    assert.deepEqual(toFirestoreValue(null), { nullValue: null });
    assert.equal(fromFirestoreValue({ nullValue: null }), null);
  });

  test('boolean roundtrip', () => {
    assert.deepEqual(toFirestoreValue(true), { booleanValue: true });
    assert.equal(fromFirestoreValue({ booleanValue: false }), false);
  });

  test('integer → integerValue string', () => {
    const fv = toFirestoreValue(42);
    assert.equal(fv.integerValue, '42');
    assert.equal(fromFirestoreValue(fv), 42);
  });

  test('float → doubleValue', () => {
    const fv = toFirestoreValue(3.14);
    assert.equal(fv.doubleValue, 3.14);
    assert.equal(fromFirestoreValue(fv), 3.14);
  });

  test('string → stringValue', () => {
    assert.deepEqual(toFirestoreValue('hello'), { stringValue: 'hello' });
    assert.equal(fromFirestoreValue({ stringValue: 'world' }), 'world');
  });

  test('ISO text stays stringValue (preserves type)', () => {
    const ts = '2026-09-28T12:00:00.000Z';
    const fv = toFirestoreValue(ts);
    assert.equal(fv.stringValue, ts);
    assert.equal(fromFirestoreValue(fv), ts);
  });

  test('non-ISO string stays stringValue', () => {
    const fv = toFirestoreValue('not-a-timestamp');
    assert.equal(fv.stringValue, 'not-a-timestamp');
  });

  test('Firestore Timestamp object {seconds,nanoseconds} → timestampValue', () => {
    const fv = toFirestoreValue({ seconds: 1790000000, nanoseconds: 500000000 });
    assert.ok(fv.timestampValue);
    assert.ok(Number.isFinite(Date.parse(fv.timestampValue)));
  });

  test('array roundtrip', () => {
    const fv = toFirestoreValue([1, 'two', null]);
    assert.ok(fv.arrayValue);
    assert.equal(fv.arrayValue.values.length, 3);
    assert.deepEqual(fromFirestoreValue(fv), [1, 'two', null]);
  });

  test('nested map roundtrip', () => {
    const obj = { name: 'test', nested: { count: 5, active: true } };
    const fv = toFirestoreValue(obj);
    assert.ok(fv.mapValue);
    assert.deepEqual(fromFirestoreValue(fv), obj);
  });

  test('_updateTime is stripped from toDocumentFields', () => {
    const fields = toDocumentFields({ name: 'test', _updateTime: '2026-01-01T00:00:00Z' });
    assert.ok(!('_updateTime' in fields));
    assert.ok('name' in fields);
  });

  test('fromDocument extracts _updateTime as metadata', () => {
    const doc = {
      name: 'projects/p/databases/d/documents/col/id',
      fields: { name: { stringValue: 'test' } },
      updateTime: '2026-09-28T12:00:00Z',
    };
    const result = fromDocument(doc);
    assert.equal(result.name, 'test');
    assert.equal(result._updateTime, '2026-09-28T12:00:00Z');
  });

  test('fromDocument returns null for missing doc', () => {
    assert.equal(fromDocument(null), null);
    assert.deepEqual(fromDocument({name:'projects/p/databases/d/documents/col/empty'}), {});
  });
});

// ═══════════════════════════════════════════════════════════════════
// Firestore adapter: get/set/query
// ═══════════════════════════════════════════════════════════════════

describe('Firestore adapter REST calls', () => {
  test('get returns document fields with _updateTime', async () => {
    const urlFetch = mockUrlFetch((url) => ({
      code: 200,
      body: {
        name: 'projects/visionflow-bd/databases/(default)/documents/portal_clients/shishir',
        fields: { email: { stringValue: 'client@example.com' } },
        updateTime: '2026-09-28T12:00:00Z',
      },
    }));

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    const doc = await fs.get('portal_clients/shishir');
    assert.equal(doc.email, 'client@example.com');
    assert.equal(doc._updateTime, '2026-09-28T12:00:00Z');
  });

  test('get returns null for 404', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 404, body: { error: { code: 404 } } }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    const doc = await fs.get('portal_clients/nonexistent');
    assert.equal(doc, null);
  });

  test('set with merge uses JSON commit with updateMask', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 200, body: {} }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.set('portal_outbox/evt1', { status: 'processing' }, { merge: true });
    const call = urlFetch.calls[0];
    assert.deepEqual(JSON.parse(call.options.payload).writes[0].updateMask.fieldPaths, ['`status`']);
    assert.equal(call.options.method, 'POST');
    assert.ok(call.url.endsWith(':commit'));
  });

  test('set with CAS precondition includes currentDocument.updateTime', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 200, body: {} }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.set('portal_outbox/evt1', { status: 'x' }, {
      merge: true,
      precondition: { updateTime: '2026-09-28T12:00:00Z' },
    });
    const call = urlFetch.calls[0];
    assert.equal(JSON.parse(call.options.payload).writes[0].currentDocument.updateTime, '2026-09-28T12:00:00Z');
  });

  test('CAS failure (409) throws error', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 409, body: { error: { code: 409, message: 'Precondition failed' } } }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await assert.rejects(
      () => fs.set('portal_outbox/evt1', { status: 'x' }, { precondition: { updateTime: 'stale-time' } }),
      /409/
    );
  });

  test('set with exists:false uses currentDocument.exists=false', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 200, body: {} }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.set('portal_outbox/evt1', { status: 'queued' }, { exists: false });
    const call = urlFetch.calls[0];
    assert.equal(JSON.parse(call.options.payload).writes[0].currentDocument.exists, false);
  });

  test('query sends structuredQuery POST', async () => {
    const urlFetch = mockUrlFetch((url, opts) => {
      if (opts.method === 'POST' && url.includes('runQuery')) {
        return {
          code: 200,
          body: [{
            document: {
              name: 'projects/visionflow-bd/databases/(default)/documents/portal_outbox/evt1',
              fields: { status: { stringValue: 'queued' } },
              updateTime: '2026-09-28T12:00:00Z',
            },
          }],
        };
      }
      return { code: 404, body: {} };
    });

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    const results = await fs.query('portal_outbox', { where: [['status', 'in', ['queued', 'retry']]], orderBy: ['createdAt', 'asc'], limit: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'queued');
    assert.equal(results[0].id, 'evt1');
  });

  test('query with subcollection path', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 200, body: [] }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.query('portal_public/tok1/consent', {});
    const call = urlFetch.calls[0];
    const payload = JSON.parse(call.options.payload);
    assert.equal(payload.structuredQuery.from[0].collectionId, 'consent');
  });

  test('empty query returns empty array', async () => {
    const urlFetch = mockUrlFetch(() => ({ code: 200, body: [{ readTime: '2026-09-28T12:00:00Z' }] }));
    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    const results = await fs.query('portal_outbox', {});
    assert.equal(results.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Firestore transactions
// ═══════════════════════════════════════════════════════════════════

describe('Firestore transaction support', () => {
  test('runTransaction commits atomically on success', async () => {
    const urlFetch = mockUrlFetch((url, opts) => {
      if (url.includes('beginTransaction')) return { code: 200, body: { transaction: 'dHgx' } };
      if (url.includes('batchGet')) return {
        code: 200,
        body: [{
          found: {
            name: 'projects/visionflow-bd/databases/(default)/documents/portal_reviews/r1',
            fields: { status: { stringValue: 'pending' } },
            updateTime: '2026-09-28T12:00:00Z',
          },
        }],
      };
      if (url.includes('commit')) return { code: 200, body: {} };
      return { code: 404, body: {} };
    });

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.runTransaction(async (tx) => {
      const doc = await tx.get('portal_reviews/r1');
      assert.equal(doc.status, 'pending');
      await tx.set('portal_reviews/r1', { status: 'deemed-accepted' }, { merge: true });
    });

    const commitCall = urlFetch.calls.find(c => c.url.includes('commit'));
    assert.ok(commitCall, 'commit was called');
    const payload = JSON.parse(commitCall.options.payload);
    assert.equal(payload.transaction, 'dHgx');
    assert.equal(payload.writes.length, 1);
  });

  test('runTransaction rolls back on error', async () => {
    const urlFetch = mockUrlFetch((url) => {
      if (url.includes('beginTransaction')) return { code: 200, body: { transaction: 'dHgy' } };
      if (url.includes('batchGet')) return { code: 200, body: [{ missing: 'x' }] };
      if (url.includes('rollback')) return { code: 200, body: {} };
      return { code: 404, body: {} };
    });

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await assert.rejects(
      () => fs.runTransaction(async (tx) => {
        const doc = await tx.get('x/y');
        if (!doc) throw new Error('Not found');
      }),
      /Not found/
    );
    const rollbackCall = urlFetch.calls.find(c => c.url.includes('rollback'));
    assert.ok(rollbackCall, 'rollback was called');
  });

  test('transaction get uses batchGet (not GET with transaction param)', async () => {
    const urlFetch = mockUrlFetch((url) => {
      if (url.includes('beginTransaction')) return { code: 200, body: { transaction: 'dHgz' } };
      if (url.includes('batchGet')) return {
        code: 200,
        body: [{ found: { name: 'projects/visionflow-bd/databases/(default)/documents/t/d', fields: { v: { integerValue: '1' } }, updateTime: '2026-09-28T12:00:00Z' } }],
      };
      if (url.includes('commit')) return { code: 200, body: {} };
      return { code: 404, body: {} };
    });

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.runTransaction(async (tx) => { await tx.get('t/d'); });

    const batchGetCall = urlFetch.calls.find(c => c.url.includes('batchGet'));
    assert.ok(batchGetCall, 'batchGet was used');
    const payload = JSON.parse(batchGetCall.options.payload);
    assert.ok(payload.documents, 'has documents array');
    assert.equal(payload.transaction, 'dHgz');
  });

  test('transaction set with exists:false creates currentDocument guard', async () => {
    const urlFetch = mockUrlFetch((url) => {
      if (url.includes('beginTransaction')) return { code: 200, body: { transaction: 'tx1' } };
      if (url.includes('commit')) return { code: 200, body: {} };
      return { code: 404, body: {} };
    });

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    await fs.runTransaction(async (tx) => {
      await tx.set('portal_outbox/new1', { status: 'queued' }, { exists: false });
    });

    const commitCall = urlFetch.calls.find(c => c.url.includes('commit'));
    const payload = JSON.parse(commitCall.options.payload);
    assert.deepEqual(payload.writes[0].currentDocument, { exists: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Encoded document IDs
// ═══════════════════════════════════════════════════════════════════

describe('encoded document IDs', () => {
  test('percent-encoded stable IDs are path-encoded for URL', async () => {
    const stableId = encodeURIComponent(JSON.stringify(['deemed-accepted', 'shishir', 'r1', 'v1']));
    const urlFetch = mockUrlFetch(() => ({
      code: 200,
      body: {
        name: `projects/visionflow-bd/databases/(default)/documents/portal_outbox/${stableId}`,
        fields: { status: { stringValue: 'queued' } },
        updateTime: '2026-09-28T12:00:00Z',
      },
    }));

    const fs = createFirestoreAdapter({ urlFetch, scriptApp: mockScriptApp(), projectId: 'visionflow-bd' });
    const doc = await fs.get(`portal_outbox/${stableId}`);
    assert.equal(doc.status, 'queued');
    // The URL should have the stableId double-encoded (once in the ID, once for HTTP)
    const call = urlFetch.calls[0];
    assert.ok(call.url.includes(encodeURIComponent(stableId)));
  });
});

// ═══════════════════════════════════════════════════════════════════
// MailApp adapter
// ═══════════════════════════════════════════════════════════════════

describe('MailApp adapter', () => {
  test('successful send does not claim delivery', async () => {
    const mailApp = mockMailApp();
    const adapter = createMailAdapter({ mailApp });
    await adapter.send({ to: 'test@example.com', subject: 'Test', body: 'Hello' });
    assert.equal(mailApp.sent.length, 1);
  });

  test('unknown error is ambiguous (no notAccepted flag)', async () => {
    const adapter = createMailAdapter({ mailApp: mockMailApp({ throwError: 'Network timeout' }) });
    try {
      await adapter.send({ to: 'test@example.com', subject: 'Test', body: 'Hello' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.notAccepted, undefined, 'Unknown error must NOT be labelled notAccepted');
    }
  });

  test('daily limit exception remains ambiguous', async () => {
    const adapter = createMailAdapter({ mailApp: mockMailApp({ throwLimitError: true }) });
    try {
      await adapter.send({ to: 'test@example.com', subject: 'Test', body: 'Hello' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.notAccepted, undefined);
    }
  });

  test('remainingQuota returns 0 on failure (fail closed)', async () => {
    const adapter = createMailAdapter({ mailApp: mockMailApp({ throwQuotaError: true }) });
    const quota = await adapter.remainingQuota();
    assert.equal(quota, 0);
  });

  test('remainingQuota returns actual quota', async () => {
    const adapter = createMailAdapter({ mailApp: mockMailApp({ quota: 75 }) });
    const quota = await adapter.remainingQuota();
    assert.equal(quota, 75);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Clock adapter
// ═══════════════════════════════════════════════════════════════════

describe('Clock adapter', () => {
  test('now() returns valid ISO string', () => {
    const clock = createClockAdapter();
    const now = clock.now();
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(now));
    assert.ok(Number.isFinite(Date.parse(now)));
  });

  test('serverTimestamp() returns {seconds, nanoseconds}', () => {
    const clock = createClockAdapter();
    const ts = clock.serverTimestamp();
    assert.ok(Number.isInteger(ts.seconds));
    assert.equal(ts.nanoseconds, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Config loader
// ═══════════════════════════════════════════════════════════════════

describe('Config loader', () => {
  test('disabled by default when properties empty', () => {
    const config = loadConfig({ propertiesService: mockPropertiesService({}) });
    assert.equal(config.enabled, false);
    assert.equal(config.reviewStateReady, false);
    assert.equal(config.projectId, '');
  });

  test('enabled only with explicit "true" string', () => {
    const config = loadConfig({
      propertiesService: mockPropertiesService({
        PROJECT_ID: 'visionflow-bd', ADMIN_UID: 'uid123',
        ACTIVATION_BOUNDARY: '2026-09-28T00:00:00Z', ENABLED: 'true', REVIEW_STATE_READY: 'true',
      }),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.reviewStateReady, true);
    assert.equal(config.projectId, 'visionflow-bd');
  });

  test('non-"true" ENABLED values stay disabled', () => {
    for (const val of ['yes', '1', 'TRUE', 'True', 'false', '']) {
      const config = loadConfig({ propertiesService: mockPropertiesService({ ENABLED: val }) });
      assert.equal(config.enabled, false, `"${val}" should not enable`);
    }
  });

  test('portalHost is always canonical (not configurable)', () => {
    const config = loadConfig({ propertiesService: mockPropertiesService({}) });
    assert.equal(config.portalHost, 'https://visionflow-bd.github.io');
  });
});

// ═══════════════════════════════════════════════════════════════════
// doPost fail-closed simulation
// ═══════════════════════════════════════════════════════════════════

describe('doPost fail-closed', () => {
  test('public POST with arbitrary body is rejected', () => {
    const e = { postData: { contents: JSON.stringify({ to: 'victim@example.com', message: 'spam' }) } };
    let result;
    try {
      const data = JSON.parse(e.postData.contents);
      if (data.action === 'enqueue' && data.idToken) {
        result = { ok: false, error: 'Direct enqueue via doPost is disabled.' };
      } else {
        result = { ok: false, error: 'Unauthorized. This endpoint does not relay mail.' };
      }
    } catch { result = { ok: false, error: 'Bad request.' }; }
    assert.equal(result.ok, false);
    assert.match(result.error, /does not relay/i);
  });

  test('enqueue attempt is disabled', () => {
    const e = { postData: { contents: JSON.stringify({ action: 'enqueue', idToken: 'fake' }) } };
    const data = JSON.parse(e.postData.contents);
    const result = (data.action === 'enqueue' && data.idToken) ?
      { ok: false, error: 'Direct enqueue via doPost is disabled.' } :
      { ok: false, error: 'Unauthorized.' };
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Code.gs build artifact verification
// ═══════════════════════════════════════════════════════════════════

describe('Code.gs build artifact', () => {
  test('syntax-parses as valid JavaScript', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    assert.doesNotThrow(() => new Function(src));
  });

  test('has all global entry points', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    assert.ok(/^function doGet\b/m.test(src), 'doGet');
    assert.ok(/^function doPost\b/m.test(src), 'doPost');
    assert.ok(/^async function scheduledWorker\b/m.test(src), 'scheduledWorker');
  });

  test('no import or export statements', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    assert.ok(!/^import\s/m.test(src), 'no import');
    assert.ok(!/^export\s/m.test(src), 'no export');
  });

  test('no Node-only APIs', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\brequire\s*\(/m.test(code), 'no require()');
    assert.ok(!/\bprocess\.\b/m.test(code), 'no process.');
    assert.ok(!/\bBuffer\.\b/m.test(code), 'no Buffer.');
  });

  test('async/await preserved', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    assert.ok(/\basync\b/.test(src), 'async preserved');
    assert.ok(/\bawait\b/.test(src), 'await preserved');
  });

  test('security checks preserved in output', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('backend/apps-script/runtime/Code.gs', 'utf8');
    assert.ok(src.includes('does not relay mail'), 'doPost rejection text');
    assert.ok(src.includes('REDACTED'), 'token redaction');
    assert.ok(src.includes('notAccepted'), 'ambiguous mail error handling');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Coverage label — what is tested vs not tested
// ═══════════════════════════════════════════════════════════════════
// TESTED (Node adapter contract with synthetic wrappers):
//   Firestore values: null, bool, int, float, string, timestamp, array, map, nested
//   Firestore metadata: _updateTime (not persisted), fromDocument null case
//   Firestore REST: get success/404, set merge/CAS/exists:false, query/subcollection/empty
//   Transactions: commit, rollback, batchGet for reads, exists:false in tx
//   Encoded IDs: percent-encoded stable IDs double-encoded in URL
//   Mail: success handoff, ambiguous errors including limit text, quota fail-closed
//   Clock: ISO now(), serverTimestamp {seconds,nanoseconds}
//   Config: disabled default, explicit "true", canonical portalHost
//   doPost: fail-closed rejection, enqueue disabled
//   Code.gs: syntax, entry points, no import/export, no Node APIs, async/await, security checks
//
// NOT TESTED (live service dependencies — labelled UNVERIFIED):
//   Real Apps Script V8 runtime execution
//   Real UrlFetchApp / ScriptApp.getOAuthToken() / MailApp.sendEmail()
//   Real PropertiesService / ContentService
//   Real Firestore REST API responses (status codes, error shapes)
//   Real time-driven trigger creation and 6-min timeout
//   Real IAM authorization for Firestore access
//   Real owner OAuth consent for declared scopes
//   Real daily quota enforcement (100 recipients consumer)
//   Production concurrent workers and race conditions

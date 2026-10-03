// VisionFlow Trusted Backend — Runtime Adapters for Apps Script V8
// Implements the exact adapter contract consumed by worker.mjs and review-worker.mjs.
//
// Official references:
//   Firestore REST: https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents
//   UrlFetchApp:    https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app
//   MailApp:        https://developers.google.com/apps-script/reference/mail/mail-app
//   ScriptApp:      https://developers.google.com/apps-script/reference/script/script-app#getOAuthToken()
//   PropertiesService: https://developers.google.com/apps-script/reference/properties/properties-service
//
// Security:
//   - OAuth token from ScriptApp.getOAuthToken() is NEVER logged, printed or stored.
//   - Tokens are used inline in Authorization headers only.
//   - Error messages strip any token content before surfacing.

// ── Firestore value ↔ JS conversion (module-level) ───────────────
// Reference: https://firebase.google.com/docs/firestore/reference/rest/v1/Value

// Keep wire types distinct from plain application strings/maps. Firestore reads
// must round-trip without silently changing timestamp, reference or bytes types.
class RuntimeTimestamp {
  constructor(iso) {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
    if (!match || !Number.isFinite(Date.parse(iso))) throw new Error('Invalid Firestore timestamp.');
    this.seconds = Date.parse(match[1] + 'Z') / 1000;
    this.nanoseconds = Number((match[2] || '').padEnd(9, '0'));
    this.iso = iso;
  }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  toDate() { return new Date(this.toMillis()); }
  toString() { return this.iso; }
}
class RuntimeWireValue {
  constructor(type, value) { this.type = type; this.value = value; }
}
function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('Unsafe Firestore number.');
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (value && typeof value === 'object') {
    if (value instanceof RuntimeTimestamp) return { timestampValue: value.iso };
    if (value instanceof RuntimeWireValue) return { [value.type]: value.value };
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    // Firestore Timestamp object { seconds, nanoseconds }
    if (typeof value.seconds === 'number' && 'nanoseconds' in value) {
      if (!Number.isSafeInteger(value.seconds) || !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds >= 1e9) throw new Error('Invalid Firestore timestamp.');
      return { timestampValue: new Date(value.seconds * 1000).toISOString().replace(/\.000Z$/, '.' + String(value.nanoseconds).padStart(9, '0') + 'Z') };
    }
    // Plain object → mapValue
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  throw new Error('Unsupported Firestore value.');
}

function fromFirestoreValue(fv) {
  if (!fv || typeof fv !== 'object') return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) {
    const value = Number(fv.integerValue);
    return Number.isSafeInteger(value) ? value : new RuntimeWireValue('integerValue', fv.integerValue);
  }
  if ('doubleValue' in fv) return fv.doubleValue;
  if ('stringValue' in fv) return fv.stringValue;
  if ('timestampValue' in fv) return new RuntimeTimestamp(fv.timestampValue);
  if ('arrayValue' in fv) return (fv.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in fv) {
    const result = {};
    for (const [k, v] of Object.entries(fv.mapValue.fields || {})) result[k] = fromFirestoreValue(v);
    return result;
  }
  for (const type of ['referenceValue', 'geoPointValue', 'bytesValue']) if (type in fv) return new RuntimeWireValue(type, fv[type]);
  throw new Error('Unsupported Firestore wire value.');
}

function fromDocument(doc) {
  if (!doc) return null;
  const result = {};
  for (const [k, v] of Object.entries(doc.fields || {})) result[k] = fromFirestoreValue(v);
  // Expose updateTime as metadata, NOT as a persisted field
  if (doc.updateTime) result._updateTime = doc.updateTime;
  return result;
}

function toDocumentFields(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === '_updateTime' || k === '_path') continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

// ── Firestore REST Adapter ────────────────────────────────────────

function createFirestoreAdapter(deps) {
  const projectId = deps.projectId;
  const databaseId = deps.databaseId || '(default)';
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
  const now = deps.now || Date.now;
  const startedAt = now();
  let calls = 0;
  function checkBudget(requiredCalls=1) {
    // This prevents starting further requests; it cannot interrupt an in-flight
    // synchronous UrlFetchApp request. Never retry a mail send on exhaustion.
    if (calls + requiredCalls > (deps.maxCalls ?? 200) || now() - startedAt >= (deps.maxRuntimeMs ?? 240000)) throw new Error('Firestore runtime budget exhausted.');
  }

  function authHeaders() {
    return { Authorization: 'Bearer ' + deps.scriptApp.getOAuthToken() };
  }

  function fetchJson(url, options = {}, cleanup = false) {
    if (!cleanup) checkBudget();
    calls++;
    let resp;
    try { resp = deps.urlFetch.fetch(url, {
      ...options,
      headers: { ...authHeaders(), 'Content-Type': 'application/json', ...(options.headers || {}) },
      muteHttpExceptions: true,
    }); } catch { throw new Error('Firestore transport outcome unknown.'); }
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code >= 200 && code < 300) {
      try { return body ? JSON.parse(body) : null; }
      catch { throw new Error('Invalid Firestore response.'); }
    }
    // Never surface response bodies: they may contain private records or tokens.
    const err = new Error(`Firestore REST ${code} (response body REDACTED)`);
    err.httpCode = code;
    // Permit only fixed machine-readable reasons, never arbitrary messages or
    // metadata (which can contain resource names and private payloads).
    try {
      const details=JSON.parse(body)?.error?.details;
      if(Array.isArray(details))err.reason=details.map(detail=>detail?.reason).find(reason=>
        ['IAM_PERMISSION_DENIED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','SERVICE_DISABLED','CONSUMER_INVALID'].includes(reason));
    } catch {}
    throw err;
  }

  function docUrl(path) {
    validatePath(path, 0);
    return baseUrl + '/' + path.split('/').map(s => encodeURIComponent(s)).join('/');
  }

  function docName(path) {
    validatePath(path, 0);
    return `projects/${projectId}/databases/${databaseId}/documents/${path}`;
  }

  function validatePath(path, parity) {
    if (typeof path !== 'string') throw new Error('Invalid Firestore path.');
    const segments = path.split('/');
    if (segments.length % 2 !== parity || segments.some(s => !s || s === '.' || s === '..')) throw new Error('Invalid Firestore path.');
  }
  function fieldPath(key) { return '`' + key.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }
  function precondition(options) {
    const p = options.precondition || (typeof options.exists === 'boolean' ? { exists: options.exists } : null);
    if (!p) return null;
    if (typeof p.updateTime === 'string' && Object.keys(p).length === 1) return { updateTime: p.updateTime };
    if (typeof p.exists === 'boolean' && Object.keys(p).length === 1) return { exists: p.exists };
    throw new Error('Invalid Firestore precondition.');
  }

  // ── get ──
  async function get(path) {
    try {
      const doc = fetchJson(docUrl(path));
      return fromDocument(doc);
    } catch (err) {
      if (err.httpCode === 404) return null;
      throw err;
    }
  }

  // ── set ──
  async function set(path, data, options = {}) {
    const fields = toDocumentFields(data);
    if (options.merge && !Object.keys(fields).length) throw new Error('Empty merge is unsupported.');
    const write = { update: { name: docName(path), fields } };
    if (options.merge) write.updateMask = { fieldPaths: Object.keys(fields).map(fieldPath) };
    const condition = precondition(options);
    if (condition) write.currentDocument = condition;
    // Carry Timestamp preconditions in JSON. The emulator PATCH query parser
    // drops currentDocument.updateTime; commit preserves the exact CAS version.
    fetchJson(`${baseUrl}:commit`, { method: 'POST', payload: JSON.stringify({ writes: [write] }) });
  }

  // ── query ──
  async function query(collection, filters = {}) {
    return executeQuery(collection, filters);
  }
  function executeQuery(collection, filters = {}, transaction) {
    validatePath(collection, 1);
    const parts = collection.split('/');
    const collectionId = parts.pop();
    const parent = parts.length > 0 ? docUrl(parts.join('/')) : baseUrl;

    const structuredQuery = { from: [{ collectionId }] };

    if (filters.where && filters.where.length > 0) {
      const fieldFilters = filters.where.map(([field, op, value]) => {
        const opMap = { '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', 'in': 'IN', 'not-in': 'NOT_IN', 'array-contains': 'ARRAY_CONTAINS', 'array-contains-any': 'ARRAY_CONTAINS_ANY' };
        const fsOp = opMap[op];
        if (!fsOp) throw new Error('Unsupported query operator.');
        if (['IN', 'NOT_IN', 'ARRAY_CONTAINS_ANY'].includes(fsOp)) {
          return { fieldFilter: { field: { fieldPath: field }, op: fsOp, value: { arrayValue: { values: value.map(toFirestoreValue) } } } };
        }
        return { fieldFilter: { field: { fieldPath: field }, op: fsOp, value: toFirestoreValue(value) } };
      });
      structuredQuery.where = fieldFilters.length === 1 ? fieldFilters[0] : { compositeFilter: { op: 'AND', filters: fieldFilters } };
    }

    if (filters.orderBy) {
      const orders = typeof filters.orderBy === 'string' ? [[filters.orderBy, 'asc']] : Array.isArray(filters.orderBy[0]) ? filters.orderBy : [filters.orderBy];
      structuredQuery.orderBy = orders.map(([field, dir = 'asc']) => {
        if (!['asc', 'desc'].includes(dir)) throw new Error('Invalid query order.');
        return { field: { fieldPath: field }, direction: dir === 'desc' ? 'DESCENDING' : 'ASCENDING' };
      });
    }
    if (filters.limit) structuredQuery.limit = filters.limit;
    if (filters.startAfterId !== undefined) {
      if(typeof filters.startAfterId!=='string'||filters.startAfterId.includes('/')||!filters.startAfterId||filters.startAfter!==undefined)throw new Error('Invalid document cursor.');
      validatePath(`${collection}/${filters.startAfterId}`,0);
      structuredQuery.startAt={values:[{referenceValue:`projects/${projectId}/databases/${databaseId}/documents/${collection}/${filters.startAfterId}`}],before:false};
    }
    if (filters.startAfter !== undefined) {
      // Full ordered values including a document-name tie breaker can be passed
      // as {values:[..., {referenceValue:doc.name}]} in Firestore wire form.
      const values = filters.startAfter?.values || [toFirestoreValue(filters.startAfter)];
      if (!Array.isArray(values) || !values.length) throw new Error('Invalid query cursor.');
      structuredQuery.startAt = { values, before: false };
    }

    const url = `${parent}:runQuery`;
    const results = fetchJson(url, { method: 'POST', payload: JSON.stringify({ structuredQuery, ...(transaction ? {transaction} : {}) }) });
    return (results || []).filter(r => r.document).map(r => {
      const doc = fromDocument(r.document);
      return { ...doc, id: r.document.name.split('/').pop() };
    });
  }

  // ── Transactions ──
  function beginTransaction() {
    const result = fetchJson(`${baseUrl}:beginTransaction`, { method: 'POST', payload: JSON.stringify({}) });
    if (!result || typeof result.transaction !== 'string' || !result.transaction) throw new Error('Missing Firestore transaction identity.');
    return result.transaction;
  }

  // batchGet for transaction reads (NOT GET with transaction param — emulator BYTE_STRING fix)
  // Reference: https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/batchGet
  function transactionGet(txId, path) {
    const batchUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:batchGet`;
    const result = fetchJson(batchUrl, {
      method: 'POST',
      payload: JSON.stringify({ documents: [docName(path)], transaction: txId }),
    });
    const item = (result || [])[0];
    if (item && item.found) return fromDocument(item.found);
    return null;
  }

  function transactionQuery(txId, collection, filters = {}) {
    return executeQuery(collection, filters, txId);
  }

  function commitTransaction(txId, writes) {
    fetchJson(`${baseUrl}:commit`, { method: 'POST', payload: JSON.stringify({ transaction: txId, writes }) });
  }

  function rollbackTransaction(txId) {
    try { fetchJson(`${baseUrl}:rollback`, { method: 'POST', payload: JSON.stringify({ transaction: txId }) }, true); } catch { /* transaction expires if cleanup fails */ }
  }

  async function runTransaction(fn) {
    const txId = beginTransaction();
    const pendingWrites = [];
    const tx = {
      get: (path) => transactionGet(txId, path),
      query: (collection, filters) => transactionQuery(txId, collection, filters),
      set: (path, data, options = {}) => {
        const fields = toDocumentFields(data);
        const write = { update: { name: docName(path), fields } };
        if (options.merge && !Object.keys(fields).length) throw new Error('Empty merge is unsupported.');
        if (options.merge) write.updateMask = { fieldPaths: Object.keys(fields).map(fieldPath) };
        const condition = precondition(options);
        if (condition) write.currentDocument = condition;
        pendingWrites.push(write);
      },
    };
    try {
      const result = await fn(tx);
      if (pendingWrites.length > 0) commitTransaction(txId, pendingWrites);
      else rollbackTransaction(txId);
      return result;
    } catch (err) {
      rollbackTransaction(txId);
      throw err;
    }
  }

  return { get, set, query, runTransaction, checkBudget };
}

// ── MailApp Adapter ─────────────────────────────────────────────
// Reference: https://developers.google.com/apps-script/reference/mail/mail-app
// Scope: https://www.googleapis.com/auth/script.send_mail
// Consumer quota: 100 recipients/day

function createMailAdapter(deps) {
  const mailApp = deps.mailApp;
  const readiness=()=>{
    const normalize=value=>typeof value==='string'?value.trim().toLowerCase():'';
    const expected=normalize(deps.expectedSender);
    if(!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(expected))return {ok:false,code:'sender-unconfigured'};
    try {
      const actual=normalize(deps.session.getEffectiveUser().getEmail());
      return {ok:actual===expected,code:actual===expected?'sender-verified':actual?'sender-mismatch':'sender-unavailable'};
    }catch{return {ok:false,code:'sender-unavailable'};}
  };
  return {
    readiness,
    send: async (message) => {
      if(!readiness().ok)throw Object.assign(new Error('Sender identity check failed before mail handoff.'),{notAccepted:true});
      let attachments;
      if(message.paymentDocument){
        try{attachments=[deps.paymentAttachment(message.paymentDocument)];}
        catch{throw Object.assign(new Error('Payment attachment preparation failed before mail handoff.'),{notAccepted:true});}
      }
      try {
        mailApp.sendEmail({
          to: message.to, subject: message.subject, body: message.body,
          htmlBody: message.htmlBody, name: message.name || 'Vision Flow', replyTo: message.replyTo,
          ...(attachments?{attachments}:{}),
        });
      } catch (err) {
        const error = new Error('Mail handoff failed or is uncertain.');
        // Exception text is not proof of nonacceptance. The worker must retain
        // this event for reconciliation, never retry it as an unsent message.
        throw error;
      }
    },
    remainingQuota: async () => {
      try {
        const quota = mailApp.getRemainingDailyQuota();
        return Number.isSafeInteger(quota) && quota >= 0 ? quota : 0;
      } catch { return 0; }
    },
  };
}

// ── Clock Adapter ───────────────────────────────────────────────
function createClockAdapter() {
  return {
    now: () => new Date().toISOString(),
    serverTimestamp: () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }),
  };
}

// ── Config from Script Properties ───────────────────────────────
// MUST be explicitly configured. NO fallback that enables mail when config is absent.
function loadConfig(deps) {
  const props = deps.propertiesService;
  const raw = props.getScriptProperties().getProperties();
  return {
    projectId: raw.PROJECT_ID || '',
    adminUid: raw.ADMIN_UID || '',
    activationBoundary: raw.ACTIVATION_BOUNDARY || '',
    portalHost: 'https://visionflow-bd.github.io',
    replyTo: raw.REPLY_TO || 'visionflow.agency.bd@gmail.com',
    expectedSender: raw.EXPECTED_SENDER || '',
    // Optional owner-controlled staging fence. Empty means normal all-client mode.
    clientScopeSlug: raw.CLIENT_SCOPE_SLUG || '',
    enabled: raw.ENABLED === 'true',
    reviewStateReady: raw.REVIEW_STATE_READY === 'true',
    eventBatchLimit: 4,
  };
}

// ── ESM Exports (build script strips these) ─────────────────────
export {
  createFirestoreAdapter,
  createMailAdapter,
  createClockAdapter,
  loadConfig,
  toFirestoreValue,
  fromFirestoreValue,
  fromDocument,
  toDocumentFields,
};

export function createFakeFirestore(data = {}) {
  const records = {};
  let revision = Math.max(0, ...Object.values(data).map(v => Number(v._updateTime) || 0));

  for (const [k, v] of Object.entries(data)) {
    records[k] = structuredClone(v);
    records[k]._updateTime = String(++revision);
  }

  const store = { records, _records: records, _store: records };

  function readDoc(src, path) {
    const doc = src[path];
    return doc ? structuredClone(doc) : null;
  }

  function flatRecord(path, doc) {
    const seg = path.split('/');
    const id = seg[seg.length - 1];
    const clone = structuredClone(doc);
    return { ...clone, id, _path: path };
  }

  function queryDocs(src, collection, filters, ordering, lim, startAfterId) {
    for (const [, op] of filters) {
      if (!['==', '<', 'in'].includes(op)) throw new Error('Unknown operator: ' + op);
    }
    const prefix = collection + '/';
    let results = [];
    for (const [p, doc] of Object.entries(src)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      if(startAfterId!==undefined&&rest<=startAfterId)continue;
      let match = true;
      for (const [field, op, value] of filters) {
        const v = doc[field];
        if (op === '==') { if (v !== value) match = false; }
        else if (op === '<') { if (!(v < value)) match = false; }
        else if (op === 'in') { if (!Array.isArray(value) || !value.includes(v)) match = false; }
        else throw new Error('Unknown operator: ' + op);
      }
      if (match) results.push({ _internalPath: p, _internalDoc: doc });
    }
    if (ordering && ordering.length) {
      const orders = typeof ordering[0] === 'string' ? [ordering] : ordering;
      results.sort((a, b) => {
        for (const [field, dir] of orders) {
          const av = field==='__name__'?a._internalPath:a._internalDoc[field], bv = field==='__name__'?b._internalPath:b._internalDoc[field];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (lim != null) results = results.slice(0, lim);
    return results;
  }

  function nextVersion() {
    return String(++revision);
  }

  function applySet(target, path, d, opts) {
    const existing = target[path] || null;
    if (opts.exists === false && existing) throw new Error('Document already exists: ' + path);
    if (opts.precondition) {
      const pc = opts.precondition;
      if (pc.exists === true && !existing) throw new Error('Precondition failed: doc missing ' + path);
      if (pc.exists === false && existing) throw new Error('Precondition failed: doc exists ' + path);
      if (pc.updateTime !== undefined && (!existing || existing._updateTime !== pc.updateTime))
        throw new Error('Precondition failed: updateTime mismatch ' + path);
    }
    const ver = nextVersion();
    if (opts.merge && existing) {
      target[path] = { ...existing, ...d, _updateTime: ver };
    } else {
      target[path] = { ...d, _updateTime: ver };
    }
  }

  function deepCloneOpts(opts) {
    return structuredClone(opts);
  }

  store.get = async (path) => readDoc(records, path);

  store.query = async (collection, { where: w = [], orderBy: ob, limit: lim, startAfterId } = {}) => {
    const internal = queryDocs(records, collection, w, ob, lim,startAfterId);
    return internal.map(r => flatRecord(r._internalPath, r._internalDoc));
  };

  store.set = async (path, d, opts = {}) => {
    applySet(records, path, structuredClone(d), deepCloneOpts(opts));
  };

  store.runTransaction = async (fn) => {
    const snapshot = structuredClone(records);
    const readVersions = {};
    const queriedCollections = {};
    const writes = [];

    const tx = {
      get(path) {
        const doc = readDoc(snapshot, path);
        readVersions[path] = doc ? doc._updateTime : null;
        return doc;
      },
      query(collection, opts = {}) {
        const { where: w = [], orderBy: ob, limit: lim } = opts;
        const internal = queryDocs(snapshot, collection, w, ob, lim);
        const membership = {};
        const prefix = collection + '/';
        for (const [p, doc] of Object.entries(snapshot)) {
          if (!p.startsWith(prefix) || p.slice(prefix.length).includes('/')) continue;
          membership[p] = doc._updateTime;
        }
        queriedCollections[collection] = membership;
        for (const r of internal) readVersions[r._internalPath] = r._internalDoc._updateTime;
        return internal.map(r => flatRecord(r._internalPath, r._internalDoc));
      },
      set(path, d, opts = {}) {
        writes.push({ path, data: structuredClone(d), opts: deepCloneOpts(opts) });
      }
    };

    const result = await fn(tx);

    // Validate read versions
    for (const [path, ver] of Object.entries(readVersions)) {
      const cur = records[path] || null;
      const curVer = cur ? cur._updateTime : null;
      if (curVer !== ver) throw new Error('Transaction conflict on ' + path);
    }
    // Validate queried collections (phantom detection)
    for (const [col, membership] of Object.entries(queriedCollections)) {
      const prefix = col + '/';
      const curMembership = {};
      for (const [p, doc] of Object.entries(records)) {
        if (!p.startsWith(prefix) || p.slice(prefix.length).includes('/')) continue;
        curMembership[p] = doc._updateTime;
      }
      const allKeys = new Set([...Object.keys(membership), ...Object.keys(curMembership)]);
      for (const k of allKeys) {
        if ((membership[k] || null) !== (curMembership[k] || null))
          throw new Error('Transaction phantom conflict in ' + col);
      }
    }

    // Build draft from current records
    const draft = {};
    for (const [k, v] of Object.entries(records)) draft[k] = structuredClone(v);

    // Apply all writes to draft
    for (const w of writes) applySet(draft, w.path, w.data, w.opts);

    // Commit: replace records contents atomically
    for (const k of Object.keys(records)) delete records[k];
    for (const [k, v] of Object.entries(draft)) records[k] = v;

    return result;
  };

  return store;
}

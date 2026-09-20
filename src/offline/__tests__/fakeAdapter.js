// A fake RTDB, faithful in the ways that have actually bitten this codebase.
//
// NOT a stub that returns what the test wants. It holds a tree and answers
// queries from it, so a test can write to the tree and then assert what a leg
// reads back — which is the only way a "the feed carries a price change" test
// can be about the feed rather than about the fixture.
//
// THE FIDELITY THAT MATTERS:
//   - an absent node answers null, and so does an EMPTY one. RTDB cannot store
//     an empty object or an empty array; writing one removes the key. A fake
//     that answered {} would hide every bug about telling those apart.
//   - a key range is compared as STRINGS, in RTDB key order.
//   - `readPath` on a missing child answers null, which is how a delete
//     reaches the mirror.
//   - and every method RECORDS ITS OPTIONS. A fake that took only `(path)`
//     let production drop `{ big: true }` — reverting every large setup read
//     from the 30-second budget to the 8-second one, i.e. guaranteed timeouts
//     on a 35.8 MB node — with nothing to see. A fake that ignores an argument
//     lies about the code that ignores the same argument.

export function createFakeRtdb(initial = {}) {
  const tree = structuredClone(initial);

  const at = (path) => {
    let node = tree;
    for (const seg of String(path).split("/").filter(Boolean)) {
      if (node === null || typeof node !== "object") return undefined;
      node = node[seg];
    }
    return node;
  };

  // RTDB removes a key whose value becomes an empty object or array; a read of
  // one therefore answers null, never {}.
  const normalise = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "object" && Object.keys(v).length === 0) return null;
    return structuredClone(v);
  };

  const calls = {
    readPath: [], readPathOpts: [], readKeyPage: [], readChildPage: [],
    subscribeNewChanges: [], writePath: [],
  };
  const signalListeners = new Set();

  const adapter = {
    async readPath(path, opts = {}) {
      calls.readPath.push(path);
      calls.readPathOpts.push({ path, ...opts });
      return normalise(at(path));
    },
    async readKeyPage(path, { after = null, limit = 500, big = false } = {}) {
      calls.readKeyPage.push({ path, after, limit, big });
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const keys = Object.keys(node).sort()
        .filter((k) => after === null || after === undefined || k > after)
        .slice(0, limit);
      if (!keys.length) return null;
      return Object.fromEntries(keys.map((k) => [k, structuredClone(node[k])]));
    },
    async readChildPage(path, field, { from = null, fromKey = null, limit = 500, big = false } = {}) {
      calls.readChildPage.push({ path, field, from, fromKey, limit, big });
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      // RTDB orders by (value, key) and compares strings by UTF-16 code unit —
      // NOT by localeCompare, which is locale-dependent and would order a
      // different ts format differently from the real thing.
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      const rows = Object.entries(node)
        .filter(([, v]) => v && typeof v === "object")
        .sort((a, b) => cmp(String(a[1][field]), String(b[1][field])) || cmp(a[0], b[0]))
        // The two-argument startAt(value, key): inclusive of that exact pair.
        .filter(([k, v]) => {
          if (from === null) return true;
          const t = String(v[field]);
          if (t !== String(from)) return t > String(from);
          return fromKey === null || k >= String(fromKey);
        })
        .slice(0, limit);
      if (!rows.length) return null;
      return Object.fromEntries(rows.map(([k, v]) => [k, structuredClone(v)]));
    },
    async readKeyRange(path, { from = null, to = null, limit = 500 } = {}) {
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const keys = Object.keys(node).sort()
        .filter((k) => (from === null || k >= from) && (to === null || k <= to))
        .slice(0, limit);
      if (!keys.length) return null;
      return Object.fromEntries(keys.map((k) => [k, structuredClone(node[k])]));
    },
    async firstKey(path) {
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const keys = Object.keys(node).sort();
      return keys.length ? keys[0] : null;
    },
    async lastKey(path) {
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const keys = Object.keys(node).sort();
      return keys.length ? keys[keys.length - 1] : null;
    },
    subscribeConnected() { return () => {}; },

    // The live change SIGNAL, and the device's own health WRITE. Both are part
    // of the adapter contract, and a fake that simply lacked them made the
    // engine throw an unhandled TypeError the moment a test drove the real
    // startOfflineMirror — which is how a fake stops standing in for the thing
    // it is standing in for.
    subscribeNewChanges(path, after, onSignal) {
      calls.subscribeNewChanges.push({ path, after });
      signalListeners.add(onSignal);
      return () => signalListeners.delete(onSignal);
    },
    async writePath(path, value) {
      calls.writePath.push({ path, value });
      write(path, value);
      return true;
    },
  };

  // Test-side writers.
  const write = (path, value) => {
    const segs = String(path).split("/").filter(Boolean);
    const last = segs.pop();
    let node = tree;
    for (const s of segs) {
      if (node[s] === undefined || node[s] === null || typeof node[s] !== "object") node[s] = {};
      node = node[s];
    }
    if (value === null || value === undefined) delete node[last];
    else node[last] = structuredClone(value);
  };

  // Fire the live change signal, as one device's write reaches another's tab.
  const signal = (key) => { for (const l of signalListeners) l(key); };

  return { adapter, tree, write, read: (p) => normalise(at(p)), calls, signal };
}

// A push key for a given millisecond, so a test can place a change record at a
// chosen time. Same alphabet as the server and the client.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
export function pushKeyForMs(ms, suffix = "AAAAAAAAAAAA") {
  let n = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < 8; i += 1) { out = PUSH_CHARS[n % 64] + out; n = Math.floor(n / 64); }
  return out + suffix;
}

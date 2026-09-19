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

  const calls = { readPath: [], readKeyPage: [], readChildPage: [] };

  const adapter = {
    async readPath(path) {
      calls.readPath.push(path);
      return normalise(at(path));
    },
    async readKeyPage(path, { after = null, limit = 500 } = {}) {
      calls.readKeyPage.push({ path, after, limit });
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const keys = Object.keys(node).sort()
        .filter((k) => after === null || after === undefined || k > after)
        .slice(0, limit);
      if (!keys.length) return null;
      return Object.fromEntries(keys.map((k) => [k, structuredClone(node[k])]));
    },
    async readChildPage(path, field, { from = null, limit = 500 } = {}) {
      calls.readChildPage.push({ path, field, from, limit });
      const node = at(path);
      if (!node || typeof node !== "object") return null;
      const rows = Object.entries(node)
        .filter(([, v]) => v && typeof v === "object")
        .sort((a, b) => String(a[1][field]).localeCompare(String(b[1][field])))
        .filter(([, v]) => from === null || String(v[field]) >= String(from))
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

  return { adapter, tree, write, read: (p) => normalise(at(p)), calls };
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

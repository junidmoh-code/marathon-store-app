// ─── LINKING NEVER MERGES — /products is read-only to the alias flow ─────────
// (Owner spec 2026-08-12, the Lacoste per-size count fix.) The link panel and
// the per-size auto-link both file through recordLabelCodes; the next scan
// resolves through codeLookup. The proof here: NEITHER action mutates any
// product record — an alias row (and, on conflict, a duplicate-queue row) are
// the only writes. Merging is a human decision made elsewhere, always.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { runLabelAlias } = require("../labelAlias/labelAlias.js");

const NOW = 1786000000000;
const ACTOR = { uid: "staff1" };

// Same faithful RTDB fake as label-alias-codes.test.cjs: empty arrays/objects
// are DELETED on write, exactly like production.
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  let pushN = 0;
  const at = (p) => String(p).split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), data);
  const put = (p, v) => {
    const parts = String(p).split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
    if (v === null) delete node[last]; else node[last] = v;
  };
  const strip = (v) => {
    if (!v || typeof v !== "object") return v;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) {
      if ((Array.isArray(x) && x.length === 0) || (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0)) continue;
      out[k] = strip(x);
    }
    return out;
  };
  const makeRef = (p) => ({
    async get() { const v = at(p); const val = v === undefined ? null : v; return { val: () => val, exists: () => val !== null }; },
    async set(v) { put(p, strip(v)); },
    async update(patch) { for (const [k, v] of Object.entries(patch)) put(`${p}/${k}`, v); },
    push() { const id = `al${++pushN}`; return { key: id, ...makeRef(`${p}/${id}`) }; },
    async transaction(fn) {
      const cur = at(p);
      const out = fn(cur === undefined ? null : cur);
      if (out === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      put(p, strip(out));
      return { committed: true, snapshot: { val: () => out } };
    },
  });
  return { data, ref: makeRef };
}

const PRODUCTS = {
  pAud: { id: "pAud", name: "Lacoste Audysol White", styleCodeNormalised: "745SMA00421G" },
  pOther: { id: "pOther", name: "Some Other Shoe", styleCodeNormalised: "745SFA000521G" },
};

test("filing a per-size link, then resolving it, never touches a product record", async () => {
  const db = fakeDb({ products: PRODUCTS });
  const before = JSON.stringify(db.data.products);

  // The link (auto or human-picked) files the other size's code:
  const filed = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pAud",
    chosenCode: "745SMA00621G", otherCodes: [], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(filed.attached, ["745SMA00621G"]);
  assert.deepStrictEqual(filed.conflicts, []);

  // The next scan of that size resolves silently:
  const hit = await runLabelAlias(db, { action: "codeLookup", code: "745SMA006-21G", actor: ACTOR, nowMs: NOW });
  assert.strictEqual(hit.productId, "pAud");

  // And the catalogue is byte-identical — nothing merged, stamped or edited.
  assert.strictEqual(JSON.stringify(db.data.products), before);
  // The one write that DID happen is the alias row:
  const rows = Object.values(db.data.label_aliases || {});
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].productId, "pAud");
  assert.deepStrictEqual(Object.keys(rows[0].c), ["745SMA00621G"]);
});

test("a conflicting link routes to the duplicate queue and STILL touches no product", async () => {
  // pOther already carries the code being linked to pAud via a claim row:
  const db = fakeDb({
    products: PRODUCTS,
    style_code_index: { "745SFA000521G": { productId: "pOther", claimedAt: NOW, claimedBy: "x" } },
  });
  const before = JSON.stringify(db.data.products);
  const res = await runLabelAlias(db, {
    action: "recordLabelCodes", productId: "pAud",
    chosenCode: "745SFA000521G", otherCodes: [], actor: ACTOR, nowMs: NOW,
  });
  assert.deepStrictEqual(res.attached, []);
  assert.strictEqual(res.conflicts.length, 1);
  assert.strictEqual(res.conflicts[0].ownerId, "pOther");
  assert.strictEqual(JSON.stringify(db.data.products), before);
  assert.ok(db.data.duplicate_candidates, "the collision is surfaced for a human, never swallowed");
  assert.strictEqual(db.data.label_aliases, undefined, "nothing was attached");
});

// ─── The search-index sweep's two floors ─────────────────────────────────────
// The sweep repairs a drifted index by removing anything indexed that is no
// longer live. That is also the shape of a catastrophe: if the LIVE set is
// wrong, every document looks like an orphan and the whole storefront search
// disappears. Reviewers found the unguarded version could do exactly that, so
// these pin the refusals. (2026-08-17.)

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

// The module is ESM under scripts/; import it dynamically.
const load = () => import(pathToFileURL(join(__dirname, "../../scripts/shopify/searchIndexWrite.mjs")).href);

// A fake RTDB that records what the sweep tried to do. Nothing here can reach
// a real database.
function fakeDb(docs) {
  const removed = [];
  const written = [];
  return {
    removed, written,
    ref(path) {
      return {
        async get() { return { exists: () => docs.has(path.split("/").pop()), val: () => null }; },
        async remove() { removed.push(path.split("/").pop()); },
        async set(v) { written.push([path, v]); },
        async update() {},
      };
    },
  };
}
// shallowKeys reads through the admin app; stub it by handing the sweep an app
// whose credential resolves and a fetch that returns the key map.
function fakeApp(keys) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => Object.fromEntries(keys.map((k) => [k, true])),
  });
  return { options: { databaseURL: "https://x", credential: { getAccessToken: async () => ({ access_token: "t" }) } } };
}

test("REFUSES entirely when the live set is empty — it would delete the whole index", async () => {
  const { sweepSearchIndex } = await load();
  const indexed = ["p1", "p2", "p3"];
  const db = fakeDb(new Set(indexed));
  const out = await sweepSearchIndex(db, fakeApp(indexed), { livePids: [], buildDoc: async () => null });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.refused, "empty live set");
  assert.deepStrictEqual(db.removed, [], "nothing may be removed");
});

test("REFUSES on a null/undefined live set too, not just an empty array", async () => {
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set(["p1"]));
  for (const livePids of [null, undefined]) {
    const out = await sweepSearchIndex(db, fakeApp(["p1"]), { livePids, buildDoc: async () => null });
    assert.strictEqual(out.skipped, true);
  }
  assert.deepStrictEqual(db.removed, []);
});

test("REFUSES the removals when they would take more than half the index", async () => {
  const { sweepSearchIndex } = await load();
  const indexed = ["p1", "p2", "p3", "p4"];
  const db = fakeDb(new Set(indexed));
  // Only p1 live ⇒ 3 of 4 orphaned, over the 50% ceiling.
  const out = await sweepSearchIndex(db, fakeApp(indexed), { livePids: ["p1"], buildDoc: async () => null });
  assert.strictEqual(out.refused, "removal ceiling");
  assert.strictEqual(out.removed, 0);
  assert.deepStrictEqual(db.removed, []);
});

test("a NORMAL take-down still applies — the floors are not a blanket freeze", async () => {
  const { sweepSearchIndex } = await load();
  const indexed = ["p1", "p2", "p3", "p4"];
  const db = fakeDb(new Set(indexed));
  // p4 came off: 1 of 4, comfortably under the ceiling.
  const out = await sweepSearchIndex(db, fakeApp(indexed), {
    livePids: ["p1", "p2", "p3"], buildDoc: async () => null,
  });
  assert.strictEqual(out.refused, undefined);
  assert.strictEqual(out.removed, 1);
  assert.deepStrictEqual(db.removed, ["p4"]);
});

test("an empty index is not a refusal — a fresh shop only adds", async () => {
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set());
  const out = await sweepSearchIndex(db, fakeApp([]), {
    livePids: ["p1", "p2"], buildDoc: async () => null, max: 10,
  });
  assert.strictEqual(out.missing, 2);
  assert.strictEqual(out.orphans, 0);
  assert.deepStrictEqual(db.removed, []);
});

test("additions are capped per run and the cap is REPORTED, never silent", async () => {
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set());
  const out = await sweepSearchIndex(db, fakeApp([]), {
    livePids: ["a", "b", "c", "d", "e"], buildDoc: async () => null, max: 2,
  });
  assert.strictEqual(out.missing, 5);
  assert.strictEqual(out.capped, true);
});

test("one indexed document and one orphan is REFUSED, not a 100% wipe", async () => {
  // The hole CodeRabbit found: `Math.max(1, floor(1 * 0.5))` was 1, so `1 > 1`
  // was false and the sweep deleted the entire index. Comparing against the
  // exact fraction (0.5) makes `1 > 0.5` true, and it refuses.
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set(["p1"]));
  const out = await sweepSearchIndex(db, fakeApp(["p1"]), {
    livePids: ["p2"], buildDoc: async () => null, max: 0,
  });
  assert.strictEqual(out.refused, "removal ceiling");
  assert.strictEqual(out.removed, 0);
  assert.deepStrictEqual(db.removed, []);
});

test("two indexed, one orphan is EXACTLY the ceiling and still applies", async () => {
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set(["p1", "p2"]));
  const out = await sweepSearchIndex(db, fakeApp(["p1", "p2"]), {
    livePids: ["p1"], buildDoc: async () => null,
  });
  assert.strictEqual(out.refused, undefined);
  assert.deepStrictEqual(db.removed, ["p2"]);
});

test("three indexed, two orphans is over the ceiling and is refused", async () => {
  const { sweepSearchIndex } = await load();
  const db = fakeDb(new Set(["p1", "p2", "p3"]));
  const out = await sweepSearchIndex(db, fakeApp(["p1", "p2", "p3"]), {
    livePids: ["p1"], buildDoc: async () => null,
  });
  assert.strictEqual(out.refused, "removal ceiling");
  assert.deepStrictEqual(db.removed, []);
});

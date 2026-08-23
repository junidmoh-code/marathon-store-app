// ─── performMerge with the count state — the phantom stock goes, the real ─────
//     stock moves, and nothing asks a question
//
// The unit under test is the whole merge, driven only by what the count records
// say. Every assertion is a QUANTITY or a LEDGER ENTRY, never a call shape.
//
// The world: Hub 1 has been counted (the survivor's size-9 cell carries a
// current, settled record), Central has not been counted at all, and Hub 3
// holds a negative cell nobody has counted. The loser holds stock at all three.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { performMerge } = require("../lib/product-merge.cjs");

const NOW = 1770000000000;
const ACTOR = { uid: "admin1", email: "gunidmoh@gmail.com" };

function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const updates = [];
  // { match, fn, skip } — fires ONCE after a get whose path includes `match`,
  // once `skip` earlier matches have gone by, modelling a concurrent write that
  // lands AFTER the merge read that path.
  let onGet = null;
  const failing = new Set();
  const at = (path) => String(path).split("/").filter(Boolean)
    .reduce((n, k) => (n == null ? undefined : n[k]), data);
  const put = (path, value) => {
    const parts = String(path).split("/").filter(Boolean);
    const last = parts.pop();
    let node = data;
    for (const k of parts) {
      if (node[k] == null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    if (value === null) delete node[last];
    else node[last] = value;
  };
  return {
    data,
    updates,
    afterGetOf(match, fn, skip = 0) { onGet = { match, fn, skip }; },
    failGet(prefix) { failing.add(prefix); },
    ref(path = "") {
      return {
        async get() {
          await Promise.resolve();
          for (const p of failing) if (String(path).startsWith(p)) throw new Error("PERMISSION_DENIED");
          if (onGet && String(path).includes(onGet.match)) {
            if (onGet.skip > 0) onGet.skip -= 1;
            else { const { fn } = onGet; onGet = null; fn({ getPath: at, setPath: put }); }
          }
          const v = at(path);
          const val = v === undefined ? null : (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
          return { val: () => val, exists: () => val !== null };
        },
        async set(value) { put(path || "", value); },
        async update(patch) {
          updates.push({ base: path || "", patch });
          for (const [k, v] of Object.entries(patch)) put(path ? `${path}/${k}` : k, v);
        },
        async transaction(fn) {
          const cur = at(path);
          const next = fn(cur === undefined ? null : cur);
          if (next === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
          put(path, next);
          return { committed: true, snapshot: { val: () => next } };
        },
      };
    },
  };
}

const LOCATIONS = {
  central: { id: "central" }, hub1: { id: "hub1" }, hub2: { id: "hub2" }, hub3: { id: "hub3" },
  "marathon-pine": { id: "marathon-pine" }, trophy: { id: "trophy" },
};

const HUB1_SESSION = "-SessionHub1";
const HUB2_SESSION = "-SessionHub2";

function world({ hub1Counted = true, loserCounted = false, hub2Counted = false } = {}) {
  const counted = {};
  if (hub1Counted) {
    counted[HUB1_SESSION] = {
      "pSurvivor::9": { productId: "pSurvivor", sizeKey: "9", action: "confirm", actual: 17, settled: true },
      ...(loserCounted ? { "pLoser::9": { productId: "pLoser", sizeKey: "9", action: "confirm", actual: 6, settled: true } } : {}),
    };
  }
  const hub2counted = hub2Counted
    ? { [HUB2_SESSION]: { "pSurvivor::9": { productId: "pSurvivor", sizeKey: "9", action: "confirm", actual: 4, settled: true } } }
    : null;
  return {
    locations: LOCATIONS,
    settings: {
      hubSneakerCount: {
        sessions: {
          hub1: { hub: "hub1", sessionId: HUB1_SESSION },
          hub2: { hub: "hub2", sessionId: HUB2_SESSION },
          central: { hub: "central", sessionId: "-SessionCentral" },
        },
        counted: {
          ...(Object.keys(counted).length ? { hub1: counted } : {}),
          ...(hub2counted ? { hub2: hub2counted } : {}),
          // Central has an OPEN session and has counted nothing. That is the
          // live shape, and it is why "a session exists" is not the test.
        },
      },
    },
    products: {
      pLoser: { id: "pLoser", name: "Lacoste Audyssor White Gray (dup)", sizes: ["9"] },
      pSurvivor: { id: "pSurvivor", name: "Lacoste Audysol White", sizes: ["9"] },
    },
    stock: {
      hub1: {
        pLoser: { "9": { qty: 6, v: 3, mv: "mL1" } },
        pSurvivor: { "9": { qty: 17, v: 8, mv: "mS1" } },
      },
      central: {
        pLoser: { "9": { qty: 16, v: 1, mv: "mL2" } },
        pSurvivor: { "9": { qty: 0, v: 4, mv: "mS2" } },
      },
      hub3: { pLoser: { "9": { qty: -2, v: 2, mv: "mL3" } } },
      "marathon-pine": { pSurvivor: { "9": { qty: 7, v: 1, mv: "mS3" } } },
    },
  };
}

const run = (db, over = {}) =>
  performMerge(db, { loserId: "pLoser", survivorId: "pSurvivor", actor: ACTOR, nowMs: NOW, ...over });

const totalAt = (data, loc) => {
  let sum = 0;
  for (const cells of Object.values(data.stock[loc] || {})) {
    for (const [k, cell] of Object.entries(cells)) {
      if (k === "_meta" || !cell || typeof cell !== "object") continue;
      sum += typeof cell.qty === "number" ? cell.qty : 0;
    }
  }
  return sum;
};

// ─── THE COUNTED LOCATION: removal, and the survivor does NOT go up ───────────
test("at a COUNTED cell the loser's stock is removed and the survivor's total does not increase", async () => {
  const db = fakeDb(world());
  const before = db.data.stock.hub1.pSurvivor["9"].qty;
  const out = await run(db);
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, before,
    "the survivor's counted cell must be untouched — those 6 pairs are already inside it");
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].v, 8, "an untouched cell's version does not move");
  assert.strictEqual(db.data.stock.hub1.pLoser, undefined, "the loser's node at hub1 is gone");
  assert.deepStrictEqual(out.removed.find((r) => r.loc === "hub1"), { loc: "hub1", size: "9", qty: 6 });
  assert.strictEqual(totalAt(db.data, "hub1"), 17, "hub 1 loses exactly the phantom 6");
});

// ─── THE UNCOUNTED LOCATION: transfer, totals conserved exactly ───────────────
test("at an UNCOUNTED location the stock transfers and the location total is conserved", async () => {
  const db = fakeDb(world());
  const before = totalAt(db.data, "central");
  const out = await run(db);
  assert.strictEqual(totalAt(db.data, "central"), before, "central's total is conserved to the unit");
  assert.strictEqual(db.data.stock.central.pSurvivor["9"].qty, 16, "0 + 16");
  assert.strictEqual(db.data.stock.central.pSurvivor["9"].v, 5, "an existing cell goes v+1");
  assert.ok(out.moved.some((m) => m.loc === "central" && m.qty === 16));
});

test("one merge handles a counted AND an uncounted location correctly, together", async () => {
  const db = fakeDb(world());
  const out = await run(db);
  assert.deepStrictEqual(out.removed.map((r) => r.loc).sort(), ["hub1"]);
  assert.deepStrictEqual(out.moved.map((m) => m.loc).sort(), ["central", "hub3"]);
  assert.strictEqual(totalAt(db.data, "hub1"), 17);
  assert.strictEqual(totalAt(db.data, "central"), 16);
});

// ─── A VERIFIED COUNT IS NEVER WRITTEN OFF ───────────────────────────────────
test("when the LOSER's own cell was counted, its units TRANSFER rather than being removed", async () => {
  const db = fakeDb(world({ loserCounted: true }));
  const out = await run(db);
  assert.deepStrictEqual(out.removed, []);
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 23, "17 + 6 — both counts are real");
});

// ─── NEGATIVES ───────────────────────────────────────────────────────────────
test("a negative cell transfers with its sign intact", async () => {
  const db = fakeDb(world());
  await run(db);
  assert.strictEqual(db.data.stock.hub3.pSurvivor["9"].qty, -2, "−2 arrives as −2, not 0 and not 2");
  assert.strictEqual(totalAt(db.data, "hub3"), -2);
});

test("a negative cell at a COUNTED location is removed with its sign — not clamped", async () => {
  const w = world();
  w.stock.hub1.pLoser["9"].qty = -3;
  const db = fakeDb(w);
  const out = await run(db);
  assert.deepStrictEqual(out.removed.find((r) => r.loc === "hub1"), { loc: "hub1", size: "9", qty: -3 });
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 17, "unchanged");
});

// ─── PINE ────────────────────────────────────────────────────────────────────
test("a merge succeeds when either product holds Pine stock, and Pine keeps it", async () => {
  const db = fakeDb(world());
  await run(db);
  assert.strictEqual(db.data.stock["marathon-pine"].pSurvivor["9"].qty, 7,
    "Pine is not special: the survivor's Pine cell is untouched and no location refused");
  const w2 = world();
  w2.stock["marathon-pine"].pLoser = { "9": { qty: 4, v: 0, mv: "mLp" } };
  const db2 = fakeDb(w2);
  const out2 = await run(db2);
  assert.strictEqual(db2.data.stock["marathon-pine"].pSurvivor["9"].qty, 11, "7 + 4 at Pine");
  assert.ok(out2.ok);
});

// ─── THE REMOVAL IS A LEDGER MOVEMENT, NOT A DELETION ────────────────────────
test("a removal writes an adjustment movement whose reason names the merge", async () => {
  const db = fakeDb(world());
  const out = await run(db);
  const mvId = out.movementIds.find((id) => id.includes("_L_hub1_9"));
  const mv = db.data.stock_movements[mvId];
  assert.ok(mv, "the removal appears in the ledger");
  assert.strictEqual(mv.type, "adjustment");
  assert.strictEqual(mv.reason, "product_merge_counted_removal");
  assert.strictEqual(mv.productId, "pLoser");
  assert.strictEqual(mv.link.mergeId, out.mergeId);
  assert.strictEqual(mv.link.mergedInto, "pSurvivor");
  assert.deepStrictEqual(mv.before, { hub1: 6 });
  assert.deepStrictEqual(mv.after, { hub1: 0 });
  // and NO survivor leg was minted for it — nothing arrived anywhere.
  assert.strictEqual(out.movementIds.filter((id) => id.includes("_S_hub1_9")).length, 0);
});

test("a removal is REVERSIBLE — the loser's full before-state is recorded", async () => {
  const db = fakeDb(world());
  const out = await run(db);
  const rec = db.data.product_merges[out.mergeId];
  assert.deepStrictEqual(rec.before.loserStock.hub1, { "9": { qty: 6, v: 3, mv: "mL1" } },
    "the removed cell is recorded exactly as it was, so it can be put back");
  assert.deepStrictEqual(rec.removed, [{ loc: "hub1", size: "9", qty: 6 }]);
});

// ─── ATOMIC, IDEMPOTENT, NO QUESTION ─────────────────────────────────────────
test("the whole merge — removals included — is ONE atomic root update", async () => {
  const db = fakeDb(world());
  await run(db);
  const roots = db.updates.filter((u) => u.base === "");
  assert.strictEqual(roots.length, 1, "exactly one multi-path update writes everything");
});

test("a rerun refuses: the loser is already a redirect, so nothing double-books", async () => {
  const db = fakeDb(world());
  await run(db);
  await assert.rejects(() => run(db), (err) => err.refused && /already merged away/i.test(err.message));
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 17, "still 17 — no second removal, no second transfer");
});

test("the loser becomes a hidden redirect and old references still resolve", async () => {
  const db = fakeDb(world());
  await run(db);
  assert.strictEqual(db.data.products.pLoser.mergedInto, "pSurvivor");
  assert.ok(db.data.products.pLoser.name, "the record itself survives for old sales and laybys");
});

// ─── THE COUNT STATE DRIVES IT, NOTHING ELSE ─────────────────────────────────
test("hub 2 finishing its count changes hub 2's outcome with no code change", async () => {
  const w = world({ hub2Counted: true });
  w.stock.hub2 = {
    pLoser: { "9": { qty: 3, v: 0, mv: "x" } },
    pSurvivor: { "9": { qty: 4, v: 0, mv: "y" } },
  };
  const db = fakeDb(w);
  const out = await run(db);
  assert.ok(out.removed.some((r) => r.loc === "hub2" && r.qty === 3), "counted at hub2 → removed at hub2");

  const w2 = world({ hub2Counted: false });
  w2.stock.hub2 = {
    pLoser: { "9": { qty: 3, v: 0, mv: "x" } },
    pSurvivor: { "9": { qty: 4, v: 0, mv: "y" } },
  };
  const db2 = fakeDb(w2);
  const out2 = await run(db2);
  assert.ok(out2.moved.some((m) => m.loc === "hub2" && m.qty === 3), "not counted at hub2 → transferred");
  assert.strictEqual(db2.data.stock.hub2.pSurvivor["9"].qty, 7);
});

test("an open session that has counted NOTHING removes nothing — central is the live case", async () => {
  const db = fakeDb(world({ hub1Counted: false }));
  const out = await run(db);
  assert.deepStrictEqual(out.removed, [], "a session record alone is not a count");
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 23);
});

test("a staled count record does not authorise a removal", async () => {
  const w = world();
  w.settings.hubSneakerCount.counted.hub1[HUB1_SESSION]["pSurvivor::9"].staleAt = NOW - 10;
  const db = fakeDb(w);
  const out = await run(db);
  assert.deepStrictEqual(out.removed, []);
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 23, "it transfers instead");
});

test("counted records from an OLD session are ignored — only the live session counts", async () => {
  const w = world();
  w.settings.hubSneakerCount.counted.hub1 = {
    "-AnOlderSession": { "pSurvivor::9": { settled: true } },
  };
  const db = fakeDb(w);
  const out = await run(db);
  assert.deepStrictEqual(out.removed, []);
});

// ─── THE REMOVAL FENCE — the one window a removal could be wrong ─────────────
test("a removal REFUSES if its count record is staled between the read and the commit", async () => {
  const db = fakeDb(world());
  // A concurrent shipment release stales the survivor's counted cell after the
  // merge has read it. A transfer would be caught by the survivor-cell fence;
  // a removal writes no survivor cell, so it needs its own.
  db.afterGetOf("stock/hub1/pLoser", ({ setPath }) => {
    setPath(`settings/hubSneakerCount/counted/hub1/${HUB1_SESSION}/pSurvivor::9/staleAt`, NOW);
  }, 1);
  await assert.rejects(() => run(db), (err) => err.refused && /no longer safe to write off/i.test(err.message));
  assert.strictEqual(db.data.stock.hub1.pLoser["9"].qty, 6, "nothing was written off");
  assert.ok(db.data.stock.central.pLoser, "and nothing else was committed either");
});

test("a removal REFUSES if its count record is deleted between the read and the commit", async () => {
  const db = fakeDb(world());
  db.afterGetOf("stock/hub1/pLoser", ({ setPath }) => {
    setPath(`settings/hubSneakerCount/counted/hub1/${HUB1_SESSION}/pSurvivor::9`, null);
  }, 1);
  await assert.rejects(() => run(db), (err) => err.refused);
  assert.strictEqual(db.data.stock.hub1.pLoser["9"].qty, 6);
});

// ─── UNREADABLE COUNT RECORDS REFUSE, THEY DO NOT GUESS ─────────────────────
test("an unreadable count node refuses with a coded message and releases the lock", async () => {
  const db = fakeDb(world());
  db.failGet("settings/hubSneakerCount/counted/hub1");
  await assert.rejects(() => run(db), (err) => err.refused
    && err.code === "failed-precondition"
    && /count records at hub1 could not be read/i.test(err.message));
  assert.deepStrictEqual(db.data.product_merges_locks, {}, "the lock is released on the refusal");
  assert.strictEqual(db.data.stock.hub1.pLoser["9"].qty, 6, "nothing was changed");
});

test("an unreadable SESSIONS node refuses too — it is never treated as 'nothing counted'", async () => {
  const db = fakeDb(world());
  db.failGet("settings/hubSneakerCount/sessions");
  await assert.rejects(() => run(db), (err) => err.refused
    && /hub count sessions could not be read/i.test(err.message));
  assert.strictEqual(db.data.stock.hub1.pSurvivor["9"].qty, 17, "and hub 1 was NOT silently double-counted");
});

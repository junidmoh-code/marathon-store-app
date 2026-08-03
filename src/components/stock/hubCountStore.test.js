// ─── HUB SNEAKER COUNT — THE CONCURRENCY GUARD ────────────────────────────────
// The guard is three layers deep and every one of them exists to stop the SAME
// failure: a write that lands on a base nobody counted, with nothing on screen
// to say so. A silent wrong write during a stock-take is close to undetectable —
// the number just looks like a count result — so each layer is proven here
// behaviourally, not merely called.
//
// ── WHY THE FAKE applyMovement REPRODUCES THE RETRY LOOP ─────────────────────
// The `maxRetries: 1` layer cannot be proven by asserting "we passed 1". That
// assertion survives the option being ignored, and it says nothing about WHY 1
// is the right number. So the fake below implements the real writer's actual
// semantics — read the cell, apply a RELATIVE delta, and on a version conflict
// re-read and re-apply — which is what makes retries wrong for an absolute
// count. With retries on, a concurrent sale causes a silently wrong quantity to
// be committed and `ok: true` returned. That is the bug these tests exist to
// catch, and it only appears if the fake retries the way the real one does.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

// ── An in-memory RTDB with real path semantics ───────────────────────────────
let store = {};
let pushN = 0;
let mvN = 0;

function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `pk${++pushN}` }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "counter-1" } } }));

// ── The fake writer, with the REAL writer's concurrency semantics ────────────
// `raceDuringWrite` fires ONCE between the read and the write of an attempt —
// exactly the window the cell's version guard exists to police.
// `raceAfterWrite` fires once after a successful commit — the window the
// post-write assert exists to police.
let raceDuringWrite = null;
let raceAfterWrite = null;

const applyMovementMock = vi.fn(async (mv, { maxRetries = 6 } = {}) => {
  const loc = mv.to || mv.from;
  const path = stockCellPath(loc, mv.productId, mv.size);
  const delta = mv.to ? Number(mv.qty) : -Number(mv.qty);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cell = getPath(path);
    const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
    const seenV = cell && typeof cell.v === "number" ? cell.v : null;

    if (raceDuringWrite) { const w = raceDuringWrite; raceDuringWrite = null; w(); }

    const fresh = getPath(path);
    const nowV = fresh && typeof fresh.v === "number" ? fresh.v : null;
    if (nowV !== seenV) {                                  // the rule rejects our v
      if (attempt === maxRetries) return { ok: false, reason: "write_failed" };
      continue;                                            // re-read and re-apply — the real loop
    }

    setPath(path, { ...(cell || {}), qty: curQty + delta, v: (seenV ?? -1) + 1, mv: `m${++mvN}`, lastType: "adjustment" });
    if (raceAfterWrite) { const w = raceAfterWrite; raceAfterWrite = null; w(); }
    return { ok: true, movementId: `mv${mvN}` };
  }
  return { ok: false, reason: "retries_exhausted" };
});

vi.mock("./applyMovement", () => ({ applyMovement: (...args) => applyMovementMock(...args) }));

const { adjustCell, confirmCell } = await import("./hubCountStore.js");

const HUB = "hub1";
const PID = "sh1";
const SESSION = "sess1";
const cellPath = (size = "8") => stockCellPath(HUB, PID, size);
const cellNow = (size = "8") => getPath(cellPath(size));
const recordNow = (size = "8") => getPath(`settings/hubSneakerCount/counted/${HUB}/${SESSION}/${PID}::${size}`);

const seedCell = (qty, v = 1, size = "8") => setPath(cellPath(size), { qty, v, mv: "m0", lastType: "received" });

beforeEach(() => {
  store = {};
  pushN = 0; mvN = 0;
  raceDuringWrite = null; raceAfterWrite = null;
  applyMovementMock.mockClear();
});

// ── LAYER 1 ──────────────────────────────────────────────────────────────────
describe("LAYER 1 — the pre-flight staleness fence", () => {
  it("REFUSES the write when the cell no longer holds what the counter was shown", async () => {
    seedCell(2);                                     // someone already moved it to 2
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 5 });

    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();  // nothing reached the writer
    expect(cellNow().qty).toBe(2);                     // the cell is untouched
    expect(recordNow()).toBeNull();                    // and nothing was recorded as counted
  });

  it("names BOTH numbers in the message, so the counter knows what to reconcile", async () => {
    seedCell(2);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 5 });
    expect(res.message).toContain("2");
    expect(res.message).toContain("4");
    expect(res.message).toMatch(/recheck/i);
  });

  it("fences a CONFIRM too — confirming a number that already moved is still wrong", async () => {
    seedCell(9);
    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4 });
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(recordNow()).toBeNull();
  });

  it("lets a clean write through when the cell still matches", async () => {
    seedCell(4);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(6);
    expect(recordNow()).toMatchObject({ expected: 4, actual: 6, action: "adjust" });
  });
});

// ── LAYER 2 ──────────────────────────────────────────────────────────────────
describe("LAYER 2 — retries OFF, so a version conflict fails instead of re-applying", () => {
  // The race: the fence passes (cell really is 4), then a sale takes it to 2 in
  // the instant between the writer's read and its write.
  const raceToTwo = () => { raceDuringWrite = () => setPath(cellPath(), { qty: 2, v: 2, mv: "sale", lastType: "sold" }); };

  it("surfaces the conflict as a FAILURE and never commits a number nobody counted", async () => {
    seedCell(4);
    raceToTwo();
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 5 });

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/recheck/i);
    // THE POINT: with retries on, the writer would re-read 2 and re-apply +1,
    // committing 3 — a value neither the counter (5) nor the system (2) ever
    // held. The cell must still read 2.
    expect(cellNow().qty).toBe(2);
    expect(recordNow()).toBeNull();                  // and it is NOT recorded as counted
  });

  it("passes maxRetries 1 to the single writer — the mechanism behind the above", async () => {
    seedCell(4);
    await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 5 });
    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    expect(applyMovementMock.mock.calls[0][1]).toEqual({ maxRetries: 1 });
  });

  it("demonstrates the harness WOULD catch a re-applied write (retries on → silent 3)", async () => {
    // Proves the test above can actually fail: same race, retries allowed.
    seedCell(4);
    raceToTwo();
    const res = await applyMovementMock(
      { type: "adjustment", productId: PID, size: "8", qty: 1, to: HUB, from: null },
      { maxRetries: 6 }
    );
    expect(res.ok).toBe(true);                       // silently "succeeds"…
    expect(cellNow().qty).toBe(3);                   // …at a number nobody counted
  });
});

// ── LAYER 3 ──────────────────────────────────────────────────────────────────
describe("LAYER 3 — the post-write assert", () => {
  it("warns WITH the movement id when the cell does not end up at the counted value", async () => {
    seedCell(4);
    // A writer lands in the same instant, immediately after our commit.
    raceAfterWrite = () => setPath(cellPath(), { qty: 99, v: 9, mv: "other", lastType: "sold" });

    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });

    expect(res.ok).toBe(true);                       // our write did land…
    expect(res.warning).toBeTruthy();                // …but it is NOT reported as clean
    expect(res.warning).toContain("99");             // what the cell actually reads
    expect(res.warning).toContain(res.record.movementId);   // traceable in History
    expect(recordNow()).toBeTruthy();                // still recorded — the count happened
  });

  it("stays silent when the cell settles exactly where it should", async () => {
    seedCell(4);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });
    expect(res.ok).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(cellNow().qty).toBe(6);
  });
});

// ── Surrounding behaviour the guard depends on ───────────────────────────────
describe("recording and provenance", () => {
  it("a confirm records the count and touches /stock not at all", async () => {
    seedCell(4);
    const before = JSON.stringify(cellNow());
    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4 });

    expect(res.ok).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(JSON.stringify(cellNow())).toBe(before);          // byte-identical cell
    expect(recordNow()).toMatchObject({ expected: 4, actual: 4, action: "confirm", by: "counter-1" });
  });

  it("carries session provenance on the movement's link", async () => {
    seedCell(4);
    await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 1, actorRole: "admin" });
    const link = applyMovementMock.mock.calls[0][0].link;
    expect(link).toMatchObject({
      countSessionId: SESSION, countLocation: HUB, countSize: "8",
      countExpected: 4, countActual: 1, countDelta: -3,
    });
    expect(applyMovementMock.mock.calls[0][0].reason).toBe("hub_sneaker_count");
  });

  it("a count equal to expected degrades to a confirm — no movement for a no-op", async () => {
    seedCell(4);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 4 });
    expect(res.ok).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(recordNow().action).toBe("confirm");
  });

  it("rejects a non-integer or negative count before any read", async () => {
    seedCell(4);
    for (const bad of [-1, 2.5, NaN]) {
      const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: bad });
      expect(res.ok).toBe(false);
    }
    expect(applyMovementMock).not.toHaveBeenCalled();
  });

  it("corrects a NEGATIVE cell upward — the case a clamp would have hidden", async () => {
    seedCell(-3);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: -3, actual: 0 });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(0);
    expect(recordNow()).toMatchObject({ expected: -3, actual: 0 });
  });

  it("writes a half-size to the cell the fence read — 5.5 lives at 5_5", async () => {
    seedCell(2, 1, "5.5");
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "5_5", expected: 2, actual: 4 });
    expect(res.ok).toBe(true);
    expect(getPath(`stock/${HUB}/${PID}/5_5`).qty).toBe(4);
    expect(applyMovementMock.mock.calls[0][0].size).toBe("5.5");   // RAW size to the writer
  });
});

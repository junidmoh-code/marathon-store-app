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
  get: async (node) => {
    // Fail reads under a path, optionally after letting the first N through — the
    // adjust flow reads the cell twice (pre-flight fence, then post-write verify)
    // and these tests need to break only the second.
    if (failReadsUnder && String(node.path).startsWith(failReadsUnder)) {
      if (failReadsSkip > 0) failReadsSkip -= 1;
      else throw new Error("READ_FAILED");
    }
    return { val: () => getPath(node.path), exists: () => getPath(node.path) != null };
  },
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) {
      const full = node.path ? `${node.path}/${k}` : k;
      if (failWritesUnder && full.startsWith(failWritesUnder)) throw new Error("PERMISSION_DENIED");
      setPath(full, v);
    }
  },
  push: () => ({ key: `pk${++pushN}` }),
  // Models RTDB's real transaction semantics: run the updater, and if the value
  // moved underneath us before the commit, RE-RUN it against the new value.
  // That re-run is what makes first-write-wins actually work.
  runTransaction: async (node, fn) => {
    // A rules rejection fails a transaction exactly as it fails an update — the
    // durability tests inject failure per path prefix and must cover BOTH ways
    // a record write can happen.
    if (failWritesUnder && String(node.path).startsWith(failWritesUnder)) throw new Error("PERMISSION_DENIED");
    for (let i = 0; i < 5; i++) {
      const cur = getPath(node.path);
      const next = fn(cur);
      if (raceDuringTxn) { const w = raceDuringTxn; raceDuringTxn = null; w(); }
      const now = getPath(node.path);
      if (JSON.stringify(now) !== JSON.stringify(cur)) continue;      // conflict → re-run
      if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
      setPath(node.path, next);
      return { committed: true, snapshot: { val: () => next } };
    }
    return { committed: false, snapshot: { val: () => getPath(node.path) } };
  },
}));
let raceDuringTxn = null;
let failWritesUnder = null;   // path prefix whose writes should reject
let failReadsUnder = null;    // path prefix whose reads should reject
let failReadsSkip = 0;        // let this many matching reads through first
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "counter-1" } } }));

// ── The fake writer, with the REAL writer's concurrency semantics ────────────
// `raceDuringWrite` fires ONCE between the read and the write of an attempt —
// exactly the window the cell's version guard exists to police.
// `raceAfterWrite` fires once after a successful commit — the window the
// post-write assert exists to police.
let raceDuringWrite = null;
let raceAfterWrite = null;

// `raceBeforeWriterRead` fires once BEFORE the writer's own read — the window
// between the caller's fence read and applyMovement's read, which the `v` guard
// cannot see because the writer never observes the old version.
let raceBeforeWriterRead = null;

const applyMovementMock = vi.fn(async (mv, { maxRetries = 6 } = {}) => {
  const loc = mv.to || mv.from;
  const path = stockCellPath(loc, mv.productId, mv.size);
  const delta = mv.to ? Number(mv.qty) : -Number(mv.qty);

  if (raceBeforeWriterRead) { const w = raceBeforeWriterRead; raceBeforeWriterRead = null; w(); }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const cell = getPath(path);
    const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
    const seenV = cell && typeof cell.v === "number" ? cell.v : null;

    // The absolute-value precondition, mirroring the real applyMovement: checked
    // against the value THIS function just read, on every attempt.
    if (mv.expect && typeof mv.expect.qty === "number" && curQty !== mv.expect.qty) {
      return { ok: false, reason: "stale_expectation", expected: mv.expect.qty, live: curQty };
    }

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

const { adjustCell, confirmCell, flagCell, openOrResumeSession, loadCardSummary } = await import("./hubCountStore.js");

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
  raceDuringWrite = null; raceAfterWrite = null; raceBeforeWriterRead = null; raceDuringTxn = null;
  failWritesUnder = null; failReadsUnder = null; failReadsSkip = 0;
  applyMovementMock.mockClear();
});

// ── SESSION IDENTITY ─────────────────────────────────────────────────────────
// "A second counter sees what's already done" is only true if both counters are
// in the SAME session. A check-then-write would let two tablets mint two ids and
// have the second overwrite the first, orphaning a whole counter's progress.
describe("session open/resume is compare-and-set", () => {
  const sessionNode = () => getPath(`settings/hubSneakerCount/sessions/${HUB}`);

  it("creates a session when the hub has never been counted", async () => {
    const s = await openOrResumeSession(HUB);
    expect(s.sessionId).toBeTruthy();
    expect(sessionNode().sessionId).toBe(s.sessionId);
  });

  it("RESUMES the existing session rather than minting a second one", async () => {
    const first = await openOrResumeSession(HUB);
    const second = await openOrResumeSession(HUB);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("two tablets opening the same fresh hub converge on ONE session", async () => {
    // Counter B's session commits while counter A's transaction is in flight.
    const bId = "sessionFromCounterB";
    raceDuringTxn = () => setPath(`settings/hubSneakerCount/sessions/${HUB}`,
      { sessionId: bId, hub: HUB, openedAt: "t", openedBy: "counter-2" });

    const a = await openOrResumeSession(HUB);

    // A must ADOPT B's session, not keep the id it minted locally — otherwise A
    // writes counts under an id nothing will ever load again.
    expect(a.sessionId).toBe(bId);
    expect(sessionNode().sessionId).toBe(bId);
  });
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

// ── LAYER 2b — THE GAP BETWEEN THE FENCE AND THE WRITER ─────────────────────
// Found in review (Codex, stage 5). The fence and applyMovement do two SEPARATE
// reads. A write landing between them produces no version conflict at all —
// applyMovement never saw the old version, so it computes its delta against the
// new base and commits happily. The `expect` precondition is what closes it.
describe("LAYER 2b — a write landing between the fence and the writer's own read", () => {
  it("REJECTS instead of committing a number nobody counted", async () => {
    seedCell(10, 4);
    // Counter A completes an entire adjustment in the gap: 10 → 8.
    raceBeforeWriterRead = () => setPath(cellPath(), { qty: 8, v: 5, mv: "counterA", lastType: "adjustment" });

    // Counter B saw 10, counted 8, so B's delta is -2.
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 10, actual: 8 });

    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(res.message).toContain("8");                 // tells B what it really holds now
    // Without `expect`, B's -2 would have applied to A's 8 and committed 6 —
    // a number neither counter ever counted.
    expect(cellNow().qty).toBe(8);
    expect(recordNow()).toBeNull();
  });

  it("passes the expected quantity to the writer, so the check happens at ITS read", async () => {
    seedCell(4);
    await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 5 });
    expect(applyMovementMock.mock.calls[0][0].expect).toEqual({ qty: 4 });
  });

  it("demonstrates the harness WOULD catch a re-based write (no expect → silent 6)", async () => {
    seedCell(10, 4);
    raceBeforeWriterRead = () => setPath(cellPath(), { qty: 8, v: 5, mv: "counterA", lastType: "adjustment" });
    const res = await applyMovementMock(
      { type: "adjustment", productId: PID, size: "8", qty: 2, to: null, from: HUB },   // no expect
      { maxRetries: 1 }
    );
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(6);                     // the bug, reproduced
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
    expect(recordNow().settled).toBe(true);
  });

  it("PERSISTS the unsettled state on the record — a toast is not a work item", async () => {
    seedCell(4);
    raceAfterWrite = () => setPath(cellPath(), { qty: 99, v: 9, mv: "other", lastType: "sold" });
    await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });

    // Survives the reload: the record itself says this cell needs re-checking,
    // and what it really holds.
    expect(recordNow()).toMatchObject({ settled: false, actual: 6, live: 99 });
  });
});

// ── THE HOME CARD MUST NOT PAY FOR THE WHOLE COUNT ──────────────────────────
// Found by CodeRabbit: loadCardSummary used to download every counted record to
// produce one number — several thousand records at hub 2, on every app open.
describe("card progress is a tally, not a download", () => {
  const sessionFor = () => getPath(`settings/hubSneakerCount/sessions/${HUB}`);

  it("counts each newly recorded cell exactly once", async () => {
    await openOrResumeSession(HUB);
    const sid = sessionFor().sessionId;
    seedCell(4); seedCell(2, 1, "9");

    await confirmCell({ hub: HUB, sessionId: sid, productId: PID, sizeKey: "8", expected: 4 });
    await confirmCell({ hub: HUB, sessionId: sid, productId: PID, sizeKey: "9", expected: 2 });

    expect(sessionFor().doneCells).toBe(2);
  });

  it("does NOT double-count a re-count of a cell already recorded", async () => {
    await openOrResumeSession(HUB);
    const sid = sessionFor().sessionId;
    seedCell(4);

    await confirmCell({ hub: HUB, sessionId: sid, productId: PID, sizeKey: "8", expected: 4 });
    await adjustCell({ hub: HUB, sessionId: sid, productId: PID, sizeKey: "8", expected: 4, actual: 6 });

    expect(sessionFor().doneCells).toBe(1);      // same cell, corrected — still one
  });

  it("two concurrent first-writes on one cell cannot double-count the tally", async () => {
    seedCell(4);
    // Another counter's record lands while OUR create-transaction is in flight:
    // the transaction re-runs against it, aborts, and we overwrite WITHOUT
    // counting — only the actual creator's client bumps the tally.
    raceDuringTxn = () => setPath(`settings/hubSneakerCount/counted/${HUB}/${SESSION}/${PID}::8`,
      { productId: PID, sizeKey: "8", expected: 4, actual: 4, action: "confirm" });
    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4 });
    expect(res.ok).toBe(true);
    expect(recordNow()).toBeTruthy();                 // our record still landed (overwrite)
    expect(getPath(`settings/hubSneakerCount/sessions/${HUB}/doneCells`) || 0).toBe(0);   // we did NOT create → no bump
  });

  it("reads ONLY the session record — never the counted node", async () => {
    await openOrResumeSession(HUB);
    const sid = sessionFor().sessionId;
    seedCell(4);
    await confirmCell({ hub: HUB, sessionId: sid, productId: PID, sizeKey: "8", expected: 4 });
    setPath(`${`settings/hubSneakerCount/sessions/${HUB}`}/totalCells`, 40);

    const s = await loadCardSummary(HUB);
    expect(s).toMatchObject({ done: 1, total: 40 });
  });
});

// ── FLAG — the warehouse counter's mismatch path ─────────────────────────────
// The rules only let admins write `adjustment` movements, so staff RECORD the
// mismatch instead. The invariant that matters: flagCell must NEVER reach the
// stock writer — a "record" that moved stock would be an adjustment with a
// friendlier name and no rule behind it.
describe("flagCell records a mismatch without touching stock", () => {
  it("writes a flag record; the stock writer is never called; the cell is untouched", async () => {
    seedCell(4);
    const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7 });

    expect(res.ok).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(cellNow().qty).toBe(4);                    // stock exactly where it was
    expect(cellNow().v).toBe(1);                      // version untouched
    expect(recordNow()).toMatchObject({ action: "flag", expected: 4, actual: 7, settled: true, live: 4 });
  });

  it("is fenced like everything else — a moved cell rejects the record", async () => {
    seedCell(2);                                       // someone already changed it
    const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7 });
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(recordNow()).toBeNull();
  });

  it("a matching count degrades to a plain confirm", async () => {
    seedCell(4);
    const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 4 });
    expect(res.ok).toBe(true);
    expect(recordNow().action).toBe("confirm");
  });

  it("rejects junk before any read", async () => {
    seedCell(4);
    for (const bad of [-1, 2.5, NaN]) {
      const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: bad });
      expect(res.ok).toBe(false);
    }
  });

  it("the admin APPLY is just adjustCell over the flagged numbers — and overwrites the flag", async () => {
    seedCell(4);
    await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7 });
    // Admin applies later; stock has not moved in between.
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7, actorRole: "admin" });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(7);
    expect(recordNow().action).toBe("adjust");        // pending cleared — same key, overwritten
  });

  it("the apply REJECTS when stock moved after the count — no blind write of an old number", async () => {
    seedCell(4);
    await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7 });
    setPath(cellPath(), { qty: 3, v: 2, mv: "sale", lastType: "sold" });   // a sale lands before the admin gets there
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 7, actorRole: "admin" });
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(cellNow().qty).toBe(3);                    // the sale's truth survives
    expect(recordNow().action).toBe("flag");          // still queued, needs a recount
  });
});

// ── DURABILITY ───────────────────────────────────────────────────────────────
// The movement commits stock and the ledger atomically; the progress record is a
// separate write that can fail on its own. Reporting that as "the count failed"
// would be actively dangerous: the counter re-enters the number and adjusts a
// second time.
describe("a lost progress record must never be reported as a failed count", () => {
  it("reports SUCCESS with a warning when stock committed but the record write failed", async () => {
    seedCell(4);
    failWritesUnder = "settings/hubSneakerCount/counted";

    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });

    expect(cellNow().qty).toBe(6);                    // the stock DID move
    expect(res.ok).toBe(true);                        // …so this is NOT a failure
    expect(res.warning).toMatch(/Stock WAS updated/i);
    expect(res.warning).toContain("do not count this cell again");
    expect(recordNow()).toBeNull();                   // record genuinely absent
  });

  it("a failed VERIFICATION read costs the verification, never the record", async () => {
    seedCell(4);
    // The post-write re-read rejects. Previously this exception propagated out of
    // adjustCell and the record write never ran — stock corrected, cell showing
    // as uncounted, and a retry blocked by the stale fence.
    failReadsUnder = `stock/${HUB}/${PID}/8`;
    failReadsSkip = 1;                              // fence read succeeds; verify read fails
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 6 });

    expect(res.ok).toBe(true);
    expect(recordNow()).toBeTruthy();               // the record SURVIVED
    expect(res.warning).toMatch(/could not re-read/i);
  });

  it("a failed CONFIRM is a plain failure — no stock moved, safe to retry", async () => {
    seedCell(4);
    failWritesUnder = "settings/hubSneakerCount/counted";

    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4 });

    expect(res.ok).toBe(false);
    expect(cellNow().qty).toBe(4);
    expect(applyMovementMock).not.toHaveBeenCalled();
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

// ─── OFF-SHELF ARITHMETIC (owner spec 2026-08-12) ────────────────────────────
// The counter answers for the SHELF; `offShelf` is what the system knows is
// booked here but standing elsewhere (a display at a shop, a ready order).
// These pins ARE the count-integrity contract: an honest shelf count can never
// destroy an off-shelf unit, and a cell with nothing off-shelf behaves
// byte-for-byte as before.
describe("off-shelf arithmetic", () => {
  it("worked example: booked 2, 1 on display, counter sees 1 → CONFIRM, no movement", async () => {
    seedCell(2);
    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                    expected: 2, offShelf: 1, offShelfNote: "1 on display at Marathon PE" });
    expect(res.ok).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();     // the display unit survives
    expect(cellNow().qty).toBe(2);
    expect(recordNow()).toMatchObject({ action: "confirm", expected: 2, actual: 1, offShelf: 1 });
  });

  it("adjust moves the SHELF figure: booked 8, 1 off-shelf, shelf shows 4 → cell lands at 5, not 4", async () => {
    seedCell(8);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                   expected: 8, actual: 4, offShelf: 1 });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(5);                        // 4 on the shelf + 1 off-shelf stays booked
    expect(recordNow()).toMatchObject({ action: "adjust", expected: 8, actual: 4, offShelf: 1, settled: true });
    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.qty).toBe(3);                               // |5 − 8|
    expect(mv.from).toBe(HUB);
    expect(mv.link.countOffShelf).toBe(1);
  });

  it("a shelf count matching booked − offShelf via the adjust path is just a confirm", async () => {
    seedCell(5);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                   expected: 5, actual: 4, offShelf: 1 });
    expect(res.ok).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(recordNow().action).toBe("confirm");
  });

  it("flag records the shelf count with its off-shelf context for the admin apply", async () => {
    seedCell(5);
    const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                 expected: 5, actual: 2, offShelf: 1, offShelfNote: "1 on display at Trophy" });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(5);                        // flags never move stock
    expect(recordNow()).toMatchObject({ action: "flag", actual: 2, offShelf: 1, offShelfNote: "1 on display at Trophy" });
  });

  it("flag whose shelf count matches booked − offShelf collapses to a confirm", async () => {
    seedCell(5);
    const res = await flagCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                 expected: 5, actual: 4, offShelf: 1 });
    expect(res.ok).toBe(true);
    expect(recordNow().action).toBe("confirm");
  });

  it("offShelf 0 (or absent) is EXACTLY the old behaviour", async () => {
    seedCell(4);
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 4, actual: 2 });
    expect(res.ok).toBe(true);
    expect(cellNow().qty).toBe(2);
    expect(recordNow()).toMatchObject({ actual: 2, offShelf: 0 });
  });

  it("the stale fence still compares BOOKED numbers — a moved cell rejects regardless of offShelf", async () => {
    seedCell(7);   // the counter was shown 8
    const res = await adjustCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8",
                                   expected: 8, actual: 4, offShelf: 1 });
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(applyMovementMock).not.toHaveBeenCalled();
  });
});

// Negative shelf confirmation is refused — never notarised (CodeRabbit, PR #347).
describe("books-disagree confirm rejection", () => {
  it("confirmCell refuses when known off-shelf exceeds booked", async () => {
    seedCell(1);
    const res = await confirmCell({ hub: HUB, sessionId: SESSION, productId: PID, sizeKey: "8", expected: 1, offShelf: 2 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/books disagree/i);
    expect(recordNow()).toBeNull();
    expect(applyMovementMock).not.toHaveBeenCalled();
  });
});

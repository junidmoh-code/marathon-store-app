// ── Reconcile scope tests: the watermark contract and its backstops ──────────
// Pure-function tests (no RTDB): every rule that decides WHICH nodes a tick
// looks at. These are the tests that stand between "cheap" and "a product that
// silently never publishes", so they are written as the failure they prevent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  sastHour, isOvernight, fullScanIntervalMs, planScan, nextRetrySet, nextWatermark, isMissingIndexError,
  NIGHT_START_HOUR, NIGHT_END_HOUR, WATERMARK_FUTURE_TOLERANCE_MS,
  readChangedPublishNodes, readLivePids, removeMappingIfUnchanged,
  WATERMARK_OVERLAP_MS, FULL_SCAN_DAY_MS, FULL_SCAN_NIGHT_MS, MAX_RETRY_PIDS,
} from "./reconcileScope.mjs";

// SAST is UTC+2, no DST. 2026-09-03T10:00:00Z is 12:00 in Johannesburg.
const at = (iso) => Date.parse(iso);

describe("the clock", () => {
  it("reads UTC+2 with no daylight saving, in January and in July", () => {
    expect(sastHour(at("2026-01-15T10:00:00Z"))).toBe(12);
    expect(sastHour(at("2026-07-15T10:00:00Z"))).toBe(12);
    expect(sastHour(at("2026-09-03T23:30:00Z"))).toBe(1); // wraps past midnight
  });

  it("calls 01:00–07:00 SAST overnight and nothing else", () => {
    expect(isOvernight(at("2026-09-03T23:00:00Z"))).toBe(true);  // 01:00 SAST
    expect(isOvernight(at("2026-09-03T03:00:00Z"))).toBe(true);  // 05:00 SAST
    expect(isOvernight(at("2026-09-03T04:59:00Z"))).toBe(true);  // 06:59 SAST
    expect(isOvernight(at("2026-09-03T05:30:00Z"))).toBe(false); // 07:30 SAST
    expect(isOvernight(at("2026-09-03T18:00:00Z"))).toBe(false); // 20:00 SAST
  });

  // The measured busy hours, held as tests rather than as a comment. 23:00 was
  // classified as overnight by an earlier draft and is the single BUSIEST
  // publishing hour in the mini's log; 00:00 is active too. Backing drift
  // repair off 6× at those hours is the regression this pins.
  it("does NOT call the two busiest publishing hours overnight", () => {
    expect(isOvernight(at("2026-09-03T21:30:00Z"))).toBe(false); // 23:30 SAST
    expect(isOvernight(at("2026-09-03T22:30:00Z"))).toBe(false); // 00:30 SAST
    expect(fullScanIntervalMs(at("2026-09-03T21:30:00Z"))).toBe(FULL_SCAN_DAY_MS);
  });

  // isOvernight is written for both window shapes because the boundaries are
  // measured numbers that may move. The single `>= start || < end` form is
  // correct only when the window wraps midnight; with a non-wrapping window it
  // is true at EVERY hour, which would silently pin the loop to the 3-hour
  // drift cadence for ever. Assert the window is not the whole day.
  it("never calls every hour of the day overnight, whatever the boundaries", () => {
    const midnightUtc = at("2026-09-03T00:00:00Z");
    const hours = Array.from({ length: 24 }, (_, i) => isOvernight(midnightUtc + i * 3600000));
    expect(hours.filter(Boolean).length).toBe(
      NIGHT_START_HOUR > NIGHT_END_HOUR
        ? 24 - NIGHT_START_HOUR + NIGHT_END_HOUR
        : NIGHT_END_HOUR - NIGHT_START_HOUR);
    expect(hours.some((x) => x === false)).toBe(true);
    expect(hours.some((x) => x === true)).toBe(true);
  });

  it("backs the full scan off overnight and not by day", () => {
    expect(fullScanIntervalMs(at("2026-09-03T12:00:00Z"))).toBe(FULL_SCAN_DAY_MS);
    expect(fullScanIntervalMs(at("2026-09-03T02:00:00Z"))).toBe(FULL_SCAN_NIGHT_MS);
  });
});

describe("planScan — an incremental tick may never be the reason work is missed", () => {
  const now = at("2026-09-03T12:00:00Z");

  it("scans everything when there is no state at all (first run, wiped node)", () => {
    expect(planScan({ state: null, nowMs: now }).mode).toBe("full");
    expect(planScan({ state: { watermark: 0 }, nowMs: now }).mode).toBe("full");
    expect(planScan({ state: { watermark: "nonsense" }, nowMs: now }).mode).toBe("full");
  });

  it("scans everything when --full is asked for, whatever the state says", () => {
    const state = { watermark: now - 1000, lastFullScanAt: now - 1000 };
    expect(planScan({ state, nowMs: now, force: true }).mode).toBe("full");
  });

  it("scans everything once the cadence is due, and reads the window otherwise", () => {
    const fresh = { watermark: now - 60_000, lastFullScanAt: now - 60_000 };
    expect(planScan({ state: fresh, nowMs: now }).mode).toBe("incremental");
    const stale = { watermark: now - 60_000, lastFullScanAt: now - FULL_SCAN_DAY_MS - 1 };
    expect(planScan({ state: stale, nowMs: now }).mode).toBe("full");
  });

  it("holds the overnight cadence past the daytime one", () => {
    const night = at("2026-09-03T02:00:00Z");
    const state = { watermark: night - 1000, lastFullScanAt: night - FULL_SCAN_DAY_MS - 1 };
    expect(planScan({ state, nowMs: night }).mode).toBe("incremental");
    const older = { watermark: night - 1000, lastFullScanAt: night - FULL_SCAN_NIGHT_MS - 1 };
    expect(planScan({ state: older, nowMs: night }).mode).toBe("full");
  });

  it("starts the window BEFORE the watermark, so a write racing the last run is not stepped over", () => {
    const state = { watermark: now - 60_000, lastFullScanAt: now - 60_000 };
    expect(planScan({ state, nowMs: now }).since).toBe(now - 60_000 - WATERMARK_OVERLAP_MS);
  });

  // Expressed in terms of the constant, not a literal. The literal was one hour,
  // which silently became the exact boundary when the lookback was widened — the
  // test then failed on a constant rather than on the rule, which is not what it
  // is for. And it is deliberately WATERMARK_FUTURE_TOLERANCE_MS, not the
  // lookback: pinning this to the lookback would codify a coupling between two
  // quantities that only ever shared a name, and make decoupling them fight a
  // test.
  it("falls back to a full scan when the watermark is ahead of the clock", () => {
    const skewed = { watermark: now + WATERMARK_FUTURE_TOLERANCE_MS + 1, lastFullScanAt: now - 1000 };
    expect(planScan({ state: skewed, nowMs: now }).mode).toBe("full");
    // ...and one inside the tolerance is ordinary skew, not corruption.
    const inside = { watermark: now + WATERMARK_FUTURE_TOLERANCE_MS - 1, lastFullScanAt: now - 1000 };
    expect(planScan({ state: inside, nowMs: now }).mode).toBe("incremental");
  });
});

describe("nextRetrySet — unfinished work outlives the window that cannot see it", () => {
  const now = 1_000_000;

  it("remembers a failure, because a failed apply does not move the node's updatedAt", () => {
    expect(nextRetrySet({ previous: {}, attempted: ["a"], failedPids: ["a"], nowMs: now })).toEqual({ a: now });
  });

  it("forgets a product once a later run applies it", () => {
    const carried = nextRetrySet({ previous: { a: 1 }, attempted: ["a"], failedPids: [], nowMs: now });
    expect(carried).toEqual({});
  });

  it("keeps a product that was remembered but NOT attempted this run (per-run cap)", () => {
    expect(nextRetrySet({ previous: { a: 1 }, attempted: ["b"], failedPids: [], nowMs: now })).toEqual({ a: 1 });
  });

  it("keeps the ORIGINAL failure time, so age is real", () => {
    expect(nextRetrySet({ previous: { a: 5 }, attempted: ["a"], failedPids: ["a"], nowMs: now })).toEqual({ a: 5 });
  });

  it("caps the set and drops the OLDEST, so today's failures are never crowded out", () => {
    const previous = {};
    for (let i = 0; i < MAX_RETRY_PIDS; i++) previous[`old${i}`] = i + 1; // oldest = old0
    const next = nextRetrySet({ previous, attempted: [], failedPids: ["new"], nowMs: now });
    expect(Object.keys(next)).toHaveLength(MAX_RETRY_PIDS);
    expect(next.new).toBe(now);
    expect(next.old0).toBeUndefined();
    expect(next[`old${MAX_RETRY_PIDS - 1}`]).toBeDefined();
  });
});

describe("isMissingIndexError — RTDB refuses an unindexed query, it does not sort it", () => {
  it("recognises the live refusal verbatim", () => {
    // Verified against the live database, 3 Sep 2026.
    const err = new Error('Index not defined, add ".indexOn": "updatedAt", for path "/shopify_publish", to the rules');
    expect(isMissingIndexError(err, "updatedAt")).toBe(true);
  });

  it("does not swallow an unrelated failure, or a refusal about a DIFFERENT field", () => {
    expect(isMissingIndexError(new Error("permission_denied at /shopify_publish"), "updatedAt")).toBe(false);
    expect(isMissingIndexError(new Error("network error"), "updatedAt")).toBe(false);
    const other = new Error('Index not defined, add ".indexOn": "state", for path "/shopify_publish", to the rules');
    expect(isMissingIndexError(other, "updatedAt")).toBe(false);
  });
});

// ── One flaky retry read must not cost the whole tick ────────────────────────
// The window read is the cheap half; the retry pids are read one at a time.
// Letting a transient error on one of them propagate would abandon everything
// the window already found — and, because the caller counts evaluated retry
// pids as attempted, a SILENT skip would be worse still: the pid would drain
// out of the retry set and never be tried again.
describe("readChangedPublishNodes", () => {
  // The fake RECORDS what the query was built with. It used to discard both
  // arguments, which meant the one thing this whole module exists for — that
  // the tick asks for a WINDOW and not the whole node — was pinned by nothing:
  // deleting `.startAt(since)` (a silent return to reading everything, every
  // tick) left every test green, and so did ordering by any other field.
  function db({ window: win = {}, points = {} }) {
    const calls = { orderByChild: null, startAt: null, startAtCalled: false };
    return {
      calls,
      ref(path) {
        if (path === "shopify_publish") {
          const q = {
            orderByChild: (f) => { calls.orderByChild = f; return q; },
            startAt: (v) => { calls.startAt = v; calls.startAtCalled = true; return q; },
            get: async () => ({ val: () => win }),
          };
          return q;
        }
        const pid = path.replace("shopify_publish/", "");
        return {
          get: async () => {
            const v = points[pid];
            if (v instanceof Error) throw v;
            return { val: () => v ?? null };
          },
        };
      },
    };
  }

  it("reports an unreadable retry pid instead of throwing, and still returns the window", async () => {
    const seen = [];
    const nodes = await readChangedPublishNodes(
      db({ window: { a: { desiredState: "on" } }, points: { b: new Error("ECONNRESET"), c: { desiredState: "off" } } }),
      { since: 1, retryPids: ["b", "c"], onUnreadable: (pid) => seen.push(pid) },
    );
    // The window's work survives the blip, and so does the readable retry.
    expect(Object.keys(nodes).sort()).toEqual(["a", "c"]);
    expect(seen).toEqual(["b"]);
  });

  it("does not re-read a retry pid the window already returned", async () => {
    let reads = 0;
    const base = db({ window: { a: { desiredState: "on" } }, points: { a: { desiredState: "on" } } });
    const counting = { ref: (p) => { if (p !== "shopify_publish") reads += 1; return base.ref(p); } };
    await readChangedPublishNodes(counting, { since: 1, retryPids: ["a"] });
    expect(reads).toBe(0);
  });

  it("still refuses a bad product id — that is a bug, not a blip", async () => {
    await expect(readChangedPublishNodes(db({}), { since: 1, retryPids: ["a/b"] })).rejects.toThrow();
  });
});

// ── The window is a WINDOW ───────────────────────────────────────────────────
// The saving is entirely in these two calls. Without them the query is a
// whole-node read wearing a query's clothes, at the old price, and every other
// test in this file still passes.
describe("the worklist query itself", () => {
  function recordingDb() {
    const calls = { orderByChild: null, startAt: null, startAtCalled: false };
    const q = {
      orderByChild: (f) => { calls.orderByChild = f; return q; },
      startAt: (v) => { calls.startAt = v; calls.startAtCalled = true; return q; },
      get: async () => ({ val: () => ({}) }),
    };
    return { calls, ref: () => q };
  }

  it("orders by updatedAt and starts at the window, not at the beginning", async () => {
    const db = recordingDb();
    await readChangedPublishNodes(db, { since: 1_700_000_000_000, retryPids: [] });
    // The field is the watermark the page stamps. Any other field silently
    // returns the wrong rows.
    expect(db.calls.orderByChild).toBe("updatedAt");
    // startAt is what makes it a window. Its absence is a whole-node read.
    expect(db.calls.startAtCalled).toBe(true);
    expect(db.calls.startAt).toBe(1_700_000_000_000);
  });
});

// ── The watermark does not step over work the cap did not reach ──────────────
// The failure this prevents, in full: the owner queues 150 intents. The tick
// applies 25 and defers 125. When the leftovers rode the retry set, that set
// was capped at 50, so 75 products were dropped outright — their updatedAt
// never moved, so no later window could find them, and only a full scan would:
// 30 minutes by day, THREE HOURS overnight, against the ~12 minutes the same
// backlog took before this branch existed.
describe("nextWatermark", () => {
  const RUN = 1_700_000_000_000;

  it("advances to the run start when everything was applied", () => {
    expect(nextWatermark({ runStartedAt: RUN, unapplied: [] })).toBe(RUN);
  });

  it("stays one millisecond behind the OLDEST unfinished node", () => {
    const w = nextWatermark({
      runStartedAt: RUN,
      unapplied: [{ updatedAt: RUN - 5_000 }, { updatedAt: RUN - 60_000 }, { updatedAt: RUN - 900 }],
    });
    expect(w).toBe(RUN - 60_000 - 1);
  });

  it("a 150-intent backlog is still draining, not dropped, after the retry cap would have lost it", () => {
    // 125 deferred, all stamped at the same moment — the shape that used to
    // collapse into 50 retry slots.
    const stamped = Array.from({ length: 125 }, () => ({ updatedAt: RUN - 1_000 }));
    const w = nextWatermark({ runStartedAt: RUN, unapplied: stamped });
    // The next window starts before them, so every one of the 125 is in it.
    expect(w).toBeLessThan(RUN - 1_000);
    expect(stamped.every((n) => n.updatedAt > w)).toBe(true);
  });

  it("does NOT advance when an unfinished node has no usable updatedAt", () => {
    // No window can locate such a node, so guessing a bound risks stepping over
    // it. Holding the previous watermark (or none at all, forcing a full scan)
    // is the safe answer.
    expect(nextWatermark({ runStartedAt: RUN, unapplied: [{ updatedAt: undefined }], previousWatermark: 123 })).toBe(123);
    expect(nextWatermark({ runStartedAt: RUN, unapplied: [{}], previousWatermark: null })).toBe(null);
    expect(nextWatermark({ runStartedAt: RUN, unapplied: [{ updatedAt: "soon" }], previousWatermark: 5 })).toBe(5);
  });

  it("never advances past the run start even if a node claims a future stamp", () => {
    expect(nextWatermark({ runStartedAt: RUN, unapplied: [{ updatedAt: RUN + 999_999 }] })).toBe(RUN);
  });
});

// ── The `state` index has no fallback, so it gets a message worth reading ────
// §9.1 asks a person to paste an index into the console by hand. The plausible
// slip is REPLACING ["state"] with ["updatedAt"] rather than adding to it —
// which removes the index this query needs, rots the search index behind one
// generic warning per tick, and breaks the publishing page's own `state`
// queries, with nothing connecting those symptoms to the paste that caused them.
describe("readLivePids when the state index is missing", () => {
  const refusal = () => { throw new Error('Index not defined, add ".indexOn": "state", for path "/shopify_publish", to the rules'); };
  const db = (get) => ({ ref: () => ({ orderByChild: () => ({ equalTo: () => ({ get }) }) }) });

  it("names the actual mistake and both index entries", async () => {
    await expect(readLivePids(db(refusal))).rejects.toThrow(/\["state", "updatedAt"\]/);
    await expect(readLivePids(db(refusal))).rejects.toThrow(/replaced "state" instead of joining it/);
  });

  it("does not swallow an unrelated failure as an index problem", async () => {
    const boom = () => { throw new Error("ECONNRESET"); };
    await expect(readLivePids(db(boom))).rejects.toThrow(/ECONNRESET/);
  });
});

// ── The stale-map removal, driven through a faithful transaction fake ────────
// Two versions of this function have now been wrong, and the SECOND was wrong
// because THIS FAKE was wrong. It modelled `views.shift()`, so the second
// transaction call was guaranteed to see the server value — it asserted by
// construction the "the retry runs against a warmed cache" property that the
// real SDK does not provide, and the broken code passed.
//
// What @firebase/database actually does, checked in node_modules:
//   · the callback runs synchronously against the LOCAL CACHE, before any
//     server data can arrive;
//   · returning `undefined` aborts there and then — the server is NEVER asked,
//     and no later invocation happens;
//   · a `get()` afterwards does NOT leave the value cached (it removes its own
//     registration), so the next transaction starts just as cold;
//   · only a WRITE goes to the server, and only then is the callback re-invoked
//     with the true value.
//
// So `cache` here is what the local cache shows on EVERY call. It never warms.
// A fake that cannot express "the cache stays cold" cannot catch the bug.
function txnDb({ cache, server, staysCold = true }) {
  const state = { server, deleted: false, serverReads: 0, invocations: 0, aborts: 0 };
  let warmed = false;
  const view = () => (cache === undefined || (warmed && !staysCold) ? state.server : cache);
  const apply = (out) => {
    if (out === null) { state.server = null; state.deleted = true; }
    else state.server = out;
  };
  const node = () => ({
    async transaction(fn) {
      const local = view();
      state.invocations += 1;
      let out = fn(local === undefined ? null : local);
      if (out === undefined) {
        // ONE-SHOT. No server contact, no second invocation, cache untouched.
        state.aborts += 1;
        return { committed: false, snapshot: { val: () => local ?? null } };
      }
      // It wanted to write, so it goes to the server. If what the callback saw
      // was not what the server holds, the SDK re-invokes with the true value.
      if (local !== state.server) {
        state.invocations += 1;
        out = fn(state.server === undefined ? null : state.server);
        if (out === undefined) {
          state.aborts += 1;
          return { committed: false, snapshot: { val: () => state.server ?? null } };
        }
      }
      warmed = true;
      apply(out);
      return { committed: true, snapshot: { val: () => state.server ?? null } };
    },
    async get() { state.serverReads += 1; return { val: () => state.server ?? null }; },
    child: () => ({
      async get() { state.serverReads += 1; return { val: () => (state.server ? state.server.shopifyProductId : null) }; },
    }),
  });
  return { state, ref: () => node() };
}

describe("removeMappingIfUnchanged", () => {
  const GID = "gid://shopify/Product/9339656536213";
  const OTHER = "gid://shopify/Product/999";

  it("removes the record when the mapping is unchanged", async () => {
    const db = txnDb({ server: { shopifyProductId: GID, variants: {} } });
    await expect(removeMappingIfUnchanged(db, "p1", GID)).resolves.toBe("removed");
    expect(db.state.deleted).toBe(true);
  });

  // THE REGRESSION THAT MATTERS. On a fresh process — every tick, launchd
  // spawns a new node — the cache is empty and STAYS empty across a confirming
  // read. The version that aborted here returned "changed" for ever: the stale
  // map was never removed, the caller never confirmed off, and the same futile
  // unpublish went out every two minutes. The 1,367-tick loop, rebuilt inside
  // its own fix. Nothing may abort out of the `cur == null` branch.
  it("a COLD CACHE THAT NEVER WARMS still removes the mapping", async () => {
    const db = txnDb({ cache: null, server: { shopifyProductId: GID } });
    await expect(removeMappingIfUnchanged(db, "p1", GID)).resolves.toBe("removed");
    expect(db.state.deleted).toBe(true);
    expect(db.state.aborts).toBe(0);          // it never aborted, so the server was reached
    expect(db.state.invocations).toBe(2);     // cold view, then the true value
  });

  // THE OTHER DIRECTION, and the one that would diverge what is published: a
  // stale cache that MATCHES while the server has been re-mapped. Confirming
  // off here leaves a live, published product recorded as off with the intent
  // consumed, so no later tick retries.
  it("a WARM BUT STALE cache does not report a removal that did not happen", async () => {
    const db = txnDb({ cache: { shopifyProductId: GID }, server: { shopifyProductId: OTHER } });
    await expect(removeMappingIfUnchanged(db, "p1", GID)).resolves.toBe("changed");
    expect(db.state.deleted).toBe(false);
    expect(db.state.server).toEqual({ shopifyProductId: OTHER });
  });

  // A RECORD CLEARED BY SOMEONE ELSE IS NOT A REMOVAL WE PERFORMED, and the
  // difference is a divergence. Collapsing the two into "removed" saves exactly
  // one tick and opens this: a person deletes /shopify_sync/{pid} to repair a
  // bad mapping, this answers "removed", the caller confirms the record OFF and
  // unindexes it, and the person's re-adoption onto a LIVE product then lands —
  // leaving a live published product recorded off with its intent satisfied, so
  // nothing revisits it. The caller must not confirm off on this verdict.
  it("does NOT report an already-cleared record as a removal it performed", async () => {
    const db = txnDb({ server: null });
    await expect(removeMappingIfUnchanged(db, "p1", GID)).resolves.toBe("absent");
  });

  // ...and the caller must treat it as such. Source-pinned, because reconcile.mjs
  // is top-level-await and cannot be imported.
  it("the caller confirms off ONLY on 'removed'", () => {
    const SRC = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
    expect(SRC).toMatch(/if \(outcome !== "removed"\) \{/);
  });

  it("says 'contended' — never 'removed' — when the write does not land", async () => {
    const db = txnDb({ server: { shopifyProductId: GID } });
    db.ref = () => ({ async transaction() { return { committed: false, snapshot: { val: () => null } }; } });
    await expect(removeMappingIfUnchanged(db, "p1", GID)).resolves.toBe("contended");
  });

  it("makes exactly one transaction call — there is no retry loop to spin", async () => {
    let calls = 0;
    const db = txnDb({ server: { shopifyProductId: GID } });
    const inner = db.ref();
    db.ref = () => ({ transaction: (fn) => { calls += 1; return inner.transaction(fn); } });
    await removeMappingIfUnchanged(db, "p1", GID);
    expect(calls).toBe(1);
  });

  it("refuses a malformed product id", async () => {
    await expect(removeMappingIfUnchanged(txnDb({ server: null }), "a/b", GID)).rejects.toThrow();
  });
});

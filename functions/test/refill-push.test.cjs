// ─── REFILL PUSH — the proofs ────────────────────────────────────────────────
// Run: cd functions && node --test test/refill-push.test.cjs
// Mutation-proven by scripts/mutation-proof-push-notify.mjs.
//
// The failures this suite exists to prevent are not "does it send". They are:
//   • an engine sweep firing four hundred notifications at one phone
//   • the same request notified twice because Eventarc delivered it twice
//   • shadow rows — read-only artifacts rewritten every 15 minutes — notifying
//     forever about work that does not exist
//   • a dead token kept alive so the server writes to nobody, or a live one
//     deleted because of a transient quota error
//   • a dirty account (no stockRole, no destShop) crashing the fan-out, which
//     would mean nobody in that hub was told and nothing said so

const { test } = require("node:test");
const assert = require("node:assert");
const {
  notifyRefillRequest, restoreBurst, shouldNotify, pruneSeen, composeMessage,
  STALE_CLAIM_MS, REPLAY_TTL_MS, DEAD_TOKEN_CODES, MAX_RECIPIENTS, MAX_SEEN,
  FLUSH_TICK_MS, MAX_FLUSH_WAIT_MS,
} = require("../lib/refill-push.cjs");

const NOW = 1_757_000_000_000;

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// Models exactly what the fan-out uses: ref().get(), ref().update(),
// ref().transaction() — with CLOUD-FUNCTION COLD-CACHE semantics, which is the
// property the flush transaction is written against. The update fn is invoked
// FIRST with null (an empty local cache), and only if that returns a value is it
// re-run against the real server value. A fake that fed the server value first
// would never exercise the polarity the tombstone flush depends on.
function fakeDb(initial = {}) {
  const state = structuredClone(initial);
  const get = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const setPath = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let n = state;
    for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (value === null || value === undefined) delete n[last]; else n[last] = value;
  };
  const snapOf = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v != null });

  const ref = (path = "") => ({
    async get() { return snapOf(get(path)); },
    async update(updates) {
      for (const [k, v] of Object.entries(updates)) setPath(path ? `${path}/${k}` : k, v);
    },
    async transaction(fn) {
      // Run 1: the cold local cache.
      const first = fn(null);
      if (first === undefined) return { committed: false, snapshot: snapOf(get(path)) };
      const server = get(path);
      // Run 2: the CAS re-run, only when the server disagrees with the cache.
      const value = server === undefined ? first : fn(structuredClone(server));
      if (value === undefined) return { committed: false, snapshot: snapOf(server) };
      setPath(path, value === null ? null : structuredClone(value));
      return { committed: true, snapshot: snapOf(value) };
    },
  });
  ref.state = state;
  return { ref, state };
}

function fakeMessaging(plan = {}) {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(message) {
      calls.push(message);
      const responses = message.tokens.map((tok) => {
        const code = plan[tok];
        return code ? { success: false, error: { code } } : { success: true };
      });
      return { responses, successCount: responses.filter((r) => r.success).length };
    },
  };
}

const noSleep = async () => {};

const REQ = (over = {}) => ({
  productId: "p1", size: "9", qty: 2, requestingLocation: "hub1", status: "open",
  createdAt: new Date(NOW).toISOString(), createdFrom: { engine: true }, ...over,
});

// One subscribed warehouse user with one device, plus the product name.
const WORLD = () => ({
  push_audience: { all: { u_ware: { at: NOW } } },
  push_tokens: { u_ware: { d1: { token: "tok-A", device: "iPhone Safari · installed · d1" } } },
  products: { p1: { name: "Nike Air Max 90" } },
});

const run = (db, messaging, requestId, record, over = {}) => notifyRefillRequest({
  db, messaging, requestId, record, nowMs: NOW, sleep: noSleep,
  newWindowId: () => "W1", ...over,
});

// ── THE GUARDS: what must NOT produce a notification ─────────────────────────

test("a shadow row notifies nobody — it is a preview the sweep rewrites every 15 minutes", async () => {
  assert.equal(shouldNotify("abc", REQ({ shadow: true })), "shadow");
  // Guarded twice, because the flag and the key prefix are written by the same
  // line in refill-scan.cjs and either could be the one that changes.
  assert.equal(shouldNotify("SHDWrr-p1-9", REQ()), "shadow_key");

  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, "SHDWrr-p1-9", REQ())).skipped, "shadow_key");
  assert.equal(m.calls.length, 0);
});

test("a row that is not open notifies nobody", async () => {
  assert.equal(shouldNotify("a", REQ({ status: "fulfilled" })), "not_open");
  assert.equal(shouldNotify("a", REQ({ status: "cancelled" })), "not_open");
});

test("a row with no destination notifies nobody, and does not throw", async () => {
  assert.equal(shouldNotify("a", REQ({ requestingLocation: null })), "no_destination");
  assert.equal(shouldNotify("a", REQ({ requestingLocation: "   " })), "no_destination");
  assert.equal(shouldNotify("a", null), "not_a_record");
  assert.equal(shouldNotify("a", "nonsense"), "not_a_record");
});

// ── BURST COLLAPSE ───────────────────────────────────────────────────────────

test("BURST COLLAPSE: 40 requests in one sweep produce ONE notification saying 40", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  // The claimer opens the window and is held at the flush until every other
  // request has landed — which is exactly the real ordering: it is asleep.
  let releaseFlush;
  const held = new Promise((r) => { releaseFlush = r; });
  const claimer = notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r0", record: REQ(), nowMs: NOW,
    sleep: () => held, newWindowId: () => "W1",
  });

  const joiners = [];
  for (let i = 1; i < 40; i += 1) {
    joiners.push(await notifyRefillRequest({
      db: { ref }, messaging: m, requestId: `r${i}`, record: REQ({ size: String(i) }),
      nowMs: NOW + i * 10, sleep: noSleep, newWindowId: () => `W${i + 1}`,
    }));
  }
  assert.deepEqual([...new Set(joiners.map((j) => j.skipped))], ["joined_window"]);
  assert.equal(m.calls.length, 0, "no joiner may send");

  releaseFlush();
  const res = await claimer;
  assert.equal(res.sent, true);
  assert.equal(res.count, 40);
  assert.equal(m.calls.length, 1, "one sweep, one notification");
  assert.equal(m.calls[0].data.title, "40 new refill requests");
  assert.match(m.calls[0].data.body, /Hub 1/);
  // The window is closed, not deleted — that is what keeps the replay memory.
  assert.equal(state.push_bursts.hub1.windowId, null);
  assert.ok(state.push_bursts.hub1.closedAt);
});

test("two hubs bursting at once get one notification EACH, not one between them", async () => {
  const world = WORLD();
  world.push_audience.hub2 = { u_pe: { at: NOW } };
  world.push_tokens.u_pe = { d9: { token: "tok-B" } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();

  const a = await run({ ref }, m, "a1", REQ({ requestingLocation: "hub1" }));
  const b = await run({ ref }, m, "b1", REQ({ requestingLocation: "hub2" }), { newWindowId: () => "W2" });
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(m.calls.length, 2);
  assert.deepEqual(m.calls.map((c) => c.data.hub), ["hub1", "hub2"]);
});

test("a request arriving long after the claimer went quiet opens a NEW window", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "r1", REQ());
  const later = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r2", record: REQ(),
    nowMs: NOW + STALE_CLAIM_MS + 1000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(later.sent, true);
  assert.equal(m.calls.length, 2);
});

// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────

test("IDEMPOTENCY: a redelivered creation of the SAME request sends nothing", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const first = await run({ ref }, m, "r1", REQ());
  assert.equal(first.sent, true);
  assert.equal(m.calls.length, 1);

  // Eventarc redelivers the same create a minute later. The window it belonged
  // to has closed — the replay memory is what has to catch this, and it must
  // survive the close for that reason.
  const replay = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r1", record: REQ(),
    nowMs: NOW + 60_000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(replay.sent, false);
  assert.equal(replay.skipped, "replay");
  assert.equal(m.calls.length, 1, "a retried trigger must not double-send");
});

test("a redelivery INSIDE the window does not inflate the count either", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r1", record: REQ(), nowMs: NOW,
    sleep: () => held, newWindowId: () => "W1",
  });
  const dup = await run({ ref }, m, "r1", REQ(), { newWindowId: () => "W2" });
  assert.equal(dup.skipped, "replay");
  release();
  assert.equal((await claimer).count, 1);
});

test("the replay memory is pruned by AGE, so it cannot grow without bound", () => {
  const kept = pruneSeen({ old: NOW - REPLAY_TTL_MS - 1, fresh: NOW - 1000 }, NOW);
  assert.deepEqual(Object.keys(kept), ["fresh"]);
  // A malformed entry is dropped rather than kept forever as a poison key.
  assert.deepEqual(pruneSeen({ bad: "yesterday" }, NOW), {});
  assert.deepEqual(pruneSeen(null, NOW), {});
});

// ── DEAD TOKEN PRUNING ───────────────────────────────────────────────────────

test("PRUNING: an UNREGISTERED token is deleted immediately", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-DEAD" };
  const { ref, state } = fakeDb(world);
  const m = fakeMessaging({ "tok-DEAD": "messaging/registration-token-not-registered" });
  const res = await run({ ref }, m, "r1", REQ());
  assert.equal(res.pruned, 1);
  assert.equal(state.push_tokens.u_ware.d2, undefined, "the dead token is gone");
  assert.ok(state.push_tokens.u_ware.d1, "the live one is untouched");
});

test("PRUNING: an INVALID_ARGUMENT token is deleted too", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-BAD" };
  const { ref, state } = fakeDb(world);
  const m = fakeMessaging({ "tok-BAD": "messaging/invalid-argument" });
  await run({ ref }, m, "r1", REQ());
  assert.equal(state.push_tokens.u_ware.d2, undefined);
});

test("PRUNING: a TRANSIENT failure never costs someone their registration", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging({ "tok-A": "messaging/server-unavailable" });
  const res = await run({ ref }, m, "r1", REQ());
  assert.equal(res.pruned, 0);
  assert.ok(state.push_tokens.u_ware.d1, "a quota or transport error is not a dead address");
  assert.ok(DEAD_TOKEN_CODES.has("messaging/registration-token-not-registered"));
  assert.ok(!DEAD_TOKEN_CODES.has("messaging/server-unavailable"));
});

// ── THE RECIPIENT SET ────────────────────────────────────────────────────────

test("recipients come from the index, and the wildcard bucket reaches every hub", async () => {
  const world = WORLD();
  world.push_audience.hub2 = { u_scoped: { at: NOW } };
  world.push_tokens.u_scoped = { d5: { token: "tok-SCOPED" } };
  const { ref } = fakeDb(world);

  const m1 = fakeMessaging();
  await run({ ref }, m1, "r1", REQ({ requestingLocation: "hub1" }));
  assert.deepEqual(m1.calls[0].tokens, ["tok-A"], "the hub2-scoped user hears nothing about hub1");

  const m2 = fakeMessaging();
  await run({ ref }, m2, "r2", REQ({ requestingLocation: "hub2" }), { newWindowId: () => "W2" });
  assert.deepEqual(m2.calls[0].tokens.sort(), ["tok-A", "tok-SCOPED"], "wildcard + scoped, deduped");
});

test("a uid in the index with no tokens contributes nothing and breaks nothing", async () => {
  const world = WORLD();
  world.push_audience.all.u_ghost = { at: NOW };   // registered once, tokens since revoked
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, "r1", REQ());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-A"]);
});

test("nobody subscribed: it closes the window quietly rather than throwing", async () => {
  const { ref } = fakeDb({ products: { p1: { name: "Nike Air Max 90" } } });
  const m = fakeMessaging();
  const res = await run({ ref }, m, "r1", REQ());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients");
  assert.equal(m.calls.length, 0);
});

test("the recipient set is capped, so a corrupted index cannot fan out forever", async () => {
  const world = WORLD();
  for (let i = 0; i < MAX_RECIPIENTS + 50; i += 1) world.push_audience.all[`u${i}`] = { at: NOW };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, "r1", REQ());
  // u_ware is the only uid with a token; the cap is on how many are RESOLVED.
  assert.ok(m.calls.length <= 1);
});

// ── THE WORDS, AND THE LINK ──────────────────────────────────────────────────

test("one request names the hub and the product; a burst names the number", async () => {
  const { ref } = fakeDb(WORLD());
  const one = await composeMessage({ ref }, "hub1", 1, { productId: "p1", size: "9", qty: 2 });
  assert.equal(one.title, "New refill request");
  assert.equal(one.body, "Hub 1 — Nike Air Max 90 · size 9 ×2");

  // A burst names its first product too: "6 items to pick" is a number, while
  // "Nike Air Max 90 and 5 more" is a thing you can picture — and it is what
  // tells someone at a glance whether this is the delivery they were waiting for.
  const many = await composeMessage({ ref }, "marathon-pe", 6, { productId: "p1" });
  assert.equal(many.title, "6 new refill requests");
  assert.equal(many.body, "Marathon PE — Nike Air Max 90 and 5 more to pick.");

  const nameless = await composeMessage({ ref }, "hub1", 4, { productId: "gone" });
  assert.equal(nameless.body, "Hub 1 — 4 items to pick.");
});

test("a one-size product does not advertise its placeholder size key", async () => {
  const { ref } = fakeDb(WORLD());
  const msg = await composeMessage({ ref }, "hub2", 1, { productId: "p1", size: "_", qty: 1 });
  assert.equal(msg.body, "Hub 2 — Nike Air Max 90");
});

test("a product with no name still produces a readable notification", async () => {
  const { ref } = fakeDb({ });
  const msg = await composeMessage({ ref }, "hub1", 1, { productId: "missing", size: "9" });
  assert.equal(msg.body, "Hub 1 — 1 item to pick.");
});

test("the payload is DATA-ONLY and deep-links to the destination's own queue", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "r1", REQ({ requestingLocation: "hub1" }));
  const sent = m.calls[0];
  // A `notification` block would be displayed by the browser ITSELF, including
  // while the app is open — the double-fire the foreground half exists to stop.
  assert.equal(sent.notification, undefined);
  assert.equal(typeof sent.data.title, "string");
  assert.equal(sent.data.link, "/?push=refill&hub=hub1&tab=hub1refill");
  assert.equal(sent.webpush.fcmOptions.link, sent.data.link);
  // FCM rejects a data payload containing a non-string.
  for (const v of Object.values(sent.data)) assert.equal(typeof v, "string");
});

test("hub2 deep-links to the Hub 2 queue", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "r1", REQ({ requestingLocation: "hub2" }));
  assert.equal(m.calls[0].data.link, "/?push=refill&hub=hub2&tab=clothing");
});

test("a STORE destination opens the app, not a queue that would not list it", async () => {
  // Source has exactly two hub queues, and the "clothing" tab renders hub2 and
  // nothing else. A store leg's work is an R### order in the warehouse queue,
  // so linking it to "clothing" — as the first draft did — landed the reader on
  // a screen where the thing they were just told about is absent. A
  // notification that opens the WRONG screen is worse than one that opens no
  // particular screen: the reader concludes the alert was wrong.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  for (const dest of ["marathon-pe", "trophy", "marathon-pine", "hub3"]) {
    m.calls.length = 0;
    await notifyRefillRequest({
      db: { ref }, messaging: m, requestId: `r-${dest}`, record: REQ({ requestingLocation: dest }),
      nowMs: NOW, sleep: noSleep, newWindowId: () => `W-${dest}`,
    });
    assert.equal(m.calls[0].data.link, "/", `${dest} must not be sent to a hub queue`);
  }
});

// ── DIRTY DATA ───────────────────────────────────────────────────────────────

test("a request naming an unknown destination still notifies readably", async () => {
  const world = WORLD();
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, "r1", REQ({ requestingLocation: "hub-from-2019" }));
  assert.equal(res.sent, true, "the wildcard bucket still covers it");
  assert.match(m.calls[0].data.body, /hub-from-2019/);
});

test("a malformed audience node does not crash the fan-out", async () => {
  for (const bad of [null, "nonsense", 42, []]) {
    const world = WORLD();
    world.push_audience.all = bad;
    const { ref } = fakeDb(world);
    const m = fakeMessaging();
    await assert.doesNotReject(run({ ref }, m, "r1", REQ()));
  }
});

test("a token row with no token string is skipped, not sent as undefined", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d3 = { device: "half-written row" };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, "r1", REQ());
  assert.deepEqual(m.calls[0].tokens, ["tok-A"]);
});

// ── THE TWO FAILURES THE FIRST DRAFT HAD ─────────────────────────────────────

test("a window whose claimer DIED carries its count forward — late, never lost", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  // Five requests land; the claimer never returns (the instance was killed).
  let neverResolves;
  const stuck = new Promise((r) => { neverResolves = r; });
  notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r0", record: REQ(), nowMs: NOW,
    sleep: () => stuck, newWindowId: () => "W1",
  });
  for (let i = 1; i < 5; i += 1) {
    await notifyRefillRequest({
      db: { ref }, messaging: m, requestId: `r${i}`, record: REQ(), nowMs: NOW + i,
      sleep: noSleep, newWindowId: () => `Wx${i}`,
    });
  }
  assert.equal(state.push_bursts.hub1.count, 5);
  assert.equal(m.calls.length, 0, "nobody has been told anything yet");

  // The window ages out and the next request opens a new one. The five orphans
  // are already in `seen`, so nothing will ever re-count them — discarding the
  // count here would understate the work permanently.
  const next = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r9", record: REQ(),
    nowMs: NOW + STALE_CLAIM_MS + 1, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(next.sent, true);
  assert.equal(next.count, 6, "5 orphaned + 1 new");
  neverResolves();
});

test("the replay memory is CAPPED, so one node cannot grow with the burst", () => {
  const seen = {};
  for (let i = 0; i < MAX_SEEN + 500; i += 1) seen[`r${i}`] = NOW - (MAX_SEEN + 500 - i);
  const kept = pruneSeen(seen, NOW);
  // Unbounded, the 400th request of a sweep would read and rewrite 400 ids —
  // O(n^2) bytes on the single node every request for that hub transacts on.
  assert.equal(Object.keys(kept).length, MAX_SEEN);
  // The newest survive: a redelivery is most likely to be about a recent id.
  assert.ok(kept[`r${MAX_SEEN + 499}`], "the most recent id is kept");
  assert.ok(!kept.r0, "the oldest is dropped");
});

test("A FAILED SEND PUTS THE COUNT BACK — a burst is never lost silently", async () => {
  const { ref, state } = fakeDb(WORLD());
  const exploding = {
    calls: [],
    async sendEachForMulticast() { throw new Error("FCM 503"); },
  };
  const res = await run({ ref }, exploding, "r1", REQ());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "send_failed");
  assert.equal(res.count, 1);

  // The window is re-opened, ALREADY EXPIRED, holding the count. The requests it
  // counted are in `seen` and can never be re-counted, so discarding here would
  // lose them permanently.
  const w = state.push_bursts.hub1;
  assert.ok(w.windowId, "a window is open again");
  assert.equal(w.count, 1);
  // startedAt 0 — expired against every possible clock. Anything derived from
  // the current time can still look OPEN to a request arriving moments later,
  // which would make it a joiner of a window that has no claimer, and nothing
  // would ever flush it.
  assert.equal(w.startedAt, 0, "expired on purpose, so the next request flushes it at once");

  // The very next request carries it forward and gets through.
  const m = fakeMessaging();
  const next = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r2", record: REQ(),
    nowMs: NOW + 1000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(next.sent, true);
  assert.equal(next.count, 2, "the failed one plus the new one");
});

test("a restore folds into a LIVE window rather than clobbering someone else's claim", async () => {
  const { ref, state } = fakeDb(WORLD());
  await ref("push_bursts/hub1").transaction(() => ({
    windowId: "OTHER", startedAt: NOW, count: 3, sample: null, seen: {}, closedAt: null,
  }));
  await restoreBurst({
    burstRef: ref("push_bursts/hub1"), count: 5,
    captured: { sample: { productId: "p1" } }, closedAt: NOW,
  });
  assert.equal(state.push_bursts.hub1.windowId, "OTHER", "the live claim is untouched");
  assert.equal(state.push_bursts.hub1.count, 8, "3 live + 5 restored");
});

test("THE COLLAPSE SURVIVES A SLOW SWEEP — the claimer waits for quiet, not for a clock", async () => {
  // The failure this replaces: with a FIXED flush delay, a sweep that keeps
  // writing past the delay produced "40 new refill requests", then "35 new
  // refill requests", then more. Fewer than one notification per request, but
  // still not the one notification the burst is supposed to become.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();

  // Each tick of the claimer's wait lets 10 more requests land — a sweep that
  // is still going. The 4th tick lets nothing land, which is the sweep ending.
  let tick = 0;
  let landed = 0;
  const sweepSleep = async () => {
    tick += 1;
    if (tick > 4) return;
    for (let i = 0; i < 10; i += 1) {
      landed += 1;
      await notifyRefillRequest({
        db: { ref }, messaging: m, requestId: `r${landed}`, record: REQ(),
        nowMs: NOW + landed, sleep: noSleep, newWindowId: () => `Wj${landed}`,
      });
    }
  };

  const res = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r0", record: REQ(),
    nowMs: NOW, sleep: sweepSleep, newWindowId: () => "W1",
  });

  assert.equal(res.sent, true);
  assert.equal(m.calls.length, 1, "a sweep spanning several ticks is still ONE notification");
  assert.equal(res.count, 41, "the claimer plus every request that landed while it waited");
  assert.equal(m.calls[0].data.title, "41 new refill requests");
});

test("the wait ends at the ceiling rather than never — a burst that never stops still lands", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  let landed = 0;
  let clock = NOW;
  // Never goes quiet: every tick adds another request AND advances the clock,
  // so only the ceiling can end this wait.
  const forever = async () => {
    landed += 1;
    clock += FLUSH_TICK_MS;
    if (clock - NOW > MAX_FLUSH_WAIT_MS * 3) throw new Error("the ceiling did not stop the wait");
    await notifyRefillRequest({
      db: { ref }, messaging: m, requestId: `x${landed}`, record: REQ(),
      nowMs: NOW + landed, sleep: noSleep, newWindowId: () => `Wx${landed}`,
    });
  };
  const res = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "x0", record: REQ(),
    nowMs: NOW, sleep: forever, now: () => clock, newWindowId: () => "W1",
  });
  assert.equal(res.sent, true, "an unending burst still produces a notification");
  assert.equal(m.calls.length, 1);
});

test("A LIVE CLAIMER IS NOT ROBBED — one clock, a sweep that outlives any fixed threshold", async () => {
  // THE test the earlier suite could not fail. Its slow-sweep case advanced the
  // joiners' clock by milliseconds and the claimer's by ticks — two clocks that
  // are the same clock in production — so a joining request's `nowMs` never
  // crossed the threshold that decided whether the claimer looked dead. With a
  // fixed WINDOW_MS this scenario stole the burst from a live claimer every 90
  // seconds and split one sweep into instalments; every test still passed.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();

  let clock = NOW;                      // ONE clock, shared by claimer and joiners
  let landed = 0;
  const slowSweep = async () => {
    // Each tick is 12s of wall clock, and the sweep keeps writing for 200s —
    // the engine's real apply box, and far past any 90s window.
    clock += FLUSH_TICK_MS;
    if (clock - NOW > 200 * 1000) return;   // the sweep finally stops
    for (let i = 0; i < 5; i += 1) {
      landed += 1;
      await notifyRefillRequest({
        db: { ref }, messaging: m, requestId: `s${landed}`, record: REQ(),
        nowMs: clock, sleep: noSleep, now: () => clock, newWindowId: () => `Wj${landed}`,
      });
    }
  };

  const res = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "s0", record: REQ(),
    nowMs: NOW, sleep: slowSweep, now: () => clock, newWindowId: () => "W1",
  });

  assert.equal(res.sent, true, "the original claimer must still be the one that sends");
  assert.equal(m.calls.length, 1, "a 200s sweep is ONE notification, not one per 90s");
  assert.equal(res.count, landed + 1, "every request that landed during the sweep is counted");
});

test("a claimer that stops beating IS judged abandoned — recovery does not depend on the burst's age", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  // A window opened long ago whose claimer beat once and then died.
  await ref("push_bursts/hub1").transaction(() => ({
    windowId: "DEAD", startedAt: NOW, heartbeatAt: NOW, count: 7,
    sample: { productId: "p1", size: "9", qty: 1 }, seen: {}, closedAt: null,
  }));

  // A request three ticks later finds the heartbeat stale and takes over.
  const res = await notifyRefillRequest({
    db: { ref }, messaging: m, requestId: "r1", record: REQ(),
    nowMs: NOW + STALE_CLAIM_MS + 1, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(res.sent, true);
  assert.equal(res.count, 8, "7 orphaned + 1 new");
  assert.equal(state.push_bursts.hub1.windowId, null, "and the window is closed properly");
});

test("a run of failed tick reads flushes; a single blip does NOT", async () => {
  // A sustained read failure fragmenting one sweep into dozens of notifications
  // is the original bug arriving through an error path. One blip must not end
  // the wait; a run of them must.
  const world = WORLD();
  const base = fakeDb(world);
  let failures = 0;
  const flaky = (path) => {
    const inner = base.ref(path);
    return {
      ...inner,
      async get() {
        if (path.startsWith("push_bursts") && failures > 0) { failures -= 1; throw new Error("read blip"); }
        return inner.get();
      },
    };
  };
  const m = fakeMessaging();
  let ticks = 0;
  // One blip, then the burst keeps growing for two more ticks, then quiet.
  const sleepFn = async () => {
    ticks += 1;
    if (ticks === 1) { failures = 1; return; }          // a single blip
    if (ticks <= 3) {
      await notifyRefillRequest({
        db: { ref: flaky }, messaging: m, requestId: `b${ticks}`, record: REQ(),
        nowMs: NOW + ticks, sleep: noSleep, newWindowId: () => `Wb${ticks}`,
      });
    }
  };
  const res = await notifyRefillRequest({
    db: { ref: flaky }, messaging: m, requestId: "b0", record: REQ(),
    nowMs: NOW, sleep: sleepFn, newWindowId: () => "W1",
  });
  assert.equal(res.sent, true);
  assert.ok(res.count > 1, "the wait survived the blip and kept collecting");
  assert.ok(ticks > 1, "one failed read did not end the wait");
});

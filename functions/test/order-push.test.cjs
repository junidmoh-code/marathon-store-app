// ─── ORDER PUSH — the proofs ─────────────────────────────────────────────────
// Run: cd functions && node --test test/order-push.test.cjs
// Mutation-proven by scripts/mutation-proof-push-notify.mjs.
//
// The failures this suite exists to prevent are not "does it send". They are:
//   • an engine sweep firing four hundred notifications at one phone
//   • the same order notified twice because Eventarc delivered it twice
//   • a RECYCLED order id making tomorrow's 005 a replay of today's, so a real
//     order is silently never announced
//   • shadow orders — read-only artifacts rewritten every 15 minutes —
//     notifying forever about work that does not exist
//   • a dead token kept alive so the server writes to nobody, or a live one
//     deleted because of a transient quota error
//   • a dirty record (no destShop, a destShop that is not a legal key) crashing
//     the fan-out, which would mean nobody was told and nothing said so

const { test } = require("node:test");
const assert = require("node:assert");
const {
  notifyOrderPlaced, restoreBurst, shouldNotify, pruneSeen, composeMessage,
  orderLink, warehouseTabFor, hubForOrder, isRefillOrder,
  STALE_CLAIM_MS, REPLAY_TTL_MS, DEAD_TOKEN_CODES, MAX_RECIPIENTS, MAX_SEEN,
  FLUSH_TICK_MS, MAX_FLUSH_WAIT_MS,
} = require("../lib/order-push.cjs");

const NOW = 1_757_000_000_000;
const AT = new Date(NOW).toISOString();

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

// ── THE THREE PRODUCERS, AS THEY REALLY WRITE ────────────────────────────────
// Each factory is the shape its producer actually writes, so a change to any of
// them that this fan-out could not read shows up here rather than on a phone.

/** AssistantView.placeOrders — a customer order, keyed by the daily 001..999. */
const CUSTOMER = (over = {}) => ({
  id: "005", productId: "p1", productName: "Nike Air Max 90", size: "9", sentSize: null,
  productType: "sneaker", customerName: "Ayanda", customerPhone: "+27600000000",
  hub: "hub1", placedAtHub: "hub1", placedStore: "central", destShop: "marathon-pe",
  requestDisplay: false, requestDisplayPartner: false,
  status: "incoming", createdAt: AT, updatedAt: AT, ...over,
});

/** AssistantView.placeRefillRequests — a shop-refill cart line, keyed R###-{n}. */
const REFILL = (over = {}) => ({
  id: "R041-2", productId: "p1", productName: "Nike Air Max 90", size: "M", qty: 3,
  productType: "clothing", customerName: "Shop Refill", customerPhone: null,
  hub: "hub2", placedAtHub: "hub2", placedStore: "central", destShop: "marathon-pe",
  status: "incoming", createdAt: AT, updatedAt: AT, ...over,
});

/** refill-scan.cjs — the engine's own store leg. Same shape plus autoRefill. */
const ENGINE = (over = {}) => REFILL({
  id: "R056-7", autoRefill: true, autoRefillPriority: "high", autoRefillRunId: "2026-09-06T13-00", ...over,
});

/** refill-scan.cjs shadow sync — a read-only preview, rewritten every 15 min. */
const SHADOW = (over = {}) => REFILL({
  id: "SHDW-marathon-pe-p1-M", autoRefill: true, autoShadow: true, ...over,
});

// One subscribed warehouse user with one device, plus the product name.
const WORLD = () => ({
  push_audience: { all: { u_ware: { at: NOW } } },
  push_tokens: { u_ware: { d1: { token: "tok-A", device: "iPhone Safari · installed · d1" } } },
  products: { p1: { name: "Nike Air Max 90" } },
});

const run = (db, messaging, orderId, record, over = {}) => notifyOrderPlaced({
  db, messaging, orderId, record, createdAt: record && record.createdAt,
  nowMs: NOW, sleep: noSleep, newWindowId: () => "W1", ...over,
});

// ── THE GUARDS: what must NOT produce a notification ─────────────────────────

test("a shadow order notifies nobody — it is a preview the sweep rewrites every 15 minutes", async () => {
  assert.equal(shouldNotify("R056-1", SHADOW({ id: "R056-1" }), AT), "shadow");
  // Guarded twice, because the flag and the key prefix are written by the same
  // line in refill-scan.cjs and either could be the one that changes.
  assert.equal(shouldNotify("SHDW-marathon-pe-p1-M", REFILL(), AT), "shadow_key");

  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, "SHDW-marathon-pe-p1-M", REFILL())).skipped, "shadow_key");
  assert.equal(m.calls.length, 0);
});

test("an order that is not incoming notifies nobody — a restore is not work arriving", async () => {
  for (const status of ["ready", "collected", "out_of_stock", "coming_tomorrow", null]) {
    assert.equal(shouldNotify("005", CUSTOMER({ status }), AT), "not_incoming", String(status));
  }
});

test("SUPERSEDED: the id was recycled while the event was in flight, so it is left alone", async () => {
  // Order ids repeat daily. By the time an at-least-once delivery arrives, the
  // node may already hold the NEXT order at that id — announcing the re-read
  // record against the old event would name the wrong thing, and the new record
  // has its own event coming.
  const tomorrow = new Date(NOW + 86_400_000).toISOString();
  assert.equal(shouldNotify("005", CUSTOMER({ createdAt: tomorrow }), AT), "superseded");
  assert.equal(shouldNotify("005", CUSTOMER({ createdAt: AT }), AT), null);

  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER({ createdAt: tomorrow }),
    createdAt: AT, nowMs: NOW, sleep: noSleep, newWindowId: () => "W1",
  });
  assert.equal(res.skipped, "superseded");
  assert.equal(m.calls.length, 0);
});

test("an order that vanished before the re-read notifies nobody, and does not throw", async () => {
  // The trigger re-reads /orders/{id}; a collected-and-cleared order reads back
  // as null. That is a skip, never a crash.
  assert.equal(shouldNotify("005", null, AT), "not_a_record");
  assert.equal(shouldNotify("005", "nonsense", AT), "not_a_record");
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: null, createdAt: AT,
    nowMs: NOW, sleep: noSleep, newWindowId: () => "W1",
  });
  assert.equal(res.skipped, "not_a_record");
  assert.equal(m.calls.length, 0);
});

test("an order with no destShop notifies nobody, and does not throw", async () => {
  assert.equal(shouldNotify("005", CUSTOMER({ destShop: null }), AT), "no_destination");
  assert.equal(shouldNotify("005", CUSTOMER({ destShop: "   " }), AT), "no_destination");
  assert.equal(shouldNotify("005", CUSTOMER({ destShop: 42 }), AT), "no_destination");

  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  for (const bad of [null, "", "   ", 42, {}, []]) {
    const res = await run({ ref }, m, "005", CUSTOMER({ destShop: bad }));
    assert.equal(res.skipped, "no_destination", JSON.stringify(bad));
  }
  assert.equal(m.calls.length, 0, "a malformed destShop is silent, never a crash and never a send");
});

// ── EVERY CREATION PATH, EXACTLY ONCE ────────────────────────────────────────

test("each producer's order fires EXACTLY ONE notification", async () => {
  for (const [label, record, id] of [
    ["checkout",     CUSTOMER(),                        "005"],
    ["refill cart",  REFILL(),                          "R041-2"],
    ["engine leg",   ENGINE(),                          "R056-7"],
  ]) {
    const { ref } = fakeDb(WORLD());
    const m = fakeMessaging();
    const res = await run({ ref }, m, id, record);
    assert.equal(res.sent, true, label);
    assert.equal(res.count, 1, label);
    assert.equal(m.calls.length, 1, `${label}: exactly one notification`);

    // And a redelivery of that same creation adds nothing.
    const again = await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: id, record, createdAt: record.createdAt,
      nowMs: NOW + 60_000, sleep: noSleep, newWindowId: () => "W2",
    });
    assert.equal(again.skipped, "replay", label);
    assert.equal(m.calls.length, 1, `${label}: still exactly one`);
  }
});

test("BURST COLLAPSE ACROSS PRODUCERS: a checkout, a refill cart and an engine leg are ONE notification", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();

  // The claimer opens the window and is held at the flush until the others have
  // landed — which is exactly the real ordering: it is asleep.
  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER(), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });

  const others = [];
  for (const [i, [id, rec]] of [
    ["006", CUSTOMER({ id: "006" })],
    ["R041-1", REFILL({ id: "R041-1" })],
    ["R041-2", REFILL({ id: "R041-2" })],
    ["R056-7", ENGINE()],
  ].entries()) {
    others.push(await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: id, record: rec, createdAt: rec.createdAt,
      nowMs: NOW + i + 1, sleep: noSleep, newWindowId: () => `W${i + 2}`,
    }));
  }
  assert.deepEqual([...new Set(others.map((o) => o.skipped))], ["joined_window"]);
  assert.equal(m.calls.length, 0, "no joiner may send");

  release();
  const res = await claimer;
  assert.equal(res.sent, true);
  assert.equal(res.count, 5, "one store, five orders, whoever wrote them");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].data.title, "Marathon PE — 5 new orders");
});

test("BURST COLLAPSE: 40 orders in one sweep produce ONE notification saying 40", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  let releaseFlush;
  const held = new Promise((r) => { releaseFlush = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "R056-0", record: ENGINE({ id: "R056-0" }), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });

  const joiners = [];
  for (let i = 1; i < 40; i += 1) {
    const rec = ENGINE({ id: `R056-${i}`, size: String(i) });
    joiners.push(await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
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
  assert.equal(m.calls[0].data.title, "Marathon PE — 40 new orders");
  assert.match(m.calls[0].data.body, /Nike Air Max 90 and 39 more/);
  // The window is closed, not deleted — that is what keeps the replay memory.
  assert.equal(state.push_bursts["marathon-pe"].windowId, null);
  assert.ok(state.push_bursts["marathon-pe"].closedAt);
});

test("two stores ordering at once get one notification EACH, not one between them", async () => {
  const world = WORLD();
  world.push_audience.trophy = { u_troph: { at: NOW } };
  world.push_tokens.u_troph = { d9: { token: "tok-B" } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();

  const a = await run({ ref }, m, "005", CUSTOMER({ destShop: "marathon-pe" }));
  const b = await run({ ref }, m, "006", CUSTOMER({ id: "006", destShop: "trophy" }), { newWindowId: () => "W2" });
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(m.calls.length, 2);
  assert.deepEqual(m.calls.map((c) => c.data.hub), ["marathon-pe", "trophy"]);
  // The wrong-shop collapse this keying prevents: one sentence naming one shop
  // while the other shop's order hides inside its count.
  assert.deepEqual(m.calls.map((c) => c.data.count), ["1", "1"]);
});

test("an order arriving long after the claimer went quiet opens a NEW window", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "005", CUSTOMER());
  const rec = CUSTOMER({ id: "006" });
  const later = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "006", record: rec, createdAt: rec.createdAt,
    nowMs: NOW + STALE_CLAIM_MS + 1000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(later.sent, true);
  assert.equal(m.calls.length, 2);
});

// ── IDEMPOTENCY, AND THE RECYCLED ID ─────────────────────────────────────────

test("IDEMPOTENCY: a redelivered creation of the SAME order sends nothing", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const first = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(first.sent, true);
  assert.equal(m.calls.length, 1);

  // Eventarc redelivers the same create a minute later. The window it belonged
  // to has closed — the replay memory is what has to catch this, and it must
  // survive the close for that reason.
  const replay = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER(), createdAt: AT,
    nowMs: NOW + 60_000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(replay.sent, false);
  assert.equal(replay.skipped, "replay");
  assert.equal(m.calls.length, 1, "a retried trigger must not double-send");
});

test("TOMORROW'S 005 IS NOT A REPLAY OF TODAY'S — the replay key carries createdAt", async () => {
  // Both counters reset daily and cycle 001-999 while the nodes persist, so the
  // same id is written again and again. Keyed on the bare id, the replay memory
  // would swallow the next day's real order and nobody would ever be told.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "005", CUSTOMER());
  assert.equal(m.calls.length, 1);

  const tomorrow = new Date(NOW + 60_000).toISOString();
  const next = CUSTOMER({ createdAt: tomorrow, productName: "New Balance 530" });
  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: next, createdAt: tomorrow,
    nowMs: NOW + 60_000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(res.sent, true, "the same id with a new createdAt is a NEW order");
  assert.equal(m.calls.length, 2);
  assert.match(m.calls[1].data.body, /New Balance 530/);
});

test("a redelivery INSIDE the window does not inflate the count either", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER(), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });
  const dup = await run({ ref }, m, "005", CUSTOMER(), { newWindowId: () => "W2" });
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
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.pruned, 1);
  assert.equal(state.push_tokens.u_ware.d2, undefined, "the dead token is gone");
  assert.ok(state.push_tokens.u_ware.d1, "the live one is untouched");
});

test("PRUNING: an INVALID_ARGUMENT token is deleted too", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-BAD" };
  const { ref, state } = fakeDb(world);
  const m = fakeMessaging({ "tok-BAD": "messaging/invalid-argument" });
  await run({ ref }, m, "005", CUSTOMER());
  assert.equal(state.push_tokens.u_ware.d2, undefined);
});

test("PRUNING: a TRANSIENT failure never costs someone their registration", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging({ "tok-A": "messaging/server-unavailable" });
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.pruned, 0);
  assert.ok(state.push_tokens.u_ware.d1, "a quota or transport error is not a dead address");
  assert.ok(DEAD_TOKEN_CODES.has("messaging/registration-token-not-registered"));
  assert.ok(!DEAD_TOKEN_CODES.has("messaging/server-unavailable"));
});

// ── THE RECIPIENT SET ────────────────────────────────────────────────────────

test("recipients come from the index, and the wildcard bucket reaches every store", async () => {
  const world = WORLD();
  world.push_audience.trophy = { u_scoped: { at: NOW } };
  world.push_tokens.u_scoped = { d5: { token: "tok-SCOPED" } };
  const { ref } = fakeDb(world);

  const m1 = fakeMessaging();
  await run({ ref }, m1, "005", CUSTOMER({ destShop: "marathon-pe" }));
  assert.deepEqual(m1.calls[0].tokens, ["tok-A"], "the Trophy-scoped user hears nothing about PE");

  const m2 = fakeMessaging();
  await run({ ref }, m2, "006", CUSTOMER({ id: "006", destShop: "trophy" }), { newWindowId: () => "W2" });
  assert.deepEqual(m2.calls[0].tokens.sort(), ["tok-A", "tok-SCOPED"], "wildcard + scoped, deduped");
});

test("a uid in the index with no tokens contributes nothing and breaks nothing", async () => {
  const world = WORLD();
  world.push_audience.all.u_ghost = { at: NOW };   // registered once, tokens since revoked
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-A"]);
});

test("nobody subscribed: it closes the window quietly rather than throwing", async () => {
  const { ref } = fakeDb({ products: { p1: { name: "Nike Air Max 90" } } });
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients");
  assert.equal(m.calls.length, 0);
});

test("the recipient set is capped, so a corrupted index cannot fan out forever", async () => {
  const world = WORLD();
  // EVERY surplus uid gets a token. An earlier version of this test gave a
  // token only to u_ware, so deleting the cap still produced one token and the
  // assertion passed — it could not fail, which is the same as not existing.
  for (let i = 0; i < MAX_RECIPIENTS + 50; i += 1) {
    world.push_audience.all[`u${i}`] = { at: NOW };
    world.push_tokens[`u${i}`] = { d1: { token: `tok-${i}` } };
  }
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, "005", CUSTOMER());
  assert.equal(m.calls.length, 1);
  assert.ok(
    m.calls[0].tokens.length <= MAX_RECIPIENTS,
    `resolved ${m.calls[0].tokens.length} recipients, cap is ${MAX_RECIPIENTS}`,
  );
});

test("a destShop that is not a legal RTDB key is REFUSED, not turned into a path", async () => {
  // These arrive on records this function does not write, and the data is known
  // to be dirty. A "." or "#" makes db.ref() throw before the send's try/catch
  // exists; a "/" would silently split one store's window across two nodes and
  // stop the collapse working, with nothing to show for it.
  for (const bad of ["a.b", "a#b", "a$b", "a/b", "a[b", "a]b", "marathon.pe"]) {
    assert.equal(shouldNotify("005", CUSTOMER({ destShop: bad }), AT), "bad_destination", bad);
  }
  for (const good of ["marathon-pe", "trophy", "marathon-pine", "marathon_pine", "hub1"]) {
    assert.equal(shouldNotify("005", CUSTOMER({ destShop: good }), AT), null, good);
  }

  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER({ destShop: "marathon/pe" }));
  assert.equal(res.skipped, "bad_destination");
  assert.equal(m.calls.length, 0);
});

test("a lone order is quiet at the FIRST tick, not the second", async () => {
  // lastCount used to start at -1, which no real count can equal, so a single
  // hand-placed order always waited two ticks — 24 seconds, twice what every
  // comment in the file promised.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  let ticks = 0;
  await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER(), createdAt: AT,
    nowMs: NOW, sleep: async () => { ticks += 1; }, newWindowId: () => "W1",
  });
  assert.equal(ticks, 1, "one order that attracts no joiners waits exactly one tick");
  assert.equal(m.calls.length, 1);
});

// ── THE WORDS, AND THE LINK ──────────────────────────────────────────────────

test("one order names the store, the number and the product; a burst names the count", async () => {
  const { ref } = fakeDb(WORLD());
  const one = await composeMessage({ ref }, "marathon-pe", 1, {
    orderId: "005", productId: "p1", productName: "Nike Air Max 90", size: "9", qty: 2,
  });
  assert.equal(one.title, "Marathon PE — new order");
  assert.equal(one.body, "#005 · Nike Air Max 90 · size 9 ×2");

  // A burst names its first product too: "6 orders" is a number, while "Nike Air
  // Max 90 and 5 more" is a thing you can picture — and it is what tells someone
  // at a glance whether this is the one they were waiting for.
  const many = await composeMessage({ ref }, "trophy", 6, { orderId: "005", productName: "Nike Air Max 90" });
  assert.equal(many.title, "Trophy — 6 new orders");
  assert.equal(many.body, "Nike Air Max 90 and 5 more to pick.");

  const nameless = await composeMessage({ ref }, "marathon-pine", 4, { productId: "gone" });
  assert.equal(nameless.title, "Marathon Pine — 4 new orders");
  assert.equal(nameless.body, "4 items to pick.");
});

test("a shop refill says so, so a lock screen distinguishes it from a customer's order", async () => {
  const { ref } = fakeDb(WORLD());
  const msg = await composeMessage({ ref }, "marathon-pe", 1, {
    orderId: "R041-2", productName: "Nike Nocta Puffer", size: "M", qty: 3, refill: true,
  });
  assert.equal(msg.body, "#R041-2 · Shop refill: Nike Nocta Puffer · size M ×3");
});

test("the product name comes off the ORDER, with /products only as a fallback", async () => {
  // Every producer writes productName onto the order, so the normal path costs
  // no read at all — and a name that has since been renamed in the catalogue
  // still matches the slip in the picker's hand.
  const { ref } = fakeDb(WORLD());
  const fromOrder = await composeMessage({ ref }, "marathon-pe", 1, {
    orderId: "005", productId: "p1", productName: "Name As Ordered",
  });
  assert.match(fromOrder.body, /Name As Ordered/);
  const fromCatalogue = await composeMessage({ ref }, "marathon-pe", 1, { orderId: "005", productId: "p1" });
  assert.match(fromCatalogue.body, /Nike Air Max 90/);
});

test("a one-size product does not advertise its placeholder size key", async () => {
  const { ref } = fakeDb(WORLD());
  const msg = await composeMessage({ ref }, "trophy", 1, {
    orderId: "005", productId: "p1", size: "_", qty: 1,
  });
  assert.equal(msg.body, "#005 · Nike Air Max 90");
});

test("a product with no name anywhere still produces a readable notification", async () => {
  const { ref } = fakeDb({});
  const msg = await composeMessage({ ref }, "marathon-pe", 1, { orderId: "005", productId: "missing", size: "9" });
  assert.equal(msg.body, "#005 · 1 item to pick.");
});

test("the payload is DATA-ONLY and deep-links to the ORDER, not to a list", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  await run({ ref }, m, "005", CUSTOMER());
  const sent = m.calls[0];
  // A `notification` block would be displayed by the browser ITSELF, including
  // while the app is open — the double-fire the foreground half exists to stop.
  assert.equal(sent.notification, undefined);
  assert.equal(typeof sent.data.title, "string");
  assert.equal(sent.data.kind, "order");
  assert.equal(
    sent.data.link,
    `/?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}`,
  );
  assert.equal(sent.webpush.fcmOptions.link, sent.data.link);
  // One tag per destination store: a second notification for the same shop
  // REPLACES the first in the tray instead of stacking a column of them.
  assert.equal(sent.data.tag, "order-marathon-pe");
  // FCM rejects a data payload containing a non-string.
  for (const v of Object.values(sent.data)) assert.equal(typeof v, "string");
});

test("a CR refill at a CR hub links to the clothing tab; a customer order to the queue", () => {
  assert.equal(warehouseTabFor(REFILL({ hub: "hub2" })), "clothing");
  assert.equal(warehouseTabFor(ENGINE({ hub: "hub3", placedAtHub: "hub3" })), "clothing");
  assert.equal(warehouseTabFor(CUSTOMER({ hub: "hub2" })), "queue", "a customer order is on the queue");
  // A refill routed to a hub with no CR tab belongs on the order queue, not on
  // a tab that would not list it.
  assert.equal(warehouseTabFor(REFILL({ hub: "hub1", placedAtHub: "hub1" })), "queue");
});

test("hubForOrder agrees with the warehouse's own filter under every shape", () => {
  assert.equal(hubForOrder(CUSTOMER({ hub: "hub1", placedAtHub: "hub1" })), "hub1");
  assert.equal(hubForOrder(CUSTOMER({ hub: null, placedAtHub: "hub3" })), "hub3");
  assert.equal(hubForOrder(CUSTOMER({ hub: null, placedAtHub: null })), "");
  assert.equal(isRefillOrder(REFILL()), true);
  assert.equal(isRefillOrder(ENGINE({ customerName: null })), true, "autoRefill alone is enough");
  assert.equal(isRefillOrder(CUSTOMER()), false);
});

test("A BURST OPENS THE QUEUE, not one card — several orders cannot be one card", () => {
  const sample = { orderId: "005", createdAt: AT, hub: "hub1", tab: "queue" };
  assert.equal(orderLink(sample, 1), `/?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}`);
  assert.equal(orderLink(sample, 6), "/?push=order&hub=hub1&tab=queue");
});

test("AN ORDER WITH NO USABLE HUB OPENS THE APP, never a screen that would not list it", () => {
  // A link to the WRONG screen is worse than one to no particular screen: the
  // reader concludes the ALERT was wrong rather than that the link was.
  for (const hub of [null, "", "hub-from-2019", "nonsense"]) {
    assert.equal(orderLink({ orderId: "005", createdAt: AT, hub, tab: "queue" }, 1), "/", String(hub));
  }
  // ONE HUB VOCABULARY. A destination STORE is a legal HUB_LABEL key (a
  // notification names a store) but is not a hub the warehouse selector can
  // render, and the client refuses one — so emitting it here would produce a
  // link that silently drops its hub and lands the reader on whichever hub they
  // last used. Only the selector's own four are allowed out.
  for (const notAHub of ["marathon-pe", "trophy", "marathon-pine", "central"]) {
    assert.equal(orderLink({ orderId: "005", createdAt: AT, hub: notAHub, tab: "queue" }, 1), "/", notAHub);
  }
  for (const hub of ["hub1", "hub2", "hub3", "hubC"]) {
    assert.match(orderLink({ orderId: "005", createdAt: AT, hub, tab: "queue" }, 1), /^\/\?push=order/, hub);
  }
});

// ── DIRTY DATA ───────────────────────────────────────────────────────────────

test("an order naming an unknown destShop still notifies readably", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER({ destShop: "shop-from-2019" }));
  assert.equal(res.sent, true, "the wildcard bucket still covers it");
  assert.match(m.calls[0].data.title, /shop-from-2019/);
  assert.equal(m.calls[0].data.link, "/?push=order&hub=hub1&tab=queue&order=005&at=" + encodeURIComponent(AT));
});

test("a malformed audience node does not crash the fan-out", async () => {
  for (const bad of [null, "nonsense", 42, []]) {
    const world = WORLD();
    world.push_audience.all = bad;
    const { ref } = fakeDb(world);
    const m = fakeMessaging();
    await assert.doesNotReject(run({ ref }, m, "005", CUSTOMER()));
  }
});

test("a token row with no token string is skipped, not sent as undefined", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d3 = { device: "half-written row" };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, "005", CUSTOMER());
  assert.deepEqual(m.calls[0].tokens, ["tok-A"]);
});

test("a half-written order — no product, no size, no qty — still sends something readable", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", {
    id: "005", destShop: "marathon-pe", status: "incoming", createdAt: AT,
  });
  assert.equal(res.sent, true);
  assert.equal(typeof m.calls[0].data.body, "string");
  assert.ok(m.calls[0].data.body.length > 0);
});

// ── THE FAILURES THE FIRST DRAFT HAD ─────────────────────────────────────────

test("a window whose claimer DIED carries its count forward — late, never lost", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  // Five orders land; the claimer never returns (the instance was killed).
  let neverResolves;
  const stuck = new Promise((r) => { neverResolves = r; });
  notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "R056-0", record: ENGINE({ id: "R056-0" }), createdAt: AT,
    nowMs: NOW, sleep: () => stuck, newWindowId: () => "W1",
  });
  for (let i = 1; i < 5; i += 1) {
    const rec = ENGINE({ id: `R056-${i}` });
    await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
      nowMs: NOW + i, sleep: noSleep, newWindowId: () => `Wx${i}`,
    });
  }
  assert.equal(state.push_bursts["marathon-pe"].count, 5);
  assert.equal(m.calls.length, 0, "nobody has been told anything yet");

  // The window ages out and the next order opens a new one. The five orphans
  // are already in `seen`, so nothing will ever re-count them — discarding the
  // count here would understate the work permanently.
  const last = ENGINE({ id: "R056-9" });
  const next = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: last.id, record: last, createdAt: last.createdAt,
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
  // Unbounded, the 400th order of a sweep would read and rewrite 400 ids —
  // O(n^2) bytes on the single node every order for that store transacts on.
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
  const res = await run({ ref }, exploding, "005", CUSTOMER());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "send_failed");
  assert.equal(res.count, 1);

  // The window is re-opened, ALREADY EXPIRED, holding the count. The orders it
  // counted are in `seen` and can never be re-counted, so discarding here would
  // lose them permanently.
  const w = state.push_bursts["marathon-pe"];
  assert.ok(w.windowId, "a window is open again");
  assert.equal(w.count, 1);
  // startedAt 0 — expired against every possible clock. Anything derived from
  // the current time can still look OPEN to an order arriving moments later,
  // which would make it a joiner of a window that has no claimer, and nothing
  // would ever flush it.
  assert.equal(w.startedAt, 0, "expired on purpose, so the next order flushes it at once");

  // The very next order carries it forward and gets through.
  const m = fakeMessaging();
  const rec = CUSTOMER({ id: "006" });
  const next = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "006", record: rec, createdAt: rec.createdAt,
    nowMs: NOW + 1000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(next.sent, true);
  assert.equal(next.count, 2, "the failed one plus the new one");
});

test("a restore folds into a LIVE window rather than clobbering someone else's claim", async () => {
  const { ref, state } = fakeDb(WORLD());
  await ref("push_bursts/marathon-pe").transaction(() => ({
    windowId: "OTHER", startedAt: NOW, count: 3, sample: null, seen: {}, closedAt: null,
  }));
  await restoreBurst({
    burstRef: ref("push_bursts/marathon-pe"), count: 5,
    captured: { sample: { productId: "p1" } }, closedAt: NOW,
  });
  assert.equal(state.push_bursts["marathon-pe"].windowId, "OTHER", "the live claim is untouched");
  assert.equal(state.push_bursts["marathon-pe"].count, 8, "3 live + 5 restored");
});

test("THE COLLAPSE SURVIVES A SLOW SWEEP — the claimer waits for quiet, not for a clock", async () => {
  // The failure this replaces: with a FIXED flush delay, a sweep that keeps
  // writing past the delay produced "40 new orders", then "35 new orders", then
  // more. Fewer than one notification per order, but still not the ONE
  // notification the burst is supposed to become.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();

  // Each tick of the claimer's wait lets 10 more orders land — a sweep that is
  // still going. The 4th tick lets nothing land, which is the sweep ending.
  let tick = 0;
  let landed = 0;
  const sweepSleep = async () => {
    tick += 1;
    if (tick > 4) return;
    for (let i = 0; i < 10; i += 1) {
      landed += 1;
      const rec = ENGINE({ id: `R056-${landed}` });
      await notifyOrderPlaced({
        db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
        nowMs: NOW + landed, sleep: noSleep, newWindowId: () => `Wj${landed}`,
      });
    }
  };

  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "R056-0", record: ENGINE({ id: "R056-0" }), createdAt: AT,
    nowMs: NOW, sleep: sweepSleep, newWindowId: () => "W1",
  });

  assert.equal(res.sent, true);
  assert.equal(m.calls.length, 1, "a sweep spanning several ticks is still ONE notification");
  assert.equal(res.count, 41, "the claimer plus every order that landed while it waited");
  assert.equal(m.calls[0].data.title, "Marathon PE — 41 new orders");
});

test("the wait ends at the ceiling rather than never — a burst that never stops still lands", async () => {
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  let landed = 0;
  let clock = NOW;
  // Never goes quiet: every tick adds another order AND advances the clock, so
  // only the ceiling can end this wait.
  const forever = async () => {
    landed += 1;
    clock += FLUSH_TICK_MS;
    if (clock - NOW > MAX_FLUSH_WAIT_MS * 3) throw new Error("the ceiling did not stop the wait");
    const rec = ENGINE({ id: `x${landed}` });
    await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
      nowMs: NOW + landed, sleep: noSleep, newWindowId: () => `Wx${landed}`,
    });
  };
  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "x0", record: ENGINE({ id: "x0" }), createdAt: AT,
    nowMs: NOW, sleep: forever, now: () => clock, newWindowId: () => "W1",
  });
  assert.equal(res.sent, true, "an unending burst still produces a notification");
  assert.equal(m.calls.length, 1);
});

test("A LIVE CLAIMER IS NOT ROBBED — one clock, a sweep that outlives any fixed threshold", async () => {
  // THE test the earlier suite could not fail. Its slow-sweep case advanced the
  // joiners' clock by milliseconds and the claimer's by ticks — two clocks that
  // are the same clock in production — so a joining order's `nowMs` never
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
      const rec = ENGINE({ id: `s${landed}` });
      await notifyOrderPlaced({
        db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
        nowMs: clock, sleep: noSleep, now: () => clock, newWindowId: () => `Wj${landed}`,
      });
    }
  };

  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "s0", record: ENGINE({ id: "s0" }), createdAt: AT,
    nowMs: NOW, sleep: slowSweep, now: () => clock, newWindowId: () => "W1",
  });

  assert.equal(res.sent, true, "the original claimer must still be the one that sends");
  assert.equal(m.calls.length, 1, "a 200s sweep is ONE notification, not one per 90s");
  assert.equal(res.count, landed + 1, "every order that landed during the sweep is counted");
});

test("a claimer that stops beating IS judged abandoned — recovery does not depend on the burst's age", async () => {
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging();

  // A window opened long ago whose claimer beat once and then died.
  await ref("push_bursts/marathon-pe").transaction(() => ({
    windowId: "DEAD", startedAt: NOW, heartbeatAt: NOW, count: 7,
    sample: { orderId: "005", productId: "p1", size: "9", qty: 1, hub: "hub1", tab: "queue" },
    seen: {}, closedAt: null,
  }));

  // An order three ticks later finds the heartbeat stale and takes over.
  const rec = CUSTOMER({ id: "006" });
  const res = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "006", record: rec, createdAt: rec.createdAt,
    nowMs: NOW + STALE_CLAIM_MS + 1, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(res.sent, true);
  assert.equal(res.count, 8, "7 orphaned + 1 new");
  assert.equal(state.push_bursts["marathon-pe"].windowId, null, "and the window is closed properly");
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
      const rec = ENGINE({ id: `b${ticks}` });
      await notifyOrderPlaced({
        db: { ref: flaky }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
        nowMs: NOW + ticks, sleep: noSleep, newWindowId: () => `Wb${ticks}`,
      });
    }
  };
  const res = await notifyOrderPlaced({
    db: { ref: flaky }, messaging: m, orderId: "b0", record: ENGINE({ id: "b0" }), createdAt: AT,
    nowMs: NOW, sleep: sleepFn, newWindowId: () => "W1",
  });
  assert.equal(res.sent, true);
  assert.ok(res.count > 1, "the wait survived the blip and kept collecting");
  assert.ok(ticks > 1, "one failed read did not end the wait");
});

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
  notifyOrderPlaced, restoreBurst, shouldNotify, pruneSeen, composeMessage, replayKey,
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
// ── THE FAKE ENFORCES RTDB'S KEY RULES ──────────────────────────────────────
// It did not, and that let a release-blocking bug through: the replay key was
// built from an ISO createdAt, whose milliseconds carry a ".", and RTDB forbids
// "." "#" "$" "/" "[" "]" in a key. The real Admin SDK throws SYNCHRONOUSLY on
// one, before the transaction is sent — so every claim would have thrown and
// nobody would ever have been told anything, while this suite stayed green
// because a plain JS object accepts any string as a key.
//
// A fake that accepts what the real thing rejects does not model it; it just
// agrees with whatever the code does. So every key this fake writes — path
// segments AND the keys of any object written into a node — is checked the way
// RTDB checks them. (Same lesson as #269, where an ISO key crashed the refill
// engine intermittently for hours.)
const ILLEGAL_KEY = /[.#$/[\]]/;
function assertLegalKeys(value, where) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((v) => assertLegalKeys(v, where)); return; }
  for (const [k, v] of Object.entries(value)) {
    if (ILLEGAL_KEY.test(k)) {
      throw new Error(`Invalid RTDB key "${k}" written at ${where} — RTDB forbids . # $ / [ ]`);
    }
    assertLegalKeys(v, `${where}/${k}`);
  }
}

function fakeDb(initial = {}) {
  const state = structuredClone(initial);
  const get = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const setPath = (path, value) => {
    assertLegalKeys(value, path);
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

// One warehouse user, ASSIGNED BY THE ADMIN to both hubs, with one device,
// plus the product name.
//
// "Assigned to both" is the default fixture rather than an exotic case: it is
// what lets every pre-existing guard below stay a test about what it was a test
// about (collapse, idempotency, pruning, the wait) instead of quietly becoming
// a test about scoping. The scoping guards are their own suite — see "THE
// SCOPED FAN-OUT" at the bottom of this file, where the fixture is deliberately
// NOT this one.
const WORLD = () => ({
  push_hub_audience: { hub1: { u_ware: { at: NOW } }, hub2: { u_ware: { at: NOW } } },
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
  // All five ON ONE HUB. The window is keyed by the hub that has to pick, so
  // that is the axis this guard is about: three different producers writing
  // work for the SAME hub converge into one window and one sentence. (A
  // customer order for a hub2 shoe is an ordinary line — computeHubForItem
  // resolves the hub from the PRODUCT, not from the producer.) Two DIFFERENT
  // hubs must not collapse, and that has its own test below.
  const H2 = { hub: "hub2", placedAtHub: "hub2" };
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();

  // The claimer opens the window and is held at the flush until the others have
  // landed — which is exactly the real ordering: it is asleep.
  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: CUSTOMER(H2), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });

  const others = [];
  for (const [i, [id, rec]] of [
    ["006", CUSTOMER({ id: "006", ...H2 })],
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
  assert.equal(res.count, 5, "one hub, five orders, whoever wrote them");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].data.title, "Hub 2 — 5 new orders");
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
  assert.equal(m.calls[0].data.title, "Hub 2 — 40 new orders");
  assert.match(m.calls[0].data.body, /Nike Air Max 90 and 39 more/);
  // The window is closed, not deleted — that is what keeps the replay memory.
  assert.equal(state.push_bursts.hub2.windowId, null);
  assert.ok(state.push_bursts.hub2.closedAt);
});

test("two HUBS ordering at once get one notification EACH, not one between them", async () => {
  // This was "two stores" while the window was keyed by destShop. The axis
  // moved with the key, and it had to: the collapse must be keyed by the same
  // thing the recipients are scoped to, or a burst can swallow an order the
  // people it reaches were never entitled to hear about. Two different HUBS is
  // now the case that must not merge.
  const world = WORLD();
  world.push_hub_audience.hub2 = { u_two: { at: NOW } };
  world.push_tokens.u_two = { d9: { token: "tok-B" } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();

  const a = await run({ ref }, m, "005", CUSTOMER({ hub: "hub1", placedAtHub: "hub1" }));
  const b = await run({ ref }, m, "006", CUSTOMER({ id: "006", hub: "hub2", placedAtHub: "hub2" }), { newWindowId: () => "W2" });
  assert.equal(a.sent, true);
  assert.equal(b.sent, true);
  assert.equal(m.calls.length, 2);
  assert.deepEqual(m.calls.map((c) => c.data.hub), ["hub1", "hub2"]);
  // The wrong-hub collapse this keying prevents: one sentence naming one hub
  // while the other hub's order hides inside its count.
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

test("THE REPLAY KEY IS A LEGAL RTDB KEY — an ISO stamp's dot would throw on every claim", async () => {
  // The key goes into the `seen` MAP, so it is an RTDB key. An ISO createdAt
  // carries a "." in its milliseconds and the Admin SDK throws synchronously on
  // one — before the transaction is sent, so nothing downstream can catch it.
  // Not a degraded notification: every claim throws and nobody is ever told.
  // #269 is the same bug in the refill engine, and cost hours of silent scans.
  assert.equal(replayKey("005", "2026-09-06T07:07:41.633Z"), "005::1788678461633");
  for (const stamp of [AT, "2026-09-06T07:07:41.633Z", null, undefined, "", 0, "not a date", "a.b#c$d/e[f]g"]) {
    const key = replayKey("R041-2", stamp);
    assert.ok(!/[.#$/[\]]/.test(key), `illegal RTDB key produced from ${JSON.stringify(stamp)}: ${key}`);
  }
  // Two different malformed stamps must stay DIFFERENT keys, or one would be
  // read as a replay of the other and a real order would be dropped.
  assert.notEqual(replayKey("005", "x.1"), replayKey("005", "x.2"));

  // And end to end: the fake now rejects an illegal key the way RTDB does, so
  // this send is the proof the whole path is clean.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, true);
  assert.equal(m.calls.length, 1);
});

test("A DELIVERY OF ZERO IS NOT A SEND — the burst is put back, not consumed", async () => {
  // Every token failing for a transient reason would otherwise eat the burst:
  // the count gone, the ids remembered as seen, and no device told anything.
  const { ref, state } = fakeDb(WORLD());
  const m = fakeMessaging({ "tok-A": "messaging/server-unavailable" });
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "send_failed");
  const w = state.push_bursts.hub1;
  assert.equal(w.count, 1, "the count is back for the next order to flush");
  assert.ok(state.push_tokens.u_ware.d1, "and a transient failure still did not cost a registration");
});

test("a PARTIAL delivery is left alone — re-sending would re-notify the devices that got it", async () => {
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-B" };
  const { ref } = fakeDb(world);
  const m = fakeMessaging({ "tok-B": "messaging/server-unavailable" });
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, true);
  assert.equal(res.delivered, 1);
});

test("a failed token PRUNE cannot undo a delivery that already happened", async () => {
  // The prune runs after the multicast. A throw there would reach the caller's
  // catch, which puts the whole burst back — re-notifying every device that had
  // just been told.
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-DEAD" };
  const base = fakeDb(world);
  const refWithBrokenPrune = (path = "") => {
    const inner = base.ref(path);
    if (path !== "") return inner;
    return { ...inner, async update() { throw new Error("prune write failed"); } };
  };
  const m = fakeMessaging({ "tok-DEAD": "messaging/registration-token-not-registered" });
  const res = await run({ ref: refWithBrokenPrune }, m, "005", CUSTOMER());
  assert.equal(res.sent, true, "the delivery stands");
  assert.equal(m.calls.length, 1, "and it is not sent a second time");
});

test("a close transaction that did NOT commit sends nothing", async () => {
  // `captured` is assigned from inside the transaction handler, which runs more
  // than twice against a contended node. A run that saw our window followed by
  // a run that saw somebody else's leaves `captured` set on a transaction that
  // changed nothing — and sending then duplicates the real owner's notification.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  // The CLAIM must behave normally — otherwise the function exits at
  // "claim_failed" and never reaches the close, which is the whole point of
  // this test. Only the second transaction on the burst node (the close) is
  // made to re-run and then abort.
  let burstTxns = 0;
  const stolen = (path = "") => {
    const inner = ref(path);
    if (!path.startsWith("push_bursts")) return inner;
    return {
      ...inner,
      async transaction(fn) {
        burstTxns += 1;
        if (burstTxns === 1) return inner.transaction(fn);
        // Hand the handler OUR window first (a stale local value, which sets
        // `captured`), then abort as the server would when another claimer
        // already owns it.
        fn({ windowId: "W1", startedAt: NOW, heartbeatAt: NOW, count: 3, sample: null, seen: {}, closedAt: null });
        return { committed: false, snapshot: { val: () => null, exists: () => false } };
      },
    };
  };
  const res = await notifyOrderPlaced({
    db: { ref: stolen }, messaging: m, orderId: "005", record: CUSTOMER(), createdAt: AT,
    nowMs: NOW, sleep: noSleep, newWindowId: () => "W1",
  });
  assert.ok(burstTxns >= 2, "the test must actually reach the close transaction");
  assert.equal(res.sent, false);
  assert.equal(m.calls.length, 0, "an aborted close must not send");
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
  // A SECOND, working device, so this stays a test about pruning: with only the
  // failing token the multicast delivers zero, which is now its own failure
  // (the burst is put back rather than consumed) and would test that instead.
  const world = WORLD();
  world.push_tokens.u_ware.d2 = { token: "tok-OK" };
  const { ref, state } = fakeDb(world);
  const m = fakeMessaging({ "tok-A": "messaging/server-unavailable" });
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.pruned, 0);
  assert.ok(state.push_tokens.u_ware.d1, "a quota or transport error is not a dead address");
  assert.ok(DEAD_TOKEN_CODES.has("messaging/registration-token-not-registered"));
  assert.ok(!DEAD_TOKEN_CODES.has("messaging/server-unavailable"));
});

// ── THE RECIPIENT SET ────────────────────────────────────────────────────────

test("recipients come from the ASSIGNED index for that order's hub, and nowhere else", async () => {
  const world = WORLD();
  world.push_hub_audience.hub2.u_two = { at: NOW };
  world.push_tokens.u_two = { d5: { token: "tok-TWO" } };
  const { ref } = fakeDb(world);

  const m1 = fakeMessaging();
  await run({ ref }, m1, "005", CUSTOMER({ hub: "hub1", placedAtHub: "hub1" }));
  assert.deepEqual(m1.calls[0].tokens, ["tok-A"], "the Hub 2 assignee hears nothing about Hub 1");

  const m2 = fakeMessaging();
  await run({ ref }, m2, "006", CUSTOMER({ id: "006", hub: "hub2", placedAtHub: "hub2" }), { newWindowId: () => "W2" });
  assert.deepEqual(m2.calls[0].tokens.sort(), ["tok-A", "tok-TWO"], "both Hub 2 assignees, and only them");
});

test("a uid in the index with no tokens contributes nothing and breaks nothing", async () => {
  const world = WORLD();
  world.push_hub_audience.hub1.u_ghost = { at: NOW };  // assigned, but their device is gone
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-A"]);
});

test("nobody assigned: it closes the window quietly rather than throwing", async () => {
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
    world.push_hub_audience.hub1[`u${i}`] = { at: NOW };
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
  // The tag is PER HUB, so a Hub 2 notification never replaces a Hub 1 one on
  // the lock screen of somebody assigned to both.
  assert.equal(sent.data.tag, "order-hub1");
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
  // The TITLE names the hub now, so an unrecognised destShop can no longer
  // blank it. It still has to reach the BODY readably rather than as "" or
  // "undefined", because the store is what tells the picker where the box goes.
  const { ref } = fakeDb(WORLD());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER({ destShop: "shop-from-2019" }));
  assert.equal(res.sent, true, "an unknown store is still real work for its hub");
  assert.match(m.calls[0].data.title, /Hub 1/);
  assert.match(m.calls[0].data.body, /shop-from-2019/);
  assert.equal(m.calls[0].data.link, "/?push=order&hub=hub1&tab=queue&order=005&at=" + encodeURIComponent(AT));
});

test("a malformed assignment index does not crash the fan-out", async () => {
  for (const bad of [null, "nonsense", 42, []]) {
    const world = WORLD();
    world.push_hub_audience.hub1 = bad;
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
    // hub is present because it always is — every producer writes it in the
    // same object literal as createdAt. Everything a message is BUILT from is
    // missing; that is what "half-written" means here.
    id: "005", hub: "hub1", placedAtHub: "hub1",
    destShop: "marathon-pe", status: "incoming", createdAt: AT,
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
  assert.equal(state.push_bursts.hub2.count, 5);
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
  const w = state.push_bursts.hub1;
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
  assert.equal(m.calls[0].data.title, "Hub 2 — 41 new orders");
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
  await ref("push_bursts/hub1").transaction(() => ({
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

// ─── THE SCOPED FAN-OUT ──────────────────────────────────────────────────────
// Everything above uses WORLD(), where the one staff member is assigned to BOTH
// hubs — deliberately, so those guards stay guards about collapse, idempotency
// and pruning. THESE tests build their own fixtures, because every one of them
// is about who is in the index and who is not.
//
// The failure they exist to prevent is the one that has no symptom: somebody is
// notified whom nobody assigned, or somebody assigned is never notified, and
// nothing anywhere says so.

/** A world with NOBODY assigned — the default state of every account. */
const UNASSIGNED = () => ({
  // A live token and a real device. Under the model this replaces, this person
  // (stockRole warehouse) was subscribed by default and would be told.
  push_tokens: { u_ware: { d1: { token: "tok-A", device: "iPhone Safari · installed · d1" } } },
  products: { p1: { name: "Nike Air Max 90" } },
});

/** A world where `assigned` maps hub → [uids], each uid given one live token. */
const ASSIGNED = (assigned) => {
  const world = { push_hub_audience: {}, push_tokens: {}, products: { p1: { name: "Nike Air Max 90" } } };
  for (const [hub, uids] of Object.entries(assigned)) {
    world.push_hub_audience[hub] = {};
    for (const uid of uids) {
      world.push_hub_audience[hub][uid] = { at: NOW };
      world.push_tokens[uid] = { d1: { token: `tok-${uid}` } };
    }
  }
  return world;
};

const HUB1 = (over = {}) => CUSTOMER({ hub: "hub1", placedAtHub: "hub1", ...over });
const HUB2 = (over = {}) => CUSTOMER({ id: "006", hub: "hub2", placedAtHub: "hub2", ...over });
// Pine. destShop matches what every live hub3 order actually carries — all 714
// of them in the fourteen days to 2026-09-08.
const HUB3 = (over = {}) => CUSTOMER({ id: "007", hub: "hub3", placedAtHub: "hub3", destShop: "marathon-pine", ...over });

test("NO ASSIGNMENT MEANS NOTHING IS SENT — a live token and full permission are not consent", async () => {
  // The whole model in one test. This person has a registered device, the
  // browser has granted notifications, and their /users record says warehouse.
  // Under the model this replaces they were subscribed BY DEFAULT. Junid has
  // not assigned them, so they hear nothing.
  const { ref } = fakeDb(UNASSIGNED());
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients");
  assert.equal(m.calls.length, 0, "not one device may be reached");
});

test("nothing else on the record is read as an assignment — not the role, not the shop", async () => {
  // Every field the old resolver consulted, at once, on both the order and a
  // /users record sitting in the same database. Still nobody.
  const world = UNASSIGNED();
  world.users = { u_ware: { stockRole: "admin", destShop: "marathon-pe", permissions: ["stock"] } };
  world.notification_prefs = { u_ware: { refillRequests: true, updatedAt: NOW } };
  world.push_audience = { all: { u_ware: { at: NOW } } };   // the LEGACY index
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, "005", HUB1())).skipped, "no_recipients");
  assert.equal(m.calls.length, 0);
});

test("a HUB 1 assignee is told about Hub 1 and hears nothing about Hub 2", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"] }));

  const m1 = fakeMessaging();
  const a = await run({ ref }, m1, "005", HUB1());
  assert.equal(a.sent, true);
  assert.deepEqual(m1.calls[0].tokens, ["tok-u_one"]);

  const m2 = fakeMessaging();
  const b = await run({ ref }, m2, "006", HUB2(), { newWindowId: () => "W2" });
  assert.equal(b.sent, true);
  assert.deepEqual(m2.calls[0].tokens, ["tok-u_two"], "and the Hub 1 assignee is not in it");
});

test("a HUB 2 assignee hears nothing about Hub 1 — the other direction, stated separately", async () => {
  // Not symmetry for its own sake: hub1 is the fallback value everywhere else
  // in this codebase (`|| "hub1"`), so a leak is far likelier to run toward it
  // than away from it, and a test that only ever checked one direction would
  // miss exactly that.
  const { ref } = fakeDb(ASSIGNED({ hub2: ["u_two"] }));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients");
  assert.equal(m.calls.length, 0);
});

test("somebody assigned to BOTH hubs gets both — as two notifications, not one", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_both"], hub2: ["u_both"] }));
  const m = fakeMessaging();
  await run({ ref }, m, "005", HUB1());
  await run({ ref }, m, "006", HUB2(), { newWindowId: () => "W2" });
  assert.equal(m.calls.length, 2, "two hubs, two orders, two alerts");
  assert.deepEqual(m.calls.map((c) => c.tokens), [["tok-u_both"], ["tok-u_both"]]);
  assert.deepEqual(m.calls.map((c) => c.data.hub), ["hub1", "hub2"]);
  // The lock screen must show both, so they cannot share a tag: a per-store or
  // per-app tag would let the Hub 2 alert REPLACE the Hub 1 one and this person
  // would simply never see that Hub 1 had work.
  assert.equal(new Set(m.calls.map((c) => c.data.tag)).size, 2);
});

test("PER-HUB BURST COLLAPSE: a Hub 1 burst does not swallow a Hub 2 order", async () => {
  // The failure this is the whole point of. Both orders land inside ONE window
  // length, both are destined for the same shop — the exact case the old
  // destShop key collapsed into a single notification.
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"] }));
  const m = fakeMessaging();

  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "005", record: HUB1(), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });

  // A HUB 2 order, same shop, one second later — well inside the Hub 1 window.
  const other = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "006", record: HUB2(), createdAt: AT,
    nowMs: NOW + 1000, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.notEqual(other.skipped, "joined_window", "it must NOT join the Hub 1 window");
  assert.equal(other.sent, true, "it opens and flushes its own");
  assert.equal(other.count, 1, "and it counts one, not two");
  assert.deepEqual(m.calls[0].tokens, ["tok-u_two"]);

  release();
  const first = await claimer;
  assert.equal(first.sent, true);
  assert.equal(first.count, 1, "the Hub 1 burst counted only its own order");
  assert.equal(m.calls.length, 2);
  assert.deepEqual(m.calls.map((c) => c.data.hub).sort(), ["hub1", "hub2"]);
});

test("a Hub 1 SWEEP still collapses into one, while a Hub 2 order beside it stays its own", async () => {
  // Collapse must not be the casualty of scoping: forty Hub 1 orders are still
  // one notification, and the Hub 2 order that lands in the middle of them is
  // still a second one.
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"] }));
  const m = fakeMessaging();

  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "R056-0", record: ENGINE({ id: "R056-0", hub: "hub1", placedAtHub: "hub1" }),
    createdAt: AT, nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });
  for (let i = 1; i < 40; i += 1) {
    const rec = ENGINE({ id: `R056-${i}`, hub: "hub1", placedAtHub: "hub1" });
    await notifyOrderPlaced({
      db: { ref }, messaging: m, orderId: rec.id, record: rec, createdAt: rec.createdAt,
      nowMs: NOW + i * 10, sleep: noSleep, newWindowId: () => `W${i + 1}`,
    });
  }
  const hub2 = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "006", record: HUB2(), createdAt: AT,
    nowMs: NOW + 500, sleep: noSleep, newWindowId: () => "WX",
  });
  assert.equal(hub2.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-u_two"]);

  release();
  const res = await claimer;
  assert.equal(res.count, 40, "the sweep is still ONE notification saying 40");
  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[1].data.title, "Hub 1 — 40 new orders");
});

test("AN ORDER WITH NO HUB IS REFUSED — not guessed, not broadcast, and never a crash", async () => {
  // The decision, stated: the hub is written at creation by every producer, so
  // a record without one is malformed, not early. There is no safe default —
  // "hub1" puts another hub's work on Hub 1's phones and "everyone" undoes the
  // scoping — so it announces nothing. The order is still worked from the
  // warehouse queue like any other.
  for (const missing of [{}, { hub: "" }, { hub: "   " }, { hub: null }, { hub: 7 }, { hub: {} }]) {
    const rec = { ...CUSTOMER(), hub: undefined, placedAtHub: undefined, ...missing };
    assert.equal(shouldNotify("005", rec, AT), "no_hub", JSON.stringify(missing));
  }
  // placedAtHub alone is enough — WarehouseView filters hub3/hubC by it.
  assert.equal(shouldNotify("005", { ...CUSTOMER(), hub: undefined, placedAtHub: "hub3" }, AT), null);

  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const m = fakeMessaging();
  let res;
  await assert.doesNotReject(async () => {
    res = await run({ ref }, m, "005", { ...CUSTOMER(), hub: undefined, placedAtHub: undefined });
  });
  assert.equal(res.skipped, "no_hub");
  assert.equal(m.calls.length, 0, "and nobody is told, rather than everybody");
});

test("A HUB THAT IS NOT A LEGAL RTDB KEY IS REFUSED before it becomes a path", async () => {
  // db.ref() throws SYNCHRONOUSLY on one of these, before the send's own
  // try/catch exists — so the invocation dies rather than degrades — and "/"
  // would silently split one hub's window across two nodes, stopping the
  // collapse with nothing to show for it. Same lesson as #269.
  for (const bad of ["a.b", "a#b", "a$b", "a/b", "a[b", "a]b", "hub.1"]) {
    assert.equal(shouldNotify("005", CUSTOMER({ hub: bad, placedAtHub: bad }), AT), "bad_hub", bad);
  }
  for (const good of ["hub1", "hub2", "hub3", "hubC", "central"]) {
    assert.equal(shouldNotify("005", CUSTOMER({ hub: good, placedAtHub: good }), AT), null, good);
  }

  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const m = fakeMessaging();
  let res;
  await assert.doesNotReject(async () => {
    res = await run({ ref }, m, "005", CUSTOMER({ hub: "hub/1", placedAtHub: "hub/1" }));
  });
  assert.equal(res.skipped, "bad_hub");
  assert.equal(m.calls.length, 0);
});

test("a PINE order reaches nobody by construction — no assignment can name hub3", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"] }));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", CUSTOMER({ hub: "hub3", placedAtHub: "hub3", destShop: "marathon-pine" }));
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients", "refused for want of recipients, not for being malformed");
  assert.equal(m.calls.length, 0);
});

test("the fan-out reads ONE node to resolve recipients, and it is the hub's own", async () => {
  // The bandwidth guard. A regression to reading a wildcard bucket, or to
  // walking /push_assignments, would both still pass every test above.
  const reads = [];
  const base = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const spyRef = (path = "") => {
    const inner = base.ref(path);
    return { ...inner, async get() { reads.push(path); return inner.get(); } };
  };
  await run({ ref: spyRef }, fakeMessaging(), "005", HUB1());
  // push_bursts/hub1 is the flush tick's own node, not a recipient lookup.
  const lookups = reads.filter((p) => !p.startsWith("push_bursts"));
  // Three reads for one recipient: the hub's audience, that person's mute leaf,
  // and their token node. The mute leaf is a single boolean and comes BEFORE
  // the token node, so a muted person costs the leaf and nothing else.
  assert.deepEqual(lookups, ["push_hub_audience/hub1", "push_mutes/u_one/muted", "push_tokens/u_one"]);
  assert.equal(reads.filter((p) => p === "push_mutes").length, 0,
    "the mute is read per-uid at its leaf — never as a whole node");
  assert.equal(reads.filter((p) => p === "users" || p === "push_assignments").length, 0,
    "never the roster, never the decision node — only the derived index");
});

test("the STORE is still named, so a picker knows where the box is going", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const m = fakeMessaging();
  await run({ ref }, m, "005", HUB1({ destShop: "trophy" }));
  assert.equal(m.calls[0].data.title, "Hub 1 — new order", "the title names what you are assigned to");
  assert.match(m.calls[0].data.body, /Trophy/, "the body names where it is going");
});


// ─── HUB 3 (PINE) IS A HUB LIKE THE OTHERS ───────────────────────────────────
// Pine was excluded on the reasoning that it picks on its own floor. Reversed
// 2026-09-08. Nothing in this file changed to enable it — the exclusion lived
// entirely in the client's closed hub list — so these tests exist to prove that
// "no change was needed" is true rather than merely believed, and that turning
// Pine on did not quietly widen anything else.

test("a HUB 3 assignee gets Pine orders, and neither of the other two hubs", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"], hub3: ["u_pine"] }));

  const m3 = fakeMessaging();
  const r3 = await run({ ref }, m3, "007", HUB3());
  assert.equal(r3.sent, true, "Pine's order now reaches somebody");
  assert.deepEqual(m3.calls[0].tokens, ["tok-u_pine"]);
  assert.equal(m3.calls[0].data.hub, "hub3");

  // And the same person hears nothing about the other two.
  const m1 = fakeMessaging();
  await run({ ref }, m1, "005", HUB1(), { newWindowId: () => "W2" });
  assert.deepEqual(m1.calls[0].tokens, ["tok-u_one"], "Hub 1 is not Pine's business");

  const m2 = fakeMessaging();
  await run({ ref }, m2, "006", HUB2(), { newWindowId: () => "W3" });
  assert.deepEqual(m2.calls[0].tokens, ["tok-u_two"], "nor is Hub 2");
});

test("someone assigned to Hub 1 AND Hub 3 hears about both, and about nothing else", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_both"], hub3: ["u_both"], hub2: ["u_two"] }));

  const m1 = fakeMessaging();
  await run({ ref }, m1, "005", HUB1());
  assert.deepEqual(m1.calls[0].tokens, ["tok-u_both"]);

  const m3 = fakeMessaging();
  await run({ ref }, m3, "007", HUB3(), { newWindowId: () => "W2" });
  assert.deepEqual(m3.calls[0].tokens, ["tok-u_both"]);

  const m2 = fakeMessaging();
  await run({ ref }, m2, "006", HUB2(), { newWindowId: () => "W3" });
  assert.deepEqual(m2.calls[0].tokens, ["tok-u_two"], "two hubs assigned is not three");
});

test("the Hub 3 notification names Hub 3, and names Pine as the destination", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub3: ["u_pine"] }));
  const m = fakeMessaging();
  await run({ ref }, m, "007", HUB3());
  assert.equal(m.calls[0].data.title, "Hub 3 — new order");
  assert.match(m.calls[0].data.body, /Pine/);
});

test("BURST COLLAPSE STAYS PER HUB ACROSS ALL THREE — Pine cannot swallow Hub 1 or Hub 2", async () => {
  // The window is keyed by hub, so three orders landing together must produce
  // three notifications of one each — not one notification of three, and above
  // all not a Hub 3 sentence with another hub's order hidden inside its count.
  // Deliberately fired Pine FIRST, so a collapse would swallow the other two
  // rather than the other way round.
  const { ref, state } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"], hub3: ["u_pine"] }));
  const m = fakeMessaging();

  const a = await run({ ref }, m, "007", HUB3(),  { newWindowId: () => "W3" });
  const b = await run({ ref }, m, "005", HUB1(),  { newWindowId: () => "W1" });
  const c = await run({ ref }, m, "006", HUB2(),  { newWindowId: () => "W2" });

  assert.deepEqual([a.sent, b.sent, c.sent], [true, true, true]);
  assert.equal(m.calls.length, 3, "three hubs, three notifications");
  assert.deepEqual(m.calls.map((x) => x.data.hub), ["hub3", "hub1", "hub2"]);
  assert.deepEqual(m.calls.map((x) => x.data.count), ["1", "1", "1"],
    "no hub's count may include another hub's order");
  assert.deepEqual(m.calls.map((x) => x.tokens[0]), ["tok-u_pine", "tok-u_one", "tok-u_two"]);
  // Three independent windows, one per hub node.
  assert.ok(state.push_bursts.hub1 && state.push_bursts.hub2 && state.push_bursts.hub3);
});

test("two PINE orders together DO collapse — per-hub scoping is not per-hub disabling", async () => {
  // The mirror of the test above: if collapse stopped working for hub3 the
  // three-hub test would still pass, and a Pine cart would fire once per line.
  const { ref } = fakeDb(ASSIGNED({ hub3: ["u_pine"] }));
  const m = fakeMessaging();

  // The claimer is held at the flush while the second lands — the real
  // ordering, since the claimer is asleep for the window's duration.
  let release;
  const held = new Promise((r) => { release = r; });
  const claimer = notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "007", record: HUB3(), createdAt: AT,
    nowMs: NOW, sleep: () => held, newWindowId: () => "W1",
  });
  const second = HUB3({ id: "008" });
  const joiner = await notifyOrderPlaced({
    db: { ref }, messaging: m, orderId: "008", record: second, createdAt: second.createdAt,
    nowMs: NOW + 1, sleep: noSleep, newWindowId: () => "W2",
  });
  assert.equal(joiner.skipped, "joined_window");
  assert.equal(m.calls.length, 0, "no joiner may send");

  release();
  const res = await claimer;
  assert.equal(res.sent, true);
  assert.equal(res.count, 2, "one hub, two orders, one sentence");
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].data.count, "2");
});

test("a Hub 3 order still notifies NOBODY when nobody is assigned to Hub 3", async () => {
  // Making Pine assignable must not make it assigned. Absence is still off.
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"] }));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "007", HUB3());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "no_recipients");
  assert.equal(m.calls.length, 0, "and above all it does not fall back to another hub's audience");
});

test("AN ORDER WITH NO HUB NOTIFIES NOBODY, AND DOES NOT FALL INTO HUB 3", async () => {
  // The refusal must stay a refusal. With Pine now carrying a real audience,
  // a malformed record quietly defaulting anywhere would deliver another hub's
  // work — or every hub's — to Pine's phones.
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"], hub2: ["u_two"], hub3: ["u_pine"] }));

  for (const [label, over] of [
    ["absent",     { hub: undefined, placedAtHub: undefined }],
    ["empty",      { hub: "", placedAtHub: "" }],
    ["whitespace", { hub: "   ", placedAtHub: "   " }],
    ["null",       { hub: null, placedAtHub: null }],
  ]) {
    const rec = CUSTOMER(over);
    assert.equal(shouldNotify("005", rec, AT), "no_hub", `${label} hub must be refused`);
    const m = fakeMessaging();
    const res = await run({ ref }, m, "005", rec);
    assert.equal(res.skipped, "no_hub", `${label}: refused`);
    assert.equal(m.calls.length, 0, `${label}: nobody is told`);
  }

  // An illegal hub is refused for its own reason and also reaches nobody — it
  // would otherwise become a path segment.
  const bad = CUSTOMER({ hub: "hub3/../hub1", placedAtHub: "hub3/../hub1" });
  assert.equal(shouldNotify("005", bad, AT), "bad_hub");
  const mb = fakeMessaging();
  assert.equal((await run({ ref }, mb, "005", bad)).skipped, "bad_hub");
  assert.equal(mb.calls.length, 0);

  // The control: the SAME fixture does notify when the hub is real, so the
  // refusals above are not passing because the world is empty.
  const ok = fakeMessaging();
  assert.equal((await run({ ref }, ok, "007", HUB3())).sent, true);
  assert.deepEqual(ok.calls[0].tokens, ["tok-u_pine"]);
});

test("a Hub 3 deep link opens Pine's own queue, not whichever hub was last used", async () => {
  const { ref } = fakeDb(ASSIGNED({ hub3: ["u_pine"] }));
  const m = fakeMessaging();
  await run({ ref }, m, "007", HUB3());
  assert.match(m.calls[0].data.link, /hub=hub3/);
  // One tag PER HUB, so a Pine notification can never replace a Hub 1 or Hub 2
  // one on the lock screen of somebody assigned to more than one.
  assert.equal(m.calls[0].data.tag, "order-hub3");
});


// ─── THE MUTE — A VETO, AND ONLY A VETO ──────────────────────────────────────
// Recipients are the AND of two independent facts: Junid ASSIGNED this person
// to this hub, and this person has not silenced their own phone. These prove
// each half is genuinely required, that neither can stand in for the other, and
// that the mute cannot leak into any of the machinery around it.
//
// The failure being guarded against is the one that produced this release: a
// personal switch that was load-bearing for DELIVERY, so an assignment could
// not reach somebody until they found it. Turning the mute on grants nothing;
// the "never touched it" case below is the one that has to keep working for
// ever, because it is everybody's default.

/** ASSIGNED(), with a mute record for the named uids. */
const MUTED = (assigned, mutedUids) => {
  const world = ASSIGNED(assigned);
  world.push_mutes = {};
  for (const uid of mutedUids) world.push_mutes[uid] = { muted: true, updatedAt: NOW };
  return world;
};

test("MUTED AND ASSIGNED HEARS NOTHING — the veto beats the assignment", async () => {
  const { ref } = fakeDb(MUTED({ hub1: ["u_one"] }, ["u_one"]));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "all_muted", "refused for the mute, not for want of an assignment or a token");
  assert.equal(m.calls.length, 0, "not one device may be reached");
});

test("NEVER TOUCHED THE SWITCH IS NOT MUTED — an assignment works with no mute record at all", async () => {
  // The default for every account, and the requirement this release exists for:
  // nobody may have to find a switch in order to START receiving. There is no
  // /push_mutes node in this world at all.
  const { ref } = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-u_one"]);
});

test("AN EMPTY MUTE RECORD IS NOT A MUTE — absence of the flag is audible", async () => {
  const world = ASSIGNED({ hub1: ["u_one"] });
  world.push_mutes = { u_one: { updatedAt: NOW } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, "005", HUB1())).sent, true);
});

test("UNMUTING IS A DELETE, and a stray muted:false is audible anyway", async () => {
  // The client deletes the record rather than storing false, so this shape
  // should not exist. It is read the audible way regardless: corruption in this
  // node must degrade towards DELIVERY, the opposite direction from an
  // assignment, because the harm here is silencing somebody who WAS chosen.
  const world = ASSIGNED({ hub1: ["u_one"] });
  world.push_mutes = { u_one: { muted: false, updatedAt: NOW } };
  const { ref } = fakeDb(world);
  assert.equal((await run({ ref }, fakeMessaging(), "005", HUB1())).sent, true);
});

test('ONLY A REAL BOOLEAN MUTES — "true" the string does not silence anybody', async () => {
  const world = ASSIGNED({ hub1: ["u_one"] });
  world.push_mutes = { u_one: { muted: "true", updatedAt: NOW } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, "005", HUB1())).sent, true, "corruption degrades to delivery here");
});

test("THE MUTE GRANTS NOTHING — an unassigned person with no mute is still told nothing", async () => {
  // The half that makes this a veto rather than an opt-in. u_two is not muted,
  // has a live token, and is assigned to nothing. Being audible is not being a
  // recipient.
  const world = ASSIGNED({ hub1: ["u_one"] });
  world.push_tokens.u_two = { d1: { token: "tok-u_two" } };
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, "005", HUB1());
  assert.deepEqual(m.calls[0].tokens, ["tok-u_one"], "only the ASSIGNED uid, never everyone who is audible");
});

test("ONE MUTED PERSON DOES NOT SILENCE THE HUB — the others still hear it", async () => {
  const { ref } = fakeDb(MUTED({ hub1: ["u_one", "u_two"] }, ["u_one"]));
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-u_two"]);
  assert.equal(res.tokens, 1, "the muted device is not counted as reached");
});

test("A MUTED PERSON'S TOKEN IS NOT PRUNED — being quiet is not being dead", async () => {
  // The mute filter runs BEFORE collectTokens, so a muted uid's token never
  // enters the multicast and can never appear in the failure responses that
  // drive pruning. If it were filtered afterwards — or if the token were sent
  // and the response discarded — a muted person would lose their registration
  // and unmuting would silently do nothing until they reopened the app.
  const { ref, state } = fakeDb(MUTED({ hub1: ["u_one", "u_two"] }, ["u_one"]));
  const m = fakeMessaging();
  await run({ ref }, m, "005", HUB1());
  assert.ok(state.push_tokens.u_one, "the muted person's token row survives");
  assert.equal(state.push_tokens.u_one.d1.token, "tok-u_one");
});

test("A MUTED PERSON'S TOKEN IS NOT EVEN READ — the leaf is the whole cost of being muted", async () => {
  const reads = [];
  const base = fakeDb(MUTED({ hub1: ["u_muted"] }, ["u_muted"]));
  const spyRef = (path = "") => {
    const inner = base.ref(path);
    return { ...inner, async get() { reads.push(path); return inner.get(); } };
  };
  await run({ ref: spyRef }, fakeMessaging(), "005", HUB1());
  assert.ok(reads.includes("push_mutes/u_muted/muted"));
  assert.ok(!reads.includes("push_tokens/u_muted"),
    "a muted uid costs one boolean leaf, never their token node as well");
});

test("A MUTE THAT CANNOT BE READ IS AUDIBLE — one refusal must not silence a hub", async () => {
  // Failing the other way would let a single RTDB blip suppress every
  // notification for a hub — invisible, indistinguishable from the feature
  // being broken, and the exact failure this release exists to end. A muted
  // phone buzzing once during an outage is the price, and it is legible.
  const base = fakeDb(ASSIGNED({ hub1: ["u_one"] }));
  const spyRef = (path = "") => {
    const inner = base.ref(path);
    if (path === "push_mutes/u_one/muted") {
      return { ...inner, async get() { throw new Error("PERMISSION_DENIED"); } };
    }
    return inner;
  };
  const m = fakeMessaging();
  const res = await run({ ref: spyRef }, m, "005", HUB1());
  assert.equal(res.sent, true, "the send happens anyway");
  assert.deepEqual(m.calls[0].tokens, ["tok-u_one"]);
});

test("A REFUSED MUTE READ DOES NOT THROW — a throw here would put the burst back and re-notify", async () => {
  // deliver()'s caller treats a throw as "the send failed" and restores the
  // whole burst. A mute read that rejected would therefore re-notify every
  // device that had already been told, on every retry, for ever.
  const base = fakeDb(ASSIGNED({ hub1: ["u_one", "u_two"] }));
  const spyRef = (path = "") => {
    const inner = base.ref(path);
    if (path.startsWith("push_mutes/")) {
      return { ...inner, async get() { throw new Error("PERMISSION_DENIED"); } };
    }
    return inner;
  };
  const res = await run({ ref: spyRef }, fakeMessaging(), "005", HUB1());
  assert.equal(res.sent, true);
  assert.equal(res.tokens, 2, "both are still reached");
});

test("SWITCHED ON WITH NO ASSIGNMENT RECEIVES NOTHING — the spec line, as one test", async () => {
  // The full "turned it on" state, assembled rather than composed out of three
  // partial proofs: this person tapped the switch, so they have a live token
  // AND no mute record — the exact database state enablePush() + an unmute
  // leaves behind. Junid has not assigned them. They hear nothing.
  //
  // This is the sentence that makes the switch a veto rather than an opt-in,
  // and it is the one a future "helpful" fallback in resolveRecipients would
  // break while every other test here stayed green.
  const world = ASSIGNED({ hub1: ["u_assigned"] });
  world.push_tokens.u_keen = { d1: { token: "tok-u_keen" } };   // registered by the ON tap
  // and NO world.push_mutes entry for u_keen — unmuting deletes the record
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, "005", HUB1());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0].tokens, ["tok-u_assigned"],
    "being audible and registered is not being a recipient");
  assert.equal(res.tokens, 1);
});

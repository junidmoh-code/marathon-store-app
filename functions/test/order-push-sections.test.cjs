// ─── ORDER PUSH × THE NETWORK REGISTRY — hubs, labels, links and sections ────
// Run: cd functions && node --test test/order-push-sections.test.cjs
//
// Three things, each pinned for BOTH sections:
//   1. Section 2 (Hub 1, Hub 2) sends exactly what it sent before the hub lists
//      came out of the code: same audience node, same title, body, link, tag.
//   2. Section 1 (Hub 3 — there is no Concrete Stockroom) is served by the same code path.
//   3. An account scoped to one section never receives the other section's
//      hub's alerts, read from three leaves and never from /users.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  notifyOrderPlaced, composeMessage, orderLink, warehouseTabFor, hubLabel, dropOtherSections, WAREHOUSE_HUBS,
} = require("../lib/order-push.cjs");
const { pushHubsOf, warehouseHubsOf, isCrHub, hubSectionOf } = require("../lib/push-hubs.cjs");
const { sectionRecord, sectionsMap, readAccountSections, locationInSections } = require("../lib/section-access.cjs");
const { normalizeNetwork, SEED_REGISTRY } = require("../lib/network-registry.cjs");

const NOW = 1_757_000_000_000;
const AT = new Date(NOW).toISOString();

// The same fake the main suite uses, cut down: get / update / transaction with
// the cold-cache first call. `refuse` makes chosen paths reject on get().
function fakeDb(initial = {}, { refuse = () => false } = {}) {
  const state = structuredClone(initial);
  const reads = [];
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const setPath = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let n = state;
    for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (value === null || value === undefined) delete n[last]; else n[last] = value;
  };
  const snapOf = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v != null });
  const ref = (path = "") => ({
    async get() {
      reads.push(path);
      if (refuse(path)) throw new Error(`refused ${path}`);
      return snapOf(at(path));
    },
    async update(updates) { for (const [k, v] of Object.entries(updates)) setPath(path ? `${path}/${k}` : k, v); },
    async transaction(fn) {
      const first = fn(null);
      if (first === undefined) return { committed: false, snapshot: snapOf(at(path)) };
      const server = at(path);
      const value = server === undefined ? first : fn(structuredClone(server));
      if (value === undefined) return { committed: false, snapshot: snapOf(server) };
      setPath(path, value === null ? null : structuredClone(value));
      return { committed: true, snapshot: snapOf(value) };
    },
  });
  return { ref, state, reads };
}

function fakeMessaging() {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(message) {
      calls.push(message);
      return { responses: message.tokens.map(() => ({ success: true })), successCount: message.tokens.length };
    },
  };
}

const ORDER = (over = {}) => ({
  id: "005", productId: "p1", productName: "Nike Air Max 90", size: "9",
  customerName: "Ayanda", hub: "hub1", placedAtHub: "hub1", destShop: "marathon-pe",
  status: "incoming", createdAt: AT, updatedAt: AT, ...over,
});
const REFILL = (over = {}) => ORDER({ id: "R041-2", size: "M", qty: 3, customerName: "Shop Refill", hub: "hub2", placedAtHub: "hub2", ...over });

/** assigned: hub → [uids]; users: uid → the /users leaves that exist. */
const WORLD = (assigned, users = {}) => {
  const world = { push_hub_audience: {}, push_tokens: {}, users };
  for (const [hub, uids] of Object.entries(assigned)) {
    world.push_hub_audience[hub] = {};
    for (const uid of uids) {
      world.push_hub_audience[hub][uid] = { at: NOW };
      world.push_tokens[uid] = { d1: { token: `tok-${uid}` } };
    }
  }
  return world;
};

const run = (db, messaging, record, over = {}) => notifyOrderPlaced({
  db, messaging, orderId: record.id, record, createdAt: record.createdAt,
  // A frozen wall clock: sentAt is nowMs plus the time actually waited, and a
  // real clock ticking over mid-test would make the pinned payloads flaky.
  nowMs: NOW, now: () => NOW, sleep: async () => {}, newWindowId: () => "W1", ...over,
});

// ── 1. THE VOCABULARY ────────────────────────────────────────────────────────

test("the hubs come from the registry: Hub 3 beside Hub 1 and Hub 2 (no Concrete Stockroom)", () => {
  assert.deepEqual([...pushHubsOf(SEED_REGISTRY)].sort(), ["hub1", "hub2", "hub3"]);
  // hubC is not a registry location; it stays linkable and is never assignable.
  assert.deepEqual([...warehouseHubsOf(SEED_REGISTRY)].sort(), ["hub1", "hub2", "hub3", "hubC"]);
  assert.equal(pushHubsOf(SEED_REGISTRY).includes("hubC"), false);
  assert.deepEqual([...WAREHOUSE_HUBS].sort(), ["hub1", "hub2", "hub3", "hubC"]);
  // a stored record for the removed Stockroom never makes it notifiable again
  assert.equal(pushHubsOf(normalizeNetwork({ locations: { "concrete-stockroom": { type: "hub", section: 1, name: "Concrete Stockroom" } } })).includes("concrete-stockroom"), false);
  // No registry at all is the built-in one, never an empty list.
  assert.deepEqual(pushHubsOf(null), pushHubsOf(SEED_REGISTRY));
});

test("a hub the owner adds on the Network card is a notifiable hub with no deploy", () => {
  const R = normalizeNetwork({ locations: { hub4: { name: "Hub 4", type: "hub", section: 2, sort: 30 } } });
  assert.ok(pushHubsOf(R).includes("hub4"));
  assert.equal(hubLabel("hub4", R), "Hub 4");
  assert.match(orderLink({ orderId: "005", createdAt: AT, hub: "hub4", tab: "queue" }, 1, R), /hub=hub4/);
  // …and on the built-in registry it is not one.
  assert.equal(orderLink({ orderId: "005", createdAt: AT, hub: "hub4", tab: "queue" }, 1), "/");
});

test("SECTION 2 LABELS ARE THE WORDS THEY ALWAYS WERE", () => {
  // The literal map this replaced, entry for entry.
  const was = {
    hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", central: "Central",
    "marathon-pe": "Marathon PE", trophy: "Trophy", "marathon-pine": "Marathon Pine",
  };
  for (const [id, words] of Object.entries(was)) assert.equal(hubLabel(id), words, id);
  // Unknown stays its own text; nothing stays "a store". hubC had no label before.
  assert.equal(hubLabel("shop-from-2019"), "shop-from-2019");
  assert.equal(hubLabel("hubC"), "hubC");
  assert.equal(hubLabel(null), "a store");
  assert.equal(hubLabel(""), "a store");
  // An alias is NOT quietly renamed: only the exact id the order carries.
  assert.equal(hubLabel("pe"), "pe");
  // Section 1's new location reads by name; the removed Stockroom id is unknown text.
  assert.equal(hubLabel("concrete"), "Concrete");
  assert.equal(hubLabel("concrete-stockroom"), "concrete-stockroom");
});

test("which hubs have a CR Orders tab: Hub 2 and Hub 3 as before, Hub 1, hubC and the removed Stockroom not", () => {
  assert.equal(isCrHub(SEED_REGISTRY, "hub2"), true);
  assert.equal(isCrHub(SEED_REGISTRY, "hub3"), true);
  assert.equal(isCrHub(SEED_REGISTRY, "hub1"), false);
  assert.equal(isCrHub(SEED_REGISTRY, "hubC"), false);
  assert.equal(isCrHub(SEED_REGISTRY, "concrete-stockroom"), false);
  for (const notAHub of ["marathon-pe", "central", "", null, "nonsense"]) assert.equal(isCrHub(SEED_REGISTRY, notAHub), false, String(notAHub));

  assert.equal(warehouseTabFor(REFILL({ hub: "hub2", placedAtHub: "hub2" })), "clothing");
  assert.equal(warehouseTabFor(REFILL({ hub: "hub3", placedAtHub: "hub3" })), "clothing");
  assert.equal(warehouseTabFor(REFILL({ hub: "hub1", placedAtHub: "hub1" })), "queue");
  assert.equal(warehouseTabFor(REFILL({ hub: "hubC", placedAtHub: "hubC" })), "queue");
  assert.equal(warehouseTabFor(ORDER({ hub: "hub2", placedAtHub: "hub2" })), "queue", "a customer order is on the queue");
});

test("a hub's section is the registry's; hubC and unknown ids have none", () => {
  assert.equal(hubSectionOf(SEED_REGISTRY, "hub1"), 2);
  assert.equal(hubSectionOf(SEED_REGISTRY, "hub2"), 2);
  assert.equal(hubSectionOf(SEED_REGISTRY, "hub3"), 1);
  for (const none of ["hubC", "central", "marathon-pe", "concrete-stockroom", "nonsense", null]) assert.equal(hubSectionOf(SEED_REGISTRY, none), null, String(none));
});

// ── 2. THE SEND, BOTH SECTIONS ───────────────────────────────────────────────

test("SECTION 2, BYTE FOR BYTE: a Hub 1 order sends the payload it always sent", async () => {
  const { ref, reads } = fakeDb({ ...WORLD({ hub1: ["u_one"], hub2: ["u_two"] }), products: { p1: { name: "Nike Air Max 90" } } });
  const m = fakeMessaging();
  const res = await run({ ref }, m, ORDER());
  assert.equal(res.sent, true);
  assert.deepEqual(m.calls[0], {
    tokens: ["tok-u_one"],
    data: {
      kind: "order", hub: "hub1", count: "1",
      title: "Hub 1 — new order",
      body: "Marathon PE · #005 · Nike Air Max 90 · size 9",
      link: `/?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}`,
      tag: "order-hub1",
      sentAt: String(NOW),
    },
    webpush: { fcmOptions: { link: `/?push=order&hub=hub1&tab=queue&order=005&at=${encodeURIComponent(AT)}` } },
  });
  assert.ok(reads.includes("push_hub_audience/hub1"), "the same audience node");
  assert.ok(!reads.includes("push_hub_audience/hub2"));
});

test("SECTION 2, BYTE FOR BYTE: a Hub 2 shop refill sends the payload it always sent", async () => {
  const { ref } = fakeDb(WORLD({ hub1: ["u_one"], hub2: ["u_two"] }));
  const m = fakeMessaging();
  await run({ ref }, m, REFILL({ destShop: "trophy" }));
  assert.deepEqual(m.calls[0].tokens, ["tok-u_two"]);
  assert.deepEqual(m.calls[0].data, {
    kind: "order", hub: "hub2", count: "1",
    title: "Hub 2 — new order",
    body: "Trophy · #R041-2 · Shop refill: Nike Air Max 90 · size M ×3",
    link: `/?push=order&hub=hub2&tab=clothing&order=R041-2&at=${encodeURIComponent(AT)}`,
    tag: "order-hub2",
    sentAt: String(NOW),
  });
});

test("the seed registry and no registry at all send the same thing", async () => {
  const a = fakeMessaging(); const b = fakeMessaging();
  await run({ ref: fakeDb(WORLD({ hub2: ["u_two"] })).ref }, a, REFILL());
  await run({ ref: fakeDb(WORLD({ hub2: ["u_two"] })).ref }, b, REFILL(), { registry: SEED_REGISTRY });
  assert.deepEqual(a.calls, b.calls);
});

test("THE CONCRETE STOCKROOM DOES NOT EXIST (8 Oct 2026): an order naming it is an UNKNOWN hub — never Hub 3's recipients, no deep link, no section", async () => {
  // (No such order or audience exists in production; this pins that the old
  // id is treated like any id the registry has never heard of.)
  const { ref } = fakeDb(WORLD({ "concrete-stockroom": ["u_stock"], hub3: ["u_pine"], hub2: ["u_two"] }));
  const m = fakeMessaging();
  await run({ ref }, m, ORDER({ hub: "concrete-stockroom", placedAtHub: "concrete-stockroom", destShop: "concrete" }));
  for (const c of m.calls) {
    assert.equal(c.tokens.includes("tok-u_pine"), false);
    assert.equal(c.tokens.includes("tok-u_two"), false);
    assert.equal(c.data.link, "/");
    assert.equal(c.data.title, "concrete-stockroom — new order");
  }
  assert.equal(hubSectionOf(SEED_REGISTRY, "concrete-stockroom"), null);
});

test("SECTION 1: Hub 3 is treated exactly like Hub 1 and Hub 2", async () => {
  const { ref } = fakeDb(WORLD({ hub3: ["u_pine"], hub1: ["u_one"] }));
  const m = fakeMessaging();
  await run({ ref }, m, REFILL({ hub: "hub3", placedAtHub: "hub3", destShop: "marathon-pine" }));
  assert.deepEqual(m.calls[0].tokens, ["tok-u_pine"]);
  assert.equal(m.calls[0].data.title, "Hub 3 — new order");
  assert.match(m.calls[0].data.body, /^Marathon Pine · /);
  assert.match(m.calls[0].data.link, /hub=hub3&tab=clothing/);
});

test("a hub that is NOT LIVE still notifies — an alert tells a person, it routes no stock", async () => {
  // Hub 3 is not fully live (Auto-refill "solved"). An order a person placed there by
  // hand is real work for whoever Junid assigned to it.
  assert.equal(SEED_REGISTRY.locations.hub3.live, false);
  const { ref } = fakeDb(WORLD({ hub3: ["u_pine"] }));
  const m = fakeMessaging();
  assert.equal((await run({ ref }, m, ORDER({ hub: "hub3", placedAtHub: "hub3", destShop: "marathon-pine" }))).sent, true);
});

test("hubC keeps working: its own audience node, a link, and no section filter", async () => {
  const world = WORLD({ hubC: ["u_c"] }, { u_c: { sections: { 1: true } } });
  const { ref, reads } = fakeDb(world);
  const m = fakeMessaging();
  const res = await run({ ref }, m, ORDER({ hub: "hubC", placedAtHub: "hubC" }));
  assert.equal(res.sent, true);
  assert.equal(m.calls[0].data.title, "hubC — new order");
  assert.match(m.calls[0].data.link, /^\/\?push=order&hub=hubC&tab=queue/);
  assert.equal(reads.filter((p) => p.startsWith("users/")).length, 0, "no section is asked about for a hub that has none");
});

test("composeMessage names every registry store, Concrete included", async () => {
  const { ref } = fakeDb({});
  const one = await composeMessage({ ref }, "hub3", 1, { orderId: "005", productName: "Tee", dest: "concrete" });
  assert.equal(one.title, "Hub 3 — new order");
  assert.equal(one.body, "Concrete · #005 · Tee");
});

// ── 3. THE SECTION WALL, FOR ALERTS ──────────────────────────────────────────

test("an account scoped to Section 1 never receives a Section 2 hub's alert, whatever the index says", async () => {
  const world = WORLD({ hub2: ["u_s1", "u_s2", "u_legacy"] }, {
    u_s1: { sections: { 1: true } },
    u_s2: { sections: { 2: true } },
    // u_legacy has no /users leaves at all.
  });
  const { ref } = fakeDb(world);
  const m = fakeMessaging();
  await run({ ref }, m, REFILL());
  assert.deepEqual(m.calls[0].tokens.sort(), ["tok-u_legacy", "tok-u_s2"]);
});

test("…and the other way: a Section 2 account never hears Hub 3", async () => {
  for (const hub of ["hub3"]) {
    const world = WORLD({ [hub]: ["u_s1", "u_s2"] }, { u_s1: { sections: { 1: true } }, u_s2: { sections: { 2: true } } });
    const m = fakeMessaging();
    await run({ ref: fakeDb(world).ref }, m, ORDER({ hub, placedAtHub: hub, destShop: "concrete" }));
    assert.deepEqual(m.calls[0].tokens, ["tok-u_s1"], hub);
  }
});

test("allSections, and an account that predates sections, receive both", async () => {
  const users = { u_all: { allSections: true }, u_old: { stockRole: "warehouse" } };
  for (const hub of ["hub1", "hub3"]) {
    const m = fakeMessaging();
    await run({ ref: fakeDb(WORLD({ [hub]: ["u_all", "u_old"] }, users)).ref }, m, ORDER({ hub, placedAtHub: hub }));
    assert.deepEqual(m.calls[0].tokens.sort(), ["tok-u_all", "tok-u_old"], hub);
  }
});

test("a destShop lock scopes the account to that shop's section", async () => {
  const users = { u_pe: { destShop: "marathon-pe" }, u_pine: { destShop: "marathon-pine" } };
  const m1 = fakeMessaging();
  await run({ ref: fakeDb(WORLD({ hub1: ["u_pe", "u_pine"] }, users)).ref }, m1, ORDER());
  assert.deepEqual(m1.calls[0].tokens, ["tok-u_pe"]);
  const m3 = fakeMessaging();
  await run({ ref: fakeDb(WORLD({ hub3: ["u_pe", "u_pine"] }, users)).ref }, m3, ORDER({ hub: "hub3", placedAtHub: "hub3" }));
  assert.deepEqual(m3.calls[0].tokens, ["tok-u_pine"]);
});

test("everybody assigned is in the other section: nothing is sent, and it says why", async () => {
  const { ref } = fakeDb(WORLD({ hub2: ["u_s1"] }, { u_s1: { sections: { 1: true } } }));
  const m = fakeMessaging();
  const res = await run({ ref }, m, REFILL());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "other_section");
  assert.equal(m.calls.length, 0);
});

test("the scope is read as THREE LEAVES per recipient — never /users, never the whole record", async () => {
  const { ref, reads } = fakeDb(WORLD({ hub1: ["u_one"] }, { u_one: { sections: { 2: true }, permissions: ["stock"] } }));
  await run({ ref }, fakeMessaging(), ORDER());
  assert.deepEqual(reads.filter((p) => p.startsWith("users")).sort(),
    ["users/u_one/allSections", "users/u_one/destShop", "users/u_one/sections"]);
});

test("a muted person costs no section read at all", async () => {
  const world = WORLD({ hub1: ["u_muted"] }, { u_muted: { sections: { 2: true } } });
  world.push_mutes = { u_muted: { muted: true } };
  const { ref, reads } = fakeDb(world);
  const res = await run({ ref }, fakeMessaging(), ORDER());
  assert.equal(res.skipped, "all_muted");
  assert.equal(reads.filter((p) => p.startsWith("users")).length, 0);
});

test("A SCOPE THAT CANNOT BE READ DOES NOT SILENCE THE HUB — and does not throw", async () => {
  const world = WORLD({ hub1: ["u_one", "u_two"] }, { u_two: { sections: { 1: true } } });
  const { ref } = fakeDb(world, { refuse: (p) => p.startsWith("users/u_one/") });
  const m = fakeMessaging();
  let res;
  await assert.doesNotReject(async () => { res = await run({ ref }, m, ORDER()); });
  assert.equal(res.sent, true);
  // u_one's scope is unknown → still told; u_two's is known to be Section 1 → not.
  assert.deepEqual(m.calls[0].tokens, ["tok-u_one"]);
});

test("dropOtherSections leaves the list untouched for a hub with no section", async () => {
  const { ref, reads } = fakeDb({ users: { a: { sections: { 1: true } } } });
  assert.deepEqual(await dropOtherSections({ ref }, SEED_REGISTRY, "hubC", ["a", "b"]), ["a", "b"]);
  assert.equal(reads.length, 0);
});

// ── the reader itself ────────────────────────────────────────────────────────

test("sections stored as a map read back as a map — and as the array RTDB turns { 1, 2 } into", async () => {
  assert.deepEqual(sectionsMap({ 1: true }), { 1: true });
  assert.deepEqual(sectionsMap([null, true, true]), { 1: true, 2: true });
  assert.deepEqual(sectionsMap([null, true]), { 1: true });
  assert.equal(sectionsMap(null), null);
  assert.equal(sectionsMap("1"), null);
  assert.deepEqual(sectionRecord({ sections: null, allSections: null, destShop: null }), {});
  assert.deepEqual(sectionRecord({ sections: [null, true, true], destShop: "marathon-pine" }),
    { sections: { 1: true, 2: true }, destShop: "marathon-pine" });

  const read = (users, uid, opts) => readAccountSections({ ref: fakeDb({ users }).ref }, SEED_REGISTRY, uid, opts);
  assert.deepEqual(await read({ u: { sections: { 1: true } } }, "u"), [1]);
  assert.deepEqual(await read({ u: { sections: { 2: true } } }, "u"), [2]);
  // The array form with a destShop beside it must NOT fall through to the shop.
  assert.deepEqual(await read({ u: { sections: [null, true, true], destShop: "marathon-pine" } }, "u"), [1, 2]);
  assert.deepEqual(await read({ u: { allSections: true, destShop: "trophy" } }, "u"), [1, 2]);
  assert.deepEqual(await read({ u: { destShop: "trophy" } }, "u"), [2]);
  assert.deepEqual(await read({ u: { destShop: "concrete" } }, "u"), [1]);
  assert.deepEqual(await read({}, "nobody"), [1, 2]);
  // A map that grants nothing grants nothing — it is not "unset".
  assert.deepEqual(await read({ u: { sections: { 1: false } } }, "u"), []);
  // An enrolled device's section claim narrows an otherwise unscoped account…
  assert.deepEqual(await read({}, "mc", { deviceSection: 1 }), [1]);
  // …and the owner is never narrowed by anything.
  assert.deepEqual(await read({ o: { sections: { 1: true } } }, "o", { isOwner: true }), [1, 2]);
});

test("locationInSections: POS store ids resolve, Central is everyone's", () => {
  assert.equal(locationInSections(SEED_REGISTRY, [2], "pe"), true);
  assert.equal(locationInSections(SEED_REGISTRY, [2], "trophy"), true);
  assert.equal(locationInSections(SEED_REGISTRY, [2], "pine"), false);
  assert.equal(locationInSections(SEED_REGISTRY, [2], "concrete"), false);
  assert.equal(locationInSections(SEED_REGISTRY, [1], "concrete"), true);
  assert.equal(locationInSections(SEED_REGISTRY, [1], "pe"), false);
  assert.equal(locationInSections(SEED_REGISTRY, [], "central"), true);
});

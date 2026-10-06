// Card capture × sections: a hand capture is refused for a till outside the
// caller's sections — the server half of the capture screen's own filter.
// Run: cd functions && node --test test/card-capture-sections.test.cjs
"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { sectionRefusalFor } = require("../cardRecon/cardRecon.js");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");

beforeEach(() => __resetNetworkCacheForTests());

function fakeDb(data = {}, { refuse = () => false } = {}) {
  const reads = [];
  const at = (p) => p.split("/").reduce((o, k) => (o == null ? undefined : o[k]), data) ?? null;
  const snap = (p) => { reads.push(p); if (refuse(p)) throw new Error(`refused ${p}`); return { val: () => at(p) }; };
  return { reads, ref: (p) => ({ once: async () => snap(p), get: async () => snap(p) }) };
}
const as = (uid, token = {}) => ({ auth: { uid, token: { email: `${uid}@marathon.internal`, ...token } } });
const T = {
  peTill: { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" },
  trophyTill: { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2" },
  pineTill: { storeId: "pine", tillId: "till-1", label: "Pine Till 1" },
  concreteTill: { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2" },
};

test("SECTION 2, AS TODAY: an account with no section set captures every till it always could", async () => {
  const db = fakeDb({ users: { u: { permFlags: { card_recon: true } } } });
  for (const t of Object.values(T)) assert.equal(await sectionRefusalFor(db, as("u"), "TID", t), null, t.label);
});

test("an account scoped to Section 2 captures PE and Trophy, and is refused Pine and Concrete", async () => {
  const db = fakeDb({ users: { u: { sections: { 2: true } } } });
  assert.equal(await sectionRefusalFor(db, as("u"), "A", T.peTill), null);
  assert.equal(await sectionRefusalFor(db, as("u"), "A", T.trophyTill), null);
  assert.match(await sectionRefusalFor(db, as("u"), "A", T.pineTill), /Pine Till 1 is not in your section/);
  assert.match(await sectionRefusalFor(db, as("u"), "A", T.concreteTill), /Concrete Till 2 is not in your section/);
});

test("an account scoped to Section 1 captures Pine and Concrete, and is refused PE and Trophy", async () => {
  const db = fakeDb({ users: { u: { sections: { 1: true } } } });
  assert.equal(await sectionRefusalFor(db, as("u"), "A", T.pineTill), null);
  assert.equal(await sectionRefusalFor(db, as("u"), "A", T.concreteTill), null);
  assert.match(await sectionRefusalFor(db, as("u"), "A", T.peTill), /not in your section/);
  assert.match(await sectionRefusalFor(db, as("u"), "A", T.trophyTill), /not in your section/);
});

test("allSections and Junid capture both; a shop lock scopes to that shop's section", async () => {
  const db = fakeDb({ users: { all: { allSections: true }, pe: { destShop: "marathon-pe" }, owner: { sections: { 1: true } } } });
  for (const t of Object.values(T)) assert.equal(await sectionRefusalFor(db, as("all"), "A", t), null);
  assert.equal(await sectionRefusalFor(db, as("pe"), "A", T.trophyTill), null);
  assert.match(await sectionRefusalFor(db, as("pe"), "A", T.concreteTill), /not in your section/);
  // The owner is never narrowed, and costs no read.
  const before = db.reads.length;
  assert.equal(await sectionRefusalFor(db, { auth: { uid: "owner", token: { email: "gunidmoh@gmail.com" } } }, "A", T.peTill), null);
  assert.equal(db.reads.length, before);
});

test("an enrolled device's section claim scopes the shared login it is on", async () => {
  const db = fakeDb({ users: { mc: { deviceCodeRequired: true } } });
  assert.equal(await sectionRefusalFor(db, as("mc", { section: 1 }), "A", T.concreteTill), null);
  assert.match(await sectionRefusalFor(db, as("mc", { section: 1 }), "A", T.peTill), /not in your section/);
  assert.equal(await sectionRefusalFor(db, as("mc", { section: 2 }), "A", T.peTill), null);
  // A claim that is not exactly 1 or 2 is no claim: the device is not scoped.
  assert.equal(await sectionRefusalFor(db, as("mc", { section: "1" }), "A", T.peTill), null);
  // A device from before sections is not scoped.
  assert.equal(await sectionRefusalFor(db, as("mc"), "A", T.concreteTill), null);
});

test("it reads /network and three leaves — never the /users record", async () => {
  const db = fakeDb({ users: { u: { sections: { 2: true }, permissions: ["card_recon"] } } });
  await sectionRefusalFor(db, as("u"), "A", T.peTill);
  assert.deepEqual([...db.reads].sort(), ["network", "users/u/allSections", "users/u/destShop", "users/u/sections"]);
});

test("a store the registry does not know has no section, and is refused to nobody by THIS check", async () => {
  const db = fakeDb({ users: { u: { sections: { 2: true } } } });
  assert.equal(await sectionRefusalFor(db, as("u"), "A", { storeId: "shop-from-2019", tillId: "till-1" }), null);
});

test("FAILS CLOSED: a scope that cannot be read throws, it does not wave the capture through", async () => {
  const db = fakeDb({ users: { u: { sections: { 1: true } } } }, { refuse: (p) => p === "users/u/sections" });
  await assert.rejects(sectionRefusalFor(db, as("u"), "A", T.peTill), /Could not check which section/);
  await assert.rejects(sectionRefusalFor(db, { auth: null }, "A", T.peTill), /Sign in required/);
});

test("the live /network decides the section — a store moved or added there is honoured", async () => {
  const db = fakeDb({
    users: { u: { sections: { 2: true } } },
    network: { locations: { mall: { name: "Mall", type: "store", section: 2, posId: "mall", sort: 25 } } },
  });
  assert.equal(await sectionRefusalFor(db, as("u"), "A", { storeId: "mall", tillId: "till-1", label: "Mall Till 1" }), null);
});

// Card terminals × the network registry: the stores and tills a terminal can be
// placed on come from /network, so Concrete (2 tills) and Pine can be given
// terminals from the settings sheet — with the day each came into use — and no
// TID, store or till lives in code.
// Run: cd functions && node --test test/card-terminal-sections.test.cjs
"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { posStores, posStoresOf, registryTillsOf, POS_STORES, TILLS_FALLBACK } = require("../lib/pos-tills.cjs");
const { planAdd } = require("../lib/card-terminal-admin.cjs");
const { wasActiveAt } = require("../lib/card-terminals.cjs");
const { normalizeNetwork, SEED_REGISTRY, sectionOf } = require("../lib/network-registry.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const { _handle, _readActiveFromDate } = require("../cardRecon/cardTerminalAdmin.js");

const NOW = Date.parse("2026-10-02T10:00:00.000Z");
beforeEach(() => __resetNetworkCacheForTests());

// The same shape of fake the card-terminal-admin suite uses (null-first
// transactions, server stamps resolved to NOW), with every read path recorded.
function fakeDb(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const reads = [];
  const pushed = [];
  const resolve = (v) => {
    if (v && typeof v === "object" && v[".sv"] === "timestamp") return NOW;
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  const get = (p) => p.split("/").reduce((o, k) => (o == null ? undefined : o[k]), data) ?? null;
  const set = (p, v) => {
    const ks = p.split("/"); let o = data;
    for (const k of ks.slice(0, -1)) o = o[k] ??= {};
    if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v;
  };
  return {
    data, reads, pushed,
    ref: (p) => ({
      once: async () => { reads.push(p); return { val: () => JSON.parse(JSON.stringify(get(p))) }; },
      push: async (v) => { pushed.push(resolve(v)); },
      transaction: async (fn) => {
        let out = fn(null);
        const real = get(p);
        if (out === undefined) return { committed: false, snapshot: { val: () => real } };
        if (real !== null) {
          out = fn(JSON.parse(JSON.stringify(real)));
          if (out === undefined) return { committed: false, snapshot: { val: () => real } };
        }
        set(p, out === null ? null : resolve(out));
        return { committed: true, snapshot: { val: () => (out === null ? null : resolve(out)) } };
      },
    }),
  };
}
const REQ = (data) => ({ data, auth: { uid: "owner", token: { email: "gunidmoh@gmail.com", email_verified: true } } });
const term = (over) => ({ tid: "0000cc1a", storeId: "concrete", tillId: "till-1", label: "Concrete Till 1", mid: "", capture: "both", ...over });

// ── the list ─────────────────────────────────────────────────────────────────
test("SECTION 2 AND PINE, EXACTLY AS THE TYPED LIST HAD THEM", () => {
  // The literal this file replaced.
  const WAS_STORES = [
    { storeId: "pe", label: "Marathon PE" },
    { storeId: "pine", label: "Marathon Pine" },
    { storeId: "trophy", label: "Trophy" },
  ];
  const WAS_TILLS = {
    pe: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }, { tillId: "till-3", name: "Till 3" }],
    pine: [{ tillId: "till-1", name: "Till 1" }],
    trophy: [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }],
  };
  assert.deepEqual(POS_STORES.slice(0, 3), WAS_STORES);
  for (const id of Object.keys(WAS_TILLS)) assert.deepEqual(TILLS_FALLBACK[id], WAS_TILLS[id], id);
  const now = posStores({});
  for (const [i, was] of WAS_STORES.entries()) {
    assert.equal(now[i].storeId, was.storeId);
    assert.equal(now[i].label, was.label);
    assert.deepEqual(now[i].tills, WAS_TILLS[was.storeId]);
    assert.equal(now[i].source, "pos-fallback");
  }
});

test("Concrete is a POS store with two tills, in Section 1; every store says its section", () => {
  const s = posStores({});
  assert.deepEqual(s.map((x) => [x.storeId, x.section, x.location]), [
    ["pe", 2, "marathon-pe"], ["pine", 1, "marathon-pine"], ["trophy", 2, "trophy"], ["concrete", 1, "concrete"],
  ]);
  assert.deepEqual(s.find((x) => x.storeId === "concrete").tills, [{ tillId: "till-1", name: "Till 1" }, { tillId: "till-2", name: "Till 2" }]);
  // The POS id resolves through the registry to the same section.
  for (const x of s) assert.equal(sectionOf(SEED_REGISTRY, x.storeId), x.section, x.storeId);
});

test("a store, a till or a name changed on the Network card is what the sheet offers — no deploy", () => {
  const R = normalizeNetwork({ locations: {
    concrete: { tills: [{ tillId: "till-1", name: "Front" }, { tillId: "till-2", name: "Back" }, { tillId: "till-3", name: "Kiosk" }] },
    "marathon-pine": { name: "Pine Crest" },
    mall: { name: "Mall", type: "store", section: 2, posId: "mall", sort: 25, tills: [{ tillId: "till-1", name: "Till 1" }] },
  } });
  const s = posStores({}, R);
  assert.deepEqual(s.map((x) => x.storeId), ["pe", "pine", "trophy", "concrete", "mall"]);
  assert.deepEqual(s.find((x) => x.storeId === "concrete").tills.map((t) => t.name), ["Front", "Back", "Kiosk"]);
  assert.equal(s.find((x) => x.storeId === "pine").label, "Pine Crest");
  assert.deepEqual(posStoresOf(R).map((x) => x.storeId), s.map((x) => x.storeId));
  assert.deepEqual(Object.keys(registryTillsOf(R)).sort(), ["concrete", "mall", "pe", "pine", "trophy"]);
});

test("a store with no POS id (or a hub) is never offered", () => {
  const R = normalizeNetwork({ locations: { depot: { name: "Depot", type: "store", section: 2, sort: 40 } } });
  assert.equal(posStoresOf(R).some((x) => x.location === "depot"), false);
  assert.equal(posStoresOf(R).some((x) => x.storeId === "hub2" || x.storeId === "central"), false);
});

test("a seeded /pos/config/{store}/tills still wins, for Concrete as for the others", () => {
  const s = posStores({ concrete: [{ tillId: "till-9", name: "Nine" }] });
  assert.deepEqual(s.find((x) => x.storeId === "concrete").tills, [{ tillId: "till-9", name: "Nine" }]);
  assert.equal(s.find((x) => x.storeId === "concrete").source, "pos-config");
  assert.equal(s.find((x) => x.storeId === "pe").source, "pos-fallback");
});

test("placement: Concrete Till 1 and Till 2 are accepted; a till Concrete does not have, and the location id, are refused", () => {
  const stores = posStores({});
  assert.equal(planAdd(term(), null, { stores, now: NOW }).ok, true);
  assert.equal(planAdd(term({ tillId: "till-2" }), null, { stores, now: NOW }).ok, true);
  assert.match(planAdd(term({ tillId: "till-3" }), null, { stores, now: NOW }).reason, /Concrete has no till "till-3"/);
  assert.match(planAdd(term({ storeId: "marathon-concrete" }), null, { stores, now: NOW }).reason, /not a POS store/);
  assert.match(planAdd(term({ storeId: "concrete-stockroom" }), null, { stores, now: NOW }).reason, /not a POS store/);
});

// ── the callable ─────────────────────────────────────────────────────────────
test("options: the stores come from /network, with one small tills read per store and nothing wider", async () => {
  const db = fakeDb({});
  const out = await _handle(db, REQ({ action: "options" }));
  assert.deepEqual(out.stores.map((s) => [s.storeId, s.section]), [["pe", 2], ["pine", 1], ["trophy", 2], ["concrete", 1]]);
  assert.deepEqual([...db.reads].sort(), ["network", "pos/config/concrete/tills", "pos/config/pe/tills", "pos/config/pine/tills", "pos/config/trophy/tills"]);
});

test("options follows the live /network node", async () => {
  const db = fakeDb({ network: { locations: { mall: { name: "Mall", type: "store", section: 2, posId: "mall", sort: 25, tills: [{ tillId: "till-1", name: "Till 1" }] } } } });
  const out = await _handle(db, REQ({ action: "options" }));
  assert.deepEqual(out.stores.map((s) => s.storeId), ["pe", "pine", "trophy", "concrete", "mall"]);
});

test("Junid registers Concrete Till 1, Concrete Till 2 and a Pine terminal from the sheet", async () => {
  const db = fakeDb({});
  const adds = [
    term({ tid: "0000cc1a", tillId: "till-1", label: "Concrete Till 1" }),
    term({ tid: "0000cc2b", tillId: "till-2", label: "Concrete Till 2", capture: "photo" }),
    term({ tid: "0000pn1c", storeId: "pine", tillId: "till-1", label: "Pine Till 1", capture: "email" }),
  ];
  for (const t of adds) {
    const out = await _handle(db, REQ({ action: "add", terminal: t }), { nowMs: NOW });
    assert.equal(out.ok, true, out.reason);
  }
  assert.deepEqual(db.data.config.cardTerminals, {
    "0000CC1A": { storeId: "concrete", tillId: "till-1", label: "Concrete Till 1", capture: "both", activeFrom: NOW },
    "0000CC2B": { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2", capture: "photo", activeFrom: NOW },
    "0000PN1C": { storeId: "pine", tillId: "till-1", label: "Pine Till 1", capture: "email", activeFrom: NOW },
  });
  assert.deepEqual(db.pushed.map((a) => [a.action, a.tid]), [["add", "0000CC1A"], ["add", "0000CC2B"], ["add", "0000PN1C"]]);
});

test("SECTION 2, AS TODAY: a Trophy add with no picked day writes the row it always wrote", async () => {
  const db = fakeDb({});
  const out = await _handle(db, REQ({ action: "add", terminal: { tid: "0000ab1c", storeId: "trophy", tillId: "till-2", label: " Trophy  Till 2 ", mid: "", capture: "photo" } }), { nowMs: NOW });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(db.data.config.cardTerminals["0000AB1C"],
    { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "photo", activeFrom: NOW });
});

// ── in use from ──────────────────────────────────────────────────────────────
test("a picked day becomes the start of that day in South Africa", () => {
  assert.deepEqual(_readActiveFromDate(undefined, NOW), { ok: true, ms: null });
  assert.deepEqual(_readActiveFromDate("", NOW), { ok: true, ms: null });
  assert.deepEqual(_readActiveFromDate(null, NOW), { ok: true, ms: null });
  // 00:00 SAST on 25 Sept is 22:00 UTC on the 24th.
  assert.equal(_readActiveFromDate("2026-09-25", NOW).ms, Date.parse("2026-09-24T22:00:00.000Z"));
  // Today is allowed: its start has already passed.
  assert.equal(_readActiveFromDate("2026-10-02", NOW).ms, Date.parse("2026-10-01T22:00:00.000Z"));
});

test("a day that has not started, an impossible date and anything not a calendar date are refused", () => {
  assert.match(_readActiveFromDate("2026-10-03", NOW).reason, /has not started yet/);
  for (const bad of ["2026-02-31", "2026-13-01", "25/09/2026", "2026-9-5", "yesterday", 1790000000000, {}, "2026-09-25T00:00"]) {
    assert.equal(_readActiveFromDate(bad, NOW).ok, false, JSON.stringify(bad));
  }
});

test("Add with a picked day: the terminal is in the estate from that day, not from the moment it was registered", async () => {
  const db = fakeDb({});
  const out = await _handle(db, REQ({ action: "add", terminal: term({ activeFromDate: "2026-09-25" }) }), { nowMs: NOW });
  assert.equal(out.ok, true, out.reason);
  const row = db.data.config.cardTerminals["0000CC1A"];
  assert.equal(row.activeFrom, Date.parse("2026-09-24T22:00:00.000Z"));
  assert.equal("activeFromDate" in row, false, "the picked text is not stored — only the stamp");
  // A batch from 28 Sept is inside the estate for this row…
  assert.equal(wasActiveAt(row, Date.parse("2026-09-28T16:00:00.000Z")), true);
  // …and would NOT have been, had it been stamped with the day it was registered.
  assert.equal(wasActiveAt({ ...row, activeFrom: NOW }, Date.parse("2026-09-28T16:00:00.000Z")), false);
});

test("a refused day writes nothing and audits nothing", async () => {
  const db = fakeDb({});
  const out = await _handle(db, REQ({ action: "add", terminal: term({ activeFromDate: "2027-01-01" }) }), { nowMs: NOW });
  assert.equal(out.ok, false);
  assert.match(out.reason, /has not started yet/);
  assert.equal(db.data.config, undefined);
  assert.equal(db.pushed.length, 0);
});

test("an edit never moves activeFrom, whatever day it is sent", async () => {
  const db = fakeDb({ config: { cardTerminals: { "0000CC1A": { storeId: "concrete", tillId: "till-1", label: "Concrete Till 1", activeFrom: 5 } } } });
  const out = await _handle(db, REQ({ action: "edit", terminal: term({ tillId: "till-2", activeFromDate: "2026-09-25" }) }), { nowMs: NOW });
  assert.equal(out.ok, true, out.reason);
  assert.equal(db.data.config.cardTerminals["0000CC1A"].activeFrom, 5);
  assert.equal(db.data.config.cardTerminals["0000CC1A"].tillChangedAt, NOW);
});

// ── nothing typed in code ────────────────────────────────────────────────────
test("no store list, till list or TID is typed in the terminal code paths", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tills = read("lib/pos-tills.cjs");
  // The only store ids left are the three whose ORDER is kept; no labels, no tills.
  assert.equal(/"Marathon PE"|"Marathon Pine"|"Trophy"|"Concrete"/.test(tills), false);
  assert.equal(/till-\d/.test(tills), false);
  const admin = read("cardRecon/cardTerminalAdmin.js");
  assert.equal(/"pe"|"pine"|"trophy"|"concrete"|till-\d/.test(admin), false);
  assert.equal(/["'`][0-9]{4}[A-Z0-9]{4}["'`]/.test(admin + tills), false, "no TID literal");
});

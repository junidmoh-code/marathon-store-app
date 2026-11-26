// ─── MANUAL TRANSFER TO EVERY LOCATION, RENDERED (Junid, 26 Nov 2026) ─────────
// The real Transfer screen, driven the way a person drives it (a restored
// cart → Destination → Confirm), from Central, Hub 2 and Hub 3 to each of the
// eight locations. Every write the screen makes goes through the REAL Firebase
// SDK's update() validation (offline — nothing leaves the machine) — the
// screen's own writes; applyMovement is mocked here and judged elsewhere: the
// 24–26 Nov outage was an SDK refusal on the device, so a fake update() that
// accepts anything could never have caught it.
//
// Each transit doc is also checked against the LIVE console rule for
// /transfers/$transferId (fetched read-only 26 Nov 2026), quoted here because
// the repo's database.rules.json is not the source of truth:
//   .write    signed in, non-anonymous, /users/{uid} exists,
//             stockRole ∈ warehouse|store|admin
//   status    matches ^(dispatched|partially_received|received|discrepancy)$
//   from, to  write-once AND /locations/{value} exists
//   createdAt write-once
//   lines/$pid/$sizeKey  number > 0
// The RTDB emulator could not run on the build Mac (no Java runtime), so this
// is the rule's shape asserted directly, field by field, with the live
// /locations ids standing in for the rule's root.child('locations') lookup
// (the users/{uid} and stockRole checks are the caller's, not the doc's).
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-11-26T08:00:00.000Z");

// The live /locations ids (read narrowly, 26 Nov 2026).
const LIVE_LOCATIONS = {
  central: { id: "central", label: "Central", kind: "warehouse", active: true, sellable: false },
  hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true, sellable: false },
  hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true, sellable: false },
  hub3: { id: "hub3", label: "Hub 3", kind: "warehouse", active: true, sellable: false },
  "marathon-pe": { id: "marathon-pe", label: "Marathon PE", kind: "store", active: true, sellable: true },
  trophy: { id: "trophy", label: "Trophy", kind: "store", active: true, sellable: true },
  "marathon-pine": { id: "marathon-pine", label: "Pine", kind: "store", active: true, sellable: true },
  concrete: { id: "concrete", label: "Concrete", kind: "store", active: true, sellable: true },
  in_transit: { id: "in_transit", label: "In Transit", kind: "transit", active: true, sellable: false },
};
const EIGHT = ["hub1", "hub2", "hub3", "central", "marathon-pe", "trophy", "marathon-pine", "concrete"];

const PID = "p_tiro_windbreaker";
const PRODUCTS = [{ id: PID, name: "Adidas Argentina Tiro Travel Windbreaker", category: "Clothing", sizes: ["S", "M", "L"] }];

const writes = [];                       // every patch the REAL SDK accepted
let rejectTransfersWith = null;          // simulate a server refusal on /transfers
let draft = null;
let existingDoc = null;                  // what get(transfers/{id}) returns
let pushN = 0;

vi.mock("firebase/database", async () => {
  const real = await vi.importActual("firebase/database");
  const { initializeApp } = await vi.importActual("firebase/app");
  const app = initializeApp({ projectId: "demo-transfer-all", databaseURL: "http://127.0.0.1:1?ns=demo-transfer-all" }, "transfer-all");
  const db = real.getDatabase(app);
  real.connectDatabaseEmulator(db, "127.0.0.1", 1);
  real.goOffline(db);
  return {
    ref: (_db, path) => ({ path: path ?? "" }),
    child: (r, p) => ({ path: r.path ? `${r.path}/${p}` : p }),
    push: () => ({ key: `-TID${++pushN}` }),
    get: () => Promise.resolve({ exists: () => !!existingDoc, val: () => existingDoc }),
    onValue: () => () => {},
    update: (r, patch) => {
      // The real SDK's path + value validation; it throws on the device for
      // an ancestor/descendant pair — the 26 Nov outage.
      try { real.update(real.ref(db, r.path || undefined), patch); } catch (e) { return Promise.reject(e); }
      if (rejectTransfersWith && Object.keys(patch).some((k) => k.startsWith("transfers/"))) {
        return Promise.reject(rejectTransfersWith);
      }
      writes.push(patch);
      return Promise.resolve();
    },
  };
});
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW, saDateString: () => "2026-11-26" }));
vi.mock("./useStock", () => ({
  useStockCells: (loc) => (LIVE_LOCATIONS[loc] ? { [PID]: { S: { qty: 5, v: 1, mv: "m0", lastType: "received" } } } : {}),
  useTransitConfig: () => ({ enabled: true }),   // live since 24 Nov 12:07 UTC
}));
const applyMovement = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovement(...a) }));
vi.mock("./transferDraft", async () => {
  const real = await vi.importActual("./transferDraft");
  return { ...real, loadDraft: () => draft, saveDraft: () => {}, clearDraft: () => {} };
});
vi.mock("../../update/updateChecker", () => ({ setUpdateBusy: () => {} }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));

const { default: Transfer } = await import("./Transfer.jsx");
const { isTransitLane } = await import("./transitLanes.js");

// The live /transfers/$transferId rule, field by field (see header).
function assertLiveTransferRule(doc, uidRole = "warehouse") {
  expect(uidRole).toMatch(/^(warehouse|store|admin)$/);
  expect(doc.status).toMatch(/^(dispatched|partially_received|received|discrepancy)$/);
  expect(LIVE_LOCATIONS[doc.from]).toBeTruthy();
  expect(LIVE_LOCATIONS[doc.to]).toBeTruthy();
  expect(typeof doc.createdAt).toBe("string");
  for (const sizes of Object.values(doc.lines || {})) {
    for (const q of Object.values(sizes)) { expect(typeof q).toBe("number"); expect(q).toBeGreaterThan(0); }
  }
}

const textOf = (node) => (typeof node === "string" ? node : (node.children || []).map(textOf).join(""));
const button = (root, re) => {
  const b = root.findAll((n) => n.type === "button" && re.test(textOf(n)));
  if (!b.length) throw new Error(`no button matching ${re}`);
  return b[0];
};
const flush = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };

async function sendOne(from, to, { transferId = null } = {}) {
  draft = {
    from, to, refillId: null, transferId, lineResults: {},
    basket: { [`${PID}__S`]: { productId: PID, productName: PRODUCTS[0].name, size: "S", qty: 1 } },
  };
  let r;
  await act(async () => { r = TestRenderer.create(<Transfer products={PRODUCTS} registry={LIVE_LOCATIONS} actorRole="warehouse" />); });
  await act(async () => { button(r.root, /^Restore cart$/).props.onClick(); });
  await act(async () => { button(r.root, /^Destination/).props.onClick(); });
  await act(async () => { button(r.root, /^Confirm →/).props.onClick(); });
  await flush();
  const toast = r.root.findAll((n) => typeof n.type === "string" && n.children?.some((c) => typeof c === "string" && /Sent|Transferred|Couldn't|incomplete/.test(c)));
  const msg = toast.map(textOf).join(" | ");
  act(() => r.unmount());
  return msg;
}

beforeEach(() => {
  writes.length = 0;
  applyMovement.mockClear();
  rejectTransfersWith = null;
  existingDoc = null;
});

describe.each(["central", "hub2", "hub3"])("a manual transfer from %s", (from) => {
  it.each(EIGHT.filter((to) => to !== from))(`reaches %s`, async (to) => {
    const msg = await sendOne(from, to);
    expect(msg).not.toMatch(/Couldn't|incomplete/);
    expect(applyMovement).toHaveBeenCalledTimes(1);
    const mv = applyMovement.mock.calls[0][0];
    expect(mv).toMatchObject({ type: "transfer_out", productId: PID, size: "S", qty: 1, from, manual: true });

    const docWrites = writes.flatMap((p) => Object.entries(p)).filter(([k, v]) => /^transfers\/[^/]+$/.test(k) && v);
    if (isTransitLane(from, to)) {
      // Two-step: the transit record names the REAL destination, the stock
      // parks in in_transit and carries the destination as transitTo.
      expect(docWrites).toHaveLength(1);
      const [key, doc] = docWrites[0];
      expect(doc.to).toBe(to);
      expect(doc.from).toBe(from);
      expect(doc.lines).toEqual({ [PID]: { S: 1 } });
      expect(Object.keys(doc.stamps || {})).toHaveLength(1);      // stamp INSIDE the doc
      assertLiveTransferRule(doc);
      expect(mv.to).toBe("in_transit");
      expect(mv.transitTo).toBe(to);
      expect(mv.link.transferId).toBe(key.split("/")[1]);
      expect(msg).toMatch(/in transit to/);
    } else {
      // One-step: the stock goes straight to the destination; no transit doc.
      expect(docWrites).toHaveLength(0);
      expect(mv.to).toBe(to);
      expect(mv.transitTo).toBeUndefined();
      expect(msg).toMatch(/Transferred 1 line/);
    }
  });
});

describe("a refused transit record says WHY", () => {
  it("appends the real error code to the friendly sentence, and moves nothing", async () => {
    rejectTransfersWith = Object.assign(new Error("PERMISSION_DENIED: Permission denied"), { code: "PERMISSION_DENIED" });
    const msg = await sendOne("central", "hub1");
    expect(msg).toMatch(/Couldn't create the transit record — nothing was sent\. Check connection and retry\. \(PERMISSION_DENIED: Permission denied\)/);
    expect(applyMovement).not.toHaveBeenCalled();
  });
});

describe("a retried transit send (the doc already exists)", () => {
  it("merges the lines into the same doc — leaf paths the real SDK accepts", async () => {
    existingDoc = { status: "dispatched", from: "central", to: "hub1", reason: "manual", createdAt: "2026-11-26T07:00:00.000Z", lines: { other: { M: 1 } } };
    const msg = await sendOne("central", "hub1", { transferId: "-TIDOLD" });
    expect(msg).toMatch(/in transit to/);
    const keys = writes.flatMap((p) => Object.keys(p));
    expect(keys).toContain(`transfers/-TIDOLD/lines/${PID}/S`);
    expect(keys.some((k) => /^transfers\/-TIDOLD\/stamps\//.test(k))).toBe(true);
    expect(keys).not.toContain("transfers/-TIDOLD");
    expect(applyMovement.mock.calls[0][0]).toMatchObject({ to: "in_transit", transitTo: "hub1", link: { transferId: "-TIDOLD" } });
  });

  it("a changed destination with nothing sent drops the stale doc and writes a fresh one to the new place", async () => {
    existingDoc = { status: "dispatched", from: "central", to: "hub2", reason: "manual", createdAt: "2026-11-26T07:00:00.000Z", lines: { [PID]: { S: 1 } } };
    const msg = await sendOne("central", "trophy", { transferId: "-TIDSTALE" });
    expect(msg).toMatch(/in transit to/);
    expect(writes.some((p) => p["transfers/-TIDSTALE"] === null)).toBe(true);
    const fresh = writes.flatMap((p) => Object.entries(p)).filter(([k, v]) => /^transfers\/[^/]+$/.test(k) && v);
    expect(fresh).toHaveLength(1);
    expect(fresh[0][0]).not.toBe("transfers/-TIDSTALE");
    expect(fresh[0][1].to).toBe("trophy");
    assertLiveTransferRule(fresh[0][1]);
  });
});

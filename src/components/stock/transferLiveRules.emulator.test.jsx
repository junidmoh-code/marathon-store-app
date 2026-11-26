// ─── MANUAL TRANSFERS AGAINST THE LIVE CONSOLE RULES, IN THE EMULATOR ─────────
// (Junid, 26 Nov 2026 — "Central → Marathon PE still fails after #1000".)
//
// #1000's tests checked the live /transfers rule by hand. This one runs the
// REAL Transfer screen and the REAL applyMovement against the RTDB emulator
// loaded with the LIVE console rules (fetched read-only by
// scripts/emulator/transfer-live-rules.sh — the repo's database.rules.json is
// stale and is never used here). Every write in the path is judged by the
// real rule engine: the transit record, the stock cells, the ledger movement,
// the Central dispatch row and, for a prefilled refill, the request clearing.
//
// Accounts are modelled on the live /users records (stockRole read leaf by
// leaf, 26 Nov): warehouse staff, a warehouse/store-assistant account with NO
// stockRole, a POS-stockRole super-admin (Jafer), and an admin (Junid).
//
// Skipped unless RTDB_EMULATOR (host:port) and LIVE_RULES_FILE are set; run
// it with `bash scripts/emulator/transfer-live-rules.sh`.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import fs from "node:fs";

const EMU = process.env.RTDB_EMULATOR || "";
const RULES = process.env.LIVE_RULES_FILE || "";
const ON = !!(EMU && RULES && fs.existsSync(RULES));
const [HOST, PORT] = EMU.split(":");
const NS = "demo-marathon";
const BASE = `http://${HOST}:${PORT}`;

const LOCS = {
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
const PID = "p1784817725258";   // the live windbreaker from Junid's report
const PRODUCTS = [{ id: PID, name: "Adidas Argentina Tiro Travel Windbreaker", category: "Clothing", sizes: ["S", "M", "L"] }];

// Modelled on the live /users records (26 Nov 2026), read leaf by leaf.
export const ACCOUNTS = {
  warehouse: { uid: "u_kalid", email: "kalid@staff.test", rec: { username: "kalid", role: "store_assistant", stockRole: "warehouse", permFlags: { warehouse: true } } },
  admin: { uid: "u_junid", email: "gunidmoh@gmail.com", rec: { username: "junid", role: "admin", stockRole: "admin" } },
  // ayob / alliibro / casimu: Stock opened by stock_management, NO stockRole.
  noStockRole: { uid: "u_casimu", email: "casimu@staff.test", rec: { username: "casimu", role: "warehouse", permFlags: { stock_management: true, warehouse: true, stock_add: true } } },
  // zee / the "jafer" login: stock_management, stockRole "pos".
  posStockManager: { uid: "u_zee", email: "zee@staff.test", rec: { username: "zee", role: "admin", stockRole: "pos", permFlags: { stock_management: true, stock_add: true } } },
  // A till login: stockRole pos, no stock_management — never sees Stock.
  posTill: { uid: "u_till", email: "till@staff.test", rec: { stockRole: "pos" } },
};

const owner = { Authorization: "Bearer owner" };
async function rest(method, path, body) {
  const r = await fetch(`${BASE}/${path}.json?ns=${NS}`, { method, headers: owner, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const cell = (qty) => ({ qty, v: 1, mv: "seed", lastType: "received", state: "live" });
function seed() {
  const users = {};
  for (const a of Object.values(ACCOUNTS)) users[a.uid] = a.rec;
  const stock = {};
  for (const l of EIGHT) stock[l] = { [PID]: { S: cell(5) } };
  return {
    users, locations: LOCS, stock,
    products: { [PID]: { name: PRODUCTS[0].name, stockPrice: 350, sizes: ["S", "M", "L"] } },
    config: { transit: { enabled: true } },
  };
}

// Module-level mocks: everything except firebase talks to the real code.
let draft = null;

let appN = 0;
vi.mock("./transferDraft", async () => {
  const real = await vi.importActual("./transferDraft");
  return { ...real, loadDraft: () => draft, saveDraft: () => {}, clearDraft: () => {} };
});
vi.mock("./useStock", () => ({
  useStockCells: (loc) => (EIGHT.includes(loc) ? { [PID]: { S: { qty: 5 } } } : {}),
  useTransitConfig: () => ({ enabled: true }),
}));
vi.mock("../../update/updateChecker", () => ({ setUpdateBusy: () => {}, CURRENT_VERSION: "test-build" }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));

const textOf = (n) => (typeof n === "string" ? n : (n.children || []).map(textOf).join(""));
const button = (root, re) => {
  const b = root.findAll((n) => n.type === "button" && re.test(textOf(n)));
  if (!b.length) throw new Error(`no button ${re}`);
  return b[0];
};

// One send through the real screen. The UI's actorRole is what StockView
// gives it: "admin" for a super-admin, else the stored stockRole.
async function send(acc, from, to, { refillId = null } = {}) {

  vi.resetModules();
  // A fresh firebase module per account: the emulator authenticates every
  // request with this account's mock token, so the RULES see this account.
  vi.doMock("../../firebase", async () => {
    const { initializeApp } = await vi.importActual("firebase/app");
    const { getDatabase, connectDatabaseEmulator } = await vi.importActual("firebase/database");
    const app = initializeApp({ projectId: NS, databaseURL: `${BASE}?ns=${NS}` }, `emu-${acc.uid}-${++appN}`);
    const database = getDatabase(app);
    connectDatabaseEmulator(database, HOST, Number(PORT), {
      mockUserToken: { sub: acc.uid, user_id: acc.uid, email: acc.email, email_verified: true, firebase: { sign_in_provider: "password" } },
    });
    return { database, auth: { currentUser: { uid: acc.uid, email: acc.email } } };
  });
  const { default: Transfer } = await import("./Transfer.jsx");
  const actorRole = acc.email === "gunidmoh@gmail.com" || acc.email === "jafermohammed340@gmail.com" ? "admin" : (acc.rec.stockRole || null);
  draft = {
    from, to, refillId, transferId: null, lineResults: {},
    basket: { [`${PID}__S`]: { productId: PID, productName: PRODUCTS[0].name, size: "S", qty: 1 } },
  };
  let r;
  const toasts = [];
  await act(async () => { r = TestRenderer.create(<Transfer products={PRODUCTS} registry={LOCS} actorRole={actorRole} />); });
  await act(async () => { button(r.root, /^Restore cart$/).props.onClick(); });
  await act(async () => { button(r.root, /^Destination/).props.onClick(); });
  const confirm = button(r.root, /^Confirm →/);
  await act(async () => { await confirm.props.onClick(); });
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise((res) => setTimeout(res, 25)); });
    const t = r.root.findAll((n) => typeof n.type === "string" && n.children?.some((c) => typeof c === "string" && /Sent|Transferred|Couldn't|incomplete/.test(c)));
    if (t.length) { toasts.push(...t.map(textOf)); break; }
  }
  act(() => r.unmount());
  return toasts.join(" | ");
}

const d = ON ? describe : describe.skip;
const { applyProposedTransferRules } = await import("../../../scripts/emulator/proposedTransferRules.mjs");
const LIVE = ON ? JSON.parse(fs.readFileSync(RULES, "utf8")) : null;
// Once Junid has pasted the change, the LIVE rules already accept stock
// managers: the refusal tests flip to "lands", and the patch (which refuses a
// drifted console) is not re-applied.
const PASTED = ON && JSON.stringify(LIVE).includes("child('stock_management').val() === true ||");
const dProposed = ON && !PASTED ? describe : describe.skip;

async function landed(from, to) {
  expect(await rest("GET", `stock/${from}/${PID}/S/qty`)).toBe(4);
  const mv = Object.values((await rest("GET", "stock_movements")) || {})[0];
  expect(mv).toMatchObject({ type: "transfer_out", from, productId: PID, qty: 1 });
  if (mv.to === "in_transit") {
    const doc = Object.values((await rest("GET", "transfers")) || {})[0];
    expect(doc.to).toBe(to);
    expect(doc.lines).toEqual({ [PID]: { S: 1 } });
    expect(await rest("GET", `stock/in_transit/${PID}/S/qty`)).toBe(1);
  } else {
    expect(mv.to).toBe(to);
    expect(await rest("GET", `stock/${to}/${PID}/S/qty`)).toBe(6);
  }
}
async function nothingMoved(from) {
  expect(await rest("GET", `stock/${from}/${PID}/S/qty`)).toBe(5);
  expect(await rest("GET", "stock_movements")).toBe(null);
  expect(await rest("GET", "transfers")).toBe(null);
}
const PAIRS = EIGHT.flatMap((f) => EIGHT.filter((t) => t !== f).map((t) => [f, t]));

d("LIVE console rules × real Transfer screen", () => {
  beforeAll(async () => { await rest("PUT", ".settings/rules", LIVE); });
  beforeEach(async () => { await rest("PUT", "", seed()); });

  it.each(PAIRS)("warehouse staff: %s → %s lands every write", async (from, to) => {
    expect(await send(ACCOUNTS.warehouse, from, to)).toMatch(/Sent 1 line|Transferred 1 line/);
    await landed(from, to);
  });

  it("a prefilled refill is cleared in the same send (one-step lane)", async () => {
    await rest("PUT", "refill_requests/RR1", { status: "open", productId: PID, size: "S", to: "marathon-pe", createdAt: "2026-11-26T07:00:00.000Z" });
    expect(await send(ACCOUNTS.warehouse, "hub1", "marathon-pe", { refillId: "RR1" })).toMatch(/Transferred 1 line/);
    expect(await rest("GET", "refill_requests/RR1/status")).toBe("fulfilled");
  });

  it.each(["warehouse", "admin"])("Central → Marathon PE as %s lands", async (k) => {
    expect(await send(ACCOUNTS[k], "central", "marathon-pe")).toMatch(/Sent 1 line/);
    await landed("central", "marathon-pe");
  });

  // THE 26 NOV FAILURE: the transit record is refused by
  // /transfers/$transferId/.write (stockRole must match warehouse|store|admin).
  it.each(["noStockRole", "posStockManager"])("Central → Marathon PE as %s is REFUSED by the live rules — and says why (until the paste)", async (k) => {
    const msg = await send(ACCOUNTS[k], "central", "marathon-pe");
    if (PASTED) { expect(msg).toMatch(/Sent 1 line/); await landed("central", "marathon-pe"); return; }
    expect(msg).toMatch(/Couldn't create the transit record — nothing was sent\. Check connection and retry\. \(PERMISSION_DENIED/);
    expect(msg).toMatch(/stock role is (not set|"pos") — moving stock needs warehouse, store or admin/);
    await nothingMoved("central");
    // No /logs rule is live yet, so the failure note is refused too.
    expect(await rest("GET", "logs")).toBe(null);
  });

  it.each(["noStockRole", "posStockManager"])("a one-step send as %s is refused on the movement — not called 'network'", async (k) => {
    const msg = await send(ACCOUNTS[k], "hub1", "marathon-pe");
    if (PASTED) { expect(msg).toMatch(/Transferred 1 line/); return; }
    expect(msg).toMatch(/Transfer incomplete — 0\/1 moved.*PERMISSION_DENIED/);
    expect(await rest("GET", `stock/hub1/${PID}/S/qty`)).toBe(5);
  });
});

dProposed("LIVE rules + the proposed paste (scripts/emulator/proposedTransferRules.mjs)", () => {
  beforeAll(async () => { await rest("PUT", ".settings/rules", applyProposedTransferRules(LIVE).rules); });
  beforeEach(async () => { await rest("PUT", "", seed()); });

  it.each(PAIRS)("no-stockRole stock manager: %s → %s lands every write", async (from, to) => {
    expect(await send(ACCOUNTS.noStockRole, from, to)).toMatch(/Sent 1 line|Transferred 1 line/);
    await landed(from, to);
  });

  it.each(PAIRS)("pos-stockRole stock manager: %s → %s lands every write", async (from, to) => {
    expect(await send(ACCOUNTS.posStockManager, from, to)).toMatch(/Sent 1 line|Transferred 1 line/);
    await landed(from, to);
  });

  it("warehouse staff still land Central → Marathon PE", async () => {
    expect(await send(ACCOUNTS.warehouse, "central", "marathon-pe")).toMatch(/Sent 1 line/);
    await landed("central", "marathon-pe");
  });

  it("NARROW: a pos till with no stock_management is still refused", async () => {
    const msg = await send(ACCOUNTS.posTill, "central", "marathon-pe");
    expect(msg).toMatch(/PERMISSION_DENIED/);
    await nothingMoved("central");
  });

  it("NARROW: refill requests are NOT widened — a stock manager without a stockRole cannot clear one", async () => {
    await rest("PUT", "refill_requests/RR1", { status: "open", productId: PID, size: "S", to: "marathon-pe", createdAt: "2026-11-26T07:00:00.000Z" });
    await send(ACCOUNTS.noStockRole, "hub1", "marathon-pe", { refillId: "RR1" });
    expect(await rest("GET", "refill_requests/RR1/status")).toBe("open");
  });

  it("a failure leaves one note at /logs/transferFailures — every field, server time", async () => {
    const msg = await send(ACCOUNTS.posTill, "central", "marathon-pe");
    expect(msg).toMatch(/PERMISSION_DENIED/);
    let rows = null;
    for (let i = 0; i < 20 && !rows; i++) { rows = await rest("GET", "logs/transferFailures"); if (!rows) await new Promise((r) => setTimeout(r, 50)); }
    const list = Object.values(rows || {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: "PERMISSION_DENIED", uid: "u_till", role: "pos", from: "central", to: "marathon-pe", productId: PID, lines: 1, stage: "transit-record" });
    expect(typeof list[0].atMs).toBe("number");
    expect(typeof list[0].build).toBe("string");
  });

  it("a one-step refusal is logged at the movement stage with the real code", async () => {
    await send(ACCOUNTS.posTill, "hub1", "marathon-pe");
    let rows = null;
    for (let i = 0; i < 20 && !rows; i++) { rows = await rest("GET", "logs/transferFailures"); if (!rows) await new Promise((r) => setTimeout(r, 50)); }
    const list = Object.values(rows || {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: "PERMISSION_DENIED", stage: "movement", from: "hub1", to: "marathon-pe", role: "pos" });
  });

  // The paste widens TRANSFERS only: a stock manager with no stockRole still
  // cannot book a receipt or an adjustment on the ledger.
  it.each(["received", "adjustment", "opening"])("NARROW: a no-stockRole stock manager still cannot write a %s movement", async (type) => {
    const { initializeApp } = await vi.importActual("firebase/app");
    const dbm = await vi.importActual("firebase/database");
    const a = ACCOUNTS.noStockRole;
    const app = initializeApp({ projectId: NS, databaseURL: `${BASE}?ns=${NS}` }, `narrow-${type}-${Math.random()}`);
    const db = dbm.getDatabase(app);
    dbm.connectDatabaseEmulator(db, HOST, Number(PORT), { mockUserToken: { sub: a.uid, user_id: a.uid, email: a.email, email_verified: true, firebase: { sign_in_provider: "password" } } });
    const mv = { type, productId: PID, size: "S", qty: 1, actor: a.uid, ts: "2026-11-26T09:00:00.000Z", to: "hub1", ...(type === "adjustment" ? { reason: "x" } : {}) };
    await expect(dbm.set(dbm.ref(db, `stock_movements/narrow_${type}`), mv)).rejects.toThrow(/permission/i);
  });
});


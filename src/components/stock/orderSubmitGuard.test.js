import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { findSubmitShortfall, submitShortfallMessage } from "./orderSubmitGuard";
import { resolveSneakerSourcing, allocateSneakerCart } from "./availabilityCore";
import { stockCellPath } from "../../utils/sizeKey";

// ── A FAKE RTDB THAT BEHAVES LIKE THE REAL ONE WHERE IT MATTERS ─────────────
// Real RTDB stores no empty containers: writing null (or {} / []) removes the
// key, and a parent left with no children disappears with it. An array whose
// last child is removed reads back null; dense integer keys read back as an
// array with null holes (/stock rows are often array-coerced). The guard reads
// one cell by path, so the fake must answer exactly what a `get` would.
function fakeDb(initial = {}) {
  let root = JSON.parse(JSON.stringify(initial));
  const isEmpty = (v) => v == null
    || (Array.isArray(v) && v.every((x) => x == null))
    || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  const prune = (node) => {
    if (node == null || typeof node !== "object") return node;
    for (const k of Object.keys(node)) {
      node[k] = prune(node[k]);
      if (isEmpty(node[k])) { if (Array.isArray(node)) node[k] = null; else delete node[k]; }
    }
    return isEmpty(node) ? null : node;
  };
  return {
    set(path, value) {
      const parts = path.split("/");
      let n = root ?? (root = {});
      for (const p of parts.slice(0, -1)) n = (n[p] ??= {});
      n[parts.at(-1)] = value == null ? null : JSON.parse(JSON.stringify(value));
      root = prune(root) ?? {};
    },
    get(path) {
      let n = root;
      for (const p of path.split("/")) { if (n == null) return null; n = n[p]; }
      return n === undefined ? null : JSON.parse(JSON.stringify(n));
    },
  };
}
const reader = (db, { fail = false } = {}) => (hub, pid, size) =>
  fail ? Promise.reject(new Error("permission_denied")) : Promise.resolve(db.get(stockCellPath(hub, pid, String(size))));

const PID = "p1787222538915";
const SLIDE = { id: PID, name: "Diesel slide black", category: "Footwear", productType: "sneaker", hubs: ["hub1", "hub3"] };
const line = (hub, size, extra = {}) => ({ hub, productId: PID, size, label: SLIDE.name, ...extra });

// The live Diesel slide rows, 3 Oct 2026. Hub 1 is ARRAY-coerced (dense keys).
function liveDb() {
  const hub1 = []; hub1[6] = { qty: 0, state: "untracked" }; hub1[7] = { qty: 2, state: "live" };
  hub1[8] = { qty: 2 }; hub1[9] = { qty: 2, state: "live" }; hub1[10] = { qty: 0 }; hub1[11] = { qty: 0, state: "untracked" };
  return fakeDb({ stock: {
    hub1: { [PID]: hub1 },
    hub2: { [PID]: { 6: { qty: 0 }, 7: { qty: 0 }, 8: { qty: 0 }, 9: { qty: 0 }, 10: { qty: 0 } } },
    hub3: { [PID]: { 6: { qty: 0 }, 7: { qty: 0 }, 8: { qty: 0 }, 9: { qty: 0 }, 10: { qty: 0 } } },
  } });
}

describe("submit-time stock guard — the four cases", () => {
  it("ZERO CELL: order #148's shape (Hub 1, size 10 at 0) is refused", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "10")], readCell: reader(liveDb()) });
    expect(r).toMatchObject({ reason: "short", hub: "hub1", size: "10", have: 0, want: 1 });
    expect(submitShortfallMessage(r, (h) => ({ hub1: "Hub 1" })[h]))
      .toBe("Diesel slide black size 10 is out of stock at Hub 1 — remove it from the cart to place the rest. Nothing was placed.");
  });

  it("UNCOUNTED CELL: a cleared size (qty 0, state untracked) is refused", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "6")], readCell: reader(liveDb()) });
    expect(r).toMatchObject({ reason: "short", size: "6", have: 0 });
  });

  it("…and a cell RTDB deleted outright (absent, not zero) is refused", async () => {
    const db = liveDb();
    db.set(`stock/hub2/${PID}/10`, null);                      // the last cell standing at size 10
    expect(db.get(`stock/hub2/${PID}/10`)).toBe(null);
    const r = await findSubmitShortfall({ lines: [line("hub2", "10")], readCell: reader(db) });
    expect(r).toMatchObject({ reason: "short", hub: "hub2", have: 0 });
  });

  it("SIZE IN STOCK AT HUB 2 ONLY: the line routed to Hub 2 passes; the same line against Hub 1 would not", async () => {
    const db = liveDb();
    db.set(`stock/hub2/${PID}/10`, { qty: 1 });
    // Routing first — the screen's allocation sends this size to Hub 2 …
    const hubData = {
      hub1: { cells: { [PID]: { 10: db.get(`stock/hub1/${PID}/10`) } }, promised: {}, ready: true },
      hub2: { cells: { [PID]: { 10: db.get(`stock/hub2/${PID}/10`) } }, promised: {}, ready: true },
    };
    const cartLine = { product: SLIDE, size: "10" };
    const { hubOf } = allocateSneakerCart({ lines: [cartLine], hubData, taggedHubFor: () => "hub1" });
    expect(hubOf.get(cartLine)).toBe("hub2");
    // … and the guard checks THAT cell.
    expect(await findSubmitShortfall({ lines: [line(hubOf.get(cartLine), "10")], readCell: reader(db) })).toBe(null);
    expect(await findSubmitShortfall({ lines: [line("hub1", "10")], readCell: reader(db) })).toMatchObject({ have: 0 });
  });

  it("RACE: in stock when the sheet opened, 0 by the time Place is tapped — refused on the live read", async () => {
    const db = liveDb();
    db.set(`stock/hub1/${PID}/8`, { qty: 1 });
    // The grid, on the snapshot it holds, offers size 8 …
    const snapshot = { [PID]: { 8: db.get(`stock/hub1/${PID}/8`) } };
    const tile = resolveSneakerSourcing({ product: SLIDE, taggedHub: "hub1", size: "8",
      hubData: { hub1: { cells: snapshot, promised: {}, ready: true }, hub2: { cells: {}, promised: {}, ready: true } } });
    expect(tile.available).toBe(1);
    // … a till sells the last pair before the assistant taps Place …
    db.set(`stock/hub1/${PID}/8`, { qty: 0, lastType: "sold" });
    // … and the guard reads the cell itself, not the snapshot.
    const r = await findSubmitShortfall({ lines: [line("hub1", "8")], readCell: reader(db) });
    expect(r).toMatchObject({ reason: "short", size: "8", have: 0 });
  });
});

describe("submit-time stock guard — the edges", () => {
  it("a covered cart passes, and counted stock is not refused", async () => {
    expect(await findSubmitShortfall({ lines: [line("hub1", "7"), line("hub1", "9")], readCell: reader(liveDb()) })).toBe(null);
  });
  it("the cart is counted per cell: three of size 7 against a cell of 2 is short", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "7"), line("hub1", "7"), line("hub1", "7")], readCell: reader(liveDb()) });
    expect(r).toMatchObject({ reason: "short", size: "7", have: 2, want: 3 });
    expect(submitShortfallMessage(r, () => "Hub 1")).toMatch(/only holds 2 .* the cart has 3 — remove 1/);
  });
  it("a negative cell holds nothing", async () => {
    const db = liveDb(); db.set(`stock/hub1/${PID}/9`, { qty: -1 });
    expect(await findSubmitShortfall({ lines: [line("hub1", "9")], readCell: reader(db) })).toMatchObject({ have: 0 });
  });
  it("an unreadable cell refuses — never a silent accept", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: reader(liveDb(), { fail: true }) });
    expect(r).toMatchObject({ reason: "unreadable", hub: "hub1", size: "7" });
    expect(submitShortfallMessage(r, () => "Hub 1")).toMatch(/^Couldn't confirm stock .* Nothing was placed\.$/);
  });
  it("a read that never answers refuses after the timeout", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: () => new Promise(() => {}), timeoutMs: 20 });
    expect(r).toMatchObject({ reason: "unreadable", error: "stock check timed out" });
  });
  // The module is hub-agnostic: it judges whatever cells it is handed. The
  // SCREEN never hands it a Pine footwear line (see "the guarded lines" below).
  it("hub-agnostic: any hub's empty cell is refused when a caller asks", async () => {
    expect(await findSubmitShortfall({ lines: [line("hub3", "10")], readCell: reader(liveDb()) })).toMatchObject({ hub: "hub3", have: 0 });
  });
  it("reads ONE cell per distinct line — never a hub subtree", async () => {
    const paths = [];
    const db = liveDb();
    await findSubmitShortfall({
      lines: [line("hub1", "7"), line("hub1", "7"), line("hub2", "9.5")],
      readCell: (h, p, s) => { const path = stockCellPath(h, p, String(s)); paths.push(path); return Promise.resolve(db.get(path)); },
    });
    expect(paths.sort()).toEqual([`stock/hub1/${PID}/7`, `stock/hub2/${PID}/9_5`]);
  });
});

// The screen wiring: the guard runs inside placeOrders, BEFORE any write, on
// the same hub the write uses, and a refusal keeps the sheet open.
describe("placeOrders wiring", () => {
  const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
  const body = APP.slice(APP.indexOf("const placeOrders = async"), APP.indexOf("const placeRefillRequests"));
  it("the guard runs before the first write and before the customer is resolved", () => {
    const guard = body.indexOf("findSubmitShortfall(");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("resolveOrderCustomer("));
    expect(guard).toBeLessThan(body.indexOf("await writeOrder(order)"));
    // Sections: the number is drawn for the order's shop (its own sequence
    // for Pine / Concrete; the shared one for Marathon PE / Trophy).
    expect(body.indexOf("getNextOrderNumber(effectiveShop)")).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("getNextOrderNumber(effectiveShop)"));
  });
  it("the guard and the write read the same hub function", () => {
    expect(body).toContain("hub: placedHubFor(item), productId: item.product.id, size: item.size");
    expect(body).toContain("const placedHub = placedHubFor(item);");
  });
  it("it reads one cell by stockCellPath, never a subtree", () => {
    expect(body).toContain("get(ref(database, stockCellPath(hub, pid, String(size))))");
  });
  it("a refusal returns false and the desktop panel stays open on it", () => {
    expect(body).toMatch(/setSubmitRefusal\(submitShortfallMessage\([^)]*\)[^;]*;\s*return false;/);
    expect(APP).toContain("if ((await onPlaceOrder()) !== false) setCoOpen(false);");
  });
});

// WHICH LINES ARE GUARDED — exactly the ones the grid gates. Pine's Hub 3 is
// out: its cells do not record the stock Pine orders are filled from
// (2026-10-03: 7 footwear units at Hub 3, 94 of 119 Pine orders filled).
describe("the guarded lines are the grid's gated lines", async () => {
  const { gatedSneakerHub } = await import("./availabilityCore");
  const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
  it("footwear is guarded through gatedSneakerHub on the line's own placed hub", () => {
    expect(APP).toContain("return !!gatedSneakerHub(item.product, placedHubFor(item));");
  });
  it("so Hub 1/Hub 2 shoes are guarded and a Pine (Hub 3) shoe is not", () => {
    expect(gatedSneakerHub(SLIDE, "hub1")).toBe("hub1");
    expect(gatedSneakerHub(SLIDE, "hub2")).toBe("hub2");
    expect(gatedSneakerHub(SLIDE, "hub3")).toBe(null);
  });
  it("display partner requests and pulls are never guarded; clothing customer lines are", () => {
    expect(APP).toContain("if (item.requestDisplayPartner || item.displayPairRequest === true) return false;");
    expect(APP).toMatch(/const stockGuardedLine = \(item\) => \{[\s\S]{0,200}if \(item\.productType === "clothing"\) return true;/);
  });
});

describe("one-size clothing reads the '_' cell the grid greys on", () => {
  it("'Free Size' resolves to stock/{hub}/{pid}/_", async () => {
    const db = fakeDb({ stock: { hub2: { pX: { _: { qty: 0 } } } } });
    const r = await findSubmitShortfall({ lines: [{ hub: "hub2", productId: "pX", size: "Free Size" }], readCell: reader(db) });
    expect(r).toMatchObject({ reason: "short", have: 0 });
    db.set("stock/hub2/pX/_", { qty: 3 });
    expect(await findSubmitShortfall({ lines: [{ hub: "hub2", productId: "pX", size: "Free Size" }], readCell: reader(db) })).toBe(null);
  });
});

describe("the desktop panel cannot hide a refusal", () => {
  it("a refusal reopens the checkout panel (destination-confirm path closes it first)", () => {
    const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain("useEffect(() => { if (submitRefusal) setCoOpen(true); }, [submitRefusal]);");
  });
});

describe("offline: a cached positive cell is never trusted (CodeRabbit, #671)", () => {
  it("disconnected → refused as unreadable, and no cell is read", async () => {
    let reads = 0;
    const db = liveDb();
    const r = await findSubmitShortfall({
      lines: [line("hub1", "7")],
      readCell: (...a) => { reads++; return reader(db)(...a); },
      isOnline: () => Promise.resolve(false),
    });
    expect(r).toMatchObject({ reason: "unreadable", error: "offline", size: "7" });
    expect(reads).toBe(0);
  });
  it("a connection check that throws is offline", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: reader(liveDb()), isOnline: () => Promise.reject(new Error("x")) });
    expect(r).toMatchObject({ reason: "unreadable" });
  });
  it("connected → judged on the cell", async () => {
    expect(await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: reader(liveDb()), isOnline: () => Promise.resolve(true) })).toBe(null);
  });
  it("the screen passes the .info/connected check", () => {
    const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain('unsub = onValue(ref(database, ".info/connected"), (snap) => finish(snap.val() === true), () => finish(false));');
  });
});

describe("promises are netted like the grid nets them (CodeRabbit, #671)", () => {
  it("a cell of 2 with 2 promised to ready orders holds nothing", async () => {
    const r = await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: reader(liveDb()),
      promisedFor: (h, p, s) => (h === "hub1" && s === "7" ? 2 : 0) });
    expect(r).toMatchObject({ reason: "short", have: 0 });
  });
  it("one promised of two leaves one", async () => {
    expect(await findSubmitShortfall({ lines: [line("hub1", "7")], readCell: reader(liveDb()), promisedFor: () => 1 })).toBe(null);
  });
  it("the screen passes the grid's own promised maps, footwear hubs only", () => {
    const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(APP).toContain("? (sneakerPromisedMap(hub)[promisedKey(pid, size)] || 0) : 0),");
  });
});

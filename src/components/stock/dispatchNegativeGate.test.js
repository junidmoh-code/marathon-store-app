// ─── THE DISPATCH NEGATIVE GATE — allow-list, proved end to end ───────────────
// The incident this file exists for: 2026-07-27, four bottles of
// "Lacoste original 100ML" dispatched out of hub1 — a hub that has never held a
// single unit of perfume — drove hub1 to −4 and credited Marathon PE with four
// units no shelf had. applyMovement's negative floor would have refused every
// one of them. It was disabled because the gate was a DENY-LIST (`!isClothing`)
// and a perfume is not clothing.
//
// ── HOW THIS FILE IS BUILT, AND WHY ──────────────────────────────────────────
// A gate test that re-implements the gate and asserts against its own copy
// proves nothing; this repo has been bitten by exactly that. So:
//
//   §1  asserts the REAL gate function against catalogue records copied from
//       live /products — including the exact perfume record from the incident.
//   §2  drives the REAL applyMovement (in-memory RTDB fake, same harness as
//       applyMovementExpect.test.js) with allowNegative taken from the REAL
//       gate, and replays the incident. Nothing here restates the rule: the
//       assertions are on the resulting cell and the returned reason.
//   §3  pins the call site — App.jsx must actually ASK the gate. Without this,
//       the module could be orphaned and §1/§2 would stay green.
//
// MUTATION CHECK (run before every change to the gate). Revert the gate body to
// the old deny-list:
//
//     export function dispatchAllowsNegative(product, order) {
//       return order?.productType !== "clothing";
//     }
//
// and these must go red:
//   • §1 "the incident's own perfume record"      — the named perfume
//   • §2 "replays the incident"                   — hub1 lands on −4 again
//   • §2 "a blocked line is not marked Sent"
// while §2 "a real sneaker dispatch … exactly as today" must stay GREEN under
// both the old and the new gate — that is the no-regression half.

import { describe, it, expect as expectVi, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stockCellPath } from "../../utils/sizeKey";
import { dispatchAllowsNegative } from "../../utils/dispatchNegativeGate";

// ── in-memory RTDB, so applyMovement under test is the real one ──────────────
let store = {};
let pushN = 0;

function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) {
      const full = node.path ? `${node.path}/${k}` : k;
      if (v && typeof v === "object" && "__increment" in v) {
        setPath(full, (Number(getPath(full)) || 0) + v.__increment);
      } else setPath(full, v);
    }
  },
  push: () => ({ key: `mv${++pushN}` }),
  // applyMovement now also maintains /stock_provenance in the same atomic update,
  // using increment(). This fake resolves it eagerly so the resulting store holds
  // plain numbers; the SENTINEL shape is asserted in provenanceMaintain.test.js,
  // which captures the raw payload instead.
  increment: (delta) => ({ __increment: delta }),
}));
vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u1" } } }));

const { applyMovement } = await import("./applyMovement.js");

// ── catalogue records, copied field-for-field from live /products ────────────

// p1784882828657 — the product in the incident. `productType` and `hubs` are
// ABSENT, exactly as they are live; perfume omits productType deliberately so it
// stays out of the clothing refill lane, and that omission must never be
// "fixed" by writing productType onto perfume records.
const LACOSTE_ORIGINAL_100ML = {
  id: "p1784882828657",
  name: "Lacoste original 100ML",
  category: "Perfume",
  categoryKey: "perfumes",
  sizes: ["_"],
};

// p1784882828658 — the other exposed perfume (no hubs, no productType).
const LACOSTE_PINK_90ML = {
  id: "p1784882828658",
  name: "Lacoste pink 90ML",
  category: "Perfume",
  categoryKey: "perfumes",
  sizes: ["_"],
};

// A real shoe that carries productType (604 of 1,398 live footwear records do).
const SNEAKER_TYPED = {
  id: "p1777979694000",
  name: "Nike Air Force 1 Low White",
  category: "Footwear",
  categoryKey: "sneakers",
  productType: "sneaker",
  sizes: ["6", "7", "8"],
};

// A real shoe with productType ABSENT — 794 of the 1,398 live footwear records
// look like this. Keying the gate on catalogue productType would have stripped
// the A1 exemption from every one of them.
const SNEAKER_UNTYPED = {
  id: "p1777979694047",
  name: "Nike Air Force 1 White",
  category: "Footwear",
  categoryKey: "sneakers",
  sizes: ["6", "7", "8"],
};

const SOCCER_BOOT = {
  id: "p1778839637437",
  name: "Adidas Predator Elite Laceless FG Gold Black Soccer Boots",
  category: "Footwear",
  categoryKey: "soccer-boots",
  productType: "sneaker",
  sizes: ["7", "8"],
};

const CLOTHING = {
  id: "p1780345207000",
  name: "Nike Tech Fleece Tracksuit Gray",
  category: "Clothing",
  categoryKey: "tracksuits",
  productType: "clothing",
  sizes: ["M", "L", "XL"],
};

// p1780345207491 — live clothing record that WRONGLY carries productType
// "sneaker". Four such records exist. The catalogue category is the truth.
const JACKET_MISTYPED_AS_SNEAKER = {
  id: "p1780345207491",
  name: "Nike Windrunner Jacket Black",
  category: "Clothing",
  categoryKey: "jackets",
  productType: "sneaker",
  sizes: ["M", "L"],
};

const BAG = {
  id: "p1782715943401",
  name: "Lacoste handbag",
  category: "Accessories",
  categoryKey: "bags",
  sizes: ["_"],
};

// ── §1 — the gate itself, against live-shaped records ────────────────────────

describe("dispatchAllowsNegative — the allow-list", () => {
  it("refuses the incident's own perfume record (Lacoste original 100ML)", () => {
    expectVi(dispatchAllowsNegative(LACOSTE_ORIGINAL_100ML)).toBe(false);
  });

  it("refuses the other exposed perfume (Lacoste pink 90ML)", () => {
    expectVi(dispatchAllowsNegative(LACOSTE_PINK_90ML)).toBe(false);
  });

  it("allows a shoe that carries productType", () => {
    expectVi(dispatchAllowsNegative(SNEAKER_TYPED)).toBe(true);
  });

  it("allows a shoe whose productType is ABSENT — 794 live records look like this", () => {
    expectVi(dispatchAllowsNegative(SNEAKER_UNTYPED)).toBe(true);
  });

  it("allows a soccer boot", () => {
    expectVi(dispatchAllowsNegative(SOCCER_BOOT)).toBe(true);
  });

  it("refuses clothing, as the deny-list did", () => {
    expectVi(dispatchAllowsNegative(CLOTHING)).toBe(false);
  });

  it("refuses a jacket mis-stamped productType:'sneaker' — the catalogue wins", () => {
    expectVi(dispatchAllowsNegative(JACKET_MISTYPED_AS_SNEAKER)).toBe(false);
  });

  it("refuses a bag", () => {
    expectVi(dispatchAllowsNegative(BAG)).toBe(false);
  });

  it("refuses an unknown / unresolvable product", () => {
    expectVi(dispatchAllowsNegative(null)).toBe(false);
    expectVi(dispatchAllowsNegative(undefined)).toBe(false);
    expectVi(dispatchAllowsNegative({ id: "p?", name: "no category" })).toBe(false);
  });
});

// ── §2 — the real writer, driven by the real gate ────────────────────────────
//
// This mirrors recordDispatchTransfer's applyMovement call exactly: same type,
// same from/to, same size handling, and allowNegative taken from the gate.

const dispatch = (product, { from, to, size, qty = 1, orderId = "065" }) =>
  applyMovement({
    type: "transfer_out",
    productId: product.id,
    size,
    qty,
    from,
    to,
    actorRole: "warehouse",
    link: { orderId },
    movementId: `disp_${orderId}_2026-07-27T08_32_50_628Z`,
    allowNegative: dispatchAllowsNegative(product),   // ← the gate under test
  });

describe("dispatch through the real applyMovement", () => {
  beforeEach(() => { store = {}; pushN = 0; });

  it("replays the incident: four perfume dispatches out of an empty hub1 are all refused", async () => {
    // hub1 held nothing — live /stock/hub1 has exactly one perfume cell today
    // and it is the −4 these four dispatches created.
    setPath(stockCellPath("hub1", LACOSTE_ORIGINAL_100ML.id, "Free Size"), { qty: 0, v: 0, mv: "seed", lastType: "count" });

    for (const orderId of ["068", "067", "066", "065"]) {
      const res = await dispatch(LACOSTE_ORIGINAL_100ML, {
        from: "hub1", to: "marathon-pe", size: "Free Size", orderId,
      });
      expectVi(res.ok).toBe(false);
      expectVi(res.reason).toBe("insufficient_stock");
      expectVi(res.available).toBe(0);
    }

    // The cell never moved, and Marathon PE was never credited.
    expectVi(getPath(stockCellPath("hub1", LACOSTE_ORIGINAL_100ML.id, "Free Size")).qty).toBe(0);
    expectVi(getPath(stockCellPath("marathon-pe", LACOSTE_ORIGINAL_100ML.id, "Free Size"))).toBe(null);
    // And no ledger row was written for any of the four.
    expectVi(getPath("stock_movements")).toBe(null);
  });

  it("a blocked line is not marked Sent — the caller gets the blockSend reason", async () => {
    setPath(stockCellPath("hub1", LACOSTE_ORIGINAL_100ML.id, "Free Size"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await dispatch(LACOSTE_ORIGINAL_100ML, { from: "hub1", to: "marathon-pe", size: "Free Size" });
    // recordDispatchTransfer turns exactly this reason into { blockSend: true },
    // which markSentWithTransfer honours by returning before updateStatus.
    expectVi(res.reason).toBe("insufficient_stock");
  });

  it("a perfume dispatch from a hub that HAS the stock still goes through", async () => {
    // The gate must not block a legitimate move — only an overdraw.
    setPath(stockCellPath("hub2", LACOSTE_ORIGINAL_100ML.id, "Free Size"), { qty: 4, v: 1, mv: "seed", lastType: "transfer_out" });
    const res = await dispatch(LACOSTE_ORIGINAL_100ML, { from: "hub2", to: "marathon-pe", size: "Free Size" });
    expectVi(res.ok).toBe(true);
    expectVi(getPath(stockCellPath("hub2", LACOSTE_ORIGINAL_100ML.id, "Free Size")).qty).toBe(3);
    expectVi(getPath(stockCellPath("marathon-pe", LACOSTE_ORIGINAL_100ML.id, "Free Size")).qty).toBe(1);
  });

  it("a real sneaker dispatch against insufficient stock behaves exactly as today — the hub goes negative", async () => {
    // A1 (stock-integrity): the parcel physically leaves the hub, so the ledger
    // moves and the hub negative is the honest shortage signal. This must be
    // identical before and after the allow-list.
    setPath(stockCellPath("hub1", SNEAKER_TYPED.id, "8"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await dispatch(SNEAKER_TYPED, { from: "hub1", to: "marathon-pe", size: "8", orderId: "090" });
    expectVi(res.ok).toBe(true);
    expectVi(getPath(stockCellPath("hub1", SNEAKER_TYPED.id, "8")).qty).toBe(-1);
    expectVi(getPath(stockCellPath("marathon-pe", SNEAKER_TYPED.id, "8")).qty).toBe(1);
  });

  it("a shoe with NO productType keeps the A1 exemption too", async () => {
    setPath(stockCellPath("hub1", SNEAKER_UNTYPED.id, "7"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await dispatch(SNEAKER_UNTYPED, { from: "hub1", to: "marathon-pe", size: "7", orderId: "091" });
    expectVi(res.ok).toBe(true);
    expectVi(getPath(stockCellPath("hub1", SNEAKER_UNTYPED.id, "7")).qty).toBe(-1);
  });

  it("clothing is still blocked, exactly as the deny-list had it", async () => {
    setPath(stockCellPath("hub2", CLOTHING.id, "L"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await dispatch(CLOTHING, { from: "hub2", to: "marathon-pe", size: "L", orderId: "092" });
    expectVi(res.ok).toBe(false);
    expectVi(res.reason).toBe("insufficient_stock");
    expectVi(getPath(stockCellPath("hub2", CLOTHING.id, "L")).qty).toBe(0);
  });

  it("a bag can no longer mint stock out of an empty hub", async () => {
    setPath(stockCellPath("hub2", BAG.id, "_"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await dispatch(BAG, { from: "hub2", to: "marathon-pe", size: "_", orderId: "093" });
    expectVi(res.ok).toBe(false);
    expectVi(res.reason).toBe("insufficient_stock");
  });

  it("an unresolvable product can no longer mint stock either", async () => {
    const GHOST = { id: "p-unknown", name: "?", sizes: ["_"] };
    setPath(stockCellPath("hub1", GHOST.id, "_"), { qty: 0, v: 0, mv: "seed", lastType: "count" });
    const res = await applyMovement({
      type: "transfer_out", productId: GHOST.id, size: "_", qty: 1,
      from: "hub1", to: "marathon-pe", actorRole: "warehouse",
      movementId: "disp_094_x",
      allowNegative: dispatchAllowsNegative(null),   // resolveProductById miss
    });
    expectVi(res.ok).toBe(false);
    expectVi(res.reason).toBe("insufficient_stock");
  });
});

// ── §3 — the call site must actually ask the gate ────────────────────────────
//
// Source pin, deliberately: §1 and §2 exercise the module, but neither notices
// if App.jsx stops importing it. The dispatch path is one function in a 14k-line
// file that has no seam to import directly.

describe("App.jsx dispatch call site", () => {
  const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

  it("imports the gate", () => {
    expectVi(APP).toMatch(/import \{ dispatchAllowsNegative \} from "\.\/utils\/dispatchNegativeGate"/);
  });

  it("derives allowNegative from the resolved catalogue product, not the order", () => {
    expectVi(APP).toContain("const allowNegative = dispatchAllowsNegative(orderProduct);");
  });

  it("no longer passes the deny-list into applyMovement", () => {
    expectVi(APP).not.toContain("allowNegative: !isClothing");
  });

  it("blocks the send on insufficient_stock for every type, not just clothing", () => {
    expectVi(APP).not.toContain('if (isClothing && res.reason === "insufficient_stock")');
    expectVi(APP).toContain('if (res.reason === "insufficient_stock")');
  });
});

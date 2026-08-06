// ─── HUB STOCK CLEANUP — REGISTRATION IDEMPOTENCY, PROVEN ────────────────────
// The owner's mandatory mutation proof: "registering the same display twice
// adds one unit, not two". The mechanism is the DETERMINISTIC movement id —
// applyMovement treats the movement id as its idempotency key, so the fake
// writer below reproduces exactly that semantic (a movement id that already
// landed is a no-op). Kill the deterministic id (the mutation) and these tests
// fail; nothing here asserts on function names or call counts alone.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { stockCellPath } from "../../utils/sizeKey";

// ── In-memory RTDB (same fake as hubCountStore.test.js) ──────────────────────
let store = {};
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
  if (value === null) delete node[parts[parts.length - 1]];
  else node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: async (node) => { readLog.push(String(node.path)); return { val: () => getPath(node.path), exists: () => getPath(node.path) != null }; },
  update: async (node, updates) => {
    for (const [k, v] of Object.entries(updates)) setPath(node.path ? `${node.path}/${k}` : k, v);
  },
  push: () => ({ key: `pk${++pushN}` }),
  runTransaction: async (node, fn) => {
    const cur = getPath(node.path);
    const next = fn(cur);
    if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
    setPath(node.path, next);
    return { committed: true, snapshot: { val: () => next } };
  },
}));
let pushN = 0;
let readLog = [];
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true }, auth: { currentUser: { uid: "walker-1" } } }));

// The labelAlias callable — the ONLY write path to /label_aliases. Mocked at
// the httpsCallable seam so the tests assert WHEN the save files an alias.
const aliasCalls = [];
let aliasResult = { ok: true, aliasId: "al1" };
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (payload) => { aliasCalls.push(payload); if (aliasResult instanceof Error) throw aliasResult; return { data: aliasResult }; },
}));
vi.mock("../../device/deviceId", () => ({ getDeviceId: () => "dev-1" }));

// The capture queue is a separate, already-tested module — here we only assert
// WHEN the register save enqueues and with what.
const enqueueMock = vi.fn(async () => ({ ok: true, captureId: "cap1", normalised: "CT8527016" }));
vi.mock("../../utils/styleCodeCapture", () => ({ enqueueStyleCodeCapture: (...a) => enqueueMock(...a) }));

// The fake writer with the REAL writer's idempotency semantic: the movement id
// is the key. A movement that already exists changes NOTHING and reports
// { idempotent: true } — byte-for-byte the contract in applyMovement.js:112.
const applyMovementMock = vi.fn(async (mv) => {
  const id = mv.movementId || `auto${++pushN}`;
  if (getPath(`stock_movements/${id}`)) return { ok: true, movementId: id, idempotent: true };
  const loc = mv.to || mv.from;
  const path = stockCellPath(loc, mv.productId, mv.size);
  const cell = getPath(path);
  const cur = cell && typeof cell.qty === "number" ? cell.qty : 0;
  const delta = mv.to ? Number(mv.qty) : -Number(mv.qty);
  setPath(path, { ...(cell || {}), qty: cur + delta, v: cell && typeof cell.v === "number" ? cell.v + 1 : 0, mv: id, lastType: mv.type });
  setPath(`stock_movements/${id}`, { ...mv, id });
  return { ok: true, movementId: id };
});
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));

const {
  registerDisplayUnit, addExtraDisplayUnit, recordUnresolvedScan, loadRegister,
  fetchProductFollowingMerge, lookupStyleClaim,
} = await import("./hubCleanupStore.js");

const HUB = "hub2";
const PRODUCT = { id: "p100", name: "Nike Dunk Low" };
// The style-number fact used throughout — typed, no barcode anywhere in sight.
const STYLE = { code: "CT8527-016", source: "manual" };
const cellQty = (size = "6") => {
  const c = getPath(stockCellPath(HUB, PRODUCT.id, size));
  return c && typeof c.qty === "number" ? c.qty : 0;
};
const movementCount = () => Object.keys(getPath("stock_movements") || {}).length;

beforeEach(() => {
  store = {};
  pushN = 0;
  applyMovementMock.mockClear();
  enqueueMock.mockClear();
  readLog = [];
  aliasCalls.length = 0;
  aliasResult = { ok: true, aliasId: "al1" };
});

describe("registration is idempotent — the mandatory mutation proof", () => {
  it("registering the same display twice adds ONE unit, not two", async () => {
    const r1 = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(r1.ok).toBe(true);
    expect(cellQty("6")).toBe(1);

    const r2 = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(r2.ok).toBe(true);
    expect(r2.already).toBe(true);
    expect(cellQty("6")).toBe(1);          // still one unit
    expect(movementCount()).toBe(1);       // still one movement
  });

  it("even with the progress record lost, the movement id blocks a double add", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    // Simulate the record vanishing (cleared node, other device's session wipe):
    setPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`, null);
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(r.ok).toBe(true);
    // The deterministic movement id is the real guard — the record was gone.
    expect(cellQty("6")).toBe(1);
  });

  it("adds onto the hub's EXISTING quantity — a size 6 display adds 1 to size 6", async () => {
    setPath(stockCellPath(HUB, PRODUCT.id, "6"), { qty: 4, v: 7, mv: "m0" });
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(cellQty("6")).toBe(5);
    const cell = getPath(stockCellPath(HUB, PRODUCT.id, "6"));
    expect(cell.v).toBe(8);                // v moved by exactly 1
  });

  it("different sizes are different displays — each registers its own unit", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "8", styleCode: STYLE });
    expect(cellQty("6")).toBe(1);
    expect(cellQty("8")).toBe(1);
  });

  it("a deliberate extra unit adds exactly one; replaying it does not", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    const r = await addExtraDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(2);
    // Two devices adding "one more" from the same base build the SAME movement
    // id — the second is a no-op on stock:
    setPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6/qty`, 1); // other device still sees base 1
    const r2 = await addExtraDisplayUnit({ hub: HUB, product: PRODUCT, size: "6" });
    expect(r2.ok).toBe(true);
    expect(r2.idempotent).toBe(true);
    expect(cellQty("6")).toBe(2);          // still two — never three
  });
});

describe("scope and size discipline", () => {
  it("refuses every hub outside hub1/hub2 — Pine can never be touched", async () => {
    for (const hub of ["hub3", "marathon-pine", "marathon-pe", "trophy", "central"]) {
      const r = await registerDisplayUnit({ hub, product: PRODUCT, size: "6", styleCode: STYLE });
      expect(r.ok).toBe(false);
      const extra = await addExtraDisplayUnit({ hub, product: PRODUCT, size: "6" });
      expect(extra.ok).toBe(false);
    }
    expect(getPath("stock")).toBe(null);
    expect(movementCount()).toBe(0);
  });

  it("refuses a size that would encode to the one-size sentinel — the Free Size leak", async () => {
    for (const size of ["", "_", "Free Size", null]) {
      const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size, styleCode: STYLE });
      expect(r.ok).toBe(false);
    }
    expect(getPath("stock")).toBe(null);
  });

  it("stock changes go through applyMovement — the register write path builds a received movement to the hub", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", qty: 2, styleCode: STYLE });
    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.type).toBe("received");
    expect(mv.to).toBe(HUB);
    expect(mv.qty).toBe(2);
    expect(mv.size).toBe("6");             // RAW size in — the writer owns encoding
    expect(mv.reason).toBe("display_registration");
    expect(cellQty("6")).toBe(2);
  });
});

// ─── THE TWO-FACTS CONTRACT (owner correction 2026-08-06) ────────────────────
// Registration attaches the STYLE NUMBER and the SIZE in one save. No barcode
// is involved anywhere: every call in this whole file identifies the product
// directly (it was found by search or the unregistered list) and none of these
// paths ever reads /barcodes — that is the proof registration is reachable and
// completable without one.
describe("style number + size, one action, no barcode", () => {
  it("registration completes from {product, size, style number} alone — no barcode anywhere", async () => {
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1);
    expect(getPath("barcodes")).toBe(null);          // nothing ever touched the barcode index
  });

  it("ONE call saves BOTH facts: the movement, the record's code fields, and the capture", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    // fact 2 — the unit landed:
    expect(cellQty("6")).toBe(1);
    // fact 1 — the code rode the same save:
    const rec = getPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`);
    expect(rec.styleCodeNormalised).toBe("CT8527016");
    expect(rec.styleCode).toBe("CT8527-016");
    expect(rec.styleCodeFrom).toBe("manual");
    // …and went to the server-decided capture queue in the same action:
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({ productId: PRODUCT.id, origin: "displayCheck" });
  });

  it("without a code, an on-file code, or a reasoned skip, NOTHING is written", async () => {
    for (const styleCode of [null, undefined, { code: "" }, { code: "###" }, { skipped: "nah" }]) {
      const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode });
      expect(r.ok).toBe(false);
    }
    expect(movementCount()).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a label-read code and a typed code both satisfy the step", async () => {
    const label = await registerDisplayUnit({
      hub: HUB, product: PRODUCT, size: "6",
      styleCode: { code: "CT8527-016", source: "label", labelPhoto: { blob: {} } },
    });
    expect(label.ok).toBe(true);
    expect(getPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`).styleCodeFrom).toBe("label");
    expect(enqueueMock.mock.calls[0][0].labelPhoto).toEqual({ blob: {} });

    const typedR = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "7", styleCode: STYLE });
    expect(typedR.ok).toBe(true);
    expect(getPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__7`).styleCodeFrom).toBe("manual");
  });

  it("a product with the code ON FILE needs no capture — and none is enqueued", async () => {
    const onFile = { ...PRODUCT, id: "p200", styleCodeNormalised: "DD1391100", styleCode: "DD1391-100" };
    const r = await registerDisplayUnit({ hub: HUB, product: onFile, size: "6", styleCode: null });
    expect(r.ok).toBe(true);
    const rec = getPath(`settings/hubSneakerCount/register/${HUB}/p200__6`);
    expect(rec.styleCodeNormalised).toBe("DD1391100");
    expect(rec.styleCodeFrom).toBe("on_file");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a deliberate skip is recorded with its reason, and enqueues nothing", async () => {
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: { skipped: "label_missing" } });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1);
    const rec = getPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`);
    expect(rec.styleCodeSkipReason).toBe("label_missing");
    expect(rec.styleCodeNormalised).toBe(null);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a failed capture enqueue downgrades to a warning — the stock unit is never lost", async () => {
    enqueueMock.mockRejectedValueOnce(new Error("queue down"));
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: STYLE });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1);
    expect(r.warning).toMatch(/style number could not be queued/);
  });
});

// ─── LABEL READINGS ARE ALIASES, NEVER KEYS (owner design fix 2026-08-06) ────
describe("registering by label reading — aliases, never styleCodeNormalised", () => {
  const TOKENS = ["CLOUDNOVA", "MONO", "UNDYED", "WHITE"];

  it("a token registration completes: movement + record + ONE alias add, no capture, no code stamp", async () => {
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: { aliasTokens: TOKENS } });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1);
    const rec = getPath(`settings/hubSneakerCount/register/${HUB}/${PRODUCT.id}__6`);
    expect(rec.styleCodeFrom).toBe("label_alias");
    expect(rec.styleCodeNormalised).toBe(null);          // NEVER a key
    expect(rec.aliasTokenCount).toBe(4);
    expect(aliasCalls).toEqual([{ action: "add", productId: PRODUCT.id, tokens: TOKENS }]);
    expect(enqueueMock).not.toHaveBeenCalled();          // no capture queue, no claim
  });

  it("NEVER A DEAD END: a product that already carries an immutable code gains an ALIAS instead of failing", async () => {
    const withCode = { ...PRODUCT, id: "p300", styleCodeNormalised: "CT8527016", styleCode: "CT8527-016" };
    const r = await registerDisplayUnit({ hub: HUB, product: withCode, size: "6", styleCode: { aliasTokens: TOKENS } });
    expect(r.ok).toBe(true);                             // no immutability error, ever
    expect(cellQty === undefined).toBe(false);
    const rec = getPath(`settings/hubSneakerCount/register/${HUB}/p300__6`);
    expect(rec.styleCodeNormalised).toBe("CT8527016");   // the REAL code stays
    expect(aliasCalls).toEqual([{ action: "add", productId: "p300", tokens: TOKENS }]);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a failed alias filing downgrades to a warning — the stock unit is never lost", async () => {
    aliasResult = new Error("callable down");
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: { aliasTokens: TOKENS } });
    expect(r.ok).toBe(true);
    expect(cellQty("6")).toBe(1);
    expect(r.warning).toMatch(/reading could not be filed/);
  });

  it("fewer than two tokens is not an identity — the save refuses", async () => {
    const r = await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "6", styleCode: { aliasTokens: ["ONE"] } });
    expect(r.ok).toBe(false);
    expect(movementCount()).toBe(0);
  });
});

describe("guards", () => {
  it("addExtraDisplayUnit refuses a missing product or sentinel size as a result, never a throw", async () => {
    for (const args of [
      { hub: HUB, product: null, size: "6" },
      { hub: HUB, product: {}, size: "6" },
      { hub: HUB, product: PRODUCT, size: "" },
      { hub: HUB, product: PRODUCT, size: "Free Size" },
    ]) {
      const r = await addExtraDisplayUnit(args);
      expect(r.ok).toBe(false);
    }
    expect(movementCount()).toBe(0);
  });
});

// ─── THE COUNT'S LABEL PATH (owner reversal 2026-08-06) ──────────────────────
// A tongue-label read resolves through the /style_code_index claim — THE
// authority on who owns a code — and the whole path never goes anywhere near
// the barcode index. The read log proves it.
describe("count by tongue label — claim resolution, no barcode anywhere", () => {
  it("the claim resolves to the right product, and only /style_code_index and /products are read", async () => {
    setPath("style_code_index/CT8527016", { productId: "p100", claimedAt: 1 });
    setPath("products/p100", { id: "p100", name: "Nike Dunk Low" });
    const claim = await lookupStyleClaim("CT8527016");
    expect(claim.productId).toBe("p100");
    const p = await fetchProductFollowingMerge(claim.productId);
    expect(p.name).toBe("Nike Dunk Low");
    expect(readLog.every((r) => r.startsWith("style_code_index/") || r.startsWith("products/"))).toBe(true);
    expect(readLog.some((r) => r.startsWith("barcodes"))).toBe(false);
  });

  it("a claim pointing at a merged-away product follows to the survivor", async () => {
    setPath("style_code_index/CT8527016", { productId: "pOld", claimedAt: 1 });
    setPath("products/pOld", { id: "pOld", mergedInto: "pNew" });
    setPath("products/pNew", { id: "pNew", name: "Real Dunk" });
    const claim = await lookupStyleClaim("CT8527016");
    const p = await fetchProductFollowingMerge(claim.productId);
    expect(p.id).toBe("pNew");
  });

  it("no claim → null, cleanly — the caller falls back to the catalogue match", async () => {
    expect(await lookupStyleClaim("ZZ9999999")).toBe(null);
    expect(await lookupStyleClaim("")).toBe(null);
    expect(await lookupStyleClaim(null)).toBe(null);
  });
});

describe("historical barcode rows — following a merge done elsewhere", () => {
  it("a productId merged away resolves to its survivor via /products directly", async () => {
    setPath("products/pOld", { id: "pOld", name: "Dup", mergedInto: "pMid" });
    setPath("products/pMid", { id: "pMid", name: "Mid", mergedInto: "pFinal" });
    setPath("products/pFinal", { id: "pFinal", name: "Real Dunk" });
    const p = await fetchProductFollowingMerge("pOld");
    expect(p?.id).toBe("pFinal");
  });

  it("a live product returns itself; a ghost or dangling chain returns null (fail closed)", async () => {
    setPath("products/pLive", { id: "pLive", name: "Live" });
    setPath("products/pDangling", { id: "pDangling", name: "D", mergedInto: "pGone" });
    expect((await fetchProductFollowingMerge("pLive"))?.id).toBe("pLive");
    expect(await fetchProductFollowingMerge("pGhost")).toBe(null);
    expect(await fetchProductFollowingMerge("pDangling")).toBe(null);
  });

  it("a pointer cycle stops instead of spinning", async () => {
    setPath("products/pA", { id: "pA", mergedInto: "pB" });
    setPath("products/pB", { id: "pB", mergedInto: "pA" });
    expect(await fetchProductFollowingMerge("pA")).toBe(null);
  });
});

describe("the register record and unresolved scans", () => {
  it("keeps a per-slot record the count pass and Leftovers read", async () => {
    await registerDisplayUnit({ hub: HUB, product: PRODUCT, size: "5.5", styleCode: STYLE });
    const reg = await loadRegister(HUB);
    const rec = reg[`${PRODUCT.id}__5_5`];
    expect(rec).toBeTruthy();
    expect(rec.size).toBe("5.5");          // raw size preserved as a VALUE
    expect(rec.sizeKey).toBe("5_5");       // encoded form only in the KEY
    expect(rec.qty).toBe(1);
  });

  it("an unresolved scan is recorded calmly, keyed so re-scans do not pile up", async () => {
    await recordUnresolvedScan({ hub: HUB, code: "199.55/X", context: "count" });
    await recordUnresolvedScan({ hub: HUB, code: "199.55/X", context: "count" });
    const rows = getPath(`settings/hubSneakerCount/unresolved/${HUB}`);
    expect(Object.keys(rows)).toHaveLength(1);
    expect(Object.values(rows)[0].code).toBe("199.55/X");
  });
});

// ─── THE ONE LIST, RENDERED FOR REAL (owner spec 2026-08-08) ─────────────────
// refillQueueCore.test.js pins the pure bridge; this renders the actual
// component, because every directive here is a WIRING claim:
//
//   1. A former hold is an ORDINARY request line — no badge, no order number,
//      no customer name, nothing marking it. The worked example is built
//      verbatim: Adidas Adi 2000 White Grey, size 5 from a sale and size 7
//      from a hold, two identical lines in one list.
//   2. Every row has the SAME actions with the SAME wording — Fulfil and
//      Out of Stock — whatever raised it. The old "Transfer N units to Hub"
//      button is gone.
//   3. Release windows gate EVERYTHING: a clothing sale cell waits for the
//      next window exactly like a sneaker request. No category, no origin
//      exempt. The admin early-release override survives, requests only.
//   4. The page is quiet: ONE status line, and none of the old chrome.
//
// Fixed clock: serverNowMs = 2026-08-07T10:00:00Z = 12:00 SA. Default windows
// 06:00/14:00 SA → last release 04:00Z, next 14:00 SA.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const NOW = Date.parse("2026-08-07T10:00:00.000Z");

const paths = {};   // onValue subscriptions
const gets = {};    // one-shot get() reads
const rejects = new Set();   // paths whose get() fails (offline simulation)
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: (r) => rejects.has(r.path) ? Promise.reject(new Error("offline")) : Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
const applyMovementMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovementMock(...a) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => new Date(NOW).toISOString(), serverNowMs: () => NOW }));

const { default: RefillQueue } = await import("./RefillQueue.jsx");
const { pendingSaleRows } = await import("./refillQueueCore.js");

// 05:00 SA — before the 06:00 release → pickable. 07:00+ SA — waiting for 14:00.
const RELEASED_AT = "2026-08-07T03:00:00.000Z";
const WAITING_AT = "2026-08-07T05:00:00.000Z";

const PRODUCTS = [
  { id: "adi", name: "Adidas Adi 2000 White Grey", photoUrl: null },
  { id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null },
  { id: "cap", name: "New Era 9Forty Navy", photoUrl: null },
  { id: "tee", name: "Essentials Tee Olive", photoUrl: null },
];

const fulfilCtx = {
  canTransfer: true, actorRole: "warehouse", locationsReg: undefined,
  knownLoc: () => true,
  resolveId: (p) => p.productId || null,
};

// The worked example's sale half + a WAITING clothing sale cell, built through
// the REAL bridge so the row shape can never drift from production.
function saleRowsFixture() {
  return pendingSaleRows({
    counts: {
      adi: { productName: "Adidas Adi 2000 White Grey", productId: "adi", nameKey: "adidas_adi_2000_white_grey", photo: "", photoUrl: null, sizes: { 5: 1 } },
      tee: { productName: "Essentials Tee Olive", productId: "tee", nameKey: "essentials_tee_olive", photo: "", photoUrl: null, sizes: { L: 1 } },
    },
    responses: {}, progress: {}, date: "2026-08-07",
    tsBySize: { adi: { 5: Date.parse(RELEASED_AT) }, tee: { L: Date.parse("2026-08-07T05:30:00.000Z") } },
    fallbackMs: Date.parse("2026-08-06T22:00:00.000Z"),
  });
}

const textOf = (n) => {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return textOf(n.children);
};
const buttonsOf = (tree, label) =>
  tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).trim() === label);
const sizeLineOf = (tree, size, origin) =>
  tree.root.findAll((n) => n.props && n.props["data-size"] === size && n.props["data-origin"] === origin)[0];
const rowLineOf = (tree, rowKey) =>
  tree.root.findAll((n) => n.props && n.props["data-row"] === rowKey)[0];
const lineButton = (line, label) =>
  line.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).trim() === label);
function renderQueue(props = {}) {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <RefillQueue products={PRODUCTS} dest="hub1" fulfilCtx={fulfilCtx} saleRows={saleRowsFixture()} {...props} />
    );
  });
  return tree;
}
function renderText(props = {}) {
  const tree = renderQueue(props);
  const text = textOf(tree.toJSON());
  tree.unmount();
  return text;
}

beforeEach(() => {
  for (const k of Object.keys(paths)) delete paths[k];
  for (const k of Object.keys(gets)) delete gets[k];
  updateMock.mockClear();
  applyMovementMock.mockClear();
  rejects.clear();
  perm.permRecord = { stockRole: "warehouse" };
  perm.isSuperAdmin = false;
  paths["refill_requests"] = {
    // The worked example's hold half: size 7 raised by a customer hold. The
    // stamp and order id are IN THE DATA — the row must show none of it.
    holdreq: { productId: "adi", size: "7", qty: 1, requestingLocation: "hub1", status: "open",
               createdAt: RELEASED_AT,
               createdFrom: { manual: true, source: "central", via: "on_hold", orderId: "042", orderDate: "2026-08-07" } },
    // An engine request, released.
    bootreq: { productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open",
               createdAt: RELEASED_AT, createdFrom: { engine: true, source: "central" } },
    // A sneaker request raised AFTER the 06:00 release → waiting.
    capreq: { productId: "cap", size: "M", qty: 1, requestingLocation: "hub1", status: "open",
              createdAt: WAITING_AT, createdFrom: { manual: true, source: "central", via: "missing_sneakers" } },
  };
  paths["stock/hub1"] = null;
  paths["refill_engine/open"] = null;
  paths["config/refillEngine"] = null;   // absent → default 06:00/14:00
  gets["refill_requests/holdreq"] = paths["refill_requests"].holdreq;
  gets["refill_requests/bootreq"] = paths["refill_requests"].bootreq;
  gets["stock/central/adi/7"] = { qty: 3 };
  gets["stock/central/adi/5"] = { qty: 2 };
  gets["stock/central/boot/7"] = { qty: 5 };
});

describe("1 · a former hold is an ordinary request line — the worked example, exactly", () => {
  it("size 5 (sale) and size 7 (hold) are two ordinary lines INSIDE ONE CARD of the same product", () => {
    const tree = renderQueue();
    const out = textOf(tree.toJSON());
    // ONE box per product (owner correction 2026-08-08) — the name renders once
    expect(out.match(/Adidas Adi 2000 White Grey/g)).toHaveLength(1);
    // …and both size lines live inside it, indistinguishable by origin
    expect(sizeLineOf(tree, "5", "sale")).toBeTruthy();
    expect(sizeLineOf(tree, "7", "request")).toBeTruthy();
    // every size line carries the SAME actions; the engine row too (3 lines total)
    expect(buttonsOf(tree, "Fulfil")).toHaveLength(3);
    expect(buttonsOf(tree, "Out of Stock")).toHaveLength(3);
    tree.unmount();
  });

  it("sizes of one product NEVER split into separate boxes; different products get their own", () => {
    const tree = renderQueue();
    // two products on screen (adi grouped incl. both origins, boot) → exactly 2 cards
    const cards = tree.root.findAll((n) =>
      n.type === "div" && n.props.style?.background === "rgba(4,5,10,1)" &&
      n.children.some?.(() => true) && textOf(n.children).includes("size"));
    const cardTexts = cards.map((c) => textOf(c.children));
    expect(cardTexts.filter((t) => t.includes("Adidas Adi 2000 White Grey"))).toHaveLength(1);
    expect(cardTexts.filter((t) => t.includes("Timberland"))).toHaveLength(1);
    tree.unmount();
  });

  it("NOTHING marks the hold: no badge, no order number, no customer name, no hold wording", () => {
    const out = renderText();
    expect(out).not.toContain("CUSTOMER HOLD");
    expect(out).not.toContain("#042");
    expect(out).not.toContain("042");
    expect(out).not.toContain("Customer waiting");
    expect(out).not.toMatch(/on hold/i);
    expect(out).not.toMatch(/\bheld\b/i);
  });

  it("the queue renders NO customer-notification path — fulfil moves stock, nothing messages anyone", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./RefillQueue.jsx", import.meta.url), "utf8");
    for (const banned of ["sendWhatsApp", "whatsapp", "order_tomorrow", "order_ready", "notifyCustomer", "customerPhone"]) {
      expect(src.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("2 · one list, one design — identical rows, identical actions, identical wording", () => {
  it("the old per-origin buttons are gone: no 'Transfer N units to Hub', no reject-✕ footer", () => {
    const tree = renderQueue();
    const labels = tree.root.findAll((n) => n.type === "button").map((n) => textOf(n.props.children));
    expect(labels.find((l) => /Transfer \d+ unit/.test(l))).toBeUndefined();
    expect(labels.find((l) => l.includes("Reject request"))).toBeUndefined();
    expect(labels.find((l) => l.includes("Available"))).toBeUndefined();   // resolvable rows all say Fulfil
    tree.unmount();
  });

  it("Fulfil on a REQUEST row keeps the exact movement contract (central, auto_refill reason, rrf_ id)", async () => {
    const tree = renderQueue();
    const fulfilBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});   // panel loads availability
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    expect(confirm).toBeTruthy();
    await act(async () => { await confirm.props.onClick(); });
    tree.unmount();

    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    expect(applyMovementMock.mock.calls[0][0]).toEqual({
      type: "transfer_out", productId: "boot", size: "7", qty: 2,
      from: "central", to: "hub1", actorRole: "warehouse",
      reason: "hub1_auto_refill",
      movementId: "rrf_bootreq",
      link: { refillId: "bootreq" },
    });
    // and the request is marked fulfilled in the same breath
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/bootreq/status"]).toBe("fulfilled");
    expect(patch["refill_requests/bootreq/fulfilledBy"]).toEqual({ movementId: "rrf_bootreq", qty: 2 });
    expect(patch["refill_requests/bootreq/resolvedBy"]).toBe("u1");
  });

  it("Fulfil on a SALE row keeps the Source contract (picked warehouse, source_refill, seeded id)", async () => {
    const onSaleProgress = vi.fn();
    const tree = renderQueue({ onSaleProgress });
    const fulfilBtn = lineButton(sizeLineOf(tree, "5", "sale"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick(); });
    tree.unmount();

    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    const mv = applyMovementMock.mock.calls[0][0];
    expect(mv.type).toBe("transfer_out");
    expect(mv.reason).toBe("source_refill");
    expect(mv.allowNegative).toBe(true);
    expect(mv.to).toBe("hub1");
    expect(mv.movementId).toBe("srcful_2026-08-07_adi_5_0");
    expect(onSaleProgress).toHaveBeenCalledWith(expect.objectContaining({ key: "adi", size: "5" }), 1, true,
      expect.objectContaining({ counted: true }));
  });

  it("PARTIAL FULFIL deducts the sent tranche — ask ×2, send 1, ×1 stays open (owner correction)", async () => {
    const tree = renderQueue();
    const fulfilBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});   // panel loads availability (5 counted at Central)
    // stepper down from the default full ask (2) to 1
    const minus = tree.root.findAll((n) => n.type === "button" && textOf(n.props.children) === "−")[0];
    await act(async () => { minus.props.onClick(); });
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick(); });
    tree.unmount();

    // one unit moved, under the historic bare id (first tranche)
    expect(applyMovementMock).toHaveBeenCalledTimes(1);
    expect(applyMovementMock.mock.calls[0][0]).toMatchObject({ qty: 1, movementId: "rrf_bootreq" });
    // the request is NOT fulfilled — the remainder is deducted and stays open
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/bootreq/qty"]).toBe(1);
    expect(patch["refill_requests/bootreq/sentQty"]).toBe(1);
    expect(Object.keys(patch).find((k) => k.includes("/status"))).toBeUndefined();
  });

  it("the SECOND tranche gets its own idempotent movement id and closes the request with the true total", async () => {
    // the live record already carries the first tranche: 1 of the original 2 sent
    paths["refill_requests"].bootreq = { ...paths["refill_requests"].bootreq, qty: 1, sentQty: 1 };
    gets["refill_requests/bootreq"] = paths["refill_requests"].bootreq;
    const tree = renderQueue();
    const fulfilBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick(); });
    tree.unmount();

    // a FRESH id — the bare rrf_ id already names tranche one; reusing it would
    // make applyMovement swallow this send as a duplicate
    expect(applyMovementMock.mock.calls[0][0]).toMatchObject({ qty: 1, movementId: "rrf_bootreq_1" });
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/bootreq/status"]).toBe("fulfilled");
    expect(patch["refill_requests/bootreq/fulfilledBy"]).toEqual({ movementId: "rrf_bootreq_1", qty: 1, totalQty: 2 });
  });

  it("a FAILED live read aborts the send — never a guessed tranche id (CodeRabbit, PR #338)", async () => {
    rejects.add("refill_requests/bootreq");
    const tree = renderQueue();
    const fulfilBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick(); });
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(out).toContain("Nothing was sent");
  });

  it("a RETRY after a failed bookkeeping write credits what actually moved, not the new pick", async () => {
    // Tranche one (1 unit) is already in the ledger under the bare id, but the
    // qty/sentQty write failed — the request still reads qty 2 / sentQty 0.
    // The picker retries asking for the full 2: nothing must move again, ONE
    // unit is credited, and ×1 stays open instead of the request closing over
    // a unit that never shipped.
    gets["stock_movements/rrf_bootreq"] = { qty: 1, productId: "boot" };
    const tree = renderQueue();
    const fulfilBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick(); });
    tree.unmount();
    expect(applyMovementMock).not.toHaveBeenCalled();
    const patch = updateMock.mock.calls.at(-1)[1];
    expect(patch["refill_requests/bootreq/qty"]).toBe(1);
    expect(patch["refill_requests/bootreq/sentQty"]).toBe(1);
    expect(Object.keys(patch).find((k) => k.includes("/status"))).toBeUndefined();
  });

  it("a partially-sent request line SHOWS its progress (sentQty renders)", () => {
    paths["refill_requests"].bootreq = { ...paths["refill_requests"].bootreq, qty: 1, sentQty: 1 };
    const tree = renderQueue();
    const line = rowLineOf(tree, "req:bootreq");
    expect(textOf(line.children)).toContain("1 sent");
    tree.unmount();
  });

  it("Out of Stock on a REQUEST row is the human rejection — cancelled with NO cancelReason", async () => {
    const tree = renderQueue();
    const oosBtn = lineButton(rowLineOf(tree, "req:bootreq"), "Out of Stock");
    await act(async () => { await oosBtn.props.onClick(); });
    tree.unmount();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0][1];
    expect(patch["refill_requests/bootreq/status"]).toBe("cancelled");
    expect(patch["refill_requests/bootreq/rejectedBy"]).toBe("warehouse");
    expect(patch["refill_requests/bootreq/resolvedBy"]).toBe("u1");
    // cancelReason is EXPLICITLY CLEARED (null = RTDB delete), never set to a
    // value: the engine reads "cancelled with no cancelReason" as the human
    // rejection. A stale reason from an earlier lifecycle must not survive the
    // reject and demote it to an engine withdrawal (CodeRabbit, PR #337).
    expect(patch["refill_requests/bootreq/cancelReason"]).toBeNull();
    expect(applyMovementMock).not.toHaveBeenCalled();
  });

  it("a THROWING confirm never wedges the row or the panel at 'Transferring…' (finally reset)", async () => {
    const onSaleProgress = vi.fn(() => { throw new Error("progress write exploded"); });
    const tree = renderQueue({ onSaleProgress });
    const fulfilBtn = lineButton(sizeLineOf(tree, "5", "sale"), "Fulfil");
    await act(async () => { fulfilBtn.props.onClick(); });
    await act(async () => {});
    const confirm = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Transfer & Fulfil"));
    await act(async () => { await confirm.props.onClick().catch(() => {}); });
    await act(async () => {});
    const out = textOf(tree.toJSON());
    expect(out).not.toContain("Transferring…");
    // the panel surfaced the failure instead of dying silently
    expect(out).toContain("progress write exploded");
    tree.unmount();
  });

  it("Out of Stock on a SALE row writes the response record and moves no stock", async () => {
    const onSaleResponse = vi.fn();
    const tree = renderQueue({ onSaleResponse });
    const oosBtn = lineButton(sizeLineOf(tree, "5", "sale"), "Out of Stock");
    await act(async () => { oosBtn.props.onClick(); });
    tree.unmount();
    expect(onSaleResponse).toHaveBeenCalledWith(expect.objectContaining({ key: "adi", size: "5", date: "2026-08-07" }), "out_of_stock");
    expect(applyMovementMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("3 · release windows gate EVERYTHING — no category, no origin exempt", () => {
  it("a clothing SALE cell raised after the window waits exactly like a sneaker REQUEST", () => {
    const out = renderText();
    expect(out).not.toContain("New Era 9Forty Navy");     // waiting sneaker request
    expect(out).not.toContain("Essentials Tee Olive");    // waiting clothing sale cell
    expect(out).toContain("3 to pick");
    expect(out).toContain("next batch 14:00");
    expect(out).toContain("2 waiting");
  });

  it("releaseWindows === false releases everything — the escape hatch still works", () => {
    paths["config/refillEngine"] = { releaseWindows: false };
    const out = renderText();
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).toContain("Essentials Tee Olive");
    expect(out).toContain("5 to pick");
    expect(out).not.toContain("next batch");
  });

  it("an earlyRelease stamp frees that one request mid-gap", () => {
    paths["refill_requests"].capreq.earlyRelease = { at: "x", by: "u9", reason: "urgent" };
    const out = renderText();
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).toContain("4 to pick");
  });

  it("admin taps the status line, sees the waiting rows, and Release now exists ONLY for request rows", async () => {
    perm.permRecord = { stockRole: "admin" };
    const tree = renderQueue();
    const statusBtn = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("waiting"));
    act(() => { statusBtn.props.onClick(); });
    const out = textOf(tree.toJSON());
    expect(out).toContain("New Era 9Forty Navy");         // waiting request, listed
    expect(out).toContain("Essentials Tee Olive");        // waiting sale cell, listed
    const releaseBtns = tree.root.findAll((n) => n.type === "button" && textOf(n.props.children).includes("Release now"));
    expect(releaseBtns).toHaveLength(1);                  // the sale cell gets NO override — nothing to stamp

    vi.stubGlobal("window", { prompt: vi.fn(() => "customer at the counter") });
    await act(async () => { await releaseBtns[0].props.onClick(); });
    vi.unstubAllGlobals();
    tree.unmount();
    const [refArg, patch] = updateMock.mock.calls[0];
    expect(refArg.path).toBe("refill_requests/capreq");
    expect(patch).toEqual({ earlyRelease: { at: new Date(NOW).toISOString(), by: "u1", reason: "customer at the counter" } });
  });

  it("staff see the waiting count but no Release now anywhere", () => {
    const tree = renderQueue();
    const statusBtn = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("waiting"));
    act(() => { statusBtn.props.onClick(); });
    const out = textOf(tree.toJSON());
    tree.unmount();
    expect(out).not.toContain("Release now");
  });
});

describe("4 · the quiet page — one status line, none of the old chrome", () => {
  it("exactly one status line; the old banners and toggles are gone", () => {
    const out = renderText();
    expect(out).toContain("3 to pick · next batch 14:00 · 2 waiting");
    for (const chrome of ["Release windows", "Accumulating", "ready to fulfil", "Refill Pending",
                          "Open queue", "Fulfilled history", "waiting behind it", "In the background"]) {
      expect(out).not.toContain(chrome);
    }
  });

  it("empty between windows: the line says when the next batch lands — never a broken screen", () => {
    paths["refill_requests"] = { capreq: paths["refill_requests"].capreq };
    const out = renderText({ saleRows: [] });
    expect(out).toContain("Nothing to pick — next batch lands 14:00 · 1 waiting");
  });
});

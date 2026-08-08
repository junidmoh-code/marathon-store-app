// ─── THE GATE AT THE CALL SITE, NOT JUST THE HELPER ──────────────────────────
// releaseWindows.test.js pins the pure maths. This renders the real component,
// because the class of bug that matters here is a wiring one (the same lesson
// as Hub2RefillQueue.wiring.test.jsx): the gate must be applied to the CARD
// LIST and nowhere else, the waiting count must be told to staff, the backlog
// rows and the urgent override must exist for admin only, and a hold-origin
// request row must say a customer is waiting.
//
// Fixed clock: serverNowMs = 2026-08-07T10:00:00Z = 12:00 SA. With the default
// 06:00/14:00 windows the last release was 06:00 SA (04:00Z) and the next is
// 14:00 SA.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const paths = {};
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: (...a) => updateMock(...a),
  get: vi.fn(() => Promise.resolve({ val: () => null })),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
// Mutable so individual tests can flip between a plain warehouse user and admin.
const perm = { permRecord: { stockRole: "warehouse" }, isSuperAdmin: false };
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ ...perm }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn() }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-07T10:00:00.000Z", serverNowMs: () => Date.parse("2026-08-07T10:00:00.000Z") }));

const { default: Hub2RefillQueue } = await import("./Hub2RefillQueue.jsx");

// 05:00 SA — before the 06:00 release → pickable now.
const RELEASED_AT = "2026-08-07T03:00:00.000Z";
// 07:00 SA — after the 06:00 release → waiting for 14:00.
const WAITING_AT = "2026-08-07T05:00:00.000Z";
const PRODUCTS = [
  { id: "boot", name: "Timberland Premium 6-Inch Wheat", photoUrl: null },
  { id: "cap", name: "New Era 9Forty Navy", photoUrl: null },
];

const textOf = (node) => {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
};
function renderQueue(props = {}) {
  let tree;
  act(() => { tree = TestRenderer.create(<Hub2RefillQueue products={PRODUCTS} dest="hub1" {...props} />); });
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
  updateMock.mockClear();
  perm.permRecord = { stockRole: "warehouse" };
  perm.isSuperAdmin = false;
  paths["refill_requests"] = {
    released1: { productId: "boot", size: "7", qty: 2, requestingLocation: "hub1", status: "open",
                 createdAt: RELEASED_AT, createdFrom: { engine: true, source: "central" } },
    waiting1: { productId: "cap", size: "M", qty: 1, requestingLocation: "hub1", status: "open",
                createdAt: WAITING_AT, createdFrom: { engine: true, source: "central" } },
  };
  paths["stock/central"] = { boot: { 7: { qty: 5 } }, cap: { M: { qty: 5 } } };
  paths["stock/hub1"] = null;                 // nothing covered — both are real work
  paths["refill_engine/open"] = null;
  paths["stock_exceptions/latest"] = null;
  paths["config/refillEngine"] = null;        // absent config → default 06:00/14:00
});

describe("the release gate on the pick queue (defaults, config absent)", () => {
  it("a request raised BEFORE the last release is pickable; one raised AFTER is not", () => {
    const out = renderText();
    expect(out).toContain("Timberland Premium 6-Inch Wheat");   // released → card
    expect(out).not.toContain("New Era 9Forty Navy");           // waiting → no card for staff
    expect(out).toContain("next release 14:00");
    expect(out).toContain("1 waiting behind it");
  });

  it("between windows an empty queue explains itself — never a broken-looking screen", () => {
    delete paths["refill_requests"].released1;                  // only the waiting ask remains
    const out = renderText();
    expect(out).toContain("Nothing to pick right now");
    expect(out).toContain("waiting for the");
    expect(out).toContain("14:00");
    expect(out).not.toContain("No refill requests Central can act on");
  });

  it("staff (non-admin) see the count but NOT the backlog rows or the override", () => {
    const out = renderText();
    expect(out).not.toContain("Release now");
    expect(out).not.toContain("Accumulating");
  });

  it("admin sees the accumulating backlog rows with the urgent override", () => {
    perm.permRecord = { stockRole: "admin" };
    const out = renderText();
    expect(out).toContain("Accumulating");
    expect(out).toContain("New Era 9Forty Navy");               // the waiting row, visible to admin
    expect(out).toContain("Release now");
  });

  it("the urgent override writes earlyRelease {at, by, reason} to that ONE request", async () => {
    perm.permRecord = { stockRole: "admin" };
    vi.stubGlobal("window", { prompt: vi.fn(() => "customer waiting at the counter") });
    const tree = renderQueue();
    const btn = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Release now"));
    expect(btn).toBeTruthy();
    await act(async () => { await btn.props.onClick(); });
    tree.unmount();
    vi.unstubAllGlobals();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [refArg, patch] = updateMock.mock.calls[0];
    expect(refArg.path).toBe("refill_requests/waiting1");
    expect(patch).toEqual({ earlyRelease: { at: "2026-08-07T10:00:00.000Z", by: "u1", reason: "customer waiting at the counter" } });
  });

  it("a cancelled prompt or empty reason releases NOTHING", async () => {
    perm.permRecord = { stockRole: "admin" };
    for (const answer of [null, "", "   "]) {
      vi.stubGlobal("window", { prompt: vi.fn(() => answer) });
      const tree = renderQueue();
      const btn = tree.root.findAll((n) => n.type === "button").find((n) => textOf(n.props.children).includes("Release now"));
      await act(async () => { await btn.props.onClick(); });
      tree.unmount();
      vi.unstubAllGlobals();
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an earlyRelease stamp makes the row pickable for everyone, mid-gap", () => {
    paths["refill_requests"].waiting1.earlyRelease = { at: "x", by: "u9", reason: "urgent" };
    const out = renderText();
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).toContain("nothing waiting");
  });
});

describe("the gate follows /config/refillEngine/releaseWindows, not hardcoded times", () => {
  it("a console-edited single window moves the maths (11:00 SA: released1 in, waiting1 in too)", () => {
    // Last release becomes 11:00 SA (09:00Z): BOTH requests predate it.
    paths["config/refillEngine"] = { releaseWindows: ["11:00"] };
    const out = renderText();
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).toContain("Release windows 11:00 SA");
  });

  it("a later single window (13:00 SA) holds BOTH requests back", () => {
    // Last release becomes YESTERDAY 13:00 SA; both were raised today.
    paths["config/refillEngine"] = { releaseWindows: ["13:00"] };
    const out = renderText();
    expect(out).not.toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("2 waiting behind it");
    expect(out).toContain("next release 13:00");
  });

  it("releaseWindows === false switches batching off — the pre-feature queue", () => {
    paths["config/refillEngine"] = { releaseWindows: false };
    const out = renderText();
    expect(out).toContain("Timberland Premium 6-Inch Wheat");
    expect(out).toContain("New Era 9Forty Navy");
    expect(out).not.toContain("Release windows");
  });
});

describe("a hold is a request row (owner spec 2026-08-08)", () => {
  it("a hold-origin request is badged and names the waiting customer via the join", () => {
    paths["refill_requests"].released1.createdFrom = { manual: true, source: "central", via: "on_hold", orderId: "042", orderDate: "2026-08-07" };
    const holdInfo = new Map([["released1", { orderNumber: "042", customerName: "Ayanda M", ts: "2026-08-07T03:00:00.000Z" }]]);
    const out = renderText({ holdInfoByRequestId: holdInfo });
    expect(out).toContain("CUSTOMER HOLD");
    expect(out).toContain("Customer waiting");
    expect(out).toContain("#042");
    expect(out).toContain("Ayanda M");
  });

  it("the createdFrom.via stamp alone still badges the row when the join has nothing", () => {
    paths["refill_requests"].released1.createdFrom = { manual: true, source: "central", via: "on_hold", orderId: "042", orderDate: "2026-08-07" };
    const out = renderText();
    expect(out).toContain("CUSTOMER HOLD");
    expect(out).toContain("#042");
  });

  it("an engine request shows NO hold marking", () => {
    const out = renderText();
    expect(out).not.toContain("CUSTOMER HOLD");
    expect(out).not.toContain("Customer waiting");
  });

  it("holdRows (the exception tail) renders INSIDE the queue, pickable cards or not", () => {
    const marker = <div>EXCEPTION-HOLD-ROW-MARKER</div>;
    expect(renderText({ holdRows: marker })).toContain("EXCEPTION-HOLD-ROW-MARKER");
    delete paths["refill_requests"].released1;              // queue empty between windows
    expect(renderText({ holdRows: marker })).toContain("EXCEPTION-HOLD-ROW-MARKER");
  });

  it("a waiting hold-origin request is named in the ADMIN backlog too", () => {
    perm.permRecord = { stockRole: "admin" };
    paths["refill_requests"].waiting1.createdFrom = { manual: true, source: "central", via: "on_hold", orderId: "077", orderDate: "2026-08-07" };
    const holdInfo = new Map([["waiting1", { orderNumber: "077", customerName: "Sipho K", ts: WAITING_AT }]]);
    const out = renderText({ holdInfoByRequestId: holdInfo });
    expect(out).toContain("customer hold");
    expect(out).toContain("#077");
    expect(out).toContain("Sipho K");
  });
});

// ─── IN TRANSIT: RECEIVING A CROSS-SECTION MANUAL TRANSFER (31 Oct 2026) ─────
// A person sent Hub 2 → Concrete through transit; the receiver taps Receive.
// The receive must reach the writer flagged `manual: true` with the REAL
// origin as transitFrom — without the flag the wall would refuse Hub 2 →
// Concrete and the units would sit in transit forever.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: () => Promise.resolve({ val: () => null, exists: () => false }),
  update: () => Promise.resolve(),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
const applyMovement = vi.fn(() => Promise.resolve({ ok: true, movementId: "m1" }));
vi.mock("./applyMovement", () => ({ applyMovement: (...a) => applyMovement(...a) }));
let TRANSFER;
const MANUAL = { id: "t1", status: "dispatched", from: "hub2", to: "concrete", reason: "manual",
  createdAt: "2026-10-31T08:00:00.000Z", lines: { p1: { M: 2 } } };
vi.mock("./useStock", () => ({
  useTransfers: () => [TRANSFER],
  useLocations: () => ({}),
  useTransitConfig: () => null,
}));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "store" }, isSuperAdmin: false }) }));
vi.mock("../../device/deviceStamp", () => ({ stampAt: () => ({}) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-10-31T09:00:00.000Z", serverNowMs: () => Date.parse("2026-10-31T09:00:00.000Z") }));

const { default: InTransit } = await import("./InTransit.jsx");

const text = (node) => node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

async function receive(products = [{ id: "p1", name: "Tee" }]) {
  applyMovement.mockClear();
  let tree;
  await act(async () => { tree = TestRenderer.create(<InTransit products={products} actorRole="store" />); });
  const btn = tree.root.findAll((n) => n.type === "button").find((b) => /^Receive into /.test(text(b)));
  await act(async () => { await btn.props.onClick(); });
  return applyMovement.mock.calls.map((c) => c[0]);
}

describe("receiving Hub 2 → Concrete", () => {
  it("a record without reason \"manual\" is received with no flag (the wall judges it as before)", async () => {
    TRANSFER = { ...MANUAL, from: "central", reason: undefined };
    const [mv] = await receive();
    expect(mv).toMatchObject({ type: "transfer_in", to: "concrete", transitFrom: "central" });
    expect(mv).not.toHaveProperty("manual");
  });

  it("hands the writer a transfer_in flagged manual, judged on the real origin", async () => {
    TRANSFER = MANUAL;
    applyMovement.mockClear();
    let tree;
    await act(async () => { tree = TestRenderer.create(<InTransit products={[{ id: "p1", name: "Tee" }]} actorRole="store" />); });
    const btn = tree.root.findAll((n) => n.type === "button").find((b) => /^Receive into /.test(text(b)));
    await act(async () => { await btn.props.onClick(); });
    expect(applyMovement).toHaveBeenCalledTimes(1);
    expect(applyMovement.mock.calls[0][0]).toMatchObject({
      type: "transfer_in", from: "in_transit", to: "concrete", transitFrom: "hub2", productId: "p1", size: "M", qty: 2, manual: true,
    });
  });
});

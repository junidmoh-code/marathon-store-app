// ─── SHIPPING CARD — THE GATE, THE EXACT-PATH READS, AND "BOOKS NOTHING" ─────
//
//   1. A refused viewer reads and writes NOTHING (asserted on the db calls).
//   2. The live switch renders DISABLED with "Enable after measurement", and
//      Save never writes /config/shipping/live — even when it is already true.
//   3. "Test an order" reads ONE order by exact path; a ref that is not a
//      legal key is refused before any read.
//   4. Live quotes are a request + ONE answer listener; the card has no path
//      to anything that books.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {}, location: { hash: "#admin/shipping" },
  isSecureContext: true, scrollY: 0, scrollTo() {}, requestAnimationFrame(fn) { fn(); },
};

let store = {};
const getMock = vi.fn(async (r) => {
  const v = r.path.split("/").reduce((n, k) => (n == null ? n : n[k]), store);
  return { exists: () => v != null, val: () => v ?? null };
});
const updateMock = vi.fn(async () => {});
const setMock = vi.fn(async () => {});
const onValueMock = vi.fn(() => () => {});
const pushMock = vi.fn((r) => ({ path: `${r.path}/req1`, key: "req1" }));

vi.mock("firebase/database", () => ({
  getDatabase: () => ({ fake: true }),
  ref: (_db, path) => ({ path: path || "" }),
  get: (...a) => getMock(...a),
  set: (...a) => setMock(...a),
  update: (...a) => updateMock(...a),
  onValue: (...a) => onValueMock(...a),
  push: (...a) => pushMock(...a),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const ShippingCard = (await import("./ShippingCard.jsx")).default;

const ADMIN = { uid: "a", email: "gunidmoh@gmail.com" };
const STAFF = { uid: "s", email: "rashid@marathon.internal" };

async function render(authUser) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<ShippingCard authUser={authUser} onExit={() => {}} />); });
  return tree;
}
const byLabel = (tree, label) => tree.root.find((n) => n.props?.["aria-label"] === label);
const text = (tree) => JSON.stringify(tree.toJSON());
const button = (tree, label) => tree.root.find((n) => n.type === "button" && n.children.join("") === label);

beforeEach(() => {
  store = {};
  for (const m of [getMock, updateMock, setMock, onValueMock, pushMock]) m.mockClear();
});

describe("ShippingCard gate", () => {
  it("a non-owner reads nothing and writes nothing", async () => {
    const tree = await render(STAFF);
    expect(text(tree)).toContain("account owner only");
    expect(getMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("the owner reads /config/shipping once, by exact path, and opens no subscription", async () => {
    await render(ADMIN);
    expect(getMock.mock.calls.map((c) => c[0].path)).toEqual(["config/shipping"]);
    expect(onValueMock).not.toHaveBeenCalled();
  });
});

describe("the live switch", () => {
  it("is shown disabled with 'Enable after measurement'", async () => {
    const tree = await render(ADMIN);
    const sw = byLabel(tree, "Book real shipments");
    expect(sw.props.disabled).toBe(true);
    expect(text(tree)).toContain("Enable after measurement");
  });

  it("shows the real state but Save never writes `live` — even when it is true", async () => {
    store = { config: { shipping: { live: true, volumetricDivisor: 5000 } } };
    const tree = await render(ADMIN);
    expect(byLabel(tree, "Book real shipments").props.checked).toBe(true);
    await act(async () => { button(tree, "Save").props.onClick(); });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [r, payload] = updateMock.mock.calls[0];
    expect(r.path).toBe("config/shipping");
    expect(payload).not.toHaveProperty("live");
    expect(payload.volumetricDivisor).toBe(5000);
    expect(Object.keys(payload).sort()).toEqual(["boxes", "collectionAddress", "divisorByServiceGroup", "doorServiceCode", "dropBox", "excludeServiceCodes", "items", "volumetricDivisor"]);
  });

  it("every unmeasured seed carries the marker", async () => {
    const tree = await render(ADMIN);
    expect((text(tree).match(/"unmeasured"/g) || []).length).toBeGreaterThanOrEqual(10 + 6 + 1);
  });
});

describe("test an order", () => {
  const ORDER = {
    ref: "W1001",
    lines: [{ category: "Footwear", subcategory: "Sneakers", name: "Runner", size: "9", qty: 1 }],
    shipping: { address: { street: "5 Esplanade Road", suburb: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441" } },
    customer: { name: "A Customer", phone: "0820000000", email: "a@example.com" },
  };

  it("reads ONE order by exact path and shows the computed parcel", async () => {
    store = { online_orders: { W1001: ORDER } };
    const tree = await render(ADMIN);
    await act(async () => { byLabel(tree, "order ref").props.onChange({ target: { value: "W1001" } }); });
    await act(async () => { button(tree, "Read order").props.onClick(); });
    expect(getMock.mock.calls.map((c) => c[0].path)).toEqual(["config/shipping", "online_orders/W1001"]);
    const t = text(tree);
    expect(t).toContain("SHOE");
    expect(t).toContain("L2DM - ECO");
  });

  it("refuses an illegal ref before reading anything", async () => {
    const tree = await render(ADMIN);
    await act(async () => { byLabel(tree, "order ref").props.onChange({ target: { value: "../users" } }); });
    await act(async () => { button(tree, "Read order").props.onClick(); });
    expect(getMock.mock.calls.map((c) => c[0].path)).toEqual(["config/shipping"]);
    expect(text(tree)).toContain("not a valid order ref");
  });

  it("live quotes: one request write, one answer listener, nothing else", async () => {
    store = { online_orders: { W1001: ORDER } };
    const tree = await render(ADMIN);
    await act(async () => { byLabel(tree, "order ref").props.onChange({ target: { value: "W1001" } }); });
    await act(async () => { button(tree, "Read order").props.onClick(); });
    await act(async () => { button(tree, "Get live quotes").props.onClick(); });
    expect(pushMock.mock.calls[0][0].path).toBe("shipping_quotes/requests");
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0][0].path).toBe("shipping_quotes/requests/req1");
    expect(setMock.mock.calls[0][1]).toMatchObject({ ref: "W1001", parcel: { lengthCm: 35, widthCm: 23, heightCm: 14, actualKg: 1.5 } });
    expect(onValueMock.mock.calls.map((c) => c[0].path)).toEqual(["shipping_quotes/answers/req1"]);
  });
});

describe("books nothing", () => {
  it("the card's source has no path to a shipment call", () => {
    const src = readFileSync(new URL("./ShippingCard.jsx", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/createShipment|bookShipment|cancelShipment|courier-client/);
  });
});

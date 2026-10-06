// ─── NETWORK CARD — THE GATE, THE CONFIRMATION, THE PATH ─────────────────────
//   1. A viewer who is not the owner gets no control and both reads disabled.
//   2. A live flip takes a confirmation, then writes that ONE location's flag.
//   3. Going live with nothing confirmed writes nothing.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { normalizeNetwork, seedPayload } from "../../utils/networkRegistry";

const useNetworkMock = vi.fn();
const usePathStateMock = vi.fn();

vi.mock("firebase/database", () => ({ ref: () => ({}), update: vi.fn(async () => true) }));
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));
vi.mock("../../utils/useNetwork", () => ({ useNetwork: (...a) => useNetworkMock(...a) }));
vi.mock("../stock/useStock", () => ({ usePathState: (...a) => usePathStateMock(...a) }));
vi.mock("./useTaxonomy", () => ({
  useTaxonomy: () => ({ registry: { cats: { hoodies: { key: "hoodies", label: "Hoodies", top: "clothing" } }, tops: { clothing: { key: "clothing", label: "Clothing" } } } }),
}));

const Card = (await import("./NetworkSettingsCard.jsx")).default;

const OWNER = { uid: "owner-uid", email: "gunidmoh@gmail.com" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };
const NOW = 1790000000000;

function mount(authUser, { raw = {}, write = vi.fn(async () => true) } = {}) {
  useNetworkMock.mockImplementation(() => ({ registry: normalizeNetwork(raw), settled: true, error: false, raw }));
  usePathStateMock.mockImplementation(() => ({ value: { concrete: {}, "concrete-stockroom": {} }, settled: true, error: false }));
  let tree;
  act(() => {
    tree = TestRenderer.create(<Card authUser={authUser} products={[{ id: "p1", name: "Campus Black" }]} onExit={() => {}} write={write} now={() => NOW} />);
  });
  return { tree, write };
}
const text = (n) => (typeof n === "string" ? n : (n.children || []).map(text).join(""));
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const rowButton = (tree, loc) => tree.root.find((n) => n.props && n.props["data-loc"] === loc).find((n) => n.type === "button");

describe("the gate", () => {
  beforeEach(() => { useNetworkMock.mockReset(); usePathStateMock.mockReset(); });

  it("gives a non-owner no control, and disables both reads", () => {
    const { tree, write } = mount(STAFF);
    expect(useNetworkMock).toHaveBeenCalledWith(false);
    expect(usePathStateMock).toHaveBeenCalledWith("locations", false);
    expect(buttons(tree).map(text)).toEqual(["Back"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("gives no control to a signed-out viewer either", () => {
    const { tree } = mount(null);
    expect(buttons(tree).map(text)).toEqual(["Back"]);
  });

  it("enables the reads for the owner and shows all eight sectioned locations", () => {
    const { tree } = mount(OWNER);
    expect(useNetworkMock).toHaveBeenCalledWith(true);
    const locs = tree.root.findAll((n) => n.props && n.props["data-loc"]).map((n) => n.props["data-loc"]);
    expect(locs).toEqual(["marathon-pe", "trophy", "hub1", "hub2", "marathon-pine", "concrete", "hub3", "concrete-stockroom"]);
    expect(text(rowButton(tree, "hub3"))).toBe("Not live");
    expect(text(rowButton(tree, "hub2"))).toBe("Live");
  });
});

describe("the live switch", () => {
  beforeEach(() => { useNetworkMock.mockReset(); usePathStateMock.mockReset(); });

  it("writes nothing on the first tap — it asks first", () => {
    const { tree, write } = mount(OWNER);
    act(() => rowButton(tree, "hub3").props.onClick());
    expect(write).not.toHaveBeenCalled();
    expect(tree.root.findAll((n) => n.props && n.props.role === "alertdialog")).toHaveLength(1);
  });

  it("writes that one location's flag once confirmed", async () => {
    const { tree, write } = mount(OWNER);
    act(() => rowButton(tree, "hub3").props.onClick());
    const yes = buttons(tree).find((b) => /^Yes, go live/.test(text(b)));
    await act(async () => { yes.props.onClick(); });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({ "network/locations/hub3/live": true, "network/updatedAt": NOW, "network/updatedBy": "owner-uid" });
  });

  it("cancel writes nothing", () => {
    const { tree, write } = mount(OWNER);
    act(() => rowButton(tree, "hub3").props.onClick());
    act(() => buttons(tree).find((b) => text(b) === "Cancel").props.onClick());
    expect(write).not.toHaveBeenCalled();
    expect(tree.root.findAll((n) => n.props && n.props.role === "alertdialog")).toHaveLength(0);
  });

  it("says so when the write is refused, instead of showing it as saved", async () => {
    const write = vi.fn(async () => { throw new Error("PERMISSION_DENIED"); });
    const { tree } = mount(OWNER, { write });
    act(() => rowButton(tree, "hub3").props.onClick());
    await act(async () => { buttons(tree).find((b) => /^Yes, go live/.test(text(b))).props.onClick(); });
    expect(text(tree.root.find((n) => n.props && n.props.role === "status"))).toMatch(/Not saved: PERMISSION_DENIED/);
  });
});

describe("Concrete's mapping and credit scope", () => {
  beforeEach(() => { useNetworkMock.mockReset(); usePathStateMock.mockReset(); });

  it("flips a category to the stockroom with one path", async () => {
    const { tree, write } = mount(OWNER);
    const rowEl = tree.root.find((n) => n.props && n.props["data-cat"] === "hoodies");
    const stockroom = rowEl.findAll((n) => n.type === "button").find((b) => text(b) === "Concrete Stockroom");
    await act(async () => { stockroom.props.onClick(); });
    expect(write.mock.calls[0][0]["network/backStock/concrete/hoodies"]).toBe("concrete-stockroom");
  });

  it("tapping the hub a category is already on writes nothing", async () => {
    const { tree, write } = mount(OWNER);
    const rowEl = tree.root.find((n) => n.props && n.props["data-cat"] === "hoodies");
    await act(async () => { rowEl.findAll((n) => n.type === "button").find((b) => text(b) === "Hub 3").props.onClick(); });
    expect(write).not.toHaveBeenCalled();
  });

  it("sets the credit scope", async () => {
    const { tree, write } = mount(OWNER);
    await act(async () => { buttons(tree).find((b) => text(b) === "Its own section only").props.onClick(); });
    expect(write.mock.calls[0][0]["network/creditScope"]).toBe("section");
  });

  it("offers first-time setup only while something is missing", () => {
    const seeded = mount(OWNER, { raw: seedPayload() });
    expect(buttons(seeded.tree).map(text)).not.toContain("Set up the network");
    // a node that exists but lacks its sections (a flip made before set-up) still needs it
    const partial = mount(OWNER, { raw: { creditScope: "shared", locations: { hub3: { live: true } } } });
    expect(buttons(partial.tree).map(text)).toContain("Set up the network");
    const fresh = mount(OWNER, { raw: null });
    expect(buttons(fresh.tree).map(text)).toContain("Set up the network");
  });
});

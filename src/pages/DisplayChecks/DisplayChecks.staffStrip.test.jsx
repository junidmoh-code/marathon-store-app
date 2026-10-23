// ─── DISPLAY CHECKS — a plain store user sees the Website orders strip ───────
// Run: npx vitest run src/pages/DisplayChecks/DisplayChecks.staffStrip.test.jsx
// The whole module, mounted as store staff (display_checks + destShop, NOT the
// super-admin): website lines sit ONLY in the strip above the stats, never in
// the Outstanding grid — exactly what the super-admin sees for that store.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = window.scrollTo || (() => {});
window.addEventListener = window.addEventListener || (() => {});
window.removeEventListener = window.removeEventListener || (() => {});
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, activeElement: null };

const callMock = vi.fn(async () => ({ data: { ok: true } }));
let perm = null;
let feed = null;
vi.mock("../../firebase", () => ({ functions: {}, database: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callMock(...a) }));
vi.mock("firebase/database", () => ({ getDatabase: () => ({}), ref: (_d, p) => ({ path: p }), get: async () => ({ val: () => null }) }));
vi.mock("../../components/PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com", usePermissions: () => perm }));
vi.mock("./useDisplayChecks", () => ({ useTodayFeedSources: (store) => ({ ...feed, store }) }));
vi.mock("./AvailabilityView", () => ({ default: () => null }));
vi.mock("./AnalyticsView", () => ({ default: () => null }));
vi.mock("./SettingsView", () => ({ default: () => null }));
vi.mock("./StyleCodeCapture", () => ({ default: () => null }));
vi.mock("../../config/displayChecks", async (orig) => ({
  ...(await orig()),
  primeDisplayCheckSwitches: async () => ({}),
  currentDisplayCheckSwitches: () => ({ "marathon-pe": true, trophy: true }),
}));

const { default: DisplayChecks } = await import("./index.jsx");
const { default: CheckCard } = await import("./CheckCard.jsx");

// The live shape: website rows are online__ keys with kind online_pick; the
// ordinary display checks have no kind at all.
const WEB = [
  { key: "online__18962474533013__1", checkId: "-W1", kind: "online_pick", status: "open", productId: "p1", productName: "Lacoste cap", size: "_", qty: 1, ref: "#1772", orderNumber: 1772, orderId: "18962474533013", lineIndex: 1, createdAt: 1792645985732 },
  { key: "online__18964392018069__3", checkId: "-W2", kind: "online_pick", status: "open", productId: "p2", productName: "Giorgio Armani acquadi perfume", size: "_", qty: 1, ref: "#1776", orderNumber: 1776, orderId: "18964392018069", lineIndex: 3, createdAt: 1792739690369 },
];
const CHECKS = [
  { key: "p1780473234474__L", checkId: "-C1", status: "open", productId: "p1780473234474", productName: "Nike Tech Fleece Black", size: "L", createdAt: 1792740902587 },
  { key: "p1782135474784__L", checkId: "-C2", status: "open", productId: "p1782135474784", productName: "BALR White T-Shirt", size: "L", createdAt: 1792581715016 },
];

const STAFF = { user: { uid: "u-staff", email: "asanda@marathon.internal" }, permRecord: { permissions: ["display_checks"], destShop: "marathon-pe", displayName: "Asanda" } };
const OWNER = { user: { uid: "u-owner", email: "gunidmoh@gmail.com" }, permRecord: { permissions: [], destShop: null, displayName: "Junid" } };

const byTestId = (tree, id) => tree.root.findAll((n) => n.props?.["data-testid"] === id);
const gridChecks = (tree) => tree.root.findAllByType(CheckCard).filter((n) => n.props.variant === "outstanding").map((n) => n.props.check.key);
const stripKeys = (tree) => tree.root.findAll((n) => n.props?.["data-testid"] === "web-strip")
  .flatMap((s) => s.findAll((n) => n.props?.row?.key).map((n) => n.props.row.key));

async function mount(who) {
  perm = who;
  let tree;
  await act(async () => { tree = TestRenderer.create(<DisplayChecks onExit={() => {}} products={[]} />); });
  return tree;
}

beforeEach(() => {
  callMock.mockClear();
  feed = { activeItems: [...CHECKS.slice(0, 1), ...WEB, ...CHECKS.slice(1)], completedItems: [], ready: true, error: null, saDate: "2026-10-23" };
});

describe("Display Checks as a plain store user", () => {
  it("puts website lines in the strip and never in the Outstanding grid", async () => {
    const tree = await mount(STAFF);
    expect(byTestId(tree, "web-strip")).toHaveLength(1);
    expect(byTestId(tree, "web-count")[0].props.children).toBe(2);
    expect(new Set(stripKeys(tree))).toEqual(new Set(WEB.map((r) => r.key)));
    expect(gridChecks(tree).sort()).toEqual(CHECKS.map((r) => r.key).sort());
    for (const k of WEB.map((r) => r.key)) expect(gridChecks(tree)).not.toContain(k);
  });

  it("gives staff the same Handed over / Not found buttons, through the same locked callable", async () => {
    const tree = await mount(STAFF);
    expect(byTestId(tree, "web-handed")).toHaveLength(2);
    expect(byTestId(tree, "web-notfound")).toHaveLength(2);
    await act(async () => { byTestId(tree, "web-handed")[0].props.onClick(); });
    expect(callMock).toHaveBeenCalledWith(expect.objectContaining({ store: "marathon-pe", result: "handed", override: false }));
  });

  it("shows staff exactly what the super-admin sees for that store", async () => {
    const staff = await mount(STAFF);
    const owner = await mount(OWNER);
    expect(stripKeys(staff)).toEqual(stripKeys(owner));
    expect(gridChecks(staff)).toEqual(gridChecks(owner));
  });
});

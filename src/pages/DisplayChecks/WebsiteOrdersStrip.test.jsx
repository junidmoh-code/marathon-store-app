// ─── DISPLAY CHECKS — the "Website orders" strip ─────────────────────────────
// Top of the Today tab, this store's website rows only, red count, hidden at
// zero; Handed over / Not found go through completeDisplayCheck (the same locks).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, activeElement: null };

const callMock = vi.fn(async () => ({ data: { ok: true } }));
const getMock = vi.fn(async () => ({ val: () => null }));
vi.mock("../../firebase", () => ({ functions: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callMock(...a) }));
vi.mock("firebase/database", () => ({ getDatabase: () => ({}), ref: (_d, p) => ({ path: p }), get: (...a) => getMock(...a) }));
vi.mock("./StyleCodeCapture", () => ({ default: () => null }));

const { default: WebsiteOrdersStrip } = await import("./WebsiteOrdersStrip.jsx");
const { default: TodayView } = await import("./TodayView.jsx");

const strings = (c) => (c == null || typeof c === "boolean" ? "" : Array.isArray(c) ? c.map(strings).join("") : typeof c === "object" ? strings(c.props?.children) : String(c));
const all = (tree) => JSON.stringify(tree.toJSON());
const byTestId = (tree, id) => tree.root.findAll((n) => n.props?.["data-testid"] === id);

const ROW = { key: "online__9__0", checkId: "C1", productId: "p9", productName: "Lacoste golf t shirt", size: "XL", qty: 1, status: "open",
              kind: "online_pick", ref: "KQZ", orderId: "9", lineIndex: 0, photoUrl: "https://x/p.jpg" };
const CHECK = { key: "-Ncheck", checkId: "C2", productId: "p1", productName: "Boss Tee", size: "M", status: "open", kind: "clothing" };

beforeEach(() => { callMock.mockClear(); getMock.mockReset(); getMock.mockResolvedValue({ val: () => null }); });

async function renderStrip(rows) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<WebsiteOrdersStrip store="marathon-pe" rows={rows} />); });
  return tree;
}

describe("Website orders strip", () => {
  it("is hidden when nothing is waiting", async () => {
    expect((await renderStrip([])).toJSON()).toBeNull();
  });

  it("shows photo, name, size, qty, the order code and the default handover words, with a red count", async () => {
    const tree = await renderStrip([ROW]);
    const t = all(tree);
    expect(t).toContain("Website orders");
    expect(strings(byTestId(tree, "web-count")[0].props.children)).toBe("1");
    for (const s of ["Lacoste golf t shirt", "SIZE ", "XL", "QTY ", "KQZ", "Pull and give to Till 2", "https://x/p.jpg"]) expect(t).toContain(s);
    expect(getMock.mock.calls[0][0].path).toBe("config/onlineOrders/handoverText");
  });

  it("uses /config/onlineOrders/handoverText when set", async () => {
    getMock.mockResolvedValue({ val: () => "Give to Yasmin" });
    const tree = await renderStrip([ROW]);
    await act(async () => {});
    expect(all(tree)).toContain("Pull and give to Yasmin");
  });

  it("Handed over → completeDisplayCheck(handed) for THIS row", async () => {
    const tree = await renderStrip([ROW]);
    await act(async () => { byTestId(tree, "web-handed")[0].props.onClick(); });
    expect(callMock).toHaveBeenCalledWith({ store: "marathon-pe", key: "online__9__0", checkId: "C1", result: "handed", override: false });
  });

  it("Not found takes two taps, then completeDisplayCheck(not_found)", async () => {
    const tree = await renderStrip([ROW]);
    await act(async () => { byTestId(tree, "web-notfound")[0].props.onClick(); });
    expect(callMock).not.toHaveBeenCalled();
    await act(async () => { byTestId(tree, "web-notfound")[0].props.onClick(); });
    expect(callMock).toHaveBeenCalledWith(expect.objectContaining({ result: "not_found", key: "online__9__0" }));
  });

  it("a refused verdict (stale-check) is shown, not swallowed", async () => {
    callMock.mockRejectedValueOnce(Object.assign(new Error("stale-check"), { code: "failed-precondition" }));
    const tree = await renderStrip([ROW]);
    await act(async () => { byTestId(tree, "web-handed")[0].props.onClick(); });
    expect(all(tree)).toContain("stale-check");
  });
});

describe("TodayView: the strip sits on top and website rows leave the grid", () => {
  it("renders the strip before the stats and the grid holds only display checks", async () => {
    let tree;
    await act(async () => {
      tree = TestRenderer.create(<TodayView store="marathon-pe" active activeItems={[ROW, CHECK]} completedItems={[]} ready error={null} products={[]} />);
    });
    const t = all(tree);
    expect(t.indexOf("Website orders")).toBeGreaterThan(-1);
    expect(t.indexOf("Website orders")).toBeLessThan(t.indexOf("Completion"));
    expect(byTestId(tree, "web-row")).toHaveLength(1);
    expect(t).toContain("OUTSTANDING");
    expect(t).toMatch(/"\(","1",""\)"|\(1\)|"1"/); // the grid counts 1 (the display check), not 2
  });
});

// ─── ONE PRODUCT'S DISPLAY HISTORY — clause 6's "from the product" surface ───
//
// This screen had no test at all, and it is the one that changed from a
// whole-node subscription to keyed per-store reads. What a test has to hold
// here is not the markup but the READ SHAPE: that it asks for paths naming the
// product, that it never asks for the node, and that it still settles — with
// the right empty line — when a product has no history or a store refuses.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";

let READS = [];
let DB = {};              // path → value, or a thrown Error
const get = vi.fn(async (path) => {
  READS.push(path);
  const v = DB[path];
  if (v instanceof Error) throw v;
  return { val: () => (v === undefined ? null : v) };
});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => path,
  get: (path) => get(path),
}));
vi.mock("../../firebase", () => ({ database: {} }));

const ProductDisplayHistory = (await import("./ProductDisplayHistory")).default;

const row = (o = {}) => ({
  rowId: "r1", store: "marathon-pe", productId: "p1", productName: "Air Force 1",
  size: "9", sizeKey: "9", bookedHub: "hub1", status: "open",
  openedAt: "2026-09-01T10:00:00.000Z", openedBy: "u1", openedVia: "send",
  events: { "opened|2026-09-01T10:00:00.000Z": { at: "2026-09-01T10:00:00.000Z", what: "sent", by: "u1", detail: { size: "9" } } },
  ...o,
});

const text = (t) => {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false) return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.children) n.children.forEach(walk);
  };
  walk(t.toJSON());
  return out.join(" ");
};

const render = async (props) => {
  let t;
  await act(async () => { t = create(<ProductDisplayHistory {...props} />); });
  await act(async () => {});
  return t;
};

beforeEach(() => { READS = []; DB = {}; get.mockClear(); });

describe("it reads this product's rows, and never the node", () => {
  it("asks for one path per display store, each naming the product", async () => {
    DB["settings/displayRows/marathon-pe/p1"] = { r1: row() };
    await render({ productId: "p1" });
    expect(READS.sort()).toEqual([
      "settings/displayRows/marathon-pe/p1",
      "settings/displayRows/trophy/p1",
    ]);
    // The whole-node read this screen used to do. If it comes back, the cost
    // grows with every closed row forever — displayRows never deletes one.
    expect(READS).not.toContain("settings/displayRows");
  });

  it("shows the open row, its store, its size and its timeline", async () => {
    DB["settings/displayRows/trophy/p1"] = { r1: row({ store: "trophy" }) };
    const t = await render({ productId: "p1" });
    const s = text(t);
    expect(s).toMatch(/On display now/);
    expect(s).toMatch(/size\s+9/);
    expect(s).toMatch(/Display history/);
  });

  it("gathers rows from BOTH stores into one list", async () => {
    DB["settings/displayRows/marathon-pe/p1"] = { r1: row() };
    DB["settings/displayRows/trophy/p1"] = { r2: row({ rowId: "r2", store: "trophy", size: "10", sizeKey: "10" }) };
    const t = await render({ productId: "p1" });
    const s = text(t);
    expect(s).toMatch(/size\s+9/);
    expect(s).toMatch(/size\s+10/);
  });

  it("a closed row reads as closed, with its reason", async () => {
    DB["settings/displayRows/marathon-pe/p1"] = {
      r1: row({ status: "closed", closedAt: "2026-09-05T08:00:00.000Z", closedReason: "sold" }),
    };
    const t = await render({ productId: "p1" });
    expect(text(t)).toMatch(/Closed/);
    expect(text(t)).not.toMatch(/On display now/);
  });
});

describe("it settles, and says the true thing when there is nothing", () => {
  it("no history anywhere → the 'never been on a wall' line, not Loading", async () => {
    const t = await render({ productId: "p1" });
    expect(text(t)).toMatch(/never been registered on a shop's display wall/);
    expect(text(t)).not.toMatch(/Loading/);
  });

  it("one store refusing does not hide the other's rows, and still settles", async () => {
    DB["settings/displayRows/marathon-pe/p1"] = new Error("permission_denied");
    DB["settings/displayRows/trophy/p1"] = { r1: row({ store: "trophy" }) };
    const t = await render({ productId: "p1" });
    expect(text(t)).toMatch(/On display now/);
    expect(text(t)).not.toMatch(/Loading/);
  });

  it("no product selected → nothing rendered and nothing read", async () => {
    const t = await render({ productId: null });
    expect(t.toJSON()).toBe(null);
    expect(READS).toEqual([]);
  });

  it("a product id that cannot be an RTDB key reads NOTHING rather than some other path", async () => {
    // `p/1` would otherwise build settings/displayRows/marathon-pe/p/1 — a path
    // belonging to a different product entirely. rowSegment refuses it.
    await render({ productId: "p/1" });
    expect(READS).toEqual([]);
  });
});

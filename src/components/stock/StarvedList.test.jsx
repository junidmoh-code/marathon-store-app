// ─── THE STARVED CARD, RENDERED FOR REAL ─────────────────────────────────────
// The engine half is pinned in functions/test/starved-list.test.cjs. This is the
// half a person actually meets: what the row SAYS, and what Introduce WRITES.
//
// The row's sentence is tested as hard as the write, because the card's whole job is
// to make a silent refusal legible. A row that lists a shop without explaining why it
// was refused sends someone to introduce a line whose stock was deliberately sent
// back — and "k 4 / u 4" versus "no record at all" is the difference.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const gets = {};
const updateMock = vi.fn(() => Promise.resolve());
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u9" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-18T12:00:00.000Z" }));

const { default: StarvedList, evidenceLine } = await import("./StarvedList.jsx");

const TEE = "p_tee";
const byId = new Map([[TEE, { id: TEE, name: "A tee", sizes: ["S", "M"], photoUrl: "" }]]);
const row = (over = {}) => ({
  loc: "marathon-pe", pid: TEE, name: "A tee", category: "t-shirts",
  held: 0, sold: 4, openLines: 0, why: ["sold"], excluded: false,
  s: 0, k: 0, u: 0, hasRecord: false, ...over,
});

const render = (rows, { canAct = true } = {}) => {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <StarvedList rows={rows} byId={byId} canAct={canAct} sizesFor={(pid) => (byId.get(pid)?.sizes || [])} />
    );
  });
  return tree;
};
const textOf = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const introduceBtn = (tree) => buttons(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && c.startsWith("Introduce")));

beforeEach(() => {
  updateMock.mockClear();
  for (const k of Object.keys(gets)) delete gets[k];
});

describe("evidenceLine — the sentence is the point of the card", () => {
  it("no record at all reads as exactly that", () => {
    expect(evidenceLine(row())).toContain("no stock history at all for this shop");
    expect(evidenceLine(row())).toContain("sold 4 here");
  });

  it("stocked-then-undone is NOT reported as 'never heard of it'", () => {
    // The two Lacoste sweatshirts. Introducing is probably WRONG here — the units
    // went back for a reason — so the row must not read like a missing record.
    const line = evidenceLine(row({ hasRecord: true, k: 4, u: 4, sold: 0, held: 2, why: ["holds"] }));
    expect(line).toContain("stocked 4 and took 4 back");
    expect(line).not.toContain("no stock history at all");
  });

  it("names every piece of evidence it has", () => {
    const line = evidenceLine(row({ held: 3, sold: 4, openLines: 2, why: ["sold", "holds", "asked"] }));
    expect(line).toContain("sold 4");
    expect(line).toContain("3 units on the shelf");
    expect(line).toContain("2 open refill lines");
  });
});

describe("the card", () => {
  it("says nothing is starved when the list is empty — a green resting state", () => {
    expect(textOf(render([]))).toMatch(/Nothing starved/);
  });

  it("renders one row per shop, grouped under the product", () => {
    const t = render([row(), row({ loc: "trophy", held: 2, sold: 0, why: ["holds"] })]);
    const txt = textOf(t);
    expect(txt).toMatch(/Marathon PE/);
    expect(txt).toMatch(/Trophy/);
    expect(buttons(t).filter((b) => (b.children || []).includes("Introduce"))).toHaveLength(2);
  });

  it("flags a deliberately excluded shop instead of hiding it", () => {
    expect(textOf(render([row({ excluded: true })]))).toMatch(/deliberately excluded here/);
  });

  it("warns that till sales may not reach the history", () => {
    // The POS is a separate writer and does not increment `s`. Someone reading this
    // card has to know that before concluding the shop never sold the line.
    expect(textOf(render([row()]))).toMatch(/till do not always reach the history/);
  });
});

describe("Introduce", () => {
  it("writes introduce-only rows for every declared size, and NO target", async () => {
    const t = render([row()]);
    await act(async () => { introduceBtn(t).props.onClick(); });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][1];
    const keys = Object.keys(payload).sort();
    expect(keys).toContain(`stock_targets/marathon-pe/${TEE}/S/introduce`);
    expect(keys).toContain(`stock_targets/marathon-pe/${TEE}/M/introduce`);
    expect(payload[`stock_targets/marathon-pe/${TEE}/S/introduce`]).toBe(true);
    // A numeric target would pin the quantities and outrank the size run forever.
    expect(keys.some((k) => k.endsWith("/target") || k.endsWith("/minQty"))).toBe(false);
    // Attributable, and it says where it came from.
    expect(payload[`stock_targets/marathon-pe/${TEE}/S/introducedBy`]).toBe("u9");
    expect(payload[`stock_targets/marathon-pe/${TEE}/S/note`]).toMatch(/Starved list/);
    expect(textOf(t)).toMatch(/Introduced at Marathon PE/);
  });

  it("touches only the shop on the row", async () => {
    const t = render([row(), row({ loc: "trophy" })]);
    await act(async () => { introduceBtn(t).props.onClick(); });
    const keys = Object.keys(updateMock.mock.calls[0][1]);
    expect(keys.every((k) => k.startsWith("stock_targets/marathon-pe/"))).toBe(true);
  });

  it("RE-READS first and writes nothing if the pair was introduced since the scan", async () => {
    // This card renders a snapshot up to 15 minutes old. Writing over a row somebody
    // else created in that window would claim their decision as ours.
    gets[`stock_targets/marathon-pe/${TEE}`] = { M: { introduce: true, introducedBy: "someone-else" } };
    const t = render([row()]);
    await act(async () => { introduceBtn(t).props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t)).toMatch(/Already introduced here/);
  });

  it("refuses a product with no declared sizes rather than writing an empty update", async () => {
    byId.set("p_nosize", { id: "p_nosize", name: "Sizeless", sizes: [] });
    const t = render([row({ pid: "p_nosize" })]);
    await act(async () => { introduceBtn(t).props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t)).toMatch(/declares no sizes/);
    byId.delete("p_nosize");
  });

  it("surfaces a failed write instead of showing success", async () => {
    updateMock.mockImplementationOnce(() => Promise.reject(new Error("permission denied")));
    const t = render([row()]);
    await act(async () => { introduceBtn(t).props.onClick(); });
    const txt = textOf(t);
    expect(txt).toMatch(/Couldn't introduce/);
    expect(txt).toMatch(/nothing changed/);
    // ⚠ This is the path that fires until the widened /stock_targets rule is
    // published — an introduce-only row is refused for every client until then. It
    // must read as a refusal, never as a success.
  });

  it("is disabled without permission", () => {
    const t = render([row()], { canAct: false });
    expect(introduceBtn(t).props.disabled).toBe(true);
  });
});

// ─── WIRING GATES — a standing card, not a component nobody can reach ────────
// The owner's requirement was explicitly "a permanent card, not a one-off script".
// A component that exists but is not reachable from the Health grid satisfies the
// diff and not the requirement, so the route is pinned here. (House idiom — see
// solveUndo.gate.test.js, hiddenProducts.gate.test.js.)
describe("the card is reachable and standing", () => {
  const HEALTH = readFileSync(join(here, "HealthView.jsx"), "utf8");

  it("has a StatCard in the grid that opens it", () => {
    expect(HEALTH).toMatch(/<StatCard label="Starved" value=\{count\("starved"\)\}/);
    expect(HEALTH).toMatch(/onClick=\{\(\) => setScreen\("starved"\)\}/);
  });

  it("turns RED on one, because one wrong refusal never self-corrects", () => {
    expect(HEALTH).toMatch(/tone=\{count\("starved"\) \? RED : GREEN\}/);
  });

  it("renders the real component from the scan's exceptions", () => {
    expect(HEALTH).toMatch(/case "starved":/);
    expect(HEALTH).toMatch(/<StarvedList rows=\{ex\.starved\?\.items \|\| \[\]\}/);
    expect(HEALTH).toMatch(/import StarvedList from ".\/StarvedList"/);
  });

  it("lets store and warehouse introduce, not admins only", () => {
    // The people who see an empty shelf are the ones who must be able to fix it,
    // and it is the same set the widened /stock_targets rule grants an
    // introduce-only write to.
    expect(HEALTH).toMatch(/canAct=\{\["store", "warehouse", "admin"\]\.includes\(actorRole\)\}/);
  });
});

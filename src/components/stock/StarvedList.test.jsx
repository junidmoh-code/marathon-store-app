// ─── THE STARVED CARD, RENDERED FOR REAL ─────────────────────────────────────
// The engine half is pinned in functions/test/starved-list.test.cjs. This is the
// half a person actually meets: what the row SAYS, and what Introduce WRITES.
//
// The row's sentence is tested as hard as the write, because the card's whole job is
// to make a silent refusal legible. A row that lists a shop without explaining why it
// was refused sends someone to introduce a line whose stock was deliberately sent
// back — and "k 4 / u 4" versus "no record at all" is the difference.
//
// Introduce is a TWO-PRESS action since the adversarial review: the first press
// shows the consequence (the run it opens), the second commits, and a committed
// introduce keeps an Undo. One uncontemplated tap on a stray collection cell was
// the 2026-08-17 incident manufactured from a red card.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const gets = {};
const paths = {};
const updateMock = vi.fn(() => Promise.resolve());
const txnLog = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  update: (...a) => updateMock(...a),
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  runTransaction: (r, fn) => {
    const cur = gets[r.path] ?? null;
    const next = fn(cur);
    const committed = next !== undefined;
    if (committed) { txnLog.push(r.path); if (next === null) delete gets[r.path]; else gets[r.path] = next; }
    return Promise.resolve({ committed });
  },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u9" } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u9" }); return () => {}; } }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-18T12:00:00.000Z", serverNowMs: () => Date.parse("2026-08-18T12:00:00.000Z") }));

const { default: StarvedList, evidenceLine } = await import("./StarvedList.jsx");

const TEE = "p_tee";
const byId = new Map([[TEE, { id: TEE, name: "A tee", sizes: ["S", "M"], photoUrl: "" }]]);
// The DIETED payload shape: zero-valued fields are omitted, `rec: 1` marks an
// existing index record, name/category are the client's catalogue lookup.
const row = (over = {}) => ({ loc: "marathon-pe", pid: TEE, sold: 4, why: ["sold"], ...over });

const render = (rows, { canAct = true, total = 0 } = {}) => {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <StarvedList rows={rows} total={total} byId={byId} canAct={canAct} sizesFor={(pid) => (byId.get(pid)?.sizes || [])} />
    );
  });
  return tree;
};
const textOf = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
const introduceBtn = (tree) => buttons(tree).find((b) => (b.children || []).some((c) => typeof c === "string" && (c.startsWith("Introduce") || c.startsWith("Press again"))));
const pressTwice = async (tree) => {
  await act(async () => { introduceBtn(tree).props.onClick(); });
  await act(async () => { introduceBtn(tree).props.onClick(); });
};

beforeEach(() => {
  updateMock.mockClear();
  txnLog.length = 0;
  for (const k of Object.keys(gets)) delete gets[k];
  for (const k of Object.keys(paths)) delete paths[k];
  paths["config/refillEngine"] = { defaultRunByStore: { "marathon-pe": { S: 2, M: 2, L: 2, XL: 1, XXL: 1, XXXL: 1 } } };
});

describe("evidenceLine — the sentence is the point of the card", () => {
  it("no record at all reads as exactly that", () => {
    expect(evidenceLine(row())).toContain("no stock history at all for this shop");
    expect(evidenceLine(row())).toContain("sold 4 here");
  });

  it("stocked-then-undone is NOT reported as 'never heard of it'", () => {
    // The two Lacoste sweatshirts. Introducing is probably WRONG here — the units
    // went back for a reason — so the row must not read like a missing record.
    const line = evidenceLine(row({ rec: 1, k: 4, u: 4, sold: undefined, held: 2, why: ["holds"] }));
    expect(line).toContain("stocked 4 and took 4 back");
    expect(line).not.toContain("no stock history at all");
  });

  it("names every piece of evidence it has, and never prints a negative net", () => {
    const line = evidenceLine(row({ held: 3, sold: 4, openLines: 2, why: ["sold", "holds", "asked"] }));
    expect(line).toContain("sold 4");
    expect(line).toContain("3 units on the shelf");
    expect(line).toContain("2 open refill lines");
    // {u:3} with no k must clamp to 0, not read "-3 net units". (Review, PR #383.)
    expect(evidenceLine(row({ rec: 1, u: 3 }))).toContain("nets to 0");
  });
});

describe("the card", () => {
  it("says nothing is starved when the list is empty — a green resting state", () => {
    expect(textOf(render([]))).toMatch(/Nothing starved/);
  });

  it("renders one row per shop, grouped under the product", () => {
    const t = render([row(), row({ loc: "trophy", held: 2, sold: undefined, why: ["holds"] })]);
    const txt = textOf(t);
    expect(txt).toMatch(/Marathon PE/);
    expect(txt).toMatch(/Trophy/);
    expect(buttons(t).filter((b) => (b.children || []).includes("Introduce"))).toHaveLength(2);
  });

  it("an excluded shop is shown in its own quiet section, with NO Introduce button", () => {
    // Introducing over target-0 rows would silence this card while the zero rows
    // keep outranking everything — the shelf starves on, reported as fixed — and
    // would turn the documented off-switch (delete the zero row) into an arming
    // action. (Adversarial review, PR #383.)
    const t = render([row({ excluded: true, held: 2, why: ["holds"] })]);
    const txt = textOf(t);
    expect(txt).toMatch(/deliberately excluded here/);
    expect(txt).toMatch(/Standing exclusions with contrary evidence/);
    expect(introduceBtn(t)).toBeUndefined();
  });

  it("warns that till sales may not reach the history", () => {
    // The POS is a separate writer and does not increment `s`. Someone reading this
    // card has to know that before concluding the shop never sold the line.
    expect(textOf(render([row()]))).toMatch(/till do not always reach the history/);
  });

  it("says when it is showing a capped slice, instead of implying completeness", () => {
    expect(textOf(render([row()], { total: 340 }))).toMatch(/Showing the worst 1 of 340/);
  });
});

describe("Introduce — two presses, and the consequence in between", () => {
  it("the FIRST press writes nothing and shows the run it would open", async () => {
    const t = render([row()]);
    await act(async () => { introduceBtn(t).props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
    const txt = textOf(t);
    expect(txt).toMatch(/standing decision/);
    expect(txt).toMatch(/2 sizes/);
    expect(txt).toMatch(/~4 units/);              // S:2 + M:2 from the run
    expect(txt).toMatch(/do NOT introduce/);      // the stray-cell warning
  });

  it("the SECOND press writes whole introduce-only rows for every declared size, and NO target", async () => {
    const t = render([row()]);
    await pressTwice(t);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0][1];
    const keys = Object.keys(payload).sort();
    // WHOLE ROWS — the $size-level .validate only runs when $size is the write
    // path (introduceUpdates' contract, PR #381).
    expect(keys).toEqual([
      `stock_targets/marathon-pe/${TEE}/M`,
      `stock_targets/marathon-pe/${TEE}/S`,
    ]);
    const written = payload[`stock_targets/marathon-pe/${TEE}/S`];
    expect(written.introduce).toBe(true);
    expect("target" in written).toBe(false);
    expect(written.introducedBy).toBe("u9");
    expect(written.note).toMatch(/Starved list/);
    expect(textOf(t)).toMatch(/Introduced at Marathon PE/);
  });

  it("touches only the shop on the row", async () => {
    const t = render([row(), row({ loc: "trophy" })]);
    await pressTwice(t);
    const keys = Object.keys(updateMock.mock.calls[0][1]);
    expect(keys.every((k) => k.startsWith("stock_targets/marathon-pe/"))).toBe(true);
  });

  it("RE-READS first and writes nothing if the pair was introduced since the scan", async () => {
    gets[`stock_targets/marathon-pe/${TEE}`] = { M: { introduce: true, introducedBy: "someone-else" } };
    const t = render([row()]);
    await pressTwice(t);
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t)).toMatch(/Already introduced here/);
  });

  it("RE-READS catch a NUMERIC row too — managing and excluded both refuse", async () => {
    // The comment always promised this; the code only checked introduce:true.
    // (Review finding 6, PR #383.)
    gets[`stock_targets/marathon-pe/${TEE}`] = { M: { target: 3, minQty: 1 } };
    const t = render([row()]);
    await pressTwice(t);
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t)).toMatch(/already manages this here/);

    gets[`stock_targets/marathon-pe/${TEE}`] = { M: { target: 0, minQty: 0 } };
    const t2 = render([row()]);
    await pressTwice(t2);
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t2)).toMatch(/deliberately excluded/);
  });

  it("refuses a product with no declared sizes rather than writing an empty update", async () => {
    byId.set("p_nosize", { id: "p_nosize", name: "Sizeless", sizes: [] });
    const t = render([row({ pid: "p_nosize" })]);
    await pressTwice(t);
    expect(updateMock).not.toHaveBeenCalled();
    expect(textOf(t)).toMatch(/declares no sizes/);
    byId.delete("p_nosize");
  });

  it("surfaces a rule refusal as the RULE'S refusal, not a retry loop", async () => {
    updateMock.mockImplementationOnce(() => Promise.reject(new Error("permission denied")));
    const t = render([row()]);
    await pressTwice(t);
    const txt = textOf(t);
    // ⚠ This is the path that fires until the widened /stock_targets rule is
    // published. It must read as a refusal with a way forward, never a success
    // and never bare "retry".
    expect(txt).toMatch(/hasn't been published/);
    expect(txt).toMatch(/Nothing changed/);
  });

  it("a committed introduce can be UNDONE — by CAS on its own stamp", async () => {
    const t = render([row()]);
    await pressTwice(t);
    // Mirror the write into the mock store so the undo's CAS can see it.
    const payload = updateMock.mock.calls[0][1];
    for (const [k, v] of Object.entries(payload)) gets[k] = v;
    // One row acquires a target in the meantime — somebody's deliberate act.
    gets[`stock_targets/marathon-pe/${TEE}/M`] = { ...gets[`stock_targets/marathon-pe/${TEE}/M`], target: 5 };

    const undoBtn = buttons(t).find((b) => (b.children || []).includes("Undo"));
    expect(undoBtn).toBeTruthy();
    await act(async () => { undoBtn.props.onClick(); });

    expect(gets[`stock_targets/marathon-pe/${TEE}/S`]).toBeUndefined();       // ours — removed
    expect(gets[`stock_targets/marathon-pe/${TEE}/M`].target).toBe(5);        // theirs — stands whole
    expect(textOf(t)).toMatch(/1 row someone has edited since/);
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
    expect(HEALTH).toMatch(/<StatCard label="Starved" value=\{ex\.starved\?\.active \?\? count\("starved"\)\}/);
    expect(HEALTH).toMatch(/onClick=\{\(\) => setScreen\("starved"\)\}/);
  });

  it("turns RED on one ACTIVE row, AMBER when only standing exclusions remain", () => {
    // Excluded rows have no exit (the engine will never refill them, provenance
    // will never grow), so counting them red would leave the tile permanently lit
    // and train everyone to ignore it. (Adversarial review, PR #383.)
    expect(HEALTH).toMatch(/tone=\{\(ex\.starved\?\.active \?\? count\("starved"\)\) \? RED : count\("starved"\) \? AMBER : GREEN\}/);
  });

  it("renders the real component from the scan's exceptions", () => {
    expect(HEALTH).toMatch(/case "starved":/);
    expect(HEALTH).toMatch(/<StarvedList rows=\{ex\.starved\?\.items \|\| \[\]\} total=\{count\("starved"\)\}/);
    expect(HEALTH).toMatch(/import StarvedList from ".\/StarvedList"/);
  });

  it("lets store and warehouse introduce, not admins only", () => {
    // The people who see an empty shelf are the ones who must be able to fix it,
    // and it is the same set the widened /stock_targets rule grants an
    // introduce-only write to.
    expect(HEALTH).toMatch(/canAct=\{\["store", "warehouse", "admin"\]\.includes\(actorRole\)\}/);
  });
});

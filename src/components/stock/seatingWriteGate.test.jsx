// ─── THE SEATING TAB'S WRITES ARE NOT THE CALLABLE'S ─────────────────────────
// Every other change on the Engine Policy card goes through setCategoryPolicy,
// which writes with the Admin SDK — so the `engine_policy` permission alone is
// enough for it. Switch off / Move and switch off / Re-seat do NOT: they write
// /stock_targets and /stock straight from the browser, and the live rules ask
// for stockRole 'admin' on the first and a stockRole on the second.
//
// So a grantee without a stockRole would have worked happily through every
// category and then collected a raw PERMISSION_DENIED on the first seating tap.
// This pins the fix: the buttons ask the same question the rules ask, BEFORE
// the confirm press, and say so in words. (Fable spec review, PR #469.)
//
// MC — the person this permission was created for — already holds stockRole
// 'admin' from the Shopify Publishing grant, so he never meets the refusal.
// That is precisely why it is tested rather than left to be found.
//
// Run: npx vitest run src/components/stock/seatingWriteGate.test.jsx

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};

vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));
vi.mock("firebase/database", () => ({ ref: () => ({}), get: async () => ({ exists: () => false, val: () => null }), update: async () => {} }));

// The PLANS are not what is under test — the gate above them is. Stubbed so a
// missing branch in a pure helper cannot masquerade as a refusal.
vi.mock("./seatingStore", () => ({
  switchOffBlockers: () => null,
  switchOffPlan: () => [{ sizeKey: "_" }],
  reseatPlan: () => ({ restore: [], stuck: [] }),
  movePlan: () => [{ sizeKey: "M", size: "M", qty: 3 }],
  moveBlockers: () => "",
  switchOff: async () => ({ ok: true, rowCount: 1 }),
  reseat: async () => ({ ok: true, rowCount: 1 }),
  moveAndSwitchOff: async () => ({ ok: true, moved: 1, failed: [], switchedOff: true }),
}));

const SeatingActions = (await import("./SeatingActions.jsx")).default;
const { enginePolicySeatingWritable } = await import("../../config/enginePolicy.js");

const OWNER = { email: "gunidmoh@gmail.com" };
const GRANTED_NO_STOCK = { email: "mc@marathon.internal", permFlags: { engine_policy: true } };
const GRANTED_WITH_STOCK = { ...GRANTED_NO_STOCK, stockRole: "admin" };

const SEAT = { loc: "marathon-pe", pid: "p1", reason: "carried" };
const CTX = { stock: {}, targets: {} };

const render = (viewer) => {
  let tree;
  act(() => {
    tree = TestRenderer.create(
      <SeatingActions
        seat={SEAT} product={{ name: "Black Cap" }} label="PE" registry={{}}
        locations={["marathon-pe", "hub2"]} destinations={["hub2"]} ctx={CTX}
        viewer={viewer} onDone={() => {}} onFail={() => {}}
      />,
    );
  });
  return tree;
};
const text = (tree) => JSON.stringify(tree.toJSON());
const buttonLabels = (tree) =>
  tree.root.findAllByType("button").map((b) => JSON.stringify(b.props.children)).join(" | ");

// ── THE PREDICATE ────────────────────────────────────────────────────────────
describe("enginePolicySeatingWritable", () => {
  it("admits the owner and a stockRole 'admin', and nobody else", () => {
    expect(enginePolicySeatingWritable(OWNER)).toBe(true);
    expect(enginePolicySeatingWritable(GRANTED_WITH_STOCK)).toBe(true);
    for (const v of [
      null, undefined, {},
      GRANTED_NO_STOCK,
      // A stockRole that is not 'admin' can write /stock but NOT
      // /stock_targets, and a switch-off writes a target row first. Half a
      // write is worse than none: it would leave the row set and the cells not.
      { email: "x@marathon.internal", stockRole: "warehouse" },
      { email: "x@marathon.internal", stockRole: "" },
      // The engine_policy flag is not a stock grant, however it is spelled.
      { email: "x@marathon.internal", permFlags: { engine_policy: true, stock_add: true } },
      { email: "x@marathon.internal", permissions: ["stock_management"] },
    ]) {
      expect(enginePolicySeatingWritable(v), `must refuse ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("is NOT the gate that opens the screen — the two answer different questions", async () => {
    const { enginePolicyVisibleForViewer } = await import("../../config/enginePolicy.js");
    // Granted, no stockRole: the card opens, the seating buttons do not.
    expect(enginePolicyVisibleForViewer(GRANTED_NO_STOCK)).toBe(true);
    expect(enginePolicySeatingWritable(GRANTED_NO_STOCK)).toBe(false);
    // A stockRole alone opens neither.
    const stockOnly = { email: "ahmed@marathon.internal", stockRole: "admin" };
    expect(enginePolicyVisibleForViewer(stockOnly)).toBe(false);
    expect(enginePolicySeatingWritable(stockOnly)).toBe(true);
  });
});

// ── THE ACTIONS THEMSELVES ───────────────────────────────────────────────────
describe("SeatingActions refuses in words rather than at the database", () => {
  it("a granted viewer WITHOUT a stockRole gets an explanation and no buttons", () => {
    const tree = render(GRANTED_NO_STOCK);
    expect(buttonLabels(tree)).toBe("");
    expect(text(tree)).toContain("needs Stock access");
    // …and it names what still works, so the screen does not read as broken.
    expect(text(tree)).toContain("everything else on this screen still works");
  });

  it("the owner still gets the buttons — the refusal above is not vacuous", () => {
    const labels = buttonLabels(render(OWNER));
    expect(labels).toContain("Switch off");
    expect(labels).toContain("Move and switch off");
  });

  it("a grantee WITH stockRole 'admin' gets them too — this is MC's case", () => {
    const labels = buttonLabels(render(GRANTED_WITH_STOCK));
    expect(labels).toContain("Switch off");
  });

  it("no viewer at all writes nothing", () => {
    expect(buttonLabels(render(null))).toBe("");
    expect(buttonLabels(render(undefined))).toBe("");
  });
});

// ── THE GATE SITS BELOW EVERY HOOK ───────────────────────────────────────────
// An early return above a hook changes the hook count between renders and
// crashes React the moment the viewer arrives. The renders above would catch
// it, but only for the props they happen to use; this states the rule.
describe("the refusal is placed after the hooks, not before them", () => {
  const src = readFileSync(new URL("./SeatingActions.jsx", import.meta.url), "utf8");
  it("no useState/useMemo appears after the gate", () => {
    const at = src.indexOf("const canWrite = enginePolicySeatingWritable(viewer);");
    expect(at, "SeatingActions must gate on enginePolicySeatingWritable").toBeGreaterThan(-1);
    const after = src.slice(at, src.indexOf("return (", at));
    expect(after).not.toMatch(/use(State|Memo|Effect|Callback|Ref)\(/);
  });

  it("the gate is above every write call site, not beside them", () => {
    const at = src.indexOf("const canWrite = enginePolicySeatingWritable(viewer);");
    for (const fn of ["switchOff(", "reseat(", "moveAndSwitchOff("]) {
      const callAt = src.indexOf(`${fn}{ seat`);
      expect(callAt, `SeatingActions must call ${fn}`).toBeGreaterThan(-1);
      expect(callAt).toBeGreaterThan(at);
    }
  });
});

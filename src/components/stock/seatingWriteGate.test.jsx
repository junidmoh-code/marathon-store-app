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
const moveSpy = vi.fn(async () => ({ ok: true, moved: 1, replayed: 0, failed: [], switchedOff: false }));
vi.mock("./seatingStore", () => ({
  switchOffBlockers: () => null,
  switchOffPlan: () => [{ sizeKey: "_" }],
  reseatPlan: () => ({ restore: [], stuck: [] }),
  movePlan: () => [{ sizeKey: "M", size: "M", qty: 3 }],
  moveBlockers: () => "",
  switchOff: async () => ({ ok: true, rowCount: 1 }),
  reseat: async () => ({ ok: true, rowCount: 1 }),
  moveAndSwitchOff: (...a) => moveSpy(...a),
}));

const SeatingActions = (await import("./SeatingActions.jsx")).default;
const { enginePolicySeatingWritable, enginePolicySeatingMovable } = await import("../../config/enginePolicy.js");

const OWNER = { email: "gunidmoh@gmail.com" };
const GRANTED_NO_STOCK = { email: "mc@marathon.internal", permFlags: { engine_policy: true } };
const GRANTED_WITH_STOCK = { ...GRANTED_NO_STOCK, stockRole: "admin" };
// The person the coarse first gate got wrong: allowed to move stock by the
// movement rule, not allowed to write a target row. Both halves are true at once
// and the screen has to say so. (Adversarial re-review, PR #469.)
const GRANTED_STORE = { ...GRANTED_NO_STOCK, stockRole: "store" };

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
      { email: "x@marathon.internal", stockRole: "store" },
      { email: "x@marathon.internal", stockRole: "" },
      // The engine_policy flag is not a stock grant, however it is spelled.
      { email: "x@marathon.internal", permFlags: { engine_policy: true, stock_add: true } },
      { email: "x@marathon.internal", permissions: ["stock_management"] },
    ]) {
      expect(enginePolicySeatingWritable(v), `must refuse ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("MOVING asks the movement rule's question instead — a wider list", () => {
    // /stock needs a stockRole to exist; the movement's own type rule admits
    // warehouse | store | admin for a transfer_out. Nothing else.
    for (const role of ["admin", "warehouse", "store"]) {
      expect(enginePolicySeatingMovable({ email: "x@marathon.internal", stockRole: role }),
        `must admit ${role}`).toBe(true);
    }
    expect(enginePolicySeatingMovable(OWNER)).toBe(true);
    for (const v of [
      null, undefined, {}, GRANTED_NO_STOCK,
      // POS roles record a sale; they do not transfer.
      { email: "x@marathon.internal", stockRole: "pos" },
      { email: "x@marathon.internal", stockRole: "p" },
      { email: "x@marathon.internal", stockRole: "" },
      { email: "x@marathon.internal", stockRole: true },
      { email: "x@marathon.internal", permissions: ["stock_management"] },
    ]) {
      expect(enginePolicySeatingMovable(v), `must refuse ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("the two are ordered — anyone who may switch off may also move", () => {
    // If this ever inverted, the screen would offer a switch-off to somebody it
    // refuses a move to, and the combined action would half-complete.
    for (const role of ["admin", "warehouse", "store", "pos", "", undefined]) {
      const v = { email: "x@marathon.internal", stockRole: role };
      if (enginePolicySeatingWritable(v)) {
        expect(enginePolicySeatingMovable(v), `${role} may switch off but not move`).toBe(true);
      }
    }
    expect(enginePolicySeatingWritable(OWNER) && enginePolicySeatingMovable(OWNER)).toBe(true);
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
  it("a granted viewer WITH NO stockRole AT ALL gets an explanation and no buttons", () => {
    const tree = render(GRANTED_NO_STOCK);
    expect(buttonLabels(tree)).toBe("");
    // It names a stock ROLE — not "Stock access", which points at the Stock
    // permission group, which does not open this. The vaguer wording sent
    // people to tick the wrong toggle. (Round 2 review.)
    expect(text(tree)).toContain("stock role");
    // …and it names what still works, so the screen does not read as broken.
    expect(text(tree)).toContain("still works");
    // It must NOT repeat the claim this file's own header disproves: plain
    // Switch off moves nothing, it refuses while units are present.
    expect(text(tree)).not.toMatch(/[Ss]witching a shop off moves stock/);
    // House style: no other refusal in this folder names a person.
    expect(text(tree)).not.toContain("Junid");
  });

  // ── THE CASE THE COARSE GATE GOT WRONG ────────────────────────────────────
  it("a 'store' stockRole is offered the MOVE and refused the switch-off", () => {
    const tree = render(GRANTED_STORE);
    const labels = buttonLabels(tree);
    // The movement rule admits warehouse|store|admin for transfer_out, so this
    // person may move. Refusing them was a wrong answer, not a safe one.
    expect(labels).toContain("Move stock");
    // …and the target row still needs 'admin', so these stay away.
    expect(labels).not.toContain("Switch off");
    expect(labels).not.toContain("Re-seat");
    // The button must not promise the switch-off it cannot perform.
    expect(labels).not.toContain("Move and switch off");
  });

  it("the switch-off tick is not offered to someone who may not switch off", () => {
    // The tick turns an allowed action into a refused one at the database.
    // It goes with the thing it controls, replaced by the reason.
    const tree = render(GRANTED_STORE);
    expect(tree.root.findAllByType("input").length).toBe(0);
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

// ── WHAT ACTUALLY REACHES THE STORE ──────────────────────────────────────────
// The buttons being right is not the same as the CALL being right. The tick
// defaults to ON and is not rendered for a mover — so if the raw tick state
// were passed through, a 'store' grantee pressing Move would silently ask for a
// switch-off they are refused, and lose the target row half of the action at
// the database after the stock had already moved. This asserts on the argument,
// which is the only place that can be checked. (Mutation M-SEATING-TICK.)
describe("the move a non-admin sends asks for no switch-off", () => {
  const clickText = (tree, needle) => {
    const btn = tree.root.findAll((n) => n.type === "button"
      && JSON.stringify(n.props.children || "").includes(needle))[0];
    expect(btn, `no button matching ${needle}`).toBeTruthy();
    act(() => { btn.props.onClick(); });
  };
  // The destination chips are labelled by `labelFor`, which reads a location
  // registry this test does not stub — so they are picked by being neither the
  // action nor Cancel, rather than by a label this test would be asserting
  // against itself.
  const clickDestination = (tree) => {
    const btn = tree.root.findAll((n) => n.type === "button"
      && !/Move|Cancel|Switch|Re-seat/.test(JSON.stringify(n.props.children || "")))[0];
    expect(btn, "no destination button offered").toBeTruthy();
    act(() => { btn.props.onClick(); });
  };

  it("a 'store' viewer's move is sent with alsoSwitchOff false", async () => {
    moveSpy.mockClear();
    const tree = render(GRANTED_STORE);
    clickText(tree, "Move stock");        // open the confirm
    clickDestination(tree);               // pick the one destination offered
    clickText(tree, "Move only");         // and go
    await act(async () => {});
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy.mock.calls[0][0].alsoSwitchOff).toBe(false);
  });

  it("the owner's move still carries the tick, so the above is not vacuous", async () => {
    moveSpy.mockClear();
    const tree = render(OWNER);
    clickText(tree, "Move and switch off");
    clickDestination(tree);
    clickText(tree, "Move and switch off");
    await act(async () => {});
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy.mock.calls[0][0].alsoSwitchOff).toBe(true);
  });
});

// ── THE GATE SITS BELOW EVERY HOOK ───────────────────────────────────────────
// An early return above a hook changes the hook count between renders and
// crashes React the moment the viewer arrives. The renders above would catch
// it, but only for the props they happen to use; this states the rule.
describe("the refusal is placed after the hooks, not before them", () => {
  const src = readFileSync(new URL("./SeatingActions.jsx", import.meta.url), "utf8");
  it("no hook appears anywhere after the gate", () => {
    const at = src.indexOf("const canSwitchOff = enginePolicySeatingWritable(viewer);");
    expect(at, "SeatingActions must gate on enginePolicySeatingWritable").toBeGreaterThan(-1);
    // TO THE END OF THE COMPONENT, not to the next `return (`. The first draft
    // stopped at the refusal branch's own return — about ten lines — so it read
    // past nothing and would have passed with a hook sitting in the whole
    // authorized body below. A test whose only job is to catch that must not be
    // able to miss it. (CodeRabbit, PR #469.)
    const endOfComponent = src.indexOf("\n}\n", at);
    expect(endOfComponent, "could not find the end of the component").toBeGreaterThan(at);
    const after = src.slice(at, endOfComponent);
    // Sanity: the slice really does span the authorized body, not a stub.
    expect(after).toContain("Move and switch off");
    expect(after).not.toMatch(/use(State|Memo|Effect|Callback|Ref)\(/);
  });

  it("survives a viewer going from refused to allowed mid-mount", () => {
    // The runtime proof of the same property: React throws
    // "Rendered more hooks than during the previous render" if the early
    // return sits above a hook and the answer changes under one instance —
    // which is exactly what happens when permRecord arrives a beat after auth.
    let tree;
    act(() => { tree = TestRenderer.create(<SeatingActions
      seat={SEAT} product={{ name: "Black Cap" }} label="PE" registry={{}}
      locations={["marathon-pe", "hub2"]} destinations={["hub2"]} ctx={CTX}
      viewer={GRANTED_NO_STOCK} onDone={() => {}} onFail={() => {}} />); });
    expect(buttonLabels(tree)).toBe("");
    act(() => { tree.update(<SeatingActions
      seat={SEAT} product={{ name: "Black Cap" }} label="PE" registry={{}}
      locations={["marathon-pe", "hub2"]} destinations={["hub2"]} ctx={CTX}
      viewer={GRANTED_WITH_STOCK} onDone={() => {}} onFail={() => {}} />); });
    expect(buttonLabels(tree)).toContain("Switch off");
    // …and back again, which is a revoked grant on a screen already open.
    act(() => { tree.update(<SeatingActions
      seat={SEAT} product={{ name: "Black Cap" }} label="PE" registry={{}}
      locations={["marathon-pe", "hub2"]} destinations={["hub2"]} ctx={CTX}
      viewer={GRANTED_NO_STOCK} onDone={() => {}} onFail={() => {}} />); });
    expect(buttonLabels(tree)).toBe("");
  });

  it("the gate is above every write call site, not beside them", () => {
    const at = src.indexOf("const canSwitchOff = enginePolicySeatingWritable(viewer);");
    for (const fn of ["switchOff(", "reseat(", "moveAndSwitchOff("]) {
      const callAt = src.indexOf(`${fn}{ seat`);
      expect(callAt, `SeatingActions must call ${fn}`).toBeGreaterThan(-1);
      expect(callAt).toBeGreaterThan(at);
    }
  });
});

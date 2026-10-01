// ─── THE ARMING TAB — FOUR INDEPENDENT GATES ─────────────────────────────────
//
// The Arming tab shows every product each hub is holding. It is the widest read
// on the card and it is super-admin only, on the same four gates the Seating
// tab has and for the same reason: "independent" only means something if each
// one refuses with the other three bypassed.
//
//   GATE 1   the home tile does not render                       (App.jsx)
//   GATE 2   the route refuses to mount the card                 (App.jsx)
//   GATE 2b  the card refuses itself, opening nothing            (EnginePolicyCard)
//   GATE 2d  the ARMING BRANCH refuses on its own                (EnginePolicyCard)
//
// Gates 1 and 2 are asserted at source level, the same deliberate compromise
// enginePolicyGates.test.jsx makes and for the same reason: the route decision
// lives inside a ~19,900-line module that imports Firebase, image assets and
// the whole view tree at module scope, and a mock of most of the application
// would be likelier to be wrong than the thing under test.
//
// Each of the four is deleted on its own by
// scripts/mutation-proof-engine-policy.mjs (M-ARMING-TAB, M-ARMING-TILE,
// M-ARMING-ROUTE, M-ARMING-CARD) and this file must go red for each.
//
// Run: npx vitest run src/components/stock/armingGates.test.jsx

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => false,
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const callableMock = vi.fn(async () => ({ data: { categories: [], destinations: [], history: [], cap: 75 } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true }, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));

// EVERY read the tab could make, recorded. A refused viewer must cause none of
// them: the four scoped reads are 2.7 MB against live, and a gate that refuses
// the pixels while still downloading the catalogue has not refused anything.
const READS = [];
// Enough stock for ONE armed row to exist, so the positive half of the refusal
// tests is not asserting against an empty screen.
const NODES = {
  "stock/hub1": { p1: { 8: { qty: 3, v: 1 } } },
  "stock/hub2": { p1: { 8: { qty: 2, v: 1 } } },
};
const readNode = (path) => {
  if (Object.prototype.hasOwnProperty.call(NODES, path)) return NODES[path];
  const parts = String(path).split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join("/");
    if (!Object.prototype.hasOwnProperty.call(NODES, head)) continue;
    let v = NODES[head];
    for (const k of parts.slice(i)) { v = v?.[k]; if (v == null) return null; }
    return v;
  }
  return null;
};
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    READS.push(String(r.path));
    const v = readNode(String(r.path));
    return { exists: () => v != null, val: () => v };
  },
  onValue: () => () => {},
  update: async () => {},
  push: () => ({ key: "mv1" }),
  child: () => ({}),
}));

vi.mock("./useStock", () => ({
  useLocations: () => ({
    hub1: { id: "hub1", label: "Hub 1", kind: "warehouse", active: true },
    hub2: { id: "hub2", label: "Hub 2", kind: "warehouse", active: true },
  }),
  useEngineConfig: () => GATE_CONFIG,
  useEngineConfigState: () => ({ value: GATE_CONFIG, settled: true, error: false }),
}));

const ArmingTab = (await import("./ArmingTab.jsx")).default;
const { SeatRow } = await import("./SeatingTab.jsx");
const { ArmRow } = await import("./ArmingTab.jsx");
const SeatingActions = (await import("./SeatingActions.jsx")).default;
const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;

const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
const CARD = readFileSync(new URL("./EnginePolicyCard.jsx", import.meta.url), "utf8");

const GATE_CONFIG = {
  ruleBasedTargets: true,
  categoryPolicy: { sneakers: { perSize: true,
    hub1: { carriedOnly: true, sizes: { 8: { target: 2, minQty: 1 } } },
    hub2: { carriedOnly: true, sizes: { 8: { target: 2, minQty: 1 } } } } },
};
const PRODUCTS = [{ id: "p1", name: "A Sneaker", category: "Footwear", categoryKey: "sneakers", sizes: ["8"] }];
const OWNER = { email: "gunidmoh@gmail.com" };
const GRANTED = { email: "mc@marathon.internal", permFlags: { engine_policy: true } };
const STAFF = { email: "rashid@marathon.internal" };

const text = (tree) => JSON.stringify(tree.toJSON());
const buttons = (tree) => tree.root.findAll((n) => n.type === "button");
function label(node) {
  const out = [];
  const walk = (c) => {
    if (c == null || typeof c === "boolean") return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    if (typeof c === "object") { walk(c.props?.children); return; }
    out.push(String(c));
  };
  walk(node.props?.children);
  return out.join("");
}
const buttonSaying = (tree, said) => buttons(tree).find((b) => label(b).includes(said));

// Open the Arming tab and expand its first row, as far as the viewer is let.
// A refused viewer simply has no tab and no rows, and that is the answer.
async function openFirstRow(tree, { alsoSeat = false } = {}) {
  const arming = buttonSaying(tree, "Arming");
  if (arming) { await act(async () => { arming.props.onClick(); }); await act(async () => {}); await act(async () => {}); }
  const row = tree.root.findAllByType(ArmRow)[0];
  if (row) {
    const btn = row.findAll((n) => n.type === "button").find((b) => label(b).includes(row.props.row.name));
    await act(async () => { btn.props.onClick(); });
    await act(async () => {});
    await act(async () => {});
  }
  if (alsoSeat) {
    // SeatingActions mounts only for an EXPANDED seat row — that is where the
    // write buttons live, so that is where the refusal has to reach.
    const seat = tree.root.findAllByType(SeatRow)[0];
    if (seat) {
      const change = seat.findAll((n) => n.type === "button").find((b) => label(b).includes("Change"));
      await act(async () => { change.props.onClick(); });
      await act(async () => {});
    }
  }
  return tree;
}

async function card(viewer) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<EnginePolicyCard viewer={viewer} products={PRODUCTS} onExit={() => {}} />); });
  await act(async () => {});
  return tree;
}

// ── GATE 1 — THE HOME TILE ───────────────────────────────────────────────────
describe("GATE 1 — no tile", () => {
  it("the tile is still behind enginePolicyVisibleForViewer", () => {
    expect(APP).toContain('enginePolicyVisibleForViewer(enginePolicyViewer) && { key:"engine_policy"');
  });

  it("and the Arming tab has no tile, route or role of its own to slip through", () => {
    // One way in, and it is the Engine Policy card. A second entry point would
    // be a second gate to keep in step — and the one that got forgotten.
    expect(APP).not.toContain("ArmingTab");
    expect(APP).not.toContain("ROLES.ARMING");
  });
});

// ── GATE 2 — THE ROUTE ───────────────────────────────────────────────────────
describe("GATE 2 — no route", () => {
  it("the route still refuses to mount the card for anyone but a verified viewer", () => {
    expect(APP).toContain("else if (role === ROLES.ENGINE_POLICY) view = enginePolicyVisibleForViewer({ email: authUser?.email, permFlags: permRecord?.permFlags })");
  });
});

// ── GATE 2b — THE CARD ───────────────────────────────────────────────────────
describe("GATE 2b — no card", () => {
  it("a staff account gets the refusal, not the card", async () => {
    const tree = await card(STAFF);
    expect(text(tree)).toContain("don't have access");
    expect(tree.root.findAllByType(ArmingTab).length).toBe(0);
  });
});

// ── GATE 2d — THE TAB'S OWN CHECK ────────────────────────────────────────────
describe("GATE 2d — the Arming branch refuses on its own", () => {
  // THE SLICE HAS TO START AT THE BRANCH, NOT AT THE FIRST MENTION. The tab
  // strip carries `tab === "arming" ? tabOn : tabOff` well above the branch, so
  // a slice from the first occurrence swallows the whole Seating branch — and
  // then passes on SEATING'S gate while Arming has none. Both M-ARMING-TAB
  // mutations survived that version of this test, which is what the mutation
  // harness is for.
  const armingBranch = () => {
    const start = CARD.indexOf('} : tab === "arming"') >= 0
      ? CARD.indexOf('} : tab === "arming"')
      : CARD.indexOf(') : tab === "arming"');
    expect(start, "the Arming branch must still be a branch of the tab ternary").toBeGreaterThan(-1);
    return CARD.slice(start, CARD.indexOf("<ArmingTab"));
  };

  it("the card's arming branch is guarded by the shared predicate", () => {
    expect(armingBranch()).toContain("enginePolicyVisibleForViewer(viewer) ? (");
  });

  it("and by NOTHING WEAKER — no truthy viewer, no email test of its own", () => {
    // A gate that still looks like a gate is the interesting failure. The
    // branch must ask the one predicate every other gate asks, so a change to
    // who may see Engine Policy cannot leave this tab behind.
    const branch = armingBranch();
    expect(branch).not.toMatch(/!!viewer\s*\?/);
    expect(branch).not.toMatch(/\btrue\s*\?\s*\(/);
    expect(branch).not.toContain("ADMIN_EMAIL");
  });

  it("and its refusal is the card's own Refused screen", () => {
    expect(armingBranch().length).toBeGreaterThan(0);
    const tail = CARD.slice(CARD.indexOf("<ArmingTab"));
    expect(tail.slice(0, 200)).toContain("<Refused onExit={onExit} />");
  });

  it("a staff account never reaches the tab, whichever tab is selected", async () => {
    const tree = await card(STAFF);
    expect(tree.root.findAllByType(ArmingTab).length).toBe(0);
  });

  it("and starts no read — the refusal is of the WORK, not only of the pixels", async () => {
    READS.length = 0;
    await card(STAFF);
    expect(READS).toEqual([]);
    expect(callableMock).not.toHaveBeenCalled();
  });

  it("…and mounts no SeatRow, so none of its write buttons can exist", async () => {
    // The tab EDITS now. A refusal that stopped at the list while still
    // mounting the action rows would be a refusal of the reading and not of the
    // writing.
    //
    // THE OWNER HALF IS WHAT MAKES THIS MEAN ANYTHING. SeatRow only mounts when
    // a row is OPENED, so a version of this that merely rendered the card
    // asserted zero for every viewer alive — it passed with STAFF swapped for
    // OWNER. The positive case is proved first, on the same fixture, and only
    // then is the refusal asserted. (Adversarial review, PR #604.)
    const armed = await openFirstRow(await card(OWNER));
    expect(armed.root.findAllByType(SeatRow).length,
      "the refusal below is vacuous unless a permitted viewer gets rows").toBeGreaterThan(0);

    const refused = await openFirstRow(await card(STAFF));
    expect(refused.root.findAllByType(SeatRow).length).toBe(0);
  });

  it("and no SeatingActions, which is where the writes actually live", async () => {
    const armed = await openFirstRow(await card(OWNER), { alsoSeat: true });
    expect(armed.root.findAllByType(SeatingActions).length).toBeGreaterThan(0);

    const refused = await openFirstRow(await card(STAFF), { alsoSeat: true });
    expect(refused.root.findAllByType(SeatingActions).length).toBe(0);
  });
});

// ── THE REFUSALS ARE NOT VACUOUS ─────────────────────────────────────────────
describe("the owner and a grantee do get in", () => {
  it("the owner reaches the Arming tab", async () => {
    const tree = await card(OWNER);
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(ArmingTab).length).toBe(1);
  });

  it("so does an account carrying the engine_policy flag", async () => {
    const tree = await card(GRANTED);
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    expect(tree.root.findAllByType(ArmingTab).length).toBe(1);
  });

  it("and only then does it read the two hubs", async () => {
    READS.length = 0;
    const tree = await card(OWNER);
    expect(READS).toEqual([]);            // Categories is the landing tab
    await act(async () => { buttonSaying(tree, "Arming").props.onClick(); });
    await act(async () => {});
    expect(READS.sort()).toEqual(["stock/hub1", "stock/hub2", "stock_targets/hub1", "stock_targets/hub2"]);
  });
});

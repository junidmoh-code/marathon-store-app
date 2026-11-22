// The Engine Policy card says "Pine follows Trophy" (Junid, 22 Nov 2026), offers
// the one switch, and the reasons a shop kept from Central has nothing to solve
// are true sentences (actionReasons.js).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/database", () => ({ ref: (_db, path) => ({ path }), get: async () => ({ exists: () => false, val: () => null }) }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("./barcodeListener", () => ({ installBarcodeListener: () => () => {}, subscribeBarcode: () => () => {} }));
vi.mock("./useStock", () => ({ useLocations: () => ({}), useEngineConfig: () => ({}) }));

const { PolicyFollowPanel, policyFollowHistoryLine } = await import("./EnginePolicyCard.jsx");
const { centralFedNoPlanReason, centralFedNothingSentReason, solveConfirmReason, solveReason } = await import("./actionReasons.js");

const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
const mount = (el) => { let t; act(() => { t = TestRenderer.create(el); }); return t; };
const button = (t, action) => t.root.findAll((n) => n.type === "button" && n.props["data-action"] === action)[0];

describe("the card: Pine follows Trophy", () => {
  it("on: the heading says it, and what following means is spelled out", () => {
    const t = mount(<PolicyFollowPanel location="marathon-pine" follows="trophy" options={["trophy"]} busy="" onSave={() => {}} />);
    const text = flat(t.toJSON());
    expect(text).toContain("Pine follows Trophy");
    expect(text).toContain("Change Trophy's numbers and Pine follows at the next scan.");
    expect(text).toContain("Nothing is added to Pine");
    expect(text).toContain("a product switched off at Pine stays off");
    expect(text).toContain("its stock still comes from Central (sneakers from Hub 3)");
    expect(t.root.findByProps({ "data-policy-follow-panel": "marathon-pine" }).props["data-follows"]).toBe("trophy");
  });
  it("on: the one button switches it off; off: the one button switches it on", () => {
    const saved = [];
    const on = mount(<PolicyFollowPanel location="marathon-pine" follows="trophy" options={["trophy"]} busy="" onSave={(v) => saved.push(v)} />);
    expect(button(on, "policy-follow-on")).toBeUndefined();
    act(() => { button(on, "policy-follow-off").props.onClick(); });
    const off = mount(<PolicyFollowPanel location="marathon-pine" follows={null} options={["trophy"]} busy="" onSave={(v) => saved.push(v)} />);
    expect(flat(off.toJSON())).toContain("Pine does not follow Trophy");
    expect(flat(off.toJSON())).toContain("Make Pine follow Trophy");
    act(() => { button(off, "policy-follow-on").props.onClick(); });
    expect(saved).toEqual([null, "trophy"]);
  });
  it("nothing can be tapped while another save is running", () => {
    const t = mount(<PolicyFollowPanel location="marathon-pine" follows="trophy" options={["trophy"]} busy="save" onSave={() => {}} />);
    expect(button(t, "policy-follow-off").props.disabled).toBe(true);
  });
  it("the history line reads both ways, so Revert is one obvious step", () => {
    expect(policyFollowHistoryLine({ before: null, after: "trophy" })).toBe("own numbers -> follows Trophy");
    expect(policyFollowHistoryLine({ before: "trophy", after: null })).toBe("follows Trophy -> own numbers");
  });
});

describe("a shop kept from Central with nothing to solve says what is true", () => {
  const size = (over) => ({ size: "_", target: 5, switchedOff: false, hasCell: true, trusted: true, qty: 0, ...over });
  it("something CAN be solved → no reason (a missing cell, or an empty uncounted one)", () => {
    expect(centralFedNoPlanReason({ sizes: [size({ hasCell: false })], storeLabel: "Marathon Pine" })).toBe(null);
    expect(centralFedNoPlanReason({ sizes: [size({ trusted: false, qty: 0 })], storeLabel: "Marathon Pine" })).toBe(null);
    expect(centralFedNoPlanReason({ sizes: [size(), size({ size: "M", hasCell: false })], storeLabel: "Marathon Pine" })).toBe(null);
  });
  it("already carried: the scan refills it; paused says so; an open request is named", () => {
    expect(centralFedNoPlanReason({ sizes: [size()], storeLabel: "Marathon Pine" })).toMatchObject({ code: "carried" });
    expect(centralFedNoPlanReason({ sizes: [size()], storeLabel: "Marathon Pine", paused: true }).text).toMatch(/paused while Marathon Pine is being counted/);
    expect(centralFedNoPlanReason({ sizes: [size()], storeLabel: "Marathon Pine", paused: true, onTheWay: 5 })).toEqual({
      code: "on_the_way", text: "Marathon Pine already carries this and 5 are already requested from Central for it, so there is nothing more to solve." });
    expect(centralFedNoPlanReason({ sizes: [size()], storeLabel: "Marathon Pine", onTheWay: 1 }).text).toMatch(/and 1 is already requested/);
  });
  it("switched off at the shop, uncounted stock, and no keep at all are three different sentences", () => {
    expect(centralFedNoPlanReason({ sizes: [size({ target: 0, switchedOff: true })], storeLabel: "Marathon Pine" }).code).toBe("switched_off");
    expect(centralFedNoPlanReason({ sizes: [size({ trusted: false, qty: 3 })], storeLabel: "Marathon Pine" }).code).toBe("uncounted");
    expect(centralFedNoPlanReason({ sizes: [size({ target: 0 })], storeLabel: "Marathon Pine" }).code).toBe("no_keep");
    expect(centralFedNoPlanReason({ sizes: [], storeLabel: "Marathon Pine" }).code).toBe("no_keep");
  });
  it("none of them is 'No refill policy covers this product' or 'Central has none'", () => {
    for (const sizes of [[size()], [size({ target: 0, switchedOff: true })], [size({ trusted: false, qty: 3 })]]) {
      const r = centralFedNoPlanReason({ sizes, storeLabel: "Marathon Pine", paused: true });
      expect(r.text).not.toMatch(/No refill policy covers|Central has none/);
      expect(r.text).toMatch(/\.$/);
    }
  });
  it("the confirm and the outer Solve button carry that reason instead of the generic one", () => {
    const why = centralFedNoPlanReason({ sizes: [size()], storeLabel: "Marathon Pine" }).text;
    expect(solveConfirmReason({ canAct: true, sizesInPlan: 0, storeLabel: "Marathon Pine", why })).toBe(why);
    expect(solveConfirmReason({ canAct: true, sizesInPlan: 0, storeLabel: "Marathon Pine" })).toMatch(/No refill policy covers this product at Marathon Pine/);
    expect(solveConfirmReason({ canAct: true, sizesInPlan: 2, storeLabel: "Marathon Pine", why })).toBe(null);
    const base = { canAct: true, configLoaded: true, targetsLoaded: true, hasSourceStock: true, ruleOnAnywhere: true };
    expect(solveReason({ ...base, policyAtAnyStore: false, why })).toBe(why);
    expect(solveReason({ ...base, policyAtAnyStore: true, why })).toBe(null);
    // A failed read is still the first thing said: the reason may rest on rows nobody could read.
    expect(solveReason({ ...base, policyAtAnyStore: false, targetsError: true, why })).toMatch(/Can't read the refill settings/);
  });
});

describe("sizes can be solved but nothing is sent: where Central's stock is", () => {
  it("none at all; in sizes the product does not list; all promised; or simply marked carried", () => {
    expect(centralFedNothingSentReason({ storeLabel: "Marathon Pine", centralUnits: 0 })).toBe("Central has none of this product — nothing to send to Marathon Pine yet.");
    expect(centralFedNothingSentReason({ storeLabel: "Marathon Pine", centralUnits: 28, inSizes: 0, otherSizes: ["XL", "XXL"] }))
      .toBe("Central holds 28 units, but in sizes this product does not list (XL, XXL) — nothing to send to Marathon Pine until the product's sizes are corrected.");
    expect(centralFedNothingSentReason({ storeLabel: "Marathon Pine", centralUnits: 28, inSizes: 28, free: 0 }))
      .toBe("Central holds 28 units of these sizes, all already promised to other requests — nothing to send to Marathon Pine yet.");
    expect(centralFedNothingSentReason({ storeLabel: "Marathon Pine", centralUnits: 28, inSizes: 28, free: 28 })).toMatch(/marked as carried there and the scan asks Central/);
  });
  it("28 units at Central never reads as 'Central has none'", () => {
    for (const args of [{ inSizes: 0, otherSizes: ["M"] }, { inSizes: 28, free: 0 }, { inSizes: 28, free: 28 }]) {
      expect(centralFedNothingSentReason({ storeLabel: "Marathon Pine", centralUnits: 28, ...args })).not.toMatch(/has none/);
    }
  });
});

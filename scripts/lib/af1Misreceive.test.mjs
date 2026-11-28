// AF1 wrong-product receive (Junid, 28 Nov 2026): facts + plan are pure.
import { describe, it, expect } from "vitest";
import { collectFacts, planCorrection, cellsToMap, groupReceiveEvents, sizeKey, sastDay, levelBefore } from "./af1Misreceive.mjs";

const W = "pW", R = "pR";
let n = 0;
const row = (o) => ({ id: `m${++n}`, actor: "mike", reason: null, ...o });
const base = { wrongPid: W, rightPid: R, receiveFrom: "2026-11-22T22:00:00.000Z", receiveTo: "2026-11-28T20:00:00.000Z", manualDay: "2026-11-28", userNames: { mike: "Mike", jun: "Junid" } };

describe("cellsToMap", () => {
  it("drops the null holes RTDB leaves when size keys are small integers", () => {
    expect(cellsToMap([null, null, null, { qty: 2 }, { qty: 0 }])).toEqual({ 3: 2, 4: 0 });
  });
  it("reads an object node and treats a cell without qty as 0", () => {
    expect(cellsToMap({ "5_5": { qty: 1 }, 6: { v: 1 }, x: null })).toEqual({ "5_5": 1, 6: 0 });
    expect(cellsToMap(null)).toEqual({});
  });
});

describe("helpers", () => {
  it("sizeKey folds a half size like the cell writer", () => { expect(sizeKey("5.5")).toBe("5_5"); expect(sizeKey("")).toBe("_"); });
  it("sastDay is the SAST calendar day", () => { expect(sastDay("2026-11-27T22:30:00Z")).toBe("2026-11-28"); });
  it("groups rows by actor+place within 10 minutes", () => {
    const ev = groupReceiveEvents([
      row({ ts: "2026-11-23T13:48:00Z", to: "central", size: "3", qty: 7, productId: W }),
      row({ ts: "2026-11-23T13:49:00Z", to: "central", size: "4", qty: 8, productId: W }),
      row({ ts: "2026-11-23T14:06:00Z", to: "central", size: "3", qty: 7, productId: W }),
    ]);
    expect(ev.map((e) => e.units)).toEqual([15, 7]);
  });
  it("levelBefore uses the first touching row's before, else the current cell", () => {
    const rows = [row({ ts: "2026-11-24T00:00:00Z", size: "5", before: { hub1: 1 } })];
    expect(levelBefore(rows, "hub1", "5", "2026-11-23T00:00:00Z", {})).toBe(1);
    expect(levelBefore(rows, "hub3", "5", "2026-11-23T00:00:00Z", { hub3: { 5: 4 } })).toBe(4);
  });
});

// A clean world that matches the brief exactly: one receive onto WRONG at
// central, part refilled to hub1, one WRONG sale there, Junid's add on RIGHT.
function cleanWorld() {
  const rows = [
    row({ productId: W, ts: "2026-11-25T08:00:00Z", type: "received", size: "5", qty: 6, to: "central", before: { central: 0 }, after: { central: 6 } }),
    row({ productId: W, ts: "2026-11-25T08:00:30Z", type: "received", size: "6", qty: 4, to: "central", before: { central: 0 }, after: { central: 4 } }),
    row({ productId: W, ts: "2026-11-26T06:00:00Z", type: "transfer_out", size: "5", qty: 2, from: "central", to: "hub1", before: { central: 6, hub1: 0 }, after: { central: 4, hub1: 2 } }),
    row({ productId: W, ts: "2026-11-27T09:00:00Z", type: "sold", size: "5", qty: 1, from: "hub1", before: { hub1: 2 }, after: { hub1: 1 } }),
    row({ productId: R, ts: "2026-11-26T09:00:00Z", type: "sold", size: "5", qty: 1, from: "hub1", before: { hub1: 0 }, after: { hub1: 0 } }),
    row({ productId: R, actor: "jun", ts: "2026-11-28T09:00:00Z", type: "adjustment", size: "5", qty: 3, to: "hub1", reason: "recount", before: { hub1: 0 }, after: { hub1: 3 } }),
    row({ productId: R, ts: "2026-11-28T10:00:00Z", type: "sold", size: "5", qty: 2, from: "hub1", before: { hub1: 3 }, after: { hub1: 1 } }),
  ];
  const cells = { [W]: { central: { 5: 4, 6: 4 }, hub1: { 5: 1 } }, [R]: { hub1: { 5: 1 } } };
  return { rows, cells };
}

describe("collectFacts + planCorrection — a world that matches the brief", () => {
  it("follows R to where it sits now, reassigns the clean Ys and is READY", () => {
    const { rows, cells } = cleanWorld();
    const f = collectFacts({ ...base, rows, cells, manualActors: ["jun"] });
    expect(f.R).toEqual({ central: { 5: 4, 6: 4 }, hub1: { 5: 2 } });
    expect(f.Ys).toEqual({ hub1: { 5: 1 } });
    expect(f.M).toEqual({ hub1: { 5: 3 } });
    expect(f.Ws).toEqual({ hub1: { 5: 3 } });
    const p = planCorrection(f, { expectedReceiveDay: "2026-11-25" });
    expect(p.blockers).toEqual([]);
    expect(p.status).toBe("READY");
    const byKey = Object.fromEntries(p.lines.map((l) => [`${l.product}:${l.loc}:${l.size}`, l]));
    // hub1/5: RIGHT +2 −3 −1 = −2 → 1 → −1 is negative, reported not applied
    expect(p.negative.map((l) => `${l.product}:${l.loc}:${l.size}:${l.delta}`)).toEqual(["right:hub1:5:-2"]);
    expect(byKey["right:central:5"].delta).toBe(4);
    expect(byKey["wrong:central:5"]).toMatchObject({ delta: -4, before: 4, after: 0 });
    expect(byKey["wrong:hub1:5"]).toMatchObject({ delta: -1, before: 1, after: 0 });
    expect(p.totals.combinedDelta).toBe(-3);
    expect(p.totals.combinedDeltaOk).toBe(true);
  });
});

describe("blockers — the brief's premise not holding", () => {
  it("blocks when the right product received the same delivery too", () => {
    const { rows, cells } = cleanWorld();
    rows.push(row({ productId: R, ts: "2026-11-25T09:00:00Z", type: "received", size: "5", qty: 6, to: "central", before: { central: 0 } }));
    rows.push(row({ productId: R, ts: "2026-11-25T09:00:10Z", type: "received", size: "6", qty: 4, to: "central", before: { central: 0 } }));
    const p = planCorrection(collectFacts({ ...base, rows, cells, manualActors: ["jun"] }));
    expect(p.status).toBe("BLOCKED");
    expect(p.blockers.map((b) => b.code)).toContain("right_product_also_received");
  });
  it("blocks on no receive, an unconfirmed manual actor, and the wrong day", () => {
    const { rows, cells } = cleanWorld();
    const none = planCorrection(collectFacts({ ...base, rows: rows.filter((r) => r.type !== "received"), cells, manualActors: ["jun"] }));
    expect(none.blockers.map((b) => b.code)).toContain("no_wrong_receive");
    const p = planCorrection(collectFacts({ ...base, rows, cells }), { expectedReceiveDay: "2026-11-24" });
    expect(p.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["manual_add_unconfirmed", "receive_not_on_expected_day"]));
  });
  it("marks a WRONG sale ambiguous when that cell held real WRONG stock before the receive", () => {
    const { rows, cells } = cleanWorld();
    rows[2] = { ...rows[2], before: { central: 6, hub1: 1 } };   // hub1 already held 1
    const f = collectFacts({ ...base, rows, cells, manualActors: ["jun"] });
    expect(f.Ys).toEqual({});
    expect(f.ysLines[0].ambiguous).toBe(true);
    const p = planCorrection(f);
    expect(p.blockers).toEqual([]);   // listed, left out of Ys — not a reason to hold the rest
    expect(p.negative.find((l) => l.product === "wrong" && l.loc === "hub1")).toMatchObject({ delta: -2, before: 1, after: -1 });   // the unit sold must not be removed twice
  });
  it("blocks two receive events onto the wrong product", () => {
    const { rows, cells } = cleanWorld();
    rows.push(row({ productId: W, ts: "2026-11-25T09:30:00Z", type: "received", size: "5", qty: 6, to: "central", before: { central: 4 } }));
    expect(planCorrection(collectFacts({ ...base, rows, cells, manualActors: ["jun"] })).blockers.map((b) => b.code)).toContain("multiple_wrong_receives");
  });
});

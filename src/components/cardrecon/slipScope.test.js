// ─── THE SLIP SCOPE, CLIENT AND SERVER READ IT THE SAME WAY ──────────────────
// The server decides (functions/lib/card-slip-scope.cjs + placements); this
// screen only chooses which till to draw. If the two ever read a scope or a
// placement differently, the screen would offer a till the server refuses — or
// hide the one it would take. So both run over the same inputs here.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readSlipScope, tillNow, slipTills, hasSlipScope } from "./slipScope";

const require = createRequire(import.meta.url);
const server = require("../../../functions/lib/card-slip-scope.cjs");
const { tillAt } = require("../../../functions/lib/card-terminal-placements.cjs");

const SCOPES = [
  { pe: { "till-2": true } },
  { trophy: { "till-2": true }, pe: { "till-1": true, "till-3": false } },
  { pe: { "till-2": "true" } }, { pe: true }, { pe: ["till-2"] }, ["pe/till-2"], "pe/till-2", null, undefined, {},
  { "pe/x": { a: true } }, { pe: { "../x": true } },
];

const at = (iso) => Date.parse(`${iso}+02:00`);
const placed = (...ps) => Object.fromEntries(ps.map(([from, storeId, tillId, label]) => [`at-${at(from)}`, { effectiveFrom: at(from), storeId, tillId, label }]));
// The live shapes, 16 Oct 2026 (made-up TIDs): two machines swapped tills on 5 Oct.
const REGISTRY = {
  "67000001": { storeId: "pe", tillId: "till-1", label: "Trophy Till 1",
    placements: placed(["2026-09-18T00:00:00", "pe", "till-1", "Marathon Till 1"], ["2026-10-05T09:00:00", "trophy", "till-1", "Trophy Till 1"]) },
  "67000004": { storeId: "trophy", tillId: "till-1", label: "Marathon Till 1",
    placements: placed(["1970-01-01T02:00:00", "trophy", "till-1", "Trophy Till 1"], ["2026-10-05T09:00:00", "pe", "till-1", "Marathon Till 1"]) },
  "0000AA2X": { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", placements: placed(["2026-09-18T00:00:00", "pe", "till-2", "Marathon Till 2"]) },
  "0000BB2Y": { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2", capture: "typed", placements: placed(["2026-09-18T00:00:00", "trophy", "till-2", "Trophy Till 2"]) },
  "67000003": { storeId: "pe", tillId: "till-3", label: "Marathon Till 3" },
  "67000009": { storeId: "pe", tillId: "till-2", label: "Old Till 2", retiredAt: at("2026-09-18T00:00:00") },
};
const NOW = at("2026-10-16T18:00:00");

describe("the client reads a scope exactly as the server does", () => {
  it.each(SCOPES.map((s) => [JSON.stringify(s), s]))("%s", (_, raw) => {
    expect(readSlipScope(raw)).toEqual(server.readSlipScope(raw));
  });

  it("and places every machine on the same till, before and after a swap", () => {
    for (const row of Object.values(REGISTRY)) {
      for (const when of [at("2026-09-01T00:00:00"), at("2026-10-05T08:59:59"), at("2026-10-05T09:00:00"), NOW]) {
        const c = tillNow(row, when), s = tillAt(row, when);
        expect({ storeId: c.storeId, tillId: c.tillId }).toEqual({ storeId: s.storeId, tillId: s.tillId });
      }
    }
  });
});

describe("which till's slip an account sends", () => {
  it("Yasmin (pe/till-2) gets Marathon Till 2, and only that", () => {
    const tills = slipTills(REGISTRY, { cardSlipTills: { pe: { "till-2": true } } }, NOW);
    expect(tills).toEqual([{ tid: "0000AA2X", storeId: "pe", tillId: "till-2", label: "Marathon Till 2" }]);
  });

  it("Amanda (trophy/till-2) gets Trophy Till 2, and only that", () => {
    const tills = slipTills(REGISTRY, { cardSlipTills: { trophy: { "till-2": true } } }, NOW);
    expect(tills.map((t) => t.label)).toEqual(["Trophy Till 2"]);
  });

  it("a till follows the machine standing at it NOW, never the registry row's old till", () => {
    // trophy/till-1 is the machine labelled "Trophy Till 1" since the 5 Oct swap.
    expect(slipTills(REGISTRY, { cardSlipTills: { trophy: { "till-1": true } } }, NOW).map((t) => t.tid)).toEqual(["67000001"]);
    expect(slipTills(REGISTRY, { cardSlipTills: { trophy: { "till-1": true } } }, at("2026-10-01T12:00:00")).map((t) => t.tid)).toEqual(["67000004"]);
  });

  it("no scope, or a malformed one, is no till at all", () => {
    for (const rec of [null, {}, { cardSlipTills: null }, { cardSlipTills: { pe: true } }, { permFlags: { card_recon: true } }]) {
      expect(slipTills(REGISTRY, rec, NOW)).toEqual([]);
      expect(hasSlipScope(rec)).toBe(false);
    }
    expect(hasSlipScope({ cardSlipTills: { pe: { "till-2": true } } })).toBe(true);
  });
});

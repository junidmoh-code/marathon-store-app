// ─── ENGINE POLICY CARD — the rules, as rules ─────────────────────────────────
// Run: npx vitest run src/components/stock/enginePolicyCore.test.js

import { describe, it, expect } from "vitest";
import {
  armedLocations, categoryRowState, editorRows, draftFromEntry, seedLocation, onTargetChanged,
  policyFromDraft, validateDraft, previewKey, canSave, changedFields, nextScanAt,
  previewVerdict, lastChange, defaultMinQty, COLUMN_LABELS,
} from "./enginePolicyCore";

const CARRIAGE = {
  hub2: { carries: true, products: 158, units: 381 },
  "marathon-pe": { carries: true, products: 232, units: 334 },
  trophy: { carries: false, products: 0, units: 0 },
  // The husk case, from the real data: cells exist, every one holds zero.
  // storeCarries() reads node presence, so the engine calls this "carried".
  "marathon-pine": { carries: true, products: 3, units: 0 },
};
const DESTS = ["hub2", "marathon-pe", "trophy", "marathon-pine"];
const ENTRY = { hub2: { target: 10, minQty: 5, reorderPoint: 0 }, "marathon-pe": { target: 5, minQty: 3, reorderPoint: 0 } };

// The labels are the owner's words and are load-bearing — the whole screen is
// an attempt to stop anyone having to learn "target / minQty / reorderPoint".
it("the three columns are Keep, Minimum and Ask at", () => {
  expect(COLUMN_LABELS).toEqual({ target: "Keep", minQty: "Minimum", reorderPoint: "Ask at" });
});

describe("armedLocations — the engine's own test, mirrored", () => {
  it("a positive finite numeric target arms; anything else arms nothing", () => {
    expect(armedLocations(ENTRY)).toEqual(["hub2", "marathon-pe"]);
    expect(armedLocations({ hub2: { target: "10" } })).toEqual([]);   // a string is not a target
    expect(armedLocations({ hub2: { target: 0 } })).toEqual([]);
    expect(armedLocations({ hub2: { target: -1 } })).toEqual([]);
    expect(armedLocations({ hub2: { target: NaN } })).toEqual([]);
    expect(armedLocations({ perSize: true })).toEqual([]);            // the mode flag is not a location
    expect(armedLocations(null)).toEqual([]);
    expect(armedLocations([{ target: 5 }])).toEqual([]);
  });
});

describe("row state", () => {
  it("armed, overridden, or no policy — and overridden is the one that matters", () => {
    expect(categoryRowState({ entry: ENTRY }).state).toBe("armed");
    expect(categoryRowState({ entry: null }).state).toBe("none");
    // An armed category whose products carry their own explicit rows is armed
    // in name only for those products — the map never reaches them.
    const o = categoryRowState({ entry: ENTRY, overriddenProducts: 79 });
    expect(o.state).toBe("overridden");
    expect(o.overriddenProducts).toBe(79);
  });
});

describe("carriage decides what may be edited", () => {
  const rows = editorRows({ entry: ENTRY, carriage: CARRIAGE, destinations: DESTS });
  const at = (l) => rows.find((r) => r.loc === l);

  it("a store that does not carry the category is NOT editable", () => {
    // This is the guard against inventing demand: a mapped product is managed
    // at a mapped location unconditionally, so arming trophy would make the
    // engine ask for every cap at a shop that has never sold one.
    expect(at("trophy").carries).toBe(false);
    expect(at("trophy").editable).toBe(false);
  });

  it("an already-armed store stays editable even if it stops carrying", () => {
    // Refusing to let the owner correct a mistake is not a safety feature.
    const r = editorRows({ entry: { trophy: { target: 4, minQty: 2 } }, carriage: CARRIAGE, destinations: DESTS });
    const t = r.find((x) => x.loc === "trophy");
    expect(t.carries).toBe(false);
    expect(t.armed).toBe(true);
    expect(t.editable).toBe(true);
  });

  it("cell presence, not units — a husk store still reads as carrying", () => {
    // marathon-pine's three headwear cells are all zero, left by a
    // reconciliation. The engine calls that carriage, so the card must too, and
    // the units column is what tells the owner the truth.
    expect(at("marathon-pine").carries).toBe(true);
    expect(at("marathon-pine").unitsHeld).toBe(0);
  });

  it("only armed locations start in the draft", () => {
    const d = draftFromEntry({ entry: ENTRY, carriage: CARRIAGE, destinations: DESTS });
    expect(Object.keys(d).sort()).toEqual(["hub2", "marathon-pe"]);
    expect(d.hub2).toEqual({ target: "10", minQty: "5", reorderPoint: "0" });
  });
});

describe("Minimum is visible but never typed from scratch", () => {
  it("seeds at ceil(keep / 2)", () => {
    expect(defaultMinQty(10)).toBe(5);
    expect(defaultMinQty(5)).toBe(3);
    expect(defaultMinQty(1)).toBe(1);
    expect(defaultMinQty(0)).toBe(0);
    expect(seedLocation(8)).toEqual({ target: "8", minQty: "4", reorderPoint: "" });
  });

  it("follows Keep only while it is still the default", () => {
    expect(onTargetChanged({ target: "10", minQty: "5" }, "20").minQty).toBe("10");
    // Once the owner has typed their own number it is theirs.
    expect(onTargetChanged({ target: "10", minQty: "7" }, "20").minQty).toBe("7");
    expect(onTargetChanged({ target: "", minQty: "" }, "6").minQty).toBe("3");
  });
});

describe("blank Ask at is ABSENT, not zero", () => {
  it("omits it rather than sending 0", () => {
    // Absent = top up as soon as anything sells. 0 = ask only when the shelf is
    // empty. Collapsing one into the other would silently change the behaviour
    // of every location it touched.
    const p = policyFromDraft({ hub2: { target: "10", minQty: "5", reorderPoint: "" } });
    expect("reorderPoint" in p.hub2).toBe(false);
    expect(policyFromDraft({ hub2: { target: "10", minQty: "5", reorderPoint: "0" } }).hub2.reorderPoint).toBe(0);
  });

  it("a row with no Keep is dropped, and an empty draft is null — the off switch", () => {
    expect(policyFromDraft({ hub2: { target: "", minQty: "5" } })).toBe(null);
    expect(policyFromDraft({})).toBe(null);
  });

  it("carries perSize through", () => {
    expect(policyFromDraft({ hub2: { target: "5", minQty: "3" } }, { perSize: true }).perSize).toBe(true);
    expect("perSize" in policyFromDraft({ hub2: { target: "5", minQty: "3" } })).toBe(false);
  });

  it("fills Minimum when the owner leaves it blank", () => {
    expect(policyFromDraft({ hub2: { target: "10", minQty: "" } }).hub2.minQty).toBe(5);
  });
});

describe("local validation says it at the keyboard", () => {
  const err = (row) => validateDraft({ hub2: row }).hub2;
  it("refuses what the server would refuse", () => {
    expect(err({ target: "" })).toMatch(/Keep is required/);
    expect(err({ target: "0" })).toMatch(/1 or more/);
    expect(err({ target: "-3" })).toMatch(/1 or more/);
    expect(err({ target: "2.5" })).toMatch(/1 or more/);
    expect(err({ target: "501" })).toMatch(/more than 500/);
    expect(err({ target: "10", minQty: "11" })).toMatch(/no higher than Keep/);
    expect(err({ target: "10", minQty: "5", reorderPoint: "10" })).toMatch(/must be below Keep/);
    expect(err({ target: "10", minQty: "5", reorderPoint: "x" })).toMatch(/whole number, or blank/);
  });
  it("accepts the legal shapes, blank Ask at included", () => {
    expect(validateDraft({ hub2: { target: "10", minQty: "5", reorderPoint: "" } })).toEqual({});
    expect(validateDraft({ hub2: { target: "10", minQty: "5", reorderPoint: "0" } })).toEqual({});
    expect(validateDraft({ hub2: { target: "10", minQty: "", reorderPoint: "2" } })).toEqual({});
  });
});

describe("THE PREVIEW GATE — Save is off until a preview matches what is on screen", () => {
  const draft = { hub2: { target: "10", minQty: "5", reorderPoint: "2" } };
  const key = previewKey("caps-beanies", draft);

  it("no preview, no save", () => {
    expect(canSave({ preview: null, previewKeyNow: key, errors: {}, busy: false })).toBe(false);
  });
  it("a matching preview enables it", () => {
    expect(canSave({ preview: { key }, previewKeyNow: key, errors: {}, busy: false })).toBe(true);
  });
  it("editing ANY field invalidates it", () => {
    // A preview of numbers that are no longer displayed is worse than none —
    // it is a reassurance about something else.
    const edited = { hub2: { target: "10", minQty: "5", reorderPoint: "3" } };
    expect(canSave({ preview: { key }, previewKeyNow: previewKey("caps-beanies", edited), errors: {}, busy: false })).toBe(false);
    const another = { hub2: { target: "10", minQty: "6", reorderPoint: "2" } };
    expect(previewKey("caps-beanies", another)).not.toBe(key);
    const removed = {};
    expect(previewKey("caps-beanies", removed)).not.toBe(key);
  });
  it("switching category invalidates it, even with identical numbers", () => {
    expect(previewKey("fitted-caps", draft)).not.toBe(key);
    expect(previewKey("caps-beanies", draft, { perSize: true })).not.toBe(key);
  });
  it("errors and in-flight work both block it", () => {
    expect(canSave({ preview: { key }, previewKeyNow: key, errors: { hub2: "bad" }, busy: false })).toBe(false);
    expect(canSave({ preview: { key }, previewKeyNow: key, errors: {}, busy: true })).toBe(false);
  });
  it("whitespace is not a change", () => {
    expect(previewKey("c", { hub2: { target: " 10 ", minQty: "5", reorderPoint: "2" } }))
      .toBe(previewKey("c", { hub2: { target: "10", minQty: "5", reorderPoint: "2" } }));
  });
});

describe("the changed-fields banner names every edit as old -> new", () => {
  it("renders absent as 'not set', never as 0", () => {
    const out = changedFields(
      { hub2: { target: 10, minQty: 5 } },
      { hub2: { target: 10, minQty: 5, reorderPoint: 2 } });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Ask at not set -> 2");
  });
  it("0 -> 2 is a change, and reads as one", () => {
    const out = changedFields(
      { hub2: { target: 10, minQty: 5, reorderPoint: 0 } },
      { hub2: { target: 10, minQty: 5, reorderPoint: 2 } });
    expect(out[0].text).toBe("Ask at 0 -> 2");
  });
  it("names a location being armed and a location being dropped", () => {
    expect(changedFields(null, { trophy: { target: 4, minQty: 2 } })[0].label).toBe("Started stocking here");
    expect(changedFields({ trophy: { target: 4, minQty: 2 } }, null)[0].label).toBe("Stopped stocking here");
  });
  it("says nothing when nothing changed", () => {
    expect(changedFields(ENTRY, { ...ENTRY })).toEqual([]);
  });
});

describe("next scan — every 15 min, 07:00 to 19:00 SAST", () => {
  const sast = (h, m) => Date.parse(`2026-08-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+02:00`);
  it("rounds up to the next quarter inside the window", () => {
    expect(nextScanAt(sast(9, 1)).label).toBe("09:15");
    expect(nextScanAt(sast(9, 15)).label).toBe("09:30");
    expect(nextScanAt(sast(9, 59)).label).toBe("10:00");
  });
  it("before the window opens, the next scan is 07:00", () => {
    expect(nextScanAt(sast(5, 30)).label).toBe("07:00");
  });
  it("after the day's last run it says tomorrow rather than 'in 13 hours'", () => {
    expect(nextScanAt(sast(19, 5)).at).toBe(null);
    expect(nextScanAt(sast(18, 50)).at).toBe(null);
    expect(nextScanAt(sast(23, 30)).label).toBe("tomorrow from 07:00");
  });
  it("18:45 is the last run of the day", () => {
    expect(nextScanAt(sast(18, 40)).label).toBe("18:45");
  });
  it("garbage in gives 'unknown', not a wrong time", () => {
    expect(nextScanAt(NaN).at).toBe(null);
    expect(nextScanAt(undefined).label).toBe("unknown");
  });
});

describe("the plain-English verdict", () => {
  const model = (o) => ({ totalRequests: 0, totalUnits: 0, centralOnHand: 100, cap: 75, overriddenProducts: 0, legs: [], ...o });
  it("does not read 'nothing to do' when shelves are short but nothing is upstream", () => {
    const v = previewVerdict(model({ legs: [{ parked: 293 }] }));
    expect(v).toMatch(/asks for nothing/);
    expect(v).toMatch(/293 shelves are below target/);
    expect(v).toMatch(/no stock upstream/);
  });
  it("says so when it does not fit the cap", () => {
    expect(previewVerdict(model({ totalRequests: 120, totalUnits: 300 }), { cap: 75 }))
      .toMatch(/more than the 75-per-scan limit/);
  });
  it("says so when Central cannot cover it", () => {
    expect(previewVerdict(model({ totalRequests: 19, totalUnits: 300, centralOnHand: 198 })))
      .toMatch(/Central holds 198, so 102 units cannot be sent/);
  });
  it("repeats the override count, because it is the thing people miss", () => {
    expect(previewVerdict(model({ totalRequests: 5, totalUnits: 10, overriddenProducts: 79 })))
      .toMatch(/79 products are still on their own rows/);
  });
  it("never claims more certainty than a ceiling", () => {
    expect(previewVerdict(model({ totalRequests: 19, totalUnits: 61 }))).toMatch(/at most 19 refills/);
  });
  it("with no model at all it asks for a preview", () => {
    expect(previewVerdict(null)).toMatch(/Run a preview/);
  });
});

describe("the last-change stamp", () => {
  it("counts APPLIED entries only — an aborted save changed nothing", () => {
    const h = [
      { at: 3, status: "aborted_on_drift", by: "x" },
      { at: 2, status: "applied", by: "owner" },
      { at: 1, status: "applied", by: "older" },
    ];
    expect(lastChange(h).by).toBe("owner");
    expect(lastChange([{ at: 1, status: "aborted_on_drift" }])).toBe(null);
    expect(lastChange([])).toBe(null);
    expect(lastChange(undefined)).toBe(null);
  });
});

// ── THE MIRROR ───────────────────────────────────────────────────────────────
// defaultMinQty exists in two places: here (browser, ESM) and in
// functions/lib/category-policy.cjs (server, CommonJS). The bundle must not
// reach into functions/, so it is a copy — and a copy that nothing checks is a
// copy that drifts. This is the check.
it("the client's Minimum default is byte-for-byte the server's", async () => {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const server = req("../../../functions/lib/category-policy.cjs").defaultMinQty;
  for (const t of [0, 1, 2, 3, 5, 8, 10, 15, 99, 100, -1, NaN, null, undefined, "10"]) {
    expect(defaultMinQty(t), `target ${t}`).toBe(server(t));
  }
});

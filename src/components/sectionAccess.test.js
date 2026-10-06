// The owner's section choice: what each choice WRITES, and what any stored
// shape READS back as — including the array RTDB turns { 1: true, 2: true } into.
import { describe, it, expect } from "vitest";
import { SEED_REGISTRY, sectionsFor } from "../utils/networkRegistry";
import { sectionsMap, sectionRecord, accountSections, sectionChoiceOf, sectionPatch, sectionName } from "./sectionAccess";

// What RTDB hands back after `update(users/{uid}, patch)` over `before`:
// null removes a key, and a map with dense integer keys comes back as an array.
function rtdbAfter(before, patch) {
  const out = { ...before };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  if (out.sections && !Array.isArray(out.sections)) {
    const keys = Object.keys(out.sections).map(Number);
    const max = Math.max(...keys);
    if (keys.length > (max + 1) / 2) {
      const arr = []; for (let i = 0; i <= max; i++) arr[i] = out.sections[i] === undefined ? null : out.sections[i];
      out.sections = arr;
    }
  }
  return out;
}

describe("what a choice writes", () => {
  it("Section 1 / Section 2 is a one-key MAP, and removes allSections", () => {
    expect(sectionPatch("1")).toEqual({ sections: { 1: true }, allSections: null });
    expect(sectionPatch("2")).toEqual({ sections: { 2: true }, allSections: null });
    expect(sectionPatch(1)).toEqual(sectionPatch("1"));
  });
  it("Both is allSections, and removes the map — never a two-key map RTDB would turn into an array", () => {
    expect(sectionPatch("both")).toEqual({ sections: null, allSections: true });
  });
  it("never writes an array, and never anything but those three choices", () => {
    for (const c of ["1", "2", "both"]) expect(Array.isArray(sectionPatch(c).sections)).toBe(false);
    for (const bad of ["", "3", null, undefined, "all"]) expect(() => sectionPatch(bad)).toThrow();
  });
});

describe("a choice survives the round trip through RTDB, from any starting record", () => {
  const starts = [
    {}, { destShop: "marathon-pe" }, { destShop: "marathon-pine" }, { allSections: true },
    { sections: { 1: true } }, { sections: { 2: true } }, { sections: [null, true, true] },
  ];
  for (const start of starts) {
    it(`from ${JSON.stringify(start)}`, () => {
      const cases = [["1", [1]], ["2", [2]], ["both", [1, 2]]];
      for (const [choice, sees] of cases) {
        const stored = rtdbAfter(start, sectionPatch(choice));
        expect(sectionChoiceOf(stored), choice).toBe(choice);
        expect(accountSections(SEED_REGISTRY, stored), choice).toEqual(sees);
        // …and the registry's own reader agrees on the stored record as-is,
        // which is what the app's useMySections hands it.
        expect(sectionsFor(SEED_REGISTRY, stored), `raw ${choice}`).toEqual(sees);
      }
    });
  }
});

describe("reading a stored record", () => {
  it("nothing set: follows the shop lock, else both — every account that predates sections", () => {
    expect(sectionChoiceOf({})).toBe("");
    expect(sectionChoiceOf(null)).toBe("");
    expect(accountSections(SEED_REGISTRY, {})).toEqual([1, 2]);
    expect(accountSections(SEED_REGISTRY, null)).toEqual([1, 2]);
    expect(accountSections(SEED_REGISTRY, { destShop: "marathon-pe" })).toEqual([2]);
    expect(accountSections(SEED_REGISTRY, { destShop: "trophy" })).toEqual([2]);
    expect(accountSections(SEED_REGISTRY, { destShop: "marathon-pine" })).toEqual([1]);
    expect(accountSections(SEED_REGISTRY, { destShop: "concrete" })).toEqual([1]);
  });
  it("the owner sees both whatever the record says", () => {
    expect(accountSections(SEED_REGISTRY, { sections: { 1: true } }, { isOwner: true })).toEqual([1, 2]);
  });
  it("a hand-written two-key map, in the ARRAY form RTDB returns it, still reads as both", () => {
    expect(sectionsMap([null, true, true])).toEqual({ 1: true, 2: true });
    expect(sectionChoiceOf({ sections: [null, true, true] })).toBe("both");
    // Without the repair this would fall through to the shop lock: Section 1 only.
    expect(accountSections(SEED_REGISTRY, { sections: [null, true, true], destShop: "marathon-pine" })).toEqual([1, 2]);
    expect(sectionChoiceOf({ sections: [null, true] })).toBe("1");
  });
  it("a map that grants nothing grants nothing — it is not 'unset'", () => {
    expect(accountSections(SEED_REGISTRY, { sections: { 1: false } })).toEqual([]);
    expect(sectionChoiceOf({ sections: { 1: false } })).toBe("");
  });
  it("only real booleans count", () => {
    expect(sectionRecord({ allSections: "true", sections: "1", destShop: 7 })).toEqual({});
    expect(sectionChoiceOf({ sections: { 1: "true" } })).toBe("");
  });
  it("names a section the way the registry does", () => {
    expect(sectionName(SEED_REGISTRY, 1)).toBe("Section 1");
    expect(sectionName(SEED_REGISTRY, 2)).toBe("Section 2");
    expect(sectionName(null, 2)).toBe("Section 2");
  });
});

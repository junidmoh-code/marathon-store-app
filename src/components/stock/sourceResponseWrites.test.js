import { describe, it, expect } from "vitest";
import { buildUndoPatch, clearSourceResponseCells } from "./sourceResponseWrites";

// Records every (path, patch) the code issues, so "one call, both paths" is an
// assertion rather than a claim. A regression to a remove()-per-key shows up as
// two calls; a regression to clearing one key shows up as a one-entry patch.
const spy = (impl) => {
  const calls = [];
  return {
    calls,
    updatePaths: async (path, patch) => { calls.push({ path, patch }); return impl ? impl() : undefined; },
  };
};

const DATE = "2026-08-04";
const PID = "p1781649332106";
const LEGACY = "Nike_SB_Dunk_Low_Green_White";

describe("clearSourceResponseCells — the Source undo write", () => {
  it("clears BOTH keys in exactly ONE multi-path update", async () => {
    const s = spy();
    const res = await clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: [PID, LEGACY], size: "9" });

    expect(s.calls).toHaveLength(1);                       // not one call per key
    expect(s.calls[0].path).toBe(`restock_requests/${DATE}`); // rooted at the shared parent
    expect(s.calls[0].patch).toEqual({                      // both leaves, both null
      [`${PID}/9`]: null,
      [`${LEGACY}/9`]: null,
    });
    expect(res).toEqual({ cleared: 2 });
  });

  it("a pid-less group writes ONE path, not the same path twice", async () => {
    // key === nameKey there; duplicates must collapse.
    const s = spy();
    const res = await clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: [LEGACY, LEGACY], size: "8" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].patch).toEqual({ [`${LEGACY}/8`]: null });
    expect(res).toEqual({ cleared: 1 });
  });

  it("drops absent legacy keys instead of writing an undefined path", async () => {
    const s = spy();
    await clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: [PID, null], size: "7" });
    expect(s.calls[0].patch).toEqual({ [`${PID}/7`]: null });
    // A naive filter-less build would produce "null/7" or "undefined/7".
    expect(Object.keys(s.calls[0].patch).join()).not.toMatch(/null|undefined/);
  });

  it("issues NO write when there is nothing to clear", async () => {
    const s = spy();
    const res = await clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: [null, undefined, ""], size: "9" });
    expect(s.calls).toHaveLength(0);
    expect(res).toEqual({ cleared: 0 });
  });

  it("REJECTS on transport failure — the caller must be able to surface it", async () => {
    // The bug this replaced swallowed the error with console.warn, so a failed
    // undo looked identical to a successful one.
    const s = spy(() => { throw new Error("PERMISSION_DENIED"); });
    await expect(
      clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: [PID, LEGACY], size: "9" })
    ).rejects.toThrow("PERMISSION_DENIED");
  });

  it("accepts a bare key as well as an array", async () => {
    const s = spy();
    await clearSourceResponseCells({ updatePaths: s.updatePaths, date: DATE, productKeys: PID, size: "10" });
    expect(s.calls[0].patch).toEqual({ [`${PID}/10`]: null });
  });
});

describe("buildUndoPatch", () => {
  it("maps each distinct key to a null leaf at that size", () => {
    expect(buildUndoPatch([PID, LEGACY], "9")).toEqual({ [`${PID}/9`]: null, [`${LEGACY}/9`]: null });
  });

  it("returns an empty patch for no usable keys", () => {
    expect(buildUndoPatch([null, "", undefined], "9")).toEqual({});
  });
});

describe("half sizes in the undo patch (2026-08-08)", () => {
  it("encodes the size segment — a raw '.' made the '.' a path separator and Undo cleared nothing", () => {
    expect(buildUndoPatch([PID], "5.5")).toEqual({ [`${PID}/5_5`]: null });
  });
  it("whole and letter sizes are unchanged", () => {
    expect(buildUndoPatch([PID], "9")).toEqual({ [`${PID}/9`]: null });
    expect(buildUndoPatch([PID], "M")).toEqual({ [`${PID}/M`]: null });
  });
});

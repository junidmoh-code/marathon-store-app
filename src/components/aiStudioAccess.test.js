// ─── AI Studio tool access — narrowing invariants (vitest) ───────────────────
// The `ai_photos` grant must open the Photo Studio and NOTHING else. These pin
// the two ways that could quietly break: the filter widening, and a remembered
// tab surviving the filter.

import { describe, it, expect } from "vitest";
import { permittedAiTools, clampAiTool, AI_DEFAULT_TOOL } from "./aiStudioAccess";

const ALL = [
  { id: "photos",   label: "Photo Studio" },
  { id: "stylekit", label: "Style Kit" },
  { id: "names",    label: "Name Cleanup" },
  { id: "reorder",  label: "Reorder" },
];

describe("permittedAiTools", () => {
  it("gives the super-admin every tool, unchanged", () => {
    expect(permittedAiTools(ALL, true)).toEqual(ALL);
  });

  it("gives an ai_photos holder the Photo Studio and nothing else", () => {
    expect(permittedAiTools(ALL, false).map((t) => t.id)).toEqual(["photos"]);
  });

  // Named individually: each is a paid or house-wide tool, and a regression
  // that let any ONE through should say which.
  it.each(["stylekit", "names", "reorder"])("never exposes %s to a grant holder", (id) => {
    expect(permittedAiTools(ALL, false).map((t) => t.id)).not.toContain(id);
  });

  it("treats a missing/garbled tool list as empty rather than throwing", () => {
    expect(permittedAiTools(undefined, false)).toEqual([]);
    expect(permittedAiTools(null, true)).toEqual([]);
  });
});

describe("clampAiTool", () => {
  it("keeps a tab the account may open", () => {
    expect(clampAiTool("reorder", ALL)).toBe("reorder");
  });

  // The real trap: usePersistedTab restoring a super-admin's last tab for a
  // grant holder on the same browser.
  it.each(["names", "reorder", "stylekit"])("collapses a remembered %s to the Photo Studio", (id) => {
    const allowed = permittedAiTools(ALL, false);
    expect(clampAiTool(id, allowed)).toBe(AI_DEFAULT_TOOL);
  });

  it("collapses an unknown or empty tab id", () => {
    expect(clampAiTool("nonsense", ALL)).toBe(AI_DEFAULT_TOOL);
    expect(clampAiTool(undefined, ALL)).toBe(AI_DEFAULT_TOOL);
  });
});

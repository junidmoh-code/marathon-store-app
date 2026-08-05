// ─── THE ENFORCEMENT SWITCH'S REAL VALUE ─────────────────────────────────────
// StyleCodeGate's own tests MOCK this flag so they can exercise both positions.
// That leaves the actual shipped default untested — and the default is the whole
// operational decision here: with it on, and a vendor route that 403s on our
// plan, staff cannot add products at all. This file imports the real module, so
// flipping the default is a deliberate act that has to come with a test change.

import { describe, it, expect } from "vitest";
import { STYLE_CODE_LOOKUP_ENABLED } from "./styleCode";

describe("STYLE_CODE_LOOKUP_ENABLED", () => {
  it("ships OFF — codes are captured, nothing is looked up", () => {
    // Turning this on is safe only once BOTH are true:
    //   • the adapter points at a route our plan can call
    //     (/v3/stockx/products?sku=, not the paid /v3/unified/products)
    //   • enough products carry codes that a collision is actually possible
    // Neither holds today. If you are changing this line, change that comment
    // and confirm both.
    expect(STYLE_CODE_LOOKUP_ENABLED).toBe(false);
  });

  it("is a boolean, so a truthy string can never enable it by accident", () => {
    expect(typeof STYLE_CODE_LOOKUP_ENABLED).toBe("boolean");
  });
});

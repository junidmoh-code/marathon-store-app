// ─── THE ENFORCEMENT SWITCH'S REAL VALUE ─────────────────────────────────────
// StyleCodeGate's own tests MOCK this flag so they can exercise both positions.
// That leaves the actual shipped default untested — and the default is the whole
// operational decision here: with it on, and a vendor route that 403s on our
// plan, staff cannot add products at all. This file imports the real module, so
// flipping the default is a deliberate act that has to come with a test change.

import { describe, it, expect } from "vitest";
import { STYLE_CODE_LOOKUP_ENABLED } from "./styleCode";

describe("STYLE_CODE_LOOKUP_ENABLED", () => {
  it("ships ON — the catalogue is asked, and the answer is confirmed by a human", () => {
    // Deliberately enabled. Of the two conditions this test used to name:
    //   ✓ the adapter points at a route our plan can call — /v3/stockx/products
    //     ?sku= with GOAT as fallback (#317, #319), verified against the live API
    //   ✗ enough products carry codes for a collision to be likely — they do NOT
    //     yet, and that is accepted: the value today is auto-fill, and the
    //     catalogue only fills if the lookup runs. Duplicate detection arrives
    //     on its own as codes accumulate.
    // Every failure path has an escape (#315), so a lookup that breaks can no
    // longer block Add Product. Flipping this back is the rollback.
    expect(STYLE_CODE_LOOKUP_ENABLED).toBe(true);
  });

  it("is a boolean, so a truthy string can never enable it by accident", () => {
    expect(typeof STYLE_CODE_LOOKUP_ENABLED).toBe("boolean");
  });
});

// A recorded refusal is a snapshot, and the intent dies with it — so a block
// outlives the name it was about. These pin when that block stops being true.
import { describe, it, expect } from "vitest";
import { handleFromName, handleInBlockedReason, staleHandleBlock } from "./shopifyHandle";
import { buildHandle } from "../../scripts/shopify/compliance.mjs";

describe("handleFromName", () => {
  it("is the same slug the push builds — ONE implementation", () => {
    for (const n of ["Sneaker Roam Brown", "Low-top sneaker 5.5 Black", "Toggle-lace  runner --- x"]) {
      expect(handleFromName(n)).toBe(buildHandle(n));
    }
  });
  it("returns empty where the push throws, rather than exploding a render", () => {
    expect(handleFromName("!!!")).toBe("");
    expect(() => buildHandle("!!!")).toThrow();
  });
});

describe("handleInBlockedReason", () => {
  const REAL = 'Shopify product gid://shopify/Product/9338746241173 already owns handle "sneaker-black" ' +
               "(an orphan from a crashed run, or a legacy/twin product)";
  it("reads the handle out of the reconciler's own sentence", () => {
    expect(handleInBlockedReason(REAL)).toBe("sneaker-black");
  });
  it("is null for every other kind of refusal", () => {
    expect(handleInBlockedReason("no photo on the record")).toBe(null);
    expect(handleInBlockedReason("canonical Shopify object fails compliance: title: trigger")).toBe(null);
    expect(handleInBlockedReason(null)).toBe(null);
  });
});

describe("staleHandleBlock", () => {
  const REASON = 'Shopify product gid://shopify/Product/1 already owns handle "sneaker-black"';

  it("is STALE when the current name produces a different handle", () => {
    // The screen case: blocked under "Sneaker black", now called something else.
    const v = staleHandleBlock(REASON, "Metal lace-charm triple black leather low-top");
    expect(v.stale).toBe(true);
    expect(v.recordedHandle).toBe("sneaker-black");
    expect(v.wantedHandle).toBe("metal-lace-charm-triple-black-leather-low-top");
  });

  it("is NOT stale when the name still produces the very same handle", () => {
    // The collision is still live. Softening it here would walk somebody
    // straight back into the same refusal.
    expect(staleHandleBlock(REASON, "Sneaker Black").stale).toBe(false);
    expect(staleHandleBlock(REASON, "sneaker---black").stale).toBe(false);
  });

  it("is NOT stale for a refusal that names no handle", () => {
    expect(staleHandleBlock("needs at least one photo", "Anything at all").stale).toBe(false);
  });

  it("is NOT stale when the current name yields no handle at all", () => {
    // An unnameable product has not been fixed; it has no name yet.
    expect(staleHandleBlock(REASON, "").stale).toBe(false);
    expect(staleHandleBlock(REASON, "!!!").stale).toBe(false);
  });
});

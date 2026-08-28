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
  // THE SENTENCES THE RECONCILER ACTUALLY WRITES — both builds. The first
  // version of this work rewrote the refusal wording and left the parser
  // matching a string the code no longer emitted, with these tests green
  // against the dead string. So the wordings are asserted against the source of
  // scripts/shopify/reconcile.mjs below, not typed from memory.
  const LEGACY = 'Shopify product gid://shopify/Product/9338746241173 already owns handle "sneaker-black" ' +
                 "(an orphan from a crashed run, or a legacy/twin product)";
  const CURRENT = 'the web address this name would use ("sneaker-black") already belongs to another ' +
                  'listing on the shop: "Some other product" — it holds 3 units of stock.';
  const CURRENT_RACE = 'the web address this name would use ("sneaker-black") is already taken by ' +
                       'another listing on the shop ("Some other product").';

  it("reads the handle out of the refusal the build LIVE TODAY wrote", () => {
    expect(handleInBlockedReason(LEGACY)).toBe("sneaker-black");
  });
  it("reads the handle out of the refusals THIS build writes", () => {
    expect(handleInBlockedReason(CURRENT)).toBe("sneaker-black");
    expect(handleInBlockedReason(CURRENT_RACE)).toBe("sneaker-black");
  });
  it("is null for every other kind of refusal", () => {
    expect(handleInBlockedReason("no photo on the record")).toBe(null);
    expect(handleInBlockedReason("canonical Shopify object fails compliance: title: trigger")).toBe(null);
    expect(handleInBlockedReason(null)).toBe(null);
  });
});

describe("the parser is pinned to the reconciler's REAL wording", () => {
  // The guard that would have caught the regression: read the refusal template
  // out of the reconciler's source and check the parser can read a message
  // built from it. A future edit to the sentence fails HERE, loudly, instead of
  // silently switching the stale-block feature off.
  it("every handle-collision refusal in reconcile.mjs is parseable", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("../../scripts/shopify/reconcile.mjs", import.meta.url), "utf8");
    const templates = src.match(/the web address this name would use[^`]*/g) || [];
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      // Substitute the one interpolation the handle sits in.
      const message = t.replace("${payload.handle}", "sneaker-black");
      expect(handleInBlockedReason(message)).toBe("sneaker-black");
    }
  });
});

describe("staleHandleBlock", () => {
  const REASON = 'Shopify product gid://shopify/Product/1 already owns handle "sneaker-black"';

  it("prefers the RECORDED FIELD over anything in the prose", () => {
    // The field is written by the code that made the refusal. It cannot be
    // broken by an edit to the sentence, and that is the whole reason it exists.
    const v = staleHandleBlock("some wording nobody has ever parsed", "A brand new name", "sneaker-black");
    expect(v.stale).toBe(true);
    expect(v.recordedHandle).toBe("sneaker-black");
  });

  it("with the field present and MATCHING, the block still stands", () => {
    expect(staleHandleBlock("anything", "Sneaker Black", "sneaker-black").stale).toBe(false);
  });

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

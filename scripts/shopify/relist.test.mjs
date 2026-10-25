import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  parseRelistSnapshot, isListed, numericIdOf, isBirkenstock, onlineUnits, relistVerdict, relistIntent, relistDrift,
} from "./relist.mjs";
import { pushSigFor } from "./mediaSync.mjs";

const GID = "gid://shopify/Product/111";
const shop = (over = {}) => ({
  id: GID, title: "Club Tee Plain", handle: "club-tee-plain", status: "ACTIVE", vendor: "Marathon", published: false,
  mediaIds: ["gid://shopify/MediaImage/1"], variants: [{ id: "gid://shopify/ProductVariant/1", title: "M" }], ...over,
});
const product = (over = {}) => ({ id: "p1", name: "Club tee plain", sizes: ["M"], retailPrice: 199, ...over });
const node = (over = {}) => ({ state: "live", liveState: "off", desiredState: "off", condition: "Excellent — no visible wear", ...over });

describe("parseRelistSnapshot", () => {
  it("joins media and variants to their product, and reads the Online Store flag", () => {
    const jsonl = [
      JSON.stringify({ id: GID, title: "T", handle: "t", status: "ACTIVE", vendor: "V", publishedOnPublication: false }),
      JSON.stringify({ id: "gid://shopify/MediaImage/9", __parentId: GID }),
      JSON.stringify({ id: "gid://shopify/ProductVariant/7", title: "M", __parentId: GID }),
      JSON.stringify({ id: "gid://shopify/Product/222", title: "U", handle: "u", status: "DRAFT", publishedOnPublication: true }),
    ].join("\n");
    const m = parseRelistSnapshot(jsonl);
    expect(m.get(GID)).toMatchObject({ published: false, mediaIds: ["gid://shopify/MediaImage/9"], variants: [{ id: "gid://shopify/ProductVariant/7", title: "M" }] });
    expect(isListed(m.get(GID))).toBe(false);
    expect(isListed(m.get("gid://shopify/Product/222"))).toBe(false); // a published DRAFT is not listed
    expect(isListed({ status: "ACTIVE", published: true })).toBe(true);
  });
  it("numeric id is what the claim index is keyed by", () => {
    expect(numericIdOf(GID)).toBe("111");
    expect(numericIdOf("111")).toBe(null);
  });
});

describe("relistVerdict", () => {
  it("relists a switched-off, graded, in-stock product whose sizes all have variants", () => {
    expect(relistVerdict({ product: product(), node: node(), shop: shop(), units: 1 })).toEqual({ relist: true });
  });
  it("one unit is enough — the 4-unit rule is gone", () => {
    expect(relistVerdict({ product: product(), node: node(), shop: shop(), units: 1 }).relist).toBe(true);
    expect(relistVerdict({ product: product(), node: node(), shop: shop(), units: 0 }).code).toBe("no-stock");
  });
  it("Birkenstock is skipped by name, brand or the Shopify title", () => {
    expect(relistVerdict({ product: product({ name: "BIRKENSTOCK Arizona" }), node: node(), shop: shop(), units: 5 }).code).toBe("birkenstock");
    expect(relistVerdict({ product: product({ brand: "Birkenstock" }), node: node(), shop: shop(), units: 5 }).code).toBe("birkenstock");
    expect(relistVerdict({ product: product(), node: node(), shop: shop({ title: "Birkenstock Boston" }), units: 5 }).code).toBe("birkenstock");
    expect(isBirkenstock({ name: "Birkestock typo" }, {})).toBe(false); // the alias list is the brand registry's job; this is the strict word
  });
  it("never relists a size that would need a NEW variant", () => {
    const v = relistVerdict({ product: product({ sizes: ["M", "L"] }), node: node(), shop: shop(), units: 3 });
    expect(v.code).toBe("size-no-variant");
    expect(v.why).toMatch(/L/);
  });
  it("skips a product whose photo list changed while it was off (images are frozen)", () => {
    const n = node({ media: { a: { id: "a", type: "photo", url: "https://firebasestorage.googleapis.com/v0/b/x/o/products%2Fp1%2Fshopify%2Fa.jpg?alt=media", pos: 0 } }, mediaSyncedSig: "old" });
    expect(relistVerdict({ product: product(), node: n, shop: shop(), units: 3 }).code).toBe("photos-changed");
    const synced = { ...n, mediaSyncedSig: pushSigFor(n, product()) };
    expect(relistVerdict({ product: product(), node: synced, shop: shop(), units: 3 }).relist).toBe(true);
  });
  it("blocked, archived, never-live, ungraded, merged and on-already are skipped with a reason", () => {
    expect(relistVerdict({ product: product(), node: node({ state: "blocked", blockedReason: "x" }), shop: shop(), units: 3 }).why).toMatch(/blocked.*x/);
    expect(relistVerdict({ product: product(), node: node(), shop: shop({ status: "ARCHIVED" }), units: 3 }).code).toBe("archived");
    expect(relistVerdict({ product: product(), node: node({ state: "awaiting" }), shop: shop(), units: 3 }).code).toBe("never-live");
    expect(relistVerdict({ product: product(), node: node({ condition: null }), shop: shop(), units: 3 }).code).toBe("no-condition");
    expect(relistVerdict({ product: product({ mergedInto: "p2" }), node: node(), shop: shop(), units: 3 }).code).toBe("merged");
    expect(relistVerdict({ product: product(), node: node({ desiredState: "on" }), shop: shop(), units: 3 }).code).toBe("app-on");
    expect(relistVerdict({ product: null, node: node(), shop: shop(), units: 3 }).code).toBe("no-product");
  });
});

describe("onlineUnits", () => {
  it("counts only the website's locations (Pine never counts)", () => {
    expect(onlineUnits({ pe: { p1: { M: { qty: 1 } } }, "marathon-pine": { p1: { M: { qty: 9 } } } }, "p1", ["M"])).toBe(1);
    expect(onlineUnits({}, "p1", undefined)).toBe(0);
  });
});

describe("relistIntent", () => {
  it("sets desiredState on + the one-shot relistKeep flag, and re-checks the server's value", () => {
    const out = relistIntent(node(), { now: 5, by: "s", gid: GID });
    expect(out).toMatchObject({ desiredState: "on", relistKeep: 5, relistGid: GID, updatedAt: 5, updatedBy: "s", blockedReason: null });
    expect(relistIntent(node({ liveState: "on", desiredState: "on" }), { now: 5, by: "s", gid: GID })).toBeUndefined();
    expect(relistIntent(node({ state: "blocked" }), { now: 5, by: "s", gid: GID })).toBeUndefined();
    // null is the SDK's first local guess — returned as null so it reads the server, never aborted.
    expect(relistIntent(null, { now: 5, by: "s", gid: GID })).toBeNull();
    expect(relistIntent(node(), { now: 5, by: "s" })).toBeUndefined(); // no planned gid, no intent
  });
});

describe("relistDrift — Junid's stop condition", () => {
  it("is empty when title, handle, media and variant ids are unchanged (order-insensitive)", () => {
    const b = shop({ mediaIds: ["a", "b"] });
    expect(relistDrift(b, { ...b, mediaIds: ["b", "a"], published: true })).toEqual([]);
  });
  it("names every change", () => {
    const b = shop();
    const moved = relistDrift(b, { ...b, title: "New", mediaIds: [], variants: [{ id: "x", title: "M" }] });
    expect(moved.join(" | ")).toMatch(/title.*New/);
    expect(moved.join(" | ")).toMatch(/media/);
    expect(moved.join(" | ")).toMatch(/variant ids/);
    expect(relistDrift(b, undefined)).toEqual(["the product is gone from Shopify"]);
  });
});

// ── THE RECONCILER'S "RELIST AS IT IS" BRANCH, pinned by source ───────────────
// reconcile.mjs is a top-level script; its sibling safety tests pin it by text.
describe("reconcile.mjs relist branch", () => {
  const SRC = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
  it("the field productUpdate (title/description) runs only when NOT relisting", () => {
    const i = SRC.indexOf("if (gid && relistAsIs) {");
    const j = SRC.indexOf("productUpdate(product: $input) { product { id } userErrors");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i); // the field update sits in the else-branch after the relist guard
    expect(SRC.slice(i, j)).toMatch(/\} else if \(gid\) \{/);
  });
  it("no media plan, no media sync and no fingerprint re-sync when relisting", () => {
    expect(SRC).toMatch(/let mediaPlan = \[\];\n\s+if \(!relistAsIs\) \{/);
    expect(SRC).toMatch(/const mediaModel = !relistAsIs && hasMediaModel\(fresh\);\n\s+if \(relistAsIs\) \{/);
    expect(SRC).toMatch(/const planFp = relistAsIs \? null : mediaFingerprint\(mediaPlan\);/);
  });
  it("relisting only applies to a mapped product, within a day, for the gid it was planned against, with photos unchanged", () => {
    expect(SRC).toMatch(/const relistAsIs = Number\(fresh\.relistKeep\) > 0 && !!mapNode\?\.shopifyProductId &&\n\s+runStartedAt - Number\(fresh\.relistKeep\) < RELIST_KEEP_TTL_MS;/);
    expect(SRC).toMatch(/if \(fresh\.relistGid !== mapNode\.shopifyProductId\) \{\n\s+await refuse\(/);
    expect(SRC).toMatch(/if \(hasMediaModel\(fresh\) && fresh\.mediaSyncedSig !== pushSigFor\(fresh, product\)\) \{\n\s+await refuse\(/);
  });
  it("any page edit cancels a pending relist-as-it-is (every mutator's stamp clears the flag)", async () => {
    const { desiredStateMutator } = await import("../../src/components/shopify/publishMutators.js");
    const out = desiredStateMutator({ state: "live", liveState: "off", condition: "Excellent — no visible wear", relistKeep: 5, relistGid: GID }, { want: "off" }, { now: 9, uid: "u" });
    expect(out.next.relistKeep).toBeNull();
    expect(out.next.relistGid).toBeNull();
    // Every mutator that returns a `next` spreads stamp(ctx) — none can skip it.
    const MSRC = readFileSync(new URL("../../src/components/shopify/publishMutators.js", import.meta.url), "utf8");
    const bodies = MSRC.split(/\nexport function /).slice(1).filter((b) => /Mutator\(/.test(b.split("\n")[0]));
    expect(bodies.length).toBeGreaterThanOrEqual(8);
    for (const b of bodies) {
      const nexts = b.match(/next: \{/g)?.length || 0;
      const stamps = b.match(/\.\.\.stamp\(ctx\)/g)?.length || 0;
      expect({ fn: b.split("(")[0], stamps: stamps >= nexts }).toEqual({ fn: b.split("(")[0], stamps: true });
    }
    expect(MSRC).toMatch(/const stamp = \(ctx\) => \(\{ updatedAt: ctx\.now, updatedBy: ctx\.uid \?\? null, relistKeep: null, relistGid: null \}\);/);
  });
  it("a relist with no stock left at apply time is refused, not listed", () => {
    expect(SRC).toMatch(/if \(relistAsIs && !Object\.values\(totals\)\.some\(\(q\) => q > 0\)\) \{/);
  });
  it("the tick advertises relistKeep so the relist script can refuse an old reconciler", () => {
    expect(SRC).toMatch(/await writeReconcileState\(db, \{[\s\S]{0,1500}?\n\s+features: \{ relistKeep: 1 \},/);
  });
  it("the flag is one-shot: confirm and block both clear it", () => {
    const PN = readFileSync(new URL("./publishNode.mjs", import.meta.url), "utf8");
    expect(PN.match(/relistKeep: null/g)?.length).toBe(2);
    expect(PN.match(/relistGid: null/g)?.length).toBe(2);
  });
});

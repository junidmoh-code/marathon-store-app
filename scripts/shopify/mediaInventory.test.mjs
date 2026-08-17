// ─── Photos + inventory, pure parts pinned ───────────────────────────────────
import { describe, it, expect } from "vitest";
import { buildMediaPlan, mediaFingerprint } from "./media.mjs";
import { networkTotals, untrackedVariants, TRACKED_VARIANT, enforceTracking } from "./inventory.mjs";

describe("buildMediaPlan", () => {
  const product = {
    photoUrl: "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/photo.jpg?alt=media&token=t",
    gallery: [
      "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/angle1.jpg?alt=media",
      "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/photo.jpg?alt=media&token=t", // dup of hero
    ],
  };
  it("hero first, gallery after, duplicates dropped, alt = cleaned name", () => {
    const plan = buildMediaPlan(product, "Low-top sneaker black");
    expect(plan).toHaveLength(2);
    expect(plan[0].originalSource).toContain("photo.jpg");
    expect(plan[1].originalSource).toContain("angle1.jpg");
    for (const m of plan) {
      expect(m.alt).toBe("Low-top sneaker black");
      expect(m.mediaContentType).toBe("IMAGE");
    }
  });
  it("refuses a photo-less product — imageless products never push", () => {
    expect(() => buildMediaPlan({}, "Sneaker black")).toThrow(/no photoUrl/);
    expect(() => buildMediaPlan({ photoUrl: "" }, "Sneaker black")).toThrow(/no photoUrl/);
  });
  it("refuses non-HTTPS sources and a missing cleaned title", () => {
    expect(() => buildMediaPlan({ photoUrl: "http://insecure/p.jpg" }, "Sneaker")).toThrow(/HTTPS/);
    expect(() => buildMediaPlan(product, "")).toThrow(/cleaned title/);
  });
  it("the reviewed publishing set replaces the record's photos wholesale, in its order", () => {
    const publish = [
      "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/gen_clean.jpg?alt=media",
      "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/angle1.jpg?alt=media",
    ];
    const plan = buildMediaPlan(product, "Low-top sneaker black", publish);
    // photo.jpg (the record's hero) is OUT — a removal in the page must
    // actually remove from the push, so there is no fallback mixing.
    expect(plan.map((m) => m.originalSource)).toEqual(publish);
    expect(plan[0].alt).toBe("Low-top sneaker black");
  });
  it("a null/empty publishing set falls back to photoUrl + gallery", () => {
    expect(buildMediaPlan(product, "Sneaker black", null)).toHaveLength(2);
    expect(buildMediaPlan(product, "Sneaker black", [])).toHaveLength(2);
  });
  it("the publishing set passes the same host allowlist as record photos", () => {
    expect(() => buildMediaPlan(product, "Sneaker black", ["https://evil.example.com/x.jpg"]))
      .toThrow(/not the app's Firebase Storage/);
  });
  it("mediaFingerprint: stable for the same ordered sources, different when order changes", () => {
    const a = buildMediaPlan(product, "Sneaker black");
    const b = buildMediaPlan(product, "Sneaker black");
    expect(mediaFingerprint(a)).toBe(mediaFingerprint(b));
    const reordered = [...a].reverse();
    expect(mediaFingerprint(reordered)).not.toBe(mediaFingerprint(a));
  });
});

describe("networkTotals — one sellable pool", () => {
  // Real /stock shape: movement-stamped cell objects (applyMovement), with a
  // bare-number tolerance for legacy cells.
  const cell = (qty) => ({ qty, lastType: "received", mv: "-Ox123", v: 1 });
  const stock = {
    "marathon-pe": { p1: { "8": cell(3), "9": cell(1), "5_5": cell(2) } },
    hub2:          { p1: { "8": cell(2), "9": cell(-4) } },   // negative clamps to 0
    in_transit:    { p1: { "8": 100 } },                      // NOT sellable — excluded
    trophy:        { p2: { "8": cell(99) } },                 // other product — ignored
  };
  it("sums every SELLABLE location per size, clamping negative cells to 0", () => {
    expect(networkTotals(stock, "p1", ["8", "9", "5.5"])).toEqual({
      "8": 5, "9": 1, "5_5": 2,
    });
  });
  it("in_transit stock never counts as sellable", () => {
    expect(networkTotals({ in_transit: { p1: { "8": cell(9) } } }, "p1", ["8"])).toEqual({ "8": 0 });
  });
  it("sizes not in the record are excluded; missing cells read 0", () => {
    const totals = networkTotals(stock, "p1", ["8"]);
    expect(totals).toEqual({ "8": 5 });
    expect(networkTotals(stock, "p1", ["12"])).toEqual({ "12": 0 });
  });
  it("one-size uses the '_' sentinel cell", () => {
    const t = networkTotals({ pe: { p3: { _: cell(5) } } }, "p3", ["_"]);
    expect(t).toEqual({ _: 5 });
  });
  it("empty tree → zeros, never a crash", () => {
    expect(networkTotals(null, "p1", ["8"])).toEqual({ "8": 0 });
  });
});

// ─── INVENTORY TRACKING ──────────────────────────────────────────────────────
// The defect this pins: every one of the 389 live variants on 2026-08-16 had
// inventoryItem.tracked === false, because productSet leaves it at its FALSE
// default and the reconciler never set it. Shopify therefore ignored every
// quantity setAvailable had been writing — nothing could show sold out and the
// shop could oversell. inventoryPolicy was already DENY everywhere; tracking
// was the whole defect.
describe("TRACKED_VARIANT — what every pushed variant must carry", () => {
  it("is tracked and DENY", () => {
    expect(TRACKED_VARIANT).toEqual({ inventoryPolicy: "DENY", inventoryItem: { tracked: true } });
  });

  it("carries NO cost — InventoryItemInput accepts one, and cost is stockPrice", () => {
    // stockPrice is internal (and not even a real cost — it is a B2B wholesale
    // selling price). It must never reach Shopify through this door.
    expect(Object.keys(TRACKED_VARIANT.inventoryItem)).toEqual(["tracked"]);
  });
});

describe("untrackedVariants — which variants need fixing", () => {
  const ok = { variantId: "gid://shopify/ProductVariant/1", tracked: true, inventoryPolicy: "DENY" };

  it("a correct variant costs nothing — no mutation is planned for it", () => {
    expect(untrackedVariants([ok, { ...ok, variantId: "v2" }])).toEqual([]);
  });

  it("catches the live defect: tracked false, policy already DENY", () => {
    const live = { variantId: "v", tracked: false, inventoryPolicy: "DENY" };
    expect(untrackedVariants([live])).toEqual([live]);
  });

  it("catches a CONTINUE policy even when tracking is on — that one oversells too", () => {
    const oversell = { variantId: "v", tracked: true, inventoryPolicy: "CONTINUE" };
    expect(untrackedVariants([oversell])).toEqual([oversell]);
  });

  it("treats an absent or non-boolean tracked as untracked, never as fine", () => {
    // A read-back that did not ask for the field, or an API shape change, must
    // fail towards "fix it", not towards "ship it".
    for (const tracked of [undefined, null, "true", 1]) {
      expect(untrackedVariants([{ variantId: "v", tracked, inventoryPolicy: "DENY" }])).toHaveLength(1);
    }
  });

  it("tolerates junk without throwing", () => {
    expect(untrackedVariants(null)).toEqual([]);
    expect(untrackedVariants(undefined)).toEqual([]);
    expect(untrackedVariants([])).toEqual([]);
  });

  it("returns only the wrong ones, so the mutation is as small as the damage", () => {
    const bad = { variantId: "v2", tracked: false, inventoryPolicy: "DENY" };
    expect(untrackedVariants([ok, bad, { ...ok, variantId: "v3" }])).toEqual([bad]);
  });
});

// ─── enforceTracking's echo check ────────────────────────────────────────────
// This is the gate between a listing and overselling, so it verifies the
// mutation's OWN response rather than trusting an empty userErrors. Two checks,
// because either alone has a blind spot: scanning what came back catches a
// variant returned still untracked, and comparing the id sets catches one
// DROPPED from the response entirely — which bulk mutations can do under
// concurrent modification, with no userError to show for it (review finding,
// 2026-08-16).
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";
const echo = (vs) => async () => ({
  productVariantsBulkUpdate: {
    productVariants: vs,
    userErrors: [],
  },
});
const good = (id) => ({ id, inventoryPolicy: "DENY", inventoryItem: { tracked: true } });

describe("enforceTracking", () => {
  it("sends nothing when there is nothing to fix", async () => {
    let called = false;
    const gql = async () => { called = true; return {}; };
    expect(await enforceTracking(gql, "gid://shopify/Product/1", [])).toEqual({ fixed: 0 });
    expect(called).toBe(false);
  });

  it("asks for tracked + DENY on exactly the variants it was given", async () => {
    let sent = null;
    const gql = async (_q, vars) => { sent = vars; return (await echo([good(V1), good(V2)])()); };
    await enforceTracking(gql, "gid://shopify/Product/1", [V1, V2]);
    expect(sent.productId).toBe("gid://shopify/Product/1");
    expect(sent.variants).toEqual([{ id: V1, ...TRACKED_VARIANT }, { id: V2, ...TRACKED_VARIANT }]);
  });

  it("throws on userErrors", async () => {
    const gql = async () => ({ productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: "id", message: "nope" }] } });
    await expect(enforceTracking(gql, "p", [V1])).rejects.toThrow(/userErrors/);
  });

  it("throws when a variant comes back STILL untracked", async () => {
    const gql = echo([{ id: V1, inventoryPolicy: "DENY", inventoryItem: { tracked: false } }]);
    await expect(enforceTracking(gql, "p", [V1])).rejects.toThrow(/did not take/);
  });

  it("throws when a requested variant is DROPPED from the response — no error, no entry", async () => {
    // The blind spot: V2 is simply absent. Scanning what came back sees only a
    // correct V1 and would have returned success while V2 could still oversell.
    const gql = echo([good(V1)]);
    await expect(enforceTracking(gql, "p", [V1, V2])).rejects.toThrow(/did not mention/);
  });

  it("reports the count it actually saw applied, not the count it asked for", async () => {
    expect(await enforceTracking(echo([good(V1), good(V2)]), "p", [V1, V2])).toEqual({ fixed: 2 });
  });
});

describe("TRACKED_VARIANT is frozen", () => {
  it("cannot be mutated — it is shared by reference across every variant input", () => {
    // { id, ...TRACKED_VARIANT } shares the SAME inner inventoryItem object
    // across the reconciler, round-trip and the backfill. A line that added a
    // `cost` to it would leak stockPrice into every push at once. Frozen, that
    // is a thrown error in a module (strict mode) instead of a silent global.
    expect(Object.isFrozen(TRACKED_VARIANT)).toBe(true);
    expect(Object.isFrozen(TRACKED_VARIANT.inventoryItem)).toBe(true);
    expect(() => { TRACKED_VARIANT.inventoryItem.cost = "1.00"; }).toThrow();
    expect(TRACKED_VARIANT.inventoryItem).toEqual({ tracked: true });
  });
});

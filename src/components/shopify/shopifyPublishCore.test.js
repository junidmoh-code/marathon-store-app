// ─── Shopify Publishing — core contracts pinned ──────────────────────────────
// The 2026-08-14 state model: awaiting | live | blocked, on/off for live
// products, desiredState intent + pending derivation. The page and the
// owner-run scripts must never disagree on these.
import { describe, it, expect } from "vitest";
import {
  CONDITIONS, PUBLISH_STATES, canUseShopifyPublish, canGoLive, normalizedState,
  normalizedFields, isOn, isPendingSwitch, checkCleanName, blockedReason, blockStatus,
  STATE_FILTERS, reviewStateFor, matchesStateFilter, batchSelectBlocker, effectivePhotoList,
  isPublishableProduct, PRICE_RECORD_BLOCKER,
} from "./shopifyPublishCore";
import { RECONCILE_MAX_APPLY, normalizePhotoList } from "./publishShared";
import { CONDITIONS as SCRIPT_CONDITIONS } from "../../../scripts/shopify/compliance.mjs";
import { PUBLISH_STATES as SCRIPT_STATES } from "../../../scripts/shopify/publishNode.mjs";

describe("cross-surface contracts", () => {
  it("page and scripts agree on the condition values and states", () => {
    // CONDITIONS is now SINGLE-SOURCED in publishShared.js and re-exported by
    // both sides, so comparing the two exports to each other would compare an
    // array with itself and pass no matter what. Pin the LITERAL VALUES
    // instead — that still fails if anyone edits the list, and it is what the
    // description template, the page's chips and the reconciler's apply-time
    // gate all have to agree on (reviewer finding, 2026-08-14).
    const EXPECTED = [
      "Excellent — no visible wear",
      "Very good — light cosmetic marks",
      "Good — visible wear, priced accordingly",
    ];
    expect(CONDITIONS).toEqual(EXPECTED);
    expect(SCRIPT_CONDITIONS).toEqual(EXPECTED);
    expect(PUBLISH_STATES).toEqual(SCRIPT_STATES);
    expect(PUBLISH_STATES).toEqual(["awaiting", "live", "blocked"]);
  });
});

describe("gate — mirrors the console write rule", () => {
  it("super-admin and stockRole admin pass; everyone else sees nothing", () => {
    expect(canUseShopifyPublish({ isSuperAdmin: true, stockRole: null })).toBe(true);
    expect(canUseShopifyPublish({ isSuperAdmin: false, stockRole: "admin" })).toBe(true);
    expect(canUseShopifyPublish({ isSuperAdmin: false, stockRole: "shop" })).toBe(false);
    expect(canUseShopifyPublish({ isSuperAdmin: false, stockRole: null })).toBe(false);
    expect(canUseShopifyPublish(null)).toBe(false);
  });
});

describe("the condition gate — NO default, live is unreachable without one", () => {
  it("canGoLive only with one of the three grades", () => {
    for (const c of CONDITIONS) expect(canGoLive({ condition: c })).toBe(true);
    expect(canGoLive({})).toBe(false);
    expect(canGoLive({ condition: "Mint" })).toBe(false);
    expect(canGoLive(null)).toBe(false);
  });
  it("blockedReason: condition gate wins, then the reconciler's recorded reason", () => {
    expect(blockedReason({ state: "blocked" })).toMatch(/Condition not set/);
    expect(blockedReason({ state: "blocked", condition: CONDITIONS[0], blockedReason: "validator: brand trigger in tags[0]" }))
      .toBe("validator: brand trigger in tags[0]");
    expect(blockedReason({ state: "blocked", condition: CONDITIONS[0] })).toBeNull();
    expect(blockedReason({ state: "awaiting" })).toBeNull();
    expect(blockedReason({ state: "live", liveState: "off" })).toBeNull();
    expect(blockedReason(null)).toBeNull();
  });
});

describe("legacy state tolerance — pre-migration nodes still read correctly", () => {
  it("none/nominated → awaiting, draft → live (off), live → live (on)", () => {
    expect(normalizedState({ state: "none" })).toBe("awaiting");
    expect(normalizedState({ state: "nominated" })).toBe("awaiting");
    expect(normalizedState({ state: "draft" })).toBe("live");
    expect(normalizedState({ state: "live" })).toBe("live");
    expect(normalizedState({ state: "blocked" })).toBe("blocked");
    expect(normalizedState(null)).toBe("awaiting");
    // legacy draft existed on Shopify but was never published
    expect(isOn({ state: "draft" })).toBe(false);
    expect(isOn({ state: "live" })).toBe(true);
  });
  it("normalizedFields pins liveState when a write upgrades a legacy state string", () => {
    // "draft" → live must land with liveState OFF, or the legacy-live
    // fallback in isOn would read the upgraded node as ON.
    expect(normalizedFields({ state: "draft" })).toEqual({ state: "live", liveState: "off" });
    expect(normalizedFields({ state: "live" })).toEqual({ state: "live", liveState: "on" });
    expect(normalizedFields({ state: "live", liveState: "off" })).toEqual({ state: "live", liveState: "off" });
    expect(normalizedFields({ state: "none" })).toEqual({ state: "awaiting" });
    expect(normalizedFields({ state: "blocked" })).toEqual({ state: "blocked" });
    expect(normalizedFields(null)).toEqual({ state: "awaiting" });
  });
});

describe("on/off + pending — intent vs confirmed", () => {
  it("isOn is confirmed channel state, live products only", () => {
    expect(isOn({ state: "live", liveState: "on" })).toBe(true);
    expect(isOn({ state: "live", liveState: "off" })).toBe(false);
    expect(isOn({ state: "awaiting", desiredState: "on" })).toBe(false); // intent is not confirmation
    expect(isOn({ state: "blocked", liveState: "on" })).toBe(false);
    expect(isOn(null)).toBe(false);
  });
  it("pending exactly while desiredState disagrees with the confirmed state", () => {
    expect(isPendingSwitch({ state: "awaiting", desiredState: "on" })).toBe(true);   // publish requested
    expect(isPendingSwitch({ state: "live", liveState: "off", desiredState: "on" })).toBe(true);
    expect(isPendingSwitch({ state: "live", liveState: "on", desiredState: "off" })).toBe(true);
    expect(isPendingSwitch({ state: "live", liveState: "on", desiredState: "on" })).toBe(false);
    expect(isPendingSwitch({ state: "live", liveState: "off", desiredState: "off" })).toBe(false);
    expect(isPendingSwitch({ state: "awaiting" })).toBe(false);                       // no intent expressed
    expect(isPendingSwitch({ state: "awaiting", desiredState: "off" })).toBe(false);  // cancelled publish
    expect(isPendingSwitch(null)).toBe(false);
  });
});

describe("batch selection — cap and eligibility", () => {
  it("the batch cap is the reconciler's per-run cap — one constant, both read it", () => {
    // The UI states this cap and reconcile.mjs imports the same value; a
    // regression here means the page can promise a batch one run won't take.
    expect(RECONCILE_MAX_APPLY).toBe(25);
  });
  it("batchSelectBlocker mirrors the publish gates and says why", () => {
    const node = { state: "awaiting", condition: CONDITIONS[0] };
    expect(batchSelectBlocker(node, "Low-top sneaker black", 1)).toBeNull();
    expect(batchSelectBlocker({ state: "awaiting" }, "Low-top sneaker black", 1)).toMatch(/condition/);
    expect(batchSelectBlocker(node, "", 1)).toMatch(/name/);
    expect(batchSelectBlocker(node, "Nike Air Force 1", 1)).toMatch(/name/); // trigger ⇒ not a valid name
    expect(batchSelectBlocker(null, "Low-top sneaker black", 1)).toMatch(/condition/);
    // imageless never ships — surfaced at selection, not as a blocked row
    // minutes after a script run
    expect(batchSelectBlocker(node, "Low-top sneaker black", 0)).toMatch(/photo/);
  });
});

describe("publishing photos — the effective set", () => {
  it("normalizePhotoList accepts array and object shapes, ordered numerically, deduped", () => {
    expect(normalizePhotoList(["https://a", "https://b", "https://a", "", null])).toEqual(["https://a", "https://b"]);
    // RTDB hands back an object when the 0..n keys stopped being contiguous
    expect(normalizePhotoList({ 0: "https://a", 2: "https://c", 10: "https://k" }))
      .toEqual(["https://a", "https://c", "https://k"]);
    expect(normalizePhotoList(null)).toBeNull();
    expect(normalizePhotoList([])).toBeNull();
    expect(normalizePhotoList(["", null])).toBeNull();
    expect(normalizePhotoList("https://a")).toBeNull(); // scalar garbage is not a set
  });
  it("effectivePhotoList: custom set wins whole; else photoUrl + gallery in push order", () => {
    const p = { photoUrl: "https://hero", gallery: ["https://g1", "https://hero", "https://g2"] };
    expect(effectivePhotoList(p, null)).toEqual({ photos: ["https://hero", "https://g1", "https://g2"], custom: false });
    expect(effectivePhotoList(p, { photos: ["https://g2", "https://hero"] }))
      .toEqual({ photos: ["https://g2", "https://hero"], custom: true });
    expect(effectivePhotoList({}, null)).toEqual({ photos: [], custom: false });
  });
});

describe("checkCleanName — the LIVE input trigger check", () => {
  it("accepts a compliant name", () => {
    expect(checkCleanName("Low-top sneaker black")).toEqual({ ok: true, problems: [] });
  });
  it("rejects triggers as Junid types, naming them", () => {
    const r = checkCleanName("Nike Air Force 1");
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/brand trigger/);
  });
  it("rejects concatenated triggers and enforces the title guards", () => {
    expect(checkCleanName("airforce1 white").ok).toBe(false);
    expect(checkCleanName("").ok).toBe(false);
    expect(checkCleanName("9060 grey").ok).toBe(false);
    expect(checkCleanName("ab").ok).toBe(false);
  });
});

describe("reviewStateFor — the page's row/filter state", () => {
  it("no node, or an unapproved awaiting node, is awaiting review", () => {
    expect(reviewStateFor(null)).toBe("awaiting");
    expect(reviewStateFor(undefined)).toBe("awaiting");
    expect(reviewStateFor({ state: "awaiting" })).toBe("awaiting");
    // grade-only node: the name was never signed off
    expect(reviewStateFor({ state: "awaiting", condition: CONDITIONS[0] })).toBe("awaiting");
  });
  it("an approval stamp on an awaiting node reads approved", () => {
    expect(reviewStateFor({ state: "awaiting", nameApprovedAt: 1755000000000 })).toBe("approved");
    // legacy pre-migration shape
    expect(reviewStateFor({ state: "none", nameApprovedAt: 1755000000000 })).toBe("approved");
  });
  it("live and blocked pass through", () => {
    expect(reviewStateFor({ state: "live", liveState: "on" })).toBe("live");
    expect(reviewStateFor({ state: "live", liveState: "off" })).toBe("live");
    expect(reviewStateFor({ state: "blocked" })).toBe("blocked");
  });
  it("every non-all filter key is a reachable review state, or the node-answered proposal lane", () => {
    const reachable = new Set(["awaiting", "approved", "live", "blocked"]);
    for (const { key } of STATE_FILTERS) {
      if (key === "all" || key === "proposed") continue; // "proposed" is answered from the NODE, not a review state
      expect(reachable.has(key)).toBe(true);
    }
    // and the lane IS in the list — the filter chip has to exist for the
    // vision run's output to be reachable at all.
    expect(STATE_FILTERS.some((f) => f.key === "proposed")).toBe(true);
  });
  it("matchesStateFilter — all matches everything, others match exactly", () => {
    expect(matchesStateFilter("all", "awaiting")).toBe(true);
    expect(matchesStateFilter("all", "live")).toBe(true);
    expect(matchesStateFilter("awaiting", "awaiting")).toBe(true);
    expect(matchesStateFilter("awaiting", "approved")).toBe(false);
    expect(matchesStateFilter("blocked", "blocked")).toBe(true);
    expect(matchesStateFilter("live", "awaiting")).toBe(false);
  });
});

// ── Not merchandise ──────────────────────────────────────────────────────────
describe("isPublishableProduct — price records never reach the storefront", () => {
  const PRICE = { id: "p1785900000000", name: "Entry 30 Line", priceProduct: true, category: "Price Products", subcategory: "Price Products" };
  const READY = { state: "awaiting", condition: "Very good — light cosmetic marks" };

  it("a price record is not publishable", () => {
    expect(isPublishableProduct(PRICE)).toBe(false);
  });

  it("a real product is", () => {
    expect(isPublishableProduct({ id: "p1", name: "Slide brown", category: "Footwear" })).toBe(true);
    expect(isPublishableProduct(null)).toBe(true); // absent record is not a price record
  });

  it("batchSelectBlocker refuses it AHEAD of every fixable gate", () => {
    // Everything else about this row is perfect — grade set, valid name, a
    // photo. It must still refuse, and with the not-merchandise reason, not a
    // "go fix your grade" one.
    expect(batchSelectBlocker(READY, "Entry 30 Line", 1, PRICE)).toBe(PRICE_RECORD_BLOCKER);
    // And it wins even when the fixable gates would also fire.
    expect(batchSelectBlocker({ state: "awaiting" }, "", 0, PRICE)).toBe(PRICE_RECORD_BLOCKER);
  });

  it("the same call on a real product is unaffected", () => {
    const real = { id: "p1", name: "Slide brown", category: "Footwear" };
    expect(batchSelectBlocker(READY, "Slide brown", 1, real)).toBeNull();
    expect(batchSelectBlocker(READY, "Slide brown", 0, real)).toBe("needs at least one photo");
  });

  it("callers that pass no product keep the old three-argument behaviour", () => {
    expect(batchSelectBlocker(READY, "Slide brown", 1)).toBeNull();
    expect(batchSelectBlocker({ state: "awaiting" }, "Slide brown", 1)).toBe("set a condition grade first");
  });
});


// ─── A BLOCK IS ONLY TRUE WHILE THE NAME IT WAS ABOUT IS ─────────────────────
describe("blockStatus — a refusal recorded under a name the product no longer has", () => {
  const HANDLE_REASON =
    'Shopify product gid://shopify/Product/9338746241173 already owns handle "sneaker-black" ' +
    "(an orphan from a crashed run, or a legacy/twin product)";
  const COND = CONDITIONS[0];

  it("stands down when the current name produces a different handle", () => {
    const v = blockStatus({ state: "blocked", condition: COND, blockedReason: HANDLE_REASON },
                          "Metal lace-charm triple black leather low-top");
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe(null);
    expect(v.staleNote).toMatch(/earlier attempt under a different name/);
  });

  it("STANDS when the name still produces the handle that collided", () => {
    const v = blockStatus({ state: "blocked", condition: COND, blockedReason: HANDLE_REASON }, "Sneaker black");
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe(HANDLE_REASON);
    expect(v.staleNote).toBe(null);
  });

  it("STANDS for every refusal a rename does not answer", () => {
    for (const reason of [
      "needs at least one photo",
      "canonical Shopify object fails compliance: title: trigger \"nike\"",
      "catalogue sizes with no Shopify variant: 9, 10",
    ]) {
      const v = blockStatus({ state: "blocked", condition: COND, blockedReason: reason }, "A brand new name");
      expect(v.blocked).toBe(true);
      expect(v.reason).toBe(reason);
    }
  });

  it("a condition-unset block is about the condition, whatever the name did", () => {
    const v = blockStatus({ state: "blocked", blockedReason: HANDLE_REASON }, "A brand new name");
    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/Condition not set/);
  });

  it("an unblocked node is not blocked and has nothing to note", () => {
    expect(blockStatus({ state: "awaiting" }, "x")).toEqual({ blocked: false, reason: null, staleNote: null });
    expect(blockStatus(null, "x")).toEqual({ blocked: false, reason: null, staleNote: null });
  });
});

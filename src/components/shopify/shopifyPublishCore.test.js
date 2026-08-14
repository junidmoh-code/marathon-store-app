// ─── Shopify Publishing — core contracts pinned ──────────────────────────────
// The 2026-08-14 state model: awaiting | live | blocked, on/off for live
// products, desiredState intent + pending derivation. The page and the
// owner-run scripts must never disagree on these.
import { describe, it, expect } from "vitest";
import {
  CONDITIONS, PUBLISH_STATES, canUseShopifyPublish, canGoLive, normalizedState,
  normalizedFields, isOn, isPendingSwitch, checkCleanName, blockedReason,
  STATE_FILTERS, reviewStateFor, matchesStateFilter, batchSelectBlocker, effectivePhotoList,
} from "./shopifyPublishCore";
import { RECONCILE_MAX_APPLY, normalizePhotoList } from "./publishShared";
import { CONDITIONS as SCRIPT_CONDITIONS } from "../../../scripts/shopify/compliance.mjs";
import { PUBLISH_STATES as SCRIPT_STATES } from "../../../scripts/shopify/publishNode.mjs";

describe("cross-surface contracts", () => {
  it("page and scripts agree on the condition values and states", () => {
    expect(CONDITIONS).toEqual(SCRIPT_CONDITIONS);
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
    expect(batchSelectBlocker(node, "Low-top sneaker black")).toBeNull();
    expect(batchSelectBlocker({ state: "awaiting" }, "Low-top sneaker black")).toMatch(/condition/);
    expect(batchSelectBlocker(node, "")).toMatch(/name/);
    expect(batchSelectBlocker(node, "Nike Air Force 1")).toMatch(/name/); // trigger ⇒ not a valid name
    expect(batchSelectBlocker(null, "Low-top sneaker black")).toMatch(/condition/);
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
  it("every non-all filter key is a reachable review state", () => {
    const reachable = new Set(["awaiting", "approved", "live", "blocked"]);
    for (const { key } of STATE_FILTERS) {
      if (key !== "all") expect(reachable.has(key)).toBe(true);
    }
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

// ─── Shopify Publishing card — core contracts pinned ─────────────────────────
import { describe, it, expect } from "vitest";
import {
  CONDITIONS, PUBLISH_STATES, canUseShopifyPublish, nominationState,
  checkCleanName, blockedReason, pipelineCounts,
} from "./shopifyPublishCore";
import { CONDITIONS as SCRIPT_CONDITIONS } from "../../../scripts/shopify/compliance.mjs";
import { PUBLISH_STATES as SCRIPT_STATES } from "../../../scripts/shopify/publishNode.mjs";

describe("cross-surface contracts", () => {
  it("card and push scripts agree on the condition values and states", () => {
    expect(CONDITIONS).toEqual(SCRIPT_CONDITIONS);
    expect(PUBLISH_STATES).toEqual(SCRIPT_STATES);
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

describe("nomination state — condition has NO default", () => {
  it("condition set → nominated; unset/invalid → blocked", () => {
    for (const c of CONDITIONS) expect(nominationState(c)).toBe("nominated");
    expect(nominationState(undefined)).toBe("blocked");
    expect(nominationState("Mint")).toBe("blocked");
  });
  it("blockedReason says why a nomination cannot push", () => {
    expect(blockedReason({ state: "blocked" })).toMatch(/Condition not set/);
    expect(blockedReason({ state: "nominated" })).toMatch(/Condition not set/);
    expect(blockedReason({ state: "nominated", condition: CONDITIONS[0] })).toBeNull();
    expect(blockedReason({ state: "draft" })).toBeNull();
    expect(blockedReason(null)).toBeNull();
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

describe("pipelineCounts", () => {
  it("counts only real pipeline states", () => {
    expect(pipelineCounts({
      a: { state: "nominated" }, b: { state: "draft" }, c: { state: "draft" },
      d: { state: "blocked" }, e: { state: "none" }, f: null,
    })).toEqual({ nominated: 1, draft: 2, live: 0, blocked: 1 });
    expect(pipelineCounts(null)).toEqual({ nominated: 0, draft: 0, live: 0, blocked: 0 });
  });
});

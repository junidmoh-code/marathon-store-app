// ─── HUB SNEAKER COUNT — gate truth table ─────────────────────────────────────
// The gates stopped being one gate the day warehouse counters came in
// (owner direction 2026-08-03), and each line below is now load-bearing:
//   open   — admin AND warehouse (the people who actually count)
//   adjust — admin ONLY (mirrors the RTDB rule on `adjustment` movements)
//   (the variance tab was replaced by History, visible to every counter —
//    owner direction 2026-08-03; the admin-only piece that remains is Apply,
//    which rides on canAdjustHubCount)
import { describe, it, expect } from "vitest";
import {
  canUseHubSneakerCount, canAdjustHubCount,
  hubSneakerCountVisibleForViewer,
} from "./hubSneakerCount.js";
import { ADMIN_EMAIL } from "../components/PermissionsContext";

const v = (stockRole, email = "staff@marathon.internal") => ({ email, stockRole });

describe("who can open and count", () => {
  it("admin and warehouse can; store, pos, roleless and signed-out cannot", () => {
    expect(canUseHubSneakerCount(v("admin"))).toBe(true);
    expect(canUseHubSneakerCount(v("warehouse"))).toBe(true);
    expect(canUseHubSneakerCount(v("store"))).toBe(false);
    expect(canUseHubSneakerCount(v("pos"))).toBe(false);
    expect(canUseHubSneakerCount(v(null))).toBe(false);
    expect(canUseHubSneakerCount(null)).toBe(false);
  });

  it("the home card follows the same answer", () => {
    expect(hubSneakerCountVisibleForViewer(v("warehouse"))).toBe(true);
    expect(hubSneakerCountVisibleForViewer(v("store"))).toBe(false);
  });
});

describe("who can write stock corrections", () => {
  it("ONLY a stored admin role — warehouse records, never adjusts", () => {
    expect(canAdjustHubCount(v("admin"))).toBe(true);
    expect(canAdjustHubCount(v("warehouse"))).toBe(false);
  });

  it("the super-admin email alone does NOT grant adjust — the rules read the stored role", () => {
    // This pins the lesson that produced canAdjustHubCount in the first place:
    // ADMIN_EMAIL is a client-side permissions bypass and mints no stockRole.
    expect(canAdjustHubCount(v(null, ADMIN_EMAIL))).toBe(false);
    expect(canAdjustHubCount(v("warehouse", ADMIN_EMAIL))).toBe(false);
    expect(canAdjustHubCount(v("admin", ADMIN_EMAIL))).toBe(true);
  });
});

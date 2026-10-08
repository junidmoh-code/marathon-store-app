// The per-store display-check switch on the client — the server's twin
// (functions/displayChecks/lib.cjs isTriggerStoreEnabled). Marathon PE with no
// setting is exactly today's answer.
import { describe, it, expect, beforeEach } from "vitest";
import { SEED_REGISTRY } from "../utils/networkRegistry";
import {
  displayChecksEnabledStores, isDisplayChecksStoreEnabled, displayChecksAllStores, displayCheckSwitchOf,
  primeDisplayCheckSwitches, currentDisplayCheckSwitches, __resetDisplayCheckSwitchesForTests,
} from "./displayChecks";

beforeEach(() => __resetDisplayCheckSwitchesForTests());

describe("display check switch per store", () => {
  it("no settings: the live rule, as today — Marathon PE and Trophy on, Concrete and Pine off", () => {
    expect(displayChecksEnabledStores(SEED_REGISTRY, {})).toEqual(["marathon-pe", "trophy"]);
    expect(isDisplayChecksStoreEnabled("concrete", SEED_REGISTRY, {})).toBe(false);
  });
  it("an explicit switch decides: Concrete on, a store switched off is off; a hub is never a store", () => {
    const sw = { concrete: { enabled: true, scope: "all_but_sneakers" }, trophy: { enabled: true, scope: "all_but_sneakers" } };
    expect(displayChecksEnabledStores(SEED_REGISTRY, sw)).toEqual(["marathon-pe", "trophy", "concrete"]);
    expect(isDisplayChecksStoreEnabled("concrete", SEED_REGISTRY, sw)).toBe(true);
    expect(isDisplayChecksStoreEnabled("trophy", SEED_REGISTRY, { trophy: { enabled: false } })).toBe(false);
    expect(isDisplayChecksStoreEnabled("hub3", SEED_REGISTRY, { hub3: { enabled: true } })).toBe(false);
    expect(displayCheckSwitchOf("marathon-pe", sw)).toEqual({ enabled: null, scope: "clothing" });
  });
  it("the owner's picker lists every store, so a switched-off store can be opened and switched on", () => {
    expect(displayChecksAllStores(SEED_REGISTRY).sort()).toEqual(["concrete", "marathon-pe", "marathon-pine", "trophy"]);
  });
  it("prime reads two small fields per store and skips a store the viewer may not read", async () => {
    const reads = [];
    await primeDisplayCheckSwitches(SEED_REGISTRY, async (path) => {
      reads.push(path);
      if (path.startsWith("displayChecks_settings/trophy")) throw new Error("PERMISSION_DENIED");
      return path.endsWith("/enabled") ? path.includes("concrete") : null;
    });
    expect(reads.every((p) => /\/(enabled|scope)$/.test(p))).toBe(true);
    expect(currentDisplayCheckSwitches().concrete).toEqual({ enabled: true, scope: null });
    expect(currentDisplayCheckSwitches().trophy).toBeUndefined();
    expect(isDisplayChecksStoreEnabled("concrete", SEED_REGISTRY)).toBe(true);
    expect(isDisplayChecksStoreEnabled("trophy", SEED_REGISTRY)).toBe(true);   // unreadable → live rule
  });
});

// ── live-update: when the live checkout may move, and what moving takes ─────
import { describe, it, expect } from "vitest";
import { planLiveUpdate } from "./liveUpdatePlan.mjs";

const A = "a".repeat(40), B = "b".repeat(40);
const base = { head: A, target: B, targetDescendsFromHead: true };

describe("planLiveUpdate", () => {
  it("does nothing when the checkout is already at origin/main", () => {
    expect(planLiveUpdate({ ...base, target: A })).toMatchObject({ action: "none" });
  });

  it("refuses when git could not say where either side is", () => {
    expect(planLiveUpdate({ head: "", target: B }).action).toBe("refuse");
    expect(planLiveUpdate({ head: A, target: null }).action).toBe("refuse");
  });

  it("only ever fast-forwards: a checkout ahead of, or beside, main is left alone", () => {
    const p = planLiveUpdate({ ...base, targetDescendsFromHead: false, changedFiles: ["scripts/shopify/reconcile.mjs"] });
    expect(p).toMatchObject({ action: "refuse", npmCi: [], restart: [], check: [] });
    expect(p.why).toMatch(/not behind origin\/main/);
  });

  it("refuses while a tracked file is edited in the live directory — even one the update would not touch", () => {
    const p = planLiveUpdate({ ...base, trackedEdits: ["scripts/shopify/env.mjs"], changedFiles: ["README.md"] });
    expect(p).toMatchObject({ action: "refuse" });
    expect(p.why).toMatch(/scripts\/shopify\/env\.mjs/);
  });

  it("a plain code change: update, no reinstall, and the changed scripts are parsed first", () => {
    const p = planLiveUpdate({ ...base, changedFiles: ["scripts/shopify/autoPublish.mjs", "src/App.jsx", "docs/X.md", "functions/index.js"] });
    expect(p.action).toBe("update");
    expect(p.npmCi).toEqual([]);
    expect(p.check).toEqual(["scripts/shopify/autoPublish.mjs", "functions/index.js"]);
  });

  it("reinstalls exactly the dependency trees whose lockfile changed", () => {
    expect(planLiveUpdate({ ...base, changedFiles: ["functions/package-lock.json"] }).npmCi).toEqual(["functions"]);
    expect(planLiveUpdate({ ...base, changedFiles: ["package-lock.json", "scripts/cardrecon/package-lock.json"] }).npmCi).toEqual([".", "scripts/cardrecon"]);
    expect(planLiveUpdate({ ...base, changedFiles: ["functions/package.json"] }).npmCi).toEqual([]);
  });

  it("restarts the one long-lived service only when code it could have loaded changed", () => {
    expect(planLiveUpdate({ ...base, changedFiles: ["scripts/shipping/quote-runner.mjs"] }).restart).toEqual(["com.marathon.shippingquotes"]);
    expect(planLiveUpdate({ ...base, changedFiles: ["src/utils/onlineOrders.js"] }).restart).toEqual(["com.marathon.shippingquotes"]);
    expect(planLiveUpdate({ ...base, changedFiles: ["src/components/pos/Till.jsx", "scripts/social/publish.mjs"] }).restart).toEqual([]);
  });

  it("never asks to parse something inside node_modules", () => {
    expect(planLiveUpdate({ ...base, changedFiles: ["functions/node_modules/x/index.js"] }).check).toEqual([]);
  });
});

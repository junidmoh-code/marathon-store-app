import { test, expect } from "vitest";
import { parentOf, HOME, requestHomePanel, takeHomePanel } from "./skyNav.js";

test("product edit → Products → Admin → Home", () => {
  const a = parentOf({ role: "admin", hash: "#product/p1" });
  expect(a).toMatchObject({ level: "card", hash: "" });
  const b = parentOf({ role: "admin", hash: "" });
  expect(b).toMatchObject({ level: "admin", panel: "admin", role: null });
  expect(parentOf({ role: null, hash: "" })).toMatchObject({ level: "home", panel: null });
});

test("a deep link goes up by the hierarchy, not by history", () => {
  // Opened cold on a Shopify product: up is the publisher list, then Admin.
  expect(parentOf({ role: "shopify_publish", hash: "#shopify/p9" })).toMatchObject({ level: "card", hash: "" });
  expect(parentOf({ role: "shopify_publish", hash: "" })).toMatchObject({ level: "admin" });
  expect(parentOf({ role: null, hash: "#admin/users/u1" })).toMatchObject({ level: "card", hash: "#admin/users" });
  expect(parentOf({ role: null, hash: "#admin/users" })).toMatchObject({ level: "admin", hash: "" });
  expect(parentOf({ role: null, hash: "#new-arrivals" })).toMatchObject({ level: "admin" });
});

test("home tiles go straight Home; every other card goes to Admin", () => {
  for (const r of ["assistant", "warehouse", "display_checks"]) expect(parentOf({ role: r }).level).toBe("home");
  for (const r of ["social", "stock", "barcodes", "insights", "ai_studio"]) expect(parentOf({ role: r }).level).toBe("admin");
});

test("long-press target is Home; the panel request is read once", async () => {
  expect(HOME).toMatchObject({ level: "home", panel: null });
  requestHomePanel("admin");
  expect(takeHomePanel()).toBe("admin");
  expect(takeHomePanel()).toBe("admin");            // same tick: StrictMode's second run
  await new Promise((r) => setTimeout(r, 1));
  expect(takeHomePanel()).toBe(null);
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Source pins for the two App.jsx facts these fixes turn on. Circular by
// construction and counted as such — the behaviour lives inside AssistantView,
// which cannot be reached without a live firebase subscription. What they are
// worth: both facts are ones an edit elsewhere could silently undo, where the
// failure is invisible on screen and expensive when a customer meets it.
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

describe("routing and availability are ONE computation", () => {
  // They were two, and they disagreed: the resolver decided the hub from stock
  // alone while sneakerOut subtracted the cart afterwards against whatever hub
  // it had already picked.
  it("the cart goes INTO the resolver, not on after it", () => {
    expect(APP).toContain("consumed: p?.id ? sneakerInCart(p.id, s) : 0,");
  });
  it("sneakerOut reads the resolver's own answer rather than recomputing one", () => {
    expect(APP).toContain("const { hub, available } = sneakerSourcing(p, s);");
    expect(APP).toContain("return sneakerGateReady(hub) && Number.isFinite(available) && available <= 0;");
  });
  // `null <= 0` is TRUE in JavaScript, so a bare comparison would read "this
  // rule does not answer for it" as "out of stock" for every clothing line and
  // every Pine shoe.
  it("the null answer is tested for FINITENESS, never compared to zero", () => {
    expect(APP).toContain("Number.isFinite(available)");
  });
  it("sneakerHubOf is derived from that same call — no second route", () => {
    expect(APP).toContain("const sneakerHubOf = (p, s) => sneakerSourcing(p, s).hub;");
  });
  // A const arrow used before its declaration is fine only because the caller
  // runs later; the repo has already lost a run to exactly that (#563), so the
  // order is pinned rather than left to luck.
  it("sneakerInCart is declared BEFORE the resolver that reads it", () => {
    expect(APP.indexOf("const sneakerInCart = (pid, size) =>"))
      .toBeLessThan(APP.indexOf("const sneakerSourcing = (p, s) =>"));
  });
});

describe("a display-pair line's hub is fixed, not resolved", () => {
  it("placement pins it rather than asking the resolver", () => {
    expect(APP).toContain("item.displayPairRequest === true\n            ? DISPLAY_PAIR_HUB");
  });
  it("and the pre-flight REFUSES rather than redirecting", () => {
    expect(APP).toContain("item.displayPairRequest === true");
    expect(APP).toContain("is no longer available at ${HUB_LABELS[DISPLAY_PAIR_HUB]");
    // The refusal returns before anything is written, like the deactivation
    // guard beside it — never a half-placed checkout.
    const i = APP.indexOf("The display pair of ${gone.product.name}");
    expect(APP.slice(i, i + 400)).toContain("return;");
  });
  it("the hub is named once, in the module that owns the lane", () => {
    expect(APP).toContain("DISPLAY_PAIR_HUB } from \"./components/stock/availabilityCore\"");
    // Never a bare "hub1" literal in the placement decision.
    const i = APP.indexOf("const placedHub = isClothingCustomer");
    expect(APP.slice(i, i + 500)).not.toMatch(/\?\s*"hub1"/);
  });
});

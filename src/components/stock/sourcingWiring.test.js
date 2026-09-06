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
  // Both of these RECOMPUTED availability beside the resolver and subtracted
  // the whole cart a second time. That is how a fallback to the other hub came
  // to short-fill an add, and how a display pair came to be offered as ordinary
  // shelf stock.
  it("the quantity clamp reads the resolver's remaining count, never its own", () => {
    expect(APP).toContain("const { hub: clampHub, available: clampLeft } =");
    expect(APP).toContain("reps = Math.min(reps, Math.max(1, clampLeft));");
    // and does not go back to recomputing one
    const i = APP.indexOf("const { hub: clampHub, available: clampLeft } =");
    expect(APP.slice(i, i + 400)).not.toContain("sneakerInCart(selected.id, pendingSize)");
  });
  it("the display-only check does too", () => {
    expect(APP).toContain("const { hub, available } = sneakerSourcing(p, s);");
    const i = APP.indexOf("const sneakerDisplayOnly = (p, s) => {");
    expect(APP.slice(i, i + 900)).not.toContain("- sneakerInCart(p.id, s)");
  });
  it("sneakerHubOf is derived from that same call — no second route", () => {
    expect(APP).toContain("const sneakerHubOf = (p, s) => sneakerSourcing(p, s).hub;");
  });
  // A const arrow used before its declaration is fine only because the caller
  // runs later; the repo has already lost a run to exactly that (#563), so the
  // order is pinned rather than left to luck.
  it("sneakerInCart is declared BEFORE the resolver that reads it", () => {
    const cart = APP.indexOf("const sneakerInCart = (pid, size) =>");
    const resolver = APP.indexOf("const sneakerSourcing = (p, s) =>");
    // BOTH must be found first. indexOf returns -1 for a miss, and -1 is less
    // than any real offset — so a rename of either declaration would have let
    // this fence pass while proving nothing (CodeRabbit).
    expect(cart, "sneakerInCart declaration not found").toBeGreaterThan(-1);
    expect(resolver, "sneakerSourcing declaration not found").toBeGreaterThan(-1);
    expect(cart).toBeLessThan(resolver);
  });
});

describe("a display-pair line's hub is fixed, not resolved", () => {
  it("placement pins it rather than asking the resolver", () => {
    expect(APP).toContain("item.displayPairRequest === true\n            ? DISPLAY_PAIR_HUB");
  });
  it("and the pre-flight REFUSES rather than redirecting", () => {
    expect(APP).toContain("item.displayPairRequest === true");
    // THE CONDITION, not just the message. And it checks the NAMED PAIR, not
    // the shelf total: Hub 1 holding stock says nothing about whether this
    // particular display pair still stands, since a fresh ordinary pair
    // arriving after somebody pulled the display one would let the claim
    // through.
    expect(APP).toContain("const d = hub1DisplayUnits[promisedKey(item.product.id, item.size)];");
    expect(APP).toContain("if (!d || !(d.units > 0)) return true;");
    expect(APP).toContain("if (item.displayPairStore && !(d.stores || []).includes(item.displayPairStore)) return true;");
    // FAIL CLOSED: unverifiable is refused, not waved through.
    expect(APP).toContain("if (!displayLaneReady || !ordersSettled) return true;");
    expect(APP).toContain("if (!sneakerGateReady(DISPLAY_PAIR_HUB)) return true;");
    expect(APP).toContain("can no longer be confirmed at ${HUB_LABELS[DISPLAY_PAIR_HUB]");
    // THE ORDERING, not just the presence of a `return`. The refusal must come
    // before the checkout does anything at all — the first write in placeOrders
    // is setSubmitting(true), and everything that touches the database is
    // after it. Searching a window after the message only proved a `return`
    // existed somewhere nearby, which a mutation of the message alone could
    // satisfy (CodeRabbit).
    const refusal = APP.indexOf("The display pair of ${gone.product.name}");
    const refusalReturn = APP.indexOf("return;", refusal);
    const firstWrite = APP.indexOf("setSubmitting(true);", refusal);
    const orderNumber = APP.indexOf("await getNextOrderNumber()", refusal);
    expect(refusal, "the refusal is gone").toBeGreaterThan(-1);
    expect(firstWrite, "placeOrders no longer sets submitting after the guard").toBeGreaterThan(-1);
    expect(orderNumber, "placeOrders no longer claims an order number").toBeGreaterThan(-1);
    expect(refusalReturn).toBeGreaterThan(-1);
    expect(refusalReturn, "the refusal does not return before the checkout starts").toBeLessThan(firstWrite);
    expect(refusalReturn, "the refusal does not return before an order number is claimed").toBeLessThan(orderNumber);
  });
  it("the hub is named once, in the module that owns the lane", () => {
    expect(APP).toContain("DISPLAY_PAIR_HUB } from \"./components/stock/availabilityCore\"");
    // Never a bare "hub1" literal in the placement decision.
    const i = APP.indexOf("const placedHub = isClothingCustomer");
    expect(APP.slice(i, i + 500)).not.toMatch(/\?\s*"hub1"/);
  });
});

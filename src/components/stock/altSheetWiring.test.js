import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ─── SOURCE PINS FOR THE ✕ SHEET'S WIRING ────────────────────────────────────
// These read App.jsx as text. That is CIRCULAR and it is admitted: a pin proves
// the line has not moved, not that the screen behaves. The behaviour lives
// inside AssistantView / AssistantDesktop, which cannot be reached without
// mounting a component that owns a live firebase subscription — the same honest
// limit hubIsolation.test.js states, and the reason the mutation harness counts
// these separately from behavioural guards.
//
// What they are genuinely worth: every fact pinned here is one an edit
// elsewhere could silently break, where the failure is invisible on screen
// (a suggestion that cannot be sold looks exactly like one that can) and
// expensive when a customer meets it.
const APP = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

describe("the refusal itself is unchanged", () => {
  // THE HARD RULE. Tapping an unavailable size raises the note and RETURNS.
  // It must never reach setPendingSize — a selected size is what the Add
  // button and the refill-request path act on, so a tap that selected an
  // unavailable size would let exactly the request the X gate exists to block.
  it("an unavailable tap raises the note and selects NOTHING", () => {
    const line = APP.split("\n").find((l) => l.includes("{ size: s, left: 0, snk: true }"));
    expect(line, "the phone sheet's out-tap handler moved").toBeTruthy();
    expect(line).toContain("if (out) {");
    expect(line).toContain("return;");
    expect(line).not.toContain("setPendingSize");
  });
  it("the quick-view's out-tap does the same", () => {
    const line = APP.split("\n").find((l) => l.includes("setQvNa(clothingOrder || deadForOrder(qv)"));
    expect(line).toBeTruthy();
    expect(line).toContain("return;");
    expect(line).not.toContain("setQvSize");
  });
  it("the reason text function is still the one that was there before", () => {
    // Byte-for-byte on the sentences staff read. The strip sits BELOW this and
    // adds nothing to what the refusal says.
    expect(APP).toContain("function sneakerBlockNoteText(size, w) {");
    expect(APP).toContain("isn't available at ${hub} right now — it can't be ordered.");
    expect(APP).toContain("is reserved for another customer's order (20-minute hold) — try again shortly.");
    expect(APP).toContain("claimed by a pending display-pair request — it can't be ordered.");
  });
});

describe("the alternatives join uses the shared resolver and nothing else", () => {
  it("availability comes from sneakerOut — one definition on this screen", () => {
    expect(APP).toContain("sizeAvailable: (p, sz) => !sneakerOut(p, sz),");
  });
  // THE SHARPEST EDGE IN THE BUILD. sneakerOut returns false for an ungated
  // hub meaning "no gate", not "in stock". Offering a Pine shoe on that basis
  // is an unverified suggestion in front of a customer.
  it("a neighbour is only offered when its hub is KNOWN and SETTLED", () => {
    expect(APP).toContain("const hub = sneakerHubOf(p);\n        return !!hub && sneakerGateReady(hub);");
  });
  it("deactivated, priceless and photoless lines are excluded", () => {
    expect(APP).toContain("isSellable: (p) => !deadForOrder(p) && Number(p.retailPrice) > 0 && !!String(p.photoUrl || \"\").trim(),");
  });
  it("the neighbour list is read from the product record, not fetched", () => {
    expect(APP).toContain("neighbours: product[NEIGHBOURS_FIELD],");
    // No read of the attributes node anywhere in the app: it is extraction
    // data, and putting it on the hot path is what this build avoided.
    expect(APP).not.toContain("product_attributes");
  });
  it("merged pids are followed to the survivor", () => {
    expect(APP).toContain("resolveProduct: (pid) => resolveProductById(pid),");
  });
  it("clothing is out of scope, as the brief says", () => {
    expect(APP).toContain('if ((product.productType || "sneaker") === "clothing") return [];');
  });
});

describe("the ✕ glyph is gone from every size chip", () => {
  const chipLines = APP.split("\n").filter((l) => /snkOut \?/.test(l));
  it("there are still exactly the chips that had it", () => {
    expect(chipLines.length).toBe(2);   // phone sheet + quick-view
  });
  it("none of them renders the glyph any more", () => {
    for (const l of chipLines) expect(l, l.trim().slice(0, 80)).not.toContain("✕");
  });
  it("each keeps a screen-reader label instead — the fact is still announced", () => {
    for (const l of chipLines) expect(l).toContain("not available");
  });
  it("and no size chip strikes its number through", () => {
    for (const l of APP.split("\n")) {
      if (/textDecoration\s*:\s*"line-through"/.test(l)) {
        expect(l, `a size chip still strikes through: ${l.trim().slice(0, 90)}`).not.toMatch(/ad-sz|sizeChip|out \?/);
      }
    }
  });
  it("both chips take their styling from the shared theme", () => {
    expect(APP).toContain("phoneSizeChipStyle({ out: true, selected: pendingSize === s })");
    expect(APP).toContain("quickViewSizeChipStyle({ out: true })");
  });
});

describe("taking an alternative never returns to the catalogue", () => {
  it("the phone sheet swaps the selected product in place", () => {
    expect(APP).toContain("setSelected(pick.product);");
    expect(APP).toContain("const pick = alternativeSelection(row, naNote?.size || pendingSize || \"\");");
  });
  it("and clears every piece of state that belonged to the previous shoe", () => {
    const fn = APP.slice(APP.indexOf("const pickAlternative = (row) => {"));
    const body = fn.slice(0, fn.indexOf("};"));
    for (const setter of ["setNaNote(null)", "setDisplayPrompt(null)", "setPendingDisplayPair(null)",
                          "setPendingDisplay(false)", "setPendingDisplayPartner(false)", "setPendingQty(1)"]) {
      expect(body, `pickAlternative leaves ${setter} behind`).toContain(setter);
    }
  });
  it("the quick-view reopens on the chosen shoe", () => {
    const fn = APP.slice(APP.indexOf("const pickQvAlternative = (row, requestedSize) => {"));
    const body = fn.slice(0, fn.indexOf("\n  };"));
    expect(body).toContain("openQv(pick.product);");
    expect(body).toContain("if (pick.size) setQvSize(pick.size);");
  });
});

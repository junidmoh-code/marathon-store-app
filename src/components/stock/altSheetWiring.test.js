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
    expect(APP).toContain("return !sneakerOut(p, sz);");
  });
  // AFTER #568 the serving hub is a PER-SIZE answer, so one size of a shoe can
  // be answerable while another is not. The readiness check is explicit at the
  // size, not inherited from a product-level gate — sneakerOut returning false
  // for an unready hub means "no gate", not "in stock".
  it("each size is checked against the hub THAT size resolves to", () => {
    expect(APP).toContain("if (!sneakerGateReady(hub)) return false;");
  });
  // A RECOMMENDATION asserts availability; a tile merely fails to deny it. So
  // every input must have ANSWERED, not merely be empty — an unanswered
  // /orders reads as "nothing is promised", and that fails OPEN.
  it("nothing is recommended until every input has actually answered", () => {
    expect(APP).toContain("if (!ordersSettled) return false;");
  });
  // THE MARKER IS NOT AN AVAILABILITY TERM ANY MORE (owner spec 2026-09-07).
  // A size with a unit on a display is sold on the ordinary path like any
  // other, so this sheet has nothing to exclude and nothing to wait on. Both
  // the exclusion and the display-lane readiness gate that existed only to
  // make it trustworthy are gone — a shoe that can be sold this minute must
  // not be withheld from a customer standing in front of one.
  it("a display-marked size is NOT excluded from the alternatives", () => {
    const i = APP.indexOf("sizeAvailable: (p, sz) => {");
    expect(i).toBeGreaterThan(-1);
    const body = APP.slice(i, APP.indexOf("},", i));
    // NO DISPLAY TERM AT ALL, not merely not the two that were there. A gate
    // rebuilt out of sneakerDisplayInfo or a fresh readiness flag is the same
    // bug wearing a different name.
    expect(body, `a display term is back in sizeAvailable: ${body}`).not.toMatch(/isplay/);
  });
  // And the divert's own reader is gone from the file entirely — not merely
  // unused here. A dormant copy is how a deleted rule comes back.
  it("the display-only reader no longer exists at all", () => {
    expect(APP).not.toContain("sneakerDisplayOnly");
  });
  // THE SHARPEST EDGE IN THE BUILD. sneakerOut returns false for an ungated
  // hub meaning "no gate", not "in stock". Offering a Pine shoe on that basis
  // is an unverified suggestion in front of a customer.
  it("a Pine/hub3 neighbour is never offered — this screen cannot answer for it", () => {
    // With no size, resolveSneakerSourcingHub yields the TAG, which is null for
    // an ungated shoe. That is exactly the product-level question.
    expect(APP).toContain("availabilityKnown: (p) => !!sneakerHubOf(p),");
  });
  it("deactivated, priceless and photoless lines are excluded", () => {
    // isDeactivated, NOT deadForOrder: deadForOrder is Pine-exempt (#566), and
    // that exemption is about not HIDING a retired line from someone looking
    // for it — not a licence to RECOMMEND one.
    expect(APP).toContain("isSellable: (p) => !isDeactivated(p) && !isMergedAway(p)");
    expect(APP).toContain("&& Number(p.retailPrice) > 0 && !!String(p.photoUrl || \"\").trim(),");
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

describe("the strip is wired into both sheets", () => {
  // The component itself is now a real file with real render tests
  // (AlternativesStrip.render.test.jsx) — these two only check that each sheet
  // actually mounts it, which is the part that lives in App.jsx.
  it("the phone sheet renders it under the reason", () => {
    const i = APP.indexOf("{sneakerBlockNoteText(naNote.size, sneakerOutWhy(selected, naNote.size))}");
    const j = APP.indexOf("<AlternativesStrip rows={alternativesFor(selected, naNote.size)}");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);          // BELOW the reason, never above it
  });
  it("the quick-view renders it too", () => {
    expect(APP).toContain("<AlternativesStrip compact rows={alternativesFor?.(qv, qvNa.size) || []}");
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
  it("all three chips take their styling from the shared theme", () => {
    expect(APP).toContain("phoneSizeChipStyle({ out: true, selected: pendingSize === s })");
    // The quick-view now passes `out` straight through: there is one style for
    // an available chip whether or not it carries the display glyph.
    expect(APP).toContain("quickViewSizeChipStyle({ out })");
    expect(APP).toContain("hoverGridSizeChipStyle({ out: true, tappable: snkTappable })");
  });
  // Not a blanket ban on `opacity` — the quantity stepper's disabled "+" uses
  // one legitimately. This is about SIZE chips: none of the three may fall back
  // to dimming as its only signal.
  it("no size chip is left carrying a bare opacity as its only difference", () => {
    for (const l of APP.split("\n")) {
      if (!/className="ad-sz"|selectedSizes\.map|sizesOf\(qv\)\.map/.test(l) && !/opacity:\.3/.test(l)) continue;
      if (/opacity:\.3\d?, cursor:/.test(l)) {
        expect(l, `a size chip dims instead of differing: ${l.trim().slice(0, 90)}`).toMatch(/>\+</);
      }
    }
    // and the one the hover grid used to carry is gone for good
    expect(APP).not.toContain("style={out ? { opacity:.32,");
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
    // setDisplayPrompt and setPendingDisplayPair are both gone with the divert:
    // the prompt was the only thing that opened, and the only thing that
    // minted a display-pair claim, so a shoe swap has neither to leave behind.
    for (const setter of ["setNaNote(null)",
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

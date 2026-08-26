// Pins for the Display Registration lane (2026-08-26).
//
// THE INVARIANT: this lane records display FACTS (register rows + slots) and
// NEVER moves stock. New-stock display pairs are already booked by receiving;
// a movement here would double-book every registered pair — the exact class
// of phantom stock the negative-cell zeroing spent a day cleaning up. The
// HubCleanup registrar (which DOES book a unit first) stays the only
// movement-writing registration path.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");

describe("display registration never touches stock", () => {
  for (const f of ["./displayRegistrationStore.js", "./DisplayRegistrationView.jsx", "./DisplayRegistrationCard.jsx"]) {
    it(`${f} has no movement or /stock write path`, () => {
      const s = src(f);
      expect(s).not.toMatch(/applyMovement/);
      expect(s).not.toMatch(/stock_movements/);
      expect(s).not.toMatch(/["'`]stock\//);
      expect(s).not.toMatch(/stockCellPath/);
    });
  }
  it("the store writes movementId null with the card via marker", () => {
    const s = src("./displayRegistrationStore.js");
    expect(s).toMatch(/movementId:\s*null/);
    expect(s).toMatch(/display_registration_card/);
  });
  it("edits carry the movedFrom audit instead of a movement linkage", () => {
    expect(src("./displayRegistrationStore.js")).toMatch(/movedFrom/);
  });
});

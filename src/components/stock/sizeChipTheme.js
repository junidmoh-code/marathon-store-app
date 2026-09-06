// ─── THE UNAVAILABLE SIZE CHIP, WITHOUT THE ✕ ────────────────────────────────
//
// Owner spec 2026-09-06: the chip keeps its distinct container but the ✕ glyph
// inside it is REMOVED — the container alone carries the unavailability signal,
// and the size number reads clearly inside it. The chip stays tappable; tapping
// now opens the sheet with the reason AND the alternatives, instead of doing
// nothing but raising a note.
//
// ── WHY THIS IS A MODULE AND NOT FOUR INLINE STYLE OBJECTS ───────────────────
// The spec also says: "verify the unavailable and available states remain
// unmistakably different at a glance without the glyph. If removing it makes
// them too similar, widen the styling difference on the container."
//
// "Verify" is not something a person can do reliably by reading a diff of
// inline styles spread across three call sites, and it is not something a
// screenshot proves for the next person who edits one of them. So the two
// states are defined HERE, together, and sizeChipTheme.test.js asserts they
// differ on several independent axes at once — a later edit that quietly
// converges them fails the build instead of shipping a grid where a shop
// assistant cannot tell which sizes they can sell.
//
// THEY DID NEED WIDENING. Before this, the only differences besides the glyph
// were a dashed grey border and dimmer text; with the glyph gone that is one
// visual axis and a bit. So the unavailable chip also loses the blue of the
// available one, gains a faint fill, and drops its text further — four
// independent differences (border style, border colour, fill, text weight of
// contrast), any one of which reads at arm's length.
//
// NO STRIKETHROUGH. The old desktop tiles struck the number through; the spec
// is explicit that the number must read clearly, and a line through a "8.5" on
// a 34px tile is exactly what stops it doing so.

/** The accent the app uses for a selectable size. */
const BLUE = "#3C6EFF";
const BLUE_L = "#7AA2FF";

// ── The phone sheet's chips (the primary surface) ────────────────────────────
const PHONE_BASE = {
  padding: "10px 18px", borderRadius: "10px", fontWeight: "700", fontSize: "1rem",
  position: "relative", borderWidth: 2, borderStyle: "solid",
};

export function phoneSizeChipStyle({ out, selected }) {
  if (out) {
    return {
      ...PHONE_BASE,
      // 1. DASHED, not solid — the shape of the outline itself differs.
      borderStyle: "dashed",
      // 2. GREY, not blue — no accent colour anywhere on the chip.
      borderColor: "rgba(255,255,255,.20)",
      // 3. A FAINT FILL where an available chip is transparent.
      background: "rgba(255,255,255,.045)",
      // 4. Much lower text contrast — but still legible, which is the point of
      //    dropping the glyph. No line-through.
      color: "rgba(233,238,255,.38)",
      // Still tappable: the tap is what opens the sheet.
      cursor: "pointer",
    };
  }
  return {
    ...PHONE_BASE,
    borderStyle: "solid",
    borderColor: selected ? BLUE : "rgba(60,110,255,.15)",
    background: selected ? "rgba(60,110,255,.15)" : "transparent",
    color: selected ? BLUE_L : "#888",
    cursor: "pointer",
  };
}

// ── The desktop quick-view's chips ───────────────────────────────────────────
// Same four axes, expressed in the classes that screen already uses.
export function quickViewSizeChipStyle({ out }) {
  if (out) {
    return {
      position: "relative",
      borderStyle: "dashed",
      borderColor: "rgba(255,255,255,.20)",
      background: "rgba(255,255,255,.045)",
      color: "rgba(233,238,255,.38)",
      cursor: "pointer",
    };
  }
  return { position: "relative" };
}

// ── The proof, as data ───────────────────────────────────────────────────────
// The axes the test asserts on. Named here so the test reads as the spec's own
// sentence rather than as a list of colour literals.
export const CHIP_DISTINCTION_AXES = Object.freeze(["borderStyle", "borderColor", "background", "color"]);

/**
 * How many of the distinguishing axes actually differ between the two states.
 * The available chip is compared in its UNSELECTED form — a selected chip is
 * obviously different, and the state that has to be readable at a glance is the
 * plain one sitting next to it in the grid.
 */
export function chipDistinctionCount(styleFn) {
  const out = styleFn({ out: true, selected: false });
  const ok = styleFn({ out: false, selected: false });
  return CHIP_DISTINCTION_AXES.filter((k) => out[k] !== ok[k]).length;
}

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
      // 4. Lower text contrast — but LEGIBLE, which is the whole point of
      //    dropping the glyph. .38 measured at roughly 3:1 against these chip
      //    surfaces and a 16px size label wants 4.5:1 (CodeRabbit). No
      //    line-through, and no blanket opacity: both would undo this.
      color: "rgba(233,238,255,.62)",   // 6.5:1 — see the pairing note below
      // Still tappable: the tap is what opens the sheet.
      cursor: "pointer",
    };
  }
  return {
    ...PHONE_BASE,
    borderStyle: "solid",
    borderColor: selected ? BLUE : "rgba(60,110,255,.15)",
    background: selected ? "rgba(60,110,255,.15)" : "transparent",
    // ── THE AVAILABLE CHIP HAD TO MOVE TOO ────────────────────────────────
    // Raising the unavailable label to .62 INVERTED the pair: composited on
    // its own faintly-filled surface it lands at rgb(153,157,171), luminance
    // .338, against #888's .246 — the unavailable number came out BRIGHTER
    // than the sellable one, which is the wrong way round on the one axis a
    // person reads fastest. (Caught by computing it, not by looking at it.)
    //
    // #888 was also only 5.4:1 and is the label on the chips staff use all
    // day. .78 puts it at 10.3:1 and luminance .509 — comfortably the
    // brighter of the two, so the ordering says what it should: this size is
    // live, that one is not.
    color: selected ? BLUE_L : "rgba(233,238,255,.78)",
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
      color: "rgba(233,238,255,.62)",   // see phoneSizeChipStyle for the pairing
      cursor: "pointer",
    };
  }
  // The quick-view's available chip keeps its stylesheet colour (.ad-svsz
  // button), which is already brighter than .62 composited — the inversion
  // this file fixes is the phone sheet's, where the two were set side by side.
  return { position: "relative" };
}

// ── The desktop hover grid's tiles ───────────────────────────────────────────
// The third surface, and the one that nearly kept the old look: its `.ad-sz`
// class is a solid, blue-tinted chip, so reducing opacity alone left an
// unavailable tile reading as an ordinary one at 32% — a fifth of a signal
// where the other two surfaces carry four (CodeRabbit). Same four axes here,
// expressed as overrides of that class.
//
// These tiles are 12px and 34px wide, so the text goes brighter than the phone
// sheet's, not dimmer: there is less of it to read.
export function hoverGridSizeChipStyle({ out, tappable }) {
  if (!out) return undefined;                        // the class is the style
  return {
    borderStyle: "dashed",
    borderColor: "rgba(255,255,255,.20)",
    background: "rgba(255,255,255,.045)",
    color: "rgba(233,238,255,.62)",
    // Only a SNEAKER tile opens a sheet. Clothing and deactivated tiles have
    // nothing to open and stay not-allowed.
    cursor: tappable ? "pointer" : "not-allowed",
  };
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
export function chipDistinctionCount(styleFn, base = {}) {
  const out = styleFn({ out: true, selected: false }) || {};
  const ok = { ...base, ...(styleFn({ out: false, selected: false }) || {}) };
  return CHIP_DISTINCTION_AXES.filter((k) => out[k] !== ok[k]).length;
}

// What .ad-sz resolves to, for the hover grid's comparison — the class is the
// available state there, so the axes have to be compared against it rather
// than against an empty object.
export const HOVER_GRID_BASE_CHIP = Object.freeze({
  borderStyle: "solid",
  borderColor: "rgba(255,255,255,.12)",
  background: "rgba(74,127,255,.08)",
  color: "#dfe7ff",
});

// ─── THE TERMINAL REGISTRY, AS THE CAPTURE SCREEN SEES IT ────────────────────
// /config/cardTerminals is the estate: one row per physical card machine, keyed
// by the TID printed on its slips. This turns that map into the list of cards
// the screen draws, and it owns one decision — WHICH MACHINES CAN STILL BE
// PHOTOGRAPHED.
//
// A machine that leaves the estate is RETIRED, never deleted: its batches are
// filed under its TID and deleting the mapping would strand them (the reasoning
// is in functions/lib/card-terminals.cjs, which is this module's server half).
// A retired machine keeps its history and loses its card — there is no till to
// stand at and photograph a slip from, and the callable refuses the capture
// anyway, so offering the card would only produce a refusal a manager cannot
// act on.
//
// NOTHING HERE IS KEYED TO A PARTICULAR TERMINAL. The screen used to say in its
// own header that three of the four machines email and one cannot; the estate
// has since changed twice, and a list that names a machine is a list that goes
// wrong quietly. Every registered, unretired machine gets a card, every card
// takes a photograph, and whether a machine also emails is answered by what the
// mailbox recorded (todaysArrivals.js), never by a name in the source.
//
// Pure: no React, no Firebase, no clock. Fuzzed against its server half in
// terminalRegistry.test.js.
import { sectionOf } from "../../utils/networkRegistry.js";

/** `retiredAt` — the stamp — IS the flag; a boolean beside it could disagree. */
export function isRetiredTerminal(row) {
  return Number.isFinite(row?.retiredAt);
}

/**
 * "email" | "photo" | "typed" | "both" — the server half is captureMode in
 * functions/lib/card-terminals.cjs. Absent or mangled is "both": a card only
 * loses its camera when the settings sheet says so.
 *
 * "typed" is a machine whose total is typed in and never photographed — Trophy
 * Till 2, which cannot email and whose printer leaves the total off the paper.
 * The server half carries the whole reasoning.
 */
export function captureMode(row) {
  const m = row?.capture;
  return m === "email" || m === "photo" || m === "typed" ? m : "both";
}

/**
 * Does this card open the camera? An email-only till shows its tick and nothing
 * else; a typed-total till shows one box for the figure and no camera at all.
 */
export function takesPhoto(row) {
  const m = captureMode(row);
  return m !== "email" && m !== "typed";
}

/** Is this card captured by typing its total, with no photograph at all? */
export function typesTotal(row) {
  return captureMode(row) === "typed";
}

/**
 * The registry map → the cards to draw, in the order they are drawn.
 *
 * Sorted by label so the list does not reshuffle when a row is edited, and
 * falling back to the TID for a row that carries no label — a machine mapped in
 * a hurry still has to be capturable.
 */
export function captureCards(terminals) {
  return Object.entries(terminals || {})
    .filter(([, row]) => row && typeof row === "object" && !isRetiredTerminal(row))
    // THE MAP KEY WINS, spread first. A row that carried a `tid` field of its
    // own would otherwise replace it — and the screen submits this value as
    // `pickedTid`, which the callable checks against the TID printed on the
    // slip, so that card would refuse every photograph taken at it with a
    // message about the wrong till. The seed writer preserves unknown fields on
    // an existing row, so a stray `tid` is not hypothetical. (CodeRabbit, #611.)
    .map(([tid, row]) => ({ ...row, tid }))
    .sort((a, b) => String(a.label || a.tid).localeCompare(String(b.label || b.tid)));
}

// ── WHOSE TILLS, AND UNDER WHICH SECTION ─────────────────────────────────────
// A terminal row names its store by the POS's short id ("pe", "concrete"), and
// the network registry knows which section that store is in. Two things follow,
// and both are decided here so the screen only draws:
//
//   • A VIEWER SEES THE TILLS IN THEIR OWN SECTIONS. `sections` is the answer
//     from useMySections — Junid and anyone he gives both see every till; an
//     account or enrolled device scoped to one section sees that section's.
//     The callable refuses the others regardless (sectionRefusalFor).
//   • THE CARDS ARE GROUPED BY SECTION, Section 2 first so Marathon and Trophy
//     stay at the top where they have always been. The screen prints a section
//     heading only when there is more than one group to tell apart — so a
//     viewer in one section sees the plain list this screen always was.
//
// A row whose store the registry does not know has no section: it is shown to
// everyone, last, under no heading — a machine mapped in a hurry still has to
// be capturable, and the server refuses nobody for it either.

/**
 * @param {object[]} cards     captureCards() output
 * @param {object}   registry  the network registry
 * @param {number[]} sections  the viewer's sections, e.g. [1, 2]
 * @returns {{section:number|null, name:string|null, cards:object[]}[]}
 */
export function cardsBySection(cards, registry, sections) {
  const mine = Array.isArray(sections) ? sections : [1, 2];
  const groups = [];
  for (const card of cards || []) {
    const section = sectionOf(registry, card.storeId);
    if (section !== null && !mine.includes(section)) continue;
    let g = groups.find((x) => x.section === section);
    if (!g) {
      const name = section === null ? null
        : (registry && registry.sections && registry.sections[section] && registry.sections[section].name) || `Section ${section}`;
      g = { section, name, cards: [] };
      groups.push(g);
    }
    g.cards.push(card);
  }
  // Section 2, then Section 1, then the unsectioned. Cards keep the order they
  // arrived in (captureCards sorts by label).
  const rank = (g) => (g.section === null ? 99 : -g.section);
  return groups.sort((a, b) => rank(a) - rank(b));
}

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

/** `retiredAt` — the stamp — IS the flag; a boolean beside it could disagree. */
export function isRetiredTerminal(row) {
  return Number.isFinite(row?.retiredAt);
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

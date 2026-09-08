// ─── "ONE OF THESE IS ON A DISPLAY" — A NOTE, NOT AN INSTRUCTION ─────────────
//
// THE HOLE THIS FILLS. Until #576 a size whose last Hub 1 unit was a registered
// display pair could not be ordered normally: the tile diverted into a display-
// pair request, and that request stamped `displayPairRequest` + the store whose
// floor the pair was on, which is what raises the warehouse card's amber
// "DISPLAY PAIR — it is ON THE DISPLAY at Trophy" banner.
//
// #576 deleted the divert, correctly — a marker is not a gate, and blocking a
// size because one of its units is on a wall costs real sales. But the banner
// only ever existed on the divert's output, so with the divert gone the
// warehouse stopped being told anything: the picker walks to an empty size 9
// slot, and "Mark as Out of Stock" is one tap away. The pair is twenty metres
// off on a display wall. That is a false out-of-stock in front of a customer,
// and it is the exact outcome the banner at App.jsx:12388 says it exists to
// kill.
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
//
// It is ONE informational field written onto the order at placement, and a
// quiet note rendered from it. It is NOT the pull contract coming back:
//
//   • it never sets `displayPairRequest`, so it mints no pull, pins no hub,
//     clears no slot, schedules no display refill and changes no allocation;
//   • it never gates, greys, blocks or diverts anything — the size grid does
//     not read it at all;
//   • it never tells a picker WHICH pair to send. The order asks for "a unit of
//     this size", exactly as it did before. The note only says a unit of it is
//     known to be standing on a floor, so an empty shelf is worth a second look
//     before it becomes a refusal.
//
// That last distinction is the whole design. The amber pull banner names an
// identified physical pair and instructs the picker to take THAT one; it can
// do so because the pull flow reserved it. This note reserves nothing, so it
// asserts nothing.
//
// ── AND IT MUST NOT INVITE THE ONE THING NOTHING RECORDS ────────────────────
// The first draft said "Any pair of this size is fine to send." That reads as
// permission to take the pair off the wall — and an ORDINARY send records no
// display exit at all: the slot clear at placement and the refill scheduling
// are both gated on requestDisplayPartner, and displayPairCore's replay knows
// only partner sales, pull reinstatements and replacements. So a picker who
// followed that sentence would strip a display and leave its slot standing
// against a shoe that had gone, and every later order would inherit the false
// location (independent review, 2026-09-08).
//
// The note therefore reports EVIDENCE and asks for confirmation. It says where
// the pair was recorded and WHEN, it asks the picker to check that it is still
// there, and it asks them to say so if they take it. It does not tell anyone to
// take anything. Closing the loop properly — capturing the display source at
// dispatch and recording its exit — is the display source-of-truth job, and
// this note is deliberately no substitute for it.
//
// THE TENSE MATTERS. "IS on a display" asserts a present fact from a snapshot
// that may be days old by the time a picker reads it, and no later slot repair
// can reach a note already written into an order record. "WAS … when this was
// ordered", with the date, is the only claim the data supports.
//
// Pure and side-effect free, so the "a note is never an instruction" rules are
// proved against the predicate the screen actually consults.

/** The hub whose display lane this is. Slots, the register and pulls are hub1's. */
export const DISPLAY_LANE_HUB = "hub1";

/**
 * Normalise a stores list read back from RTDB.
 *
 * RTDB hands an array back as an array only while its keys are a dense 0..n
 * run; delete one and the same node returns an OBJECT with numeric string keys.
 * Both shapes have to read the same or a note silently disappears from an order
 * nobody edited on purpose. Junk entries are dropped rather than rendered.
 */
export function normaliseStores(v) {
  const raw = Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []);
  const out = [];
  for (const s of raw) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (!t || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Which shop floors are known to be showing this line's size, at order time.
 *
 * Returns a sorted array of store ids, or NULL when there is nothing to say.
 *
 * NULL, NEVER []. RTDB deletes a key written an empty array and reads it back
 * as null, so the two are the same value in the database and pretending
 * otherwise invites a "why is this field missing" hunt later.
 *
 * @param {object}  a
 * @param {object}  a.displayUnits  the `{ units, stores }` entry from
 *                                  displayUnitsByCell for this pid::size, or null
 * @param {string}  a.placedHub     the hub the line was actually allocated to
 * @param {string}  a.productType   "sneaker" | "clothing" | …
 * @param {boolean} a.isPull        is this already a display-pair PULL?
 * @param {boolean} a.isPartnerRequest  is this a "Request Display Partner" line?
 * @param {boolean} a.laneReady     has the display-slot subscription answered?
 */
export function displayFloorsAtOrderTime({ displayUnits, placedHub, productType, isPull, isPartnerRequest,
                                           laneReady, laneHub = DISPLAY_LANE_HUB }) {
  // FAIL SILENT, NEVER LOUD. Every one of these means "this screen cannot say
  // anything useful", and the right output for that is no note at all. A note
  // is only ever worth having when it is true.
  //
  //   • an unanswered lane is not evidence of an empty floor — it is no
  //     evidence at all, and a snapshot taken before it answers would write an
  //     absence as if it were a fact;
  //   • the lane is hub1-scoped by construction (its slots node is Hub 1's), so
  //     a line allocated anywhere else must not inherit a Hub 1 floor;
  //   • clothing has no display lane;
  //   • a PULL already carries the amber banner, which is strictly stronger —
  //     it names the pair and instructs. Two banners on one card that say
  //     different-strength things about the same shoe is how the strong one
  //     stops being read;
  //   • a PARTNER REQUEST is suppressed too, and that one is a judgement rather
  //     than a mechanic. The note's whole job is stopping a false out-of-stock
  //     on a customer order. A partner request is the opposite errand — it asks
  //     the hub to send a pair TO BECOME a display — and telling that picker
  //     "one of these is on a display at Trophy" invites them to take Trophy's
  //     display pair to furnish somebody else's, which leaves Trophy's slot
  //     standing against a shoe that has gone. That is the stale-slot residual
  //     this note was never meant to widen.
  if (!laneReady) return null;
  if ((productType || "sneaker") === "clothing") return null;
  if (placedHub !== laneHub) return null;
  if (isPull === true) return null;
  if (isPartnerRequest === true) return null;
  if (!displayUnits || !(displayUnits.units > 0)) return null;
  const stores = normaliseStores(displayUnits.stores).sort();
  return stores.length ? stores : null;
}

/**
 * What the warehouse card should say about an order it has been handed.
 *
 * Returns `{ stores }` or null. Reads the RECORD, so it works for orders placed
 * before this shipped (they simply carry no field and get no note).
 */
export function displayLocationNote(order) {
  // The pull banner wins wherever both could apply — checked here as well as at
  // write time, because an order written before this rule existed, or by any
  // other path, must still only ever raise one of the two.
  if (!order || order.displayPairRequest === true) return null;
  const stores = normaliseStores(order.displayOnFloorAt);
  if (!stores.length) return null;
  // WHEN the evidence was taken, from the order's own createdAt — no second
  // field to drift out of step with it, and no field at all on the thousands of
  // orders placed before this shipped. A card that cannot date its evidence
  // says so by omission rather than implying the claim is current.
  return { stores, when: snapshotDate(order.createdAt) };
}

/** The order's date, "8 Sep 2026", or null when it cannot be read. */
export function snapshotDate(createdAt) {
  const t = Date.parse(createdAt || "");
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}

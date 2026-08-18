// ─── SOLVE'S CARRIAGE GATE — DOES THE ENGINE AGREE THIS SHOP CARRIES IT? ──────
//
// THE REGRESSION THIS CLOSES, STATED PLAINLY.
// Solve seeds `{qty:0, mv:"seed"}` cells and tells the user "the engine will refill
// on its next scan". That sentence was TRUE while `storeCarries()` meant "a /stock
// cell exists" — the seed itself was the carriage, so seeding made the promise come
// true. PR #376 changed the predicate to PROVENANCE: sold here, or received here via
// a stocking-class movement. `setCellState()` writes a seed with NO ledger record, so
// **a seed now confers no carriage at all**, and the same button makes the same
// promise while the engine refuses the line forever.
//
// That is a regression the cutover CREATES, in a button staff press and believe, and
// it is silent in the worst way: the row leaves Missing Products looking handled, the
// cell sits at 0, and nothing anywhere says why. This module is the gate that stops
// it. `solvePlan.js` already mirrors the kill switch, the subcategory policy and
// explicit rows for exactly this reason — its own header calls the button's enabled
// state "the question *will the engine refill what I am about to seed?*". Provenance
// is the one branch that question was missing.
//
// ── THE THREE OUTCOMES ───────────────────────────────────────────────────────
// Per the owner's instruction: consult provenance, and where a product genuinely is
// not carried either write real carriage through the proper route, or say plainly
// that it cannot and why. Never silently seed and lie.
//
//   CARRIED     the index (or an existing opt-in) already says yes.
//               → seed the cells, exactly as before. Nothing new is written.
//
//   INTRODUCE   the index is READY and says no. The shop genuinely does not stock
//               this line, and Solve is a person saying it should — which is the
//               precise meaning of `introduce: true`. So Solve writes that row, in
//               the SAME atomic update as the seed cells, and the panel says so
//               including the size run it will raise. This is "real carriage through
//               the proper route": the engine's own documented opt-in, not a second
//               mechanism invented here.
//
//   BLOCKED     the index is NOT ready at this location. We cannot tell "not carried"
//               from "we do not know", and those demand opposite actions. The engine
//               fails closed here; so does Solve — it refuses, names the location and
//               the reason, and writes NOTHING. Seeding on an unknown would be the
//               same silent lie in a new costume, and introducing on an unknown would
//               arm a shop against a picture nobody has built yet.
//
// ── WHY INTRODUCE, AND NOT "JUST SEED ANYWAY" ────────────────────────────────
// An introduce row is a visible, attributable standing decision on a path the owner
// already reviews. A seed is an invisible cell indistinguishable from 539 others. The
// 2026-07-29 incident — zero cells seeded at Trophy raising 15 CR requests for jerseys
// Trophy had never stocked — is what "just seed anyway" looks like at scale.
//
// ⚠ THE ROW CARRIES NO `target`. resolveTarget's explicit branch fires on
// `typeof explicit.target === "number"`, so a number here would PIN the quantities and
// outrank the size run forever. The row says only "this shop stocks this line"; the
// numbers stay in defaultRunByStore. Same shape as scripts/stage-introduce-set.mjs,
// and `explicitTarget()` in solvePlan.js agrees by the same test.
//
// ⚠ THIS REQUIRES THE WIDENED /stock_targets RULE. The rule as it stood validated
// `newData.hasChildren(['target','minQty'])`, which refuses an introduce-only row from
// any client — so this path is INERT until that rule is published. It fails loudly
// (the write is rejected and the catch surfaces it), never silently, which is why the
// gate is still worth shipping ahead of the paste: BLOCKED and CARRIED both work
// without it, and INTRODUCE reports a refusal instead of pretending.

import { encodeSizeKey } from "../../utils/sizeKey";

export const CARRIED = "carried";
export const INTRODUCE = "introduce";
export const BLOCKED = "blocked";

const INDEX_VERSION = 1;

/**
 * Is the provenance index usable for a decision at this location?
 *
 * MUST match indexReady() in functions/lib/provenance-index.cjs. Deliberately strict:
 * a partially written index that read as ready would answer "not carried" for a shop
 * whose history simply has not been folded yet, and Solve would then introduce a line
 * the shop already trades — noise on a path whose whole value is that it is quiet.
 */
export function indexReadyAt(meta, loc) {
  const m = meta && typeof meta === "object" ? meta[loc] : null;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (m.version !== INDEX_VERSION) return false;
  return typeof m.at === "string" && m.at.length > 0 && typeof m.pairs === "number" && m.pairs >= 0;
}

/**
 * The read-side predicate. MUST stay identical to carriesByIndex() in
 * functions/lib/provenance-index.cjs and carriesByProvenance() in provenanceClass.js.
 * Sold here even once, or a positive net of stocked units.
 */
export function carriesByEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (n(entry.s) > 0) return true;
  return n(entry.k) - n(entry.u) > 0;
}

/**
 * Has the owner already introduced this line here? Mirrors introducedAt() in
 * refill-engine.cjs — BOTH branches. Missing the categoryPolicy branch would make
 * Solve introduce a pair the engine already considers introduced: a duplicate row
 * claiming credit for a decision someone else made.
 */
export function introducedAt(targets, categoryPolicy, categoryKey, loc, pid) {
  const rows = targets?.[loc]?.[pid];
  if (rows && typeof rows === "object" && !Array.isArray(rows)
      && Object.keys(rows).some((k) => rows[k]?.introduce === true)) return true;
  if (typeof categoryKey === "string" && categoryKey) {
    const cat = categoryPolicy?.[categoryKey];
    if (cat && typeof cat === "object" && !Array.isArray(cat) && cat[loc]?.introduce === true) return true;
  }
  return false;
}

/**
 * What is the state of carriage at ONE location for ONE product?
 *
 * ORDER IS LOAD-BEARING. The opt-in is checked BEFORE readiness, exactly as
 * storeCarries() does: an explicit introduction is owner intent read straight off the
 * row, so it stands whether or not the index has been built. Checking readiness first
 * would BLOCK a pair the engine would happily arm, which is a false alarm on the one
 * path that is supposed to keep working during the cutover window.
 */
export function carriageAt({ provenance, provenanceMeta, targets, categoryPolicy, categoryKey, loc, pid }) {
  if (introducedAt(targets, categoryPolicy, categoryKey, loc, pid)) {
    return { loc, state: CARRIED, via: "introduce" };
  }
  if (!indexReadyAt(provenanceMeta, loc)) {
    return { loc, state: BLOCKED, via: null, reason: "index-unready" };
  }
  const entry = provenance?.[loc]?.[pid] ?? null;
  if (carriesByEntry(entry)) return { loc, state: CARRIED, via: "provenance", entry };
  return { loc, state: INTRODUCE, via: null, entry };
}

/**
 * The whole decision for one Solve press, across every location it would seed.
 *
 * Takes no `sizes`: carriage is a fact about the (location, product) pair, not about
 * any size of it. The run only matters once a plan is being turned into rows, which is
 * introduceUpdates' job. (CodeRabbit, PR #381.)
 *
 * ALL-OR-NOTHING ON BLOCKED. A central-stranded solve seeds hub2 AND the store, and
 * the two are one causal chain — the engine's first leg is central→hub2 and the second
 * only fires once hub2 receives. Seeding the half we can vouch for would leave demand
 * that can never complete, which is a subtler version of the same false promise. If
 * any location is BLOCKED the whole solve is refused.
 */
export function solveCarriagePlan({ locs, pid, provenance, provenanceMeta, targets, categoryPolicy, categoryKey }) {
  const at = (locs || []).map((loc) => carriageAt({ provenance, provenanceMeta, targets, categoryPolicy, categoryKey, loc, pid }));
  const blocked = at.filter((a) => a.state === BLOCKED);
  const introduce = at.filter((a) => a.state === INTRODUCE);
  const carried = at.filter((a) => a.state === CARRIED);

  if (blocked.length) {
    return {
      ok: false, at, blocked, introduce: [], carried,
      reason: "index-unready",
      message: `Can't confirm ${blocked.map((b) => b.loc).join(" and ")} stock${blocked.length === 1 ? "s" : ""} this line yet — the stock-history index hasn't been built for ${blocked.length === 1 ? "that shop" : "those shops"}. Nothing was seeded. Try again once it's ready; seeding now would look solved without being refillable.`,
    };
  }
  return {
    ok: true, at, blocked: [], introduce, carried,
    reason: introduce.length ? "introduce" : "carried",
    message: null,
  };
}

/**
 * The introduce rows a plan must write, as an RTDB multi-path fragment.
 *
 * One leaf per declared size at each INTRODUCE location. No `target`, no `minQty` —
 * see the header. `sizes` are the QUALIFYING sizes Solve is seeding, so the row set
 * matches what the user was actually shown.
 */
export function introduceUpdates({ plan, pid, sizes, at, by, note }) {
  const updates = {};
  for (const entry of plan?.introduce || []) {
    for (const size of sizes || []) {
      const base = `stock_targets/${entry.loc}/${pid}/${encodeSizeKey(size)}`;
      updates[`${base}/introduce`] = true;
      updates[`${base}/introducedAt`] = at;
      updates[`${base}/introducedBy`] = by;
      updates[`${base}/note`] = note;
    }
  }
  return updates;
}

/**
 * What the confirm panel must say before the user commits. The point is that the user
 * reads the CONSEQUENCE, not a reassurance: introducing a zero-held line opens its
 * whole run at once, and that is the fact the 2026-07-29 incident turned on.
 */
export function carriageNotice({ plan, labelFor = (l) => l, unitsFor = () => null }) {
  if (!plan) return null;
  if (!plan.ok) return { tone: "blocked", text: plan.message };
  if (!plan.introduce.length) return null;
  const names = plan.introduce.map((i) => labelFor(i.loc));
  const units = plan.introduce.reduce((n, i) => n + (unitsFor(i.loc) || 0), 0);
  const where = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    tone: "introduce",
    text: `${where} ${names.length === 1 ? "has" : "have"} never stocked this line — no sale and no delivery on record. Solving records it as newly introduced${units ? `, and the engine will raise the full size run (about ${units} unit${units === 1 ? "" : "s"}) on its next scan` : ""}. That is a standing decision, not a one-off order.`,
  };
}

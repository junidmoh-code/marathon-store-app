// ─── "IS IT ALREADY IN THE CATALOGUE?" — THE CLOTHING NAME FIELD'S GATE ───────
// The sneaker half of this question is asked by StyleCodeGate BEFORE the form
// opens, because a sneaker carries a style code and the gate can demand it.
// Clothing carries no such label: the supplier's article code IS the product
// name, and it is typed by hand, in three shops, off the same delivery note.
// So this panel asks the same question in the only place clothing offers to be
// asked it — under the name field, while it is being typed.
//
// ── IT COSTS NOTHING TO SHOW ─────────────────────────────────────────────────
// The Add Product screen already holds the entire catalogue: AdminView receives
// `products` and hands the same array to NewProductForm. Matching therefore
// happens IN MEMORY, against an array that is already there — this panel issues
// ZERO /products reads and there is no query, no index and no whole-node read
// behind it. rankCandidates is pure; see utils/productDupMatch.js.
//
// The ONE thing it reads is unit totals, and it reads them the way the Total
// Stock card does — ten one-shot `/stock/{loc}/{pid}` reads per product, ~1.2 KB
// each, memoised per product for the life of the page (networkTotalsStore.js).
// It never touches the 5.36 MB /stock node. Totals are read only for the
// products actually on screen, so a panel showing three rows costs about 4 KB
// once and nothing thereafter.
//
// ── WHY THE ROW HAS A PHOTO ──────────────────────────────────────────────────
// This is a visual confirmation, not a text list. The operator is holding the
// garment; a photo is the only evidence they can actually check, and "44712" on
// a line of type looks exactly like "44712" on every other line of type. The row
// is CandidateCards — the same component the style-code intake and the count
// flow already use for "is it one of these?" — so all three surfaces ask the
// question the same way rather than growing three answers to it.
//
// ── ONE CODE, ONE PRODUCT ────────────────────────────────────────────────────
// A SOLE exact code match is not presented as a list to choose from — it is
// RESOLVED, and shown as a banner naming the product. Three shops receive the
// same delivery; if each is handed a list, the same printed code is routed to
// two different products by three independent judgement calls. The rule and the
// reasoning live in duplicateGate.js.
//
// ── IT NEVER BLOCKS ──────────────────────────────────────────────────────────
// "None of these — create new" is ALWAYS rendered, on every tier, including when
// an exact code match is on screen; the resolved banner always carries its
// override link. The panel's job is to be impossible to miss, not to be
// impossible to pass.

import { useEffect, useMemo, useState } from "react";
import CandidateCards from "../shared/CandidateCards.jsx";
import { rankCandidates, TIER_EXACT_CODE } from "../../utils/productDupMatch.js";
import { resolveDuplicateChoice, totalsKnowable, DUP_RESOLVED } from "./duplicateGate.js";
import { topCategory } from "../../utils/productCategory.js";
import { loadTotals, cachedTotals, totalsFailed } from "../stock/networkTotalsStore.js";

// ── THE TWO NUMBERS, NAMED ───────────────────────────────────────────────────
// 250ms is long enough that a typed article code is matched once rather than
// five times, and short enough that the panel is on screen before the operator's
// hand has left the keyboard.
export const DEBOUNCE_MS = 250;
// Under three characters every code in the catalogue is a candidate, so the
// panel would open on the first keystroke and say nothing.
export const MIN_CHARS = 3;

const HEAD = {
  fontSize: 11, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase",
  marginBottom: 9,
};

/**
 * Debounce a value. Returns the previous value until `ms` has passed with no
 * further change.
 *
 * NO LOADING STATE, DELIBERATELY. A spinner between keystrokes is flicker: the
 * work is a synchronous in-memory scan that takes under a millisecond, so there
 * is nothing to wait for and nothing honest to show. The panel simply holds the
 * last answer until the next one is ready.
 */
export function useDebounced(value, ms = DEBOUNCE_MS) {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

// The line under the name: what it is, and how many are on the shelves. Both are
// what the operator needs to recognise a product they have handled before — a
// category tells them which shelf, a unit count tells them whether this is the
// live record or an abandoned twin.
function rowReasons(product, totals, failed, knowable = true) {
  const cat = topCategory(product);
  const units = totals
    ? `${totals.total} unit${totals.total === 1 ? "" : "s"} on hand`
    // No locations to sum over — /locations has not answered, or could not be
    // read. Saying "counting…" here would wait for a read that is never issued.
    : !knowable ? "units unknown — no locations to count"
    // A FAILED READ IS NOT ZERO. Saying "0 units" about a product whose stock we
    // could not read invites exactly the wrong conclusion ("this one is dead, I
    // will make a new one") — the same rule networkTotalsStore enforces for the
    // Total Stock card, for the same reason.
    : failed ? "units unknown — could not read stock"
    : "counting units…";
  return [cat, units];
}

/**
 * @param {object} props
 *   typed        raw contents of the product-name field
 *   products     the catalogue already in memory — never re-read
 *   locationIds  every location to sum units over
 *   onPick       (product) => void — the operator says "that's the one"
 *   onCreateNew  () => void — "none of these"; ALWAYS offered, in every state
 *
 * There is no way to switch the create-new action off. An earlier draft had one,
 * nothing ever passed it, and its own doc comment claimed a wiring that did not
 * exist — a prop whose only caller was its test. (Sonnet architect review, #594.)
 */
export default function DuplicateSuggestPanel({
  typed, products, locationIds = [], onPick, onCreateNew, debounceMs = DEBOUNCE_MS,
}) {
  const held = useDebounced(typed, debounceMs);
  const query = typeof held === "string" ? held.trim() : "";
  const enough = query.length >= MIN_CHARS;

  const rows = useMemo(
    () => (enough ? rankCandidates(query, products) : []),
    [enough, query, products],
  );

  // ── "NONE OF THESE" DISMISSES THIS ANSWER, NOT THE FEATURE ────────────────
  // Keyed to the query it was tapped for, so the panel comes back the moment the
  // operator types something else. A dismissal that outlived the name it was
  // about would silently disarm the guard for the rest of the session — and the
  // operator would have no way of knowing it had.
  const [dismissedFor, setDismissedFor] = useState(null);
  const dismissed = dismissedFor !== null && dismissedFor === query;

  // The override on a resolved banner, keyed the same way and for the same
  // reason: it is an escape from THIS answer, not a setting.
  const [overrideFor, setOverrideFor] = useState(null);
  const overridden = overrideFor !== null && overrideFor === query;

  // ── UNIT TOTALS: only for what is on screen ──────────────────────────────
  // `tick` exists to re-render as reads land; the numbers themselves live in
  // networkTotalsStore's module-scope cache, so re-typing a query already asked
  // costs nothing at all.
  const [, setTick] = useState(0);
  // ── NO "IS IT STILL MOUNTED" FLAG ─────────────────────────────────────────
  // There was one, and it was a bug: a mount-scoped ref cleared in the effect's
  // cleanup. This app renders inside React 18 StrictMode, which runs a mount
  // effect as setup → cleanup → setup, so the flag went false on the first
  // cleanup and nothing turned it back on — from then on every arriving total
  // was dropped and the rows sat on "counting units…" with the numbers already
  // cached one module away.
  //
  // The flag is GONE rather than repaired. It was guarding against a warning
  // React 18 deliberately removed: setting state on an unmounted component is a
  // no-op, not a leak. A guard against nothing that can silence a real feature
  // is worse than no guard. (CodeRabbit, PR #594.)
  const locKey = locationIds.join(",");
  useEffect(() => {
    if (!rows.length || !locationIds.length) return;
    loadTotals(rows.map((r) => r.product.id), locationIds, () => setTick((n) => n + 1));
    // locKey stands in for locationIds — a new array identity every render must
    // not re-issue reads that have not changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, locKey]);

  if (!enough || !rows.length || dismissed) return null;

  const exact = rows.filter((r) => r.tier === TIER_EXACT_CODE);
  const similar = rows.filter((r) => r.tier !== TIER_EXACT_CODE);
  const choice = resolveDuplicateChoice(rows);

  const cards = (list, cta) => (
    <CandidateCards
      suggestions={list.map((r) => ({
        product: r.product,
        code: null,
        field: null,
        reasons: rowReasons(
          r.product,
          cachedTotals(r.product.id, locationIds),
          totalsFailed(r.product.id, locationIds),
          totalsKnowable(locationIds),
        ),
      }))}
      onPick={onPick}
      limit={list.length}
      photoSize={64}
      cta={cta}
    />
  );

  // ALWAYS RENDERED, in every state including the resolved banner. The banner
  // is not a choice between products, so offering the escape alongside it does
  // not reintroduce one — and requiring a tap on "Not this one?" before the
  // operator can even SEE the way out is a block, however small.
  // (Fable spec review, PR #594: C2.11.)
  const createNew = (
    <button type="button" onClick={() => { setDismissedFor(query); if (onCreateNew) onCreateNew(); }}
      style={{ alignSelf: "flex-start", background: "transparent", border: "1px solid rgba(120,150,255,.28)",
               color: "rgba(233,238,255,.72)", borderRadius: 10, padding: "9px 14px",
               fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
      None of these — create new
    </button>
  );

  // ── RESOLVED: one code, one product, no choice offered ────────────────────
  if (choice.kind === DUP_RESOLVED && !overridden) {
    return (
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ ...HEAD, color: "#FBBF24", marginBottom: 0 }}>Already in the catalogue</div>
        <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.62)", lineHeight: 1.5 }}>
          This code is already <b style={{ color: "#fff" }}>{choice.row.product.name || "a product"}</b>. Add
          the stock you have typed to it — you do not need to create it again.
        </div>
        {cards([choice.row], "ADD STOCK TO IT →")}
        <button type="button" onClick={() => setOverrideFor(query)}
          style={{ alignSelf: "flex-start", background: "transparent", border: "none", padding: 0,
                   color: "#6A9FFF", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                   textDecoration: "underline" }}>
          Not this one?
        </button>
        {createNew}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
      {exact.length > 0 && (
        <div>
          <div style={{ ...HEAD, color: "#FBBF24" }}>Already in the catalogue</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{cards(exact, "USE THIS →")}</div>
        </div>
      )}
      {similar.length > 0 && (
        <div>
          <div style={{ ...HEAD, color: "rgba(233,238,255,.55)" }}>Possibly the same</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{cards(similar, "USE THIS →")}</div>
        </div>
      )}
      {createNew}
    </div>
  );
}

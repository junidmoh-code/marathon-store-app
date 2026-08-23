// ─── MERGE PRODUCTS — choose the target, see everything, then commit ─────────
// Reachable from a Leftover card and from a duplicate collision during
// scanning. Two screens, exactly as specified:
//
//   1. TARGET  — the PHOTO-CAPTURE LABEL READER first, an UNCAPPED, PAGED
//                search below it, and the shop-barcode scanner as a secondary
//                action. All three land on the same confirm. The search
//                matches NAME, every style CODE the product answers to, and
//                every label ALIAS; every row carries the photo, the name, the
//                code and every location with its quantity. What filters the
//                pool, and what used to, is stated in mergeSearch.js.
//   2. CONFIRM — both products side by side, and THE OUTCOME PER LOCATION in
//                plain words: what will be removed because it has already been
//                counted under the survivor, and what will move across. One
//                confirm, no choice, no toggle — the plan comes from the count
//                records (mergeDisposition.js), and the server works the same
//                plan out again from its own reads.
//
// The commit is the server-side `mergeProducts` callable — atomic, admin-only,
// reversible, fail-closed (see functions/lib/product-merge.cjs). This
// component holds NO merge logic of its own: what you see is a preview, what
// the server does is the truth, and the server re-reads everything itself.

import React, { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { searchProducts } from "../../utils/productSearch";
import { isMergedAway } from "../../utils/mergedProducts";
import { FONT, CARD, BORDER, GRAY, RED, AMBER, BLUE_L, bGhost, bGray, input } from "./ui";
import { labelFor } from "./locations";
import { sizeLabelOf } from "./hubCountCore";
import { locationsHolding, labelTokenSet, mergeTokenCandidates, exactCandidateRow, padCandidateRows } from "./hubCleanupCore";
import {
  fetchProductFollowingMerge, lookupStyleClaim, resolveAnyCodes, matchLabelAlias,
} from "./hubCleanupStore";
import { formatStyleCodeForDisplay } from "../../utils/styleCode";
import CameraScanner from "./CameraScanner.jsx";
import { TongueLabelReader } from "./TongueLabelReader.jsx";
import CandidateCards from "../shared/CandidateCards.jsx";
import IdentityLine from "../shared/IdentityLine.jsx";
import { mergeTargetPool, mergeTargetMatches } from "./mergeSearch";
import { identityFor } from "../../utils/labelIdentity";
import { useLabelIdentity } from "../../utils/labelIdentityStore";
import { planMerge, outcomeLines } from "./mergeDisposition";
import { loadCountedFor } from "./mergeDispositionStore";

const mergeProductsFn = httpsCallable(functions, "mergeProducts");

// How many result rows are on screen before "show more". Not a cap: the list
// below states how many further matches there are, and the button reaches them.
const PAGE = 40;

function Photo({ url, size = 88 }) {
  if (!url) return <div style={{ width: size, height: size, borderRadius: 14, background: "rgba(120,150,255,.08)",
                                 display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30 }}>👟</div>;
  return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 14,
                                        border: "1px solid rgba(255,255,255,.12)" }} />;
}

// Every stock cell of one product — the operator must SEE what they are joining.
function CellList({ product, allStock, registry }) {
  const locs = locationsHolding(product.id, allStock || {});
  if (!locs.length) return <div style={{ fontSize: 12, color: GRAY }}>No stock anywhere.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {locs.map(({ loc, qty, sizes }) => (
        <div key={loc} style={{ background: "rgba(255,255,255,.03)", border: BORDER, borderRadius: 10, padding: "7px 9px" }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: qty < 0 ? "#FFC9C9" : "#CFE0FF" }}>
            {labelFor(loc, registry)} · {qty}
          </div>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 2, lineHeight: 1.5 }}>
            {Object.entries(sizes).map(([k, q]) => `${sizeLabelOf(k)}: ${q}`).join(" · ") || "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── ONE SEARCH RESULT — enough to identify a twin without opening it ────────
// Owner spec 2026-08-23: "Every row shows the PHOTO, name, style code, and
// every location with its quantity." The code line is the shared IdentityLine,
// so the number on this row is copyable in one tap and is the SAME set of
// codes the count and detail screens show.
function TargetRow({ product, identityMap, allStock, registry, onPick }) {
  const { codes, aliases } = identityFor(product, identityMap);
  const locs = locationsHolding(product.id, allStock || {});
  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 10 }}>
      <button type="button" onClick={onPick}
        style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: 0, width: "100%",
                 textAlign: "left", cursor: "pointer", background: "transparent", border: "none", color: "inherit" }}>
        <Photo url={product.photoUrl} size={72} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.3 }}>{product.name}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {locs.length === 0
              ? <span style={{ fontSize: 11.5, color: GRAY }}>No stock anywhere</span>
              : locs.map(({ loc, qty }) => (
                  <span key={loc} style={{ fontSize: 11.5, fontWeight: 800, padding: "4px 8px", borderRadius: 8,
                                           fontVariantNumeric: "tabular-nums",
                                           background: qty < 0 ? "rgba(248,113,113,.12)" : "rgba(74,127,255,.12)",
                                           border: qty < 0 ? "1px solid rgba(248,113,113,.4)" : "1px solid rgba(74,127,255,.32)",
                                           color: qty < 0 ? "#FFC9C9" : "#CFE0FF" }}>
                    {labelFor(loc, registry)} · {qty}
                  </span>
                ))}
          </div>
        </div>
      </button>
      {/* Outside the button: a code chip is itself a button (tap to copy), and
          a button inside a button is invalid markup that swallows the tap. */}
      <IdentityLine codes={codes} aliases={aliases} compact
                    emptyText="No style code on record" />
    </div>
  );
}

// ─── THE OUTCOME, STATED ─────────────────────────────────────────────────────
// Owner spec 2026-08-23, verbatim: "THE SCREEN STATES THE OUTCOME, per
// location, in plain words — '6 pairs at Hub 1 will be removed — already
// counted under this product', '16 at Central will move across' — with
// per-location totals before and after. One confirm. NO choice, NO toggle."
//
// So there is no control in this component. It renders the plan
// mergeDisposition.planMerge produced and the before/after totals that follow
// from it arithmetically:
//   removal  → the survivor's total at that location does NOT change.
//   transfer → the survivor's total goes up by exactly what the loser held.
// Either way the loser ends at zero there, because its whole node is deleted.
function OutcomePlan({ plan, planFailed, loser, survivor, allStock, registry }) {
  if (!allStock) return null;
  if (plan === null) {
    return (
      <div style={{ marginTop: 14, fontSize: 13, color: AMBER }}>
        Checking what has already been counted at each location…
      </div>
    );
  }
  const survivorAt = (loc) => {
    const node = (allStock[loc] || {})[survivor.id];
    let n = 0;
    for (const [k, cell] of Object.entries(node || {})) {
      if (k === "_meta" || !cell || typeof cell !== "object") continue;
      if (typeof cell.qty === "number") n += cell.qty;
    }
    return n;
  };
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>WHAT WILL HAPPEN</div>
      {planFailed.length > 0 && (
        <div style={{ fontSize: 12.5, color: AMBER, marginBottom: 8, lineHeight: 1.5 }}>
          The count records at {planFailed.map((l) => labelFor(l, registry)).join(", ")} could not be read, so
          nothing there is treated as counted — that stock will MOVE ACROSS rather than be removed.
        </div>
      )}
      {plan.length === 0 ? (
        <div style={{ fontSize: 13, color: GRAY }}>
          {loser.name} holds no stock anywhere. Nothing moves and nothing is removed — the record simply becomes a
          redirect.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {plan.map((row) => {
            const label = labelFor(row.loc, registry);
            const before = survivorAt(row.loc);
            const after = before + row.transferQty;
            return (
              <div key={row.loc} style={{ background: "rgba(255,255,255,.03)", border: BORDER, borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#CFE0FF" }}>{label}</div>
                {outcomeLines(row, label).map((line) => (
                  <div key={line.kind} style={{ fontSize: 13, marginTop: 5, lineHeight: 1.5,
                                                color: line.kind === "remove" ? "#FFC9C9" : "#B7F0CC" }}>
                    {line.kind === "remove" ? "✕ " : "→ "}{line.text}
                  </div>
                ))}
                <div style={{ fontSize: 11.5, color: GRAY, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                  {survivor.name} at {label}: {before} → {after}
                  {" · "}{loser.name}: {row.transferQty + row.removeQty} → 0
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: GRAY, marginTop: 10, lineHeight: 1.5 }}>
        Removals are adjustment movements in the ledger naming this merge, never a silent deletion, and the full
        before-state is kept under /product_merges so a merge can be reversed.
      </div>
    </div>
  );
}

// ─── FINDING THE TARGET BY PHOTOGRAPHING THE LABEL (owner spec 2026-08-22) ───
// THE DEFECT THIS REPLACES: the only camera on this screen was CameraScanner —
// a LIVE barcode stream. A tongue label carries no barcode, so it never
// resolved, and the operator typed a name instead: the exact act that makes
// the duplicates this screen exists to clean up.
//
// The fix is a PORT, not a second implementation. The primary action is the
// shared TongueLabelReader (three-frame burst, ≤1024px downscale, image-hash
// OCR cache) used unchanged by register/count/assistant, and the candidate
// gather is the count flow's own pooling — labelTokenSet + mergeTokenCandidates
// over every code-shaped token the label printed, in ONE merged list. No token
// is auto-picked and no row resolves itself: a merge is destructive, so the
// operator always taps the photo they recognise. The live scanner survives as
// a clearly-secondary action for shop barcode stickers on boxes.
const viaLabel = (codes) => (codes || [])
  .map((c) => formatStyleCodeForDisplay(c) || c)
  .filter(Boolean)
  .join(" · ");

export default function MergeProducts({
  initialLoser, initialSurvivor = null, products = [], allStock, registry,
  onEnsureStock, onScanLookup, onClose, onMerged,
}) {
  const [loser, setLoser] = useState(initialLoser);
  const [survivor, setSurvivor] = useState(initialSurvivor);
  const [query, setQuery] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  // The label read's pooled candidates: { rows: [{ product, codes, via }],
  // tokens, unloadedIds, sweepFailed }. Never auto-applied.
  const [suggest, setSuggest] = useState(null);
  // "It's not one of these — show me everything": the whole offerable
  // catalogue, paged, beneath the same heading. The honest exit when the
  // photos on screen are not the shoe in hand.
  const [showAll, setShowAll] = useState(false);
  const [allLimit, setAllLimit] = useState(40);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);

  // The confirm screen is unusable without the full stock picture, and not
  // every entry point pre-loads it (the duplicate banner doesn't) — so this
  // component asks for it itself rather than trusting its callers.
  useEffect(() => {
    if (!allStock && onEnsureStock) onEnsureStock().catch(() => {});
  }, [allStock, onEnsureStock]);

  // ── THE SEARCH POOL AND THE MATCHES — uncapped, code- and alias-aware ─────
  // Both come from mergeSearch.js, which is where every remaining filter is
  // written down and where the removed ones are listed. The window is a SCREEN
  // concern: everything matched is here, the list shows `limit` of them and
  // says how many more there are.
  const identity = useLabelIdentity();
  const pool = useMemo(() => mergeTargetPool(products, loser), [products, loser]);
  const candidates = useMemo(
    () => mergeTargetMatches(pool, query, identity.map),
    [pool, query, identity.map],
  );
  const [limit, setLimit] = useState(PAGE);
  // A new query starts at the top of its own list — carrying a "show more"
  // depth across searches shows a hundred rows of something nobody asked for.
  useEffect(() => { setLimit(PAGE); }, [query, loser]);

  // A product this screen may offer as the survivor: real, loadable, not
  // merged away, and not the record being merged away itself.
  const offerable = (p) => !!(p && p.id && !isMergedAway(p) && p.id !== loser?.id);

  // ── THE LABEL READ → ONE POOLED CANDIDATE LIST ─────────────────────────────
  // Every code-shaped token the label printed is resolved, and everything any
  // of them owns lands in the SAME list with the number that found it. This is
  // the count flow's gather (hubCleanupCore.mergeTokenCandidates), called with
  // this screen's catalogue.
  // The rows CandidateCards renders — the shared admin picker row: PHOTO
  // first, name, the code, and a reason naming WHICH token found it. Exact
  // owners lead; beneath them the ranked suggestions, padded with the closest
  // catalogue rows so THE PANEL IS NEVER EMPTY (owner spec 2026-08-23) — the
  // ONE helper in hubCleanupCore the assistant finder shares.
  const exactRow = exactCandidateRow;
  const padWithSuggestions = (exactRows, args) => padCandidateRows({
    exactRows, products: (products || []).filter(offerable), excludeIds: [loser?.id], ...args,
  });

  const handleLabelCode = async (display, meta = null) => {
    setError("");
    setSuggest(null);
    setShowAll(false);
    setAllLimit(40);
    setReading(true);
    try {
      const tokens = labelTokenSet(display, meta && meta.allCodes);
      if (!tokens.length) { setError("That read carried no number — search by name instead."); return; }
      // Single-key /style_code_index reads, one per token, in parallel.
      const claimResults = await Promise.all(tokens.map((t) => lookupStyleClaim(t).catch(() => null)));
      const claims = {};
      tokens.forEach((t, i) => { claims[t] = claimResults[i]; });
      // The server sweep is the ONLY way an alias-only owner is visible, and it
      // reads /label_aliases whole-node — so it runs on MULTI-token labels
      // only, exactly as the count flow gates it.
      let sweep = null;
      if (tokens.length > 1) {
        try { sweep = await resolveAnyCodes(tokens); } catch { sweep = null; }
      }
      const serverOwners = sweep ? sweep.owners : [];
      const localIds = new Set((products || []).map((p) => p && p.id));
      const wanted = [...new Set(serverOwners.map((o) => o && o.productId))]
        .filter((id) => id && !localIds.has(id));
      const fetched = await Promise.all(wanted.map((id) => fetchProductFollowingMerge(id).catch(() => null)));
      const resolved = {};
      wanted.forEach((id, i) => { if (fetched[i]) resolved[id] = fetched[i]; });
      const merged = mergeTokenCandidates({ tokens, products, claims, serverOwners, resolved });
      const exact = merged.candidates
        .filter((c) => offerable(c.product))
        .map((c) => exactRow(c.product, `found by ${viaLabel(c.codes)}`, c.codes[0] || null));
      const rows = padWithSuggestions(exact, {
        kind: "code", normalised: tokens[0], allCodes: tokens,
        modelName: (meta && meta.modelName) || null, tokens: (meta && meta.tokens) || null,
      });
      setSuggest({ rows, exactCount: exact.length, tokens, unloadedIds: merged.unloadedIds,
                   sweepFailed: tokens.length > 1 && !sweep });
    } catch (err) {
      setError(String(err?.message || err));
    } finally { setReading(false); }
  };

  // A read that yielded no code at all still carries the label's WORDING —
  // the alias store answers it, and its candidates pool into the same list.
  const handleLabelTokens = async (tokens, meta = null) => {
    setError("");
    setSuggest(null);
    setShowAll(false);
    setAllLimit(40);
    setReading(true);
    try {
      const match = await matchLabelAlias(tokens).catch(() => null);
      const cands = (match && Array.isArray(match.candidates)) ? match.candidates : [];
      const exact = [];
      for (const c of cands) {
        const id = c && c.productId;
        if (!id) continue;
        let p = (products || []).find((x) => x && x.id === id) || null;
        if (!p) p = await fetchProductFollowingMerge(id).catch(() => null);
        if (offerable(p) && !exact.some((r) => r.product.id === p.id)) {
          exact.push(exactRow(p, "found by this label's wording"));
        }
      }
      const rows = padWithSuggestions(exact, {
        kind: "tokens", tokens, modelName: (meta && meta.modelName) || null, aliasCandidates: cands,
      });
      setSuggest({ rows, exactCount: exact.length, tokens: [], unloadedIds: [], sweepFailed: false });
    } catch (err) {
      setError(String(err?.message || err));
    } finally { setReading(false); }
  };

  const handleScan = async (code) => {
    setCameraOpen(false);
    setError("");
    try {
      const row = onScanLookup ? await onScanLookup(code) : null;
      let hit = row && row.productId ? products.find((p) => p && p.id === row.productId && !isMergedAway(p)) : null;
      if (!hit && row && row.productId) {
        // The row may point at a product already merged away — follow the
        // pointer to its survivor rather than reporting a dead scan.
        hit = await fetchProductFollowingMerge(row.productId).catch(() => null);
      }
      if (hit && hit.id !== loser?.id) setSurvivor(hit);
      else setError(hit ? "That scan is the same product you're merging away." : `Nothing owns “${code}” — search by name instead.`);
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  // ── THE PLAN — worked out, not asked ──────────────────────────────────────
  // The moment both parties are known, the count records for those two ids are
  // read (ranged, per location — mergeDispositionStore) and the same pure
  // planner the server runs decides each cell. `plan` is null while it loads;
  // the confirm button waits for it, because a merge must never commit against
  // an outcome nobody was shown.
  const [plan, setPlan] = useState(null);
  const [planFailed, setPlanFailed] = useState([]);
  useEffect(() => {
    if (!loser || !survivor || !allStock) { setPlan(null); return; }
    let alive = true;
    const loserCells = {};
    for (const [loc, prods] of Object.entries(allStock || {})) {
      const node = prods && prods[loser.id];
      if (!node) continue;
      const cells = {};
      for (const [k, cell] of Object.entries(node)) {
        if (k === "_meta" || !cell || typeof cell !== "object") continue;
        cells[k] = cell;
      }
      if (Object.keys(cells).length) loserCells[loc] = cells;
    }
    setPlan(null);
    setPlanFailed([]);
    loadCountedFor({ locations: Object.keys(loserCells), loserId: loser.id, survivorId: survivor.id })
      .then(({ countedByLoc, failed }) => {
        if (!alive) return;
        setPlanFailed(failed);
        setPlan(planMerge({ loserId: loser.id, survivorId: survivor.id, loserCells, countedByLoc }));
      })
      .catch(() => { if (alive) { setPlanFailed(Object.keys(loserCells)); setPlan([]); } });
    return () => { alive = false; };
  }, [loser, survivor, allStock]);

  const swap = () => { const l = loser; setLoser(survivor); setSurvivor(l); };

  const commit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await mergeProductsFn({ loserId: loser.id, survivorId: survivor.id });
      setDone(res.data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "#05070C", overflowY: "auto", fontFamily: FONT, color: "#fff" }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "14px 16px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0 14px" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: BLUE_L }}>Merge products</div>
          <button type="button" onClick={onClose} style={{ ...bGhost, padding: "10px 18px", fontSize: 14 }}>✕ Close</button>
        </div>

        {done ? (
          <div style={{ textAlign: "center", padding: "40px 10px" }}>
            <div style={{ fontSize: 34, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Merged.</div>
            <div style={{ fontSize: 13.5, color: GRAY, marginTop: 8, lineHeight: 1.6 }}>
              {done.moved?.length || 0} stock cell{(done.moved?.length || 0) === 1 ? "" : "s"} joined ·{" "}
              {done.removed?.length || 0} already counted and removed ·{" "}
              {done.barcodesRepointed?.length || 0} barcode{(done.barcodesRepointed?.length || 0) === 1 ? "" : "s"} repointed
              {done.duplicateRowClosed ? " · duplicate flag closed" : ""}
            </div>
            <button type="button" onClick={onMerged}
              style={{ ...bGray, marginTop: 22, minHeight: 52, padding: "0 26px", fontSize: 15 }}>Done</button>
          </div>
        ) : !survivor ? (
          // ── SCREEN 1: choose the target ────────────────────────────────────
          <>
            <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: 13, display: "flex", gap: 12, alignItems: "center", marginBottom: 18 }}>
              <Photo url={loser?.photoUrl} size={60} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: GRAY }}>Merging away</div>
                <div style={{ fontSize: 15.5, fontWeight: 800 }}>{loser?.name}</div>
              </div>
            </div>

            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>WHICH PRODUCT IS IT REALLY?</div>

            {/* THE PRIMARY ACTION — the shared photo-capture label reader, the
                same component and pipeline the count and register passes use.
                Nothing here is typed unless everything else fails. */}
            <TongueLabelReader big busy={busy || reading} onCode={handleLabelCode} onTokens={handleLabelTokens} />

            {/* THE POOLED SUGGESTIONS — every candidate any of the label's
                numbers found, in ONE list, each row the PHOTO first and the
                number that found it. Nothing is auto-picked: the operator
                taps the shoe they recognise. */}
            {suggest && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12.5, color: suggest.exactCount ? GRAY : AMBER, marginBottom: 8, lineHeight: 1.5 }}>
                  {suggest.exactCount === 1
                    ? "This label found one product — tap it if it's the shoe in your hand. The rows beneath are the closest others."
                    : suggest.exactCount > 1
                      ? `This label's numbers found ${suggest.exactCount} products — tap the right one. The rows beneath are the closest others.`
                      : suggest.rows.length
                        ? "Nothing matched this label closely — these are the closest we have. Tap the photo that is the shoe in your hand, or search by name below."
                        : "Nothing matched this label, and there is nothing else in this catalogue to offer — search by name below."}
                </div>
                {suggest.sweepFailed && (
                  <div style={{ fontSize: 12, color: AMBER, marginBottom: 8, lineHeight: 1.5 }}>
                    The label-code index couldn't be reached, so this label's other numbers weren't fully checked.
                  </div>
                )}
                {suggest.unloadedIds && suggest.unloadedIds.length > 0 && (
                  <div style={{ fontSize: 12, color: AMBER, marginBottom: 8, lineHeight: 1.5 }}>
                    {suggest.unloadedIds.length} further product{suggest.unloadedIds.length === 1 ? "" : "s"} answer
                    {suggest.unloadedIds.length === 1 ? "s" : ""} to this label but couldn't be loaded — reload before trusting this list.
                  </div>
                )}
                {/* THE SHARED PICKER ROW — the same component the count and
                    the intake gate render. Photo large, name, the matching
                    number, and the reason naming which token found it. A row
                    is a button; nothing here auto-picks. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <CandidateCards suggestions={suggest.rows} limit={suggest.rows.length} photoSize={110} cta="TAP"
                                  disabled={busy} onPick={(p) => { setSurvivor(p); setError(""); }} />
                </div>
                {!showAll && (
                  <button type="button" onClick={() => setShowAll(true)}
                    style={{ ...bGhost, width: "100%", minHeight: 48, marginTop: 10, fontSize: 13.5 }}>
                    It's not one of these — show me everything
                  </button>
                )}
                {showAll && (() => {
                  const pool = (products || []).filter(offerable);
                  const shownIds = new Set(suggest.rows.map((r) => r.product.id));
                  const rest = pool.filter((p) => !shownIds.has(p.id))
                    .map((p) => ({ product: p, code: p.styleCodeNormalised || null, field: null, reasons: ["everything else in the catalogue"] }));
                  return (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 8 }}>Everything else — {rest.length} product{rest.length === 1 ? "" : "s"}. Narrow it with the name search below.</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <CandidateCards suggestions={rest} limit={allLimit} photoSize={72} cta="TAP"
                                        disabled={busy} onPick={(p) => { setSurvivor(p); setError(""); }} />
                      </div>
                      {rest.length > allLimit && (
                        <button type="button" onClick={() => setAllLimit((n) => n + 40)}
                          style={{ ...bGhost, width: "100%", minHeight: 44, marginTop: 8, fontSize: 13 }}>Show more</button>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* THE FALLBACK — name search, below the suggestions, unchanged. */}
            <div style={{ marginTop: 18 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="…or search by name"
                     style={{ ...input, width: "100%", boxSizing: "border-box", minHeight: 52, fontSize: 15 }} />
            </div>
            {error && <div style={{ color: RED, fontSize: 13, marginTop: 10 }}>{error}</div>}
            {/* EVERY MATCH — photo, name, code, and every location with its
                quantity, so a twin is identifiable without opening it. The
                list is uncapped; the window below is paged and says how many
                more there are. */}
            <div style={{ fontSize: 12.5, color: GRAY, margin: "12px 0 8px" }}>
              {candidates.length === 0
                ? (pool.length === 0
                    ? "There is nothing else in this catalogue to merge into."
                    : "Nothing matches that. Clear the box to see everything.")
                : `${candidates.length} product${candidates.length === 1 ? "" : "s"}${query.trim() ? " match" : ""} · showing ${Math.min(limit, candidates.length)}`}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {candidates.slice(0, limit).map((p) => (
                <TargetRow key={p.id} product={p} identityMap={identity.map}
                           allStock={allStock} registry={registry}
                           onPick={() => { setSurvivor(p); setError(""); }} />
              ))}
            </div>
            {candidates.length > limit && (
              <button type="button" onClick={() => setLimit((n) => n + PAGE)}
                style={{ ...bGhost, width: "100%", minHeight: 48, marginTop: 10, fontSize: 13.5 }}>
                Show {Math.min(PAGE, candidates.length - limit)} more — {candidates.length - limit} still below
              </button>
            )}

            {/* SECONDARY — the live barcode stream, kept for the shop barcode
                sticker on a box. It never read tongue labels and no longer
                pretends to. */}
            <button type="button" onClick={() => setCameraOpen(true)}
              style={{ ...bGhost, width: "100%", minHeight: 46, marginTop: 18, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              ⌗ Scan a shop barcode sticker instead
            </button>
          </>
        ) : (
          // ── SCREEN 2: the visual confirm — nothing commits without it ──────
          <>
            <div style={{ fontSize: 13, color: GRAY, lineHeight: 1.55, marginBottom: 14 }}>
              Stock never moves between locations. The left product{" "}
              <strong style={{ color: "#FFC9C9" }}>disappears</strong> from search and every list; its barcodes will
              scan to the survivor. What happens to its quantity at each location is worked out below — from what
              has already been counted — and is not a choice.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[{ p: loser, role: "GOES AWAY", color: RED, border: "rgba(248,113,113,.4)" },
                { p: survivor, role: "SURVIVES", color: "#4ADE80", border: "rgba(74,222,128,.4)" }].map(({ p, role, color, border }) => (
                <div key={p.id} style={{ background: CARD, border: `1px solid ${border}`, borderRadius: 16, padding: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: ".08em", color, marginBottom: 8 }}>{role}</div>
                  <Photo url={p.photoUrl} size={88} />
                  <div style={{ fontSize: 14.5, fontWeight: 800, margin: "8px 0 2px", lineHeight: 1.3 }}>{p.name}</div>
                  {p.styleCode && <div style={{ fontSize: 11, color: GRAY, marginBottom: 6 }}>{p.styleCode}</div>}
                  <div style={{ marginTop: 8 }}>
                    <CellList product={p} allStock={allStock} registry={registry} />
                  </div>
                </div>
              ))}
            </div>

            {/* ── THE OUTCOME, PER LOCATION, IN PLAIN WORDS ─────────────────
                One line per location per disposition, with the before and
                after totals beside it. No control here changes it: the count
                records decide, and the server decides again the same way. */}
            <OutcomePlan plan={plan} planFailed={planFailed} loser={loser} survivor={survivor}
                         allStock={allStock} registry={registry} />

            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button type="button" onClick={swap} disabled={busy}
                style={{ ...bGray, flex: 1, minHeight: 50, fontSize: 14 }}>⇄ Swap direction</button>
              <button type="button" onClick={() => { setSurvivor(null); setError(""); }} disabled={busy}
                style={{ ...bGhost, flex: 1, minHeight: 50, fontSize: 14 }}>Choose another</button>
            </div>

            {error && <div style={{ color: RED, fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{error}</div>}
            {!allStock && (
              <div style={{ color: AMBER, fontSize: 12.5, marginTop: 12 }}>
                Loading the full stock picture…{onEnsureStock ? "" : " (unavailable)"}
              </div>
            )}

            <button type="button" disabled={busy || !allStock || plan === null} onClick={commit}
              style={{ width: "100%", minHeight: 66, borderRadius: 15, fontSize: 18, fontWeight: 900, fontFamily: FONT,
                       cursor: busy || !allStock || plan === null ? "not-allowed" : "pointer", marginTop: 16,
                       opacity: busy || !allStock || plan === null ? 0.5 : 1,
                       background: "rgba(248,113,113,.16)", border: "2px solid rgba(248,113,113,.55)", color: "#FFC9C9" }}>
              {busy ? "Merging…" : plan === null ? "Working out what happens…" : "MERGE — one product remains"}
            </button>
            <div style={{ fontSize: 11.5, color: GRAY, marginTop: 10, lineHeight: 1.5 }}>
              Admin-only, atomic, and recorded: the server refuses anything uncertain and keeps the full
              before-state under /product_merges.
            </div>
          </>
        )}
      </div>

      {cameraOpen && (
        <CameraScanner title="Scan the real shoe" onScan={handleScan} onClose={() => setCameraOpen(false)} />
      )}
    </div>
  );
}

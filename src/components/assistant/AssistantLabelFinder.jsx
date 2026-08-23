// ─── ASSISTANT LABEL FINDER — find a product by its TONGUE LABEL ─────────────
// (Owner fix 4, 2026-08-06; lifted out of App.jsx 2026-08-23 so it can be
// rendered in a test like every other label surface.) A shortcut for when name
// and barcode both fail: the SAME shared reader the hub cleanup, register,
// merge picker and intake gate use (stock/TongueLabelReader.jsx — three-frame
// capture, QR first, image-hash-cached OCR: a retake re-bills nothing).
//
// READ-ONLY. It FINDS registered products; it never registers, claims or files
// anything (assistants hold no write role, and the pin test forbids any alias
// or label-code WRITE call from ever appearing in this file).
//
// THE LABEL IS A SET (owner spec 2026-08-23). Every code-shaped token the label
// printed is resolved — the style-code index, the alias store, stamped products
// — and everything any of them owns lands in ONE pooled list (the count flow's
// own gather, hubCleanupCore.mergeTokenCandidates). No token is auto-picked
// and nothing is hidden behind a first hit:
//   • exactly ONE product over every token → it opens (nothing was hidden)
//   • several → the shared CandidateCards picker: photo large, name, and the
//     number that found each row; the assistant taps the shoe in hand
//   • none → the panel is NEVER empty: the ranked near-matches (code family,
//     misreads, the printed model line, the label's words) padded with the
//     closest catalogue rows under an honest heading, and name search beneath
// The same rules run for a code-less reading (the label's wording → the alias
// store's candidates → the same list).

import React, { useMemo, useState } from "react";
import { TongueLabelReader } from "../stock/TongueLabelReader";
import CandidateCards from "../shared/CandidateCards";
import { labelTokenSet, mergeTokenCandidates, exactCandidateRow, padCandidateRows } from "../stock/hubCleanupCore";
import { lookupStyleClaim, matchLabelAlias, fetchProductFollowingMerge, resolveAnyCodes, lookupCodeAlias } from "../stock/hubCleanupStore";
import { normaliseStyleCode, formatStyleCodeForDisplay } from "../../utils/styleCode";
import { searchProducts } from "../../utils/productSearch";
import { isMergedAway } from "../../utils/mergedProducts";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

const viaLabel = (codes) => (codes || [])
  .map((c) => formatStyleCodeForDisplay(c) || c).filter(Boolean).join(" · ");

export default function AssistantLabelFinder({ products, onFound, onClose }) {
  const [busy, setBusy] = useState(false);
  // { text, tone, rows: CandidateCards rows, exactCount }
  const [note, setNote] = useState(null);
  const [query, setQuery] = useState("");
  // "It's not one of these — show me everything": the whole offerable
  // catalogue, paged, beneath the same heading (the same escape the count's
  // picker and the merge picker offer).
  const [showAll, setShowAll] = useState(false);
  const [allLimit, setAllLimit] = useState(40);

  const finish = (product) => { onFound(product); };
  // The assistant may only be offered what the CURRENT catalog (mode + store
  // rules) contains — a server-named id is always mapped back onto it.
  const offerable = (p) => !!(p && p.id && !isMergedAway(p));
  const resolveCandidate = async (pid) => {
    const local = (products || []).find((x) => x && x.id === pid) || null;
    if (local) return local;
    const fetched = await fetchProductFollowingMerge(pid).catch(() => null);
    if (!fetched) return null;
    return (products || []).find((x) => x && x.id === fetched.id) || null;
  };

  const exactRow = exactCandidateRow;
  // The ONE never-empty pad (hubCleanupCore.padCandidateRows) the merge
  // picker shares — exact owners lead, the closest catalogue rows fill.
  const padWithSuggestions = (exactRows, args) => padCandidateRows({
    exactRows, products: (products || []).filter(offerable), ...args,
  });
  const showList = (rows, exactCount, display) => {
    const anyReal = rows.some((r) => r.tier === "exact" || !r.weak);
    setNote({
      rows, exactCount,
      tone: exactCount ? "good" : "warn",
      text: exactCount > 1
        ? "This label's numbers are on more than one product — tap the right one. The rows beneath are the closest others:"
        : anyReal
          ? `No product carries ${display} exactly — but these are close. Check the photo against the shoe:`
          : rows.length
            ? `No product carries ${display} exactly — nothing matched closely, but these are the closest we have. Check the photo against the shoe:`
            : `No product carries ${display}, and there is nothing else in this catalog to offer — search by name below.`,
    });
  };

  const handleCode = async (display, meta = null) => {
    setBusy(true);
    setNote(null);
    setShowAll(false);
    setAllLimit(40);
    try {
      const tokens = labelTokenSet(display, meta && meta.allCodes);
      const scanNorm = tokens[0] || normaliseStyleCode(display);
      // Single-key /style_code_index reads, one per token, in parallel; the
      // server sweep (alias-only owners) on multi-token labels, exactly as
      // the count flow gates it. A failed sweep is SAID, never read as
      // "nothing owns it".
      const claimResults = await Promise.all(tokens.map((t) => lookupStyleClaim(t).catch(() => null)));
      const claims = {};
      tokens.forEach((t, i) => { claims[t] = claimResults[i]; });
      let sweep = null;
      let sweepFailed = false;
      if (tokens.length > 1) {
        try { sweep = await resolveAnyCodes(tokens); } catch { sweepFailed = true; }
      }
      const serverOwners = sweep ? sweep.owners : [];
      // A SINGLE-token label never runs the whole-node sweep — but the exact
      // code-alias store (a code filed against a product by an earlier
      // multi-token read, e.g. a Lacoste production line) must still be
      // consulted, the same one-key lookup the count flow makes. A failed
      // lookup is an index failure, said out loud — never "nothing owns it"
      // (CodeRabbit, PR #334; kept on this surface by PR #417 review).
      if (tokens.length === 1) {
        try {
          const owner = await lookupCodeAlias(scanNorm);
          if (owner) serverOwners.push({ productId: owner, code: scanNorm, via: "alias" });
        } catch { sweepFailed = true; }
      }
      const localIds = new Set((products || []).map((p) => p && p.id));
      const wanted = [...new Set(serverOwners.map((o) => o && o.productId))].filter((id) => id && !localIds.has(id));
      const fetched = await Promise.all(wanted.map((id) => resolveCandidate(id)));
      const resolved = {};
      wanted.forEach((id, i) => { if (fetched[i]) resolved[id] = fetched[i]; });
      const merged = mergeTokenCandidates({ tokens, products, claims, serverOwners, resolved });
      const exact = merged.candidates.filter((c) => offerable(c.product))
        .map((c) => exactRow(c.product, `found by ${viaLabel(c.codes)}`, c.codes[0] || null));
      // ONE product over every token — nothing is hidden, it opens.
      if (exact.length === 1 && !merged.unloadedIds.length && !sweepFailed) { finish(exact[0].product); return; }
      const rows = padWithSuggestions(exact, {
        kind: "code", normalised: scanNorm, allCodes: tokens,
        modelName: meta && typeof meta.modelName === "string" ? meta.modelName : null,
        tokens: meta && Array.isArray(meta.tokens) ? meta.tokens : null,
      });
      showList(rows, exact.length, display);
      if (sweepFailed || merged.unloadedIds.length) {
        setNote((n) => n && ({ ...n, warn: sweepFailed
          ? "The label-code index couldn't be reached, so this label's numbers weren't fully checked — the rows are ranked from the catalog alone."
          : `${merged.unloadedIds.length} further product(s) answer to this label but aren't in this catalog — reload before trusting this list.` }));
      }
    } catch (err) {
      // Never a dead screen: say what failed and leave name search open.
      setNote({ rows: [], exactCount: 0, tone: "warn", text: `Couldn't check that label (${err?.message || err}) — try again, or search by name below.` });
    } finally { setBusy(false); }
  };

  const handleTokens = async (tokens, meta = null) => {
    setBusy(true);
    setNote(null);
    setShowAll(false);
    setAllLimit(40);
    try {
      let match = null;
      let failed = false;
      try { match = await matchLabelAlias(tokens); } catch { failed = true; }
      const cands = match && Array.isArray(match.candidates) ? match.candidates : [];
      const exact = [];
      // HIGH/MID alias candidates are exact-tier rows; a lone HIGH opens.
      if (match && (match.band === "high" || match.band === "mid")) {
        for (const c of cands) {
          const p = await resolveCandidate(c.productId);
          if (offerable(p) && !exact.some((r) => r.product.id === p.id)) exact.push(exactRow(p, "found by this label's wording"));
        }
        if (match.band === "high" && exact.length === 1) { finish(exact[0].product); return; }
      }
      const rows = padWithSuggestions(exact, {
        kind: "tokens", tokens, aliasCandidates: cands,
        modelName: meta && typeof meta.modelName === "string" ? meta.modelName : null,
      });
      showList(rows, exact.length, "this wording");
      if (failed) setNote((n) => n && ({ ...n, warn: "Couldn't check that label against the alias store — the rows are ranked from the catalog alone." }));
    } catch (err) {
      setNote({ rows: [], exactCount: 0, tone: "warn", text: `Couldn't check that label (${err?.message || err}) — try again, or search by name below.` });
    } finally { setBusy(false); }
  };

  // Free-text name search — BELOW the suggestions, never instead of them.
  const searchRows = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return searchProducts((products || []).filter(offerable), q, { limit: 20 })
      .map((p) => ({ product: p, code: p.styleCodeNormalised || null, field: null, reasons: ["name search"] }));
  }, [products, query]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 900, background: "#05070C", overflowY: "auto",
                  fontFamily: FONT, color: "#fff" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "14px 16px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0 10px" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#9DBCFF" }}>Find by the tongue label</div>
          <button type="button" onClick={onClose}
            style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.75)",
                     borderRadius: 12, padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>✕ Close</button>
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.55)", lineHeight: 1.5, marginBottom: 12 }}>
          Fold the tongue forward and photograph the printed label <u>inside</u> it — the small one with the
          style number and sizes. Not the shop barcode sticker, not the box.
        </div>
        <TongueLabelReader big busy={busy} onCode={handleCode} onTokens={handleTokens} />
        {note && (
          <div style={{ marginTop: 14, background: "rgba(251,191,36,.07)", border: "1px solid rgba(251,191,36,.25)",
                        borderRadius: 12, padding: "11px 13px", fontSize: 13.5, color: "#FDE9B0", lineHeight: 1.5 }}>
            {note.text}
            {note.warn && <div style={{ fontSize: 12, marginTop: 6, color: "#FDE9B0" }}>{note.warn}</div>}
            {/* THE SHARED PICKER ROW (shared/CandidateCards) — photo first,
                name, the registered code and WHY each row is offered. Tap =
                select for this sale; nothing is filed from here. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <CandidateCards suggestions={note.rows} limit={note.rows.length} photoSize={96} cta="TAP"
                              disabled={busy} onPick={(p) => finish(p)} />
            </div>
            {!showAll && (
              <button type="button" onClick={() => setShowAll(true)}
                style={{ width: "100%", minHeight: 46, marginTop: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
                         background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.75)", borderRadius: 12 }}>
                It's not one of these — show me everything
              </button>
            )}
            {showAll && (() => {
              const shownIds = new Set(note.rows.map((r) => r.product.id));
              const rest = (products || []).filter(offerable).filter((p) => !shownIds.has(p.id))
                .map((p) => ({ product: p, code: p.styleCodeNormalised || null, field: null, reasons: ["everything else in the catalog"] }));
              return (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12.5, marginBottom: 8 }}>Everything else — {rest.length} product{rest.length === 1 ? "" : "s"}. Narrow it with the name search below.</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <CandidateCards suggestions={rest} limit={allLimit} photoSize={64} cta="TAP" disabled={busy} onPick={(p) => finish(p)} />
                  </div>
                  {rest.length > allLimit && (
                    <button type="button" onClick={() => setAllLimit((n) => n + 40)}
                      style={{ width: "100%", minHeight: 44, marginTop: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
                               background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.16)", color: "rgba(233,238,255,.75)", borderRadius: 12 }}>Show more</button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
        {/* Free text sits BELOW the suggestions — the escape, not the design. */}
        <div style={{ marginTop: 16 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="…or search by name"
                 style={{ width: "100%", boxSizing: "border-box", minHeight: 50, fontSize: 15, borderRadius: 12, padding: "0 14px",
                          background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)", color: "#fff", fontFamily: FONT }} />
          {searchRows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <CandidateCards suggestions={searchRows} limit={searchRows.length} photoSize={64} cta="TAP" onPick={(p) => finish(p)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

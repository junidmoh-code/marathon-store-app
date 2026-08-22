// ─── MERGE PRODUCTS — choose the target, see everything, then commit ─────────
// Reachable from a Leftover card and from a duplicate collision during
// scanning. Two screens, exactly as specified:
//
//   1. TARGET  — the PHOTO-CAPTURE LABEL READER first, a name search below,
//                and the shop-barcode scanner as a secondary action. All
//                three land on the same confirm. Only visible (non-merged)
//                products are offered.
//   2. CONFIRM — both products side by side: photos and EVERY stock cell each
//                one holds, plus the direction (which record disappears). A
//                merge can NEVER complete without this screen.
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
import { locationsHolding, labelTokenSet, mergeTokenCandidates } from "./hubCleanupCore";
import {
  fetchProductFollowingMerge, lookupStyleClaim, resolveAnyCodes, matchLabelAlias,
} from "./hubCleanupStore";
import { formatStyleCodeForDisplay } from "../../utils/styleCode";
import CameraScanner from "./CameraScanner.jsx";
import { TongueLabelReader } from "./TongueLabelReader.jsx";

const mergeProductsFn = httpsCallable(functions, "mergeProducts");

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

  const candidates = useMemo(() => {
    const pool = products.filter((p) => p && p.id && !isMergedAway(p) && p.id !== loser?.id);
    return query.trim() ? searchProducts(pool, query, { limit: 12 }) : [];
  }, [products, query, loser]);


  // A product this screen may offer as the survivor: real, loadable, not
  // merged away, and not the record being merged away itself.
  const offerable = (p) => !!(p && p.id && !isMergedAway(p) && p.id !== loser?.id);

  // ── THE LABEL READ → ONE POOLED CANDIDATE LIST ─────────────────────────────
  // Every code-shaped token the label printed is resolved, and everything any
  // of them owns lands in the SAME list with the number that found it. This is
  // the count flow's gather (hubCleanupCore.mergeTokenCandidates), called with
  // this screen's catalogue.
  const handleLabelCode = async (display, meta = null) => {
    setError("");
    setSuggest(null);
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
      const rows = merged.candidates
        .filter((c) => offerable(c.product))
        .map((c) => ({ product: c.product, codes: c.codes, via: viaLabel(c.codes) }));
      const shown = tokens.map((t) => formatStyleCodeForDisplay(t) || t).join(" · ");
      if (!rows.length) {
        setSuggest({ rows: [], tokens, unloadedIds: merged.unloadedIds, sweepFailed: tokens.length > 1 && !sweep,
                     note: `Nothing this screen can offer answers to ${shown} — search by name below.` });
        return;
      }
      setSuggest({ rows, tokens, unloadedIds: merged.unloadedIds, sweepFailed: tokens.length > 1 && !sweep, note: "" });
    } catch (err) {
      setError(String(err?.message || err));
    } finally { setReading(false); }
  };

  // A read that yielded no code at all still carries the label's WORDING —
  // the alias store answers it, and its candidates pool into the same list.
  const handleLabelTokens = async (tokens) => {
    setError("");
    setSuggest(null);
    setReading(true);
    try {
      const match = await matchLabelAlias(tokens).catch(() => null);
      const cands = (match && Array.isArray(match.candidates)) ? match.candidates : [];
      const rows = [];
      for (const c of cands) {
        const id = c && c.productId;
        if (!id) continue;
        let p = (products || []).find((x) => x && x.id === id) || null;
        if (!p) p = await fetchProductFollowingMerge(id).catch(() => null);
        if (offerable(p) && !rows.some((r) => r.product.id === p.id)) {
          rows.push({ product: p, codes: [], via: "this label's wording" });
        }
      }
      setSuggest({ rows, tokens: [], unloadedIds: [], sweepFailed: false,
                   note: rows.length ? "" : "That label's wording doesn't match a product — search by name below." });
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
                {suggest.rows.length > 0 && (
                  <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 8 }}>
                    {suggest.rows.length === 1
                      ? "This label found one product — tap it if it's the shoe in your hand."
                      : `This label's numbers found ${suggest.rows.length} products — tap the right one.`}
                  </div>
                )}
                {suggest.note && <div style={{ fontSize: 13, color: AMBER, marginBottom: 8, lineHeight: 1.5 }}>{suggest.note}</div>}
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
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {suggest.rows.map((r) => (
                    <button key={r.product.id} type="button" onClick={() => { setSurvivor(r.product); setError(""); }}
                      style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", textAlign: "left", cursor: "pointer",
                               background: CARD, border: "1px solid rgba(74,127,255,.35)", borderRadius: 14 }}>
                      <Photo url={r.product.photoUrl} size={72} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.3 }}>{r.product.name}</div>
                        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3 }}>found by {r.via}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* THE FALLBACK — name search, below the suggestions, unchanged. */}
            <div style={{ marginTop: 18 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="…or search by name"
                     style={{ ...input, width: "100%", boxSizing: "border-box", minHeight: 52, fontSize: 15 }} />
            </div>
            {error && <div style={{ color: RED, fontSize: 13, marginTop: 10 }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
              {candidates.map((p) => (
                <button key={p.id} type="button" onClick={() => { setSurvivor(p); setError(""); }}
                  style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", textAlign: "left", cursor: "pointer",
                           background: CARD, border: BORDER, borderRadius: 12 }}>
                  <Photo url={p.photoUrl} size={46} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    {p.styleCode && <div style={{ fontSize: 11, color: GRAY }}>{p.styleCode}</div>}
                  </div>
                </button>
              ))}
            </div>

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
              Stock does <strong style={{ color: "#fff" }}>not move</strong> — each location keeps its quantity, the two
              records become one. The left product <strong style={{ color: "#FFC9C9" }}>disappears</strong> from search and
              every list; its barcodes will scan to the survivor.
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

            <button type="button" disabled={busy || !allStock} onClick={commit}
              style={{ width: "100%", minHeight: 66, borderRadius: 15, fontSize: 18, fontWeight: 900, fontFamily: FONT,
                       cursor: busy || !allStock ? "not-allowed" : "pointer", marginTop: 16,
                       opacity: busy || !allStock ? 0.5 : 1,
                       background: "rgba(248,113,113,.16)", border: "2px solid rgba(248,113,113,.55)", color: "#FFC9C9" }}>
              {busy ? "Merging…" : "MERGE — one product remains"}
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

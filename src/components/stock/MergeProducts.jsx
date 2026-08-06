// ─── MERGE PRODUCTS — choose the target, see everything, then commit ─────────
// Reachable from a Leftover card and from a duplicate collision during
// scanning. Two screens, exactly as specified:
//
//   1. TARGET  — a search field AND a scan button; both land on the same
//                confirm. Only visible (non-merged) products are offered.
//   2. CONFIRM — both products side by side: photos and EVERY stock cell each
//                one holds, plus the direction (which record disappears). A
//                merge can NEVER complete without this screen.
//
// The commit is the server-side `mergeProducts` callable — atomic, admin-only,
// reversible, fail-closed (see functions/lib/product-merge.cjs). This
// component holds NO merge logic of its own: what you see is a preview, what
// the server does is the truth, and the server re-reads everything itself.

import React, { useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { searchProducts } from "../../utils/productSearch";
import { isMergedAway } from "../../utils/mergedProducts";
import { FONT, CARD, BORDER, GRAY, RED, AMBER, BLUE_L, bGhost, bGray, input } from "./ui";
import { labelFor } from "./locations";
import { sizeLabelOf } from "./hubCountCore";
import { locationsHolding } from "./hubCleanupCore";
import CameraScanner from "./CameraScanner.jsx";

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

export default function MergeProducts({
  initialLoser, initialSurvivor = null, products = [], allStock, registry,
  viewer, onEnsureStock, onScanLookup, onClose, onMerged,
}) {
  const [loser, setLoser] = useState(initialLoser);
  const [survivor, setSurvivor] = useState(initialSurvivor);
  const [query, setQuery] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);

  const candidates = useMemo(() => {
    const pool = products.filter((p) => p && p.id && !isMergedAway(p) && p.id !== loser?.id);
    return query.trim() ? searchProducts(pool, query, { limit: 12 }) : [];
  }, [products, query, loser]);

  const handleScan = async (code) => {
    setCameraOpen(false);
    setError("");
    try {
      const row = onScanLookup ? await onScanLookup(code) : null;
      const hit = row && row.productId ? products.find((p) => p && p.id === row.productId && !isMergedAway(p)) : null;
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
            <button type="button" onClick={() => setCameraOpen(true)}
              style={{ width: "100%", minHeight: 64, borderRadius: 14, fontSize: 17, fontWeight: 800, cursor: "pointer",
                       background: "rgba(74,127,255,.16)", border: "2px solid rgba(74,127,255,.5)", color: "#D7E3FF", marginBottom: 10 }}>
              📷 Scan the real shoe
            </button>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="…or search by name"
                   style={{ ...input, width: "100%", boxSizing: "border-box", minHeight: 52, fontSize: 15 }} />
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

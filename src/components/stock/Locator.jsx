// ─── LOCATOR — "WHERE IS IT" ──────────────────────────────────────────────────
// Search a product → see per-size quantities across every location at a glance
// (e.g. "size 7: 2 in Hub 2 · 1 in Hub 3"). Read-only view over /stock; the
// ledger remains the source of truth. Admin-only for now (gated in StockView);
// expands to assistants/POS later.

import React, { useState, useMemo } from "react";
import { useStockCells } from "./useStock";
import { activeLocations, labelFor } from "./locations";
import { Empty } from "./widgets";
import { BLUE_L, GREEN, RED, GRAY, BORDER } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { formatSize } from "../../utils/sizeLabel";
import { SizeTag } from "../SizeTag";

function Thumb({ product, size = 42 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 9, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 9, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

export default function Locator({ products, registry }) {
  const [search, setSearch] = useState("");
  const [productId, setProductId] = useState("");
  const allCells = useStockCells();   // { loc: { pid: { size: cell } } }

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  // Forgiving search: fuzzy name + barcode/sku/per-size codes (see productSearch.js).
  const matches = useMemo(() => searchProducts(products, search, { limit: 12 }), [products, search]);

  const locs = activeLocations(registry);

  // Per-LOCATION rollup for the selected product: each location that holds any of
  // it → { id, total, sizeMap }. This is the at-a-glance "where is it" answer.
  const perLoc = useMemo(() => {
    if (!product) return [];
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    return locs.map(l => {
      const cell = allCells?.[l.id]?.[productId] || {};
      const sizeMap = {}; let total = 0;
      sizes.forEach(s => { const q = cell[s]?.qty; const n = typeof q === "number" ? q : 0; sizeMap[s] = n; total += n; });
      return { id: l.id, total, sizeMap };
      // Show a location if ANY size is nonzero — not just when the net total is
      // nonzero. With negative-stock cells, sizes can cancel to a net 0 (e.g.
      // M:+3, L:−3) while the location physically holds stock; the aggregate
      // filter used to hide those.
    }).filter(x => Object.values(x.sizeMap).some(n => n !== 0));
  }, [product, allCells, locs, productId]);
  const grand = perLoc.reduce((s, x) => s + x.total, 0);

  return (
    <div>
      <style>{`
        .lc-hit{transition:border-color .15s,background .15s}
        .lc-hit:hover{border-color:rgba(74,127,255,.5);background:rgba(74,127,255,.06)}
        .lc-card{transition:transform .18s cubic-bezier(.2,.7,.2,1),border-color .18s,box-shadow .18s}
        .lc-card:hover{transform:translateY(-3px);border-color:rgba(74,127,255,.4);box-shadow:0 16px 34px -22px rgba(60,110,255,.5)}
      `}</style>

      {/* SEARCH + typeahead */}
      {!product && (
        <div style={{ maxWidth: 560, margin: "0 auto" }}>
          <div style={{ position: "relative", marginBottom: 14 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", opacity: .4 }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={search} onChange={e => { setSearch(e.target.value); setProductId(""); }} placeholder="Search a product to locate…"
                   style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 13, color: "#fff", fontSize: 14, padding: "13px 14px 13px 40px", outline: "none" }} />
          </div>
          {search.trim() ? (
            matches.length === 0 ? <Empty>No products match.</Empty> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {matches.map(p => (
                  <div key={p.id} className="lc-hit" onClick={() => setProductId(p.id)}
                       style={{ background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 13, padding: 10, display: "flex", alignItems: "center", gap: 11, cursor: "pointer" }}>
                    <Thumb product={p} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <span style={{ color: BLUE_L }}>›</span>
                  </div>
                ))}
              </div>
            )
          ) : <Empty>Search a product to see where every size sits across all locations.</Empty>}
        </div>
      )}

      {/* RESULT — header + per-location cards */}
      {product && (
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
            <Thumb product={product} size={58} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: -.3, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.name}</div>
              <div style={{ fontSize: 12.5, color: GRAY, marginTop: 2 }}>In {perLoc.length} location{perLoc.length !== 1 ? "s" : ""} · {(product.sizes || []).length} size{(product.sizes || []).length !== 1 ? "s" : ""}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: grand < 0 ? RED : "#fff" }}>{grand}</div>
              <div style={{ fontSize: 10.5, color: "rgba(233,238,255,.3)", marginTop: 3 }}>total units</div>
            </div>
            <button onClick={() => setProductId("")} style={{ flexShrink: 0, background: "transparent", border: BORDER, color: BLUE_L, borderRadius: 9, padding: "8px 13px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change</button>
          </div>

          {perLoc.length === 0 ? <Empty>Not stocked anywhere.</Empty> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 12 }}>
              {perLoc.map(x => (
                <div key={x.id} className="lc-card" style={{ background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{labelFor(x.id, registry)}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums", margin: "6px 0 9px", color: x.total < 0 ? RED : "#fff" }}>{x.total}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {(product.sizes || []).map(s => {
                      const n = x.sizeMap[s] || 0;
                      return (
                        <span key={s} style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 7px", borderRadius: 6, fontVariantNumeric: "tabular-nums",
                                               background: n < 0 ? "rgba(248,113,113,.12)" : n > 0 ? "rgba(74,222,128,.10)" : "transparent",
                                               border: `1px solid ${n < 0 ? "rgba(248,113,113,.35)" : n > 0 ? "rgba(74,222,128,.3)" : "rgba(255,255,255,.08)"}`,
                                               color: n < 0 ? RED : n > 0 ? GREEN : "rgba(233,238,255,.3)" }}>
                          <SizeTag size={s} />·{n}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

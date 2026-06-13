// ─── LOCATOR — "WHERE IS IT" ──────────────────────────────────────────────────
// Search a product → see per-size quantities across every location at a glance
// (e.g. "size 7: 2 in Hub 2 · 1 in Hub 3"). Read-only view over /stock; the
// ledger remains the source of truth. Admin-only for now (gated in StockView);
// expands to assistants/POS later.

import React, { useState, useMemo } from "react";
import { useStockCells } from "./useStock";
import { activeLocations, labelFor } from "./locations";
import { Empty } from "./widgets";
import { GLASS, CARD, BLUE_L, GREEN, RED, GRAY, BORDER, RADIUS, input } from "./ui";

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
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return [...(products || [])]
      .filter(p => p && p.id && p.name && p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 12);
  }, [products, search]);

  const locs = activeLocations(registry);

  // For the selected product + size, gather {locId, qty} across all locations.
  const placesFor = (size) => locs
    .map(l => ({ id: l.id, qty: allCells?.[l.id]?.[productId]?.[size]?.qty }))
    .filter(x => typeof x.qty === "number" && x.qty !== 0);

  return (
    <div>
      <input value={search} onChange={e => { setSearch(e.target.value); setProductId(""); }} placeholder="Search a product to locate…"
             style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />

      {/* Typeahead results */}
      {!product && search.trim() && (
        matches.length === 0 ? <Empty>No products match.</Empty> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {matches.map(p => (
              <div key={p.id} onClick={() => { setProductId(p.id); }}
                   style={{ ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 11, cursor: "pointer" }}>
                <Thumb product={p} />
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <span style={{ color: BLUE_L }}>›</span>
              </div>
            ))}
          </div>
        )
      )}

      {!product && !search.trim() && <Empty>Search a product to see where each size is across all locations.</Empty>}

      {/* Selected product — per-size breakdown */}
      {product && (
        <div>
          <div style={{ ...GLASS, padding: 11, display: "flex", alignItems: "center", gap: 11, marginBottom: 12 }}>
            <Thumb product={product} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{product.name}</div>
              <div style={{ fontSize: 11, color: GRAY }}>quantities across all locations</div>
            </div>
            <button onClick={() => { setProductId(""); }} style={{ background: "transparent", border: BORDER, color: BLUE_L, borderRadius: 9, padding: "6px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Change</button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(Array.isArray(product.sizes) ? product.sizes : []).map(size => {
              const places = placesFor(size);
              const total = places.reduce((s, x) => s + x.qty, 0);
              return (
                <div key={size} style={{ background: CARD, border: BORDER, borderRadius: RADIUS, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: places.length ? 6 : 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: BLUE_L }}>Size {size}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: total > 0 ? "#fff" : GRAY }}>{total} total</span>
                  </div>
                  {places.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {places.map(x => (
                        <span key={x.id} style={{ fontSize: 12, fontWeight: 600, borderRadius: 16, padding: "3px 10px",
                                                  background: x.qty < 0 ? "rgba(248,113,113,.14)" : "rgba(74,222,128,.12)",
                                                  border: x.qty < 0 ? "1px solid rgba(248,113,113,.4)" : "1px solid rgba(74,222,128,.35)",
                                                  color: x.qty < 0 ? RED : GREEN }}>
                          {x.qty} · {labelFor(x.id, registry)}
                        </span>
                      ))}
                    </div>
                  )}
                  {places.length === 0 && <span style={{ fontSize: 12, color: GRAY }}>not stocked anywhere</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

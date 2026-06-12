// ─── STOCK GRID ───────────────────────────────────────────────────────────────
// Per-product × size × location quantity matrix — the at-a-glance count. Reads
// /stock live. Negative cells (offline oversell / miscount) are flagged red; the
// per-cell `state` (untracked/counting/live) is shown so partial rollout is visible.

import React, { useState, useMemo } from "react";
import { useStockCells } from "./useStock";
import { activeLocations, labelFor } from "./locations";
import { Card, Field, ProductPicker, Empty } from "./widgets";
import { GRAY, GREEN, RED, AMBER, BLUE_L, BORDER } from "./ui";

const STATE_COLOR = { live: GREEN, counting: AMBER, untracked: GRAY };

export default function StockGrid({ products, registry }) {
  const [productId, setProductId] = useState("");
  const allCells = useStockCells();            // { loc: { pid: { size: cell } } }
  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);

  const locs = activeLocations(registry);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];

  // Rows = locations that hold (or have ever held) this product; show all active
  // locations so zero-cells are visible too.
  const cellFor = (loc, size) => allCells?.[loc]?.[productId]?.[size] || null;

  return (
    <div>
      <Card>
        <Field label="Product">
          <ProductPicker products={products} value={productId} onChange={setProductId} />
        </Field>
      </Card>

      {!product && <Empty>Select a product to see its counts across locations.</Empty>}

      {product && (
        <Card style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", color: GRAY, padding: "4px 8px", position: "sticky", left: 0 }}>Location</th>
                {sizes.map(s => <th key={s} style={{ color: GRAY, padding: "4px 6px", minWidth: 38 }}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {locs.map(loc => (
                <tr key={loc.id} style={{ borderTop: BORDER }}>
                  <td style={{ padding: "6px 8px", color: "#fff", whiteSpace: "nowrap" }}>{labelFor(loc.id, registry)}</td>
                  {sizes.map(s => {
                    const c = cellFor(loc.id, s);
                    const qty = c && typeof c.qty === "number" ? c.qty : null;
                    const color = qty == null ? "rgba(255,255,255,.18)" : qty < 0 ? RED : qty === 0 ? GRAY : "#fff";
                    return (
                      <td key={s} style={{ textAlign: "center", padding: "6px 6px", color, fontWeight: qty ? 600 : 400 }}>
                        {qty == null ? "·" : qty}
                        {c?.state && c.state !== "live" && (
                          <span style={{ display: "block", fontSize: 8, color: STATE_COLOR[c.state] || GRAY }}>{c.state[0]}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: GRAY, marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span><span style={{ color: RED }}>red</span> = negative (oversell/miscount)</span>
            <span><span style={{ color: AMBER }}>c</span> = counting</span>
            <span><span style={{ color: GRAY }}>u</span> = untracked</span>
            <span style={{ color: BLUE_L }}>· = no cell yet</span>
          </div>
        </Card>
      )}
    </div>
  );
}

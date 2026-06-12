// ─── MOVEMENT HISTORY ─────────────────────────────────────────────────────────
// Per-product view of the immutable ledger (/stock_movements). Read-only audit
// trail — newest first. This is the source of truth from which balances are
// re-derived; nothing here is editable.

import React, { useState, useMemo } from "react";
import { useMovements } from "./useStock";
import { labelFor } from "./locations";
import { Card, Field, ProductPicker, Empty } from "./widgets";
import { GRAY, GREEN, RED, BLUE_L, BORDER } from "./ui";

const SIGN = { received: "+", transfer_in: "+", return: "+", sold: "−", transfer_out: "−" };
const COLOR = { received: GREEN, transfer_in: GREEN, return: GREEN, sold: RED, transfer_out: RED, adjustment: BLUE_L };

function when(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "short" }); }
  catch { return ts; }
}

export default function MovementHistory({ products, registry }) {
  const [productId, setProductId] = useState("");
  const movements = useMovements(productId || undefined);
  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);

  return (
    <div>
      <Card>
        <Field label="Product"><ProductPicker products={products} value={productId} onChange={setProductId} /></Field>
      </Card>

      {!product && <Empty>Select a product to see its full movement ledger.</Empty>}

      {product && movements.length === 0 && <Empty>No movements recorded for this product yet.</Empty>}

      {product && movements.map(m => {
        const adj = m.type === "adjustment";
        const sign = adj ? (m.to ? "+" : "−") : (SIGN[m.type] || "");
        const route = m.from && m.to ? `${labelFor(m.from, registry)} → ${labelFor(m.to, registry)}`
          : m.to ? `→ ${labelFor(m.to, registry)}`
          : m.from ? `${labelFor(m.from, registry)} →` : "";
        return (
          <div key={m.id} style={{ borderBottom: BORDER, padding: "9px 4px", display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#fff" }}>
                <span style={{ color: COLOR[m.type] || "#fff", fontWeight: 700 }}>{m.type}</span>
                <span style={{ color: GRAY, marginLeft: 6 }}>size {m.size}</span>
              </div>
              <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>{route}</div>
              {m.reason && <div style={{ fontSize: 11, color: BLUE_L, marginTop: 2 }}>“{m.reason}”</div>}
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 2 }}>{when(m.ts)}</div>
            </div>
            <div style={{ color: COLOR[m.type] || "#fff", fontWeight: 700, fontSize: 16, whiteSpace: "nowrap" }}>
              {sign}{m.qty}
            </div>
          </div>
        );
      })}
    </div>
  );
}

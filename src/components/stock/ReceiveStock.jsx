// ─── RECEIVE STOCK ────────────────────────────────────────────────────────────
// New arrivals enter the system here as `received` movements (from=null → to). The
// default destination is warehouse1 (top of chain) but any warehouse is allowed
// (flexible topology). One movement per size; each is atomic via applyMovement.

import React, { useState, useMemo } from "react";
import { applyMovement } from "./applyMovement";
import { warehouseLocations } from "./locations";
import { Card, Field, ProductPicker, LocationPicker, NumberInput, Toast } from "./widgets";
import { GRAY, GREEN, bGreen } from "./ui";

export default function ReceiveStock({ products, registry, actorRole }) {
  const [dest, setDest] = useState("warehouse1");
  const [productId, setProductId] = useState("");
  const [qtys, setQtys] = useState({});          // { size: "n" }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2600); };

  const receiveAll = async () => {
    if (!dest || !product) return flash("err", "Pick a destination and product.");
    const entries = sizes.map(s => [s, parseInt(qtys[s], 10)]).filter(([, n]) => Number.isFinite(n) && n > 0);
    if (!entries.length) return flash("err", "Enter at least one quantity.");
    setBusy(true);
    let ok = 0, fail = 0;
    for (const [size, n] of entries) {
      const res = await applyMovement({
        type: "received", productId: product.id, size, qty: n, to: dest, actorRole,
      });
      res.ok ? ok++ : fail++;
    }
    setBusy(false);
    setQtys({});
    flash(fail ? "err" : "ok", fail ? `${ok} received, ${fail} failed` : `Received ${ok} size${ok > 1 ? "s" : ""}`);
  };

  return (
    <div>
      <Card>
        <Field label="Receive into">
          <LocationPicker registry={registry} value={dest} onChange={setDest} filter={warehouseLocations} />
        </Field>
        <Field label="Product">
          <ProductPicker products={products} value={productId} onChange={(v) => { setProductId(v); setQtys({}); }} />
        </Field>
      </Card>

      {product && (
        <Card>
          <div style={{ fontSize: 11, color: GRAY, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>
            Quantity per size
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 8 }}>
            {sizes.map(s => (
              <div key={s}>
                <div style={{ fontSize: 12, color: "#fff", marginBottom: 3, textAlign: "center" }}>{s}</div>
                <NumberInput value={qtys[s] ?? ""} onChange={(v) => setQtys(q => ({ ...q, [s]: v }))} placeholder="0" />
              </div>
            ))}
          </div>
          <button onClick={receiveAll} disabled={busy} style={{ ...bGreen, width: "100%", marginTop: 14, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Receiving…" : "Receive stock"}
          </button>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 8 }}>
            Each size becomes a <span style={{ color: GREEN }}>received</span> movement — the opening ledger entry for that cell.
          </div>
        </Card>
      )}

      <Toast msg={toast} />
    </div>
  );
}

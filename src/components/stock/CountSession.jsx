// ─── COUNT SESSION ────────────────────────────────────────────────────────────
// Physical-count entry for seeding / recount. Pick a location + product, enter the
// counted quantity per size, commit. Each counted size becomes an `adjustment`
// (reason initial_count/recount) that moves the cell to the counted value AND marks
// it `live` — so partial coverage is normal (per-cell state). A count equal to the
// current value (or a true zero) flips state via setCellState without a movement.

import React, { useState, useMemo } from "react";
import { applyMovement, setCellState } from "./applyMovement";
import { useStockCells } from "./useStock";
import { activeLocations } from "./locations";
import { Card, Field, ProductPicker, LocationPicker, NumberInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, AMBER, bGreen } from "./ui";

export default function CountSession({ products, registry, actorRole }) {
  const [loc, setLoc] = useState("");
  const [productId, setProductId] = useState("");
  const [counts, setCounts] = useState({});       // { size: "n" }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];
  const cells = useStockCells(loc || undefined);   // { pid: { size: cell } } for this loc
  const curQty = (size) => {
    const c = loc ? cells?.[productId]?.[size] : null;
    return c && typeof c.qty === "number" ? c.qty : 0;
  };
  const curState = (size) => loc ? (cells?.[productId]?.[size]?.state || "untracked") : "untracked";

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2800); };

  const commit = async () => {
    if (!loc || !product) return flash("err", "Pick a location and product.");
    const entries = sizes
      .map(s => [s, parseInt(counts[s], 10)])
      .filter(([, n]) => Number.isFinite(n) && n >= 0);
    if (!entries.length) return flash("err", "Enter at least one counted quantity.");
    setBusy(true);
    let ok = 0, fail = 0;
    for (const [size, counted] of entries) {
      const cur = curQty(size);
      const delta = counted - cur;
      let res;
      if (delta === 0) {
        res = await setCellState(loc, product.id, size, "live");
      } else {
        res = await applyMovement({
          type: "adjustment",
          productId: product.id, size, qty: Math.abs(delta),
          to: delta > 0 ? loc : null,
          from: delta < 0 ? loc : null,
          reason: cur === 0 ? "initial_count" : "recount",
          cellState: "live",
          actorRole,
        });
      }
      res.ok ? ok++ : fail++;
    }
    setBusy(false);
    setCounts({});
    flash(fail ? "err" : "ok", fail ? `${ok} counted, ${fail} failed` : `Counted ${ok} size${ok > 1 ? "s" : ""} — now live`);
  };

  return (
    <div>
      <Card>
        <Field label="Location"><LocationPicker registry={registry} value={loc} onChange={setLoc} /></Field>
        <Field label="Product"><ProductPicker products={products} value={productId} onChange={(v) => { setProductId(v); setCounts({}); }} /></Field>
      </Card>

      {!loc || !product ? (
        <Empty>Pick a location and product to start counting. Coverage is per-size — count what you have, leave the rest.</Empty>
      ) : (
        <Card>
          <div style={{ fontSize: 11, color: GRAY, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>
            Counted quantity per size
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))", gap: 8 }}>
            {sizes.map(s => {
              const live = curState(s) === "live";
              return (
                <div key={s}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 2, textAlign: "center" }}>
                    {s} <span style={{ fontSize: 9, color: live ? GREEN : AMBER }}>{live ? "live" : curState(s)[0]}</span>
                  </div>
                  <div style={{ fontSize: 9, color: GRAY, textAlign: "center", marginBottom: 2 }}>sys {curQty(s)}</div>
                  <NumberInput value={counts[s] ?? ""} onChange={(v) => setCounts(c => ({ ...c, [s]: v }))} placeholder="count" />
                </div>
              );
            })}
          </div>
          <button onClick={commit} disabled={busy} style={{ ...bGreen, width: "100%", marginTop: 14, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Committing…" : "Commit counts → live"}
          </button>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 8 }}>
            “sys” = what the system currently holds. The difference is recorded as an adjustment; the cell becomes <span style={{ color: GREEN }}>live</span>.
          </div>
        </Card>
      )}
      <Toast msg={toast} />
    </div>
  );
}

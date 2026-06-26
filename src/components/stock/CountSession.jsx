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
import { Card, Field, LocationPicker, NumberInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, AMBER, BLUE_L, BORDER, CARD, bGreen, input } from "./ui";
import { searchProducts } from "../../utils/productSearch";

function Thumb({ url }) {
  if (url) return <img src={url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }}
    style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 7, flexShrink: 0 }} />;
  return <div style={{ width: 34, height: 34, borderRadius: 7, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>👟</div>;
}

export default function CountSession({ products, registry, actorRole }) {
  const [loc, setLoc] = useState("");
  const [productId, setProductId] = useState("");
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState({});       // { size: "n" }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];

  // Product search (name OR barcode/sku/per-size code); capped for speed.
  // Forgiving search: fuzzy name + barcode/sku/per-size codes (see productSearch.js).
  const matches = useMemo(
    () => searchProducts(products, q, { limit: 20, predicate: (p) => Array.isArray(p.sizes) && p.sizes.length }),
    [products, q]
  );
  const cells = useStockCells(loc || undefined);   // { pid: { size: cell } } for this loc
  const curQty = (size) => {
    const c = loc ? cells?.[productId]?.[size] : null;
    return c && typeof c.qty === "number" ? c.qty : 0;
  };
  const curState = (size) => loc ? (cells?.[productId]?.[size]?.state || "untracked") : "untracked";

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2800); };

  const commit = async () => {
    if (!loc || !product) return flash("err", "Pick a location and product.");
    // Counts must be whole numbers (the ledger stores integers).
    for (const s of sizes) {
      const raw = counts[s];
      if (raw != null && String(raw).trim() !== "" && !/^\d+$/.test(String(raw).trim()))
        return flash("err", `Count for size ${s} must be a whole number.`);
    }
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
        <Field label="Product">
          {product ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: CARD, border: BORDER, borderRadius: 9, padding: "7px 10px" }}>
              <Thumb url={product.photoUrl} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.name}</div>
              <button onClick={() => { setProductId(""); setCounts({}); setQ(""); }}
                style={{ background: "transparent", border: "1px solid rgba(60,110,255,.3)", borderRadius: 8, padding: "5px 10px", color: BLUE_L, fontSize: 11.5, cursor: "pointer" }}>Change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search product or barcode…"
                style={{ ...input, width: "100%", boxSizing: "border-box" }} />
              {q.trim() && (
                <div style={{ marginTop: 6, maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                  {matches.length === 0 ? (
                    <div style={{ fontSize: 12, color: GRAY, padding: "6px 2px" }}>No products match “{q.trim()}”.</div>
                  ) : matches.map(p => (
                    <button key={p.id} onClick={() => { setProductId(p.id); setCounts({}); setQ(""); }}
                      style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", background: CARD, border: BORDER, borderRadius: 9, padding: "6px 9px", cursor: "pointer" }}>
                      <Thumb url={p.photoUrl} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                        {p.category && <div style={{ fontSize: 10, color: GRAY }}>{p.category}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>
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

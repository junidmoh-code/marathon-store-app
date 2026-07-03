// ─── LABEL PRINT CARD (Assistant view) ────────────────────────────────────────
// Permanent, all-users card for printing a single product label on the Phomemo.
// FLOW: type a product name → forgiving search results → TAP a product → it
// reserves/reuses the product's scannable code and prints ONE label (NAME · PRICE
// · BARCODE) on the Phomemo. Reuses the existing infrastructure end-to-end:
//   • searchProducts  — the same forgiving matcher every product box uses
//   • ensureBarcode(id, null) — the product-level Code 128 (reverse-indexed at
//     /barcodes/{code} → {productId} so a POS scan resolves to this product)
//   • connectTransport + printLabels — the same Phomemo/BLE path as stock labels
// The print is kicked off straight from the tap so the Web Bluetooth device
// picker keeps a valid user-gesture (connect is the first await; the barcode
// reserve + raster happen after, on the already-open connection).

import React, { useMemo, useState } from "react";
import { searchProducts } from "../utils/productSearch";
import { ensureBarcode } from "./stock/barcodeStore";
import { connectTransport, printLabels, defaultTransportId } from "./stock/printers";

const RANDS = (v) =>
  v == null || v === "" || isNaN(Number(v)) ? "" : `R${Number(v).toLocaleString("en-ZA")}`;

export default function LabelPrintCard({ products = [] }) {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);       // product id currently printing
  const [toast, setToast] = useState(null);         // { kind: "ok"|"err", text }
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 4000); };

  const results = useMemo(() => searchProducts(products, query, { limit: 12 }), [products, query]);

  async function printLabel(product) {
    if (busyId) return;
    setBusyId(product.id);
    try {
      // 1. Open the printer INSIDE the tap gesture (device picker needs it the
      //    first time; silent reconnect after).
      const transport = defaultTransportId();
      const conn = await connectTransport(transport);
      // 2. Reserve/reuse the product's permanent, reverse-indexed code.
      const { code } = await ensureBarcode(product.id, null);
      // 3. Print one label: NAME · PRICE · BARCODE.
      const res = await printLabels({
        items: [{ code, productName: product.name, price: RANDS(product.retailPrice), count: 1 }],
        transport,
        conn,
      });
      if (res.ok) flash("ok", `Printed label — ${product.name}`);
      else flash("err", `Print failed: ${res.error}`);
    } catch (e) {
      const msg = String(e?.message || e);
      // Non-stockRole users can't MINT a brand-new code (the /barcodes index is
      // stockRole-gated); reprints of already-coded products work for everyone.
      flash("err", /permission|denied/i.test(msg)
        ? "No barcode yet for this product — a stock user needs to print it once first."
        : `Couldn't print: ${msg}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ margin: "0 13px 16px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(60,110,255,.25)", borderRadius: 14, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 16 }}>🏷️</span>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Print product label</div>
      </div>
      <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.4)", marginBottom: 10 }}>
        Search a product, then tap it to print a name · price · barcode label on the Phomemo.
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a product by name…"
        style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", borderRadius: 10, fontSize: 14,
                 background: "rgba(0,0,0,.25)", border: "1px solid rgba(60,110,255,.25)", color: "#fff", outline: "none", fontFamily: "inherit" }}
      />

      {query.trim() !== "" && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          {results.length === 0 && (
            <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.4)", padding: "8px 2px" }}>No products match “{query}”.</div>
          )}
          {results.map((p) => {
            const busy = busyId === p.id;
            const price = RANDS(p.retailPrice);
            return (
              <button
                key={p.id}
                onClick={() => printLabel(p)}
                disabled={!!busyId}
                style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left", width: "100%",
                         background: busy ? "rgba(60,110,255,.18)" : "rgba(255,255,255,.03)",
                         border: "1px solid rgba(60,110,255,.15)", borderRadius: 11, padding: 9,
                         cursor: busyId ? "default" : "pointer", opacity: busyId && !busy ? 0.45 : 1, fontFamily: "inherit" }}
              >
                {p.photoUrl
                  ? <img src={p.photoUrl} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }}
                      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                  : <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>👟</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "#7ea2ff", fontWeight: 700 }}>{price || "—"}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: busy ? "#7ea2ff" : "rgba(255,255,255,.55)", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  {busy ? "Printing…" : <>🖨️ Print</>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {toast && (
        <div style={{ marginTop: 11, padding: "9px 12px", borderRadius: 10, fontSize: 12.5, fontWeight: 600,
                      background: toast.kind === "ok" ? "rgba(0,150,70,.12)" : "rgba(248,113,113,.12)",
                      border: `1px solid ${toast.kind === "ok" ? "rgba(0,150,70,.35)" : "rgba(248,113,113,.35)"}`,
                      color: toast.kind === "ok" ? "#4ADE80" : "#F87171" }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ─── LABEL PRINT VIEW ─────────────────────────────────────────────────────────
// Standalone, all-users view (its own home card) for printing product labels on the
// Phomemo. Presents an ALWAYS-ON product grid — same look as the Store Assistant
// browse view: big photos, alphabetical, 2-up on phone / 5-up on iPad — with a
// search box to filter. TAP a product → it reserves/reuses the product's scannable
// code and prints ONE label (NAME · PRICE · BARCODE). Reuses the existing stock
// print path end-to-end (searchProducts · ensureBarcode · connectTransport ·
// printLabels). The print fires straight from the tap so the Web Bluetooth device
// picker keeps a valid user-gesture (connect is the first await; the barcode
// reserve + raster run on the already-open connection).

import React, { useMemo, useState } from "react";
import { searchProducts } from "../utils/productSearch";
import { ensureBarcode } from "./stock/barcodeStore";
import { connectTransport, printLabels, defaultTransportId } from "./stock/printers";
import { FONT } from "./stock/ui";

const RANDS = (v) =>
  v == null || v === "" || isNaN(Number(v)) ? "" : `R${Number(v).toLocaleString("en-ZA")}`;

const byName = (a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" });

export default function LabelPrintView({ products = [], onExit }) {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);       // product id currently printing
  const [toast, setToast] = useState(null);         // { kind: "ok"|"err", text }
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 4000); };

  // ALWAYS show products: empty query → the whole catalogue (alphabetical); a query
  // filters via the shared forgiving matcher, then re-sorted alphabetically.
  const shown = useMemo(() => {
    const base = query.trim() === "" ? (products || []).filter((p) => p && p.id && p.name) : searchProducts(products, query, { limit: 500 });
    return [...base].sort(byName);
  }, [products, query]);

  async function printLabel(product) {
    if (busyId) return;
    setBusyId(product.id);
    try {
      // Open the printer INSIDE the tap gesture (picker the first time; silent after).
      const transport = defaultTransportId();
      const conn = await connectTransport(transport);
      // Reserve/reuse the product's permanent, reverse-indexed code, then print.
      const { code } = await ensureBarcode(product.id, null);
      const res = await printLabels({
        items: [{ code, productName: product.name, price: RANDS(product.retailPrice), count: 1 }],
        transport,
        conn,
      });
      if (res.ok) flash("ok", `Printed label — ${product.name}`);
      else flash("err", `Print failed: ${res.error}`);
    } catch (e) {
      const msg = String(e?.message || e);
      flash("err", /permission|denied/i.test(msg)
        ? "No barcode yet for this product — a stock user needs to print it once first."
        : `Couldn't print: ${msg}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
      {/* Same responsive product-grid columns as the Assistant browse view. */}
      <style>{`
        .lp-grid { grid-template-columns: repeat(2, 1fr); }
        @media (min-width: 768px) { .lp-grid { grid-template-columns: repeat(5, 1fr); } }
      `}</style>

      {/* TOP BAR */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        <div onClick={onExit}
             style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Switch View</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: "0.5px" }}>Viewing as:</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: "0.5px" }}>PRINT LABELS</div>
        </div>
        <div style={{ width: 92 }} />
      </div>

      <div style={{ padding: "0 14px 4px" }}>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,.4)" }}>Tap a product to print a name · price · barcode label on the Phomemo</div>
      </div>

      {/* SEARCH */}
      <div style={{ padding: "10px 14px 6px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a product by name…"
          style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 12, fontSize: 15,
                   background: "rgba(0,0,0,.25)", border: "1px solid rgba(60,110,255,.25)", color: "#fff", outline: "none", fontFamily: FONT }}
        />
      </div>

      {toast && (
        <div style={{ margin: "6px 14px 0", padding: "10px 13px", borderRadius: 11, fontSize: 13, fontWeight: 600,
                      background: toast.kind === "ok" ? "rgba(0,150,70,.12)" : "rgba(248,113,113,.12)",
                      border: `1px solid ${toast.kind === "ok" ? "rgba(0,150,70,.35)" : "rgba(248,113,113,.35)"}`,
                      color: toast.kind === "ok" ? "#4ADE80" : "#F87171" }}>
          {toast.text}
        </div>
      )}

      {/* PRODUCT GRID — always on, alphabetical, big photos. */}
      <div style={{ padding: "12px 14px 0" }}>
        {shown.length === 0 ? (
          <div style={{ textAlign: "center", color: "rgba(255,255,255,.4)", fontSize: 14, padding: "40px 0" }}>
            {query.trim() ? `No products match “${query}”.` : "No products yet."}
          </div>
        ) : (
          <div className="lp-grid" style={{ display: "grid", gap: 10 }}>
            {shown.map((p) => {
              const busy = busyId === p.id;
              const price = RANDS(p.retailPrice);
              return (
                <div key={p.id} onClick={() => printLabel(p)}
                     style={{ background: busy ? "rgba(20,40,100,.3)" : "rgba(255,255,255,.03)",
                              border: busy ? "2px solid #4A7FFF" : "1px solid rgba(255,255,255,.06)",
                              borderRadius: 12, overflow: "hidden", cursor: busyId ? "default" : "pointer", position: "relative",
                              opacity: busyId && !busy ? 0.5 : 1, boxShadow: busy ? "0 0 16px rgba(60,110,255,.2)" : "none" }}>
                  <div style={{ width: "100%", height: 140, position: "relative", background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 52 }}>
                    {p.photoUrl
                      ? <img src={p.photoUrl} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
                      : <span>{p.photo || "👟"}</span>}
                  </div>
                  <div style={{ padding: "12px 13px 14px" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#7ea2ff", marginBottom: 4 }}>{price || "—"}</div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: busy ? "#7ea2ff" : "#4A7FFF" }}>{busy ? "Printing…" : "🖨️ Tap to print →"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

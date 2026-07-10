// ─── LABEL PRINT VIEW ─────────────────────────────────────────────────────────
// Standalone, all-users view for printing product labels on the Phomemo. An
// always-on product grid (big photos, alphabetical) with search + store/category
// filters. Instead of firing one label per tap, tapping a product now adds it to
// a PRINT QUEUE (cart) — set a quantity per product, then print the whole batch in
// one go. Reuses the existing stock print path end-to-end (searchProducts ·
// ensureBarcode · connectTransport · printLabels). The batch print fires from the
// "Print" button's click so the Web Bluetooth device picker keeps a valid
// user-gesture (connect is the first await; barcode reserve + raster run on the
// already-open connection). ≥1024px gets the desktop workspace (rail + browse +
// sticky queue); mobile keeps a single column with the queue inline.

import React, { useMemo, useState } from "react";
import { searchProducts } from "../utils/productSearch";
import { ensureBarcode } from "./stock/barcodeStore";
import { connectTransport, printLabels, defaultTransportId } from "./stock/printers";
import { useLocations, useStockCells } from "./stock/useStock";
import { sellableLocations, labelFor } from "./stock/locations";
import { useWide } from "./stock/hooks";
import { FONT } from "./stock/ui";

const RANDS = (v) =>
  v == null || v === "" || isNaN(Number(v)) ? "" : `R${Number(v).toLocaleString("en-ZA")}`;

const byName = (a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" });

// Workspace filter chip — neutral glass, blue when active (matches the rest of
// the redesigned app; replaces the old blue-heavy chip).
const chip = (on) => ({
  padding: "7px 13px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: FONT,
  border: on ? "1px solid rgba(74,127,255,.45)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(74,127,255,.16)" : "rgba(255,255,255,.03)",
  color: on ? "#9DBCFF" : "rgba(233,238,255,.55)",
  transition: "background .14s, color .14s, border-color .14s",
});

function Thumb({ p, size = 44, radius = 10 }) {
  if (p?.photoUrl) return <img src={p.photoUrl} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: radius, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: radius, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>{p?.photo || "👟"}</div>;
}

export default function LabelPrintView({ products = [], onExit }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("all");            // category filter (Footwear / Accessories / …)
  const [store, setStore] = useState("all");        // store filter (Marathon PE / Trophy / …)
  const [cart, setCart] = useState({});             // { [productId]: { product, qty } } — the print queue
  const [busy, setBusy] = useState(false);          // batch print in flight
  const [toast, setToast] = useState(null);         // { kind: "ok"|"err", text }
  const isWide = useWide(1024);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 4500); };

  // Category chips are data-driven — every product has a `category`.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Store picker — the sellable shops. A chosen store limits the grid to products
  // with stock recorded at that store. useStockCells("all") → {} (no such node).
  const registry = useLocations();
  const stores = useMemo(() => sellableLocations(registry), [registry]);
  const storeCells = useStockCells(store);

  const shown = useMemo(() => {
    const predicate = (p) => {
      if (cat !== "all" && p.category !== cat) return false;
      if (store !== "all" && !storeCells[p.id]) return false;
      return true;
    };
    const base = query.trim() === ""
      ? (products || []).filter((p) => p && p.id && p.name && predicate(p))
      : searchProducts(products, query, { predicate, limit: 2000 });
    return [...base].sort(byName);
  }, [products, query, cat, store, storeCells]);

  // ── Cart (print queue) ─────────────────────────────────────────────────────
  const cartItems = useMemo(
    () => Object.values(cart).sort((a, b) => byName(a.product, b.product)),
    [cart]
  );
  const totalLabels = cartItems.reduce((s, it) => s + it.qty, 0);
  const addToCart = (p) => setCart((prev) => ({ ...prev, [p.id]: { product: p, qty: (prev[p.id]?.qty || 0) + 1 } }));
  const setQty = (id, qty) => setCart((prev) => {
    const next = { ...prev };
    if (qty <= 0) delete next[id];
    else if (next[id]) next[id] = { ...next[id], qty };
    return next;
  });
  const clearCart = () => setCart({});

  async function printBatch() {
    if (busy || cartItems.length === 0) return;
    setBusy(true);
    try {
      // Open the printer INSIDE the click gesture (picker the first time; silent after).
      const transport = defaultTransportId();
      const conn = await connectTransport(transport);
      // Reserve/reuse each product's permanent code, then print the whole batch.
      const items = [];
      const skipped = [];
      for (const { product, qty } of cartItems) {
        try {
          const { code } = await ensureBarcode(product.id, null);
          items.push({ code, productName: product.name, price: RANDS(product.retailPrice), count: qty });
        } catch {
          skipped.push(product.name);   // no barcode yet (needs a stock user once) — skip, keep the rest
        }
      }
      if (items.length === 0) {
        flash("err", "No printable barcodes in the queue — a stock user must print each once first.");
        return;
      }
      const res = await printLabels({ items, transport, conn });
      if (res.ok) {
        const n = items.reduce((s, i) => s + i.count, 0);
        flash("ok", `Printed ${n} label${n !== 1 ? "s" : ""}${skipped.length ? ` · ${skipped.length} skipped (no barcode)` : ""}`);
        setCart({});
      } else {
        flash("err", `Print failed: ${res.error}`);
      }
    } catch (e) {
      flash("err", `Couldn't print: ${String(e?.message || e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Shared pieces ───────────────────────────────────────────────────────────
  const searchEl = (
    <div style={{ position: "relative", width: "100%", maxWidth: isWide ? 320 : 560 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: .4 }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a product by name…"
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px 10px 36px", borderRadius: 11, fontSize: 13.5,
                 background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)", color: "#fff", outline: "none", fontFamily: FONT }} />
    </div>
  );

  const filtersEl = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
      {stores.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "rgba(233,238,255,.35)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginRight: 2 }}>Store</span>
          {[{ id: "all", label: "All stores" }, ...stores.map((s) => ({ id: s.id, label: labelFor(s.id, registry) }))].map((o) => (
            <button key={o.id} onClick={() => setStore(o.id)} style={chip(store === o.id)}>{o.label}</button>
          ))}
        </div>
      )}
      {categories.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "rgba(233,238,255,.35)", textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, marginRight: 2 }}>Category</span>
          {["all", ...categories].map((c) => (
            <button key={c} onClick={() => setCat(c)} style={chip(cat === c)}>{c === "all" ? "All" : c}</button>
          ))}
        </div>
      )}
    </div>
  );

  const toastEl = toast ? (
    <div style={{ margin: "0 0 14px", padding: "10px 13px", borderRadius: 11, fontSize: 13, fontWeight: 600,
      background: toast.kind === "ok" ? "rgba(74,222,128,.1)" : "rgba(248,113,113,.1)",
      border: `1px solid ${toast.kind === "ok" ? "rgba(74,222,128,.35)" : "rgba(248,113,113,.35)"}`,
      color: toast.kind === "ok" ? "#4ADE80" : "#F87171" }}>
      {toast.text}
    </div>
  ) : null;

  const gridCols = isWide ? "repeat(auto-fill, minmax(150px, 1fr))" : "repeat(2, 1fr)";
  const gridEl = shown.length === 0 ? (
    <div style={{ textAlign: "center", color: "rgba(255,255,255,.4)", fontSize: 14, padding: "48px 0" }}>
      {query.trim()
        ? `No products match “${query}”.`
        : store !== "all"
          ? `No ${cat !== "all" ? cat.toLowerCase() + " " : ""}products with stock at ${labelFor(store, registry)}.`
          : cat !== "all" ? `No ${cat} products.` : "No products yet."}
    </div>
  ) : (
    <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 12 }}>
      {shown.map((p) => {
        const inCart = cart[p.id]?.qty || 0;
        const price = RANDS(p.retailPrice);
        return (
          <div key={p.id} onClick={() => addToCart(p)}
            style={{ background: "rgba(255,255,255,.024)", border: inCart ? "1px solid rgba(74,127,255,.5)" : "1px solid rgba(255,255,255,.08)",
                     borderRadius: 14, overflow: "hidden", cursor: "pointer", position: "relative", transition: "border-color .14s, transform .14s",
                     boxShadow: inCart ? "0 14px 34px -22px rgba(74,127,255,.5)" : "none" }}>
            {inCart > 0 && (
              <div style={{ position: "absolute", top: 8, right: 8, zIndex: 2, minWidth: 22, height: 22, padding: "0 6px", borderRadius: 999, background: "#4A7FFF", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 12px -2px rgba(74,127,255,.7)" }}>{inCart}</div>
            )}
            <div style={{ width: "100%", aspectRatio: "1 / 1", position: "relative", background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 46 }}>
              {p.photoUrl
                ? <img src={p.photoUrl} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
                : <span>{p.photo || "👟"}</span>}
            </div>
            <div style={{ padding: "11px 12px 12px" }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#9DBCFF", fontVariantNumeric: "tabular-nums" }}>{price || "—"}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: inCart ? "#9DBCFF" : "rgba(233,238,255,.4)", display: "flex", alignItems: "center", gap: 4 }}>
                  {inCart ? `${inCart} queued` : (<>+ Add</>)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  // Print queue panel — sticky rail on desktop, inline block on mobile.
  const queueEl = (
    <div style={{ background: "rgba(255,255,255,.024)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 15px", borderBottom: "1px solid rgba(255,255,255,.07)", display: "flex", alignItems: "center", gap: 10 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9DBCFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: "#fff" }}>Print queue</div>
          <div style={{ fontSize: 11, color: "rgba(233,238,255,.45)", marginTop: 1 }}>{totalLabels} label{totalLabels !== 1 ? "s" : ""} · {cartItems.length} product{cartItems.length !== 1 ? "s" : ""}</div>
        </div>
        {cartItems.length > 0 && (
          <button onClick={clearCart} style={{ background: "transparent", border: "none", color: "rgba(233,238,255,.5)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 4 }}>Clear</button>
        )}
      </div>

      {cartItems.length === 0 ? (
        <div style={{ padding: "26px 18px", textAlign: "center", color: "rgba(233,238,255,.4)", fontSize: 12.5, lineHeight: 1.5 }}>
          Tap products to build a batch, then print them all at once.
        </div>
      ) : (
        <div style={{ maxHeight: isWide ? "calc(100vh - 320px)" : 360, overflow: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          {cartItems.map(({ product: p, qty }) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 11, padding: 8 }}>
              <Thumb p={p} size={40} radius={9} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#9DBCFF", marginTop: 1, fontVariantNumeric: "tabular-nums" }}>{RANDS(p.retailPrice) || "—"}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <button onClick={() => setQty(p.id, qty - 1)} aria-label="Decrease" style={qtyBtn}>−</button>
                <span style={{ minWidth: 22, textAlign: "center", fontSize: 13, fontWeight: 800, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{qty}</span>
                <button onClick={() => setQty(p.id, qty + 1)} aria-label="Increase" style={qtyBtn}>+</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: 12, borderTop: "1px solid rgba(255,255,255,.07)" }}>
        <button onClick={printBatch} disabled={busy || totalLabels === 0}
          style={{ width: "100%", padding: "12px", borderRadius: 11, border: "none", fontSize: 13.5, fontWeight: 800, fontFamily: FONT,
                   cursor: busy || totalLabels === 0 ? "not-allowed" : "pointer",
                   background: totalLabels === 0 ? "rgba(255,255,255,.05)" : "rgba(74,127,255,.92)",
                   color: totalLabels === 0 ? "rgba(233,238,255,.35)" : "#fff",
                   display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {busy ? "Printing…" : totalLabels === 0 ? "Queue is empty" : `Print ${totalLabels} label${totalLabels !== 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );

  // ── DESKTOP WORKSPACE (≥1024px) — rail + browse + sticky queue ──
  if (isWide) {
    return (
      <div style={{ height: "100vh", background: "#000", color: "#f3f6ff", fontFamily: FONT, display: "grid", gridTemplateColumns: "236px minmax(0,1fr)", overflow: "hidden" }}>
        {/* RAIL */}
        <aside style={{ background: "rgba(255,255,255,.015)", borderRight: "1px solid rgba(255,255,255,.08)", padding: "22px 13px 16px", display: "flex", flexDirection: "column", gap: 3, overflow: "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 9px 10px" }}>
            <span style={{ fontSize: 19, fontWeight: 800, fontStyle: "italic", letterSpacing: -.6 }}>marathon</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 5, color: "#4A7FFF" }}>CLUB</span>
          </div>
          <button onClick={onExit} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "rgba(233,238,255,.6)", borderRadius: 10, padding: "9px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT, marginBottom: 10 }}>← Exit</button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(74,127,255,.1)", border: "1px solid rgba(74,127,255,.32)", borderRadius: 11, padding: "10px 12px" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9DBCFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: "#cfe0ff" }}>Print Labels</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ background: "rgba(255,255,255,.022)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 11, padding: "11px 12px" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: totalLabels ? "#9DBCFF" : "rgba(233,238,255,.5)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{totalLabels}</div>
            <div style={{ fontSize: 10, color: "rgba(233,238,255,.45)", marginTop: 4, letterSpacing: ".04em", textTransform: "uppercase", fontWeight: 600 }}>Labels queued</div>
          </div>
        </aside>

        {/* MAIN */}
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "20px 30px 18px", borderBottom: "1px solid rgba(255,255,255,.08)", background: "radial-gradient(800px 280px at 15% -60%, rgba(74,127,255,.08), transparent)", display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: -.4 }}>Print Labels</div>
              <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.55)", marginTop: 3 }}>Add products to the queue, set quantities, then print the batch — name · price · barcode.</div>
            </div>
            {searchEl}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "18px 30px 40px" }}>
            {toastEl}
            <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {filtersEl}
                {gridEl}
              </div>
              <div style={{ width: 320, flexShrink: 0, position: "sticky", top: 0 }}>
                {queueEl}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── MOBILE — single column, queue inline above the grid ──
  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
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

      <div style={{ padding: "0 14px 8px" }}>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,.4)", marginBottom: 12 }}>Tap products to queue them, then print the batch — name · price · barcode.</div>
        {searchEl}
      </div>

      <div style={{ padding: "12px 14px 0" }}>
        {toastEl}
        {filtersEl}
        {cartItems.length > 0 && <div style={{ marginBottom: 16 }}>{queueEl}</div>}
        {gridEl}
      </div>
    </div>
  );
}

const qtyBtn = {
  width: 26, height: 26, borderRadius: 8, border: "1px solid rgba(255,255,255,.14)", background: "rgba(255,255,255,.05)",
  color: "#dfe7ff", fontSize: 15, fontWeight: 800, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT,
};

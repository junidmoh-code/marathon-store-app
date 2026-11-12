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
import { isDeactivated } from "../utils/deactivation";
import { ensureBarcode } from "./stock/barcodeStore";
import { TRANSPORTS, connectTransport, printLabels, defaultTransportId, rememberTransport } from "./stock/printers";
import PrinterStatus from "./stock/PrinterStatus";
import { useLocations, useStockCells } from "./stock/useStock";
import { sellableLocations, labelFor } from "./stock/locations";
import { useWide } from "./stock/hooks";
import { withinScope } from "../utils/shopScope";
import { useMySections } from "../utils/useMySections";
import { PrimaryPhoto } from "./shared/PrimaryPhoto.jsx";
import "../styles/sky-barcode.css";

const RANDS = (v) =>
  v == null || v === "" || isNaN(Number(v)) ? "" : `R${Number(v).toLocaleString("en-ZA")}`;

const byName = (a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" });

function Thumb({ p, size = 44, radius = 10 }) {
  if (p?.photoUrl) return <PrimaryPhoto product={p} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: radius, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: radius, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>{p?.photo || "👟"}</div>;
}

// myShop: the viewer's destShop. A one-shop account picks only its own shop.
export default function LabelPrintView({ products = [], onExit, myShop = null }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("all");            // category filter (Footwear / Accessories / …)
  const [store, setStore] = useState("all");        // store filter (Marathon PE / Trophy / …)
  const [cart, setCart] = useState({});             // { [productId]: { product, qty } } — the print queue
  const [busy, setBusy] = useState(false);          // batch print in flight
  const [toast, setToast] = useState(null);         // { kind: "ok"|"err", text }
  const isWide = useWide(1024);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 4500); };
  // USB label printer on a desktop, Phomemo on a phone; a pick here is remembered.
  const [transport, setTransportState] = useState(defaultTransportId);
  const setTransport = (id) => { rememberTransport(id); setTransportState(id); };
  const transports = TRANSPORTS.filter(t => t.supported());

  // Category chips are data-driven — every product has a `category`.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Store picker — the sellable shops. A chosen store limits the grid to products
  // with stock recorded at that store. useStockCells("all") → {} (no such node).
  const registry = useLocations();
  const { canSee } = useMySections();
  const stores = useMemo(() => withinScope(sellableLocations(registry), myShop).filter((s) => canSee(s.id)), [registry, myShop, canSee]);
  // A shop outside the viewer's scope is never read, whatever was picked.
  const storeId = store === "all" || stores.some((s) => s.id === store) ? store : "all";
  const storeCells = useStockCells(storeId);

  const shown = useMemo(() => {
    const predicate = (p) => {
      // Off every staff list (owner spec 2026-09-05, BUG 1): Print Labels is
      // open to every signed-in staff member, not the stockRole-gated admin
      // section, so a retired line is neither printable nor findable here.
      if (isDeactivated(p)) return false;
      if (cat !== "all" && p.category !== cat) return false;
      if (storeId !== "all" && !storeCells[p.id]) return false;
      return true;
    };
    const base = query.trim() === ""
      ? (products || []).filter((p) => p && p.id && p.name && predicate(p))
      : searchProducts(products, query, { predicate, limit: 2000 });
    return [...base].sort(byName);
  }, [products, query, cat, storeId, storeCells]);

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
      const conn = await connectTransport(transport);
      // Reserve/reuse each product's permanent code, then print the whole batch.
      const items = [];
      const skipped = [];
      for (const { product, qty } of cartItems) {
        try {
          const { code } = await ensureBarcode(product.id, null);
          items.push({ code, productName: product.name, price: RANDS(product.retailPrice), count: qty });
        } catch {
          skipped.push(product);   // no barcode yet (needs a stock user once) — skip, keep the rest
        }
      }
      if (items.length === 0) {
        flash("err", "No printable barcodes in the queue — a stock user must print each once first.");
        return;
      }
      const res = await printLabels({ items, transport, conn });
      if (res.ok && res.unconfirmed) {
        // A print dialog was shown — it may have been cancelled. Keep the queue.
        flash("ok", `Sent ${items.reduce((s, i) => s + i.count, 0)} label(s) to ${res.routeLabel}${skipped.length ? ` · ${skipped.length} skipped (no barcode)` : ""} — the queue is kept until you clear it.`);
      } else if (res.ok) {
        const n = items.reduce((s, i) => s + i.count, 0);
        flash("ok", `Printed ${n} label${n !== 1 ? "s" : ""}${res.routeLabel ? ` · ${res.routeLabel}` : ""}${skipped.length ? ` · ${skipped.length} skipped (no barcode)` : ""}`);
        // Clear only what printed — keep the skipped (no-barcode) items in the
        // queue so staff can see and fix them rather than lose track.
        setCart(prev => { const next = {}; for (const p of skipped) if (prev[p.id]) next[p.id] = prev[p.id]; return next; });
      } else {
        flash("err", `Print failed: ${res.error}`);
      }
    } catch (e) {
      flash("err", `Couldn't print: ${String(e?.message || e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Shared pieces (sky, Junid 12 Nov: the Stock screen's chip/search/card
  // rules; classes in src/styles/sky-barcode.css). Presentation only. ──
  const searchEl = (
    <div className="lpv__srch">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
      <input className="lpv__in" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a product by name…" aria-label="Search products" />
    </div>
  );

  const storeOpts = [{ id: "all", label: myShop ? "All products" : "All stores" }, ...stores.map((s) => ({ id: s.id, label: labelFor(s.id, registry) }))];
  const filtersEl = (
    <div className="lpv__filters">
      {stores.length > 0 && (
        <div className="lpv__frow">
          <span className="lpv__lab">Store</span>
          <div className="lpv__chips" data-chip-row="" data-scroll="">
            {storeOpts.map((o) => (
              <button key={o.id} type="button" className="lpv__chip" aria-pressed={storeId === o.id} onClick={() => setStore(o.id)}>{o.label}</button>
            ))}
          </div>
        </div>
      )}
      {categories.length > 1 && (
        <div className="lpv__frow">
          <span className="lpv__lab">Category</span>
          <div className="lpv__chips" data-chip-row="" data-scroll="">
            {["all", ...categories].map((c) => (
              <button key={c} type="button" className="lpv__chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{c === "all" ? "All" : c}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const toastEl = toast ? <div className="lpv__toast" data-kind={toast.kind}>{toast.text}</div> : null;

  const gridEl = shown.length === 0 ? (
    <div className="lpv__none">
      {query.trim()
        ? `No products match “${query}”.`
        : storeId !== "all"
          ? `No ${cat !== "all" ? cat.toLowerCase() + " " : ""}products with stock at ${labelFor(storeId, registry)}.`
          : cat !== "all" ? `No ${cat} products.` : "No products yet."}
    </div>
  ) : (
    <div className={isWide ? "lpv__grid lpv__grid--wide" : "lpv__grid"}>
      {shown.map((p) => {
        const inCart = cart[p.id]?.qty || 0;
        const price = RANDS(p.retailPrice);
        return (
          <div key={p.id} className="lpv__card" data-in={inCart ? "1" : undefined} onClick={() => addToCart(p)}>
            {inCart > 0 && <div className="lpv__qn">{inCart}</div>}
            <div className="lpv__ph">
              {p.photoUrl
                ? <PrimaryPhoto product={p} alt={p.name} onError={(e) => { e.currentTarget.style.display = "none"; }} />
                : <span>{p.photo || "👟"}</span>}
            </div>
            <div className="lpv__bd">
              <div className="lpv__nm">{p.name}</div>
              <div className="lpv__ft">
                <span className="lpv__pr">{price || "—"}</span>
                <span className="lpv__add">{inCart ? `${inCart} queued` : "+ Add"}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  // Print queue panel — sticky column on desktop, inline block on mobile.
  const queueEl = (
    <div className="lpv__q">
      <div className="lpv__qh">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--sky-ink)" }}><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
        <div style={{ flex: 1 }}>
          <div className="lpv__qt">Print queue</div>
          <div className="lpv__qs">{totalLabels} label{totalLabels !== 1 ? "s" : ""} · {cartItems.length} product{cartItems.length !== 1 ? "s" : ""}</div>
        </div>
        {cartItems.length > 0 && <button type="button" className="lpv__clear" onClick={clearCart}>Clear</button>}
      </div>

      {cartItems.length === 0 ? (
        <div className="lpv__qe">Tap products to build a batch, then print them all at once.</div>
      ) : (
        <div style={{ maxHeight: isWide ? "calc(100vh - 360px)" : 360, overflow: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
          {cartItems.map(({ product: p, qty }) => (
            <div key={p.id} className="lpv__qi">
              <Thumb p={p} size={40} radius={9} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="lpv__qin">{p.name}</div>
                <div className="lpv__qip">{RANDS(p.retailPrice) || "—"}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                <button type="button" className="lpv__step" onClick={() => setQty(p.id, qty - 1)} aria-label="Decrease">−</button>
                <span className="lpv__qn2">{qty}</span>
                <button type="button" className="lpv__step" onClick={() => setQty(p.id, qty + 1)} aria-label="Increase">+</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="lpv__qf">
        {transports.length > 1 && (
          <div className="lpv__seg">
            {transports.map(t => (
              <button key={t.id} type="button" className="lpv__chip" aria-pressed={transport === t.id} onClick={() => setTransport(t.id)} disabled={busy}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="lpv__print" onClick={printBatch} disabled={busy || totalLabels === 0}>
          {busy ? "Printing…" : totalLabels === 0 ? "Queue is empty" : `Print ${totalLabels} label${totalLabels !== 1 ? "s" : ""}`}
        </button>
        {transport === "xprinter" && <PrinterStatus style={{ marginTop: 9 }} />}
      </div>
    </div>
  );

  // ── DESKTOP WORKSPACE (≥1024px) — browse + sticky queue, under the shell
  // header (its grid button is the way back; no in-page Exit, no second
  // wordmark — the header pill already says LABELS). ──
  if (isWide) {
    return (
      <div className="lpv lpv--wide" data-testid="label-print">
        <div className="lpv__browse" data-scroll="">
          {/* One glass head (navy never sits on the bare sky): the quiet hint
              beside the search, then the two chip rows. No second title — the
              header pill already says LABELS. */}
          <div className="lpv__head">
            <div className="lpv__top">
              <div className="lpv__hint" style={{ margin: 0 }}>Add products to the queue, set quantities, then print the batch — name · price · barcode.</div>
              {searchEl}
            </div>
            {filtersEl}
          </div>
          {toastEl}
          {gridEl}
        </div>
        <aside className="lpv__side" data-scroll="">{queueEl}</aside>
      </div>
    );
  }

  // ── MOBILE — single column, queue inline above the grid ──
  return (
    <div className="lpv lpv--phone" data-testid="label-print">
      <div className="lpv__head">
        <div className="lpv__hint">Tap products to queue them, then print the batch — name · price · barcode.</div>
        {searchEl}
        {filtersEl}
      </div>
      {toastEl}
      {cartItems.length > 0 && <div style={{ marginBottom: 16 }}>{queueEl}</div>}
      {gridEl}
    </div>
  );
}

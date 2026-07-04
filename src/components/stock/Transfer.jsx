// ─── TRANSFER (source-first, minimal) ─────────────────────────────────────────
// Redesigned per Junid: pick the SOURCE location first → the grid then shows ONLY
// what's actually in that location (with the available qty per size, so you can't
// over-transfer) → filter by category → build per-size quantities → pick a clean
// destination → confirm. Each basket line becomes ONE atomic `transfer_out`
// movement carrying a REAL from + to (no in_transit hop).
//
// CONSCIOUS TRADEOFF (unchanged): the dispatch → in-transit → confirm-receive
// ceremony is dropped — a transfer is instantaneous in the ledger (totals conserve
// via applyMovement's paired −from/+to). See design/INVENTORY-DESIGN.md §2.
//
// Source/destination can be any of the stock locations (warehouses, hubs, shops):
// warehouse→hub, hub→shop, any→any. Open Source refill requests can be prefilled
// and are closed atomically on a successful transfer.

import React, { useState, useMemo, useEffect } from "react";
import { ref, update, push, child } from "firebase/database";
import { database } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { useRefillRequests, useStockCells } from "./useStock";
import { transferTargets, labelFor, RECEIVING_DEFAULT } from "./locations";
import { Toast, Empty } from "./widgets";
import { GLASS, GLASS_SOLID, CARD, BLUE_L, GREEN, GRAY, AMBER, BORDER, FONT, input, bGreen, bGhost } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { SizeTag } from "../SizeTag";
import FilterPicker from "./FilterPicker";

const keyOf = (pid, size) => `${pid}__${size}`;

// Compact filter chip (source + category rows).
const chip = (on) => ({
  padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, fontWeight: 700, fontFamily: FONT, whiteSpace: "nowrap",
  border: on ? "1px solid #4A7FFF" : "1px solid rgba(60,110,255,.22)",
  background: on ? "rgba(60,110,255,.22)" : "rgba(255,255,255,.03)",
  color: on ? "#fff" : "rgba(255,255,255,.5)",
});

function Thumb({ product, size = 44 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

export default function Transfer({ products, registry, actorRole }) {
  const [from, setFrom] = useState(RECEIVING_DEFAULT);   // SOURCE — picked first
  const [cat, setCat] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);            // expanded product id
  const [basket, setBasket] = useState({});              // { pid__size: { productId, productName, size, qty } }
  const [refillId, setRefillId] = useState(null);
  const [to, setTo] = useState("");                      // destination
  const [picking, setPicking] = useState(false);         // destination sheet open
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const openRefills = useRefillRequests("open");
  const srcCells = useStockCells(from);                  // { pid: { size: cell } } at the source

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3000); };

  const locations = useMemo(() => transferTargets(registry), [registry]);
  // On-hand at the SOURCE — the cap for every transfer line.
  const avail = (pid, size) => { const c = srcCells?.[pid]?.[size]; return c && typeof c.qty === "number" ? c.qty : 0; };
  const srcTotal = (pid) => Object.values(srcCells?.[pid] || {}).reduce((s, c) => s + (typeof c?.qty === "number" ? c.qty : 0), 0);

  // Category chips are data-driven from what's ACTUALLY at the source.
  const categories = useMemo(() => {
    const set = new Set();
    for (const p of products || []) if (p?.category && srcCells?.[p.id] && srcTotal(p.id) > 0) set.add(String(p.category));
    return [...set].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, srcCells]);

  // Only products WITH stock at the source; then category + forgiving search.
  const shown = useMemo(() => {
    const atSource = (products || []).filter((p) => p && p.id && p.name && srcCells?.[p.id] && srcTotal(p.id) > 0);
    const predicate = (p) => cat === "all" || p.category === cat;
    const base = search.trim() ? searchProducts(atSource, search, { predicate, limit: 500 }) : atSource.filter(predicate);
    return [...base].sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, srcCells, cat, search]);

  const lines = useMemo(() => Object.values(basket).filter((l) => l.qty > 0), [basket]);
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  const setQty = (product, size, qty) => {
    const max = avail(product.id, size);
    const n = Math.max(0, Math.min(max, parseInt(qty, 10) || 0));
    setBasket((b) => {
      const next = { ...b };
      const k = keyOf(product.id, size);
      if (n <= 0) delete next[k];
      else next[k] = { productId: product.id, productName: product.name, size, qty: n };
      return next;
    });
  };
  const bump = (product, size, delta) => setQty(product, size, (basket[keyOf(product.id, size)]?.qty || 0) + delta);
  const clearBasket = () => { setBasket({}); setRefillId(null); };

  // Changing the source invalidates the basket (its lines were counted at the old
  // source). Reset so quantities always reflect what's actually available here.
  const pickSource = (id) => { if (id === from) return; setFrom(id); setBasket({}); setOpenId(null); setRefillId(null); if (to === id) setTo(""); };

  const prefillRefill = (r) => {
    const p = products.find((x) => x.id === r.productId);
    setBasket({ [keyOf(r.productId, r.size)]: { productId: r.productId, productName: p?.name || r.productId, size: r.size, qty: r.qty || 1 } });
    setRefillId(r.id);
    setTo(r.requestingLocation || "");
    setOpenId(r.productId);
    flash("ok", "Prefilled from refill — check the source has stock, then confirm.");
  };

  // Clear a stale destination if it ends up equal to the source.
  useEffect(() => { if (to && to === from) setTo(""); }, [from, to]);

  const doTransfer = async () => {
    if (!from || !to) return flash("err", "Pick a destination.");
    if (from === to) return flash("err", "Source and destination must differ.");
    if (!lines.length) return flash("err", "Add at least one quantity.");
    setBusy(true);
    const transferId = push(child(ref(database), "transfers")).key;
    let ok = 0, fail = 0;
    for (const ln of lines) {
      const res = await applyMovement({
        type: "transfer_out", productId: ln.productId, size: ln.size, qty: ln.qty,
        from, to, actorRole, link: { transferId, refillId: refillId || null },
      });
      res.ok ? ok++ : fail++;
    }
    if (refillId && ok > 0) {
      await update(ref(database), {
        [`refill_requests/${refillId}/status`]: "fulfilled",
        [`refill_requests/${refillId}/fulfilledBy`]: { transferId },
        [`refill_requests/${refillId}/resolvedAt`]: new Date().toISOString(),
      }).catch(() => {});
    }
    setBusy(false);
    setPicking(false);
    if (ok > 0) { clearBasket(); setTo(""); }
    flash(fail ? "err" : "ok",
      fail ? `${ok} moved, ${fail} failed (insufficient stock at ${labelFor(from, registry)} or no permission)`
           : `Transferred ${ok} line(s) → ${labelFor(to, registry)}`);
  };

  return (
    <div>
      {/* Open refill requests (Source chain) — prefill a transfer */}
      {openRefills.length > 0 && (
        <div style={{ ...GLASS, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>Open refill requests</div>
          {openRefills.map((r) => {
            const nm = products.find((p) => p.id === r.productId)?.name || r.productId;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: BORDER, fontSize: 13 }}>
                <span style={{ color: "#fff" }}>{nm} · <SizeTag size={r.size} /> ×{r.qty || 1}<span style={{ color: GRAY }}> → {labelFor(r.requestingLocation, registry)}</span></span>
                <button onClick={() => prefillRefill(r)} style={{ ...bGhost, padding: "5px 10px", fontSize: 12 }}>Prefill</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Source (pick first — the grid shows only what's here) + Category, as
          collapsible cards. Category only shows categories present at the source. */}
      <FilterPicker label="Transfer from" value={from} onChange={pickSource}
        options={locations.map((l) => ({ id: l.id, label: labelFor(l.id, registry) }))} />
      {categories.length > 1 && (
        <FilterPicker label="Category" value={cat} onChange={setCat}
          options={[{ id: "all", label: "All" }, ...categories.map((c) => ({ id: c, label: c }))]} />
      )}

      {/* Search */}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search in ${labelFor(from, registry)}…`}
             style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />

      {/* Product list — only products with stock at the source. */}
      {shown.length === 0 ? (
        <Empty>{search.trim() ? "No products match." : `Nothing in stock at ${labelFor(from, registry)}.`}</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: lines.length ? 84 : 8 }}>
          {shown.map((p) => {
            const expanded = openId === p.id;
            const sizes = (Array.isArray(p.sizes) ? p.sizes : []).filter((sz) => avail(p.id, sz) > 0);
            const inBasket = sizes.reduce((s, sz) => s + (basket[keyOf(p.id, sz)]?.qty || 0), 0);
            return (
              <div key={p.id} style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
                <div onClick={() => setOpenId(expanded ? null : p.id)} style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                  <Thumb product={p} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{srcTotal(p.id)} in stock · {sizes.length} size{sizes.length === 1 ? "" : "s"}</div>
                  </div>
                  {inBasket > 0 && <span style={{ background: "rgba(74,222,128,.16)", color: GREEN, border: "1px solid rgba(74,222,128,.4)", borderRadius: 20, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>{inBasket}</span>}
                  <span style={{ color: BLUE_L, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                </div>
                {expanded && (
                  <div style={{ padding: "0 11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 8 }}>
                    {sizes.map((sz) => {
                      const max = avail(p.id, sz);
                      const qty = basket[keyOf(p.id, sz)]?.qty || 0;
                      return (
                        <div key={sz} style={{ background: CARD, border: qty ? "1px solid rgba(74,222,128,.4)" : BORDER, borderRadius: 10, padding: "7px 8px" }}>
                          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
                            <span style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}><SizeTag size={sz} /></span>
                            <span style={{ fontSize: 9, color: GRAY }}>{max} here</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <button onClick={() => bump(p, sz, -1)} style={stepBtn}>−</button>
                            <input type="number" inputMode="numeric" min="0" max={max} value={qty || ""} placeholder="0"
                                   onChange={(e) => setQty(p, sz, e.target.value)}
                                   style={{ ...input, width: "100%", minWidth: 0, boxSizing: "border-box", textAlign: "center", padding: "6px 2px" }} />
                            <button onClick={() => bump(p, sz, +1)} style={{ ...stepBtn, opacity: qty >= max ? 0.4 : 1 }}>+</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky action bar */}
      {lines.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{lines.length} line(s) · {totalUnits} unit(s)</div>
            <div style={{ fontSize: 11, color: GRAY }}>from {labelFor(from, registry)}</div>
          </div>
          <button onClick={clearBasket} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={() => setPicking(true)} style={{ ...bGreen, padding: "10px 18px" }}>Destination →</button>
        </div>
      )}

      {/* Destination sheet — minimal: source is already set, so this only picks TO. */}
      {picking && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
             onClick={() => !busy && setPicking(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 520, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Send {totalUnits} unit(s)</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 14 }}>from <span style={{ color: "#fff", fontWeight: 600 }}>{labelFor(from, registry)}</span> to…</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 16 }}>
              {locations.filter((l) => l.id !== from).map((l) => (
                <button key={l.id} onClick={() => setTo(l.id)} style={chip(to === l.id)}>{labelFor(l.id, registry)}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPicking(false)} disabled={busy} style={{ ...bGhost, flex: 1 }}>Back</button>
              <button onClick={doTransfer} disabled={busy || !to} style={{ ...bGreen, flex: 2, opacity: (busy || !to) ? 0.5 : 1 }}>
                {busy ? "Transferring…" : `Confirm → ${to ? labelFor(to, registry) : "…"}`}
              </button>
            </div>
            <div style={{ fontSize: 11, color: AMBER, marginTop: 10 }}>Moves immediately (no in-transit confirm step).</div>
          </div>
        </div>
      )}

      <Toast msg={toast} />
    </div>
  );
}

const stepBtn = {
  width: 26, height: 30, flexShrink: 0, borderRadius: 8, border: "1px solid rgba(60,110,255,.3)",
  background: "rgba(60,110,255,.1)", color: "#9CB8FF", fontSize: 16, fontWeight: 700, cursor: "pointer",
  fontFamily: FONT, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
};

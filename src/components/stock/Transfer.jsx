// ─── TRANSFER (assistant-style, ONE-STEP) ─────────────────────────────────────
// Reworked per Junid's operating model: a photo grid of products → tap to expand
// sizes → build per-size quantities across multiple products → pick a destination
// → confirm. Each basket line becomes ONE atomic `transfer_out` movement carrying
// a REAL from + to (no in_transit hop).
//
// CONSCIOUS TRADEOFF: the dispatch → in-transit → confirm-receive ceremony is
// dropped. A transfer is instantaneous in the ledger (totals still conserve via
// applyMovement's paired −from/+to), so goods physically in a vehicle show as
// already at the destination. Transit visibility is intentionally gone — see
// design/INVENTORY-DESIGN.md §2 (I4 amendment).
//
// Source defaults to the main receiving warehouse, but BOTH source and
// destination can be any of the 9 stock locations (warehouses, hubs, shops) —
// warehouse→hub, hub→shop, warehouse→shop direct, any→any (flexible topology, no
// routing constraints). Open Source refill requests can be prefilled and are
// closed atomically on a successful transfer.

import React, { useState, useMemo } from "react";
import { ref, update, push, child } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { useRefillRequests } from "./useStock";
import { transferTargets, labelFor, RECEIVING_DEFAULT } from "./locations";
import { Toast, Empty } from "./widgets";
import { GLASS, GLASS_SOLID, CARD, BLUE, BLUE_L, GREEN, RED, GRAY, AMBER, BORDER, RADIUS, FONT, input, bGreen, bGhost } from "./ui";
import { searchProducts } from "../../utils/productSearch";

const keyOf = (pid, size) => `${pid}__${size}`;

function Thumb({ product, size = 46 }) {
  const url = product?.photoUrl;
  if (url) return <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>👟</div>;
}

export default function Transfer({ products, registry, actorRole }) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);     // expanded product id
  const [basket, setBasket] = useState({});       // { pid__size: { productId, productName, size, qty } }
  const [refillId, setRefillId] = useState(null); // fulfilling a Source refill
  const [from, setFrom] = useState(RECEIVING_DEFAULT);
  const [to, setTo] = useState("");
  const [picking, setPicking] = useState(false);  // destination sheet open
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const openRefills = useRefillRequests("open");

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3000); };

  const lines = useMemo(() => Object.values(basket).filter(l => l.qty > 0), [basket]);
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  const setQty = (product, size, qty) => {
    const n = Math.max(0, parseInt(qty, 10) || 0);
    setBasket(b => {
      const next = { ...b };
      const k = keyOf(product.id, size);
      if (n <= 0) delete next[k];
      else next[k] = { productId: product.id, productName: product.name, size, qty: n };
      return next;
    });
  };
  const bump = (product, size, delta) => {
    const k = keyOf(product.id, size);
    const cur = basket[k]?.qty || 0;
    setQty(product, size, cur + delta);
  };
  const clearBasket = () => { setBasket({}); setRefillId(null); };

  const prefillRefill = (r) => {
    const p = products.find(x => x.id === r.productId);
    setBasket({ [keyOf(r.productId, r.size)]: { productId: r.productId, productName: p?.name || r.productId, size: r.size, qty: r.qty || 1 } });
    setRefillId(r.id);
    setTo(r.requestingLocation || "");
    setOpenId(r.productId);
    flash("ok", "Prefilled from refill request — pick a source and confirm.");
  };

  // Forgiving search (fuzzy name + codes); empty query shows the full product grid.
  const filtered = useMemo(() => {
    if (!search.trim()) {
      return [...(products || [])]
        .filter(p => p && p.id && p.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return searchProducts(products, search, { limit: 300 });
  }, [products, search]);

  const doTransfer = async () => {
    if (!from || !to) return flash("err", "Pick a source and destination.");
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
    // Close the Source refill request on a successful one-step transfer.
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
          {openRefills.map(r => {
            const nm = products.find(p => p.id === r.productId)?.name || r.productId;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: BORDER, fontSize: 13 }}>
                <span style={{ color: "#fff" }}>{nm} · {r.size} ×{r.qty || 1}<span style={{ color: GRAY }}> → {labelFor(r.requestingLocation, registry)}</span></span>
                <button onClick={() => prefillRefill(r)} style={{ ...bGhost, padding: "5px 10px", fontSize: 12 }}>Prefill</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…"
             style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />

      {/* Product grid (tap to expand sizes) */}
      {filtered.length === 0 ? <Empty>No products match.</Empty> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: lines.length ? 84 : 8 }}>
          {filtered.map(p => {
            const expanded = openId === p.id;
            const sizes = Array.isArray(p.sizes) ? p.sizes : [];
            const inBasket = sizes.reduce((s, sz) => s + (basket[keyOf(p.id, sz)]?.qty || 0), 0);
            return (
              <div key={p.id} style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
                <div onClick={() => setOpenId(expanded ? null : p.id)}
                     style={{ display: "flex", alignItems: "center", gap: 11, padding: 11, cursor: "pointer" }}>
                  <Thumb product={p} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{sizes.length} size{sizes.length === 1 ? "" : "s"}</div>
                  </div>
                  {inBasket > 0 && <span style={{ background: "rgba(74,222,128,.16)", color: GREEN, border: "1px solid rgba(74,222,128,.4)", borderRadius: 20, padding: "2px 9px", fontSize: 12, fontWeight: 700 }}>{inBasket}</span>}
                  <span style={{ color: BLUE_L, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
                </div>
                {expanded && (
                  <div style={{ padding: "0 11px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 8 }}>
                    {sizes.map(sz => {
                      const qty = basket[keyOf(p.id, sz)]?.qty || 0;
                      return (
                        <div key={sz} style={{ background: CARD, border: qty ? "1px solid rgba(74,222,128,.4)" : BORDER, borderRadius: 10, padding: "7px 8px" }}>
                          <div style={{ fontSize: 12, color: BLUE_L, fontWeight: 700, textAlign: "center", marginBottom: 5 }}>{sz}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <button onClick={() => bump(p, sz, -1)} style={stepBtn}>−</button>
                            <input type="number" inputMode="numeric" min="0" value={qty || ""} placeholder="0"
                                   onChange={e => setQty(p, sz, e.target.value)}
                                   style={{ ...input, width: "100%", minWidth: 0, boxSizing: "border-box", textAlign: "center", padding: "6px 2px" }} />
                            <button onClick={() => bump(p, sz, +1)} style={stepBtn}>+</button>
                          </div>
                        </div>
                      );
                    })}
                    {sizes.length === 0 && <div style={{ color: GRAY, fontSize: 12 }}>No sizes on this product.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky transfer bar */}
      {lines.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{lines.length} line(s) · {totalUnits} unit(s)</div>
            <div style={{ fontSize: 11, color: GRAY }}>{refillId ? "fulfilling refill" : "ready to transfer"}</div>
          </div>
          <button onClick={clearBasket} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={() => setPicking(true)} style={{ ...bGreen, padding: "10px 18px" }}>Transfer</button>
        </div>
      )}

      {/* Destination sheet */}
      {picking && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
             onClick={() => !busy && setPicking(false)}>
          <div onClick={e => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 520, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 12 }}>Transfer {totalUnits} unit(s)</div>

            <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>From</div>
            {/* Any of the 9 locations may be a source (shops included), except the
                chosen destination. To excludes the source below — so from ≠ to. */}
            <select value={from} onChange={e => setFrom(e.target.value)} style={{ ...input, width: "100%", appearance: "none", marginBottom: 14 }}>
              {transferTargets(registry).filter(l => l.id !== to).map(l => <option key={l.id} value={l.id}>{labelFor(l.id, registry)}</option>)}
            </select>

            <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>To</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 16 }}>
              {transferTargets(registry).filter(l => l.id !== from).map(l => {
                const on = to === l.id;
                return (
                  <button key={l.id} onClick={() => setTo(l.id)}
                          style={{ padding: "11px 8px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600,
                                   background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)",
                                   border: on ? "1px solid rgba(60,110,255,.6)" : BORDER, color: on ? "#fff" : GRAY }}>
                    {labelFor(l.id, registry)}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPicking(false)} disabled={busy} style={{ ...bGhost, flex: 1 }}>Back</button>
              <button onClick={doTransfer} disabled={busy || !to} style={{ ...bGreen, flex: 2, opacity: (busy || !to) ? 0.5 : 1 }}>
                {busy ? "Transferring…" : `Confirm → ${to ? labelFor(to, registry) : "…"}`}
              </button>
            </div>
            <div style={{ fontSize: 11, color: AMBER, marginTop: 10 }}>One-step transfer — moves immediately (no in-transit confirm step).</div>
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

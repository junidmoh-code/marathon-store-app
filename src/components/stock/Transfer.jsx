// ─── TRANSFER (source-first, scan + search into one cart) ─────────────────────
// Pick the SOURCE first → build a cart by SCANNING barcodes and/or manual search
// (both feed the SAME cart) → pick a clean DESTINATION → confirm. Each cart line
// becomes ONE atomic `transfer_out` movement carrying a REAL from + to + size (no
// in_transit hop). Totals conserve via applyMovement's paired −from/+to.
//
// SIZE INTEGRITY: a scanned barcode resolves via /barcodes/{code} → {productId,
// size?}. Per-size codes (shoes) carry the size; product-level codes (much
// clothing) do NOT — so a sized-clothing scan PROMPTS for size (scanResolve), and
// can never silently move the "_" no-size cell. One-size products transfer the "_"
// cell explicitly (correct), and are now reachable in the manual grid too.
//
// OVER-SCAN: scanning/editing past what the source holds is ALLOWED but the line is
// flagged; applyMovement's negative floor is the hard backstop that blocks an
// impossible transfer at commit.

import React, { useState, useMemo, useEffect, useRef } from "react";
import { ref, update, push, child, get } from "firebase/database";
import { database } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { useRefillRequests, useStockCells } from "./useStock";
import { transferTargets, labelFor } from "./locations";
import { Toast, Empty } from "./widgets";
import { GLASS, GLASS_SOLID, CARD, BLUE_L, GREEN, GRAY, AMBER, BORDER, FONT, input, bGreen, bGhost } from "./ui";
import { searchProducts } from "../../utils/productSearch";
import { SizeTag } from "../SizeTag";
import { resolveScan, realSizesOf } from "./scanResolve";
import FilterPicker from "./FilterPicker";

const ONE_SIZE = "_";                                  // the no-size /stock cell key
const keyOf = (pid, size) => `${pid}__${size}`;
const sizeLabel = (size) => (size === ONE_SIZE || size == null || size === "" ? "One size" : null);

// Compact filter chip (destination row).
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

// SizeTag, or a plain "One size" pill for the "_" cell.
function SizeChip({ size }) {
  const one = sizeLabel(size);
  if (one) return <span style={{ fontSize: 11, color: BLUE_L, fontWeight: 700 }}>{one}</span>;
  return <SizeTag size={size} />;
}

export default function Transfer({ products, registry, actorRole }) {
  // SOURCE — REQUIRED, no default. Every transfer must consciously pick where the
  // stock leaves from, so this starts empty and the cart tools stay hidden until a
  // source is chosen.
  const [from, setFrom] = useState("");
  const [cat, setCat] = useState("all");
  const [search, setSearch] = useState("");
  const [scan, setScan] = useState("");
  const [openId, setOpenId] = useState(null);            // expanded product id (manual grid)
  const [basket, setBasket] = useState({});              // { pid__size: { productId, productName, size, qty } }
  const [refillId, setRefillId] = useState(null);
  const [to, setTo] = useState("");                      // destination
  const [picking, setPicking] = useState(false);         // destination sheet open
  const [sizePrompt, setSizePrompt] = useState(null);    // { product } awaiting a size after a scan
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const scanRef = useRef(null);
  const openRefills = useRefillRequests("open");
  // Guard: an empty `from` would make useStockCells subscribe to the WHOLE /stock
  // node (and return a different shape). Feed a non-existent id so it resolves to
  // {} until a real source is picked.
  const srcCells = useStockCells(from || "__no_source__"); // { pid: { size: cell } } at the source

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3000); };
  const productsById = useMemo(() => {
    const m = {}; (products || []).forEach((p) => { if (p && p.id) m[p.id] = p; }); return m;
  }, [products]);

  const locations = useMemo(() => transferTargets(registry), [registry]);
  // On-hand at the SOURCE — the cap for the manual grid and the over-scan flag.
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
  const overCount = lines.filter((l) => l.qty > avail(l.productId, l.size)).length;

  // Manual grid: capped at source stock (you can't browse-add more than is here).
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

  // Cart line qty (scan/edit path): UNCAPPED so over-scan is allowed (and flagged);
  // 0 removes the line.
  const setLineQty = (k, qty) => setBasket((b) => {
    const line = b[k]; if (!line) return b;
    const n = Math.max(0, parseInt(qty, 10) || 0);
    if (n <= 0) { const nb = { ...b }; delete nb[k]; return nb; }
    return { ...b, [k]: { ...line, qty: n } };
  });
  const removeLine = (k) => setBasket((b) => { const nb = { ...b }; delete nb[k]; return nb; });

  // Add ONE unit for a (product, size) via a scan — uncapped (over-scan allowed).
  const scanAdd = (product, size) => {
    const sz = size == null || size === "" ? ONE_SIZE : String(size);
    setBasket((b) => {
      const k = keyOf(product.id, sz);
      const cur = b[k]?.qty || 0;
      return { ...b, [k]: { productId: product.id, productName: product.name, size: sz, qty: cur + 1 } };
    });
    flash("ok", `+1 ${product.name}${sizeLabel(sz) ? "" : " · " + sz}`);
  };

  const clearBasket = () => { setBasket({}); setRefillId(null); };

  // Changing the source invalidates the basket (its lines were counted at the old
  // source). Reset so quantities always reflect what's actually available here.
  const pickSource = (id) => { if (id === from) return; setFrom(id); setBasket({}); setOpenId(null); setRefillId(null); if (to === id) setTo(""); };

  // Resolve a scanned/typed barcode → add to the cart. Unknown code → "not found"
  // but the session stays alive (input cleared, focus kept) so scanning continues.
  const onScanCode = async (raw) => {
    const code = String(raw || "").trim();
    setScan("");
    if (!code) return;
    if (!from) { flash("err", "Pick a source location first."); return; }
    let rec = null;
    try { const snap = await get(ref(database, `barcodes/${code}`)); rec = snap.exists() ? snap.val() : null; }
    catch { rec = null; }
    if (!rec || !rec.productId) { flash("err", `Barcode not found: ${code}`); return; }
    const product = productsById[rec.productId];
    if (!product) { flash("err", `Scanned product not in catalogue (${rec.productId}).`); return; }
    const r = resolveScan(product, rec.size);
    if (r.kind === "prompt") { setSizePrompt({ product }); return; }   // sized clothing, code had no size
    scanAdd(product, r.kind === "add" ? r.size : ONE_SIZE);
  };

  const prefillRefill = (r) => {
    const p = productsById[r.productId];
    setBasket({ [keyOf(r.productId, r.size)]: { productId: r.productId, productName: p?.name || r.productId, size: r.size, qty: r.qty || 1 } });
    setRefillId(r.id);
    setTo(r.requestingLocation || "");
    setOpenId(r.productId);
    flash("ok", "Prefilled from refill — check the source has stock, then confirm.");
  };

  // Clear a stale destination if it ends up equal to the source.
  useEffect(() => { if (to && to === from) setTo(""); }, [from, to]);

  const doTransfer = async () => {
    if (!from) return flash("err", "Pick a source location.");
    if (!to) return flash("err", "Pick a destination.");
    if (from === to) return flash("err", "Source and destination must differ.");
    if (!lines.length) return flash("err", "Add at least one quantity.");
    setBusy(true);
    const transferId = push(child(ref(database), "transfers")).key;
    let ok = 0, fail = 0;
    for (const ln of lines) {
      // ONE_SIZE ("_") → null so stockSizeKey maps it back to the "_" cell cleanly.
      const size = ln.size === ONE_SIZE ? null : ln.size;
      const res = await applyMovement({
        type: "transfer_out", productId: ln.productId, size, qty: ln.qty,
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
            const nm = productsById[r.productId]?.name || r.productId;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: BORDER, fontSize: 13 }}>
                <span style={{ color: "#fff" }}>{nm} · <SizeTag size={r.size} /> ×{r.qty || 1}<span style={{ color: GRAY }}> → {labelFor(r.requestingLocation, registry)}</span></span>
                <button onClick={() => prefillRefill(r)} style={{ ...bGhost, padding: "5px 10px", fontSize: 12 }}>Prefill</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Source (pick first — the grid + scan act on this location). */}
      <FilterPicker label="Transfer from" value={from} onChange={pickSource} placeholder="Choose source…" defaultOpen={!from}
        options={locations.map((l) => ({ id: l.id, label: labelFor(l.id, registry) }))} />

      {!from ? (
        <Empty>Pick a source location above to start a transfer.</Empty>
      ) : (
      <>
      {/* SCAN — a barcode gun (or manual entry) adds straight to the cart below.
          Sits above search; both feed the same cart. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} autoFocus
               onKeyDown={(e) => { if (e.key === "Enter") onScanCode(e.currentTarget.value); }}
               placeholder="Scan or type a barcode… ↵"
               style={{ ...input, flex: 1, boxSizing: "border-box", borderColor: "rgba(74,222,128,.4)" }} />
        <button onClick={() => onScanCode(scan)} style={{ ...bGreen, padding: "0 16px", whiteSpace: "nowrap" }}>Add</button>
      </div>

      {/* CART — scanned + manually-added lines. Per-line size, qty and remove.
          Over-source lines are flagged (commit is still blocked by the floor). */}
      {lines.length > 0 && (
        <div style={{ ...GLASS, padding: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: GRAY, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>
            Cart · {lines.length} line(s) · {totalUnits} unit(s){overCount > 0 ? ` · ${overCount} over source` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lines.map((l) => {
              const k = keyOf(l.productId, l.size);
              const here = avail(l.productId, l.size);
              const over = l.qty > here;
              return (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", borderTop: BORDER }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#fff", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.productName}</div>
                    <div style={{ fontSize: 11, color: over ? AMBER : GRAY, marginTop: 1 }}>
                      <SizeChip size={l.size} /> · {here} at source{over ? " · over!" : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => setLineQty(k, l.qty - 1)} style={stepBtn}>−</button>
                    <input type="number" inputMode="numeric" min="0" value={l.qty}
                           onChange={(e) => setLineQty(k, e.target.value)}
                           style={{ ...input, width: 46, minWidth: 0, boxSizing: "border-box", textAlign: "center", padding: "6px 2px", borderColor: over ? "rgba(245,158,11,.5)" : undefined }} />
                    <button onClick={() => setLineQty(k, l.qty + 1)} style={stepBtn}>+</button>
                  </div>
                  <button onClick={() => removeLine(k)} title="Remove" style={{ ...bGhost, padding: "6px 9px", fontSize: 13, lineHeight: 1 }}>×</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
            // Real sizes with stock here, PLUS a synthetic "One size" cell when this
            // product holds no-size ("_") stock — so one-size items are transferable.
            const realSizes = realSizesOf(p).filter((sz) => avail(p.id, sz) > 0);
            const sizes = avail(p.id, ONE_SIZE) > 0 ? [...realSizes, ONE_SIZE] : realSizes;
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
                            <span style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}><SizeChip size={sz} /></span>
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
      </>
      )}

      {/* Sticky action bar */}
      {lines.length > 0 && (
        <div style={{ position: "fixed", left: 12, right: 12, bottom: 14, zIndex: 40, ...GLASS, padding: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{lines.length} line(s) · {totalUnits} unit(s)</div>
            <div style={{ fontSize: 11, color: overCount ? AMBER : GRAY }}>from {labelFor(from, registry)}{overCount ? ` · ${overCount} over source` : ""}</div>
          </div>
          <button onClick={clearBasket} style={{ ...bGhost, padding: "8px 12px", fontSize: 12 }}>Clear</button>
          <button onClick={() => setPicking(true)} style={{ ...bGreen, padding: "10px 18px" }}>Destination →</button>
        </div>
      )}

      {/* Size prompt — a sized-clothing scan whose barcode carried no size. */}
      {sizePrompt && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
             onClick={() => setSizePrompt(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...GLASS_SOLID, width: "100%", maxWidth: 520, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 16, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Which size?</div>
            <div style={{ fontSize: 12.5, color: GRAY, marginBottom: 14 }}>{sizePrompt.product.name} — the barcode didn't carry a size. Pick the one you scanned.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8, marginBottom: 12 }}>
              {realSizesOf(sizePrompt.product).map((sz) => {
                const here = avail(sizePrompt.product.id, sz);
                return (
                  <button key={sz} onClick={() => { scanAdd(sizePrompt.product, sz); setSizePrompt(null); scanRef.current?.focus(); }}
                          style={{ ...chip(false), padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
                    <SizeTag size={sz} />
                    <span style={{ fontSize: 9, color: GRAY }}>{here} here</span>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setSizePrompt(null)} style={{ ...bGhost, width: "100%" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Destination sheet — source is already set, so this only picks TO. */}
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
            <div style={{ fontSize: 11, color: AMBER, marginTop: 10 }}>
              Moves immediately (no in-transit confirm step).{overCount ? ` ${overCount} line(s) exceed source stock — those will be blocked at commit.` : ""}
            </div>
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

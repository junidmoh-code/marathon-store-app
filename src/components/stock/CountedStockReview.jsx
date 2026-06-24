// ─── COUNTED STOCK REVIEW (TEMPORARY recount tool) ────────────────────────────
// Admin-only review of EVERY counted cell across all locations, with a per-row and a
// scoped per-location "Clear" to zero quantities and reset them to UNCOUNTED so a fresh
// count can be redone. Built because counted stock had errors (wrong barcodes / qtys)
// with no way to see or wipe entries.
//
// QUANTITIES ONLY — never touches /products or /barcodes. Clearing is a REVERSIBLE
// ledger movement (applyMovement type "adjustment", NOT a raw node delete): it debits
// the cell to 0 and sets cellState:"untracked" in the same atomic write. Reuses the
// stock-cell read (useStockCells), the size encoder (barcodeSizeKey) and applyMovement.
// TEMPORARY — remove once the recount is done.

import React, { useState, useMemo, useEffect } from "react";
import { applyMovement } from "./applyMovement";
import { useStockCells } from "./useStock";
import { labelFor, transferTargets } from "./locations";
import { barcodeSizeKey } from "./barcode";
import { Toast, Empty, LocationPicker } from "./widgets";
import { GLASS, CARD, GRAY, GREEN, RED, BLUE_L, AMBER, BORDER, bGreen, bGhost, input } from "./ui";

const DEFAULT_LOCATION = "marathon-pe";   // counts happen at Marathon PE by default

// Product thumbnail (same pattern as Transfer / BarcodeCatalog). Tap to open full.
function Thumb({ url, onOpen }) {
  if (url) return <img src={url} alt="" loading="lazy" onClick={onOpen} onError={(e) => { e.currentTarget.style.display = "none"; }}
    style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8, flexShrink: 0, cursor: "zoom-in" }} />;
  return <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>👟</div>;
}

export default function CountedStockReview({ products = [], registry, actorRole }) {
  const cells = useStockCells();          // { loc: { pid: { size: cell } } } — ALL locations
  // Filters persist across refresh so you return to the same view.
  const [locFilter, setLocFilterRaw] = useState(() => localStorage.getItem("countedLoc") || DEFAULT_LOCATION);
  const [typeFilter, setTypeFilterRaw] = useState(() => localStorage.getItem("countedType") || "all");
  const setLocFilter = (v) => { try { localStorage.setItem("countedLoc", v); } catch { /* ignore */ } setLocFilterRaw(v); };
  const setTypeFilter = (v) => { try { localStorage.setItem("countedType", v); } catch { /* ignore */ } setTypeFilterRaw(v); };
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());     // product keys with size grid open
  const [busyKey, setBusyKey] = useState(null);   // cell key being cleared/edited, or "prod:…"
  const [editKey, setEditKey] = useState(null);   // size-cell key whose qty is being edited
  const [editVal, setEditVal] = useState("");
  const [confirmClear, setConfirmClear] = useState(null);   // group awaiting clear confirmation
  const [moveGroup, setMoveGroup] = useState(null);  // group being relocated to another location
  const [moveLoc, setMoveLoc] = useState("");        // chosen destination for the move
  const [undo, setUndo] = useState(null);          // { label, items:[{loc,pid,size,qty}] } — 30s window
  const [lightbox, setLightbox] = useState(null);  // full-screen photo url
  const [toast, setToast] = useState(null);
  const toggleExpand = (key) => setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // The undo offer lasts 30 seconds, then disappears.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 30000);
    return () => clearTimeout(t);
  }, [undo]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3600); };

  const prodById = useMemo(() => {
    const m = {}; for (const p of products || []) if (p?.id) m[p.id] = p; return m;
  }, [products]);

  const barcodeFor = (p, size) => {
    const b = p?.barcodes; if (!b) return null;
    return b[barcodeSizeKey(size)] ?? b[size] ?? null;
  };

  // Group by product × location: ONE card per product that has at least one counted
  // size at a location. The card lists the product's FULL size set — sizes that were
  // never counted show as 0 so they can be added/adjusted right there.
  const groups = useMemo(() => {
    const arr = [];
    for (const loc of Object.keys(cells || {})) {
      const byPid = cells[loc] || {};
      for (const pid of Object.keys(byPid)) {
        const bySize = byPid[pid] || {};
        const qtyOf = (s) => { const c = bySize[s]; return c && typeof c.qty === "number" ? c.qty : 0; };
        // Only products with at least one COUNTED size at this location.
        const countedSizes = Object.keys(bySize).filter(s => qtyOf(s) !== 0);
        if (!countedSizes.length) continue;
        const p = prodById[pid];
        // Full size set = the product's configured sizes ∪ any sizes that have a cell,
        // so nothing is hidden and missing sizes appear (as 0) to be added.
        const productSizes = (p && Array.isArray(p.sizes)) ? p.sizes.map(String) : [];
        const allSizes = [...new Set([...productSizes, ...Object.keys(bySize)])];
        const sizes = allSizes.map(size => ({ size, qty: qtyOf(size), barcode: barcodeFor(p, size) }))
          .sort((a, b) => String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
        arr.push({ loc, pid, name: p?.name || pid, photoUrl: p?.photoUrl || null, product: p,
                   type: (p?.productType === "clothing" ? "clothing" : "sneaker"), sizes });
      }
    }
    return arr.sort((a, b) => a.loc.localeCompare(b.loc) || a.name.localeCompare(b.name));
  }, [cells, prodById]);

  // Counts reflect COUNTED sizes only (qty !== 0), not the 0-placeholders.
  const countByLoc = (loc) => groups.filter(g => g.loc === loc).reduce((n, g) => n + g.sizes.filter(s => s.qty !== 0).length, 0);
  // Locations that actually hold counts — the quick-switch chips at the top.
  const locsWithCounts = useMemo(() => [...new Set(groups.map(g => g.loc))]
    .sort((a, b) => labelFor(a, registry).localeCompare(labelFor(b, registry))), [groups, registry]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return groups.filter(g =>
      (locFilter === "all" || g.loc === locFilter) &&
      (typeFilter === "all" || g.type === typeFilter) &&
      (!term || g.name.toLowerCase().includes(term) || g.sizes.some(s => String(s.barcode || "").includes(term))));
  }, [groups, locFilter, typeFilter, q]);

  const shownCells = filtered.reduce((n, g) => n + g.sizes.filter(s => s.qty !== 0).length, 0);
  const shownUnits = filtered.reduce((n, g) => n + g.sizes.reduce((s, x) => s + x.qty, 0), 0);
  const totalCells = groups.reduce((n, g) => n + g.sizes.filter(s => s.qty !== 0).length, 0);
  const keyOf = (loc, pid, size) => `${loc}|${pid}|${size}`;

  // Inline qty correction — SET a size to the typed value (reconcile to the real count)
  // at its location, via a signed adjustment. Marks it live (counted).
  const startEdit = (loc, pid, size, qty) => { if (busyKey) return; setEditKey(keyOf(loc, pid, size)); setEditVal(String(qty)); };
  const cancelEdit = () => { setEditKey(null); setEditVal(""); };
  const saveEdit = async (g, s) => {
    const target = parseInt(String(editVal).trim(), 10);
    if (!Number.isFinite(target) || target < 0) return flash("err", "Enter a whole number (0 or more).");
    const delta = target - s.qty;
    if (delta === 0) return cancelEdit();
    setBusyKey(keyOf(g.loc, g.pid, s.size));
    try {
      const res = await applyMovement({
        type: "adjustment", productId: g.pid, size: s.size, qty: Math.abs(delta),
        to: delta > 0 ? g.loc : null, from: delta < 0 ? g.loc : null,
        reason: "recount: corrected on the spot", cellState: "live", actorRole,
      });
      if (res.ok) flash("ok", `Set ${g.name} · ${s.size} @ ${labelFor(g.loc, registry)} → ${target}.`);
      else flash("err", `Couldn't update: ${res.reason || res.error || "unknown"}`);
    } catch (e) {
      flash("err", `Couldn't update: ${String(e?.message || e)}`);
    } finally {
      setBusyKey(null); cancelEdit();
    }
  };

  // Clear ALL sizes of one product (at its location) → uncounted, so it's re-counted.
  // Runs only after the inline confirmation; captures prior qtys for the 30s undo.
  const clearProduct = async (g) => {
    setConfirmClear(null);
    if (busyKey) return;
    const items = g.sizes.map(s => ({ loc: g.loc, pid: g.pid, size: s.size, qty: s.qty })).filter(i => i.qty !== 0);
    setBusyKey(`prod:${g.loc}|${g.pid}`);
    let fail = 0; const cleared = [];   // only the sizes that actually zeroed → safe to undo
    for (const it of items) {
      try { (await zeroCell(it.loc, it.pid, it.size, it.qty, "recount: product cleared")).ok ? cleared.push(it) : fail++; }
      catch { fail++; }
    }
    setBusyKey(null);
    if (cleared.length) setUndo({ label: `${g.name} @ ${labelFor(g.loc, registry)}`, items: cleared });
    flash(fail ? "err" : "ok", `${g.name}: cleared ${cleared.length}${fail ? `, ${fail} failed` : ""} → uncounted.`);
  };

  // Relocate a product's counted stock to another location (e.g. counted at Marathon PE
  // but it belongs at Hub 1). Each size moves via a transfer (from → to). cellState
  // "live" marks BOTH touched cells counted — the source as a confirmed 0 and the
  // destination with the moved qty. (Intentional: a move means the source is genuinely
  // empty now, NOT awaiting re-count — unlike Clear, which marks "untracked".) Counts
  // and barcodes are preserved.
  const moveProduct = async () => {
    const g = moveGroup, to = moveLoc;
    if (!g || !to || to === g.loc || busyKey) return;
    setBusyKey(`move:${g.loc}|${g.pid}`);
    let ok = 0, fail = 0;
    for (const s of g.sizes) {
      if (!(s.qty > 0)) continue;   // only positive counted stock can be moved
      try {
        const res = await applyMovement({
          type: "transfer_out", productId: g.pid, size: s.size, qty: s.qty,
          from: g.loc, to, cellState: "live", actorRole, link: { reason: "recount: relocated" },
        });
        res.ok ? ok++ : fail++;
      } catch { fail++; }
    }
    setBusyKey(null); setMoveGroup(null); setMoveLoc("");
    if (ok === 0) { flash("err", fail ? `Move failed (${fail}).` : `Nothing to move — ${g.name} has no positive counted stock.`); return; }
    // Jump the view to the destination so the moved product is visible where it landed
    // (it left the previous location's filtered list — it isn't lost).
    setLocFilter(to);
    flash(fail ? "err" : "ok", `Moved ${ok} size(s) of ${g.name} → ${labelFor(to, registry)}${fail ? ` · ${fail} failed` : ""}. Now showing ${labelFor(to, registry)}.`);
  };

  // Undo a clear within the 30s window — restore each size's prior quantity (live).
  const doUndo = async () => {
    if (!undo || busyKey) return;
    const items = undo.items; setUndo(null);
    setBusyKey("undo");
    let ok = 0, fail = 0;
    for (const it of items) {
      try {
        const res = await applyMovement({
          type: "adjustment", productId: it.pid, size: it.size, qty: Math.abs(it.qty),
          to: it.qty > 0 ? it.loc : null, from: it.qty < 0 ? it.loc : null,
          reason: "recount: undo clear", cellState: "live", actorRole,
        });
        res.ok ? ok++ : fail++;
      } catch { fail++; }
    }
    setBusyKey(null);
    flash(fail ? "err" : "ok", `Restored ${ok} size(s)${fail ? `, ${fail} failed` : ""}.`);
  };

  // The single zeroing primitive: debit a positive cell (or credit a negative one) to 0
  // and set its state back to untracked — one atomic, reversible movement.
  function zeroCell(loc, pid, size, qty, reason) {
    return applyMovement({
      type: "adjustment", productId: pid, size, qty: Math.abs(qty),
      from: qty > 0 ? loc : null, to: qty < 0 ? loc : null,
      reason, cellState: "untracked", actorRole,
    });
  }

  return (
    <div>
      <div style={{ ...GLASS, padding: 12, marginBottom: 12, border: "1px solid rgba(245,158,11,.5)", background: "rgba(245,158,11,.10)" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: AMBER }}>⚠️ TEMPORARY — Counted Stock review</div>
        <div style={{ fontSize: 11, color: GRAY, marginTop: 4, lineHeight: 1.45 }}>
          Every cell that currently holds a quantity. <b>Clear</b> zeroes a cell (a reversible
          adjustment) and marks it <b>uncounted</b> so it's clearly waiting to be re-counted.
          Touches quantities only — never the product or its barcode.
        </div>
      </div>

      {/* Location quick-switch — tap "All" to see everything, or a location to focus it. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {[["all", `All (${totalCells})`], ...locsWithCounts.map(loc => [loc, `${labelFor(loc, registry)} (${countByLoc(loc)})`])].map(([val, lbl]) => {
          const on = locFilter === val;
          return (
            <button key={val} onClick={() => { setLocFilter(val); cancelEdit(); }}
              style={{ padding: "6px 13px", borderRadius: 9, cursor: "pointer", fontSize: 12, fontWeight: 700,
                       background: on ? "rgba(60,110,255,.25)" : "rgba(255,255,255,.04)",
                       border: on ? "1px solid rgba(60,110,255,.6)" : BORDER, color: on ? "#fff" : GRAY }}>
              {lbl}
            </button>
          );
        })}
      </div>

      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search product or barcode…"
        style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: 8 }} />

      {/* Sneakers vs Clothing */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[["all", "All"], ["sneaker", "Sneakers"], ["clothing", "Clothing"]].map(([val, lbl]) => {
          const on = typeFilter === val;
          return (
            <button key={val} onClick={() => { setTypeFilter(val); cancelEdit(); }}
              style={{ padding: "6px 14px", borderRadius: 9, cursor: "pointer", fontSize: 12, fontWeight: 600,
                       background: on ? "rgba(60,110,255,.2)" : "rgba(255,255,255,.04)",
                       border: on ? "1px solid rgba(60,110,255,.6)" : BORDER, color: on ? "#fff" : GRAY }}>
              {lbl}
            </button>
          );
        })}
      </div>

      {/* Undo a clear — available for 30 seconds. */}
      {undo && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", marginBottom: 12, borderRadius: 10,
                      background: "rgba(60,110,255,.12)", border: "1px solid rgba(60,110,255,.45)" }}>
          <span style={{ flex: 1, fontSize: 12, color: "#fff" }}>
            Cleared <b>{undo.label}</b> ({undo.items.length} size{undo.items.length === 1 ? "" : "s"}).
          </span>
          <button onClick={doUndo} disabled={busyKey === "undo"} style={{ ...bGreen, padding: "7px 16px", fontSize: 12.5 }}>
            {busyKey === "undo" ? "Undoing…" : "↩ Undo"}
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty>{groups.length === 0 ? "No counted stock — nothing has a quantity yet." : "No products match the filter."}</Empty>
      ) : (
        <>
          <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>{filtered.length} product(s) · {shownCells} size(s) · {shownUnits} unit(s)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map(g => {
              const gk = `${g.loc}|${g.pid}`;
              const prodBusy = busyKey === `prod:${gk}`;
              const open = expanded.has(gk);
              return (
                <div key={gk} style={{ background: CARD, border: BORDER, borderRadius: 12, padding: 11 }}>
                  {/* Product header — tap to expand/collapse the size breakdown. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Thumb url={g.photoUrl} onOpen={() => g.photoUrl && setLightbox(g.photoUrl)} />
                    <div onClick={() => toggleExpand(gk)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
                      <div style={{ fontSize: 11, color: GRAY }}>
                        <span style={{ color: BLUE_L }}>{labelFor(g.loc, registry)}</span> · {g.sizes.filter(s => s.qty !== 0).length} counted · {g.sizes.reduce((s, x) => s + x.qty, 0)} units
                      </div>
                    </div>
                    {/* Move — relocate this product's counted stock to another location. */}
                    <button onClick={() => { setMoveGroup(g); setMoveLoc(""); }} disabled={!!busyKey} title="Move counted stock to another location"
                      style={{ ...bGhost, padding: "6px 11px", fontSize: 11.5, color: BLUE_L, borderColor: "rgba(60,110,255,.45)", opacity: (busyKey === `move:${gk}`) ? 0.6 : 1 }}>
                      {busyKey === `move:${gk}` ? "Moving…" : "Move"}
                    </button>
                    {/* Clear — opens a red confirmation popup before wiping anything. */}
                    <button onClick={() => setConfirmClear(g)} disabled={!!busyKey} title="Zero all sizes → uncounted (re-count this product)"
                      style={{ ...bGhost, padding: "6px 11px", fontSize: 11.5, color: RED, borderColor: "rgba(248,113,113,.45)", opacity: prodBusy ? 0.6 : 1 }}>
                      {prodBusy ? "Clearing…" : "Clear"}
                    </button>
                    <button onClick={() => toggleExpand(gk)} aria-label={open ? "Collapse" : "Expand"}
                      style={{ background: "transparent", border: "none", color: BLUE_L, cursor: "pointer", fontSize: 15, padding: "4px 2px", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</button>
                  </div>
                  {/* Size grid (collapsible) — tap a number to correct it (e.g. 3 → 2). */}
                  {open && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(94px, 1fr))", gap: 8, marginTop: 9 }}>
                    {g.sizes.map(s => {
                      const k = keyOf(g.loc, g.pid, s.size);
                      const busy = busyKey === k;
                      return (
                        <div key={k} style={{ background: s.qty === 0 ? "rgba(255,255,255,.015)" : "rgba(255,255,255,.03)", border: BORDER, borderRadius: 10, padding: "7px 7px", opacity: s.qty === 0 ? 0.7 : 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: BLUE_L, textAlign: "center" }}>{s.size}</div>
                          {editKey === k ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                              <input type="number" inputMode="numeric" min="0" autoFocus value={editVal}
                                onChange={e => setEditVal(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") saveEdit(g, s); if (e.key === "Escape") cancelEdit(); }}
                                style={{ ...input, width: "100%", boxSizing: "border-box", textAlign: "center", padding: "6px 2px" }} />
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => saveEdit(g, s)} disabled={busy} style={{ ...bGreen, flex: 1, padding: "5px 0", fontSize: 13 }}>{busy ? "…" : "✓"}</button>
                                <button onClick={cancelEdit} style={{ ...bGhost, flex: 1, padding: "5px 0", fontSize: 13 }}>✕</button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => startEdit(g.loc, g.pid, s.size, s.qty)} disabled={!!busyKey} title={s.qty === 0 ? "Not counted — tap to add" : "Tap to correct"}
                              style={{ width: "100%", marginTop: 3, background: "transparent", border: s.qty === 0 ? "1px dashed rgba(120,150,255,.35)" : "1px solid rgba(60,110,255,.3)", borderRadius: 8, padding: "5px 0", cursor: "pointer" }}>
                              <span style={{ fontSize: 17, fontWeight: 800, color: s.qty === 0 ? GRAY : (s.qty < 0 ? RED : GREEN) }}>{s.qty}</span>
                            </button>
                          )}
                          {s.barcode && <div style={{ fontSize: 8, color: GRAY, fontFamily: "monospace", textAlign: "center", marginTop: 3 }}>{s.barcode}</div>}
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Move counted stock to another location (e.g. Marathon PE → Hub 1). */}
      {moveGroup && (
        <div onClick={() => !busyKey && setMoveGroup(null)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 380, background: "#0d1426", border: "1px solid rgba(60,110,255,.5)", borderRadius: 14, padding: 20, boxShadow: "0 0 40px rgba(60,110,255,.35)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", textAlign: "center" }}>Move counted stock</div>
            <div style={{ fontSize: 13, color: "#fff", textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>
              Move all counted quantities of<br /><b>{moveGroup.name}</b><br />
              from <b style={{ color: BLUE_L }}>{labelFor(moveGroup.loc, registry)}</b> to:
            </div>
            <div style={{ marginTop: 12 }}>
              <LocationPicker registry={registry} value={moveLoc} onChange={setMoveLoc} filter={transferTargets} exclude={moveGroup.loc} />
            </div>
            <div style={{ fontSize: 11, color: "#86efac", textAlign: "center", marginTop: 10 }}>✓ Counts &amp; barcodes are kept — just relocated.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => setMoveGroup(null)} disabled={!!busyKey} style={{ ...bGhost, flex: 1, padding: "11px 0", fontSize: 13 }}>Cancel</button>
              <button onClick={moveProduct} disabled={!moveLoc || !!busyKey}
                style={{ ...bGreen, flex: 1, padding: "11px 0", fontSize: 13, fontWeight: 800, opacity: (!moveLoc || busyKey) ? 0.5 : 1 }}>
                {busyKey ? "Moving…" : "Move"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scary red confirmation — on top of everything — before wiping a product's counts. */}
      {confirmClear && (
        <div onClick={() => !busyKey && setConfirmClear(null)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} role="alertdialog"
            style={{ width: "100%", maxWidth: 380, background: "#1a0708", border: "2px solid #ef4444", borderRadius: 14, padding: 20, boxShadow: "0 0 40px rgba(239,68,68,.5)" }}>
            <div style={{ fontSize: 38, textAlign: "center", lineHeight: 1 }}>⚠️</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#fca5a5", textAlign: "center", marginTop: 8, textTransform: "uppercase", letterSpacing: ".03em" }}>
              Clear counted stock?
            </div>
            <div style={{ fontSize: 13, color: "#fff", textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>
              This will <b style={{ color: "#fca5a5" }}>WIPE all {confirmClear.sizes.filter(s => s.qty !== 0).length} counted {confirmClear.sizes.filter(s => s.qty !== 0).length === 1 ? "quantity" : "quantities"}</b> for<br />
              <b>{confirmClear.name}</b> at <b>{labelFor(confirmClear.loc, registry)}</b><br />
              and mark them <b style={{ color: "#fca5a5" }}>UNCOUNTED</b>.
            </div>
            <div style={{ fontSize: 11.5, color: "#86efac", textAlign: "center", marginTop: 10 }}>
              ✓ Barcodes are kept — you only re-count the size, no reprint.
            </div>
            <div style={{ fontSize: 11, color: GRAY, textAlign: "center", marginTop: 6 }}>You'll have 30 seconds to undo.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button onClick={() => setConfirmClear(null)} disabled={!!busyKey}
                style={{ ...bGhost, flex: 1, padding: "11px 0", fontSize: 13 }}>Cancel</button>
              <button onClick={() => clearProduct(confirmClear)} disabled={!!busyKey}
                style={{ flex: 1, padding: "11px 0", fontSize: 13, fontWeight: 800, borderRadius: 10, cursor: "pointer",
                         background: "#ef4444", color: "#fff", border: "none", opacity: busyKey ? 0.6 : 1 }}>
                {busyKey ? "Clearing…" : `Yes, clear ${confirmClear.sizes.filter(s => s.qty !== 0).length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen photo — tap anywhere to close. */}
      {lightbox && (
        <div onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, cursor: "zoom-out" }}>
          <img src={lightbox} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 10 }} />
        </div>
      )}

      <Toast msg={toast} />
    </div>
  );
}

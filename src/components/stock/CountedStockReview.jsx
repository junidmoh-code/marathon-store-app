// ─── COUNTED STOCK REVIEW ──────────────────────────────────────────────────────
// Admin-only review of EVERY counted cell across all locations, with a per-row and a
// scoped per-location "Clear" to zero quantities and reset them to UNCOUNTED so a fresh
// count can be redone. Built because counted stock had errors (wrong barcodes / qtys)
// with no way to see or wipe entries.
//
// QUANTITIES ONLY — never touches /products or /barcodes. Clearing is a REVERSIBLE
// ledger movement (applyMovement type "adjustment", NOT a raw node delete): it debits
// the cell to 0 and sets cellState:"untracked" in the same atomic write. Reuses the
// stock-cell read (useStockCells), the size encoder (barcodeSizeKey) and applyMovement.
// Originally a temporary recount tool; made a PERMANENT standing feature (owner
// decision 2026-07-16) — do not remove.

import React, { useState, useMemo, useEffect } from "react";
import { applyMovement } from "./applyMovement";
import { useStockCells } from "./useStock";
import { labelFor, transferTargets, wallAllowedLocations } from "./locations";
import { barcodeSizeKey } from "./barcode";
import { TOP_CATEGORIES, UNCATEGORIZED_TOP, topCategory } from "../../utils/productCategory";
import { Toast, Empty } from "./widgets";
import SkyOverlay from "../sky/SkyOverlay.jsx";
import { useScrollRow } from "./useScrollRow";
import { GRAY, GREEN, RED, BLUE_L, BORDER, bGreen, bGhost, input } from "./ui";
import { productMatchesQuery } from "../../utils/productSearch";
import { formatSize } from "../../utils/sizeLabel";
import { SizeTag } from "../SizeTag";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";

const DEFAULT_LOCATION = "marathon-pe";   // counts happen at Marathon PE by default

// Product thumbnail (same pattern as Transfer / BarcodeCatalog). Tap to open full.
function Thumb({ product, productId, onOpen }) {
  const url = primaryPhotoUrl(product);
  if (url) return <PrimaryPhoto product={product} productId={productId} alt="" loading="lazy" onClick={onOpen} onError={(e) => { e.currentTarget.style.display = "none"; }}
    className="sky-li__thumb" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 12, flexShrink: 0, cursor: "zoom-in" }} />;
  return (
    <div className="sky-li__thumb sky-thumb-empty" aria-hidden="true">
      <svg className="sky-thumb-empty__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>
    </div>
  );
}

// Small line icons for the row actions and the info line.
const IcMove = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const IcClear = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" /></svg>;
const IcChevron = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
const IcInfo = () => <svg className="sky-stock-info__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></svg>;

// A chip whose count sits inside it in a lighter weight: "Hub 1 3".
function CountChip({ on, label, n, onClick }) {
  return (
    <button type="button" className="sky-stock-chip" aria-pressed={on} onClick={onClick}>
      {label}{typeof n === "number" ? <span className="sky-stock-chip__n">{n}</span> : null}
    </button>
  );
}

export default function CountedStockReview({ products = [], registry, actorRole }) {
  const cells = useStockCells();          // { loc: { pid: { size: cell } } } — ALL locations
  // Filters persist across refresh so you return to the same view.
  const [locFilter, setLocFilterRaw] = useState(() => localStorage.getItem("countedLoc") || DEFAULT_LOCATION);
  // Chip values are "all" | a real category | "Uncategorized". Reject any stale
  // persisted "sneaker"/"clothing" (the old chip set) so a returning user doesn't
  // land on a filter that matches nothing.
  const TYPE_CHIPS = ["all", ...TOP_CATEGORIES, UNCATEGORIZED_TOP];
  const [typeFilter, setTypeFilterRaw] = useState(() => {
    const saved = localStorage.getItem("countedType");
    return saved && TYPE_CHIPS.includes(saved) ? saved : "all";
  });
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
  const [infoOpen, setInfoOpen] = useState(false);  // the explanatory line, collapsed to one line
  // Each chip row: one scrolling line, its selected chip kept in view.
  const locRowRef = useScrollRow(locFilter);
  const typeRowRef = useScrollRow(typeFilter);
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
                   // `type` feeds the append-only movement audit — left untouched.
                   // `displayCat` is DISPLAY ONLY (the chip filter below).
                   type: (p?.productType === "clothing" ? "clothing" : "sneaker"),
                   displayCat: topCategory(p), sizes });
      }
    }
    return arr.sort((a, b) => a.loc.localeCompare(b.loc) || a.name.localeCompare(b.name));
  }, [cells, prodById]);

  // Counts reflect COUNTED sizes only (qty !== 0), not the 0-placeholders.
  const countByLoc = (loc) => groups.filter(g => g.loc === loc).reduce((n, g) => n + g.sizes.filter(s => s.qty !== 0).length, 0);
  // Locations that actually hold counts — the quick-switch chips at the top.
  const locsWithCounts = useMemo(() => [...new Set(groups.map(g => g.loc))]
    .sort((a, b) => labelFor(a, registry).localeCompare(labelFor(b, registry))), [groups, registry]);

  // Forgiving search on the grouped rows: fuzzy name + per-size barcodes (productSearch.js).
  const filtered = useMemo(() => {
    const term = q.trim();
    return groups.filter(g =>
      (locFilter === "all" || g.loc === locFilter) &&
      (typeFilter === "all" || g.displayCat === typeFilter) &&
      (!term || productMatchesQuery({ name: g.name, barcodes: g.sizes.map(s => s.barcode).filter(Boolean) }, term)));
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
        reason: "recount: corrected on the spot", cellState: "live", trust: "count", actorRole,
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
      {/* What this screen is — one line; tap the info icon to read it all. */}
      <button type="button" className="sky-stock-info" aria-expanded={infoOpen} onClick={() => setInfoOpen((o) => !o)}
              aria-label={infoOpen ? "Hide the explanation" : "Show the explanation"}>
        <IcInfo />
        <span className="sky-stock-info__t">
          Every cell that currently holds a quantity. <b>Clear</b> zeroes a cell (a reversible
          adjustment) and marks it <b>uncounted</b> so it's clearly waiting to be re-counted.
          Touches quantities only — never the product or its barcode.
        </span>
      </button>

      {/* Location quick-switch — tap "All" to see everything, or a location to focus it. */}
      <div ref={locRowRef} className="sky-stock-chips sky-row1" data-chip-row="" role="group" aria-label="Location">
        {[["all", "All", totalCells], ...locsWithCounts.map(loc => [loc, labelFor(loc, registry), countByLoc(loc)])].map(([val, lbl, n]) => (
          <CountChip key={val} on={locFilter === val} label={lbl} n={n} onClick={() => { setLocFilter(val); cancelEdit(); }} />
        ))}
      </div>

      {/* Category chips — display filter only (one per real top-level category,
          + All / Uncategorized). Does NOT change the audited movement `type`. */}
      <div ref={typeRowRef} className="sky-stock-chips sky-row1" data-chip-row="" role="group" aria-label="Category">
        {TYPE_CHIPS.map((val) => [val, val === "all" ? "All" : val]).map(([val, lbl]) => (
          <CountChip key={val} on={typeFilter === val} label={lbl} onClick={() => { setTypeFilter(val); cancelEdit(); }} />
        ))}
      </div>

      <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search product or barcode…"
        className="sky-stock-search" aria-label="Search product or barcode" />

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
          <div className="sky-stock-sum">{filtered.length} product{filtered.length === 1 ? "" : "s"} · {shownCells} size{shownCells === 1 ? "" : "s"} · {shownUnits} unit{shownUnits === 1 ? "" : "s"}</div>
          <div className="sky-stock-list">
            {filtered.map(g => {
              const gk = `${g.loc}|${g.pid}`;
              const prodBusy = busyKey === `prod:${gk}`;
              const open = expanded.has(gk);
              return (
                <div key={gk} className="sky-stock-row" data-testid="counted-row">
                  {/* Product header — tap to expand/collapse the size breakdown. */}
                  <div className="sky-li">
                    <Thumb product={g.product} productId={g.pid} onOpen={() => g.photoUrl && setLightbox(g.photoUrl)} />
                    <div className="sky-li__body" onClick={() => toggleExpand(gk)}>
                      <div className="sky-li__title">{g.name}</div>
                      <div className="sky-li__sub">
                        {labelFor(g.loc, registry)} · {g.sizes.filter(s => s.qty !== 0).length} counted · {g.sizes.reduce((s, x) => s + x.qty, 0)} units
                      </div>
                    </div>
                    <div className="sky-li__end">
                      {/* Move — relocate this product's counted stock to another location. */}
                      <button type="button" className="sky-stock-act" onClick={() => { setMoveGroup(g); setMoveLoc(""); }} disabled={!!busyKey} title="Move counted stock to another location">
                        <IcMove />{busyKey === `move:${gk}` ? "Moving…" : "Move"}
                      </button>
                      {/* Clear — opens a confirmation before wiping anything. */}
                      <button type="button" className="sky-stock-act sky-stock-act--clear" onClick={() => setConfirmClear(g)} disabled={!!busyKey} title="Zero all sizes → uncounted (re-count this product)">
                        <IcClear />{prodBusy ? "Clearing…" : "Clear"}
                      </button>
                      <button type="button" className="sky-stock-exp" onClick={() => toggleExpand(gk)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>
                        <IcChevron />
                      </button>
                    </div>
                  </div>
                  {/* Size grid (collapsible) — tap a number to correct it (e.g. 3 → 2). */}
                  {open && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(94px, 1fr))", gap: 8, marginTop: 9 }}>
                    {g.sizes.map(s => {
                      const k = keyOf(g.loc, g.pid, s.size);
                      const busy = busyKey === k;
                      return (
                        <div key={k} style={{ background: s.qty === 0 ? "rgba(255,255,255,.015)" : "rgba(255,255,255,.03)", border: BORDER, borderRadius: 10, padding: "7px 7px", opacity: s.qty === 0 ? 0.7 : 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: BLUE_L, textAlign: "center" }}><SizeTag size={s.size} /></div>
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

      {/* Move counted stock to another location (e.g. Marathon PE → Hub 1).
          The one overlay (SkyOverlay): each destination its own glass card —
          the same list the old dropdown offered (wall-allowed transfer
          targets, the source excluded). */}
      <SkyOverlay open={!!moveGroup} onClose={() => !busyKey && setMoveGroup(null)} variant="auto" label="Move counted stock" testId="counted-move">
        {moveGroup && (() => {
          const dests = wallAllowedLocations(transferTargets(registry), moveGroup.loc).filter((l) => l.id !== moveGroup.loc);
          return (
            <>
              <div className="sky-ovl-card sky-ovl-msg">
                <div className="sky-ovl-msg__title">Move counted stock</div>
                <div className="sky-ovl-msg__body">
                  Move all counted quantities of <b>{moveGroup.name}</b> from <b>{labelFor(moveGroup.loc, registry)}</b> to:
                </div>
                <div className="sky-ovl-msg__note">Counts &amp; barcodes are kept — just relocated.</div>
              </div>
              <div className="sky-pop__lab sky-pop__lab--gap">Destination</div>
              <div role="radiogroup" aria-label="Destination">
                {dests.map((l) => (
                  <button key={l.id} type="button" role="radio" aria-checked={moveLoc === l.id} className="sky-ovl-card sky-pop__i" onClick={() => setMoveLoc(l.id)}>
                    <span>{labelFor(l.id, registry)}</span>
                  </button>
                ))}
              </div>
              <div className="sky-ovl-actions">
                <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--ghost" onClick={() => setMoveGroup(null)} disabled={!!busyKey}>Cancel</button>
                <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--primary" onClick={moveProduct} disabled={!moveLoc || !!busyKey}>
                  {busyKey ? "Moving…" : "Move"}
                </button>
              </div>
            </>
          );
        })()}
      </SkyOverlay>

      {/* Confirmation before wiping a product's counts — the one overlay, a
          dialog: navy words (no red text on glass), the alert icon, Cancel and
          the action. */}
      <SkyOverlay open={!!confirmClear} onClose={() => !busyKey && setConfirmClear(null)} variant="dialog" role="alertdialog" label="Clear counted stock?" testId="counted-clear">
        {confirmClear && (() => {
          const n = confirmClear.sizes.filter(s => s.qty !== 0).length;
          return (
            <>
              <div className="sky-ovl-card sky-ovl-msg">
                <span className="sky-ovl-msg__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><line x1="12" y1="7.5" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12.01" y2="16.5" /></svg>
                </span>
                <div className="sky-ovl-msg__title">Clear counted stock?</div>
                <div className="sky-ovl-msg__body">
                  This will <b>wipe all {n} counted {n === 1 ? "quantity" : "quantities"}</b> for <b>{confirmClear.name}</b> at <b>{labelFor(confirmClear.loc, registry)}</b> and mark them <b>uncounted</b>.
                </div>
                <div className="sky-ovl-msg__note">Barcodes are kept — you only re-count the size, no reprint. You'll have 30 seconds to undo.</div>
              </div>
              <div className="sky-ovl-actions">
                <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--ghost" onClick={() => setConfirmClear(null)} disabled={!!busyKey} data-autofocus="">Cancel</button>
                <button type="button" className="sky-ovl-card sky-ovl-btn sky-ovl-btn--primary" onClick={() => clearProduct(confirmClear)} disabled={!!busyKey}>
                  {busyKey ? "Clearing…" : `Yes, clear ${n}`}
                </button>
              </div>
            </>
          );
        })()}
      </SkyOverlay>

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

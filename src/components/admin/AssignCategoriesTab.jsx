// ─── ASSIGN CATEGORIES — the new-taxonomy backlog queue ───────────────────────
// Lists every product that has no `categoryKey` yet, with its photo, name, brand
// and its CURRENT LEGACY category / subcategory / productType shown read-only for
// reference, plus a picker. A row disappears the moment it is assigned (the
// products list is a live RTDB subscription).
//
// ── WHAT THIS WRITES ─────────────────────────────────────────────────────────
// products/{id}/categoryKey — THAT IS ALL. The legacy category / subcategory /
// productType fields are NEVER in the update payload, because every existing
// automation (refill sweep, Display Checks, POS browse, POS one-size, Insights,
// the reorder planner, CR flows, scan-to-transfer) still reads them and none of
// them know categoryKey exists. Assigning here is therefore INERT: it records
// what a product actually is without changing how anything behaves. That is the
// whole point — the behaviour switch-over is a later, separate decision.
//
// Legacy sneakers (category "Footwear" AND subcategory "Sneakers") never appear
// in the queue: they are treated as "sneakers" by predicate. The Auto-assign
// button additionally STAMPS categoryKey on them so the data is honest rather
// than depending on a fallback forever — it is an explicit, confirmed action,
// never something that fires on page load.

// ── WHY THIS PAGE IS BUILT THE WAY IT IS (perf) ──────────────────────────────
// Measured 2026-08-04 on live data: 2,586 products in the backlog. Rendering
// them all at once froze every phone. Four compounding causes, all fixed here —
// do not reintroduce any of them:
//
//   1. NO backdrop-filter ON A ROW. Each blurred row is its own GPU compositing
//      layer WITH a backdrop read-back, per paint and per scroll frame. 2,586 of
//      them is not "slow", it is a locked phone. Rows use a flat translucent
//      background; the blur survives only on the handful of chrome elements
//      (batch bar, modals) where the count is fixed and small.
//   2. PAGINATED at PAGE_SIZE. `list.map` over the whole queue also meant
//      ~80,000 <option> nodes, because every row carried its own <select> of 31
//      categories in 2 optgroups.
//   3. NO <select> PER ROW. A row shows a BUTTON; the category list opens once,
//      for the row you tapped. 31 options exist once, not 2,586 times.
//   4. ROWS ARE MEMOISED and the search is DEBOUNCED. Row state (`sel`) lives in
//      the parent, so without memo every keystroke and every checkbox tap
//      re-rendered the entire page — and `products` is a live subscription over
//      the whole 2.5 MB catalogue, so any edit anywhere did too.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase.js";
import {
  groupedCategories, allCategories, labelForKey, isAssignable,
  needsAssignment, isLegacySneaker, isAssigned,
} from "../../utils/productTaxonomy.js";

const BLUE = "#4A7FFF";
const CARD = "rgba(12,16,30,.55)";

// Safety cap on "select all matching" — the largest legacy bucket is ~390, so
// this is a runaway guard, not a workflow limit.
const SELECT_CAP = 2000;
// RTDB multi-path updates are chunked: one 1,166-key write is a single 400-ish KB
// payload that either lands or doesn't. Chunks keep each write small and let a
// partial failure be reported honestly.
const WRITE_CHUNK = 250;
// Rows rendered at once. The queue is ~2,600 today; everything above this waits
// behind "Show more" rather than being built into the DOM up front.
const PAGE_SIZE = 40;
// Search debounce. Filtering re-renders the visible page, so it must not run on
// every keystroke while a thumb is mid-word.
const SEARCH_DEBOUNCE_MS = 220;

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ── ONE ROW ───────────────────────────────────────────────────────────────────
// memo() with a narrow prop surface, because `sel` lives in the parent: without
// it, one checkbox tap or one keystroke re-rendered every row on the page. The
// callbacks it receives are all useCallback-stable for the same reason.
//
// NOTE THE ABSENCES, both deliberate and both load-bearing:
//   • no backdrop-filter — a blurred row is a GPU layer with a backdrop read
//   • no <select>        — tapping "Pick category" opens the ONE shared sheet
const AssignRow = memo(function AssignRow({ p, on, saving, busy, onToggle, onPhoto, onPick }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "11px 13px",
      // Flat translucent fill. Visually near-identical to the old blurred card,
      // minus the per-row compositing layer that froze phones.
      background: on ? "rgba(74,127,255,.11)" : "rgba(14,18,32,.72)",
      border: `1px solid ${on ? "rgba(74,127,255,.45)" : "rgba(120,150,255,.14)"}`,
      borderRadius: 14,
    }}>
      <input type="checkbox" checked={on} onChange={() => onToggle(p.id)} aria-label={`Select ${p.name || p.id}`}
        style={{ width: 22, height: 22, accentColor: BLUE, cursor: "pointer", flexShrink: 0 }} />

      {p.photoUrl ? (
        <button type="button" onClick={() => onPhoto(p)} title="Open photo"
          aria-label={`Open photo of ${p.name || p.id}`}
          style={{ position: "relative", width: 52, height: 52, borderRadius: 10, overflow: "hidden",
                   flexShrink: 0, padding: 0, cursor: "zoom-in", background: "rgba(255,255,255,.04)",
                   border: "1px solid rgba(255,255,255,.07)" }}>
          <img src={p.photoUrl} alt="" loading="lazy" decoding="async"
               style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <span style={{ position: "absolute", right: 2, bottom: 2, width: 15, height: 15, borderRadius: 4,
                         background: "rgba(0,0,0,.62)", color: "#fff", fontSize: 9, lineHeight: "15px",
                         textAlign: "center" }}>⤢</span>
        </button>
      ) : (
        <div style={{ width: 52, height: 52, borderRadius: 10, flexShrink: 0,
                      background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)",
                      display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 17, opacity: .3 }}>▦</span>
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.name || p.id}
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.42)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.brand ? <b style={{ color: "rgba(233,238,255,.6)" }}>{p.brand}</b> : "no brand"}
          {" · now: "}
          {p.category || "—"}{p.subcategory ? ` / ${p.subcategory}` : ""}
          {" · "}{p.productType || "no type"}
        </div>
        <button type="button" disabled={busy || saving} onClick={() => onPick(p)}
          aria-label={`Assign a category to ${p.name || p.id}`}
          style={{ marginTop: 8, background: "rgba(74,127,255,.12)", border: "1px solid rgba(74,127,255,.42)",
                   color: "#9DBCFF", borderRadius: 10, padding: "10px 14px", fontSize: 13.5, fontWeight: 700,
                   cursor: busy || saving ? "wait" : "pointer", opacity: saving ? .5 : 1, minHeight: 42 }}>
          {saving ? "Saving…" : "Pick category ▾"}
        </button>
      </div>
    </div>
  );
});

export default function AssignCategoriesTab({ products = [], registry }) {
  const [q, setQ] = useState("");
  // What the input shows (`q`) is separate from what filters (`qDebounced`), so
  // typing stays instant while the list recomputes at most every 220ms.
  const [qDebounced, setQDebounced] = useState("");
  const [legacyFilter, setLegacyFilter] = useState("");   // legacy top-level or "sub:<leaf>"
  const [brandFilter, setBrandFilter] = useState("");
  const [sel, setSel] = useState(() => new Set());
  const [bulkKey, setBulkKey] = useState("");
  const [confirm, setConfirm] = useState(null);           // { kind:"bulk"|"sneakers", items, key }
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [undo, setUndo] = useState(null);                 // { items:[{id, prev}] }
  const [baseline, setBaseline] = useState(null);
  const [msg, setMsg] = useState("");
  // Photo viewer. A 52px thumbnail is not enough to tell a hoodie from a
  // sweater or a slide from a loafer, which is exactly the call this page asks
  // you to make — so the photo opens full-size, with the picker alongside it so
  // the decision can be made and applied without closing and hunting for the row
  // again.
  const [photoView, setPhotoView] = useState(null);       // the product being viewed
  // How many rows are currently built into the DOM (see PAGE_SIZE).
  const [shown, setShown] = useState(PAGE_SIZE);
  // The row whose category picker is open. One picker exists at a time — that is
  // the whole reason 80,000 <option> nodes are gone.
  const [pickFor, setPickFor] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const cats = useMemo(() => allCategories(registry), [registry]);
  const groups = useMemo(() => groupedCategories(registry), [registry]);

  // ── The backlog (unfiltered) — drives the remaining count and the progress bar.
  const queue = useMemo(() => (products || []).filter(needsAssignment), [products]);
  const remaining = queue.length;

  // Legacy sneakers still lacking a stamped key — what the Auto-assign button writes.
  const unstampedSneakers = useMemo(
    () => (products || []).filter((p) => p && p.id && isLegacySneaker(p) && !isAssigned(p)),
    [products]);

  // Stable progress denominator: capture the starting backlog, re-baseline once
  // it fully clears so a later import starts a fresh count rather than inheriting.
  useEffect(() => {
    setBaseline((b) => (remaining > 0 ? (b == null ? remaining : Math.max(b, remaining)) : null));
  }, [remaining]);
  const done = baseline == null ? 0 : Math.max(0, baseline - remaining);
  const pct = baseline ? Math.round((done / baseline) * 100) : 0;

  // ── Filter options, derived from the backlog itself so they never offer a
  //    filter that would return nothing.
  const legacyOptions = useMemo(() => {
    const tops = new Map();     // top → Map(sub → count)
    for (const p of queue) {
      const top = p.category || "— no category —";
      const sub = p.subcategory || "— no subcategory —";
      if (!tops.has(top)) tops.set(top, new Map());
      const m = tops.get(top);
      m.set(sub, (m.get(sub) || 0) + 1);
    }
    return [...tops.entries()]
      .map(([top, subs]) => ({
        top,
        count: [...subs.values()].reduce((a, b) => a + b, 0),
        subs: [...subs.entries()].sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.count - a.count);
  }, [queue]);

  const brandOptions = useMemo(() => {
    const m = new Map();
    for (const p of queue) if (p.brand) m.set(p.brand, (m.get(p.brand) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [queue]);

  // ── The visible, filtered list.
  const list = useMemo(() => {
    const query = qDebounced.trim().toLowerCase();
    return queue
      .filter((p) => {
        if (brandFilter && p.brand !== brandFilter) return false;
        if (legacyFilter) {
          if (legacyFilter.startsWith("sub:")) {
            const want = legacyFilter.slice(4);
            if ((p.subcategory || "— no subcategory —") !== want) return false;
          } else if ((p.category || "— no category —") !== legacyFilter) return false;
        }
        if (query) {
          const hay = `${p.name || ""} ${p.brand || ""} ${p.sku || ""} ${p.barcode || ""}`.toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [queue, qDebounced, legacyFilter, brandFilter]);

  // The rows actually rendered. Everything past this waits behind "Show more".
  const visible = useMemo(() => list.slice(0, shown), [list, shown]);
  // A new filter/search means a new list — start it from the top again, or the
  // user would land mid-way through a page count that no longer means anything.
  useEffect(() => { setShown(PAGE_SIZE); }, [qDebounced, legacyFilter, brandFilter]);

  // Prune selections that have left the backlog (assigned on another device) so
  // the toolbar count can never promise more than the write will touch.
  useEffect(() => {
    const valid = new Set(queue.map((p) => p.id));
    setSel((s) => {
      let changed = false;
      const n = new Set();
      for (const id of s) { if (valid.has(id)) n.add(id); else changed = true; }
      return changed ? n : s;
    });
  }, [queue]);

  const selectedList = useMemo(() => queue.filter((p) => sel.has(p.id)), [queue, sel]);

  // Esc closes the photo viewer, and the confirm dialog when no photo is open.
  useEffect(() => {
    if (!photoView && !confirm && !pickFor) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (pickFor) setPickFor(null);
      else if (photoView) setPhotoView(null);
      else if (!busy) setConfirm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoView, confirm, pickFor, busy]);

  // Keep the open photo in sync with live data, and drop it once the product
  // leaves the queue — otherwise assigning it on another device would leave a
  // stale card open offering to assign something already done.
  useEffect(() => {
    if (!photoView) return;
    const fresh = queue.find((p) => p.id === photoView.id);
    if (!fresh) setPhotoView(null);
    else if (fresh !== photoView) setPhotoView(fresh);
  }, [queue, photoView]);

  useEffect(() => {
    if (confirm?.kind === "bulk" && selectedList.length === 0) setConfirm(null);
  }, [confirm, selectedList.length]);

  // Same rule the photo viewer follows: if the product was assigned on another
  // device while its picker was open, close it rather than offer a dead choice.
  useEffect(() => {
    if (pickFor && !queue.some((p) => p.id === pickFor.id)) setPickFor(null);
  }, [queue, pickFor]);

  // Stable identities — a memoised row that receives a fresh function on every
  // parent render is not memoised at all.
  const toggle = useCallback((id) => {
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const selectAllMatching = () => setSel((s) => {
    const n = new Set(s);
    for (const p of list) { if (n.size >= SELECT_CAP) break; n.add(p.id); }
    return n;
  });

  // ── THE WRITE. categoryKey only, chunked, with the prior value recorded.
  //
  // LAST-WRITE-WINS IS NOT ACCEPTABLE HERE. A batch can be confirmed over a
  // thousand rows and pressed seconds later, while a second admin is working the
  // same queue. So the batch is re-filtered against the CURRENT live data at
  // write time (`stillUnassigned`), not against the snapshot taken when the
  // dialog opened: a product someone else categorised in the meantime is skipped
  // rather than silently overwritten. The count reported back is what was
  // actually written, and any skips are stated.
  const applyAssign = async (items, key, label) => {
    if (!items.length || !key || !isAssignable(registry, key)) {
      setMsg("That category is no longer available — pick another.");
      setConfirm(null);
      return;
    }
    // Re-read from the live products list, not the captured items. Anything
    // assigned since the dialog opened is another admin's decision — skip it.
    const live = new Map((products || []).filter((p) => p && p.id).map((p) => [p.id, p]));
    const writable = items.map((p) => live.get(p.id)).filter((p) => p && !isAssigned(p));
    const skipped = items.length - writable.length;

    if (!writable.length) {
      setConfirm(null);
      setSel(new Set());
      setMsg(`Nothing to write — all ${items.length} were categorised by someone else first.`);
      return;
    }

    setBusy(true);
    setMsg("");
    const undoItems = writable.map((p) => ({ id: p.id, prev: p.categoryKey ?? null, wrote: key }));
    let written = 0;
    try {
      for (const part of chunk(writable, WRITE_CHUNK)) {
        const updates = {};
        for (const p of part) updates[`products/${p.id}/categoryKey`] = key;
        await update(ref(database), updates);
        written += part.length;
      }
      setUndo({ items: undoItems.slice(0, written) });
      setSel((s) => { const n = new Set(s); for (const it of undoItems) n.delete(it.id); return n; });
      setConfirm(null);
      setMsg(`Assigned ${written} product${written === 1 ? "" : "s"} to ${label || labelForKey(registry, key)}.`
        + (skipped ? ` ${skipped} skipped — already categorised by someone else.` : ""));
    } catch (e) {
      // Chunked writes mean a mid-run failure leaves earlier chunks applied —
      // say so plainly rather than implying the whole batch rolled back.
      setUndo(written ? { items: undoItems.slice(0, written) } : null);
      setMsg(`Save failed after ${written} of ${writable.length}: ${e?.message || e}.`
        + (written ? ` The ${written} already written can be undone.` : ""));
    } finally {
      setBusy(false);
    }
  };

  const assignOne = async (p, key) => {
    setSavingId(p.id);
    try { await applyAssign([p], key); }
    finally { setSavingId(null); }
  };

  // Undo reverts ONLY the rows that still hold exactly what this action wrote.
  // If someone re-categorised a product afterwards, undoing here would quietly
  // destroy THEIR decision — so those rows are left alone and reported.
  const doUndo = async () => {
    if (!undo) return;
    const live = new Map((products || []).filter((p) => p && p.id).map((p) => [p.id, p]));
    const revertable = undo.items.filter((it) => {
      const p = live.get(it.id);
      return p && (p.categoryKey ?? null) === it.wrote;
    });
    const held = undo.items.length - revertable.length;

    if (!revertable.length) {
      setUndo(null);
      setMsg(`Nothing to undo — all ${undo.items.length} have been changed again since.`);
      return;
    }

    setBusy(true);
    try {
      for (const part of chunk(revertable, WRITE_CHUNK)) {
        const updates = {};
        // `null` DELETES the key, correctly restoring "never assigned" rather
        // than storing a literal null.
        for (const it of part) updates[`products/${it.id}/categoryKey`] = it.prev;
        await update(ref(database), updates);
      }
      setUndo(null);
      setMsg(`Undone ${revertable.length}.` + (held ? ` ${held} left alone — changed again since.` : ""));
    } catch (e) { setMsg("Undo failed: " + (e?.message || e)); }
    finally { setBusy(false); }
  };

  // ── styles ────────────────────────────────────────────────────────────────
  const field = {
    background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 11,
    padding: "11px 13px", color: "#fff", fontSize: 14, fontWeight: 600, outline: "none",
    width: "100%", boxSizing: "border-box", minHeight: 46,
  };
  const pickerStyle = { ...field, appearance: "auto", WebkitAppearance: "menulist", cursor: "pointer", fontSize: 16 };
  // A misconfigured category is shown DISABLED rather than hidden — hiding it
  // would read as "deleted" to someone hunting for it, and letting it be picked
  // would dead-end a batch of 500 at the confirm step.
  const catOptions = groups.map((g) => (
    <optgroup key={g.top} label={g.label.toUpperCase()}>
      {g.options.map((c) => {
        const ok = isAssignable(registry, c.key);
        return (
          <option key={c.key} value={c.key} disabled={!ok}>
            {ok ? c.label : `${c.label} — misconfigured`}
          </option>
        );
      })}
    </optgroup>
  ));

  return (
    <div style={{ padding: "0 14px 40px" }}>
      {/* ── HEADER + PROGRESS ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 0 10px" }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>Assign Categories</span>
        <span style={{ background: "rgba(74,127,255,.15)", border: "1px solid rgba(74,127,255,.35)", color: "#9DBCFF",
                       fontSize: 12.5, fontWeight: 800, padding: "3px 11px", borderRadius: 12, fontVariantNumeric: "tabular-nums" }}>
          {remaining.toLocaleString()} remaining
        </span>
      </div>

      {baseline > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: "rgba(233,238,255,.55)", marginBottom: 5 }}>
            Assigned <b style={{ color: "#4ACA7A" }}>{done.toLocaleString()}</b> of {baseline.toLocaleString()} · {pct}%
          </div>
          <div style={{ height: 6, borderRadius: 4, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "#4ACA7A", transition: "width .3s" }} />
          </div>
        </div>
      )}

      <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.45)", marginBottom: 12, lineHeight: 1.5 }}>
        Records what each product actually is. This writes the new category field <b>only</b> — the existing
        category, product type, refill behaviour and display checks are untouched.
      </div>

      {/* ── AUTO-ASSIGN SNEAKERS ──────────────────────────────────────────── */}
      {unstampedSneakers.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: CARD,
                      backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
                      border: "1px solid rgba(74,127,255,.20)", borderRadius: 14, padding: "13px 15px", marginBottom: 14 }}>
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#E9EEFF" }}>
              {unstampedSneakers.length.toLocaleString()} legacy sneakers ready to stamp
            </div>
            <div style={{ fontSize: 12, color: "rgba(233,238,255,.45)", marginTop: 2 }}>
              Already treated as Sneakers and hidden from this queue. Stamping makes it real data.
            </div>
          </div>
          <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "sneakers", items: unstampedSneakers, key: "sneakers" })}
            style={{ background: "rgba(74,127,255,.14)", border: `1px solid ${BLUE}`, color: "#9DBCFF", borderRadius: 11,
                     padding: "11px 17px", fontSize: 13, fontWeight: 700, cursor: busy ? "wait" : "pointer", whiteSpace: "nowrap" }}>
            Auto-assign to Sneakers
          </button>
        </div>
      )}

      {/* ── SEARCH + FILTERS ──────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 12 }}>
        <input placeholder="Search name, brand, SKU…" value={q} onChange={(e) => setQ(e.target.value)} style={field} />
        <select value={legacyFilter} onChange={(e) => setLegacyFilter(e.target.value)} style={pickerStyle} aria-label="Filter by current category">
          <option value="">All current categories</option>
          {legacyOptions.map((t) => (
            <optgroup key={t.top} label={`${t.top} (${t.count})`}>
              <option value={t.top}>All {t.top} ({t.count})</option>
              {t.subs.map(([sub, n]) => <option key={sub} value={`sub:${sub}`}>{sub} ({n})</option>)}
            </optgroup>
          ))}
        </select>
        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} style={pickerStyle} aria-label="Filter by brand">
          <option value="">All brands</option>
          {brandOptions.map(([b, n]) => <option key={b} value={b}>{b} ({n})</option>)}
        </select>
      </div>

      {/* ── BATCH BAR ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: CARD,
                    backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
                    border: "1px solid rgba(120,150,255,.16)", borderRadius: 14, padding: "12px 14px", marginBottom: 14 }}>
        <button type="button" onClick={selectAllMatching} disabled={!list.length || busy}
          style={{ background: "transparent", border: "1px solid rgba(74,127,255,.35)", color: "#9DBCFF", borderRadius: 10,
                   padding: "9px 14px", fontSize: 12.5, fontWeight: 700, cursor: list.length ? "pointer" : "not-allowed", opacity: list.length ? 1 : .45 }}>
          Select all {list.length.toLocaleString()} shown
        </button>
        {sel.size > 0 && (
          <>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{sel.size.toLocaleString()} selected</span>
            <button type="button" onClick={() => setSel(new Set())} disabled={busy}
              style={{ background: "transparent", border: "none", color: "rgba(233,238,255,.5)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
              Clear
            </button>
            <select value={bulkKey} onChange={(e) => setBulkKey(e.target.value)} style={{ ...pickerStyle, flex: "1 1 190px", width: "auto" }} aria-label="Assign selected to">
              <option value="">Assign selected to…</option>
              {catOptions}
            </select>
            <button type="button" disabled={!bulkKey || busy}
              onClick={() => setConfirm({ kind: "bulk", items: selectedList, key: bulkKey })}
              style={{ background: bulkKey ? BLUE : "rgba(255,255,255,.06)", border: "none", color: bulkKey ? "#fff" : "rgba(255,255,255,.35)",
                       borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 800, cursor: bulkKey && !busy ? "pointer" : "not-allowed" }}>
              Assign
            </button>
          </>
        )}
        {sel.size === 0 && (
          <span style={{ fontSize: 12.5, color: "rgba(233,238,255,.4)" }}>
            Filter to a group, select all, assign in one step.
          </span>
        )}
      </div>

      {/* ── STATUS + UNDO ─────────────────────────────────────────────────── */}
      {(msg || undo) && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12,
                      background: "rgba(74,202,122,.08)", border: "1px solid rgba(74,202,122,.25)", borderRadius: 12, padding: "10px 14px" }}>
          <span style={{ fontSize: 12.5, color: "#B7F0CC", flex: "1 1 200px" }}>{msg}</span>
          {undo && (
            <button type="button" onClick={doUndo} disabled={busy}
              style={{ background: "transparent", border: "1px solid rgba(74,202,122,.45)", color: "#7FE0A4", borderRadius: 9,
                       padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
              Undo {undo.items.length.toLocaleString()}
            </button>
          )}
        </div>
      )}

      {/* ── THE LIST ──────────────────────────────────────────────────────── */}
      {remaining === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 16px", color: "rgba(233,238,255,.45)" }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>✓</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#E9EEFF" }}>Every product has a category.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>New products get one at creation — this queue stays empty.</div>
        </div>
      ) : list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "34px 16px", color: "rgba(233,238,255,.4)", fontSize: 13.5 }}>
          No products match these filters. {remaining.toLocaleString()} still to assign overall.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {visible.map((p) => (
            <AssignRow key={p.id} p={p} on={sel.has(p.id)} saving={savingId === p.id} busy={busy}
              onToggle={toggle} onPhoto={setPhotoView} onPick={setPickFor} />
          ))}

          {list.length > visible.length && (
            <button type="button" onClick={() => setShown((n) => n + PAGE_SIZE * 2)}
              style={{ background: "rgba(74,127,255,.10)", border: "1px solid rgba(74,127,255,.35)", color: "#9DBCFF",
                       borderRadius: 12, padding: "13px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", marginTop: 3 }}>
              Show more — {(list.length - visible.length).toLocaleString()} more match
            </button>
          )}
          {list.length > 0 && (
            <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.35)", padding: "4px 2px", textAlign: "center" }}>
              Showing {visible.length.toLocaleString()} of {list.length.toLocaleString()}
              {list.length >= SELECT_CAP && ` · “Select all” stops at ${SELECT_CAP.toLocaleString()}`}
            </div>
          )}
        </div>
      )}

      {/* ── CATEGORY PICKER (one, shared) ─────────────────────────────────── */}
      {/* The 31 categories exist ONCE in the DOM, for whichever row was tapped —
          not once per row. This is what removed ~80,000 <option> nodes. */}
      {pickFor && (
        <div onClick={() => setPickFor(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", zIndex: 65,
                   display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#0B0E18", border: "1px solid rgba(74,127,255,.28)",
                     borderRadius: "18px 18px 0 0", padding: "16px 16px 22px", width: "100%", maxWidth: 520,
                     maxHeight: "82vh", overflowY: "auto", boxShadow: "0 -18px 50px rgba(0,0,0,.6)" }}>
            <div style={{ fontSize: 12, color: "rgba(233,238,255,.45)", marginBottom: 2 }}>Assign category to</div>
            <div style={{ fontSize: 15.5, fontWeight: 800, color: "#fff", marginBottom: 14,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {pickFor.name || pickFor.id}
            </div>

            {groups.map((g) => (
              <div key={g.top} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".08em", color: "rgba(233,238,255,.35)",
                              textTransform: "uppercase", marginBottom: 7 }}>{g.label}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {g.options.map((c) => {
                    const ok = isAssignable(registry, c.key);
                    return (
                      <button key={c.key} type="button" disabled={!ok || busy}
                        onClick={() => { const t = pickFor; setPickFor(null); assignOne(t, c.key); }}
                        style={{ background: ok ? "rgba(74,127,255,.10)" : "rgba(255,255,255,.03)",
                                 border: `1px solid ${ok ? "rgba(74,127,255,.35)" : "rgba(255,255,255,.10)"}`,
                                 color: ok ? "#CFE0FF" : "rgba(233,238,255,.3)", borderRadius: 10,
                                 padding: "11px 14px", fontSize: 13.5, fontWeight: 700, minHeight: 44,
                                 cursor: ok && !busy ? "pointer" : "not-allowed" }}>
                        {ok ? c.label : `${c.label} — misconfigured`}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <button type="button" onClick={() => setPickFor(null)}
              style={{ width: "100%", background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.16)",
                       color: "rgba(233,238,255,.75)", borderRadius: 11, padding: "13px", fontSize: 13.5,
                       fontWeight: 700, cursor: "pointer", marginTop: 4 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── PHOTO VIEWER ──────────────────────────────────────────────────── */}
      {photoView && (
        <div
          onClick={() => setPhotoView(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", backdropFilter: "blur(6px)",
                   display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 70 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 620, width: "100%",
                     maxHeight: "100%", overflow: "auto" }}>
            {/* Contain, not cover — a cropped product photo is the opposite of
                useful when the crop is what you are trying to judge. */}
            <img src={photoView.photoUrl} alt={photoView.name || "product photo"}
                 style={{ width: "100%", maxHeight: "62vh", objectFit: "contain", borderRadius: 14,
                          background: "rgba(255,255,255,.03)" }} />

            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", lineHeight: 1.3 }}>
                {photoView.name || photoView.id}
              </div>
              <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.45)", marginTop: 4 }}>
                {photoView.brand ? <b style={{ color: "rgba(233,238,255,.65)" }}>{photoView.brand}</b> : "no brand"}
                {" · now: "}{photoView.category || "—"}{photoView.subcategory ? ` / ${photoView.subcategory}` : ""}
                {" · "}{photoView.productType || "no type"}
                {photoView.sizes?.length ? ` · ${photoView.sizes.join(", ")}` : ""}
              </div>
            </div>

            {/* Assign straight from here — the photo is what the decision is
                based on, so closing first to find the row again is pure friction. */}
            <select
              value=""
              disabled={busy || savingId === photoView.id}
              onChange={(e) => {
                if (!e.target.value) return;
                const target = photoView;
                setPhotoView(null);
                assignOne(target, e.target.value);
              }}
              aria-label={`Assign a category to ${photoView.name || photoView.id}`}
              style={{ ...pickerStyle, minHeight: 50 }}>
              <option value="">{savingId === photoView.id ? "Saving…" : "Pick category…"}</option>
              {catOptions}
            </select>

            <button type="button" onClick={() => setPhotoView(null)}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.16)",
                       color: "rgba(233,238,255,.75)", borderRadius: 11, padding: "12px 18px",
                       fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── CONFIRM ───────────────────────────────────────────────────────── */}
      {confirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", backdropFilter: "blur(4px)",
                      display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 60 }}
             onClick={() => !busy && setConfirm(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "rgba(10,13,24,.96)", border: "1px solid rgba(74,127,255,.3)", borderRadius: 18,
            padding: "22px 22px 18px", maxWidth: 420, width: "100%", boxShadow: "0 24px 60px rgba(0,0,0,.6)" }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
              {confirm.kind === "sneakers" ? "Stamp legacy sneakers?" : "Assign category?"}
            </div>
            <div style={{ fontSize: 13.5, color: "rgba(233,238,255,.65)", lineHeight: 1.55, marginBottom: 16 }}>
              {confirm.items.length.toLocaleString()} product{confirm.items.length === 1 ? "" : "s"} →{" "}
              <b style={{ color: "#9DBCFF" }}>{labelForKey(registry, confirm.key)}</b>.
              <br /><br />
              Writes the new category field only. Current category, product type, refill and display checks stay exactly as they are. Reversible with Undo.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setConfirm(null)} disabled={busy}
                style={{ background: "transparent", border: "1px solid rgba(255,255,255,.18)", color: "rgba(233,238,255,.7)",
                         borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Cancel
              </button>
              <button type="button" disabled={busy}
                onClick={() => applyAssign(confirm.items, confirm.key)}
                style={{ background: BLUE, border: "none", color: "#fff", borderRadius: 10, padding: "10px 20px",
                         fontSize: 13, fontWeight: 800, cursor: busy ? "wait" : "pointer" }}>
                {busy ? "Assigning…" : `Assign ${confirm.items.length.toLocaleString()}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {cats.length === 0 && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "#FBBF24" }}>
          No categories in the registry — run <code>scripts/seed-product-taxonomy.mjs</code>.
        </div>
      )}
    </div>
  );
}

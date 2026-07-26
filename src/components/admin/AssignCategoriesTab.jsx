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

import { useEffect, useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase.js";
import {
  groupedCategories, allCategories, labelForKey, catByKey,
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

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export default function AssignCategoriesTab({ products = [], registry }) {
  const [q, setQ] = useState("");
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
    const query = q.trim().toLowerCase();
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
  }, [queue, q, legacyFilter, brandFilter]);

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

  useEffect(() => {
    if (confirm?.kind === "bulk" && selectedList.length === 0) setConfirm(null);
  }, [confirm, selectedList.length]);

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectAllMatching = () => setSel((s) => {
    const n = new Set(s);
    for (const p of list) { if (n.size >= SELECT_CAP) break; n.add(p.id); }
    return n;
  });

  // ── THE WRITE. categoryKey only, chunked, with the prior value recorded.
  const applyAssign = async (items, key, label) => {
    if (!items.length || !key || !catByKey(registry, key)) return;
    setBusy(true);
    setMsg("");
    const undoItems = items.map((p) => ({ id: p.id, prev: p.categoryKey ?? null }));
    let written = 0;
    try {
      for (const part of chunk(items, WRITE_CHUNK)) {
        const updates = {};
        for (const p of part) updates[`products/${p.id}/categoryKey`] = key;
        await update(ref(database), updates);
        written += part.length;
      }
      setUndo({ items: undoItems });
      setSel((s) => { const n = new Set(s); for (const it of undoItems) n.delete(it.id); return n; });
      setConfirm(null);
      setMsg(`Assigned ${written} product${written === 1 ? "" : "s"} to ${label || labelForKey(registry, key)}.`);
    } catch (e) {
      // Chunked writes mean a mid-run failure leaves earlier chunks applied —
      // say so plainly rather than implying the whole batch rolled back.
      setUndo(written ? { items: undoItems.slice(0, written) } : null);
      setMsg(`Save failed after ${written} of ${items.length}: ${e?.message || e}. The ${written} already written can be undone.`);
    } finally {
      setBusy(false);
    }
  };

  const assignOne = async (p, key) => {
    setSavingId(p.id);
    try { await applyAssign([p], key); }
    finally { setSavingId(null); }
  };

  const doUndo = async () => {
    if (!undo) return;
    setBusy(true);
    try {
      for (const part of chunk(undo.items, WRITE_CHUNK)) {
        const updates = {};
        for (const it of part) updates[`products/${it.id}/categoryKey`] = it.prev;
        await update(ref(database), updates);
      }
      setUndo(null);
      setMsg("Undone.");
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
  const catOptions = groups.map((g) => (
    <optgroup key={g.top} label={g.label.toUpperCase()}>
      {g.options.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
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
          {list.map((p) => {
            const on = sel.has(p.id);
            return (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "11px 13px",
                background: on ? "rgba(74,127,255,.09)" : CARD,
                backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
                border: `1px solid ${on ? "rgba(74,127,255,.45)" : "rgba(120,150,255,.14)"}`,
                borderRadius: 14, transition: "background .12s, border-color .12s",
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(p.id)} aria-label={`Select ${p.name || p.id}`}
                  style={{ width: 20, height: 20, accentColor: BLUE, cursor: "pointer", flexShrink: 0 }} />

                <div style={{ width: 52, height: 52, borderRadius: 10, overflow: "hidden", flexShrink: 0,
                              background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)",
                              display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {p.photoUrl
                    ? <img src={p.photoUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontSize: 17, opacity: .3 }}>▦</span>}
                </div>

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
                  <div style={{ marginTop: 8 }}>
                    <select
                      value=""
                      disabled={busy || savingId === p.id}
                      onChange={(e) => { if (e.target.value) assignOne(p, e.target.value); }}
                      aria-label={`Assign a category to ${p.name || p.id}`}
                      style={{ ...pickerStyle, minHeight: 42, padding: "9px 11px", fontSize: 15,
                               opacity: savingId === p.id ? .5 : 1, maxWidth: 300 }}>
                      <option value="">{savingId === p.id ? "Saving…" : "Pick category…"}</option>
                      {catOptions}
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
          {list.length >= SELECT_CAP && (
            <div style={{ fontSize: 12, color: "rgba(251,191,36,.8)", padding: "8px 2px" }}>
              Showing {list.length.toLocaleString()} — “Select all” stops at {SELECT_CAP.toLocaleString()}.
            </div>
          )}
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

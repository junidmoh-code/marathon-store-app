// ─── BULK PRICING — REPRICE PRODUCTS THAT ALREADY HAVE PRICES ────────────────
// The admin "Pricing" section: search/filter the whole catalogue, select many,
// then either set an absolute stock/retail value or apply ONE signed
// percentage (a sale is usually a percentage; -20 = 20% off, rounded to the
// whole rand). Exactly like the Missing Prices bulk bar, nothing writes
// without the preview — current → new per product, honest skip lists — and
// every apply is ONE atomic audited batch, reversible by its batchId from the
// history panel below the list.
//
// Products currently ON SPECIAL are excluded from selection here by design:
// their retailPrice IS the special price and the pre-special price is parked
// on /specials/{id}/wasPrice — repricing them would strand that parked value.
// The store refuses such writes anyway (code "on_special"); this surface
// simply doesn't offer them, and says so on the row.

import { useEffect, useMemo, useState } from "react";
import { applyPriceBatch, restorePriceBatch, previewRestore, loadRecentBatches, loadSpecials } from "./priceStore";
import { buildBulkChangePlan } from "../../utils/bulkPricing";
import BulkPricePreview from "./BulkPricePreview";
import { typeOf } from "../../utils/missingPrices";

const fmt = (v) => (typeof v === "number" ? `R${v.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "—");
const PAGE_SIZE = 50;

const INPUT = { background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, color: "#fff", padding: "8px 10px", fontSize: 12 };
const BTN = (on) => ({ background: on ? "#4A7FFF" : "rgba(255,255,255,.06)", border: "1px solid " + (on ? "#4A7FFF" : "rgba(255,255,255,.15)"), borderRadius: 8, color: on ? "#fff" : "rgba(255,255,255,.65)", padding: "8px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" });

const ACTION_LABEL = {
  single_edit: "Single edit", bulk_fill: "Bulk fill", bulk_change: "Bulk change",
  special_start: "Special started", special_end: "Special ended", restore: "Restore",
};

export default function BulkPricingTab({ products = [] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [mode, setMode] = useState("percent"); // sales are usually percentages
  const [stockDraft, setStockDraft] = useState("");
  const [retailDraft, setRetailDraft] = useState("");
  const [percentDraft, setPercentDraft] = useState("");
  const [applyToStock, setApplyToStock] = useState(false);
  const [applyToRetail, setApplyToRetail] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: "ok"|"err", text }
  const [specials, setSpecials] = useState({});
  // History panel: recent batch metas (compact index only) + per-batch state.
  const [history, setHistory] = useState(null); // null = loading
  const [restoreCandidate, setRestoreCandidate] = useState(null); // { batchId, record, drift }

  const productsById = useMemo(() => Object.fromEntries(products.filter((p) => p && p.id).map((p) => [p.id, p])), [products]);

  const refreshHistory = () => {
    loadRecentBatches(15).then(setHistory).catch((e) => setHistory({ error: String(e?.message || e) }));
  };
  useEffect(() => { refreshHistory(); }, []);
  useEffect(() => {
    loadSpecials().then(setSpecials).catch((e) => {
      setSpecials({});
      setNotice({ kind: "err", text: `Active specials could not be read (${e?.message || e}). Products on special are not marked here and the on-special guard is OFF for this session — refresh before repricing anything that might be on special.` });
    });
  }, []);

  const categories = useMemo(() => {
    const set = new Set(products.filter((p) => p && p.id).map((p) => typeOf(p)));
    return ["all", ...[...set].sort()];
  }, [products]);

  const list = useMemo(() => {
    let items = products.filter((p) => p && p.id);
    if (filter !== "all") items = items.filter((p) => typeOf(p) === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((p) =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.sku || "").toLowerCase().includes(q) ||
        (p.barcode || "").toLowerCase().includes(q));
    }
    return items;
  }, [products, filter, search]);

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const pageItems = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Live data can shrink the list under the pager — clamp so the operator is
  // never stranded on an empty page (CodeRabbit, PR #355).
  useEffect(() => { setPage((p) => Math.min(p, totalPages)); }, [totalPages]);

  const selectable = (p) => !specials[p.id];
  const toggleSelect = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pageAllSelected = pageItems.filter(selectable).length > 0 && pageItems.filter(selectable).every((p) => selected.has(p.id));
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev);
    for (const p of pageItems) { if (!selectable(p)) continue; pageAllSelected ? n.delete(p.id) : n.add(p.id); }
    return n;
  });

  const planInput = { products, selectedIds: [...selected], mode, stockDraft, retailDraft, percentDraft, applyToStock, applyToRetail };
  const plan = useMemo(() => (previewOpen ? buildBulkChangePlan(planInput) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewOpen, products, selected, mode, stockDraft, retailDraft, percentDraft, applyToStock, applyToRetail]);

  const openPreview = () => {
    const probe = buildBulkChangePlan(planInput);
    if (!probe.ok) { setNotice({ kind: "err", text: probe.error }); return; }
    setNotice(null);
    setPreviewOpen(true);
  };

  // The store's write/restore paths return {ok:false} rather than throwing,
  // but every handler still try/finally-resets busy so no rejection can strand
  // the controls disabled (CodeRabbit, PR #355).
  const applyPlan = async () => {
    if (!plan?.ok || busy) return;
    setBusy(true);
    try {
      const res = await applyPriceBatch({
        action: "bulk_change",
        lines: plan.lines,
        label: mode === "percent"
          ? `Bulk change ${percentDraft.trim()}% — ${plan.count} products`
          : `Bulk change to fixed price — ${plan.count} products`,
      });
      setPreviewOpen(false);
      if (!res.ok) { setNotice({ kind: "err", text: "Nothing was written: " + res.message }); return; }
      setSelected(new Set());
      setStockDraft(""); setRetailDraft(""); setPercentDraft("");
      setNotice({ kind: "ok", text: `Repriced ${res.count} products — batch ${res.batchId}. Undo from History below.` });
      refreshHistory();
    } catch (e) {
      setNotice({ kind: "err", text: "Nothing was written: " + (e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const openRestore = async (batchId) => {
    let pv;
    try {
      pv = await previewRestore(batchId, productsById);
    } catch (e) {
      setNotice({ kind: "err", text: `Could not read batch ${batchId}: ${e?.message || e}` });
      return;
    }
    if (!pv.ok) { setNotice({ kind: "err", text: pv.message }); return; }
    setRestoreCandidate({ batchId, record: pv.record, drift: pv.drift });
  };

  const doRestore = async () => {
    if (!restoreCandidate || busy) return;
    setBusy(true);
    try {
      const res = await restorePriceBatch(restoreCandidate.batchId, productsById);
      setRestoreCandidate(null);
      if (!res.ok) { setNotice({ kind: "err", text: "Restore failed — nothing was changed: " + res.message }); return; }
      setNotice({ kind: "ok", text: `Restored ${res.count} products to their prior prices (batch ${res.restored}).` });
      refreshHistory();
    } catch (e) {
      setNotice({ kind: "err", text: "Restore failed — nothing was changed: " + (e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  // If live product changes invalidate the open plan, close the modal WITH a
  // message instead of letting it vanish silently (CodeRabbit, PR #355).
  useEffect(() => {
    if (previewOpen && plan && !plan.ok) {
      setPreviewOpen(false);
      setNotice({ kind: "err", text: "The selection changed and the plan is no longer valid: " + plan.error });
    }
  }, [previewOpen, plan]);

  return (
    <div style={{ padding: "0 14px 30px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0 8px" }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>Bulk Pricing</span>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,.45)" }}>{list.length} products</span>
      </div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,.45)", marginBottom: 12 }}>
        Select products, then set a fixed price or apply a percentage change. Every change previews first and is undoable by batch from History.
      </div>

      {notice && (
        <div style={{ background: notice.kind === "ok" ? "rgba(74,202,122,.08)" : "rgba(255,99,99,.08)", border: `1px solid ${notice.kind === "ok" ? "rgba(74,202,122,.35)" : "rgba(255,99,99,.4)"}`, borderRadius: 10, padding: "9px 12px", marginBottom: 12, fontSize: 12, color: notice.kind === "ok" ? "#4ACA7A" : "#FF8A8A", display: "flex", gap: 10 }}>
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>{notice.text}</span>
          <button onClick={() => setNotice(null)} style={{ background: "none", border: "none", color: "rgba(255,255,255,.4)", cursor: "pointer" }}>✕</button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {categories.map((c) => (
          <button key={c} onClick={() => { setFilter(c); setPage(1); }} style={BTN(filter === c)}>{c === "all" ? "All" : c}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name, SKU, barcode…" style={{ ...INPUT, flex: 1, minWidth: 150 }} />
        <button onClick={togglePage} style={BTN(false)}>{pageAllSelected ? "Unselect page" : "Select page"}</button>
      </div>

      {/* Change bar */}
      {selected.size > 0 && (
        <div style={{ background: "rgba(74,127,255,.07)", border: "1px solid rgba(74,127,255,.35)", borderRadius: 10, padding: "10px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#9DBCFF" }}>{selected.size} selected</span>
            <button onClick={() => setMode("percent")} style={BTN(mode === "percent")}>% change</button>
            <button onClick={() => setMode("absolute")} style={BTN(mode === "absolute")}>Set price</button>
            <button onClick={() => setSelected(new Set())} style={{ background: "none", border: "none", color: "rgba(255,255,255,.45)", fontSize: 12, cursor: "pointer", marginLeft: "auto" }}>Clear</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {mode === "percent" ? (
              <>
                <input value={percentDraft} onChange={(e) => setPercentDraft(e.target.value)} placeholder="% e.g. -20" inputMode="decimal" style={{ ...INPUT, width: 100 }} />
                <label style={{ fontSize: 12, color: "#fff", display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                  <input type="checkbox" checked={applyToRetail} onChange={(e) => setApplyToRetail(e.target.checked)} /> Retail
                </label>
                <label style={{ fontSize: 12, color: "#fff", display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                  <input type="checkbox" checked={applyToStock} onChange={(e) => setApplyToStock(e.target.checked)} /> Stock
                </label>
              </>
            ) : (
              <>
                <input value={stockDraft} onChange={(e) => setStockDraft(e.target.value)} placeholder="Stock price (R)" inputMode="decimal" style={{ ...INPUT, width: 110 }} />
                <input value={retailDraft} onChange={(e) => setRetailDraft(e.target.value)} placeholder="Retail price (R)" inputMode="decimal" style={{ ...INPUT, width: 110 }} />
              </>
            )}
            <button onClick={openPreview} style={{ background: "#4A7FFF", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Preview…</button>
          </div>
        </div>
      )}

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {pageItems.map((p) => {
          const onSpecial = !!specials[p.id];
          const sel = selected.has(p.id);
          return (
            <div key={p.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, opacity: onSpecial ? 0.55 : 1, background: sel ? "rgba(74,127,255,.08)" : "rgba(255,255,255,.03)", border: "1px solid " + (sel ? "rgba(74,127,255,.4)" : "rgba(255,255,255,.07)") }}>
              <input type="checkbox" checked={sel} disabled={onSpecial} onChange={() => toggleSelect(p.id)}
                aria-label={`Select ${p.name || p.id}`}
                style={{ width: 16, height: 16, accentColor: "#4A7FFF", cursor: onSpecial ? "default" : "pointer", flexShrink: 0 }} />
              {p.photoUrl
                ? <img src={p.photoUrl} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", background: "rgba(255,255,255,.08)", flexShrink: 0 }} />
                : <div style={{ width: 40, height: 40, borderRadius: 8, background: "rgba(255,255,255,.08)", flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                  {typeOf(p)} · SKU {p.sku || "—"}{onSpecial ? " · ON SPECIAL — end the special to reprice" : ""}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                <div style={{ color: "rgba(255,255,255,.55)" }}>Stock {fmt(typeof p.stockPrice === "number" && p.stockPrice > 0 ? p.stockPrice : null)}</div>
                <div style={{ color: "#fff", fontWeight: 700 }}>Retail {fmt(typeof p.retailPrice === "number" && p.retailPrice > 0 ? p.retailPrice : null)}</div>
              </div>
            </div>
          );
        })}
        {pageItems.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: "rgba(255,255,255,.4)", fontSize: 13 }}>No products match.</div>}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 14 }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={BTN(false)}>← Prev</button>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Page {page} of {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={BTN(false)}>Next →</button>
        </div>
      )}

      {/* History — every batch, restorable by id in one action */}
      <div style={{ marginTop: 26 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", marginBottom: 8 }}>Price change history</div>
        {history === null && <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)" }}>Loading…</div>}
        {history?.error && <div style={{ fontSize: 12, color: "#FF8A8A" }}>History unavailable: {history.error}</div>}
        {Array.isArray(history) && history.length === 0 && <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)" }}>No price batches yet.</div>}
        {Array.isArray(history) && history.map((h) => (
          <div key={h.batchId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 9, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", marginBottom: 5 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ACTION_LABEL[h.action] || h.action} · {h.label || "—"}
              </div>
              <div style={{ fontSize: 10.5, color: "rgba(255,255,255,.4)", marginTop: 1 }}>
                {h.count} product{h.count === 1 ? "" : "s"} · {h.at ? new Date(h.at).toLocaleString() : "—"} · {h.byEmail || h.by || "—"}
                {h.restoredAt ? ` · RESTORED ${new Date(h.restoredAt).toLocaleString()}` : ""}
              </div>
            </div>
            {!h.restoredAt && h.action !== "special_start" && h.action !== "special_end" && (
              <button onClick={() => openRestore(h.batchId)} disabled={busy}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, color: "#fff", padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                Restore
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Preview modal */}
      {previewOpen && (
        <BulkPricePreview
          title={mode === "percent" ? `Apply ${percentDraft.trim()}% to ${plan?.count ?? 0} products` : "Set prices"}
          plan={plan?.ok ? plan : null}
          busy={busy}
          confirmLabel="Apply"
          onConfirm={applyPlan}
          onCancel={() => setPreviewOpen(false)}
        />
      )}

      {/* Restore confirm — shows drift honestly before writing */}
      {restoreCandidate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }} onClick={busy ? undefined : () => setRestoreCandidate(null)}>
          <div style={{ background: "#111", border: "1px solid rgba(255,255,255,.15)", borderRadius: 14, padding: 18, maxWidth: 500, width: "100%", maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Restore batch</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginTop: 4 }}>
              {restoreCandidate.record.label || restoreCandidate.batchId} — returns {restoreCandidate.record.count} product{restoreCandidate.record.count === 1 ? "" : "s"} to the exact prices they held before the batch.
            </div>
            {restoreCandidate.drift.length > 0 && (
              <div style={{ background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.3)", borderRadius: 9, padding: "8px 10px", fontSize: 11.5, color: "#FBBF24", marginTop: 10 }}>
                {restoreCandidate.drift.length} value{restoreCandidate.drift.length === 1 ? " was" : "s were"} edited again after this batch — restoring overwrites those edits too:
                <div style={{ marginTop: 5, color: "rgba(255,255,255,.75)" }}>
                  {restoreCandidate.drift.slice(0, 8).map((d, i) => (
                    <div key={i}>{d.name || d.pid} · {d.field === "stockPrice" ? "stock" : "retail"} is {fmt(d.current)}, batch set {fmt(d.expected)}</div>
                  ))}
                  {restoreCandidate.drift.length > 8 && <div>+{restoreCandidate.drift.length - 8} more</div>}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setRestoreCandidate(null)} disabled={busy} style={{ flex: 1, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10, padding: "11px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>Cancel</button>
              <button onClick={doRestore} disabled={busy} style={{ flex: 1, background: "#4A7FFF", border: "1px solid #4A7FFF", borderRadius: 10, padding: "11px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer" }}>{busy ? "Restoring…" : "Restore"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

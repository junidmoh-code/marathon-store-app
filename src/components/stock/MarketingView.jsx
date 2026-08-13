// ─── MARKETING ────────────────────────────────────────────────────────────────
// The picked-products workspace: two fixed tabs, Marketing and Display.
//
// Products get INTO these lists from the Attention grid (the ✚ on a tile).
// Reviewing them lives here — and since this card is where slow movers are
// lined up for advertising and PRICE DROPS, pricing lives here too:
//
//   · every tile shows its stock + retail price (and an ON SPECIAL badge);
//   · ✎ on a tile edits that one product's prices (guarded single_edit batch);
//   · tick several tiles → the bulk bar reprices the selection by ONE signed
//     percentage or fixed values — same preview, same audited batch, same
//     one-tap Undo as the admin Pricing tab. On-special products can't be
//     ticked (end the special first); the store refuses them anyway.
//
// Adding to the lists is deliberately not offered here: you pick from the
// Attention grid where you can see the stock, the photo and the numbers.
//
// MOBILE: the grid guarantees at least two tiles side by side on a phone —
// columns are min(196px, 42vw) wide, images square (aspect-ratio, not a fixed
// height), paddings tightened. Desktop keeps the familiar ~196px tiles.

import React, { useEffect, useMemo, useState } from "react";
import { onValue, ref } from "firebase/database";
import { database } from "../../firebase";
import { LISTS, resolveListProducts } from "./attentionLists";
import { useAttentionLists } from "./useAttentionLists";
import { FONT, GLASS, GRAY, RED, AMBER, BLUE_L } from "./ui";
import { applyPriceBatch, restorePriceBatch } from "../admin/priceStore";
import { buildBulkChangePlan } from "../../utils/bulkPricing";
import { asStoredPrice } from "../../utils/priceBatch";
import BulkPricePreview from "../admin/BulkPricePreview";

const count = (n) => new Intl.NumberFormat("en-ZA").format(n || 0);
const fmt = (v) => (typeof v === "number" ? `R${v.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "—");

const INPUT = { background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 8, color: "#fff", padding: "8px 10px", fontSize: 12, fontFamily: FONT };
const BTN = (on) => ({ background: on ? "#4A7FFF" : "rgba(255,255,255,.06)", border: "1px solid " + (on ? "#4A7FFF" : "rgba(255,255,255,.15)"), borderRadius: 8, color: on ? "#fff" : "rgba(255,255,255,.65)", padding: "8px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT });

export default function MarketingView({ products, onExit }) {
  const [openListId, setOpenListId] = useState(LISTS[0].id);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { lists, removeFromList, ready } = useAttentionLists();

  // ── Pricing state ──
  // null = first snapshot not in yet (nothing tickable during that window)
  const [specials, setSpecials] = useState(null);
  const [guardDown, setGuardDown] = useState(false);
  const [specialsSubGen, setSpecialsSubGen] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [mode, setMode] = useState("percent");
  const [percentDraft, setPercentDraft] = useState("");
  const [stockDraft, setStockDraft] = useState("");
  const [retailDraft, setRetailDraft] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [priceBusy, setPriceBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind, text }
  const [lastBatch, setLastBatch] = useState(null); // { batchId, count } → Undo
  const [editTarget, setEditTarget] = useState(null); // product being edited one-by-one

  // LIVE subscription, not a one-shot: /specials is a compact purpose-built
  // node (~9 KB at 20 active specials), so holding it open is cheap — and it
  // means a special started on another device drops its tile out of the
  // selection here within moments. A read error (missing rule) flips the
  // standing guardDown banner; Retry re-arms the subscription.
  useEffect(() => onValue(
    ref(database, "specials"),
    (snap) => { setSpecials(snap.val() || {}); setGuardDown(false); },
    () => { setSpecials({}); setGuardDown(true); },
  ), [specialsSubGen]);
  const reloadSpecials = () => setSpecialsSubGen((g) => g + 1);

  const productsById = useMemo(() => {
    const out = {};
    for (const p of products || []) if (p?.id) out[p.id] = p;
    return out;
  }, [products]);

  const open = lists.find((l) => l.id === openListId) || lists[0];
  const contents = useMemo(() => resolveListProducts(open, productsById), [open, productsById]);

  // Selection only ever holds products that are present and not on special.
  // The /specials subscription above keeps this genuinely live: a special
  // started elsewhere drops its product out of the selection on the next
  // snapshot. Until the FIRST snapshot arrives nothing is tickable — the brief
  // pre-load window must not offer on-special products.
  const selectable = (c) => specials !== null && !c.missing && !specials[c.id];
  const liveSelected = useMemo(() => {
    const ids = new Set(contents.filter((c) => selectable(c)).map((c) => c.id));
    return new Set([...selected].filter((id) => ids.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, contents, specials]);
  const toggleSelect = (id) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const removeItem = async (productId) => {
    setBusy(true); setError(null);
    try { await removeFromList(open.id, productId); }
    catch (err) { console.warn("Marketing: write failed:", err); setError(err?.message || "Could not save."); }
    finally { setBusy(false); }
  };

  // ── Bulk reprice ──
  const planInput = { products: products || [], selectedIds: [...liveSelected], mode, stockDraft, retailDraft, percentDraft, applyToStock: false, applyToRetail: true };
  const plan = useMemo(() => (previewOpen ? buildBulkChangePlan(planInput) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewOpen, products, liveSelected, mode, stockDraft, retailDraft, percentDraft]);

  const openPreview = () => {
    const probe = buildBulkChangePlan(planInput);
    if (!probe.ok) { setNotice({ kind: "err", text: probe.error }); return; }
    setNotice(null);
    setPreviewOpen(true);
  };
  useEffect(() => {
    if (previewOpen && plan && !plan.ok) {
      setPreviewOpen(false);
      setNotice({ kind: "err", text: "The selection changed and the plan is no longer valid: " + plan.error });
    }
  }, [previewOpen, plan]);

  const applyPlan = async () => {
    if (!plan?.ok || priceBusy) return;
    setPriceBusy(true);
    try {
      const res = await applyPriceBatch({
        action: "bulk_change",
        lines: plan.lines,
        label: mode === "percent"
          ? `Marketing price drop ${percentDraft.trim()}% — ${plan.count} products`
          : `Marketing reprice — ${plan.count} products`,
      });
      setPreviewOpen(false);
      if (!res.ok) { setNotice({ kind: "err", text: "Nothing was written: " + res.message }); return; }
      if (res.specialsCheckSkipped) setGuardDown(true);
      setSelected(new Set());
      setPercentDraft(""); setStockDraft(""); setRetailDraft("");
      setLastBatch({ batchId: res.batchId, count: res.count });
      setNotice({ kind: "ok", text: `Repriced ${res.count} product${res.count === 1 ? "" : "s"}.${res.specialsCheckSkipped ? " ⚠ The on-special check could not read /specials for this write." : ""}` });
    } catch (e) {
      setNotice({ kind: "err", text: "Nothing was written: " + (e?.message || e) });
    } finally {
      setPriceBusy(false);
    }
  };

  const undoLastBatch = async () => {
    if (!lastBatch || priceBusy) return;
    setPriceBusy(true);
    try {
      const res = await restorePriceBatch(lastBatch.batchId, productsById);
      if (!res.ok) { setNotice({ kind: "err", text: "Undo failed — nothing was changed: " + res.message }); return; }
      if (res.specialsCheckSkipped) setGuardDown(true);
      setLastBatch(null);
      setNotice({ kind: "ok", text: `Prices restored (${res.count} product${res.count === 1 ? "" : "s"}).` });
    } catch (e) {
      setNotice({ kind: "err", text: "Undo failed — nothing was changed: " + (e?.message || e) });
    } finally {
      setPriceBusy(false);
    }
  };

  return (
    <div style={{ fontFamily: FONT, color: "#fff", padding: "18px 14px 44px", maxWidth: 1640, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onExit}
          style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.25)", color: BLUE_L, borderRadius: 10, padding: "9px 13px", fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: FONT }}>
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-.01em" }}>Marketing</div>
          <div style={{ fontSize: 12.5, color: GRAY, marginTop: 2 }}>{open?.blurb} · picked from Attention · tick to reprice</div>
        </div>
      </div>

      {/* Both tabs are always present, whether or not anything is in them —
          they're fixed destinations, not folders that come and go. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {lists.map((l) => {
          const on = l.id === open?.id;
          return (
            <button
              key={l.id}
              onClick={() => { setOpenListId(l.id); setSelected(new Set()); }}
              aria-pressed={on}
              style={{
                ...GLASS, fontFamily: FONT, cursor: "pointer", textAlign: "left", padding: "11px 18px", minWidth: 148,
                border: on ? "1px solid rgba(74,127,255,.55)" : "1px solid rgba(255,255,255,.08)",
                background: on ? "rgba(74,127,255,.13)" : GLASS.background,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 800, color: on ? "#fff" : "#cfd8ee" }}>
                {l.label} <span style={{ color: on ? BLUE_L : GRAY, fontWeight: 700 }}>{count(l.count)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: on ? BLUE_L : GRAY, marginTop: 3 }}>{l.blurb}</div>
            </button>
          );
        })}
      </div>

      {guardDown && (
        <div style={{ ...GLASS, padding: "9px 12px", marginBottom: 12, fontSize: 12, color: AMBER, display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ flex: 1 }}>⚠ The on-special guard cannot read /specials — products on special are NOT marked here.</span>
          <button onClick={reloadSpecials} style={BTN(false)}>Retry</button>
        </div>
      )}
      {error && <div style={{ ...GLASS, padding: "10px 12px", color: RED, fontSize: 12, marginBottom: 12 }}>{error}</div>}
      {notice && (
        <div style={{ ...GLASS, padding: "9px 12px", marginBottom: 12, fontSize: 12, color: notice.kind === "ok" ? "#4ACA7A" : RED, display: "flex", gap: 10 }}>
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message" style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", fontFamily: FONT }}>✕</button>
        </div>
      )}
      {lastBatch && (
        <div style={{ ...GLASS, padding: "9px 12px", marginBottom: 12, fontSize: 12, color: "#4ACA7A", display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ flex: 1 }}>Prices changed on {lastBatch.count} product{lastBatch.count === 1 ? "" : "s"} — still undoable.</span>
          <button onClick={undoLastBatch} disabled={priceBusy} style={BTN(false)}>{priceBusy ? "Undoing…" : "Undo"}</button>
          <button onClick={() => setLastBatch(null)} aria-label="Dismiss undo" style={{ background: "none", border: "none", color: GRAY, cursor: "pointer", fontFamily: FONT }}>✕</button>
        </div>
      )}

      {/* Bulk bar — appears once anything is ticked */}
      {liveSelected.size > 0 && (
        <div style={{ ...GLASS, border: "1px solid rgba(74,127,255,.4)", padding: 10, marginBottom: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L }}>{liveSelected.size} ticked</span>
          <button onClick={() => setMode("percent")} style={BTN(mode === "percent")}>% change</button>
          <button onClick={() => setMode("absolute")} style={BTN(mode === "absolute")}>Set price</button>
          {mode === "percent"
            ? <input value={percentDraft} onChange={(e) => setPercentDraft(e.target.value)} placeholder="% e.g. -20" aria-label="Percentage change" inputMode="decimal" style={{ ...INPUT, width: 92 }} />
            : <>
                <input value={stockDraft} onChange={(e) => setStockDraft(e.target.value)} placeholder="Stock (R)" aria-label="New stock price" inputMode="decimal" style={{ ...INPUT, width: 90 }} />
                <input value={retailDraft} onChange={(e) => setRetailDraft(e.target.value)} placeholder="Retail (R)" aria-label="New retail price" inputMode="decimal" style={{ ...INPUT, width: 90 }} />
              </>}
          <button onClick={openPreview} style={{ ...BTN(true), border: "none" }}>Preview…</button>
          <button onClick={() => setSelected(new Set())} style={{ background: "none", border: "none", color: GRAY, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>Clear</button>
        </div>
      )}

      {!ready ? (
        <Empty>Loading…</Empty>
      ) : contents.length === 0 ? (
        <Empty>
          Nothing in {open?.label} yet — pick products with the ✚ on any card in Attention.
        </Empty>
      ) : (
        // min(196px, 42vw): phones always fit at least TWO tiles side by side;
        // desktop keeps ~196px tiles. Images are square by aspect ratio so
        // narrow tiles stay proportioned instead of towering.
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(196px, 42vw), 1fr))", gap: 10, alignItems: "start" }}>
          {contents.map((c) => {
            const onSpecial = !!(specials || {})[c.id];
            const sel = liveSelected.has(c.id);
            const retail = c.product ? asStoredPrice(c.product.retailPrice) : null;
            const stock = c.product ? asStoredPrice(c.product.stockPrice) : null;
            return (
              <div key={c.id} style={{ ...GLASS, overflow: "hidden", border: sel ? "1px solid rgba(74,127,255,.65)" : GLASS.border || "1px solid rgba(255,255,255,.08)" }}>
                <div style={{ aspectRatio: "1 / 1", background: "rgba(255,255,255,.03)", position: "relative" }}>
                  {c.photo ? (
                    <img src={c.photo} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,.16)", fontSize: 32, fontWeight: 800 }}>
                      {(c.name || "?").trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                  {selectable(c) && (
                    <input type="checkbox" checked={sel} onChange={() => toggleSelect(c.id)}
                      aria-label={`Select ${c.name}`}
                      style={{ position: "absolute", top: 7, left: 7, width: 20, height: 20, accentColor: "#4A7FFF", cursor: "pointer" }} />
                  )}
                  {onSpecial && (
                    <div style={{ position: "absolute", bottom: 7, left: 7, background: "rgba(74,202,122,.9)", color: "#063", fontSize: 9.5, fontWeight: 800, borderRadius: 6, padding: "2px 7px" }}>
                      ON SPECIAL
                    </div>
                  )}
                  <button
                    onClick={() => removeItem(c.id)}
                    disabled={busy}
                    title={`Remove from ${open.label}`}
                    style={{ position: "absolute", top: 7, right: 7, width: 27, height: 27, borderRadius: 8, cursor: busy ? "default" : "pointer", fontFamily: FONT, fontSize: 13, fontWeight: 800, background: "rgba(0,0,0,.72)", border: "1px solid rgba(255,255,255,.28)", color: "#fff", backdropFilter: "blur(6px)" }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ padding: "8px 10px 10px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.3, height: "2.6em", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {c.missing ? "Removed from catalogue" : c.name}
                  </div>
                  {c.missing
                    ? <div style={{ fontSize: 10, color: AMBER, marginTop: 4 }}>{c.id}</div>
                    : (
                      <>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 5 }}>
                          <span style={{ fontSize: 14, fontWeight: 800, color: retail !== null ? "#fff" : AMBER }}>
                            {retail !== null ? fmt(retail) : "No price"}
                          </span>
                          <span style={{ fontSize: 10.5, color: GRAY }}>stock {fmt(stock)}</span>
                        </div>
                        <button onClick={() => setEditTarget(c.product)}
                          style={{ marginTop: 7, width: "100%", background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.13)", borderRadius: 8, color: "rgba(255,255,255,.8)", padding: "6px 0", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>
                          ✎ Edit price
                        </button>
                      </>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk preview — the operator confirms EXACTLY this plan or nothing */}
      {previewOpen && (
        <BulkPricePreview
          title={mode === "percent" ? `Apply ${percentDraft.trim()}% to ${plan?.count ?? 0} products` : "Set prices"}
          plan={plan?.ok ? plan : null}
          busy={priceBusy}
          confirmLabel="Apply"
          onConfirm={applyPlan}
          onCancel={() => setPreviewOpen(false)}
        />
      )}

      {/* One-by-one edit — same guarded single_edit path as everywhere else */}
      {editTarget && (
        <PriceEditModal
          product={editTarget}
          getCurrent={() => productsById[editTarget.id] || editTarget}
          onSpecial={!!(specials || {})[editTarget.id]}
          onClose={() => setEditTarget(null)}
          onSaved={(msg, skipped) => {
            setEditTarget(null);
            // The fail-open bypass is never silent — the per-tile edit reports
            // it exactly like the bulk paths do (Sonnet review, PR #360).
            if (skipped) setGuardDown(true);
            setNotice({ kind: "ok", text: msg + (skipped ? " ⚠ The on-special check could not read /specials for this write." : "") });
          }}
        />
      )}
    </div>
  );
}

// Small one-product price modal: shows current values, writes only what
// changed, through the guarded batch path (audited; on-special retail edits
// are refused by the store with its own message).
function PriceEditModal({ product, getCurrent, onSpecial, onClose, onSaved }) {
  const [stockDraft, setStockDraft] = useState(asStoredPrice(product.stockPrice) !== null ? String(asStoredPrice(product.stockPrice)) : "");
  const [retailDraft, setRetailDraft] = useState(asStoredPrice(product.retailPrice) !== null ? String(asStoredPrice(product.retailPrice)) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const save = async () => {
    if (saving) return;
    // Compare against the LIVE record, not the snapshot captured when the
    // modal opened — a price changed elsewhere while it sat open must not
    // produce a stale audit `from` or a phantom no-op (Kimi review, PR #360).
    const live = getCurrent ? getCurrent() : product;
    const from = {};
    const to = {};
    for (const [field, draft] of [["stockPrice", stockDraft], ["retailPrice", retailDraft]]) {
      const cur = asStoredPrice(live[field]);
      const t = String(draft).trim();
      const next = t === "" ? null : Number(t);
      if (next !== null && (!Number.isFinite(next) || next <= 0)) { setErr(`${field === "stockPrice" ? "Stock" : "Retail"} price must be a number above 0 (or empty to clear).`); return; }
      if (next === cur) continue;
      from[field] = cur;
      to[field] = next;
    }
    if (Object.keys(to).length === 0) { onClose(); return; }
    setSaving(true);
    setErr(null);
    try {
      const res = await applyPriceBatch({
        action: "single_edit",
        label: `Marketing edit: ${product.name || product.id}`,
        lines: { [product.id]: { name: product.name || "", from, to } },
      });
      if (!res.ok) { setErr(res.message); return; }
      onSaved(`Saved ${product.name || product.id}.`, res.specialsCheckSkipped === true);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }}
      onClick={saving ? undefined : onClose}
      onKeyDown={(e) => { if (e.key === "Escape" && !saving) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Edit price — ${product.name || product.id}`}
        style={{ background: "#111", border: "1px solid rgba(255,255,255,.15)", borderRadius: 14, padding: 18, maxWidth: 360, width: "100%", fontFamily: FONT }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          {product.photoUrl
            ? <img src={product.photoUrl} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", background: "rgba(255,255,255,.08)", flexShrink: 0 }} />
            : <div style={{ width: 44, height: 44, borderRadius: 8, background: "rgba(255,255,255,.08)", flexShrink: 0 }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{product.name}</div>
            {onSpecial && <div style={{ fontSize: 10.5, color: "#4ACA7A", fontWeight: 700, marginTop: 2 }}>ON SPECIAL — retail is the special price; end the special to change the normal price.</div>}
          </div>
        </div>
        <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,.45)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Stock price (R)</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={stockDraft} onChange={(e) => setStockDraft(e.target.value)} disabled={saving}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} aria-label="Stock price"
          style={{ ...INPUT, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,.45)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Retail price (R)</label>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={retailDraft} onChange={(e) => setRetailDraft(e.target.value)} disabled={saving}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} aria-label="Retail price"
          style={{ ...INPUT, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        {err && <div style={{ fontSize: 11.5, color: RED, marginBottom: 10, overflowWrap: "anywhere" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: FONT }}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{ flex: 1, background: "#4A7FFF", border: "1px solid #4A7FFF", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: FONT }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ ...GLASS, padding: "48px 20px", textAlign: "center", color: GRAY, fontSize: 13.5 }}>{children}</div>;
}

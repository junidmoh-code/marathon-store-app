// ─── CONCRETE PRODUCTS — TEMPORARY marking card (Junid, 20 Nov 2026) ─────────
// TEMPORARY. Removed with ONE flag: src/config/temporaryCards.js
// CONCRETE_PRODUCTS_CARD (the home tile and the #concrete-products route both
// read it). It replaces Product Admin's Brand Check tab while Junid splits the
// Concrete brand off the catalogue.
//
// Every CLOTHING product — the existing taxonomy decides: nothing in the
// footwear group (missingProductsCore.inFootwearGroup, the engine's own Health
// predicate) or with a footwear catalogue key (footwearLine.productIsFootwear),
// no perfume, no price records, no merged-away records — with its photo on the
// row, its name, and one Concrete on/off switch.
//
// /products is already in memory on every screen (useProducts, the offline-
// mirrored subscription), so search and filters cost nothing on the wire. What
// is PAGED is the rendering: 50 rows at a time, more as Junid scrolls (and a
// "Show more" button), so a phone never mounts 4,000 tiles; every thumbnail is
// the shared ProductPhoto (PrimaryPhoto: the mirrored 300px thumb, loading
// "lazy").
//
// THE SWITCH saves instantly and optimistically through the ONE helper
// (concreteStore.markConcreteProduct → src/utils/concreteListing.js). The row
// flips the moment it is tapped; a failed save flips it back and says why in
// red (never silent). A small toast offers Undo for a few seconds.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { productMatchesQuery } from "../../utils/productSearch";
import { topCategory, isPriceRecord } from "../../utils/productCategory";
import { effectiveCategoryKey, labelForKey, TAXONOMY_SEED } from "../../utils/productTaxonomy";
import { productIsFootwear } from "../../utils/footwearLine";
import { isConcreteProduct, needsBrandCheck } from "../../utils/concreteListing";
import { inFootwearGroup, isPerfume } from "../stock/missingProductsCore";
import { markConcreteProduct, confirmBrand, restoreMarathonListing } from "./concreteStore";
import { ConcreteSwitch } from "./AllProductsList";

export const CARD_PAGE = 50;
export const UNDO_MS = 6000;
const NO_SUB = "Unassigned";

/** PURE: is this a clothing product for the card? */
export function isCardClothing(p) {
  if (!p || !p.id || p.mergedInto) return false;
  if (isPriceRecord(p) || isPerfume(p)) return false;
  if (inFootwearGroup(p) || productIsFootwear(p)) return false;
  return true;
}

/** PURE: the subcategory label a row is filtered by. */
export function subcategoryOf(p, registry = TAXONOMY_SEED) {
  const key = effectiveCategoryKey(p);
  if (key) return labelForKey(registry, key) || key;
  return (typeof p?.subcategory === "string" && p.subcategory.trim()) || NO_SUB;
}

/**
 * PURE: the card's list, newest first. `overrides` = { pid: boolean } — the
 * optimistic state of switches tapped but not yet echoed back.
 */
export function cardList(products, { q = "", category = "all", sub = "all", mode = "all", overrides = {}, registry = TAXONOMY_SEED } = {}) {
  const query = q.trim();
  const on = (p) => (p.id in overrides ? overrides[p.id] : isConcreteProduct(p));
  return (products || [])
    .filter(isCardClothing)
    .filter((p) => category === "all" || topCategory(p) === category)
    .filter((p) => sub === "all" || subcategoryOf(p, registry) === sub)
    .filter((p) => mode === "all" || (mode === "on" ? on(p) : !on(p)))
    .filter((p) => !query || productMatchesQuery(p, query))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const chip = (sel) => ({
  background: sel ? "#E5E5E5" : "rgba(255,255,255,.05)", color: sel ? "#000" : "rgba(255,255,255,.65)",
  border: "1px solid " + (sel ? "#E5E5E5" : "rgba(255,255,255,.1)"), borderRadius: 999, padding: "6px 12px",
  fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
});

export default function ConcreteProductsCard({ products = [], ProductPhoto = null, registry = TAXONOMY_SEED, liveOnConcrete = null, onExit }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [sub, setSub] = useState("all");
  const [mode, setMode] = useState("all");
  const [shown, setShown] = useState(CARD_PAGE);
  const [overrides, setOverrides] = useState({});   // pid → on (optimistic, until the echo)
  const [busy, setBusy] = useState({});             // pid → true while saving
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);         // { pid, name, on }
  const toastTimer = useRef(null);
  const sentinel = useRef(null);

  const clothing = useMemo(() => (products || []).filter(isCardClothing), [products]);
  const cats = useMemo(() => ["all", ...[...new Set(clothing.map(topCategory))].sort()], [clothing]);
  const subs = useMemo(() => {
    const pool = category === "all" ? clothing : clothing.filter((p) => topCategory(p) === category);
    return ["all", ...[...new Set(pool.map((p) => subcategoryOf(p, registry)))].sort()];
  }, [clothing, category, registry]);
  const list = useMemo(() => cardList(clothing, { q, category, sub, mode, overrides, registry }), [clothing, q, category, sub, mode, overrides, registry]);
  const page = list.slice(0, shown);
  const onCount = useMemo(() => clothing.filter((p) => (p.id in overrides ? overrides[p.id] : isConcreteProduct(p))).length, [clothing, overrides]);

  // Drop an override once the subscription echoes the same value back.
  useEffect(() => {
    setOverrides((o) => {
      let changed = false;
      const n = { ...o };
      for (const p of products || []) if (p?.id in n && isConcreteProduct(p) === n[p.id]) { delete n[p.id]; changed = true; }
      return changed ? n : o;
    });
  }, [products]);

  // Paged loading: the next page mounts as the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setShown((n) => n + CARD_PAGE); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [list.length, shown]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const resetPage = () => setShown(CARD_PAGE);

  const flip = async (p, next, { fromUndo = false } = {}) => {
    if (busy[p.id]) return;
    setErr(null);
    setOverrides((o) => ({ ...o, [p.id]: next }));
    setBusy((b) => ({ ...b, [p.id]: true }));
    const r = await markConcreteProduct(p.id, next, { liveOnConcrete });
    setBusy((b) => { const n = { ...b }; delete n[p.id]; return n; });
    if (!r.ok) {
      setOverrides((o) => { const n = { ...o }; delete n[p.id]; return n; });
      setErr(`${p.name || p.id}: not saved — ${r.message}`);
      return;
    }
    clearTimeout(toastTimer.current);
    if (fromUndo) {
      setToast(null);
      // Undoing a mark: put back a Marathon listing the mark already took off.
      if (!next) { const back = await restoreMarathonListing(p.id); if (!back.ok) setErr(`${p.name || p.id}: back on Marathon, but its Marathon listing was not switched back on (${back.message}).`); }
      return;
    }
    setToast({ pid: p.id, name: p.name || p.id, on: next, product: p });
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  };
  const confirm = async (p) => {
    setBusy((b) => ({ ...b, [p.id]: true }));
    const r = await confirmBrand(p, true, { liveOnConcrete });
    setBusy((b) => { const n = { ...b }; delete n[p.id]; return n; });
    if (!r.ok) setErr(`${p.name || p.id}: brand not confirmed — ${r.message}`);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0B0B0B", color: "#fff", paddingBottom: 90 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 5, background: "#0B0B0B", padding: "14px 14px 8px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onExit && <button onClick={onExit} style={{ ...chip(false), padding: "6px 10px" }}>← Home</button>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: ".04em" }}>CONCRETE PRODUCTS</div>
            <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>Temporary · switch ON = Concrete-only (sold on the Concrete website only)</div>
          </div>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.55)", whiteSpace: "nowrap" }}>{onCount} on</span>
        </div>
        <input value={q} onChange={(e) => { setQ(e.target.value); resetPage(); }} placeholder="Search name, code, barcode…" aria-label="Search"
          style={{ width: "100%", boxSizing: "border-box", marginTop: 10, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", borderRadius: 10, padding: "10px 12px", fontSize: 14 }} />
        <div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto" }}>
          {[["all", "All"], ["on", "On"], ["off", "Off"]].map(([k, l]) => (
            <button key={k} style={chip(mode === k)} onClick={() => { setMode(k); resetPage(); }}>{l}</button>
          ))}
          <span style={{ width: 1, background: "rgba(255,255,255,.12)", margin: "0 2px" }} />
          {cats.map((c) => <button key={c} style={chip(category === c)} onClick={() => { setCategory(c); setSub("all"); resetPage(); }}>{c === "all" ? "Every category" : c}</button>)}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, overflowX: "auto" }}>
          {subs.map((s) => <button key={s} style={chip(sub === s)} onClick={() => { setSub(s); resetPage(); }}>{s === "all" ? "Every subcategory" : s}</button>)}
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.4)", marginTop: 6 }}>{list.length} product{list.length === 1 ? "" : "s"}</div>
        {err && <div role="alert" style={{ fontSize: 12.5, color: "#F87171", marginTop: 6, lineHeight: 1.4 }}>{err}</div>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px" }}>
        {page.map((p) => {
          const on = p.id in overrides ? overrides[p.id] : isConcreteProduct(p);
          const unconfirmed = on && isConcreteProduct(p) && needsBrandCheck(p, p.id);
          return (
            <div key={p.id} data-pid={p.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: 12, background: on ? "rgba(229,229,229,.07)" : "rgba(255,255,255,.025)", border: "1px solid " + (on ? "rgba(229,229,229,.25)" : "rgba(255,255,255,.06)") }}>
              {ProductPhoto ? <ProductPhoto product={p} productId={p.id} size={56} /> : null}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{p.name || p.id}</div>
                <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>{topCategory(p)} · {subcategoryOf(p, registry)}</div>
                {unconfirmed && (
                  <button onClick={() => confirm(p)} disabled={!!busy[p.id]}
                    style={{ marginTop: 4, background: "none", border: "none", padding: "4px 0", color: "#FBBF24", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                    Brand not confirmed yet — tap to confirm
                  </button>
                )}
              </div>
              <ConcreteSwitch on={on} disabled={!!busy[p.id]} onChange={(next) => flip(p, next)} />
            </div>
          );
        })}
        {shown < list.length && (
          <button ref={sentinel} onClick={() => setShown((n) => n + CARD_PAGE)} style={{ ...chip(false), alignSelf: "center", padding: "10px 20px", marginTop: 6 }}>
            Show more ({list.length - shown} left)
          </button>
        )}
        {!list.length && <div style={{ color: "rgba(255,255,255,.45)", fontSize: 13, padding: 20, textAlign: "center" }}>Nothing matches.</div>}
      </div>

      {toast && (
        <div role="status" style={{ position: "fixed", left: 12, right: 12, bottom: 16, zIndex: 20, display: "flex", alignItems: "center", gap: 10, background: "#1C1C1C", border: "1px solid rgba(255,255,255,.18)", borderRadius: 12, padding: "10px 12px", boxShadow: "0 8px 30px rgba(0,0,0,.5)" }}>
          <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.35 }}>
            <b>{toast.name}</b> {toast.on ? "is now Concrete-only." : "is back on Marathon."}
          </span>
          <button onClick={() => flip(toast.product, !toast.on, { fromUndo: true })} style={{ ...chip(true), padding: "6px 12px" }}>Undo</button>
        </div>
      )}
    </div>
  );
}

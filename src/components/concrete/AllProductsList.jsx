// ─── PRODUCT ADMIN → ALL PRODUCTS (the Concrete marking list) ─────────────────
// Every product, searchable and filterable by category, with a Concrete toggle
// per row and multi-select bulk "Add to Concrete" / "Remove from Concrete".
// Since 20 Nov 2026 "Concrete" means CONCRETE-ONLY (concreteListing.js).
//
// /products is already in memory on every screen (useProducts — the offline-
// mirrored subscription), so filtering here costs nothing on the wire. What is
// PAGED is the rendering: 60 rows at a time with "Show more", so a phone never
// mounts 4,000 photo tiles; each tile is the shared ProductPhoto (the 300px
// mirrored thumb) and only the rows on screen exist at all.
//
// Writes go through concreteStore → src/utils/concreteListing.js only.
import React, { useMemo, useState } from "react";
import { productMatchesQuery } from "../../utils/productSearch";
import { topCategory, TOP_CATEGORIES, UNCATEGORIZED_TOP } from "../../utils/productCategory";
import { isOnConcrete } from "../../utils/concreteListing";
import { markProducts } from "./concreteStore";

export const PAGE = 60;

/** PURE: the filtered list, newest first. */
export function filterProducts(products, { q = "", category = "all", concrete = "all" } = {}) {
  const query = q.trim();
  return (products || [])
    .filter((p) => p && p.id)
    .filter((p) => category === "all" || topCategory(p) === category)
    .filter((p) => concrete === "all" || (concrete === "on" ? isOnConcrete(p) : !isOnConcrete(p)))
    .filter((p) => !query || productMatchesQuery(p, query))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const chip = (on) => ({
  background: on ? "#4A7FFF" : "rgba(255,255,255,.05)", color: on ? "#fff" : "rgba(255,255,255,.65)",
  border: "1px solid " + (on ? "#4A7FFF" : "rgba(255,255,255,.1)"), borderRadius: 999, padding: "6px 12px",
  fontSize: 12, fontWeight: 700, cursor: "pointer",
});

export function ConcreteSwitch({ on, onChange, disabled }) {
  // minHeight 36: a switch that takes a product off Marathon is a real tap target.
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      title={on ? "Concrete-only — tap to return it to Marathon" : "Marathon — tap to make it Concrete-only"}
      style={{ display: "flex", alignItems: "center", gap: 6, background: on ? "rgba(214,214,214,.16)" : "transparent",
               border: "1px solid " + (on ? "rgba(230,230,230,.6)" : "rgba(255,255,255,.14)"), color: on ? "#fff" : "rgba(255,255,255,.45)",
               borderRadius: 999, padding: "5px 12px", minHeight: 36, fontSize: 11, fontWeight: 800, letterSpacing: ".06em", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: on ? "#E5E5E5" : "rgba(255,255,255,.2)" }} />
      CONCRETE
    </button>
  );
}

export default function AllProductsList({ products, ProductPhoto, canVerify, liveOnConcrete }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [concrete, setConcrete] = useState("all");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { on, ids }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const list = useMemo(() => filterProducts(products, { q, category, concrete }), [products, q, category, concrete]);
  const page = list.slice(0, shown);
  const cats = useMemo(() => ["all", ...TOP_CATEGORIES, UNCATEGORIZED_TOP], []);

  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const run = async (ids, on) => {
    if (!canVerify) return;
    setBusy(true); setMsg(null);
    const r = await markProducts(ids, on, { verify: canVerify, liveOnConcrete });
    setBusy(false); setConfirm(null);
    if (r.ok) { setSelected(new Set()); setMsg({ ok: true, text: `${r.count} product${r.count === 1 ? "" : "s"} ${on ? "made Concrete-only" : "returned to Marathon"}.` }); }
    else setMsg({ ok: false, text: `${r.count ? `${r.count} saved, then: ` : ""}${r.message}` });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 14px" }}>
      <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search name, code, barcode…"
        style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)", color: "#fff", borderRadius: 10, padding: "10px 12px", fontSize: 14 }} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {cats.map((c) => <button key={c} style={chip(category === c)} onClick={() => { setCategory(c); setShown(PAGE); }}>{c === "all" ? "All" : c}</button>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {[["all", "Everything"], ["on", "Concrete-only"], ["off", "Marathon"]].map(([k, l]) =>
          <button key={k} style={chip(concrete === k)} onClick={() => { setConcrete(k); setShown(PAGE); }}>{l}</button>)}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "rgba(255,255,255,.5)", alignSelf: "center" }}>{list.length} products</span>
      </div>

      {/* Marking takes a product off marathonclub.co.za now (Concrete-only), so
          only Junid / a stockRole admin may (Sonnet review, PR #952 B2). */}
      {!canVerify && <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>Only Junid or an admin can change which products are Concrete-only.</div>}
      {selected.size > 0 && canVerify && (
        <div style={{ position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 3, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: "#111", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12, padding: 10 }}>
          <b style={{ fontSize: 13 }}>{selected.size} selected</b>
          <button disabled={busy} onClick={() => setConfirm({ on: true, ids: [...selected] })} style={{ ...chip(true), background: "#E5E5E5", color: "#000", borderColor: "#E5E5E5" }}>Add to Concrete</button>
          <button disabled={busy} onClick={() => setConfirm({ on: false, ids: [...selected] })} style={chip(false)}>Remove from Concrete</button>
          <button onClick={() => setSelected(new Set(page.map((p) => p.id)))} style={chip(false)}>Select shown</button>
          <button onClick={() => setSelected(new Set())} style={chip(false)}>Clear</button>
        </div>
      )}
      {msg && <div style={{ fontSize: 13, color: msg.ok ? "#4ADE80" : "#F87171" }}>{msg.text}</div>}

      {page.map((p) => {
        const on = isOnConcrete(p);
        const sel = selected.has(p.id);
        return (
          <div key={p.id} onClick={() => toggleSel(p.id)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: 12, cursor: "pointer",
                     background: sel ? "rgba(74,127,255,.12)" : "rgba(255,255,255,.025)", border: "1px solid " + (sel ? "rgba(74,127,255,.5)" : "rgba(255,255,255,.06)") }}>
            <input type="checkbox" readOnly checked={sel} style={{ width: 18, height: 18 }} />
            {ProductPhoto ? <ProductPhoto product={p} productId={p.id} size={48} /> : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name || p.id}</div>
              <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>{topCategory(p)}{p.brand ? ` · ${p.brand}` : ""}</div>
            </div>
            <ConcreteSwitch on={on} disabled={busy || !canVerify} onChange={(next) => run([p.id], next)} />
          </div>
        );
      })}
      {shown < list.length && (
        <button onClick={() => setShown((n) => n + PAGE)} style={{ ...chip(false), alignSelf: "center", padding: "10px 20px" }}>
          Show more ({list.length - shown} left)
        </button>
      )}

      {confirm && (
        <div role="dialog" onClick={() => !busy && setConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#141414", border: "1px solid rgba(255,255,255,.15)", borderRadius: 16, padding: 20, maxWidth: 380, width: "100%" }}>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>
              {confirm.on ? "Add" : "Remove"} {confirm.ids.length} product{confirm.ids.length === 1 ? "" : "s"} {confirm.on ? "to" : "from"} Concrete?
            </div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,.6)", marginBottom: 16 }}>
              {confirm.on
                ? "They become Concrete-only: they come off marathonclub.co.za (within a couple of minutes, in trading hours) and appear in the Concrete publishing tab, ready to publish. Missing Products lists them under Concrete."
                : "They go back to Marathon. Any that are live on the Concrete store are switched off there. Marathon does not republish them by itself — publish them from the Marathon tab."}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button disabled={busy} onClick={() => setConfirm(null)} style={chip(false)}>Cancel</button>
              <button disabled={busy} onClick={() => run(confirm.ids, confirm.on)} style={{ ...chip(true), background: "#E5E5E5", color: "#000", borderColor: "#E5E5E5" }}>
                {busy ? "Saving…" : `Yes, ${confirm.on ? "add" : "remove"} ${confirm.ids.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

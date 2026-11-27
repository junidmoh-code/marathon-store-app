// ─── PRODUCT ADMIN → BRAND CHECK ─────────────────────────────────────────────
// Every product created since Concrete shipped, and every product whose
// Concrete mark was flipped, that no human has brand-checked yet — newest
// first. One tap confirms what it is (Concrete on or off); flipping the chip
// first then confirming is ONE write. Junid or a stockRole admin only: the
// AdminView hides the tab from anyone else and this component refuses too.
import React, { useMemo, useState } from "react";
import { isOnConcrete, needsBrandCheck } from "../../utils/concreteListing";
import { confirmBrand } from "./concreteStore";
import { ConcreteSwitch } from "./AllProductsList";

/** PURE: the queue, newest first. */
export function brandCheckQueue(products) {
  return (products || []).filter((p) => p?.id && needsBrandCheck(p, p.id))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function useBrandCheckCount(products, enabled) {
  return useMemo(() => (enabled ? brandCheckQueue(products).length : 0), [products, enabled]);
}

export default function BrandCheckTab({ products, ProductPhoto, canVerify, liveOnConcrete }) {
  const queue = useMemo(() => brandCheckQueue(products), [products]);
  const [draft, setDraft] = useState({}); // pid → on (a flip not yet confirmed)
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [shown, setShown] = useState(40);

  if (!canVerify) return <div style={{ padding: 20, color: "rgba(255,255,255,.6)" }}>Brand Check is for Junid or a stock admin.</div>;
  if (!queue.length) return <div style={{ padding: 20, color: "#4ADE80", fontWeight: 700 }}>Nothing to check — every new product is confirmed.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 14px" }}>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.55)" }}>{queue.length} waiting. Check the photo and name, set Concrete on or off, then Confirm.</div>
      {err && <div style={{ color: "#F87171", fontSize: 13 }}>{err}</div>}
      {queue.slice(0, shown).map((p) => {
        const on = draft[p.id] ?? isOnConcrete(p);
        return (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: 12, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)" }}>
            {ProductPhoto ? <ProductPhoto product={p} productId={p.id} size={64} /> : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{p.name || p.id}</div>
              <div style={{ fontSize: 11.5, color: "rgba(255,255,255,.45)" }}>{p.brand || "no brand"}{p.category ? ` · ${p.category}` : ""}</div>
            </div>
            <ConcreteSwitch on={on} disabled={busy === p.id} onChange={(next) => setDraft((d) => ({ ...d, [p.id]: next }))} />
            <button disabled={busy === p.id} onClick={async () => {
              setBusy(p.id); setErr(null);
              const r = await confirmBrand(p, on, { liveOnConcrete });
              setBusy(null);
              if (!r.ok) setErr(`${p.name}: ${r.message}`);
            }} style={{ background: "#4A7FFF", color: "#fff", border: 0, borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
              {busy === p.id ? "…" : "Confirm"}
            </button>
          </div>
        );
      })}
      {shown < queue.length && <button onClick={() => setShown((n) => n + 40)} style={{ alignSelf: "center", background: "transparent", color: "#9DBCFF", border: "1px solid rgba(255,255,255,.15)", borderRadius: 999, padding: "8px 18px" }}>Show more</button>}
    </div>
  );
}

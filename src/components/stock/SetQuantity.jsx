// ─── SET QUANTITY ─────────────────────────────────────────────────────────────
// Admin direct on-hand entry, product-first: pick a product, pick a location, see
// every size's CURRENT on-hand, and type the target quantity per size. On commit,
// each changed size becomes an `adjustment` movement (delta = target − current) via
// applyMovement — the system's ONE writer to /stock — so the number set here is the
// exact same /stock/{loc}/{pid}/{size}/qty the Locator, Count, POS and barcode card
// read and write. There is no second counter: entry, overview and detail can never
// disagree because they share this one path and this one writer.
//
// Every change is logged to the immutable /stock_movements ledger (who/when/product/
// size/old→new via the before/after fields applyMovement records), so on-hand is
// fully auditable. Admin-only — the `adjustment` movement type also requires
// stockRole==admin at the security-rule layer.

import React, { useState, useMemo } from "react";
import { applyMovement } from "./applyMovement";
import { useStockCells } from "./useStock";
import { transferTargets } from "./locations";
import { Card, Field, ProductPicker, LocationPicker, NumberInput, TextInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, RED, BLUE_L, bGreen } from "./ui";

export default function SetQuantity({ products, registry, actorRole, isAdmin }) {
  const [productId, setProductId] = useState("");
  const [loc, setLoc] = useState("warehouse1");   // primary receiving warehouse by default
  const [targets, setTargets] = useState({});      // { size: "n" }
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];

  // SAME live read as Locator / Count — the single source of truth for on-hand.
  const cells = useStockCells(loc || undefined);   // { pid: { size: cell } } for this loc
  const curQty = (size) => {
    const c = loc ? cells?.[productId]?.[size] : null;
    return c && typeof c.qty === "number" ? c.qty : 0;
  };

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3000); };

  // Rows the admin actually changed (target differs from current on-hand).
  const pendingChanges = useMemo(() => {
    if (!product || !loc) return [];
    return sizes
      .map(s => {
        const raw = targets[s];
        if (raw == null || String(raw).trim() === "") return null;       // untouched → skip
        if (!/^\d+$/.test(String(raw).trim())) return { size: s, bad: true };
        const target = parseInt(raw, 10);
        const cur = curQty(s);
        return { size: s, cur, target, delta: target - cur };
      })
      .filter(Boolean)
      .filter(r => r.bad || r.delta !== 0);
  }, [sizes, targets, product, loc, cells]);

  const commit = async () => {
    if (!product || !loc) return flash("err", "Pick a product and a location.");
    const bad = pendingChanges.find(r => r.bad);
    if (bad) return flash("err", `Quantity for size ${bad.size} must be a whole number (0 or more).`);
    if (!pendingChanges.length) return flash("err", "Nothing changed — enter a new on-hand for at least one size.");
    if (!reason.trim()) return flash("err", "A reason is required (e.g. stock-take, correction).");

    setBusy(true);
    let ok = 0, fail = 0; const failed = [];
    for (const { size, delta } of pendingChanges) {
      // delta>0 credits this location, delta<0 debits it — applyMovement takes a
      // positive magnitude + a side. before/after old→new is recorded by the writer.
      const res = await applyMovement({
        type: "adjustment",
        productId: product.id, size, qty: Math.abs(delta),
        to: delta > 0 ? loc : null,
        from: delta < 0 ? loc : null,
        reason: reason.trim(),
        cellState: "live",
        actorRole,
      });
      if (res.ok) ok++;
      else { fail++; failed.push(`${size}: ${res.reason === "insufficient_stock" ? `only ${res.available} on hand` : res.reason}`); }
    }
    setBusy(false);
    if (!fail) { setTargets({}); setReason(""); flash("ok", `Set ${ok} size${ok > 1 ? "s" : ""} — on-hand updated`); }
    else flash("err", `${ok} set, ${fail} failed — ${failed.join("; ")}`);
  };

  if (!isAdmin) return <Empty>Setting on-hand quantity is admin-only. Ask an admin to correct a count.</Empty>;

  return (
    <div>
      <Card>
        <Field label="Product">
          <ProductPicker products={products} value={productId} onChange={(v) => { setProductId(v); setTargets({}); }} />
        </Field>
        <Field label="Location">
          <LocationPicker registry={registry} value={loc} onChange={(v) => { setLoc(v); setTargets({}); }} filter={transferTargets} />
        </Field>
      </Card>

      {!product || !loc ? (
        <Empty>Pick a product and a location to set on-hand quantity per size.</Empty>
      ) : sizes.length === 0 ? (
        <Empty>This product has no sizes configured. Add sizes to the product first.</Empty>
      ) : (
        <Card>
          <div style={{ fontSize: 11, color: GRAY, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>
            On-hand quantity per size
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(82px, 1fr))", gap: 8 }}>
            {sizes.map(s => {
              const cur = curQty(s);
              const raw = targets[s];
              const touched = raw != null && String(raw).trim() !== "" && /^\d+$/.test(String(raw).trim());
              const delta = touched ? parseInt(raw, 10) - cur : 0;
              return (
                <div key={s}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 2, textAlign: "center" }}>{s}</div>
                  <div style={{ fontSize: 9, color: GRAY, textAlign: "center", marginBottom: 2 }}>now {cur}</div>
                  <NumberInput value={raw ?? ""} onChange={(v) => setTargets(t => ({ ...t, [s]: v }))} placeholder="set to" />
                  <div style={{ fontSize: 9, textAlign: "center", marginTop: 2, height: 12,
                    color: !touched || delta === 0 ? "transparent" : delta > 0 ? GREEN : RED }}>
                    {delta > 0 ? `+${delta}` : delta}
                  </div>
                </div>
              );
            })}
          </div>

          <Field label="Reason (required)">
            <TextInput value={reason} onChange={setReason} placeholder="stock-take / correction / found / damaged …" />
          </Field>

          <button onClick={commit} disabled={busy || !pendingChanges.length} style={{ ...bGreen, width: "100%", marginTop: 6, opacity: (busy || !pendingChanges.length) ? 0.55 : 1 }}>
            {busy ? "Saving…" : pendingChanges.length ? `Set ${pendingChanges.length} change${pendingChanges.length > 1 ? "s" : ""}` : "Enter a new on-hand"}
          </button>

          <div style={{ fontSize: 11, color: GRAY, marginTop: 8 }}>
            “now” = current on-hand at this location (the one source of truth). Each change is recorded as an
            auditable <span style={{ color: BLUE_L }}>adjustment</span> with old→new and your reason.
          </div>
        </Card>
      )}

      <Toast msg={toast} />
    </div>
  );
}

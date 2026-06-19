// ─── SET QUANTITY (location-aware) ────────────────────────────────────────────
// Admin per-location on-hand entry, product-first: pick a product, pick a LOCATION,
// see each size's CURRENT on-hand at THAT location, and type the new count. Each
// changed size writes the one /stock/{loc}/{productId}/{size} cell via applyMovement
// — the system's ONE writer — so the number set here is the exact same cell the
// Locator, Count, POS and barcode card read and write. Setting a count touches only
// the chosen location; the same product+size holds independent counts at every other
// location. Entry, overview and detail can never disagree: one path, one writer.
//
// The chip chooses how the change is recorded (and the movement type):
//   • Received        → `received`   (additive — a stock receipt)
//   • Opening balance → `opening`    (additive — one-time opening count)
//   • Stock-take      → `adjustment` (signed — reconcile to a counted value)
//   • Correction      → `adjustment` (signed — fix an error, up or down)
// Received/Opening may only INCREASE a count; if the entered value is lower we warn
// and ask the admin to switch to Correction rather than silently relabel. Every
// write carries delta + before/after old→new + the chip as the reason, to the
// immutable /stock_movements ledger. Admin-only (the rule layer also gates these
// types by stockRole).

import React, { useState, useMemo } from "react";
import { applyMovement } from "./applyMovement";
import { useStockCells } from "./useStock";
import { transferTargets, RECEIVING_DEFAULT } from "./locations";
import { Card, Field, ProductPicker, LocationPicker, NumberInput, TextInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, RED, BLUE_L, bGreen, bGhost, tabOn, tabOff } from "./ui";
import BarcodePrint from "./BarcodePrint";

// The chip IS the movement type + the ledger reason. `additive` types may only
// raise a count (a receipt/opening can't reduce stock).
const INTENTS = [
  { key: "received",   label: "Received",        type: "received",   reason: "received",        additive: true  },
  { key: "opening",    label: "Opening balance", type: "opening",    reason: "opening balance", additive: true  },
  { key: "stocktake",  label: "Stock-take",      type: "adjustment", reason: "stock-take",      additive: false, adminOnly: true },
  { key: "correction", label: "Correction",      type: "adjustment", reason: "correction",      additive: false, adminOnly: true },
];

export default function SetQuantity({ products, registry, actorRole, isAdmin, canStock = isAdmin }) {
  const [productId, setProductId] = useState("");
  const [loc, setLoc] = useState(RECEIVING_DEFAULT);
  const [targets, setTargets] = useState({});      // { size: "n" }
  const [intentKey, setIntentKey] = useState("received");
  const [note, setNote] = useState("");            // optional detail appended to the chip reason
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastSaved, setLastSaved] = useState(null); // { productId, productName, items:[{size,added}] }
  const [printOpen, setPrintOpen] = useState(false);

  // Adjustment intents (Stock-take/Correction) are admin-only — the rule layer
  // permits `adjustment` for stockRole==admin only. Warehouse keeps Received/Opening.
  const intents = INTENTS.filter(i => isAdmin || !i.adminOnly);
  const intent = intents.find(i => i.key === intentKey) || intents[0];
  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const sizes = (product && Array.isArray(product.sizes)) ? product.sizes : [];

  // SAME live read as Locator / Count — the single source of truth for on-hand,
  // scoped to the chosen location only.
  const cells = useStockCells(loc || undefined);   // { pid: { size: cell } } for this loc
  const curQty = (size) => {
    const c = loc ? cells?.[productId]?.[size] : null;
    return c && typeof c.qty === "number" ? c.qty : 0;
  };

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3600); };

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
    if (!pendingChanges.length) return flash("err", "Nothing changed — enter a new count for at least one size.");

    // Received/Opening may only increase a count. Don't relabel a decrease — warn
    // and let the admin switch to Correction.
    if (intent.additive) {
      const dec = pendingChanges.find(r => r.delta < 0);
      if (dec) return flash("err", `${intent.label} can't reduce stock (size ${dec.size}: ${dec.cur}→${dec.target}). Switch to Correction to lower a count.`);
    }

    const effReason = note.trim() ? `${intent.reason} — ${note.trim()}` : intent.reason;

    setBusy(true);
    let ok = 0, fail = 0; const failed = []; const savedItems = [];
    try {
      for (const { size, delta } of pendingChanges) {
        // Additive (received/opening): always credit `to`; delta>0 is guaranteed by
        // the guard above. Adjustment: delta>0 credits `to`, delta<0 debits `from`.
        // applyMovement takes a positive magnitude + a side and records before/after.
        // Per-size try/catch: applyMovement returns {ok:false} for handled failures,
        // but its pre-write reads can reject (permission/network) — a throw on one
        // size must not abort the rest or strand the busy state.
        try {
          const res = await applyMovement({
            type: intent.type,
            productId: product.id, size, qty: Math.abs(delta),
            to: (intent.additive || delta > 0) ? loc : null,
            from: (!intent.additive && delta < 0) ? loc : null,
            reason: effReason,
            cellState: "live",
            actorRole,
          });
          if (res.ok) { ok++; savedItems.push({ size, added: Math.max(0, delta) }); }
          else { fail++; failed.push(`${size}: ${res.reason === "insufficient_stock" ? `only ${res.available} on hand` : res.reason}`); }
        } catch (err) {
          fail++; failed.push(`${size}: ${String(err?.message || err)}`);
        }
      }
    } finally {
      setBusy(false);   // always reset, even if the loop throws unexpectedly
    }
    // Offer barcode printing for the sizes that saved (count defaults to units added).
    if (savedItems.length) setLastSaved({ productId: product.id, productName: product.name, items: savedItems });
    if (!fail) { setTargets({}); setNote(""); flash("ok", `${intent.label}: ${ok} size${ok > 1 ? "s" : ""} updated — print barcodes below`); }
    else flash("err", `${ok} done, ${fail} failed — ${failed.join("; ")}`);
  };

  if (!canStock) return <Empty>Setting on-hand quantity needs a stock role (warehouse or admin).</Empty>;

  return (
    <div>
      <Card>
        <Field label="Product">
          <ProductPicker products={products} value={productId} onChange={(v) => { setProductId(v); setTargets({}); setLastSaved(null); }} />
        </Field>
        <Field label="Location">
          <LocationPicker registry={registry} value={loc} onChange={(v) => { setLoc(v); setTargets({}); }} filter={transferTargets} />
        </Field>
      </Card>

      {!product || !loc ? (
        <Empty>Pick a product and a location to set on-hand quantity per size. Each location keeps its own count.</Empty>
      ) : sizes.length === 0 ? (
        <Empty>This product has no sizes configured. Add sizes to the product first.</Empty>
      ) : (
        <Card>
          <Field label="How is this change recorded?">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {intents.map(i => (
                <button key={i.key} type="button" onClick={() => setIntentKey(i.key)} style={intentKey === i.key ? tabOn : tabOff}>
                  {i.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: GRAY, marginTop: 5 }}>
              {intent.additive
                ? `Logged as “${intent.reason}” — adds to the current count (can't reduce it).`
                : `Logged as “${intent.reason}” — sets the count to the entered value (up or down).`}
            </div>
          </Field>

          <div style={{ fontSize: 11, color: GRAY, margin: "10px 0 8px", textTransform: "uppercase", letterSpacing: ".04em" }}>
            New count per size
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(82px, 1fr))", gap: 8 }}>
            {sizes.map(s => {
              const cur = curQty(s);
              const raw = targets[s];
              const touched = raw != null && String(raw).trim() !== "" && /^\d+$/.test(String(raw).trim());
              const delta = touched ? parseInt(raw, 10) - cur : 0;
              const badDir = touched && intent.additive && delta < 0;   // receipt/opening can't reduce
              return (
                <div key={s}>
                  <div style={{ fontSize: 12, color: "#fff", marginBottom: 2, textAlign: "center" }}>{s}</div>
                  <div style={{ fontSize: 9, color: GRAY, textAlign: "center", marginBottom: 2 }}>now {cur}</div>
                  <NumberInput value={raw ?? ""} onChange={(v) => setTargets(t => ({ ...t, [s]: v }))} placeholder="set to" />
                  <div style={{ fontSize: 9, textAlign: "center", marginTop: 2, height: 12,
                    color: !touched || delta === 0 ? "transparent" : badDir ? RED : delta > 0 ? GREEN : RED }}>
                    {badDir ? "can't reduce" : delta > 0 ? `+${delta}` : delta}
                  </div>
                </div>
              );
            })}
          </div>

          <Field label="Note (optional)">
            <TextInput value={note} onChange={setNote} placeholder="PO #, found in back, damaged …" />
          </Field>

          <button onClick={commit} disabled={busy || !pendingChanges.length} style={{ ...bGreen, width: "100%", marginTop: 6, opacity: (busy || !pendingChanges.length) ? 0.55 : 1 }}>
            {busy ? "Saving…" : pendingChanges.length ? `${intent.label} — ${pendingChanges.length} size${pendingChanges.length > 1 ? "s" : ""}` : "Enter a new count"}
          </button>

          <div style={{ fontSize: 11, color: GRAY, marginTop: 8 }}>
            “now” = current on-hand at this location only (the one source of truth). Each change is recorded with
            old→new and the reason as a <span style={{ color: BLUE_L }}>{intent.type}</span> movement.
          </div>

          {lastSaved && product && lastSaved.productId === product.id && (
            <button onClick={() => setPrintOpen(true)} style={{ ...bGhost, width: "100%", marginTop: 10 }}>
              🏷️ Print barcodes — {lastSaved.items.length} size{lastSaved.items.length > 1 ? "s" : ""} just saved
            </button>
          )}
        </Card>
      )}

      {printOpen && lastSaved && (
        <BarcodePrint
          product={{ id: lastSaved.productId, name: lastSaved.productName }}
          items={lastSaved.items}
          onClose={() => setPrintOpen(false)}
        />
      )}

      <Toast msg={toast} />
    </div>
  );
}

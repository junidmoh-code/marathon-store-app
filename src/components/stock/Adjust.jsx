// ─── ADJUST ───────────────────────────────────────────────────────────────────
// Manual signed correction with a MANDATORY reason. Admin-only (the security rule
// also enforces stockRole==admin for `adjustment` movements). A positive qty credits
// the location; a negative qty debits it. Every adjustment is a ledger entry — there
// is no silent counter edit anywhere in the system.

import React, { useState, useMemo } from "react";
import { applyMovement } from "./applyMovement";
import { useStockCells } from "./useStock";
import { labelFor } from "./locations";
import { Card, Field, SizePicker, LocationPicker, NumberInput, TextInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, RED, BLUE_L, BORDER, CARD, bGreen, input } from "./ui";

function Thumb({ url }) {
  if (url) return <img src={url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }}
    style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 7, flexShrink: 0 }} />;
  return <div style={{ width: 32, height: 32, borderRadius: 7, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>👟</div>;
}

export default function Adjust({ products, registry, actorRole, isAdmin }) {
  const [loc, setLoc] = useState("");
  const [productId, setProductId] = useState("");
  const [size, setSize] = useState("");
  const [delta, setDelta] = useState("");        // signed: e.g. "-2" or "3"
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2600); };

  // Live on-hand at the chosen location for the chosen product+size, so the adjustment
  // starts from what's actually there.
  const cells = useStockCells(loc || undefined);   // { pid: { size: cell } } for this loc
  const curQty = useMemo(() => {
    if (!loc || !product || !size) return null;
    const c = cells?.[product.id]?.[size];
    return c && typeof c.qty === "number" ? c.qty : 0;
  }, [cells, loc, product, size]);
  const deltaN = /^-?\d+$/.test(String(delta).trim()) ? parseInt(delta, 10) : null;

  // Search products by name OR any code (barcode / sku / per-size); capped for speed.
  const matches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const codeMatch = (p) => {
      if (!/\d/.test(term)) return false;
      const codes = [];
      if (p.barcode != null) codes.push(String(p.barcode));
      if (p.sku != null) codes.push(String(p.sku));
      if (p.barcodes && typeof p.barcodes === "object") for (const c of Object.values(p.barcodes)) if (c != null) codes.push(String(c));
      return codes.some(c => c === term || (term.length >= 3 && c.toLowerCase().includes(term)));
    };
    return [...(products || [])]
      .filter(p => p && p.id && p.name && (p.name.toLowerCase().includes(term) || codeMatch(p)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }, [products, q]);

  if (!isAdmin) return <Empty>Adjustments are admin-only. Ask an admin to correct a count.</Empty>;

  const submit = async () => {
    if (!loc || !product || !size) return flash("err", "Pick location, product and size.");
    if (!/^-?\d+$/.test(String(delta).trim())) return flash("err", "Enter a whole number (e.g. -2 or 3).");
    const n = parseInt(delta, 10);
    if (n === 0) return flash("err", "Enter a non-zero adjustment.");
    if (!reason.trim()) return flash("err", "A reason is required for every adjustment.");
    setBusy(true);
    // Positive → credit `to`; negative → debit `from`. applyMovement takes a positive
    // magnitude + a side, so we map the sign onto from/to here.
    const res = await applyMovement({
      type: "adjustment",
      productId: product.id, size, qty: Math.abs(n),
      to: n > 0 ? loc : null,
      from: n < 0 ? loc : null,
      reason: reason.trim(),
      actorRole,
    });
    setBusy(false);
    if (res.ok) { setDelta(""); setReason(""); flash("ok", `Adjusted ${n > 0 ? "+" : ""}${n}`); }
    else flash("err", res.reason === "insufficient_stock" ? `Only ${res.available} on hand` : `Failed: ${res.reason}`);
  };

  return (
    <div>
      <Card>
        <Field label="Location"><LocationPicker registry={registry} value={loc} onChange={setLoc} /></Field>
        <Field label="Product">
          {product ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: CARD, border: BORDER, borderRadius: 9, padding: "7px 10px" }}>
              <Thumb url={product.photoUrl} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.name}</div>
              <button onClick={() => { setProductId(""); setSize(""); setQ(""); }}
                style={{ background: "transparent", border: "1px solid rgba(60,110,255,.3)", borderRadius: 8, padding: "5px 10px", color: BLUE_L, fontSize: 11.5, cursor: "pointer" }}>Change</button>
            </div>
          ) : (
            <>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search product or barcode…"
                style={{ ...input, width: "100%", boxSizing: "border-box" }} />
              {q.trim() && (
                <div style={{ marginTop: 6, maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                  {matches.length === 0 ? (
                    <div style={{ fontSize: 12, color: GRAY, padding: "6px 2px" }}>No products match “{q.trim()}”.</div>
                  ) : matches.map(p => (
                    <button key={p.id} onClick={() => { setProductId(p.id); setSize(""); setQ(""); }}
                      style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", background: CARD, border: BORDER, borderRadius: 9, padding: "6px 9px", cursor: "pointer" }}>
                      <Thumb url={p.photoUrl} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                        {p.category && <div style={{ fontSize: 10, color: GRAY }}>{p.category}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>
        <Field label="Size"><SizePicker product={product} value={size} onChange={setSize} /></Field>

        {/* Current availability at this location for the chosen size. */}
        {curQty != null && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: CARD, border: BORDER, borderRadius: 9, padding: "9px 11px", margin: "2px 0 10px" }}>
            <span style={{ fontSize: 12, color: GRAY }}>On hand at <b style={{ color: BLUE_L }}>{labelFor(loc, registry)}</b> · size <b style={{ color: "#fff" }}>{size}</b></span>
            <span style={{ fontSize: 18, fontWeight: 800, color: curQty < 0 ? RED : GREEN }}>{curQty}</span>
          </div>
        )}

        <Field label="Adjustment (signed)"><NumberInput value={delta} onChange={setDelta} min={undefined} placeholder="e.g. -2 or 3" /></Field>

        {/* Preview the resulting on-hand so the adjustment is made from the availability. */}
        {curQty != null && deltaN != null && deltaN !== 0 && (
          <div style={{ fontSize: 12, color: GRAY, margin: "-2px 0 8px" }}>
            {curQty} {deltaN > 0 ? "+" : "−"} {Math.abs(deltaN)} → <b style={{ color: (curQty + deltaN) < 0 ? RED : GREEN }}>{curQty + deltaN}</b> on hand
            {(curQty + deltaN) < 0 && <span style={{ color: RED }}> · can't go below 0</span>}
          </div>
        )}
        <Field label="Reason (required)"><TextInput value={reason} onChange={setReason} placeholder="miscount / damaged / found / …" /></Field>
        <button onClick={submit} disabled={busy} style={{ ...bGreen, width: "100%", marginTop: 6, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Adjusting…" : "Apply adjustment"}
        </button>
        <div style={{ fontSize: 11, color: GRAY, marginTop: 8 }}>
          Recorded as a signed <b>adjustment</b> movement with your reason — fully auditable.
        </div>
      </Card>
      <Toast msg={toast} />
    </div>
  );
}

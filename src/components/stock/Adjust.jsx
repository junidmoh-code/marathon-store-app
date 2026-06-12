// ─── ADJUST ───────────────────────────────────────────────────────────────────
// Manual signed correction with a MANDATORY reason. Admin-only (the security rule
// also enforces stockRole==admin for `adjustment` movements). A positive qty credits
// the location; a negative qty debits it. Every adjustment is a ledger entry — there
// is no silent counter edit anywhere in the system.

import React, { useState, useMemo } from "react";
import { applyMovement } from "./applyMovement";
import { Card, Field, ProductPicker, SizePicker, LocationPicker, NumberInput, TextInput, Toast, Empty } from "./widgets";
import { GRAY, bGreen } from "./ui";

export default function Adjust({ products, registry, actorRole, isAdmin }) {
  const [loc, setLoc] = useState("");
  const [productId, setProductId] = useState("");
  const [size, setSize] = useState("");
  const [delta, setDelta] = useState("");        // signed: e.g. "-2" or "3"
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === productId), [products, productId]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2600); };

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
        <Field label="Product"><ProductPicker products={products} value={productId} onChange={(v) => { setProductId(v); setSize(""); }} /></Field>
        <Field label="Size"><SizePicker product={product} value={size} onChange={setSize} /></Field>
        <Field label="Adjustment (signed)"><NumberInput value={delta} onChange={setDelta} min={undefined} placeholder="e.g. -2 or 3" /></Field>
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

// ─── TRANSFER ─────────────────────────────────────────────────────────────────
// Deliberate transfers (any location → any location — flexible topology) plus
// fulfilment of Source refill requests. Each leg is an atomic movement through the
// real in_transit holding (stock never invisible):
//   Dispatch  → transfer_out  (from → in_transit)   per line, shares one transferId
//   Receive   → transfer_in   (in_transit → dest)   per line; a received≠dispatched
//               count is recorded as a signed `adjustment` (reason transfer_discrepancy),
//               never silently absorbed.
// A transfer carrying a refillId marks that Source refill request fulfilled on receive.

import React, { useState, useMemo } from "react";
import { ref, update, push, child } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { useTransfers, useRefillRequests } from "./useStock";
import { transferTargets, labelFor, IN_TRANSIT } from "./locations";
import { Card, Field, ProductPicker, SizePicker, LocationPicker, NumberInput, Toast, Empty } from "./widgets";
import { GRAY, GREEN, AMBER, BLUE_L, RED, BORDER, bGreen, bGhost, tabOn, tabOff } from "./ui";

export default function Transfer({ products, registry, actorRole }) {
  const [mode, setMode] = useState("dispatch");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["dispatch", "Dispatch"], ["receive", "Receive"], ["refill", "Refill requests"]].map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} style={mode === k ? tabOn : tabOff}>{l}</button>
        ))}
      </div>
      {mode === "dispatch" && <Dispatch products={products} registry={registry} actorRole={actorRole} />}
      {mode === "receive"  && <Receive  products={products} registry={registry} actorRole={actorRole} />}
      {mode === "refill"   && <RefillList products={products} registry={registry} onPick={() => setMode("dispatch")} />}
    </div>
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
function Dispatch({ products, registry, actorRole, prefill }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(prefill?.to || "");
  const [refillId, setRefillId] = useState(prefill?.refillId || null);
  const [lines, setLines] = useState(prefill?.lines || []);
  const [pid, setPid] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const product = useMemo(() => products.find(p => p.id === pid), [products, pid]);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2800); };

  const addLine = () => {
    const n = parseInt(qty, 10);
    if (!product || !size || !Number.isFinite(n) || n <= 0) return flash("err", "Pick product, size and a positive quantity.");
    setLines(ls => [...ls, { productId: product.id, productName: product.name, size, qty: n }]);
    setSize(""); setQty("");
  };

  const dispatch = async () => {
    if (!from || !to) return flash("err", "Pick a from and to location.");
    if (from === to) return flash("err", "From and to must differ.");
    if (!lines.length) return flash("err", "Add at least one line.");
    setBusy(true);
    const transferId = push(child(ref(database), "transfers")).key;
    let fail = 0;
    for (const ln of lines) {
      const res = await applyMovement({
        type: "transfer_out", productId: ln.productId, size: ln.size, qty: ln.qty,
        from, to: IN_TRANSIT, actorRole, link: { transferId, refillId: refillId || null },
      });
      if (!res.ok) fail++;
    }
    // Record the transfer doc (final destination kept here; in_transit is the leg).
    await update(ref(database), {
      [`transfers/${transferId}`]: {
        status: "dispatched",
        from, to, refillId: refillId || null,
        lines: lines.map(l => ({ productId: l.productId, size: l.size, qtyDispatched: l.qty, qtyReceived: null })),
        createdBy: auth.currentUser?.uid || null,
        createdAt: new Date().toISOString(),
      },
    }).catch(() => { fail++; });
    setBusy(false);
    if (fail) flash("err", `${fail} line(s) failed — check stock at ${labelFor(from, registry)}`);
    else { setLines([]); setRefillId(null); flash("ok", `Dispatched ${lines.length} line(s) → in transit`); }
  };

  return (
    <div>
      <Card>
        <Field label="From"><LocationPicker registry={registry} value={from} onChange={setFrom} filter={transferTargets} exclude={to} /></Field>
        <Field label="To"><LocationPicker registry={registry} value={to} onChange={setTo} filter={transferTargets} exclude={from} /></Field>
        {refillId && <div style={{ fontSize: 11, color: BLUE_L, marginBottom: 8 }}>Fulfilling refill request {refillId.slice(-6)}</div>}
      </Card>

      <Card>
        <div style={{ fontSize: 11, color: GRAY, marginBottom: 8, textTransform: "uppercase", letterSpacing: ".04em" }}>Add line</div>
        <Field label="Product"><ProductPicker products={products} value={pid} onChange={(v) => { setPid(v); setSize(""); }} /></Field>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}><Field label="Size"><SizePicker product={product} value={size} onChange={setSize} /></Field></div>
          <div style={{ width: 90 }}><Field label="Qty"><NumberInput value={qty} onChange={setQty} placeholder="0" /></Field></div>
        </div>
        <button onClick={addLine} style={{ ...bGhost, width: "100%" }}>+ Add line</button>
      </Card>

      {lines.length > 0 && (
        <Card>
          {lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 2px", borderTop: i ? BORDER : "none", fontSize: 13 }}>
              <span style={{ color: "#fff" }}>{l.productName || l.productId} · {l.size}</span>
              <span style={{ display: "flex", gap: 10 }}>
                <span style={{ color: GREEN }}>×{l.qty}</span>
                <span onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} style={{ color: RED, cursor: "pointer" }}>✕</span>
              </span>
            </div>
          ))}
          <button onClick={dispatch} disabled={busy} style={{ ...bGreen, width: "100%", marginTop: 12, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Dispatching…" : `Dispatch ${lines.length} line(s)`}
          </button>
        </Card>
      )}
      <Toast msg={toast} />
    </div>
  );
}

// ── Receive ───────────────────────────────────────────────────────────────────
function Receive({ products, registry, actorRole }) {
  const dispatched = useTransfers("dispatched");
  const [sel, setSel] = useState(null);          // transferId
  const [recv, setRecv] = useState({});          // { lineIdx: "n" }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 2800); };

  const transfer = dispatched.find(t => t.id === sel);
  const nameFor = (pid) => products.find(p => p.id === pid)?.name || pid;

  const confirm = async () => {
    if (!transfer) return;
    setBusy(true);
    let discrepancy = false, fail = 0;
    const updatedLines = [];
    for (let i = 0; i < (transfer.lines || []).length; i++) {
      const ln = transfer.lines[i];
      const received = recv[i] != null && recv[i] !== "" ? parseInt(recv[i], 10) : ln.qtyDispatched;
      if (received > 0) {
        const res = await applyMovement({
          type: "transfer_in", productId: ln.productId, size: ln.size, qty: received,
          from: IN_TRANSIT, to: transfer.to, actorRole, link: { transferId: transfer.id, refillId: transfer.refillId || null },
        });
        if (!res.ok) fail++;
      }
      const diff = ln.qtyDispatched - received;
      if (diff !== 0) {
        discrepancy = true;
        // diff>0 → short: remove the stuck remainder from in_transit. diff<0 → over.
        const res = await applyMovement({
          type: "adjustment", productId: ln.productId, size: ln.size, qty: Math.abs(diff),
          from: diff > 0 ? IN_TRANSIT : null, to: diff < 0 ? IN_TRANSIT : null,
          reason: "transfer_discrepancy", actorRole, link: { transferId: transfer.id },
        });
        if (!res.ok) fail++;
      }
      updatedLines.push({ ...ln, qtyReceived: received });
    }
    await update(ref(database), {
      [`transfers/${transfer.id}/status`]: discrepancy ? "discrepancy" : "received",
      [`transfers/${transfer.id}/lines`]: updatedLines,
      [`transfers/${transfer.id}/receivedBy`]: auth.currentUser?.uid || null,
      [`transfers/${transfer.id}/receivedAt`]: new Date().toISOString(),
    }).catch(() => { fail++; });
    // If this transfer fulfils a refill request, close it.
    if (transfer.refillId) {
      await update(ref(database), {
        [`refill_requests/${transfer.refillId}/status`]: "fulfilled",
        [`refill_requests/${transfer.refillId}/fulfilledBy`]: { transferId: transfer.id },
        [`refill_requests/${transfer.refillId}/resolvedAt`]: new Date().toISOString(),
      }).catch(() => {});
    }
    setBusy(false); setSel(null); setRecv({});
    flash(fail ? "err" : "ok", fail ? `Received with ${fail} error(s)` : discrepancy ? "Received — discrepancy logged" : "Received in full");
  };

  if (!dispatched.length) return <Empty>No transfers in transit to receive.</Empty>;

  return (
    <div>
      {!transfer && dispatched.map(t => (
        <div key={t.id} onClick={() => setSel(t.id)} style={{ cursor: "pointer" }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "#fff" }}>{labelFor(t.from, registry)} → {labelFor(t.to, registry)}</span>
              <span style={{ color: BLUE_L }}>{(t.lines || []).length} line(s) ›</span>
            </div>
            {t.refillId && <div style={{ fontSize: 11, color: BLUE_L, marginTop: 4 }}>refill {String(t.refillId).slice(-6)}</div>}
          </Card>
        </div>
      ))}

      {transfer && (
        <Card>
          <div style={{ fontSize: 13, color: "#fff", marginBottom: 10 }}>{labelFor(transfer.from, registry)} → {labelFor(transfer.to, registry)}</div>
          {(transfer.lines || []).map((ln, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderTop: i ? BORDER : "none" }}>
              <div style={{ fontSize: 13, color: "#fff" }}>{nameFor(ln.productId)} · {ln.size}<div style={{ fontSize: 11, color: GRAY }}>sent {ln.qtyDispatched}</div></div>
              <div style={{ width: 84 }}><NumberInput value={recv[i] ?? String(ln.qtyDispatched)} onChange={(v) => setRecv(r => ({ ...r, [i]: v }))} /></div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { setSel(null); setRecv({}); }} style={{ ...bGhost, flex: 1 }}>Back</button>
            <button onClick={confirm} disabled={busy} style={{ ...bGreen, flex: 2, opacity: busy ? 0.6 : 1 }}>{busy ? "Receiving…" : "Confirm receive"}</button>
          </div>
          <div style={{ fontSize: 11, color: AMBER, marginTop: 8 }}>A received count ≠ dispatched is logged as a discrepancy adjustment.</div>
        </Card>
      )}
      <Toast msg={toast} />
    </div>
  );
}

// ── Refill request list (prefill a dispatch) ──────────────────────────────────
function RefillList({ products, registry, onPick }) {
  const open = useRefillRequests("open");
  const nameFor = (pid) => products.find(p => p.id === pid)?.name || pid;
  if (!open.length) return <Empty>No open refill requests. They are auto-created when a hub sends a pair.</Empty>;
  return (
    <div>
      <div style={{ fontSize: 11, color: GRAY, marginBottom: 8 }}>
        Open requests. Fulfil one by dispatching from any upstream location — it confirms when received.
      </div>
      {open.map(r => (
        <Card key={r.id}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "#fff" }}>{nameFor(r.productId)} · {r.size} ×{r.qty || 1}</span>
            <span style={{ color: GRAY }}>→ {labelFor(r.requestingLocation, registry)}</span>
          </div>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 4 }}>Fulfil via the Dispatch tab (link the request there).</div>
        </Card>
      ))}
    </div>
  );
}

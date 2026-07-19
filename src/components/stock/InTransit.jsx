// ─── IN TRANSIT — receive cross-building transfers (T1: button press) ─────────
// The receiving half of the transit lane (see transitLanes.js). Lists every
// /transfers doc that hasn't fully landed and lets the destination confirm
// receipt: each confirmed line is one atomic `transfer_in` (in_transit → dest)
// through applyMovement, mirrored into the doc's `received` map so a crash or
// retry resumes exactly where it stopped (movement ids are deterministic —
// re-confirming a landed line no-ops).
//
// DOC SHAPE: `lines` and `received` are nested {productId: {sizeKey: qty}} —
// NEVER a flat "pid__sizeKey" string (the one-size "_" sentinel makes flat keys
// unparseable). The manifest is complete before any stock moves (Transfer.jsx
// writes it at doc-create), so everything in in_transit is always explained.
//
// SHORT RECEIVE: the qty box per line defaults to the sent amount; receiving
// less (box came up short) lands what actually arrived and marks the transfer
// `discrepancy` — the shortfall REMAINS in the in_transit cell as the honest
// signal, surfaced here and on the Health dashboard until an admin books the
// resolving adjustment and closes the record. Nothing is ever silently clamped.
//
// STATUS FLOW: dispatched → (crash/partial retry: partially_received) →
// received | discrepancy. QR scan-to-receive (T3) will drive the same receive()
// path — this screen stays as the no-camera fallback.

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { receiveMovementId } from "./transferDraft";
import { useTransfers, useLocations } from "./useStock";
import { labelFor, IN_TRANSIT } from "./locations";
import { decodeSizeKey } from "../../utils/sizeKey";
import { STALE_TRANSIT_HOURS } from "./transitLanes";
import { usePermissions } from "../PermissionsContext";
import { GLASS, GRAY, GREEN, AMBER, RED, BLUE_L, FONT, input, bGreen } from "./ui";
import { Toast, Empty } from "./widgets";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";

const ONE_SIZE = "_";
const sizeText = (sizeKey) => {
  const s = decodeSizeKey(sizeKey);
  return s === ONE_SIZE || s == null || s === "" ? "One size" : s;
};

// Flatten a doc's nested {pid: {sizeKey: qty}} map into renderable rows. The
// row id (`pid/sizeKey`) is UI-local (edit state keys) — never persisted.
function flatLines(nested) {
  const out = [];
  for (const [pid, bySize] of Object.entries(nested || {})) {
    for (const [sizeKey, qty] of Object.entries(bySize || {})) {
      out.push({ rowId: `${pid}/${sizeKey}`, pid, sizeKey, qty: Number(qty) || 0 });
    }
  }
  return out;
}
const receivedQtyOf = (t, row) => t.received?.[row.pid]?.[row.sizeKey];

const STATUS_META = {
  dispatched: { label: "IN TRANSIT", tone: BLUE_L },
  partially_received: { label: "PARTIAL — RETRY", tone: AMBER },
  discrepancy: { label: "SHORT RECEIVED", tone: RED },
};

function ageHours(createdAt) {
  const t = Date.parse(createdAt || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (serverNowMs() - t) / 3600e3);
}

// registry/actorRole come as props when the parent already has them
// (StockView's `shared`); the hooks below are the fallback for bare mounts
// (HealthView drill-in). Hooks always run — unconditionally — the props just
// take precedence, so there's exactly one live formula for each.
export default function InTransit({ products = [], registry: registryProp, actorRole: actorRoleProp }) {
  const transfers = useTransfers();
  const registryHook = useLocations();
  const registry = registryProp || registryHook;
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = actorRoleProp || (isSuperAdmin ? "admin" : (permRecord?.stockRole || null));

  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  // Pending short-receive edits, keyed per transfer then per row: { tId: { rowId: qty } }.
  const [edits, setEdits] = useState({});

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3500); };

  const open = useMemo(
    () => transfers
      .filter((t) => t.status && t.status !== "received")
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    [transfers],
  );

  const setEdit = (tId, rowId, val, max) => {
    const q = Math.max(0, Math.min(Number(val) || 0, max));
    setEdits((e) => ({ ...e, [tId]: { ...(e[tId] || {}), [rowId]: q } }));
  };

  const receive = async (t) => {
    const rows = flatLines(t.lines);
    if (!rows.length) return flash("err", "This transfer has no manifest — ask an admin to check it.");
    setBusyId(t.id);

    const ed = edits[t.id] || {};
    const settled = {};                                  // rowId -> received qty (all passes)
    for (const r of rows) {
      const got = receivedQtyOf(t, r);
      if (got != null) settled[r.rowId] = Number(got) || 0;
    }
    let failed = 0;
    let short = rows.some((r) => settled[r.rowId] != null && settled[r.rowId] < r.qty);

    for (const r of rows) {
      if (settled[r.rowId] != null) continue;            // landed in an earlier pass
      const size = decodeSizeKey(r.sizeKey);             // "_" sentinel passes through untouched
      const want = Math.max(0, Math.min(Number(ed[r.rowId] ?? r.qty), r.qty));
      if (want < r.qty) short = true;

      let ok = true;
      if (want > 0) {
        const res = await applyMovement({
          type: "transfer_in", productId: r.pid, size, qty: want,
          from: IN_TRANSIT, to: t.to, actorRole,
          movementId: receiveMovementId(t.id, r.pid, size), // deterministic → re-confirm no-ops
          link: { transferId: t.id },
        }).catch(() => ({ ok: false }));
        ok = !!res?.ok;
      }
      if (ok) {
        // Record the receipt on the doc BEFORE moving on — this is the resume
        // point; if it fails the row stays unsettled and the retry (idempotent
        // movement) repairs it. The rules make each receipt write-once, so two
        // devices racing the same row can't record different quantities.
        try {
          await update(ref(database), { [`transfers/${t.id}/received/${r.pid}/${r.sizeKey}`]: want });
          settled[r.rowId] = want;
        } catch { failed++; }
      } else failed++;
    }

    const allSettled = rows.every((r) => settled[r.rowId] != null);
    const anySettled = Object.keys(settled).length > 0;
    const status = allSettled ? (short ? "discrepancy" : "received")
      : anySettled ? "partially_received" : t.status || "dispatched";

    const stamp = { [`transfers/${t.id}/status`]: status };
    if (allSettled) {
      stamp[`transfers/${t.id}/receivedAt`] = serverNowIso();
      stamp[`transfers/${t.id}/receivedBy`] = auth.currentUser?.uid || null;
    }
    await update(ref(database), stamp).catch(() => {});

    setBusyId(null);
    if (failed) flash("err", `${failed} line(s) didn't land — tap Receive again to retry the rest.`);
    else if (status === "discrepancy") flash("ok", "Received short — the missing units stay In Transit until an admin resolves them.");
    else flash("ok", `Received into ${labelFor(t.to, registry)} ✓`);
  };

  return (
    <div style={{ fontFamily: FONT }}>
      {open.length === 0 && <Empty>Nothing in transit — cross-building sends from Central appear here until received.</Empty>}

      {open.map((t) => {
        const meta = STATUS_META[t.status] || STATUS_META.dispatched;
        const age = ageHours(t.createdAt);
        // Stale covers partials too — a half-landed transfer past the threshold
        // needs chasing just as much as an untouched one.
        const stale = (t.status === "dispatched" || t.status === "partially_received")
          && age != null && age > STALE_TRANSIT_HOURS;
        const rows = flatLines(t.lines);
        const allSettled = rows.length > 0 && rows.every((r) => receivedQtyOf(t, r) != null);
        const busy = busyId === t.id;

        return (
          <div key={t.id} style={{ ...GLASS, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>
                {labelFor(t.from, registry)} → {labelFor(t.to, registry)}
              </div>
              <span style={{ fontSize: 10.5, fontWeight: 800, color: meta.tone, whiteSpace: "nowrap" }}>{meta.label}</span>
            </div>
            <div style={{ fontSize: 11, color: stale ? AMBER : GRAY, marginBottom: 10 }}>
              {age != null ? (age < 1 ? "Sent under an hour ago" : `Sent ${Math.floor(age)}h ago`) : "Sent —"}
              {stale ? ` · over ${STALE_TRANSIT_HOURS}h in transit — chase it` : ""}
            </div>

            {rows.map((r) => {
              const name = byId.get(r.pid)?.name || r.pid;
              const got = receivedQtyOf(t, r);
              const done = got != null;
              const gotQty = Number(got) || 0;
              return (
                <div key={r.rowId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{sizeText(r.sizeKey)} · sent {r.qty}</div>
                  </div>
                  {done ? (
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: gotQty < r.qty ? RED : GREEN, whiteSpace: "nowrap" }}>
                      {gotQty < r.qty ? `got ${gotQty} of ${r.qty}` : `received ${gotQty} ✓`}
                    </span>
                  ) : (
                    <input
                      type="number" inputMode="numeric" min={0} max={r.qty}
                      value={edits[t.id]?.[r.rowId] ?? r.qty}
                      onChange={(e) => setEdit(t.id, r.rowId, e.target.value, r.qty)}
                      disabled={busy}
                      style={{ ...input, width: 64, textAlign: "center", padding: "7px 6px" }}
                    />
                  )}
                </div>
              );
            })}

            {!allSettled && (
              <button onClick={() => receive(t)} disabled={busy} style={{ ...bGreen, width: "100%", marginTop: 10, opacity: busy ? 0.5 : 1 }}>
                {busy ? "Receiving…" : `Receive into ${labelFor(t.to, registry)}`}
              </button>
            )}
            {allSettled && t.status === "discrepancy" && (
              <div style={{ fontSize: 11, color: RED, marginTop: 8 }}>
                Short-received — the missing units are still in the In Transit holding. Book the correcting
                adjustment first (Stock → Adjust, location In Transit); closing the record here does NOT move stock.
                {actorRole === "admin" && (
                  <button
                    onClick={async () => {
                      // Deliberately labelled as a claim, not a dismissal: the
                      // admin asserts the adjustment is booked. The doc keeps
                      // the received map + this marker as the audit trail.
                      await update(ref(database), {
                        [`transfers/${t.id}/status`]: "received",
                        [`transfers/${t.id}/resolvedShort`]: true,
                        [`transfers/${t.id}/receivedAt`]: serverNowIso(),
                        [`transfers/${t.id}/receivedBy`]: auth.currentUser?.uid || null,
                      }).catch(() => flash("err", "Couldn't close the record — retry."));
                    }}
                    style={{ ...bGreen, display: "block", width: "100%", marginTop: 8, padding: "8px 12px" }}
                  >
                    Adjustment booked — close record (admin)
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <Toast msg={toast} />
    </div>
  );
}

// ─── IN TRANSIT — receive cross-building transfers (T1: button press) ─────────
// The receiving half of the transit lane (see transitLanes.js). Lists every
// /transfers doc that hasn't fully landed and lets the destination confirm
// receipt: each confirmed line is one atomic `transfer_in` (in_transit → dest)
// through applyMovement, mirrored into the doc's `received` map so a crash or
// retry resumes exactly where it stopped (movement ids are deterministic —
// re-confirming a landed line no-ops).
//
// SHORT RECEIVE: the qty box per line defaults to the sent amount; receiving
// less (box came up short) lands what actually arrived and marks the transfer
// `discrepancy` — the shortfall REMAINS in the in_transit cell as the honest
// signal, surfaced here and on the Health dashboard until an admin books the
// resolving adjustment. Nothing is ever silently clamped.
//
// STATUS FLOW: dispatched → (crash/partial retry: partially_received) →
// received | discrepancy. QR scan-to-receive (T3) will drive the same receive()
// path — this screen stays as the no-camera fallback.

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database, auth } from "../../firebase";
import { applyMovement } from "./applyMovement";
import { useTransfers, useLocations } from "./useStock";
import { labelFor, IN_TRANSIT } from "./locations";
import { decodeSizeKey } from "../../utils/sizeKey";
import { STALE_TRANSIT_HOURS } from "./transitLanes";
import { usePermissions } from "../PermissionsContext";
import { GLASS, GRAY, GREEN, AMBER, RED, BLUE_L, FONT, input, bGreen } from "./ui";
import { Toast, Empty } from "./widgets";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";

const ONE_SIZE = "_";

// Doc line keys are `${productId}__${encodedSize}` (Transfer.jsx writes them via
// stockSizeKey). Split on the LAST "__" so a product id can never shear the size.
function parseLineKey(lineKey) {
  const cut = lineKey.lastIndexOf("__");
  if (cut < 0) return null;
  const sizeKey = lineKey.slice(cut + 2);
  return { productId: lineKey.slice(0, cut), sizeKey, size: decodeSizeKey(sizeKey) };
}

const sizeText = (size) => (size === ONE_SIZE || size == null || size === "" ? "One size" : size);

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

export default function InTransit({ products = [] }) {
  const transfers = useTransfers();
  const registry = useLocations();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);

  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  // Pending short-receive edits, keyed per transfer then per line: { tId: { lineKey: qty } }.
  const [edits, setEdits] = useState({});

  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3500); };

  const open = useMemo(
    () => transfers
      .filter((t) => t.status && t.status !== "received")
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    [transfers],
  );

  const setEdit = (tId, lineKey, val, max) => {
    const q = Math.max(0, Math.min(Number(val) || 0, max));
    setEdits((e) => ({ ...e, [tId]: { ...(e[tId] || {}), [lineKey]: q } }));
  };

  const receive = async (t) => {
    const lines = Object.entries(t.lines || {});
    if (!lines.length) return flash("err", "This transfer has no manifest — ask an admin to check it.");
    setBusyId(t.id);

    const already = t.received || {};
    const ed = edits[t.id] || {};
    const settled = { ...already };          // lines done (this pass + earlier passes)
    let failed = 0;
    let short = Object.entries(already).some(([k, q]) => Number(q) < Number(t.lines?.[k] ?? 0));

    for (const [lineKey, sentQtyRaw] of lines) {
      if (settled[lineKey] != null) continue;            // landed in an earlier pass
      const parsed = parseLineKey(lineKey);
      const sentQty = Number(sentQtyRaw) || 0;
      if (!parsed || sentQty <= 0) { failed++; continue; }
      const want = Math.max(0, Math.min(Number(ed[lineKey] ?? sentQty), sentQty));
      if (want < sentQty) short = true;

      let ok = true;
      if (want > 0) {
        const res = await applyMovement({
          type: "transfer_in", productId: parsed.productId, size: parsed.size, qty: want,
          from: IN_TRANSIT, to: t.to, actorRole,
          movementId: `rcv_${t.id}_${lineKey}`,          // deterministic → re-confirm no-ops
          link: { transferId: t.id },
        }).catch(() => ({ ok: false }));
        ok = !!res?.ok;
      }
      if (ok) {
        // Record the receipt on the doc BEFORE moving on — this is the resume
        // point; if it fails the line stays unsettled and the retry (idempotent
        // movement) repairs it.
        try {
          await update(ref(database), { [`transfers/${t.id}/received/${lineKey}`]: want });
          settled[lineKey] = want;
        } catch { failed++; }
      } else failed++;
    }

    const allSettled = lines.every(([k]) => settled[k] != null);
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
        const stale = t.status === "dispatched" && age != null && age > STALE_TRANSIT_HOURS;
        const already = t.received || {};
        const lines = Object.entries(t.lines || {});
        const allSettled = lines.length > 0 && lines.every(([k]) => already[k] != null);
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

            {lines.map(([lineKey, sentQtyRaw]) => {
              const parsed = parseLineKey(lineKey);
              const sentQty = Number(sentQtyRaw) || 0;
              const name = byId.get(parsed?.productId)?.name || parsed?.productId || lineKey;
              const done = already[lineKey] != null;
              const gotQty = Number(already[lineKey]) || 0;
              return (
                <div key={lineKey} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                    <div style={{ fontSize: 11, color: GRAY }}>{sizeText(parsed?.size)} · sent {sentQty}</div>
                  </div>
                  {done ? (
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: gotQty < sentQty ? RED : GREEN, whiteSpace: "nowrap" }}>
                      {gotQty < sentQty ? `got ${gotQty} of ${sentQty}` : `received ${gotQty} ✓`}
                    </span>
                  ) : (
                    <input
                      type="number" inputMode="numeric" min={0} max={sentQty}
                      value={edits[t.id]?.[lineKey] ?? sentQty}
                      onChange={(e) => setEdit(t.id, lineKey, e.target.value, sentQty)}
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
                Short-received — the missing units are still in the In Transit holding. An admin resolves them with an adjustment (Stock → Adjust).
                {actorRole === "admin" && (
                  <button
                    onClick={async () => {
                      // Closes the card once the shortfall has been dealt with
                      // (adjustment booked / units found). The doc keeps the
                      // received map + this marker as the audit trail.
                      await update(ref(database), {
                        [`transfers/${t.id}/status`]: "received",
                        [`transfers/${t.id}/resolvedShort`]: true,
                        [`transfers/${t.id}/receivedAt`]: serverNowIso(),
                        [`transfers/${t.id}/receivedBy`]: auth.currentUser?.uid || null,
                      }).catch(() => flash("err", "Couldn't mark resolved — retry."));
                    }}
                    style={{ ...bGreen, display: "block", width: "100%", marginTop: 8, padding: "8px 12px" }}
                  >
                    Mark resolved (admin)
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

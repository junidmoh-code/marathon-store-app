// ─── MOVE EXCESS → CENTRAL (bulk rebalance tool) ──────────────────────────────
// Temporary admin tool for the initial inventory cleanup: Hub 2 should be a
// refill buffer, not long-term storage. This screen lists every clothing
// (product, size) at Hub 2 holding MORE than its approved target
// (/stock_targets/hub2) and prepares transfer_out movements hub2 → central for
// the surplus. Preview first; quantities are editable per line; nothing moves
// until Confirm.
//
// Safety properties:
//   • Every write is a normal applyMovement transfer_out (atomic, version-
//     guarded, idempotent per movementId) — the ledger records the batch under
//     one shared transferId with reason "excess_rebalance".
//   • Re-running after a partial batch recomputes remaining excess from live
//     stock, so double-moves are structurally impossible.
//   • ≤ 200 lines per confirmation (keep batches reviewable); failures are
//     listed per line (e.g. a concurrent sale consumed the excess).
// Later categories (sneakers) = drop the clothing filter.

import React, { useMemo, useState } from "react";
import { useStockCells, useStockTargets } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGhost, input } from "./ui";

const FROM = "hub2";
const TO = "central";
const MAX_LINES = 200;

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

export default function MoveExcess({ products = [], actorRole }) {
  const hubStock = useStockCells(FROM);            // { pid: { rawSize: cell } }
  const targets = useStockTargets(FROM) || {};     // { pid: { encodedSize: {target} } }
  const [edits, setEdits] = useState({});          // key → qty override
  const [skips, setSkips] = useState({});          // key → true (excluded)
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);      // { moved, failed: [{key, reason}] }

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const lines = useMemo(() => {
    const out = [];
    for (const [pid, bySize] of Object.entries(hubStock || {})) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      for (const [size, cell] of Object.entries(bySize || {})) {
        const qty = typeof cell?.qty === "number" ? cell.qty : 0;
        const t = targets?.[pid]?.[encodeSizeKey(size)];
        if (!t || typeof t.target !== "number") continue; // no approved target → not judged
        const excess = qty - t.target;
        if (excess > 0) out.push({ key: `${pid}|${size}`, pid, size, name: p?.name || pid, have: qty, target: t.target, excess });
      }
    }
    return out.sort((a, b) => b.excess - a.excess);
  }, [hubStock, targets, byId]);

  const moveQty = (l) => Math.max(0, Math.min(Number(edits[l.key] ?? l.excess) || 0, l.have));
  const activeLines = lines.filter((l) => !skips[l.key] && moveQty(l) > 0).slice(0, MAX_LINES);
  const totalUnits = activeLines.reduce((t, l) => t + moveQty(l), 0);

  const confirm = async () => {
    if (!activeLines.length || busy) return;
    setBusy(true);
    setResult(null);
    // One batch id groups the whole rebalance in MovementHistory; the per-line
    // movementId makes retries idempotent within this batch.
    const batchId = `exc_${Date.now().toString(36)}`;
    let moved = 0;
    const failed = [];
    for (const l of activeLines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: l.pid, size: l.size, qty: moveQty(l),
          from: FROM, to: TO, actorRole,
          reason: "excess_rebalance",
          movementId: `${batchId}_${l.pid}_${encodeSizeKey(l.size)}`,
          link: { transferId: batchId },
        });
      } catch (e) {
        res = { ok: false, reason: String(e?.message || e) };
      }
      if (res.ok) moved += moveQty(l);
      else failed.push({ key: l.key, name: l.name, size: l.size, reason: res.reason });
    }
    setBusy(false);
    setEdits({});
    setResult({ moved, failed });
  };

  return (
    <div>
      <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Move excess Hub 2 → Central</div>
        <div style={{ color: GRAY, fontSize: 12, marginTop: 4 }}>
          Clothing above its approved Hub 2 target. {lines.length} lines, {lines.reduce((t, l) => t + l.excess, 0)} surplus units.
          {lines.length > MAX_LINES ? ` Showing the biggest ${MAX_LINES} per batch — re-run for the rest.` : ""}
        </div>
      </div>

      {result && (
        <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ color: GREEN, fontSize: 13, fontWeight: 600 }}>Moved {result.moved} units → Central.</div>
          {result.failed.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: RED, fontSize: 12, fontWeight: 600 }}>{result.failed.length} line(s) failed:</div>
              {result.failed.slice(0, 12).map((f) => (
                <div key={f.key} style={{ color: GRAY, fontSize: 12 }}>{f.name} · {f.size} — {f.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {lines.length === 0 && (
        <div style={{ color: GRAY, fontSize: 13, padding: 12 }}>
          No excess found. Either Hub 2 is within targets, or targets haven't been seeded yet.
        </div>
      )}

      {lines.slice(0, MAX_LINES).map((l) => (
        <div key={l.key} style={{ ...GLASS, padding: "10px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10, opacity: skips[l.key] ? 0.45 : 1 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
            <div style={{ color: GRAY, fontSize: 11.5 }}>Size {l.size} — have {l.have}, target {l.target}, excess <span style={{ color: AMBER }}>{l.excess}</span></div>
          </div>
          <input
            type="number" min={0} max={l.have}
            value={edits[l.key] ?? l.excess}
            onChange={(e) => setEdits((prev) => ({ ...prev, [l.key]: e.target.value }))}
            style={{ ...input, width: 58, textAlign: "center" }}
            disabled={busy || skips[l.key]}
          />
          <button
            onClick={() => setSkips((prev) => ({ ...prev, [l.key]: !prev[l.key] }))}
            style={{ ...bGhost, padding: "6px 10px", fontSize: 12, color: skips[l.key] ? GRAY : BLUE_L }}
            disabled={busy}
          >
            {skips[l.key] ? "Include" : "Skip"}
          </button>
        </div>
      ))}

      {activeLines.length > 0 && (
        <button onClick={confirm} disabled={busy} style={{ ...bGreen, width: "100%", padding: "13px", marginTop: 6, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Moving…" : `Move ${totalUnits} units (${activeLines.length} lines) → Central`}
        </button>
      )}
    </div>
  );
}

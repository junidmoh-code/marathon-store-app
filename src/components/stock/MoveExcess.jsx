// ─── MOVE EXCESS → CENTRAL (card-by-card rebalance) ───────────────────────────
// Temporary admin tool for the Hub 2 cleanup: Hub 2 is a refill buffer, not
// long-term storage, so anything above its approved target goes back to Central.
//
// Owner-specified flow (2026-07-12): ONE professional product card at a time —
// photo, full name, current vs target vs excess per size — with editable
// transfer quantities. Press "Transfer to Central" and the next card appears,
// until the cleanup is finished. Skip leaves a product for later.
//
// Every write is a normal applyMovement transfer_out (atomic, version-guarded,
// idempotent per movementId, same proven logic as every other transfer); the
// whole cleanup shares one ledger batch id per product confirm. Re-opening the
// screen recomputes remaining excess from live stock, so double-moves are
// structurally impossible. Later categories (sneakers) = drop the clothing filter.

import React, { useMemo, useState } from "react";
import { useStockCells, useStockTargets } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGhost, input } from "./ui";

const FROM = "hub2";
const TO = "central";
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

function photoOf(p) {
  return p?.photoUrl || null;
}

export default function MoveExcess({ products = [], actorRole }) {
  const hubStock = useStockCells(FROM);            // { pid: { rawSize: cell } }
  const targets = useStockTargets(FROM) || {};     // { pid: { encodedSize: {target} } }
  const [edits, setEdits] = useState({});          // `${pid}|${size}` → qty override
  const [skipped, setSkipped] = useState({});      // pid → true (pushed to the back for later)
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [movedTotal, setMovedTotal] = useState(0);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // One entry per product with any size above target, biggest surplus first.
  const cards = useMemo(() => {
    const out = [];
    for (const [pid, bySize] of Object.entries(hubStock || {})) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      const sizes = [];
      for (const [size, cell] of Object.entries(bySize || {})) {
        const qty = typeof cell?.qty === "number" ? cell.qty : 0;
        const t = targets?.[pid]?.[encodeSizeKey(size)];
        if (!t || typeof t.target !== "number") continue;
        const excess = qty - t.target;
        if (excess > 0) sizes.push({ size, have: qty, target: t.target, excess });
      }
      if (!sizes.length) continue;
      sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      out.push({ pid, name: p?.name || pid, photo: photoOf(p), sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0) });
    }
    return out.sort((a, b) => b.totalExcess - a.totalExcess);
  }, [hubStock, targets, byId]);

  const queue = [...cards.filter((c) => !skipped[c.pid]), ...cards.filter((c) => skipped[c.pid])];
  const card = queue.find((c) => !skipped[c.pid]) || queue[0] || null;
  const remaining = cards.length;

  const qtyOf = (c, s) => {
    const v = edits[`${c.pid}|${s.size}`];
    return Math.max(0, Math.min(v == null ? s.excess : Number(v) || 0, s.have));
  };

  const transfer = async (c) => {
    if (busy) return;
    const lines = c.sizes.map((s) => ({ s, qty: qtyOf(c, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusy(true);
    const batchId = `exc_${Date.now().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: c.pid, size: s.size, qty,
          from: FROM, to: TO, actorRole,
          reason: "excess_rebalance",
          movementId: `${batchId}_${c.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batchId },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setMovedTotal((t) => t + moved);
    setLastResult({ name: c.name, moved, failed });
    setBusy(false);
    // The live stock subscription removes/updates this card automatically; the
    // next one is then first in the queue.
  };

  return (
    <div>
      <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Move excess Hub 2 → Central</div>
          <div style={{ fontSize: 12, color: BLUE_L, fontWeight: 700 }}>{remaining} product{remaining === 1 ? "" : "s"} left</div>
        </div>
        <div style={{ color: GRAY, fontSize: 11.5, marginTop: 3 }}>
          One product at a time — adjust quantities if needed, then Transfer. {movedTotal > 0 ? `${movedTotal} units moved this session.` : ""}
        </div>
      </div>

      {lastResult && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12 }}>
          <span style={{ color: GREEN, fontSize: 12.5, fontWeight: 600 }}>{lastResult.name}: {lastResult.moved} units → Central ✓</span>
          {lastResult.failed.length > 0 && (
            <div style={{ color: RED, fontSize: 12, marginTop: 4 }}>Failed: {lastResult.failed.join(" · ")}</div>
          )}
        </div>
      )}

      {!card && (
        <div style={{ ...GLASS, padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: GREEN }}>Cleanup finished 🎉</div>
          <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
            Hub 2 holds nothing above its approved targets{movedTotal > 0 ? ` — ${movedTotal} units returned to Central this session` : ""}.
          </div>
        </div>
      )}

      {card && (
        <div style={{ ...GLASS, padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 15px 10px" }}>
            {card.photo
              ? <img src={card.photo} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover", flexShrink: 0 }} />
              : <div style={{ width: 64, height: 64, borderRadius: 12, background: "rgba(60,110,255,.1)", flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.25 }}>{card.name}</div>
              <div style={{ color: AMBER, fontSize: 12, marginTop: 3 }}>{card.totalExcess} units above target</div>
            </div>
          </div>

          {/* Size table: Current | Target | Transfer */}
          <div style={{ padding: "4px 15px 8px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 1fr 76px", gap: 6, fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", padding: "4px 0" }}>
              <span>Size</span><span style={{ textAlign: "center" }}>Current</span><span style={{ textAlign: "center" }}>Target</span><span style={{ textAlign: "center" }}>Transfer</span>
            </div>
            {card.sizes.map((s) => (
              <div key={s.size} style={{ display: "grid", gridTemplateColumns: "44px 1fr 1fr 76px", gap: 6, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(120,150,255,.08)" }}>
                <span style={{ fontWeight: 700, fontSize: 13.5 }}>{s.size}</span>
                <span style={{ textAlign: "center", fontSize: 13.5 }}>{s.have}</span>
                <span style={{ textAlign: "center", fontSize: 13.5, color: GRAY }}>{s.target}</span>
                <input
                  type="number" min={0} max={s.have}
                  value={qtyOf(card, s)}
                  disabled={busy}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [`${card.pid}|${s.size}`]: e.target.value }))}
                  style={{ ...input, width: "100%", textAlign: "center", padding: "7px 4px" }}
                />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, padding: "6px 15px 15px" }}>
            <button onClick={() => setSkipped((p) => ({ ...p, [card.pid]: true }))} disabled={busy}
                    style={{ ...bGhost, flex: 1, padding: "12px" }}>Skip for now</button>
            <button onClick={() => transfer(card)} disabled={busy || card.sizes.every((s) => qtyOf(card, s) === 0)}
                    style={{ ...bGreen, flex: 2.2, padding: "12px", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Transferring…" : `Transfer ${card.sizes.reduce((t, s) => t + qtyOf(card, s), 0)} units to Central`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MOVE EXCESS → CENTRAL (card-by-card rebalance) ───────────────────────────
// Hub 2 is a refill buffer, not long-term storage: anything above its approved
// target goes back to Central. Owner UX spec (2026-07-12): the operator REVIEWS
// PRODUCTS, not rows — one professional card at a time with photo, full name,
// and per-size stepper chips (Transfer-screen idiom) showing have → target →
// move. Transfer to Central advances to the next card until the cleanup is
// finished; Skip defers a product to the back of the queue.
//
// Every write is a normal applyMovement transfer_out (atomic, version-guarded,
// idempotent per movementId); each product confirm shares one ledger batch id.
// Re-opening recomputes remaining excess from live stock, so double-moves are
// structurally impossible. Later categories (sneakers) = drop the clothing filter.

import React, { useMemo, useState } from "react";
import { useStockCells, useStockTargets } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGhost } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";

const FROM = "hub2";
const TO = "central";
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

export default function MoveExcess({ products = [], actorRole }) {
  const hubStock = useStockCells(FROM);
  const targets = useStockTargets(FROM) || {};
  const [edits, setEdits] = useState({});          // `${pid}|${size}` → qty
  const [skipped, setSkipped] = useState({});      // pid → true
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [movedTotal, setMovedTotal] = useState(0);
  const [doneCount, setDoneCount] = useState(0);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

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
      out.push({ pid, name: p?.name || pid, photo: p?.photoUrl, sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0) });
    }
    return out.sort((a, b) => b.totalExcess - a.totalExcess);
  }, [hubStock, targets, byId]);

  const active = cards.filter((c) => !skipped[c.pid]);
  const card = active[0] || cards[0] || null;
  const totalCards = cards.length + doneCount;

  const qtyOf = (c, s) => {
    const v = edits[`${c.pid}|${s.size}`];
    return Math.max(0, Math.min(v == null ? s.excess : v, s.have));
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
    if (!failed.length) setDoneCount((n) => n + 1);
    setLastResult({ name: c.name, moved, failed });
    setBusy(false);
    // Live stock subscription retires this card; the next appears automatically.
  };

  return (
    <div>
      {/* Progress strip */}
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>Hub 2 cleanup</div>
          <div style={{ color: GRAY, fontSize: 11, marginTop: 2 }}>
            {movedTotal > 0 ? `${movedTotal} units returned to Central · ` : ""}review one product at a time
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "5px 12px", whiteSpace: "nowrap" }}>
          {cards.length} left
        </span>
      </div>

      {lastResult && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5 }}>
          <span style={{ color: GREEN, fontWeight: 700 }}>{lastResult.name}: {lastResult.moved} units → Central ✓</span>
          {lastResult.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {lastResult.failed.join(" · ")}</div>}
        </div>
      )}

      {!card && (
        <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Cleanup finished 🎉</div>
          <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
            Hub 2 holds nothing above its approved targets{movedTotal > 0 ? ` — ${movedTotal} units returned to Central this session` : ""}.
          </div>
        </div>
      )}

      {card && (
        <ProductCard
          photo={card.photo} name={card.name}
          badges={<Badge tone={AMBER}>{card.totalExcess} ABOVE TARGET</Badge>}
        >
          <div style={CHIP_GRID}>
            {card.sizes.map((s) => (
              <SizeStepperChip key={s.size}
                size={s.size}
                qty={qtyOf(card, s)}
                max={s.have}
                onChange={(v) => setEdits((prev) => ({ ...prev, [`${card.pid}|${s.size}`]: v }))}
                hint={`have ${s.have} · target ${s.target}`}
                disabled={busy}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => setSkipped((p) => ({ ...p, [card.pid]: true }))} disabled={busy}
                    style={{ ...bGhost, flex: 1, padding: "12px" }}>Skip</button>
            <button onClick={() => transfer(card)} disabled={busy || card.sizes.every((s) => qtyOf(card, s) === 0)}
                    style={{ ...bGreen, flex: 2.2, padding: "12px", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Transferring…" : `Transfer ${card.sizes.reduce((t, s) => t + qtyOf(card, s), 0)} units to Central`}
            </button>
          </div>
        </ProductCard>
      )}
    </div>
  );
}

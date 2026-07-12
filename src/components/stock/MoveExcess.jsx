// ─── MOVE EXCESS — network-wide rebalance (card-by-card) ──────────────────────
// Owner spec v3 (2026-07-12): excess detection covers the WHOLE network, not
// just Hub 2. Any location holding more than its approved target surfaces here:
//   • Hub 2 — strict: every unit above target (it's a refill buffer, not storage)
//   • Marathon PE / Trophy — significant surplus only (≥2 above target; stores
//     legitimately sell down small overage on their own)
// The operator reviews ONE product card at a time — photo, name, per-size
// stepper chips (have → target → move) — picks a destination (stores may send
// back to Hub 2 or straight to Central; Hub 2 sends to Central) and transfers.
// Confirming advances to the next card until the cleanup is complete.
//
// Every write is applyMovement transfer_out (atomic, idempotent per movementId,
// one ledger batch id per confirm). Live stock retires cards instantly;
// re-opening recomputes, so double-moves are structurally impossible.

import React, { useMemo, useState } from "react";
import { useStockCells, useStockTargets } from "./useStock";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGhost, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const SOURCES = ["hub2", "marathon-pe", "trophy"];
const STORE_EXCESS_MIN = 2;   // keep in sync with config.storeExcessMinUnits
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

const destChip = (on) => ({
  padding: "8px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.55)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.15)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.5)",
});

export default function MoveExcess({ products = [], actorRole }) {
  const allStock = useStockCells();          // { loc: { pid: { rawSize: cell } } }
  const allTargets = useStockTargets();      // { loc: { pid: { encodedSize: {target} } } }
  const [edits, setEdits] = useState({});    // `${loc}|${pid}|${size}` → qty
  const [dests, setDests] = useState({});    // `${loc}|${pid}` → destination
  const [skipped, setSkipped] = useState({});
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [movedTotal, setMovedTotal] = useState(0);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const cards = useMemo(() => {
    const out = [];
    for (const loc of SOURCES) {
      const minEx = loc === "hub2" ? 1 : STORE_EXCESS_MIN;
      for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
        const p = byId.get(pid);
        if (!isClothing(p)) continue;
        const sizes = [];
        for (const [size, cell] of Object.entries(bySize || {})) {
          const qty = typeof cell?.qty === "number" ? cell.qty : 0;
          const t = allTargets?.[loc]?.[pid]?.[encodeSizeKey(size)];
          if (!t || typeof t.target !== "number") continue;
          const excessQty = qty - t.target;
          if (excessQty >= minEx) sizes.push({ size, have: qty, target: t.target, excess: excessQty });
        }
        if (!sizes.length) continue;
        sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        out.push({
          key: `${loc}|${pid}`, loc, pid, name: p?.name || pid, photo: p?.photoUrl,
          sizes, totalExcess: sizes.reduce((t, s) => t + s.excess, 0),
        });
      }
    }
    return out.sort((a, b) => b.totalExcess - a.totalExcess);
  }, [allStock, allTargets, byId]);

  const active = cards.filter((c) => !skipped[c.key]);
  const card = active[0] || cards[0] || null;

  const destOptions = (c) => (c.loc === "hub2" ? ["central"] : ["hub2", "central"]);
  const qtyOf = (c, s) => {
    const v = edits[`${c.key}|${s.size}`];
    return Math.max(0, Math.min(v == null ? s.excess : v, s.have));
  };

  const transfer = async (c) => {
    if (busy) return;
    const dest = dests[c.key] || destOptions(c)[0];
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
          from: c.loc, to: dest, actorRole,
          reason: "excess_rebalance",
          movementId: `${batchId}_${c.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batchId },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setMovedTotal((t) => t + moved);
    setLastResult({ name: c.name, dest, moved, failed });
    setBusy(false);
  };

  return (
    <div>
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>Excess rebalance</div>
          <div style={{ color: GRAY, fontSize: 11, marginTop: 2 }}>
            Hub 2 + shops above approved targets{movedTotal > 0 ? ` · ${movedTotal} units moved` : ""}
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "5px 12px", whiteSpace: "nowrap" }}>
          {cards.length} left
        </span>
      </div>

      {lastResult && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5 }}>
          <span style={{ color: GREEN, fontWeight: 700 }}>{lastResult.name}: {lastResult.moved} units → {LOC_LABEL[lastResult.dest]} ✓</span>
          {lastResult.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {lastResult.failed.join(" · ")}</div>}
        </div>
      )}

      {!card && (
        <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Network balanced 🎉</div>
          <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>
            No location holds meaningfully more than its approved targets{movedTotal > 0 ? ` — ${movedTotal} units rebalanced this session` : ""}.
          </div>
        </div>
      )}

      {card && (() => {
        const dest = dests[card.key] || destOptions(card)[0];
        const total = card.sizes.reduce((t, s) => t + qtyOf(card, s), 0);
        return (
          <ProductCard
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={BLUE_L}>{LOC_LABEL[card.loc]}</Badge>
              <Badge tone={AMBER}>{card.totalExcess} ABOVE TARGET</Badge>
            </>}
          >
            <div style={CHIP_GRID}>
              {card.sizes.map((s) => (
                <SizeStepperChip key={s.size}
                  size={s.size} qty={qtyOf(card, s)} max={s.have}
                  onChange={(v) => setEdits((prev) => ({ ...prev, [`${card.key}|${s.size}`]: v }))}
                  hint={`have ${s.have} · target ${s.target}`}
                  disabled={busy}
                />
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
              {destOptions(card).map((d) => (
                <button key={d} onClick={() => setDests((prev) => ({ ...prev, [card.key]: d }))} style={destChip(dest === d)}>
                  → {LOC_LABEL[d]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => setSkipped((p) => ({ ...p, [card.key]: true }))} disabled={busy}
                      style={{ ...bGhost, flex: 1, padding: "12px" }}>Skip</button>
              <button onClick={() => transfer(card)} disabled={busy || total === 0}
                      style={{ ...bGreen, flex: 2.2, padding: "12px", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Transferring…" : `Transfer ${total} units to ${LOC_LABEL[dest]}`}
              </button>
            </div>
          </ProductCard>
        );
      })()}
    </div>
  );
}

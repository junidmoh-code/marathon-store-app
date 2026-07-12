// ─── NO TARGET CONFIGURED — decision queue ────────────────────────────────────
// The final piece of the Health philosophy (owner, 2026-07-12): every issue is
// actionable, nothing accumulates. Clothing sitting at a managed location with
// no approved target appears here as a product card showing its stock across
// the WHOLE network (Marathon PE / Trophy / Hub 2 / Central) with a per-size
// breakdown, and four decisions — any of which clears the card instantly:
//
//   Set targets   → writes /stock_targets cells (admin stockRole; the rule
//                   enforces it) — the engine starts managing the product here
//   Transfer      → move the stock somewhere it belongs (applyMovement)
//   Exclude here  → explicit target 0 per size: "this product should never
//                   live at this location" — surplus then flows to Excess
//   Keep as is    → records /stock_targets_decisions/{loc}/{pid}; the product
//                   stays, unmanaged and un-nagged
//
// Everything computes LIVE from /stock + /stock_targets + decisions, so a
// resolved card disappears without waiting for the next engine scan.

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { useStockCells, useStockTargets, useTargetDecisions } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGhost, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, SizeFactChip, CHIP_GRID } from "./healthWidgets";

const LOCS = ["marathon-pe", "trophy", "hub2"];
const ALL_LOCS = ["marathon-pe", "trophy", "hub2", "central"];
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
const STANDARD_RUN = { S: 2, M: 3, L: 3, XL: 2, XXL: 2, XXXL: 1 };
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

const isClothing = (p) =>
  p?.productType === "clothing" ||
  (!p?.productType && (p?.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s))));

const pill = (on) => ({
  padding: "7px 13px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
  border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
  background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(255,255,255,.45)",
});

export default function NoTargetQueue({ products = [] }) {
  const allStock = useStockCells();
  const allTargets = useStockTargets() || {};
  const decisions = useTargetDecisions() || {};
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const isAdmin = actorRole === "admin";
  const canTransfer = ["store", "warehouse", "admin"].includes(actorRole);

  const [openKey, setOpenKey] = useState(null);
  const [action, setAction] = useState({});     // key → "targets" | "transfer"
  const [edits, setEdits] = useState({});       // `${key}|${size}` → qty (per action)
  const [destPick, setDestPick] = useState({}); // key → transfer destination
  const [busyKey, setBusyKey] = useState(null);
  const [doneMsg, setDoneMsg] = useState(null); // { name, text } banner

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const qtyAt = (loc, pid, size) => Math.max(Number(allStock?.[loc]?.[pid]?.[String(size)]?.qty) || 0, 0);
  const sumAt = (loc, pid) => Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);

  const cards = useMemo(() => {
    const out = [];
    for (const loc of LOCS) {
      for (const [pid, bySize] of Object.entries(allStock?.[loc] || {})) {
        const p = byId.get(pid);
        if (!isClothing(p)) continue;
        if (allTargets?.[loc]?.[pid]) continue;      // managed → not in this queue
        if (decisions?.[loc]?.[pid]) continue;       // decided: keep as is
        const sizes = Object.entries(bySize || {})
          .map(([size, c]) => ({ size, qty: Math.max(Number(c?.qty) || 0, 0) }))
          .filter((s) => s.qty > 0)
          .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        if (!sizes.length) continue;
        out.push({
          key: `${loc}|${pid}`, loc, pid, name: p?.name || pid, photo: p?.photoUrl,
          sizes, units: sizes.reduce((t, s) => t + s.qty, 0),
          network: ALL_LOCS.map((l) => ({ loc: l, units: sumAt(l, pid) })),
        });
      }
    }
    return out.sort((a, b) => b.units - a.units);
  }, [allStock, allTargets, decisions, byId]);

  // ── the four decisions ────────────────────────────────────────────────────────
  const writeTargets = async (card, zero = false) => {
    if (busyKey || !isAdmin) return;
    setBusyKey(card.key);
    const upd = {};
    const now = new Date().toISOString();
    for (const s of card.sizes) {
      const t = zero ? 0 : Math.max(0, Number(edits[`${card.key}|${s.size}`] ?? (STANDARD_RUN[s.size] ?? 1)) || 0);
      upd[`stock_targets/${card.loc}/${card.pid}/${encodeSizeKey(s.size)}`] = {
        target: t, minQty: Math.ceil(t / 2), source: zero ? "excluded" : "manual",
        batchId: "health-queue", approvedBy: "health-queue", approvedAt: now,
      };
    }
    try {
      await update(ref(database), upd);
      setDoneMsg({ name: card.name, text: zero ? `excluded from ${LOC_LABEL[card.loc]} — surplus now shows under Excess` : `targets set at ${LOC_LABEL[card.loc]} — the engine now manages it` });
    } catch (e) { setDoneMsg({ name: card.name, text: `write failed — ${String(e?.message || e)}` }); }
    setBusyKey(null);
  };

  const keepAsIs = async (card) => {
    if (busyKey) return;
    setBusyKey(card.key);
    try {
      await update(ref(database), {
        [`stock_targets_decisions/${card.loc}/${card.pid}`]: { decision: "keep", decidedAt: new Date().toISOString() },
      });
      setDoneMsg({ name: card.name, text: `kept at ${LOC_LABEL[card.loc]} as is — it won't be asked about again` });
    } catch (e) { setDoneMsg({ name: card.name, text: `write failed — ${String(e?.message || e)}` }); }
    setBusyKey(null);
  };

  const transfer = async (card) => {
    if (busyKey || !canTransfer) return;
    const dest = destPick[card.key] || (card.loc === "hub2" ? "central" : "hub2");
    const lines = card.sizes
      .map((s) => ({ s, qty: Math.max(0, Math.min(Number(edits[`${card.key}|${s.size}`] ?? s.qty) || 0, s.qty)) }))
      .filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyKey(card.key);
    const batch = `ntq_${Date.now().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: card.pid, size: s.size, qty,
          from: card.loc, to: dest, actorRole,
          reason: "network_rebalance",
          movementId: `${batch}_${card.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setDoneMsg({ name: card.name, text: failed.length ? `${moved} moved · failed: ${failed.join(" · ")}` : `${moved} units → ${LOC_LABEL[dest]} ✓` });
    setBusyKey(null);
  };

  if (!cards.length) {
    return (
      <div style={{ ...GLASS, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: GREEN }}>Queue clear 🎉</div>
        <div style={{ color: GRAY, fontSize: 12.5, marginTop: 6 }}>Every product at every location has a target, an exclusion, or a keep decision.</div>
      </div>
    );
  }

  return (
    <div>
      {doneMsg && (
        <div style={{ ...GLASS, padding: "10px 13px", marginBottom: 12, fontSize: 12.5 }}>
          <span style={{ color: doneMsg.text.includes("failed") ? RED : GREEN, fontWeight: 700 }}>{doneMsg.name}</span>
          <span style={{ color: GRAY }}> — {doneMsg.text}</span>
        </div>
      )}
      {cards.map((card) => {
        const open = openKey === card.key;
        const mode = action[card.key] || null;
        const dest = destPick[card.key] || (card.loc === "hub2" ? "central" : "hub2");
        const destOpts = ALL_LOCS.filter((l) => l !== card.loc);
        return (
          <ProductCard key={card.key}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={BLUE_L}>{LOC_LABEL[card.loc]}</Badge>
              <Badge tone={GRAY}>AWAITING TARGET</Badge>
            </>}
            sub={card.network.filter((n) => n.units > 0).map((n) => `${LOC_LABEL[n.loc]} ${n.units}`).join(" · ") || "no stock elsewhere"}
            right={
              <button onClick={() => { setOpenKey(open ? null : card.key); setAction((a) => ({ ...a, [card.key]: null })); }}
                      style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.3)", color: BLUE_L, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>
                {open ? "Close" : "Decide"}
              </button>
            }
          >
            {open && (
              <>
                {/* Size breakdown at THIS location */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {card.sizes.map((s) => <SizeFactChip key={s.size} size={s.size} value={`×${s.qty} here`} tone={BLUE_L} />)}
                </div>

                {/* Decision picker */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => setAction((a) => ({ ...a, [card.key]: "targets" }))} style={pill(mode === "targets")} disabled={!isAdmin} title={isAdmin ? "" : "Admin only"}>Set targets{!isAdmin ? " 🔒" : ""}</button>
                  <button onClick={() => setAction((a) => ({ ...a, [card.key]: "transfer" }))} style={pill(mode === "transfer")} disabled={!canTransfer}>Transfer</button>
                  <button onClick={() => writeTargets(card, true)} style={pill(false)} disabled={!isAdmin || busyKey === card.key} title={isAdmin ? "Target 0 everywhere here — surplus flows to Excess" : "Admin only"}>Exclude here{!isAdmin ? " 🔒" : ""}</button>
                  <button onClick={() => keepAsIs(card)} style={pill(false)} disabled={busyKey === card.key}>Keep as is</button>
                </div>

                {mode === "targets" && (
                  <>
                    <div style={{ color: GRAY, fontSize: 11, margin: "10px 0 4px" }}>Target per size at {LOC_LABEL[card.loc]} (prefilled with the standard run):</div>
                    <div style={CHIP_GRID}>
                      {card.sizes.map((s) => (
                        <SizeStepperChip key={s.size}
                          size={s.size}
                          qty={Math.max(0, Number(edits[`${card.key}|${s.size}`] ?? (STANDARD_RUN[s.size] ?? 1)) || 0)}
                          max={20}
                          onChange={(v) => setEdits((e) => ({ ...e, [`${card.key}|${s.size}`]: v }))}
                          hint={`have ${s.qty}`}
                          disabled={busyKey === card.key}
                        />
                      ))}
                    </div>
                    <button onClick={() => writeTargets(card)} disabled={busyKey === card.key}
                            style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyKey === card.key ? 0.6 : 1 }}>
                      {busyKey === card.key ? "Saving…" : "Save targets — engine takes over"}
                    </button>
                  </>
                )}

                {mode === "transfer" && (
                  <>
                    <div style={CHIP_GRID}>
                      {card.sizes.map((s) => (
                        <SizeStepperChip key={s.size}
                          size={s.size}
                          qty={Math.max(0, Math.min(Number(edits[`${card.key}|${s.size}`] ?? s.qty) || 0, s.qty))}
                          max={s.qty}
                          onChange={(v) => setEdits((e) => ({ ...e, [`${card.key}|${s.size}`]: v }))}
                          hint={`${s.qty} here`}
                          disabled={busyKey === card.key}
                        />
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                      {destOpts.map((d) => (
                        <button key={d} onClick={() => setDestPick((p) => ({ ...p, [card.key]: d }))} style={pill(dest === d)}>→ {LOC_LABEL[d]}</button>
                      ))}
                    </div>
                    <button onClick={() => transfer(card)} disabled={busyKey === card.key}
                            style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyKey === card.key ? 0.6 : 1 }}>
                      {busyKey === card.key ? "Transferring…" : `Transfer to ${LOC_LABEL[dest]}`}
                    </button>
                  </>
                )}
              </>
            )}
          </ProductCard>
        );
      })}
    </div>
  );
}

// ─── MISSING PRODUCTS — network transfer workflow ─────────────────────────────
// Owner spec (2026-07-12 v3): "Only in Central" / "Only in Hub 2" must be a
// complete transfer workflow, not a report. Every clothing product that exists
// upstream but is missing downstream appears as an expandable card:
//
//   photo · name · Available-at badges · Missing-from badges
//   → per-size stepper chips (capped at the source's live stock)
//   → destination chips (Hub 2 / Marathon PE / Trophy, as applicable)
//   → Transfer — immediate one-step applyMovement, straight from Health.
//
// Data is computed LIVE from /stock (not the scan snapshot) so a transfer
// retires its card instantly. Strictly clothing; strictly existing tokens.

import React, { useMemo, useState } from "react";
import { useStockCells } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, FONT } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowMs } from "../../utils/serverTime";

const STORES = ["marathon-pe", "trophy"];
const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", central: "Central" };
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

export default function NetworkTransfer({ products = [] }) {
  const allStock = useStockCells();   // { loc: { pid: { rawSize: cell } } } — live
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

  const [openPid, setOpenPid] = useState(null);
  const [dests, setDests] = useState({});     // pid → chosen destination
  const [edits, setEdits] = useState({});     // `${pid}|${size}` → qty
  const [busyPid, setBusyPid] = useState(null);
  const [done, setDone] = useState({});       // pid → {moved, dest, failed[]}

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const qtyAt = (loc, pid, size) => Math.max(Number(allStock?.[loc]?.[pid]?.[String(size)]?.qty) || 0, 0);
  const sumAt = (loc, pid) => Object.values(allStock?.[loc]?.[pid] || {}).reduce((t, c) => t + Math.max(Number(c?.qty) || 0, 0), 0);

  // Stranded clothing: upstream stock with zero presence downstream.
  const cards = useMemo(() => {
    const out = [];
    const pids = new Set([...Object.keys(allStock?.central || {}), ...Object.keys(allStock?.hub2 || {})]);
    for (const pid of pids) {
      const p = byId.get(pid);
      if (!isClothing(p)) continue;
      const ce = sumAt("central", pid), h2 = sumAt("hub2", pid);
      const pe = sumAt("marathon-pe", pid), tr = sumAt("trophy", pid);
      let source = null, kind = null;
      if (ce > 0 && h2 === 0 && pe === 0 && tr === 0) { source = "central"; kind = "Only in Central"; }
      else if (h2 > 0 && pe === 0 && tr === 0) { source = "hub2"; kind = "Only in Hub 2"; }
      if (!source) continue;
      const sizes = Object.entries(allStock[source]?.[pid] || {})
        .map(([size, c]) => ({ size, avail: Math.max(Number(c?.qty) || 0, 0) }))
        .filter((s) => s.avail > 0)
        .sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      if (!sizes.length) continue;
      const missing = source === "central" ? ["hub2", ...STORES].filter((l) => sumAt(l, pid) === 0) : STORES;
      out.push({ pid, name: p?.name || pid, photo: p?.photoUrl, source, kind, sizes, missing, units: sizes.reduce((t, s) => t + s.avail, 0) });
    }
    return out.sort((a, b) => b.units - a.units);
  }, [allStock, byId]);

  const destOptions = (card) => (card.source === "central" ? ["hub2", ...STORES] : STORES);
  const qtyOf = (card, s) => {
    const v = edits[`${card.pid}|${s.size}`];
    // Default: seed the destination with a sensible starter (up to 2 per size).
    return Math.max(0, Math.min(v == null ? Math.min(2, s.avail) : v, s.avail));
  };

  const transfer = async (card) => {
    const dest = dests[card.pid] || destOptions(card)[0];
    if (busyPid || !canAct || !dest) return;
    const lines = card.sizes.map((s) => ({ s, qty: qtyOf(card, s) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyPid(card.pid);
    const batch = `net_${serverNowMs().toString(36)}`;
    let moved = 0; const failed = [];
    for (const { s, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: card.pid, size: s.size, qty,
          from: card.source, to: dest, actorRole,
          reason: "network_rebalance",
          movementId: `${batch}_${card.pid}_${encodeSizeKey(s.size)}`,
          link: { transferId: batch },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) moved += qty; else failed.push(`${s.size}: ${res.reason}`);
    }
    setDone((d) => ({ ...d, [card.pid]: { moved, dest, failed } }));
    setBusyPid(null);
  };

  if (!cards.length) {
    return <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>No stranded products — everything upstream also exists in at least one shop.</div>;
  }

  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to transfer — viewing only.</div>}
      {cards.map((card) => {
        const open = openPid === card.pid;
        const result = done[card.pid];
        const dest = dests[card.pid] || destOptions(card)[0];
        const total = card.sizes.reduce((t, s) => t + qtyOf(card, s), 0);
        return (
          <ProductCard key={card.pid}
            photo={card.photo} name={card.name}
            badges={<>
              <Badge tone={AMBER}>{card.kind.toUpperCase()}</Badge>
              <Badge tone={BLUE_L}>{card.units} units at {LOC_LABEL[card.source]}</Badge>
            </>}
            right={
              <button onClick={() => setOpenPid(open ? null : card.pid)}
                      style={{ background: "rgba(60,110,255,.08)", border: "1px solid rgba(60,110,255,.3)", color: BLUE_L, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>
                {open ? "Close" : "Resolve"}
              </button>
            }
          >
            {result ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: GREEN, fontWeight: 700 }}>{result.moved} units → {LOC_LABEL[result.dest]} ✓</span>
                {result.failed.length > 0 && <div style={{ color: RED, marginTop: 4 }}>Failed: {result.failed.join(" · ")}</div>}
              </div>
            ) : open && (
              <>
                <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "2px 0 6px" }}>
                  Missing from: {card.missing.map((l) => LOC_LABEL[l]).join(" · ")}
                </div>
                <div style={CHIP_GRID}>
                  {card.sizes.map((s) => (
                    <SizeStepperChip key={s.size}
                      size={s.size} qty={qtyOf(card, s)} max={s.avail}
                      onChange={(v) => setEdits((e) => ({ ...e, [`${card.pid}|${s.size}`]: v }))}
                      hint={`${s.avail} at ${LOC_LABEL[card.source]}`}
                      disabled={!canAct || busyPid === card.pid}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                  {destOptions(card).map((d) => (
                    <button key={d} onClick={() => setDests((prev) => ({ ...prev, [card.pid]: d }))} style={destChip(dest === d)}>
                      → {LOC_LABEL[d]}
                    </button>
                  ))}
                </div>
                <button onClick={() => transfer(card)} disabled={busyPid === card.pid || total === 0 || !canAct}
                        style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyPid === card.pid || total === 0 || !canAct ? 0.5 : 1 }}>
                  {busyPid === card.pid ? "Transferring…" : `Transfer ${total} unit${total === 1 ? "" : "s"} to ${LOC_LABEL[dest]}`}
                </button>
              </>
            )}
          </ProductCard>
        );
      })}
    </>
  );
}

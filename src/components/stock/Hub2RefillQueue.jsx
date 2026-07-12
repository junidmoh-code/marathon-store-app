// ─── CLOTHING REFILL – HUB 2 (Central's automatic refill queue) ───────────────
// Mounted inside the SOURCE card (replacing the old per-store "Clothing Sold"
// tabs) and inside the Inventory Health dashboard. When Hub 2 falls below its
// approved targets the refill engine writes /refill_requests with
// requestingLocation="hub2"; this is where CENTRAL staff work that queue.
//
// Product-first cards (owner UX spec 2026-07-12): photo, full name, AUTO badge,
// and per-size stepper chips showing required vs available — the same idiom as
// the Transfer screen. Transfer to Hub 2 executes immediate one-step ledger
// transfers per size via applyMovement; unpicked sizes stay open and any
// shortfall is re-detected by the next 15-minute scan.

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { useRefillRequests, useStockCells } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";

const SOURCE_LOC = "central";
const DEST_LOC = "hub2";
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

export default function Hub2RefillQueue({ products = [] }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const openRequests = useRefillRequests("open");
  const centralCells = useStockCells(SOURCE_LOC);
  const [picks, setPicks] = useState({});       // refillId → qty
  const [busyCard, setBusyCard] = useState(null);
  const [msg, setMsg] = useState({});           // productId → result line

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const canTransfer = ["store", "warehouse", "admin"].includes(actorRole);

  const cards = useMemo(() => {
    const byPid = new Map();
    for (const r of openRequests) {
      if (r.requestingLocation !== DEST_LOC || !r.productId) continue;
      if (!byPid.has(r.productId)) byPid.set(r.productId, []);
      byPid.get(r.productId).push(r);
    }
    return [...byPid.entries()].map(([pid, reqs]) => {
      reqs.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      return {
        pid, reqs,
        auto: reqs.some((r) => r.createdFrom?.engine),
        // Shadow previews are read-only — Live Mode creates the real thing.
        shadow: reqs.every((r) => r.shadow),
      };
    }).sort((a, b) => (a.shadow === b.shadow ? b.reqs.length - a.reqs.length : a.shadow ? 1 : -1));
  }, [openRequests, byId]);

  const availOf = (pid, size) => Math.max(Number(centralCells?.[pid]?.[String(size)]?.qty) || 0, 0);
  const pickOf = (r) => {
    const cap = Math.min(r.qty || 1, availOf(r.productId, r.size));
    const v = picks[r.id];
    return Math.max(0, Math.min(v == null ? cap : v, cap));
  };

  const transfer = async (card) => {
    if (busyCard || !canTransfer) return;
    const lines = card.reqs.map((r) => ({ r, qty: pickOf(r) })).filter((l) => l.qty > 0);
    if (!lines.length) return;
    setBusyCard(card.pid);
    let ok = 0, fail = 0;
    for (const { r, qty } of lines) {
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: r.productId, size: r.size, qty,
          from: SOURCE_LOC, to: DEST_LOC, actorRole,
          reason: "hub2_auto_refill",
          movementId: `rrf_${r.id}`,
          link: { refillId: r.id },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) {
        ok += qty;
        await update(ref(database), {
          [`refill_requests/${r.id}/status`]: "fulfilled",
          [`refill_requests/${r.id}/fulfilledBy`]: { movementId: `rrf_${r.id}`, qty },
          [`refill_requests/${r.id}/resolvedAt`]: new Date().toISOString(),
        }).catch(() => {});
      } else fail += 1;
    }
    setMsg((m) => ({ ...m, [card.pid]: fail ? `${ok} sent · ${fail} failed — retry` : `${ok} unit(s) → Hub 2 ✓` }));
    setBusyCard(null);
  };

  if (!cards.length) {
    return (
      <div style={{ ...GLASS, padding: 16, margin: "8px 0", color: GRAY, fontSize: 13 }}>
        No open Hub 2 refill requests. When Hub 2 drops below its approved targets,
        the engine's requests appear here automatically.
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 30 }}>
      <div style={{ color: GRAY, fontSize: 11.5, margin: "6px 2px 10px" }}>
        {cards.length} product{cards.length === 1 ? "" : "s"} waiting · set what's physically available, then Transfer.
        {!canTransfer && <span style={{ color: AMBER }}> You need a stock role to transfer — viewing only.</span>}
      </div>
      {cards.map((card) => {
        const p = byId.get(card.pid);
        const totalPick = card.reqs.reduce((t, r) => t + pickOf(r), 0);
        return (
          <ProductCard key={card.pid}
            photo={p?.photoUrl} name={p?.name || card.pid}
            badges={<>
              <Badge tone={AMBER}>{card.shadow ? "HUB 2 REFILL · AUTO (SHADOW)" : "HUB 2 REFILL"}</Badge>
              {card.auto && !card.shadow && <Badge tone={BLUE_L}>AUTO</Badge>}
            </>}
            sub={`${card.reqs.length} size${card.reqs.length === 1 ? "" : "s"} requested · from Central`}
          >
            {card.shadow ? (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {card.reqs.map((r) => (
                    <span key={r.id} style={{ border: "1px solid rgba(251,191,36,.35)", background: "rgba(251,191,36,.07)", borderRadius: 10, padding: "6px 11px", fontSize: 12.5 }}>
                      <b style={{ color: "#fff" }}>{String(r.size)}</b>
                      <span style={{ color: AMBER, fontWeight: 700 }}> ×{r.qty || 1}</span>
                      <span style={{ color: GRAY }}> · {availOf(r.productId, r.size)} at Central</span>
                    </span>
                  ))}
                </div>
                <div style={{ color: GRAY, fontSize: 11, marginTop: 10 }}>
                  Shadow preview — the engine would create this request for real in Live Mode. Nothing to action yet.
                </div>
              </>
            ) : (
              <>
                <div style={CHIP_GRID}>
                  {card.reqs.map((r) => {
                    const avail = availOf(r.productId, r.size);
                    return (
                      <SizeStepperChip key={r.id}
                        size={String(r.size)}
                        qty={pickOf(r)}
                        max={Math.min(r.qty || 1, avail)}
                        onChange={(v) => setPicks((prev) => ({ ...prev, [r.id]: v }))}
                        hint={avail > 0 ? `need ×${r.qty || 1} · ${avail} here` : "none at Central"}
                        disabled={!canTransfer || avail <= 0 || busyCard === card.pid}
                      />
                    );
                  })}
                </div>
                {msg[card.pid] && (
                  <div style={{ color: msg[card.pid].includes("failed") ? RED : GREEN, fontSize: 12.5, fontWeight: 600, marginTop: 10 }}>{msg[card.pid]}</div>
                )}
                <button
                  onClick={() => transfer(card)}
                  disabled={busyCard === card.pid || totalPick === 0 || !canTransfer}
                  style={{ ...bGreen, width: "100%", marginTop: 12, padding: "12px", opacity: busyCard === card.pid || totalPick === 0 || !canTransfer ? 0.5 : 1 }}>
                  {busyCard === card.pid ? "Transferring…" : `Transfer ${totalPick} unit${totalPick === 1 ? "" : "s"} to Hub 2`}
                </button>
              </>
            )}
          </ProductCard>
        );
      })}
    </div>
  );
}

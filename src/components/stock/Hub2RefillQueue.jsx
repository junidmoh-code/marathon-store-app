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
//
// Owner additions (2026-07-13):
// • UNCOUNTED SEND — a size showing 0 at Central is no longer inert. Central
//   can still enter a quantity: the units are `received` into Hub 2 with no
//   deduction anywhere (reason hub2_refill_uncounted — the CR-uncounted
//   precedent). Real shelves beat database cells.
// • REJECT — the ✕ on a chip marks that size "not available"; the footer
//   button commits transfers AND rejections in one tap. A rejection cancels
//   the refill request WITHOUT a cancelReason, which is exactly the shape the
//   engine reads as a HUMAN rejection (24h cooldown; and if the same
//   product+size is also rejected at the shop level, the engine confirms it
//   out — no more requests, straight to the Missing Sizes reorder list).

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { useRefillRequests, useStockCells, useStockExceptions } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bRed } from "./ui";
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
  // v9 actionable-only: every card below IS ready to fulfil (the engine only
  // creates a request when Central physically has the stock, and withdraws it
  // if Central sells out). The passive demand — waiting on supplier/upstream —
  // is summarised here for visibility, never as scrollable work.
  const exceptions = useStockExceptions();
  const passive = useMemo(() => {
    const count = (k) => (exceptions?.[k]?.items || []).filter((w) => w.loc === DEST_LOC).length;
    return {
      awaitingSupplier: count("awaitingSupplier") + count("missingSizes"),
      waitingForStock: count("waitingForStock"),
      awaitingUpstream: count("awaitingUpstream"),
    };
  }, [exceptions]);
  const passiveLine = (prefix) => {
    const bits = [];
    if (passive.awaitingSupplier) bits.push(`${passive.awaitingSupplier} waiting for supplier`);
    if (passive.awaitingUpstream) bits.push(`${passive.awaitingUpstream} awaiting upstream stock`);
    if (passive.waitingForStock) bits.push(`${passive.waitingForStock} resting after rejection`);
    return bits.length ? `${prefix}${bits.join(" · ")} — these reappear automatically when stock allows.` : "";
  };
  const [picks, setPicks] = useState({});       // refillId → qty
  const [rejects, setRejects] = useState({});   // refillId → true (marked "not available")
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
  // A size with counted Central stock is capped by it; a size showing ZERO can
  // still be sent up to the requested quantity (uncounted send — no deduction).
  // Uncounted sizes default to 0 picked so nothing ships by accident.
  const capOf = (r) => {
    const avail = availOf(r.productId, r.size);
    return avail > 0 ? Math.min(r.qty || 1, avail) : (r.qty || 1);
  };
  const pickOf = (r) => {
    if (rejects[r.id]) return 0;
    const avail = availOf(r.productId, r.size);
    const cap = capOf(r);
    const v = picks[r.id];
    return Math.max(0, Math.min(v == null ? (avail > 0 ? cap : 0) : v, cap));
  };

  // One tap commits the whole card: picked quantities transfer (counted stock)
  // or arrive uncounted (zero at Central), and ✕-marked sizes are rejected —
  // the request is cancelled with NO cancelReason, the engine's human-rejection
  // shape (cooldown + confirmed-out learning when the shop level also said no).
  const commit = async (card) => {
    if (busyCard || !canTransfer) return;
    const lines = card.reqs.map((r) => ({ r, qty: pickOf(r) })).filter((l) => l.qty > 0 && !rejects[l.r.id]);
    const denied = card.reqs.filter((r) => rejects[r.id]);
    if (!lines.length && !denied.length) return;
    setBusyCard(card.pid);
    let ok = 0, fail = 0;
    for (const { r, qty } of lines) {
      const counted = availOf(r.productId, r.size) > 0;
      let res;
      try {
        res = await applyMovement(counted ? {
          type: "transfer_out", productId: r.productId, size: r.size, qty,
          from: SOURCE_LOC, to: DEST_LOC, actorRole,
          reason: "hub2_auto_refill",
          movementId: `rrf_${r.id}`,
          link: { refillId: r.id },
        } : {
          type: "received", productId: r.productId, size: r.size, qty,
          to: DEST_LOC, actorRole,
          reason: "hub2_refill_uncounted",
          movementId: `rrf_${r.id}`,
          link: { refillId: r.id },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) {
        // Only count success once the request is marked fulfilled too. If this
        // write fails the card stays open and shows "failed — retry": the
        // retry's movement is an idempotent no-op (same movementId), so stock
        // never moves twice — only the status write is re-attempted.
        try {
          await update(ref(database), {
            [`refill_requests/${r.id}/status`]: "fulfilled",
            [`refill_requests/${r.id}/fulfilledBy`]: { movementId: `rrf_${r.id}`, qty, ...(counted ? {} : { uncounted: true }) },
            [`refill_requests/${r.id}/resolvedAt`]: new Date().toISOString(),
          });
          ok += qty;
        } catch { fail += 1; }
      } else fail += 1;
    }
    let rejected = 0;
    if (denied.length) {
      const upd = {};
      const now = new Date().toISOString();
      for (const r of denied) {
        upd[`refill_requests/${r.id}/status`] = "cancelled";
        upd[`refill_requests/${r.id}/resolvedAt`] = now;
        upd[`refill_requests/${r.id}/rejectedBy`] = actorRole || "unknown";
        // Deliberately NO cancelReason — that field marks engine self-withdrawals.
      }
      try { await update(ref(database), upd); rejected = denied.length; }
      catch { fail += denied.length; }
    }
    const parts = [];
    if (ok) parts.push(`${ok} unit(s) → Hub 2 ✓`);
    if (rejected) parts.push(`${rejected} size(s) rejected`);
    if (fail) parts.push(`${fail} failed — retry`);
    setMsg((m) => ({ ...m, [card.pid]: parts.join(" · ") }));
    setBusyCard(null);
  };

  if (!cards.length) {
    return (
      <div style={{ ...GLASS, padding: 16, margin: "8px 0", color: GRAY, fontSize: 13 }}>
        No refill requests Central can act on right now. When Hub 2 drops below its
        approved targets AND Central has the stock, requests appear here automatically.
        {passiveLine(" In the background: ")}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 30 }}>
      <div style={{ color: GRAY, fontSize: 11.5, margin: "6px 2px 10px" }}>
        <b style={{ color: GREEN }}>{cards.length} ready to fulfil</b> — every card below is pickable at Central right now.
        {" "}{passiveLine("Not shown: ")}
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
                        max={capOf(r)}
                        onChange={(v) => setPicks((prev) => ({ ...prev, [r.id]: v }))}
                        rejected={!!rejects[r.id]}
                        onReject={() => setRejects((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
                        hint={avail > 0 ? `need ×${r.qty || 1} · ${avail} here` : `need ×${r.qty || 1} · 0 counted — adds to Hub 2 only`}
                        disabled={!canTransfer || busyCard === card.pid}
                      />
                    );
                  })}
                </div>
                {msg[card.pid] && (
                  <div style={{ color: msg[card.pid].includes("failed") ? RED : GREEN, fontSize: 12.5, fontWeight: 600, marginTop: 10 }}>{msg[card.pid]}</div>
                )}
                {(() => {
                  const deniedCount = card.reqs.filter((r) => rejects[r.id]).length;
                  const allDenied = deniedCount === card.reqs.length && deniedCount > 0;
                  // commit() serializes across ALL cards — mirror that here so a
                  // tap during another card's commit is visibly disabled, not a
                  // silent no-op.
                  const idle = busyCard === null;
                  const nothing = totalPick === 0 && deniedCount === 0;
                  const label = busyCard === card.pid ? "Working…"
                    : allDenied ? "Reject request — not available"
                    : deniedCount > 0 ? `Transfer ${totalPick} · reject ${deniedCount} size${deniedCount === 1 ? "" : "s"}`
                    : `Transfer ${totalPick} unit${totalPick === 1 ? "" : "s"} to Hub 2`;
                  return (
                    <button
                      onClick={() => commit(card)}
                      disabled={!idle || nothing || !canTransfer}
                      style={{ ...(allDenied ? bRed : bGreen), width: "100%", marginTop: 12, padding: "12px", opacity: !idle || nothing || !canTransfer ? 0.5 : 1 }}>
                      {label}
                    </button>
                  );
                })()}
              </>
            )}
          </ProductCard>
        );
      })}
    </div>
  );
}

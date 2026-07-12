// ─── CLOTHING REFILL – HUB 2 (Central's automatic refill queue) ───────────────
// Mounted inside the SOURCE card, replacing the old per-store "Clothing Sold"
// tabs (owner decision 2026-07-12). When Hub 2 falls below its approved targets
// the refill engine writes /refill_requests with requestingLocation="hub2";
// this screen is where CENTRAL staff work that queue.
//
// One expandable card per product: photo, name, "Hub 2 Refill Required", and a
// per-size row with the requested quantity and Central's live availability.
// The operator ticks the sizes that are physically findable, adjusts quantities
// if needed, and taps **Transfer to Hub 2** — an immediate one-step ledger
// transfer per size via applyMovement (the same proven logic every other
// transfer uses; no transit state). Fulfilled requests close themselves;
// unticked sizes stay open, and any shortfall is re-detected by the next
// 15-minute scan, so nothing is ever silently lost.

import React, { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { useRefillRequests, useStockCells, useLocations } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, input } from "./ui";

const SOURCE_LOC = "central";
const DEST_LOC = "hub2";
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i; };

function photoListOf(p) {
  const out = [];
  if (p?.photoUrl) out.push(p.photoUrl);
  if (Array.isArray(p?.gallery)) for (const u of p.gallery) if (u && !out.includes(u)) out.push(u);
  return out;
}

export default function Hub2RefillQueue({ products = [] }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const openRequests = useRefillRequests("open");
  const centralCells = useStockCells(SOURCE_LOC);   // { pid: { rawSize: cell } }
  useLocations(); // warm the registry cache used elsewhere
  const [openCard, setOpenCard] = useState(null);
  const [picks, setPicks] = useState({});           // refillId → qty (0 = unticked)
  const [busyCard, setBusyCard] = useState(null);
  const [msg, setMsg] = useState({});               // productId → result line

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const canTransfer = ["store", "warehouse", "admin"].includes(actorRole);

  // Group open hub2 requests into one card per product, sizes in wear order.
  const cards = useMemo(() => {
    const byPid = new Map();
    for (const r of openRequests) {
      if (r.requestingLocation !== DEST_LOC || !r.productId) continue;
      if (!byPid.has(r.productId)) byPid.set(r.productId, []);
      byPid.get(r.productId).push(r);
    }
    return [...byPid.entries()].map(([pid, reqs]) => {
      const p = byId.get(pid);
      reqs.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
      return { pid, name: p?.name || pid, photos: photoListOf(p), reqs, auto: reqs.some((r) => r.createdFrom?.engine) };
    }).sort((a, b) => b.reqs.length - a.reqs.length);
  }, [openRequests, byId]);

  const availOf = (pid, size) => Math.max(Number(centralCells?.[pid]?.[String(size)]?.qty) || 0, 0);
  // Default pick: everything Central can actually supply, capped at the request.
  const pickOf = (r) => picks[r.id] ?? Math.min(r.qty || 1, availOf(r.productId, r.size));

  const transfer = async (card) => {
    if (busyCard || !canTransfer) return;
    const lines = card.reqs.map((r) => ({ r, qty: Math.min(pickOf(r), availOf(r.productId, r.size)) })).filter((l) => l.qty > 0);
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
          movementId: `rrf_${r.id}`,          // one request = one idempotent movement
          link: { refillId: r.id },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res.ok) {
        ok += qty;
        // Close the request — partial quantities are fine: the next scan
        // re-detects any remaining deficit and issues a fresh request.
        await update(ref(database), {
          [`refill_requests/${r.id}/status`]: "fulfilled",
          [`refill_requests/${r.id}/fulfilledBy`]: { movementId: `rrf_${r.id}`, qty },
          [`refill_requests/${r.id}/resolvedAt`]: new Date().toISOString(),
        }).catch(() => {});
      } else fail += 1;
    }
    setMsg((m) => ({ ...m, [card.pid]: fail ? `${ok} unit(s) sent · ${fail} size(s) failed — retry` : `${ok} unit(s) → Hub 2 ✓` }));
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
        {cards.length} product{cards.length === 1 ? "" : "s"} waiting · tick what's physically available, then Transfer.
        {!canTransfer && <span style={{ color: AMBER }}> You need a stock role to transfer — viewing only.</span>}
      </div>
      {cards.map((card) => {
        const open = openCard === card.pid;
        const totalReq = card.reqs.reduce((t, r) => t + (r.qty || 1), 0);
        const totalPick = card.reqs.reduce((t, r) => t + Math.min(pickOf(r), availOf(r.productId, r.size)), 0);
        return (
          <div key={card.pid} style={{ ...GLASS, marginBottom: 10, overflow: "hidden" }}>
            <div onClick={() => setOpenCard(open ? null : card.pid)} role="button"
                 style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", cursor: "pointer" }}>
              {card.photos[0]
                ? <img src={card.photos[0]} alt="" style={{ width: 42, height: 42, borderRadius: 9, objectFit: "cover", flexShrink: 0 }} />
                : <div style={{ width: 42, height: 42, borderRadius: 9, background: "rgba(60,110,255,.1)", flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.name}</div>
                <div style={{ fontSize: 11, color: AMBER, marginTop: 1 }}>
                  Hub 2 Refill Required{card.auto ? " · AUTO" : ""}
                </div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap" }}>
                {card.reqs.length} size{card.reqs.length === 1 ? "" : "s"} · ×{totalReq}
              </span>
              <span style={{ color: BLUE_L, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 13 }}>▸</span>
            </div>

            {open && (
              <div style={{ padding: "2px 13px 13px", borderTop: "1px solid rgba(120,150,255,.1)" }}>
                {card.reqs.map((r) => {
                  const avail = availOf(r.productId, r.size);
                  const picked = Math.min(pickOf(r), avail);
                  const none = avail <= 0;
                  return (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(120,150,255,.07)", opacity: none ? 0.55 : 1 }}>
                      <span style={{ width: 44, fontWeight: 700, fontSize: 13 }}>{r.size}</span>
                      <span style={{ color: GRAY, fontSize: 12, flex: 1 }}>
                        requested ×{r.qty || 1} · Central has {avail}
                        {none && <span style={{ color: RED }}> — none here</span>}
                      </span>
                      <input
                        type="number" min={0} max={Math.min(r.qty || 1, avail)}
                        value={picked}
                        disabled={none || busyCard === card.pid}
                        onChange={(e) => setPicks((p) => ({ ...p, [r.id]: Math.max(0, Math.min(Number(e.target.value) || 0, Math.min(r.qty || 1, avail))) }))}
                        style={{ ...input, width: 54, textAlign: "center", padding: "6px 6px" }}
                      />
                    </div>
                  );
                })}
                {msg[card.pid] && <div style={{ color: msg[card.pid].includes("failed") ? RED : GREEN, fontSize: 12, marginTop: 8 }}>{msg[card.pid]}</div>}
                <button
                  onClick={() => transfer(card)}
                  disabled={busyCard === card.pid || totalPick === 0 || !canTransfer}
                  style={{ ...bGreen, width: "100%", marginTop: 10, padding: "12px", opacity: busyCard === card.pid || totalPick === 0 || !canTransfer ? 0.55 : 1 }}>
                  {busyCard === card.pid ? "Transferring…" : `Transfer ${totalPick} unit${totalPick === 1 ? "" : "s"} to Hub 2`}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

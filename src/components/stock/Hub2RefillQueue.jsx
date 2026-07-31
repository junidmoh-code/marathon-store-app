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

import React, { useEffect, useMemo, useState } from "react";
import { ref, update, get } from "firebase/database";
import { database } from "../../firebase";
import { useRefillRequests, useStockCells, useStockExceptions } from "./useStock";
import { sizeRank } from "./hubSizeRank";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bRed } from "./ui";
import { ProductCard, Badge, SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { formatDuration, refillAgeTone } from "../../utils/duration";
import { isFootwearProduct } from "./missingFootwearCore";

const SOURCE_LOC = "central";
// HUB-AGNOSTIC (2026-07-30). This queue was written when only Hub 2 received
// refills, because clothing is not kept at Hub 1 — that is a fact about CLOTHING,
// not about Hub 1. Sneakers make Hub 1 the bigger buffer (3,967 footwear units vs
// Hub 2's 3,288), so the destination is now a prop.
//
// The movement reason is derived as `${dest}_auto_refill` / `${dest}_refill_uncounted`,
// which reproduces the existing "hub2_auto_refill" / "hub2_refill_uncounted"
// strings byte-for-byte when dest is hub2 — the ledger's history keeps its
// meaning and hub1 gets its own distinct reasons rather than being logged as
// hub2 movement.
const DEFAULT_DEST = "hub2";
const HUB_LABEL = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3" };
// SIZE_ORDER / sizeRank now live in hubSizeRank.js so the tests exercise the
// real implementation instead of a copy that could silently diverge.

// Age tone → colour. serverNowMs() (not Date.now) drives every elapsed value so a
// wrong till/device clock never mis-ages a request.
const TONE_COLOR = { normal: GRAY, amber: AMBER, red: RED };
const parseMs = (iso) => Date.parse(iso || ""); // NaN when unparseable
// Raised timestamp as SA-local "21 Jul 14:03" (Intl pins the zone; no offset math).
const fmtSaDateTime = (iso) => {
  const t = parseMs(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-GB", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

// A live-ticking "now" (server-corrected), re-evaluated each minute so the elapsed
// counter counts up on its own. One interval for the whole queue.
function useNowMinute() {
  const [now, setNow] = useState(() => serverNowMs());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNowMs()), 60000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// The age pill shown on a card / history row. `elapsedMs` is live for open
// requests (now − raised) or fixed for fulfilled (resolved − raised).
function AgePill({ elapsedMs, raisedIso, prefix }) {
  const tone = refillAgeTone(elapsedMs);
  const color = TONE_COLOR[tone];
  return (
    <span title={raisedIso ? `raised ${fmtSaDateTime(raisedIso)}` : undefined}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700,
                   color, border: `1px solid ${color}55`, background: `${color}14`, borderRadius: 999, padding: "3px 9px",
                   fontVariantNumeric: "tabular-nums" }}>
      {tone === "red" && <span aria-hidden>●</span>}
      {prefix} {formatDuration(elapsedMs)}
    </span>
  );
}

export default function Hub2RefillQueue({ products = [], dest = DEFAULT_DEST }) {
  const DEST_LOC = dest;
  const destLabel = HUB_LABEL[dest] || dest;
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  // ONE subscription for the whole node; partition open vs fulfilled in memory so
  // the new history view adds NO listener (useRefillRequests already reads all of
  // /refill_requests and filters client-side).
  const allRequests = useRefillRequests();
  const openRequests = useMemo(() => allRequests.filter((r) => r.status === "open"), [allRequests]);
  const centralCells = useStockCells(SOURCE_LOC);
  const now = useNowMinute();
  const [view, setView] = useState("open"); // "open" | "history"
  // Sneakers and clothing are different picking jobs — different shelves, often
  // different people. One mixed list made the operator read every card to find
  // theirs. `null` = not chosen yet, so the screen opens on whichever kind
  // actually has work rather than a confidently empty tab.
  const [kind, setKind] = useState(null);
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
      // A card's wait = its OLDEST request (smallest createdAt) — that's the
      // longest-waiting size in it and what we age + sort on.
      const raisedMsList = reqs.map((r) => parseMs(r.createdAt)).filter(Number.isFinite);
      const raisedMs = raisedMsList.length ? Math.min(...raisedMsList) : NaN;
      return {
        pid, reqs, raisedMs,
        raisedIso: reqs.find((r) => parseMs(r.createdAt) === raisedMs)?.createdAt || null,
        auto: reqs.some((r) => r.createdFrom?.engine),
        // Shadow previews are read-only — Live Mode creates the real thing.
        shadow: reqs.every((r) => r.shadow),
      };
    }).sort((a, b) => {
      // Shadows (previews) sink to the bottom; among real cards, LONGEST-WAITING
      // FIRST — the oldest open request belongs at the top of the screen.
      if (a.shadow !== b.shadow) return a.shadow ? 1 : -1;
      const am = Number.isFinite(a.raisedMs) ? a.raisedMs : Infinity;
      const bm = Number.isFinite(b.raisedMs) ? b.raisedMs : Infinity;
      return am - bm; // ascending createdAt = oldest (longest waiting) first
    });
  }, [openRequests, byId]);

  const isFw = (pid) => isFootwearProduct(byId.get(pid));
  const splitCards = useMemo(() => ({
    sneakers: cards.filter((c) => isFw(c.pid)),
    clothing: cards.filter((c) => !isFw(c.pid)),
  }), [cards, byId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Fulfilled history — total delay (raised → fulfilled), most-recently fulfilled
  // first. Derived from the same subscription; no extra read.
  //
  // PARTITION BEFORE THE CAP. Capping a MIXED list at 100 and filtering after
  // meant a lane could be starved to nothing by the other one: 100 sneaker
  // fulfilments in a row and clothing history rendered empty, looking like there
  // had never been any. Each lane now gets its own 100. (CodeRabbit #294 — Major.)
  const HISTORY_CAP = 100;
  const historyByKind = useMemo(() => {
    const all = allRequests
      .filter((r) => r.requestingLocation === DEST_LOC && r.status === "fulfilled" && r.createdAt && r.resolvedAt)
      .map((r) => ({ ...r, raisedMs: parseMs(r.createdAt), resolvedMs: parseMs(r.resolvedAt) }))
      .filter((r) => Number.isFinite(r.raisedMs) && Number.isFinite(r.resolvedMs) && r.resolvedMs >= r.raisedMs)
      .sort((a, b) => b.resolvedMs - a.resolvedMs);
    return {
      sneakers: all.filter((r) => isFw(r.productId)).slice(0, HISTORY_CAP),
      clothing: all.filter((r) => !isFw(r.productId)).slice(0, HISTORY_CAP),
    };
  }, [allRequests, byId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Which lane opens by default depends on WHICH VIEW you are in: the open queue
  // and the history can be non-empty for different kinds, and picking the lane
  // from open cards alone landed History on an empty Sneakers tab while Clothing
  // history sat there unread. (CodeRabbit #294 — Major.)
  const laneCounts = view === "history"
    ? { sneakers: historyByKind.sneakers.length, clothing: historyByKind.clothing.length }
    : { sneakers: splitCards.sneakers.length, clothing: splitCards.clothing.length };
  const activeKind = kind || (laneCounts.sneakers ? "sneakers" : laneCounts.clothing ? "clothing" : "sneakers");
  const shownCards = splitCards[activeKind] || [];
  const shownHistory = historyByKind[activeKind] || [];

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
    for (const { r, qty: pickedQty } of lines) {
      // STALE-QTY CLAMP (review 2026-07-13): the engine may auto-resize this
      // request between render and tap. Re-read the live request; never send
      // more than it currently asks, and skip it entirely if it resolved.
      let qty = pickedQty;
      try {
        const live = (await get(ref(database, `refill_requests/${r.id}`))).val();
        if (!live || live.status !== "open") { fail++; continue; }
        if (typeof live.qty === "number" && qty > live.qty) qty = live.qty;
        if (qty <= 0) { fail++; continue; }
      } catch { /* offline read — proceed; movement idempotency still guards */ }
      const counted = availOf(r.productId, r.size) > 0;
      let res;
      try {
        res = await applyMovement(counted ? {
          type: "transfer_out", productId: r.productId, size: r.size, qty,
          from: SOURCE_LOC, to: DEST_LOC, actorRole,
          reason: `${DEST_LOC}_auto_refill`,
          movementId: `rrf_${r.id}`,
          link: { refillId: r.id },
        } : {
          type: "received", productId: r.productId, size: r.size, qty,
          to: DEST_LOC, actorRole,
          reason: `${DEST_LOC}_refill_uncounted`,
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
            [`refill_requests/${r.id}/resolvedAt`]: serverNowIso(),
          });
          ok += qty;
        } catch { fail += 1; }
      } else fail += 1;
    }
    let rejected = 0;
    if (denied.length) {
      const upd = {};
      const nowIso = serverNowIso();
      for (const r of denied) {
        upd[`refill_requests/${r.id}/status`] = "cancelled";
        upd[`refill_requests/${r.id}/resolvedAt`] = nowIso;
        upd[`refill_requests/${r.id}/rejectedBy`] = actorRole || "unknown";
        // Deliberately NO cancelReason — that field marks engine self-withdrawals.
      }
      try { await update(ref(database), upd); rejected = denied.length; }
      catch { fail += denied.length; }
    }
    const parts = [];
    if (ok) parts.push(`${ok} unit(s) → ${destLabel} ✓`);
    if (rejected) parts.push(`${rejected} size(s) rejected`);
    if (fail) parts.push(`${fail} failed — retry`);
    setMsg((m) => ({ ...m, [card.pid]: parts.join(" · ") }));
    setBusyCard(null);
  };

  // Open queue ⇄ Fulfilled history toggle — both views come from the one
  // subscription above.
  const PILLS = { display: "inline-flex", gap: 2, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 3, margin: "6px 2px 12px" };
  const pill = (on) => ({ border: "none", cursor: "pointer", borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 700,
                          background: on ? "rgba(74,127,255,.22)" : "transparent", color: on ? "#cfe0ff" : GRAY });

  // Sneakers ⇄ Clothing. Counts are always shown so an empty lane is visibly
  // empty rather than looking like a loading list.
  const kindToggle = (
    <div style={{ ...PILLS, marginRight: 8 }}>
      {[["sneakers", "Sneakers", laneCounts.sneakers], ["clothing", "Clothing", laneCounts.clothing]].map(([k, label, n]) => (
        <button key={k} type="button" onClick={() => setKind(k)} style={pill(activeKind === k)}>
          {label} · {n}
        </button>
      ))}
    </div>
  );

  const toggle = (
    <div style={{ display: "inline-flex", gap: 2, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: 3, margin: "6px 2px 12px" }}>
      {[["open", `Open queue${shownCards.length ? ` · ${shownCards.length}` : ""}`], ["history", "Fulfilled history"]].map(([k, label]) => {
        const on = view === k;
        return (
          <button key={k} type="button" onClick={() => setView(k)}
                  style={{ border: "none", cursor: "pointer", borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 700,
                           background: on ? "rgba(74,127,255,.22)" : "transparent", color: on ? "#cfe0ff" : GRAY }}>
            {label}
          </button>
        );
      })}
    </div>
  );

  if (view === "history") {
    return (
      <div style={{ paddingBottom: 30 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>{kindToggle}{toggle}</div>
        {shownHistory.length === 0 ? (
          <div style={{ ...GLASS, padding: 16, color: GRAY, fontSize: 13 }}>{`No fulfilled ${destLabel} ${activeKind === "sneakers" ? "sneaker" : "clothing"} refills yet.`}</div>
        ) : (
          <>
            <div style={{ color: GRAY, fontSize: 11.5, margin: "0 2px 10px" }}>
              Last {shownHistory.length} fulfilled — total time from raised to fulfilled. Longest delays flag red (≥24h).
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {shownHistory.map((r) => {
                const p = byId.get(r.productId);
                const delay = r.resolvedMs - r.raisedMs;
                return (
                  <div key={r.id} style={{ ...GLASS, display: "flex", alignItems: "center", gap: 11, padding: "9px 12px" }}>
                    {p?.photoUrl
                      ? <img src={p.photoUrl} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: "cover", flexShrink: 0 }} />
                      : <span style={{ width: 34, height: 34, borderRadius: 7, background: "rgba(255,255,255,.05)", flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p?.name || r.productId}</span>
                      <span style={{ display: "block", fontSize: 11, color: GRAY }}>size {String(r.size)} · raised {fmtSaDateTime(r.createdAt)} → fulfilled {fmtSaDateTime(r.resolvedAt)}</span>
                    </span>
                    <AgePill elapsedMs={delay} raisedIso={r.createdAt} prefix="took" />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }

  if (!shownCards.length) {
    return (
      <div style={{ paddingBottom: 30 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>{kindToggle}{toggle}</div>
        <div style={{ ...GLASS, padding: 16, margin: "8px 0", color: GRAY, fontSize: 13 }}>
          {`No ${activeKind === "sneakers" ? "sneaker" : "clothing"} refill requests Central can act on right now. When ${destLabel} drops below its`}
          approved targets AND Central has the stock, requests appear here automatically.
          {passiveLine(" In the background: ")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 30 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>{kindToggle}{toggle}</div>
      <div style={{ color: GRAY, fontSize: 11.5, margin: "6px 2px 10px" }}>
        <b style={{ color: GREEN }}>{shownCards.length} ready to fulfil</b> — created against live Central stock; if a size
        sold out since, the card withdraws itself on the next scan (≤15 min). Longest-waiting first.
        {" "}{passiveLine("Not shown: ")}
        {!canTransfer && <span style={{ color: AMBER }}> You need a stock role to transfer — viewing only.</span>}
      </div>
      {shownCards.map((card) => {
        const p = byId.get(card.pid);
        const totalPick = card.reqs.reduce((t, r) => t + pickOf(r), 0);
        return (
          <ProductCard key={card.pid}
            photo={p?.photoUrl} name={p?.name || card.pid}
            badges={<>
              <Badge tone={AMBER}>{card.shadow ? "HUB 2 REFILL · AUTO (SHADOW)" : "HUB 2 REFILL"}</Badge>
              {card.auto && !card.shadow && <Badge tone={BLUE_L}>AUTO</Badge>}
              {!card.shadow && Number.isFinite(card.raisedMs) && (
                <AgePill elapsedMs={now - card.raisedMs} raisedIso={card.raisedIso} prefix="waiting" />
              )}
            </>}
            sub={`${card.reqs.length} size${card.reqs.length === 1 ? "" : "s"} requested · from Central${!card.shadow && card.raisedIso ? ` · raised ${fmtSaDateTime(card.raisedIso)}` : ""}`}
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
                        hint={avail > 0 ? `need ×${r.qty || 1} · ${avail} here` : `need ×${r.qty || 1} · 0 counted — adds to ${destLabel} only`}
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
                    : `Transfer ${totalPick} unit${totalPick === 1 ? "" : "s"} to ${destLabel}`;
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

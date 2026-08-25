// ─── THE REFILL QUEUE — one list, one design (owner spec 2026-08-08) ─────────
// Every ask a hub can act on renders here as an ORDINARY REQUEST LINE — one row
// per (product, size), identical layout, identical actions (Fulfil / Out of
// Stock), whatever raised it:
//
//   • /refill_requests rows — the engine, Missing Sneakers, MoveExcess, and
//     customer holds. A hold-raised request is indistinguishable from any
//     other: no badge, no order number, no customer name. The separate On Hold
//     surface is abolished, not relocated.
//   • sale-driven restock cells — today's POS sales against this hub
//     (restock_log) and the unanswered past-day stragglers, passed in as
//     `saleRows` by SourceView. These are "today's requests" in the owner's
//     language and obey the exact same presentation rules.
//
// RELEASE WINDOWS APPLY TO EVERYTHING. Requests are raised the moment demand
// appears, but they become pickable work only at the configured release times
// (/config/refillEngine/releaseWindows, default 06:00 & 14:00 SA) — sneakers
// and clothing, every hub, every origin. The gate stays a pure function of
// (createdAt, now, config) — see releaseWindows.js — and is applied here and
// nowhere else. The admin early-release override stamps one request out of
// band, unchanged.
//
// THE PAGE IS QUIET. One status line says what to pick or when the next batch
// lands; the waiting backlog and already-covered detail sit behind a tap on
// that line. Completed sale cells (with Undo) sit behind one line at the
// bottom. Nothing else competes for attention.
//
// STOCK SEMANTICS ARE UNCHANGED per origin — only the presentation unified:
//   • request rows: counted Central stock → transfer_out central→dest, reason
//     `${dest}_auto_refill`; zero at Central → received into dest only, reason
//     `${dest}_refill_uncounted`; movementId `rrf_{requestId}` (idempotent);
//     stale-qty clamp against the live request before every send. Out of
//     Stock cancels WITHOUT a cancelReason — the engine's human-rejection
//     shape (cooldown + confirmed-out learning).
//   • sale rows: the Source Transfer & Fulfil precedent (#209) — pick a supply
//     warehouse, counted → transfer_out with allowNegative (reason
//     source_refill), never-counted → received (source_uncounted_send),
//     movementId `{seed}_{alreadySent}` with the twin-safe legacy-id dedupe.
//     Out of Stock writes the same response record it always has.

import React, { useEffect, useMemo, useState } from "react";
import { ref, update, get } from "firebase/database";
import { database, auth } from "../../firebase";
import { useRefillRequests, useStockCells, useEngineOpen, useEngineConfig, useStockHoldConfig } from "./useStock";
import { usePermissions } from "../PermissionsContext";
import { applyMovement } from "./applyMovement";
import { GRAY, GREEN, RED, AMBER, BLUE, FONT, bGreen } from "./ui";
import { serverNowIso, serverNowMs } from "../../utils/serverTime";
import { formatDuration, refillAgeTone } from "../../utils/duration";
import { partitionSatisfied, lockedRefillIds } from "./refillSatisfied";
import { parseReleaseTimes, partitionReleased, nextReleaseMs, saTimeLabel, releaseEarlyPatch } from "./releaseWindows";
import { queueStatusLine, sortQueueRows, groupRowsByProduct } from "./refillQueueCore";
import { warehouseLocations, labelFor, IN_TRANSIT } from "./locations";
import { stockCellPath, stockSizeKey } from "../../utils/sizeKey";
import { checkSourceMovementDuplicate } from "./sourceMovementDedupe";
import { sizeRank } from "./hubSizeRank";
// COUNT-INTEGRITY HOLD LANE (owner spec 2026-08-12): when the RTDB switch is
// on, a cross-building fulfil parks its destination credit at stock/in_transit
// and files a held line under its release-window SHIPMENT; the owner's release
// card lands the credit when the physical box arrives. Staff see NOTHING new —
// same buttons, same toasts, same request lifecycle.
import { holdActive, shipmentIdFor } from "./stockHoldCore";
import { recordHeldLine } from "./stockHoldStore";
import { canFulfilCard } from "../../utils/productIdentity";
import { SizeTag } from "../SizeTag";

const SOURCE_LOC = "central";
const HUB_LABEL = { hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3" };
// Sale-row ledger reasons — the Source Transfer & Fulfil contract (#209).
const SOURCE_REFILL_REASON = "source_refill";
const SOURCE_UNCOUNTED_REASON = "source_uncounted_send";

const TONE_COLOR = { normal: GRAY, amber: AMBER, red: RED };
const parseMs = (iso) => Date.parse(iso || "");
const fmtSaDateTime = (iso) => {
  const t = parseMs(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-GB", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

// Live-ticking server-corrected "now", once a minute for the whole queue.
function useNowMinute() {
  const [now, setNow] = useState(() => serverNowMs());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNowMs()), 60000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function AgePill({ elapsedMs, raisedIso }) {
  const tone = refillAgeTone(elapsedMs);
  const color = TONE_COLOR[tone];
  return (
    <span title={raisedIso ? `raised ${fmtSaDateTime(raisedIso)}` : undefined}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700,
                   color, border: `1px solid ${color}55`, background: `${color}14`, borderRadius: 999, padding: "3px 9px",
                   fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
      {tone === "red" && <span aria-hidden>●</span>}
      waiting {formatDuration(elapsedMs)}
    </span>
  );
}

function Photo({ url, photo }) {
  if (url) return <img src={url} alt="" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover", flexShrink: 0 }} />;
  return (
    <span style={{ width: 48, height: 48, borderRadius: 10, background: "rgba(255,255,255,.06)", display: "inline-flex",
                   alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{photo || ""}</span>
  );
}

// The one card surface — the app's navy card idiom (home page / hub cards).
const CARD = {
  background: "rgba(4,5,10,1)",
  border: "1px solid rgba(60,110,255,.45)",
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 0 10px rgba(60,110,255,.12)",
  fontFamily: FONT,
};
const BTN = {
  flex: 1, minHeight: 44, padding: "10px 12px", borderRadius: 10, cursor: "pointer",
  fontWeight: 700, fontSize: 13, fontFamily: FONT,
  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
};
const BTN_NEUTRAL = { ...BTN, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.03)", color: "rgba(255,255,255,.75)" };

// ─── THE SHARED SUPPLY PANEL ─────────────────────────────────────────────────
// One inline panel for every row: supply chips with live counted quantity, a
// stepper when more than one unit is open, one confirm. `capFor(avail)` and
// `uncountedWhen(avail)` carry the per-origin stock semantics (documented in
// the header) without changing what the runner sees.
function SupplyPanel({ sources, productId, size, destLabel, wantQty = 1, capFor, uncountedWhen, locationsReg,
                       onConfirm, onCancel, onWithoutTransfer }) {
  const [avail, setAvail] = useState(null);   // { locId: qty | null } — null = never counted
  const [pick, setPick] = useState(sources.length === 1 ? sources[0].id : null);
  // Default to the FULL open quantity (clamped by the cap once counts load) —
  // the same default the old fulfil panel had; sending everything asked is the
  // common case and one fewer tap.
  const [qty, setQty] = useState(Math.max(1, wantQty));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Keyed by ids, not array identity — the caller rebuilds `sources` per
  // render, and refetching one cell per parent re-render would be waste.
  const sourcesKey = sources.map((l) => l.id).join(",");
  useEffect(() => {
    let dead = false;
    (async () => {
      const out = {};
      for (const l of sources) {
        try {
          const snap = await get(ref(database, stockCellPath(l.id, productId, size)));
          const cell = snap.val();
          out[l.id] = cell && typeof cell.qty === "number" ? cell.qty : null;
        } catch { out[l.id] = null; }
      }
      if (dead) return;
      setAvail(out);
      setPick((p) => {
        if (p) return p;
        const best = sources.slice().sort((a, b) => (out[b.id] ?? -1) - (out[a.id] ?? -1))[0];
        return best ? best.id : null;
      });
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, size, sourcesKey]);

  const pickedAvail = pick && avail ? avail[pick] : undefined;
  const cap = Math.max(1, capFor(pickedAvail));
  const q = Math.max(1, Math.min(Math.round(qty) || 1, cap));
  const willNotDeduct = pick != null && avail != null && uncountedWhen(pickedAvail);

  const confirm = async () => {
    if (!pick || busy) return;
    setBusy(true); setErr(null);
    // finally, not tail: a rejection from onConfirm must never wedge the panel
    // at "Transferring…" with the button dead (CodeRabbit, PR #337).
    try {
      const res = await onConfirm(pick, q, pickedAvail);
      if (res && !res.ok) setErr(res.reason || "Transfer failed — retry.");
    } catch (e) {
      setErr(String(e?.message || e) || "Transfer failed — retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid rgba(60,110,255,.15)", paddingTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".8px", color: "rgba(255,255,255,.45)", marginBottom: 7 }}>SUPPLY FROM</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {sources.map((l) => {
          const a = avail ? avail[l.id] : undefined;
          const active = pick === l.id;
          return (
            <button key={l.id} onClick={() => setPick(l.id)} disabled={busy}
                    style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 40, padding: "7px 10px", borderRadius: 10,
                             border: active ? "1px solid rgba(60,110,255,.7)" : "1px solid rgba(255,255,255,.1)",
                             background: active ? "rgba(60,110,255,.16)" : "rgba(255,255,255,.03)",
                             color: active ? "#6A9FFF" : "rgba(255,255,255,.65)", fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: FONT }}>
              {l.label || labelFor(l.id, locationsReg)}
              <span style={{ fontSize: 10, fontWeight: 600, color: a == null ? "rgba(255,255,255,.35)" : (a > 0 ? GREEN : RED) }}>
                {avail == null ? "…" : (a == null ? "uncounted" : a)}
              </span>
            </button>
          );
        })}
      </div>
      {willNotDeduct && (
        <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginBottom: 8 }}>
          Not counted at {labelFor(pick, locationsReg)} — units will be added to {destLabel} only.
        </div>
      )}
      {cap > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.55)", fontWeight: 600 }}>Quantity</span>
          <button onClick={() => setQty(q - 1)} disabled={busy}
                  style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid rgba(255,255,255,.14)", background: "rgba(255,255,255,.04)", color: "#fff", fontWeight: 800, cursor: "pointer" }}>−</button>
          <span style={{ minWidth: 24, textAlign: "center", fontWeight: 800, color: "#fff", fontSize: 15 }}>{q}</span>
          <button onClick={() => setQty(q + 1)} disabled={busy}
                  style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid rgba(255,255,255,.14)", background: "rgba(255,255,255,.04)", color: "#fff", fontWeight: 800, cursor: "pointer" }}>+</button>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,.35)" }}>of {cap} open</span>
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: RED, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={confirm} disabled={busy || !pick} style={{ ...bGreen, flex: 1, minHeight: 44, opacity: busy || !pick ? 0.6 : 1 }}>
          {busy ? "Transferring…" : "Transfer & Fulfil"}
        </button>
        <button onClick={onCancel} disabled={busy} style={{ ...BTN_NEUTRAL, flex: "0 0 auto" }}>Cancel</button>
      </div>
      {onWithoutTransfer && (
        <button onClick={onWithoutTransfer} disabled={busy}
                style={{ marginTop: 8, width: "100%", padding: 7, borderRadius: 8, border: "none", background: "transparent", color: "rgba(255,255,255,.35)", fontSize: 10, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>
          Complete without stock transfer
        </button>
      )}
    </div>
  );
}

// ─── ONE CARD PER PRODUCT, EVERY SIZE INSIDE (owner correction 2026-08-08) ───
// The first cut rendered one box per (product, size) — five boxes for five
// sizes of one shoe. Corrected: all sizes of one product combine into ONE
// card, and each size keeps its own line with its own Fulfil / Out of Stock.
// A partial send DEDUCTS from the line — ask ×2, send 1 → ×1 stays on the
// list. The worked example still holds: Adi 2000 size 5 (sale) and size 7
// (hold) are two identical lines inside the same card, nothing marking either.
function SizeLine({ row, remaining, canAct, busy, msg, fulfilOpen, onToggleFulfil, onOutOfStock, panel }) {
  // Both origins carry accumulated progress now: a sale row's progress leaf,
  // a request row's sentQty tranches (CodeRabbit, PR #338).
  const sent = row.sent || 0;
  return (
    <div data-size={row.size} data-origin={row.origin} data-row={row.rowKey}
         style={{ borderTop: "1px solid rgba(255,255,255,.06)", marginTop: 10, paddingTop: 10,
                  opacity: busy ? 0.6 : 1, transition: "opacity 120ms ease" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7, minWidth: 74 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}><SizeTag size={row.size} /></span>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: BLUE, fontVariantNumeric: "tabular-nums" }}>×{remaining}</span>
          {sent > 0 && <span style={{ fontSize: 11, color: GRAY }}>· {sent} sent</span>}
        </span>
        <span style={{ flex: 1 }} />
        <button disabled={busy} onClick={onToggleFulfil}
                style={{ ...BTN, flex: "0 0 auto", padding: "10px 16px",
                         border: fulfilOpen ? "1px solid rgba(74,222,128,.5)" : "1px solid rgba(255,255,255,.12)",
                         background: fulfilOpen ? "rgba(74,222,128,.08)" : "rgba(255,255,255,.03)",
                         color: fulfilOpen ? GREEN : "rgba(255,255,255,.8)" }}>
          {canAct ? "Fulfil" : "Available"}
        </button>
        <button disabled={busy} onClick={onOutOfStock} style={{ ...BTN_NEUTRAL, flex: "0 0 auto", padding: "10px 14px", color: "rgba(255,255,255,.55)" }}>
          Out of Stock
        </button>
      </div>
      {fulfilOpen && canAct && panel}
      {msg && <div style={{ color: msg.includes("failed") ? RED : GREEN, fontSize: 12, fontWeight: 600, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

/**
 * `saleRows` / `completedSale` and the sale callbacks come from SourceView
 * (sale-driven feed): `onSaleResponse(row, "available"|"out_of_stock")` writes
 * the response record, `onSaleProgress(row, newSent, complete, meta)` the
 * partial-fulfil leaf, `onSaleUndo(cell)` clears a response. The Health
 * dashboard mounts this with none of them and gets the request-only list.
 * `lineFilter` is the Hub 2 SNEAKERS / CLOTHING toggle — a filter over the one
 * list, never a second list.
 */
export default function RefillQueue({ products = [], dest = "hub2", lineFilter = null,
                                      saleRows = [], completedSale = [],
                                      onSaleResponse = null, onSaleProgress = null, onSaleUndo = null,
                                      fulfilCtx = null }) {
  const DEST_LOC = dest;
  const destLabel = HUB_LABEL[dest] || dest;
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canTransfer = ["store", "warehouse", "admin"].includes(actorRole);

  const allRequests = useRefillRequests();
  const destCells = useStockCells(DEST_LOC);
  const engineOpen = useEngineOpen();
  const lockedIds = useMemo(() => lockedRefillIds(engineOpen), [engineOpen]);
  const now = useNowMinute();
  const engineConfig = useEngineConfig();
  const rawReleaseWindows = engineConfig?.releaseWindows;
  const windows = useMemo(() => parseReleaseTimes(rawReleaseWindows), [rawReleaseWindows]);
  // The held-credit switch (stockHoldCore.holdActive: RTDB enabled + windows
  // live + the leg crosses buildings). Read live so flipping the kill switch
  // takes effect on the NEXT fulfil, no reload.
  const stockHoldConfig = useStockHoldConfig();

  const [openRow, setOpenRow] = useState(null);      // rowKey with the fulfil panel open
  const [busyRow, setBusyRow] = useState(null);
  const [msg, setMsg] = useState({});                // rowKey → result line
  const [detailOpen, setDetailOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [releasingId, setReleasingId] = useState(null);
  const [releaseErr, setReleaseErr] = useState(null);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // (Parked source-gate needs were briefly rendered here, 2026-08-25 afternoon,
  // and REMOVED the same evening by owner order: this queue's waiting detail
  // means "what the 06:00/14:00 release will hand you" and nothing else.
  // Needs the source cannot fill stay where they always lived — Health's
  // Awaiting Transfer / Waiting for Supplier cards.)

  // Request rows for this destination, one row per request (per size already).
  const requestRows = useMemo(() => {
    let mine = allRequests.filter((r) => r.status === "open" && r.requestingLocation === DEST_LOC && r.productId);
    if (lineFilter) mine = mine.filter((r) => lineFilter(byId.get(r.productId), r.size));
    return mine.map((r) => {
      const p = byId.get(r.productId);
      return {
        origin: "request", rowKey: `req:${r.id}`, id: r.id,
        productId: r.productId, productName: p?.name || r.productId,
        photoUrl: p?.photoUrl || null, photo: "",
        size: String(r.size), qty: r.qty || 1, sent: Number(r.sentQty) || 0,
        createdAt: r.createdAt, createdMs: parseMs(r.createdAt),
        earlyRelease: r.earlyRelease, shadow: !!r.shadow, _r: r,
      };
    });
  }, [allRequests, DEST_LOC, lineFilter, byId]);

  // Gate EVERYTHING through the release windows — request rows and sale rows in
  // one partition, then the destination-shelf "already covered" split on the
  // released request rows only (a sale cell has no lock semantics).
  const { pick, waiting, covered, shadows } = useMemo(() => {
    const real = requestRows.filter((r) => !r.shadow);
    const shadows = requestRows.filter((r) => r.shadow);
    const gate = partitionReleased([...real, ...saleRows], now, windows);
    const releasedReq = gate.released.filter((r) => r.origin === "request");
    const releasedSale = gate.released.filter((r) => r.origin === "sale");
    const split = partitionSatisfied(releasedReq.map((r) => r._r), destCells, lockedIds);
    const okIds = new Set(split.actionable.map((r) => r.id));
    return {
      pick: sortQueueRows([...releasedReq.filter((r) => okIds.has(r.id)), ...releasedSale]),
      waiting: sortQueueRows(gate.waiting),
      covered: split.covered,
      shadows,
    };
  }, [requestRows, saleRows, now, windows, destCells, lockedIds]);

  // ── REQUEST-ROW ACTIONS — movement shapes unchanged (see header) ───────────
  // PARTIAL FULFILMENT (owner correction 2026-08-08): sending fewer units than
  // asked no longer closes the request — the sent tranche is deducted (qty
  // becomes the remainder, sentQty accumulates) and the line stays on the list
  // with the rest. Each tranche gets its own idempotent movement id: the FIRST
  // keeps the historic bare `rrf_{id}` (byte-identical to every movement ever
  // written by this queue), later tranches suffix the units already sent —
  // the same `${seed}_${alreadySent}` idiom the Source panel has always used.
  // History accumulates them per link.refillId (mergeRows), so the fulfilled
  // row reports the true total.
  const fulfilRequest = async (row, qty, avail) => {
    const r = row._r;
    let q = qty, liveQty = r.qty || 1, already = 0;
    // The live read is LOAD-BEARING for tranches and must not be skipped on
    // failure: proceeding with already=0 would rebuild tranche one's movement
    // id, applyMovement would swallow the send as a duplicate, and the request
    // could be marked fulfilled with units never moved (CodeRabbit, PR #338).
    try {
      const live = (await get(ref(database, `refill_requests/${r.id}`))).val();
      if (!live || live.status !== "open") return { ok: false, reason: "Request already resolved — it will leave the list on its own." };
      if (typeof live.qty === "number") liveQty = live.qty;
      already = Number(live.sentQty) || 0;
      if (q > liveQty) q = liveQty;
      if (q <= 0) return { ok: false, reason: "Nothing left to send on this request." };
    } catch { return { ok: false, reason: "Couldn't read the live request — check your connection and retry. Nothing was sent." }; }
    const counted = (Number(avail) || 0) > 0;
    const mvId = already === 0 ? `rrf_${r.id}` : `rrf_${r.id}_${already}`;
    // HOLD LANE: on, and this leg physically crosses buildings → the credit
    // parks at in_transit and the release card lands it when the box arrives.
    // The movement id is UNCHANGED, so a retry that races a config flip stays
    // idempotent; where the units actually went is read back off the recorded
    // movement (`to`), never re-guessed.
    const hold = holdActive({ config: stockHoldConfig, windows, from: SOURCE_LOC, to: DEST_LOC });
    const creditTo = hold ? IN_TRANSIT : DEST_LOC;
    let wentToTransit = hold;
    // Credit what ACTUALLY moved (the sourceMovementDedupe idiom): if this
    // tranche id already carries a recorded movement — a retry after a failed
    // bookkeeping write — do not re-send; credit the recorded quantity, which
    // may be smaller than the pick, so the remainder stays open instead of
    // being closed over units that never shipped.
    let appliedQty = q;
    let res;
    try {
      const prior = (await get(ref(database, `stock_movements/${mvId}`))).val();
      if (prior) {
        appliedQty = Math.min(Number(prior.qty) || 0, liveQty);
        if (appliedQty <= 0) return { ok: false, reason: "A previous send under this id couldn't be verified — retry." };
        res = { ok: true, idempotent: true };
        wentToTransit = prior.to === IN_TRANSIT;
      } else res = null;
    } catch { res = null; }
    try {
      if (!res) {
        res = await applyMovement(counted ? {
          type: "transfer_out", productId: r.productId, size: r.size, qty: q,
          from: SOURCE_LOC, to: creditTo, actorRole,
          reason: `${DEST_LOC}_auto_refill`,
          movementId: mvId,
          link: { refillId: r.id, ...(hold ? { holdDest: DEST_LOC } : {}) },
        } : {
          type: "received", productId: r.productId, size: r.size, qty: q,
          to: creditTo, actorRole,
          reason: `${DEST_LOC}_refill_uncounted`,
          movementId: mvId,
          link: { refillId: r.id, ...(hold ? { holdDest: DEST_LOC } : {}) },
        });
        // A concurrent send can land between the pre-check and this call;
        // applyMovement then replays idempotently WITHOUT moving stock. Credit
        // the recorded movement, never our own pick (Sonnet review, PR #338).
        if (res.ok && res.idempotent) {
          const recorded = (await get(ref(database, `stock_movements/${mvId}`))).val();
          appliedQty = Math.min(Number(recorded?.qty) || 0, liveQty);
          if (appliedQty <= 0) return { ok: false, reason: "Another device just sent this tranche — refresh before sending more." };
          wentToTransit = recorded?.to === IN_TRANSIT;
        }
      }
    } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
    if (!res.ok) return { ok: false, reason: `Transfer failed: ${res.reason || "unknown"} — retry.` };
    // The shipment line — what the release card releases and what the engine
    // reads as INBOUND. Written create-once under the movement id BEFORE the
    // request bookkeeping: if it fails, the whole fulfil reports as retryable
    // and the retry replays the movement idempotently. Stock parked with no
    // line would otherwise be invisible to the release card.
    if (wentToTransit) {
      const ship = shipmentIdFor(serverNowMs(), windows);
      if (ship) {
        const filed = await recordHeldLine({
          dest: DEST_LOC, lineId: mvId,
          productId: r.productId, productName: byId.get(r.productId)?.name || r.productId,
          size: r.size, sizeKey: stockSizeKey(r.size), qty: appliedQty,
          refillId: r.id, shipmentId: ship.id, windowLabel: ship.label,
          uncounted: !counted,
        });
        if (!filed.ok) return { ok: false, reason: `Sent, but the shipment line could not be saved (${filed.message || "write failed"}) — retry (stock will not move twice).` };
      }
    }
    const remaining = liveQty - appliedQty;
    if (remaining > 0) {
      // Deduct the sent tranche; the request stays OPEN for the remainder.
      //
      // ENGINE INTERPLAY (Sonnet review, PR #338 — assessed, deliberate): an
      // engine-LOCKED request also carries qty on its /refill_engine/open lock,
      // which this write does not touch (that node is the engine's own; rules
      // are console-managed). The desync is transient and CONVERGENT: the
      // tranche has already landed in /stock at the destination, so the next
      // scan's resize recomputes need = target − destHave = exactly this
      // remainder and writes BOTH nodes to it; if the tranche fully satisfied
      // the target, needGone withdraws the remainder as "no_longer_needed" —
      // the engine's long-standing rule for stock that arrived by any route.
      // Lock-less requests (Missing Sneakers, former holds) have no twin to
      // desync. Watch item recorded in the engine backlog.
      try {
        await update(ref(database), {
          [`refill_requests/${r.id}/qty`]: remaining,
          [`refill_requests/${r.id}/sentQty`]: already + appliedQty,
        });
      } catch { return { ok: false, reason: "Sent, but updating the remaining quantity failed — retry (stock will not move twice)." }; }
      setMsg((m) => ({ ...m, [row.rowKey]: `${appliedQty} sent → ${destLabel} ✓ · ${remaining} still open` }));
      return { ok: true };
    }
    try {
      await update(ref(database), {
        [`refill_requests/${r.id}/status`]: "fulfilled",
        [`refill_requests/${r.id}/fulfilledBy`]: { movementId: mvId, qty: appliedQty, ...(already ? { totalQty: already + appliedQty } : {}), ...(counted ? {} : { uncounted: true }) },
        [`refill_requests/${r.id}/resolvedAt`]: serverNowIso(),
        // A withdrawal landing between the re-read and this write must not
        // leave its stale reason on a row now marked fulfilled (Kimi, #332).
        [`refill_requests/${r.id}/cancelReason`]: null,
        ...(auth.currentUser?.uid ? { [`refill_requests/${r.id}/resolvedBy`]: auth.currentUser.uid } : {}),
      });
    } catch { return { ok: false, reason: "Sent, but marking it fulfilled failed — retry (stock will not move twice)." }; }
    setMsg((m) => ({ ...m, [row.rowKey]: `${appliedQty} unit${appliedQty === 1 ? "" : "s"} → ${destLabel} ✓` }));
    return { ok: true };
  };

  // Out of Stock on a request = the human rejection: cancelled with NO
  // cancelReason (the engine reads exactly that shape — cooldown + learning).
  const rejectRequest = async (row) => {
    if (busyRow || !canTransfer) return;
    setBusyRow(row.rowKey);
    const upd = {
      [`refill_requests/${row.id}/status`]: "cancelled",
      [`refill_requests/${row.id}/resolvedAt`]: serverNowIso(),
      [`refill_requests/${row.id}/rejectedBy`]: actorRole || "unknown",
      // Clear any stale reason from an earlier lifecycle, mirroring the fulfil
      // path: the engine recognises a HUMAN rejection precisely as "cancelled
      // with NO cancelReason" — a leftover reason would silently skip the
      // cooldown and confirmed-out learning (CodeRabbit, PR #337).
      [`refill_requests/${row.id}/cancelReason`]: null,
      ...(auth.currentUser?.uid ? { [`refill_requests/${row.id}/resolvedBy`]: auth.currentUser.uid } : {}),
    };
    try { await update(ref(database), upd); }
    catch { setMsg((m) => ({ ...m, [row.rowKey]: "failed — retry" })); }
    setBusyRow(null);
  };

  // ── SALE-ROW ACTIONS — the Source Transfer & Fulfil contract, unchanged ────
  const fulfilSale = async (row, pickLoc, qty, avail) => {
    const counted = typeof avail === "number";
    const mvId = `${row.movementIdSeed}_${row.sent}`;
    // HOLD LANE (same contract as fulfilRequest): a cross-building pick parks
    // the credit at in_transit under its release-window shipment. The pick
    // location decides — an uncounted send has no source leg and is treated as
    // Central's building (that is where the physical box leaves from).
    const hold = holdActive({ config: stockHoldConfig, windows, from: counted ? pickLoc : SOURCE_LOC, to: DEST_LOC });
    const creditTo = hold ? IN_TRANSIT : DEST_LOC;
    let wentToTransit = hold;
    let res, viaLegacy = false, appliedQty = qty;
    try {
      const dup = await checkSourceMovementDuplicate({
        getMovement: async (id) => (await get(ref(database, `stock_movements/${id}`))).val(),
        newId: mvId,
        legacyId: row.legacyMovementIdSeed ? `${row.legacyMovementIdSeed}_${row.sent}` : null,
        productId: row.resolvedId,
      });
      if (dup.duplicate) {
        viaLegacy = dup.viaLegacy;
        appliedQty = dup.appliedQty;
        res = { ok: true, idempotent: true };
        // Where the recorded movement actually put the units decides whether a
        // held line is owed — never the current config, which may have flipped.
        const recorded = (await get(ref(database, `stock_movements/${viaLegacy ? `${row.legacyMovementIdSeed}_${row.sent}` : mvId}`))).val();
        wentToTransit = recorded?.to === IN_TRANSIT;
      } else {
        res = await applyMovement(counted ? {
          type: "transfer_out", productId: row.resolvedId, size: row.size, qty,
          from: pickLoc, to: creditTo, actorRole,
          allowNegative: true,
          reason: SOURCE_REFILL_REASON,
          movementId: mvId, link: { refillId: row.movementIdSeed, ...(hold ? { holdDest: DEST_LOC } : {}) },
        } : {
          type: "received", productId: row.resolvedId, size: row.size, qty,
          to: creditTo, actorRole,
          reason: SOURCE_UNCOUNTED_REASON,
          movementId: mvId, link: { refillId: row.movementIdSeed, ...(hold ? { holdDest: DEST_LOC } : {}) },
        });
      }
    } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
    if (!res.ok) return { ok: false, reason: `Transfer failed: ${res.reason || "unknown"}. Check your stock access and retry.` };
    if (wentToTransit) {
      const ship = shipmentIdFor(serverNowMs(), windows);
      if (ship) {
        const filed = await recordHeldLine({
          dest: DEST_LOC, lineId: mvId,
          productId: row.resolvedId, productName: row.productName || row.resolvedId,
          size: row.size, sizeKey: stockSizeKey(row.size), qty: appliedQty,
          refillId: row.movementIdSeed, shipmentId: ship.id, windowLabel: ship.label,
          uncounted: !counted,
        });
        if (!filed.ok) return { ok: false, reason: `Sent, but the shipment line could not be saved (${filed.message || "write failed"}) — retry (stock will not move twice).` };
      }
    }
    const newSent = row.sent + appliedQty;
    onSaleProgress?.(row, newSent, newSent >= row.qty, { lastFrom: pickLoc, counted, ...(viaLegacy ? { viaLegacyMovementId: true } : {}) });
    setMsg((m) => ({ ...m, [row.rowKey]: `${appliedQty} unit${appliedQty === 1 ? "" : "s"} → ${destLabel} ✓` }));
    return { ok: true };
  };

  // URGENT OVERRIDE — admin releases ONE request early; reason required,
  // recorded with the uid; the stamp releases the row for everyone.
  const releaseNow = async (row) => {
    if (releasingId || actorRole !== "admin") return;
    const reason = window.prompt("Release this request ahead of the window?\nReason (required — recorded with your account):");
    if (reason == null) return;
    const patch = releaseEarlyPatch({ nowIso: serverNowIso(), uid: auth.currentUser?.uid || null, reason });
    if (!patch) { setReleaseErr("A reason is required — nothing was released."); return; }
    setReleasingId(row.id); setReleaseErr(null);
    try { await update(ref(database, `refill_requests/${row.id}`), patch); }
    catch (e) { setReleaseErr(`Early release failed — ${String(e?.message || e)}`); }
    setReleasingId(null);
  };

  // ── THE ONE STATUS LINE — tap for the waiting/covered detail ───────────────
  const unitsOf = (rows) => rows.reduce((n, r) => n + (Number(r.qty) || 1), 0);
  const statusText = queueStatusLine({
    pickCount: pick.length,
    pickUnits: unitsOf(pick),
    waitingCount: waiting.length,
    waitingUnits: unitsOf(waiting),
    coveredCount: covered.length,
    windowsDisabled: windows.disabled,
    nextLabel: windows.disabled ? "" : saTimeLabel(nextReleaseMs(now, windows)),
  });
  const hasDetail = waiting.length > 0 || covered.length > 0;
  const statusLine = (
    <button type="button" onClick={() => hasDetail && setDetailOpen((v) => !v)}
            style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent",
                     color: GRAY, fontSize: 12.5, fontFamily: FONT, padding: "4px 2px", margin: "0 0 10px",
                     cursor: hasDetail ? "pointer" : "default", lineHeight: 1.5 }}>
      {statusText}{hasDetail ? (detailOpen ? " ▴" : " ▾") : ""}
      {releaseErr && <span style={{ color: RED, fontWeight: 600 }}> · {releaseErr}</span>}
    </button>
  );

  const detail = detailOpen && hasDetail && (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0 0 12px" }}>
      {/* One card per PRODUCT, its sizes as lines (owner ask 2026-08-25) —
          the same shape the pick list renders, so "Air Jordan 4 · 4 ×1 · 5 ×2"
          is one card, not three. Release now stays PER LINE: early release is
          a per-request act and must never release a sibling size silently. */}
      {groupRowsByProduct(waiting).map((g) => (
        <div key={`wait-${g.key}`} style={{ ...CARD, padding: "9px 12px", opacity: 0.85 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Photo url={g.photoUrl} photo={g.photo} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.productName}</span>
            {Number.isFinite(g.oldestMs) && g.oldestMs !== Infinity && <AgePill elapsedMs={now - g.oldestMs} raisedIso={g.oldestIso} />}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {g.rows.map((row) => (
              <div key={row.rowKey} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, fontSize: 12, color: GRAY }}>size {String(row.size)} ×{row.qty || 1} · raised {fmtSaDateTime(row.createdAt)}</span>
                {actorRole === "admin" && row.origin === "request" && (
                  <button onClick={() => releaseNow(row)} disabled={releasingId !== null}
                          style={{ border: "1px solid rgba(74,127,255,.5)", background: "rgba(74,127,255,.12)", color: "#cfe0ff",
                                   borderRadius: 9, minHeight: 34, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                                   opacity: releasingId !== null ? 0.5 : 1, flexShrink: 0, fontFamily: FONT }}>
                    {releasingId === row.id ? "Releasing…" : "Release now"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {covered.map((r) => (
        <div key={`cov-${r.id}`} style={{ ...CARD, padding: "9px 12px", opacity: 0.85 }}>
          <span style={{ fontSize: 12, color: GRAY }}>
            <b style={{ color: GREEN }}>Already covered:</b>{" "}
            <b style={{ color: "rgba(255,255,255,.85)" }}>{byId.get(r.productId)?.name || r.productId}</b>{" "}
            size {String(r.size)} — asked ×{r.qty || 1}, {r.onHand} on the shelf at {destLabel}. The engine withdraws it on its next scan.
          </span>
        </div>
      ))}
    </div>
  );

  // ── CARDS — one per product, its sizes as lines inside ─────────────────────
  const cards = useMemo(() => {
    const byKey = new Map();
    for (const row of pick) {
      const k = row.productId || `name:${row.productName}`;
      if (!byKey.has(k)) byKey.set(k, { key: k, productName: row.productName, photoUrl: row.photoUrl, photo: row.photo, rows: [], oldestMs: Infinity, oldestIso: null });
      const c = byKey.get(k);
      c.rows.push(row);
      if (!c.photoUrl && row.photoUrl) c.photoUrl = row.photoUrl;
      const m = Number.isFinite(row.createdMs) ? row.createdMs : Infinity;
      if (m < c.oldestMs) { c.oldestMs = m; c.oldestIso = row.createdAt; }
    }
    const out = [...byKey.values()];
    for (const c of out) c.rows.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    // Longest-waiting product first — a card's age is its OLDEST ask.
    return out.sort((a, b) => a.oldestMs - b.oldestMs);
  }, [pick]);

  const renderSizeLine = (row) => {
    const isReq = row.origin === "request";
    const resolvedId = isReq ? row.productId : (fulfilCtx ? fulfilCtx.resolveId({ productId: row.productId, productName: row.productName }) : null);
    const canAct = isReq ? canTransfer : (!!fulfilCtx && canFulfilCard({ enabled: fulfilCtx.canTransfer, productId: resolvedId }));
    const saleRow = isReq ? null : { ...row, resolvedId };
    // For a request row qty IS the remainder (partial sends deduct it in the
    // DB); a sale row nets its progress leaf locally.
    const remaining = isReq ? (row.qty || 1) : Math.max(1, (row.qty || 1) - (row.sent || 0));
    const sources = isReq
      ? [{ id: SOURCE_LOC, label: "Central" }]
      : warehouseLocations(fulfilCtx?.locationsReg).filter((l) => l.id !== DEST_LOC);
    const panel = (
      <SupplyPanel
        sources={sources}
        productId={resolvedId}
        size={row.size}
        destLabel={destLabel}
        wantQty={remaining}
        locationsReg={fulfilCtx?.locationsReg}
        // Per-origin stock semantics, folded behind the one button (see header).
        capFor={isReq
          ? (avail) => ((Number(avail) || 0) > 0 ? Math.min(remaining, Number(avail)) : remaining)
          : () => remaining}
        uncountedWhen={isReq ? (avail) => !((Number(avail) || 0) > 0) : (avail) => typeof avail !== "number"}
        onConfirm={async (pickLoc, q, avail) => {
          setBusyRow(row.rowKey);
          try {
            const res = isReq ? await fulfilRequest(row, q, avail) : await fulfilSale(saleRow, pickLoc, q, avail);
            if (res.ok) setOpenRow(null);
            return res;
          } finally {
            setBusyRow(null);   // a throw must not leave the row disabled forever
          }
        }}
        onCancel={() => setOpenRow(null)}
        onWithoutTransfer={isReq ? null : () => { setOpenRow(null); onSaleResponse?.(row, "available"); }}
      />
    );
    return (
      <SizeLine key={row.rowKey}
        row={row} remaining={remaining}
        canAct={canAct}
        busy={busyRow === row.rowKey || (isReq && !canTransfer)}
        msg={msg[row.rowKey]}
        fulfilOpen={openRow === row.rowKey && canAct}
        onToggleFulfil={() => {
          if (!canAct) { if (!isReq) onSaleResponse?.(row, "available"); return; }
          setOpenRow(openRow === row.rowKey ? null : row.rowKey);
        }}
        onOutOfStock={() => { isReq ? rejectRequest(row) : onSaleResponse?.(row, "out_of_stock"); }}
        panel={panel}
      />
    );
  };

  const cardEls = cards.map((card) => (
    <div key={card.key} style={CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Photo url={card.photoUrl} photo={card.photo} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#fff", fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.productName}</div>
          <div style={{ fontSize: 11.5, color: GRAY, marginTop: 2 }}>
            {card.rows.length} size{card.rows.length === 1 ? "" : "s"}
          </div>
        </div>
        {Number.isFinite(card.oldestMs) && card.oldestMs !== Infinity && (
          <AgePill elapsedMs={now - card.oldestMs} raisedIso={card.oldestIso} />
        )}
      </div>
      {card.rows.map(renderSizeLine)}
    </div>
  ));

  // Shadow previews (engine shadow mode) — read-only, never actionable.
  const shadowEls = shadows.map((row) => (
    <div key={row.rowKey} style={{ ...CARD, opacity: 0.7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Photo url={row.photoUrl} photo={row.photo} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: "#fff", fontSize: 14 }}>{row.productName}</div>
          <div style={{ fontSize: 11, color: AMBER, marginTop: 3 }}>size {row.size} ×{row.qty || 1} · shadow preview — the engine would raise this in Live Mode. Nothing to action.</div>
        </div>
      </div>
    </div>
  ));

  // Completed sale cells (today) behind one quiet line — the Undo path.
  const completedBlock = completedSale.length > 0 && (
    <div style={{ marginTop: 14 }}>
      <button type="button" onClick={() => setCompletedOpen((v) => !v)}
              style={{ border: "none", background: "transparent", color: GRAY, fontSize: 12, fontWeight: 600,
                       cursor: "pointer", padding: "8px 2px", fontFamily: FONT }}>
        Completed today · {completedSale.length} {completedOpen ? "▴" : "▾"}
      </button>
      {completedOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {completedSale.map((c) => {
            const isAvail = c.response === "available";
            return (
              <div key={`done:${c.date}:${c.key}:${c.size}`} style={{ ...CARD, display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", opacity: 0.85 }}>
                <Photo url={c.photoUrl} photo={c.photo} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.productName}</span>
                  <span style={{ display: "block", fontSize: 11, color: isAvail ? GREEN : RED, fontWeight: 700 }}>
                    size {c.size}{c.qty > 1 ? ` ×${c.qty}` : ""} · {isAvail ? "Fulfilled" : "Out of Stock"}
                  </span>
                </span>
                <button onClick={() => onSaleUndo?.(c)}
                        style={{ ...BTN_NEUTRAL, flex: "0 0 auto", minHeight: 40, fontSize: 11 }}>Undo</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ paddingBottom: 30, fontFamily: FONT }}>
      {statusLine}
      {detail}
      {!canTransfer && pick.length > 0 && (
        <div style={{ color: AMBER, fontSize: 11.5, margin: "0 2px 10px" }}>You need a stock role to transfer — viewing only.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cardEls}
        {shadowEls}
      </div>
      {completedBlock}
    </div>
  );
}

// ─── EXCESS INVENTORY — Hub → Central (sneakers-only) ─────────────────────────
// The Inventory Health "Excess Inventory" tab (HealthView.jsx, case "excess").
// The pre-existing store-source clothing excess screen (MoveExcess.jsx, still
// mounted at Stock → Move Excess) is UNTOUCHED — this is a separate screen.
//
// ── DELIBERATE, REVERSED (owner, 2026-09-03) ─────────────────────────────────
// This screen originally shipped as one circular button per product that moved
// EVERY size at once, with no confirmation and no way to send less. The owner
// reversed that: "the transfer is too sensitive". A transfer moves real stock
// between buildings, so the operator must be able to see the sizes, send FEWER
// than the full excess, and press a button that says where the stock is going.
// So:
//   • cards COLLAPSE — a tap opens one (accordion; only one open at a time)
//   • each size is a stepper, defaulting to the full excess, adjustable DOWN
//   • one Transfer button per card, naming source and destination in words
// The earlier "numbers only, no sentences" rule is superseded for this screen:
// an operator moving stock between buildings is told, in words, what will
// happen. Nothing about the excess MATH changed.
//
// ── THE CLAMP ────────────────────────────────────────────────────────────────
// A stepper's max is that size's computed excess — 6 can be sent as 5, 1 or 0,
// never as 7. Going above the excess would pull the cell BELOW its Keep
// number, which is the invariant this whole screen exists to protect. The
// clamp lives in SizeStepperChip (healthWidgets.jsx:171-173, min 0 / max) and
// again in the transfer path, so a bad edit cannot reach applyMovement.
//
// DATA: computeHubSneakerExcess() (excessComputation.js) — the excess math is
// not reimplemented here. Clothing excess comes from computeHubClothingExcess(),
// which self-gates on config/refillEngine/excessClothingEnabled and returns []
// while that key is absent/false: zero clothing cards by default, restored by
// flipping one RTDB key with no code change and no deploy.
//
// MOVEMENT: the SAME action the existing excess button calls —
// applyMovement({type:"transfer_out", from, to:"central", ...}), exactly as
// MoveExcess.jsx:286-292 does. No second movement path, no direct stock-cell
// write. applyMovement RESOLVES { ok, reason } rather than throwing, so every
// line's result is inspected: a card is retired only when EVERY line it sent
// landed, and Undo reverses only the lines that really moved.
//
// VIRTUALIZATION: no react-window/react-virtual in this codebase — a
// hand-rolled windowed list over an explicit offsets array (one collapsed
// height per card, plus the measured height of the single open card). The
// offsets loop is O(cards) per render, which at a few hundred cards is
// nothing, and it stays exact when a card opens instead of guessing.

import React, { useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import { useStockCells, useStockTargets, useEngineConfig, useRefillRequests } from "./useStock";
import {
  computeHubSneakerExcess,
  computeHubClothingExcess,
  reservedByHubFromOpenRequests,
  EXCESS_HUB_LOCATIONS,
} from "./excessComputation";
import { applyMovement } from "./applyMovement";
import { encodeSizeKey } from "../../utils/sizeKey";
import { serverNowMs } from "../../utils/serverTime";
import { sizeRank } from "./hubSizeRank";
import { SizeStepperChip, CHIP_GRID } from "./healthWidgets";
import { GLASS, GRAY, GREEN, BLUE_L, FONT } from "./ui";

const HUB_LABEL = { hub1: "Hub 1", hub2: "Hub 2" };
const DEST_KEY   = "central";      // the /stock location key
const DEST_LABEL = "Central";      // what the operator is shown
const COLLAPSED_H = 78;   // one collapsed card incl. its 8px gap
const OVERSCAN = 4;
const UNDO_MS = 5000;
const EXIT_MS = 220;      // must match the card's CSS transition below

export default function ExcessHubToCentral({ products = [], actorRole }) {
  const allStock = useStockCells();
  const allTargets = useStockTargets();
  const config = useEngineConfig();
  const openRequests = useRefillRequests("open");

  const productsById = useMemo(() => {
    const out = {};
    for (const p of products) if (p?.id) out[p.id] = p;
    return out;
  }, [products]);

  // config.routes is the engine's third fallback for "which hub fulfils this
  // request" — see reservedByHubFromOpenRequests.
  const reserved = useMemo(
    () => reservedByHubFromOpenRequests(openRequests, config?.routes),
    [openRequests, config],
  );

  const [hub, setHub] = useState(EXCESS_HUB_LOCATIONS[0] || "hub1");
  const [openKey, setOpenKey] = useState(null);          // the one expanded card
  const [edits, setEdits] = useState({});                // `${loc}|${pid}|${size}` -> qty
  const [movedKeys, setMovedKeys] = useState(() => new Set());
  const [leavingKeys, setLeavingKeys] = useState(() => new Set());
  const [busyKey, setBusyKey] = useState(null);
  const [undo, setUndo] = useState(null);

  const ctx = useMemo(
    () => ({ products: productsById, stock: allStock, targets: allTargets, config }),
    [productsById, allStock, allTargets, config],
  );

  // Sneakers always; clothing only while the flag is on (returns [] otherwise).
  const rows = useMemo(() => [
    ...computeHubSneakerExcess(ctx, reserved, { locations: [hub] }),
    ...computeHubClothingExcess(ctx, reserved, { locations: [hub] }),
  ], [ctx, reserved, hub]);

  const cards = useMemo(() => {
    const byPid = new Map();
    for (const r of rows) {
      const key = `${r.loc}|${r.pid}`;
      if (movedKeys.has(key)) continue;
      let c = byPid.get(r.pid);
      if (!c) {
        const p = productsById[r.pid];
        c = { key, loc: r.loc, pid: r.pid, name: p?.name || r.pid, photo: p?.photoUrl || null, sizes: [], excessTotal: 0 };
        byPid.set(r.pid, c);
      }
      c.sizes.push({ size: r.size, excess: r.excess });
      c.excessTotal += r.excess;
    }
    const out = Array.from(byPid.values());
    for (const c of out) c.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    out.sort((a, b) => b.excessTotal - a.excessTotal || a.name.localeCompare(b.name));
    return out;
  }, [rows, productsById, movedKeys]);

  // A size's chosen quantity: the operator's edit if there is one, otherwise
  // the full excess. Always re-clamped to [0, excess] on read, so a stale edit
  // left over from a larger excess can never exceed today's.
  const qtyFor = useCallback(
    (card, s) => {
      const e = edits[`${card.loc}|${card.pid}|${s.size}`];
      return Math.max(0, Math.min(s.excess, e == null ? s.excess : e));
    },
    [edits],
  );
  const chosenTotal = useCallback(
    (card) => card.sizes.reduce((t, s) => t + qtyFor(card, s), 0),
    [qtyFor],
  );

  const unitTotal = cards.reduce((t, c) => t + c.excessTotal, 0);

  // Once live stock catches up the row is gone on its own merit and the
  // optimistic entry must be dropped — otherwise a product that legitimately
  // goes back above target later would stay invisible for the whole session.
  const liveKeys = useMemo(() => new Set(rows.map((r) => `${r.loc}|${r.pid}`)), [rows]);
  useEffect(() => {
    setMovedKeys((prev) => {
      if (!prev.size) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const k of prev) if (!liveKeys.has(k)) { next.delete(k); changed = true; }
      return changed ? next : prev;
    });
  }, [liveKeys]);

  // ── movement ─────────────────────────────────────────────────────────────
  // Returns the lines that ACTUALLY moved. applyMovement resolves {ok, reason}
  // on a rejected write instead of throwing, so ok is checked explicitly.
  const doMove = useCallback(async (pid, lines, from, to) => {
    const batchId = `exchc_${serverNowMs().toString(36)}`;
    const moved = [];
    for (const s of lines) {
      if (!(s.qty > 0)) continue;
      let res;
      try {
        res = await applyMovement({
          type: "transfer_out", productId: pid, size: s.size, qty: s.qty,
          from, to, actorRole, reason: "excess_rebalance",
          movementId: `${batchId}_${pid}_${encodeSizeKey(s.size)}_${from}_${to}`,
          link: { transferId: batchId },
        });
      } catch (e) { res = { ok: false, reason: String(e?.message || e) }; }
      if (res?.ok) moved.push(s);
    }
    return moved;
  }, [actorRole]);

  const transfer = useCallback((card) => {
    if (busyKey || movedKeys.has(card.key) || leavingKeys.has(card.key)) return;
    // Re-clamped here as well as in the stepper: nothing above a size's excess
    // may reach applyMovement, or the cell would end below Keep.
    const lines = card.sizes
      .map((s) => ({ size: s.size, qty: Math.max(0, Math.min(s.excess, qtyFor(card, s))) }))
      .filter((s) => s.qty > 0);
    if (!lines.length) return;

    const sentAll = lines.length === card.sizes.length
      && lines.every((l, i) => l.qty === card.sizes[i].excess);

    setBusyKey(card.key);
    setLeavingKeys((prev) => new Set(prev).add(card.key));
    const animated = new Promise((resolve) => setTimeout(resolve, EXIT_MS));

    Promise.all([doMove(card.pid, lines, card.loc, DEST_KEY), animated]).then(([moved]) => {
      setBusyKey(null);
      setLeavingKeys((prev) => { const n = new Set(prev); n.delete(card.key); return n; });
      if (!moved.length) return;   // nothing moved — the card stays exactly as it was

      // A card is retired only when everything it SENT landed AND it sent its
      // whole excess. A partial send, or a partly-failed one, leaves the card
      // up so the live recompute can redraw whatever is still over target —
      // the optimistic hide is keyed by product, so retiring it early would
      // hide the remainder for the rest of the session.
      if (moved.length === lines.length && sentAll) {
        setMovedKeys((prev) => new Set(prev).add(card.key));
        setOpenKey((k) => (k === card.key ? null : k));
      }
      // Edits are cleared either way: quantities must recompute from the
      // moved-down live stock, never linger from the pre-transfer render.
      setEdits((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) if (k.startsWith(`${card.loc}|${card.pid}|`)) delete next[k];
        return next;
      });

      const total = moved.reduce((t, s) => t + s.qty, 0);
      setUndo((prev) => {
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => setUndo((u) => (u && u.key === card.key ? null : u)), UNDO_MS);
        return { key: card.key, hub: card.loc, pid: card.pid, name: card.name, lines: moved, total, timer };
      });
    });
  }, [busyKey, movedKeys, leavingKeys, doMove, qtyFor]);

  const undoNow = useCallback(() => {
    if (!undo) return;
    clearTimeout(undo.timer);
    const u = undo;
    setUndo(null);
    // movedKeys is cleared whatever the reversal returns, deliberately. Once
    // the key is gone the card is a pure function of live stock again, so a
    // reversal that only partly landed redraws as whatever is ACTUALLY on the
    // shelf. Holding the card back would hide real units behind a stale flag.
    doMove(u.pid, u.lines, DEST_KEY, u.hub).then(() => {
      setMovedKeys((prev) => { const n = new Set(prev); n.delete(u.key); return n; });
    });
  }, [undo, doMove]);

  useEffect(() => () => { if (undo) clearTimeout(undo.timer); }, [undo]);

  // ── windowing over an explicit offsets array ─────────────────────────────
  const scrollerRef = useRef(null);
  const openRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [openH, setOpenH] = useState(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const onResize = () => setViewportH(el.clientHeight || 600);
    onResize();
    el.addEventListener("scroll", onScroll, { passive: true });
    if (typeof window !== "undefined") window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
    };
  }, []);

  // Measure the one open card rather than predicting its height from the size
  // count — chips wrap by available width, so a prediction would drift.
  useLayoutEffect(() => {
    if (!openKey) { setOpenH(0); return; }
    const h = openRef.current?.getBoundingClientRect?.().height;
    if (h) setOpenH(h + 8);
  }, [openKey, cards, edits]);

  const openIdx = openKey ? cards.findIndex((c) => c.key === openKey) : -1;
  const offsets = useMemo(() => {
    const out = new Array(cards.length + 1);
    let y = 0;
    for (let i = 0; i < cards.length; i++) {
      out[i] = y;
      y += (i === openIdx && openH ? openH : COLLAPSED_H);
    }
    out[cards.length] = y;
    return out;
  }, [cards.length, openIdx, openH]);

  const totalH = offsets[cards.length] || 0;
  let start = 0;
  while (start < cards.length && offsets[start + 1] < scrollTop) start++;
  let end = start;
  while (end < cards.length && offsets[end] < scrollTop + viewportH) end++;
  const from = Math.max(0, start - OVERSCAN);
  const to = Math.min(cards.length, end + OVERSCAN);
  const visible = cards.slice(from, to);

  return (
    <div>
      <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{HUB_LABEL[hub] || hub} → {DEST_LABEL}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", borderRadius: 999, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.03)", padding: 2 }}>
            {EXCESS_HUB_LOCATIONS.map((h) => (
              <button key={h} onClick={() => { setHub(h); setOpenKey(null); }} aria-pressed={hub === h}
                style={{
                  padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer", fontFamily: FONT,
                  fontSize: 12, fontWeight: 700,
                  background: hub === h ? "rgba(74,127,255,.18)" : "transparent",
                  color: hub === h ? BLUE_L : GRAY,
                }}>
                {HUB_LABEL[h] || h}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 12, fontWeight: 800, color: BLUE_L, background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.3)", borderRadius: 999, padding: "5px 12px", whiteSpace: "nowrap" }}>
            {cards.length} product{cards.length === 1 ? "" : "s"} · {unitTotal} unit{unitTotal === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div ref={scrollerRef} style={{ height: "calc(100vh - 260px)", minHeight: 320, overflowY: "auto", position: "relative" }}>
        <div style={{ height: totalH, position: "relative" }}>
          {visible.map((c, i) => {
            const idx = from + i;
            const isOpen = c.key === openKey;
            return (
              <div key={c.key}
                ref={isOpen ? openRef : null}
                style={{
                  position: "absolute", left: 0, right: 0, top: offsets[idx],
                  transition: `opacity ${EXIT_MS - 20}ms ease, transform ${EXIT_MS - 20}ms ease`,
                  opacity: leavingKeys.has(c.key) ? 0 : 1,
                  transform: leavingKeys.has(c.key) ? "scale(0.98)" : "scale(1)",
                  pointerEvents: leavingKeys.has(c.key) ? "none" : "auto",
                }}>
                <Card
                  card={c} open={isOpen} busy={busyKey === c.key}
                  hubLabel={HUB_LABEL[c.loc] || c.loc}
                  qtyFor={qtyFor} chosen={chosenTotal(c)}
                  onToggle={() => setOpenKey(isOpen ? null : c.key)}
                  onQty={(size, q) => setEdits((prev) => ({ ...prev, [`${c.loc}|${c.pid}|${size}`]: q }))}
                  onTransfer={() => transfer(c)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {undo && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 80, display: "flex", justifyContent: "center", padding: "0 12px 16px" }}>
          <div style={{ ...GLASS, background: "#0a0e18", display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderRadius: 999, boxShadow: "0 20px 50px -18px rgba(0,0,0,.8)" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "#fff" }}>
              Sent {undo.total} to {DEST_LABEL}
            </span>
            <button onClick={undoNow} style={{
              background: "rgba(74,127,255,.16)", border: "1px solid rgba(74,127,255,.45)", color: BLUE_L,
              borderRadius: 999, padding: "8px 18px", fontWeight: 800, fontSize: 12.5, cursor: "pointer", fontFamily: FONT,
            }}>
              Undo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ card, open, busy, hubLabel, qtyFor, chosen, onToggle, onQty, onTransfer }) {
  return (
    <div style={{ ...GLASS, padding: open ? "10px 12px 12px" : "10px 12px", boxSizing: "border-box" }}>
      <div onClick={onToggle} role="button" aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", height: 50 }}>
        <div style={{ width: 50, height: 50, borderRadius: 11, flexShrink: 0, overflow: "hidden", background: "rgba(60,110,255,.1)" }}>
          {card.photo && <img src={card.photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {card.name}
          </div>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>
            {card.sizes.length} size{card.sizes.length === 1 ? "" : "s"} · {card.excessTotal} over target
          </div>
        </div>
        <span style={{
          flexShrink: 0, fontSize: 13, fontWeight: 800, color: GREEN, background: "rgba(74,222,128,.14)",
          border: "1px solid rgba(74,222,128,.4)", borderRadius: 999, padding: "6px 12px", whiteSpace: "nowrap",
        }}>
          {card.excessTotal}
        </span>
        <span style={{ flexShrink: 0, color: GRAY, fontSize: 12, width: 14, textAlign: "center" }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div>
          <div style={CHIP_GRID}>
            {card.sizes.map((s) => (
              <SizeStepperChip
                key={s.size} size={s.size} qty={qtyFor(card, s)} max={s.excess}
                hint={`of ${s.excess}`} disabled={busy}
                onChange={(q) => onQty(s.size, q)}
              />
            ))}
          </div>
          <button onClick={onTransfer} disabled={busy || chosen <= 0}
            style={{
              marginTop: 12, width: "100%", padding: "12px 14px", borderRadius: 12, fontFamily: FONT,
              border: `1px solid ${chosen > 0 ? "rgba(74,222,128,.5)" : "rgba(255,255,255,.12)"}`,
              background: chosen > 0 ? "rgba(74,222,128,.16)" : "rgba(255,255,255,.04)",
              color: chosen > 0 ? GREEN : GRAY,
              fontSize: 13.5, fontWeight: 800,
              cursor: busy || chosen <= 0 ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}>
            {busy
              ? `Transferring ${chosen} to ${DEST_LABEL}…`
              : `Transfer ${chosen} ${chosen === 1 ? "unit" : "units"} · ${hubLabel} → ${DEST_LABEL}`}
          </button>
        </div>
      )}
    </div>
  );
}

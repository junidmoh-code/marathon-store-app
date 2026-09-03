// ─── EXCESS INVENTORY — Hub → Central (sneakers-only) ─────────────────────────
// Commit 4 of the excess-sneakers-hub-to-central build (docs/EXCESS-SNEAKERS.md).
// Replaces this tab's rendered content in HealthView.jsx ("Excess Inventory"
// stat card → "excess" drill-in). The pre-existing store-source clothing
// excess screen (MoveExcess.jsx, still mounted at Stock → Move Excess) is
// UNTOUCHED — this is a separate, additive screen for a different tab.
//
// Numbers and movement only, no on-screen sentences (owner spec):
//   • Header: "Hub 1 → Central" / "Hub 2 → Central" (matches the segmented
//     control), plus one count pill "N products · M units".
//   • One card per product per hub, single column, sorted by total movable
//     units descending: square photo, one-line truncated name, a horizontally
//     scrollable row of "<size> · <units>" chips, and a circular button on the
//     right showing the card's total — tapping it moves EVERY size on the
//     card in one go.
//   • No confirmation dialog. Tap → applyMovement (transfer_out, hub → central)
//     for every size line → card animates out → count pill decrements → a
//     5-second Undo affordance appears at the bottom (a compensating
//     transfer_out, central → hub, same quantities). After 5s the move is final.
//   • No tooltips / helper text / banners.
//
// DATA: computeHubSneakerExcess() (src/components/stock/excessComputation.js,
// Commit 3) — the excess math is not reimplemented here. Clothing excess is
// additionally offered by computeHubClothingExcess(), which self-gates on
// config/refillEngine/excessClothingEnabled and returns [] while that key is
// absent/false — so clothing contributes ZERO cards by default and is turned
// back on by flipping one RTDB key, with no code change and no deploy.
//
// MOVEMENT: the SAME action the existing excess button calls —
// applyMovement({type:"transfer_out", from, to, ...}), exactly as
// MoveExcess.jsx:286-292 does with to:"central". No second movement path, no
// direct stock-cell write. applyMovement RESOLVES { ok, reason } rather than
// throwing on a rejected write, so every line's result is inspected: a card
// only stays retired if at least one of its lines actually moved, and Undo
// only reverses the lines that really did.
//
// VIRTUALIZATION: no react-window/react-virtual in this codebase (checked
// package.json + src) — a hand-rolled fixed-row-height windowed list is used
// instead (see ROW_HEIGHT below). Chips scroll horizontally within a card so
// every card keeps the same height regardless of how many armed sizes it has,
// which is what makes fixed-height windowing safe here.

import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
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
import { GLASS, GRAY, GREEN, BLUE_L, FONT } from "./ui";

const HUB_LABEL = { hub1: "Hub 1", hub2: "Hub 2" };
const ROW_HEIGHT = 78;   // fixed card height incl. margin — see VIRTUALIZATION note above
const OVERSCAN = 6;
const UNDO_MS = 5000;
const EXIT_MS = 220;     // must match the card's CSS transition duration below

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

  const reserved = useMemo(() => reservedByHubFromOpenRequests(openRequests), [openRequests]);

  const [hub, setHub] = useState(EXCESS_HUB_LOCATIONS[0] || "hub1");
  // Cards retired this session (optimistic — hides instantly, ahead of the live
  // RTDB round trip), or put back when a move failed / was undone.
  const [movedKeys, setMovedKeys] = useState(() => new Set());
  const [leavingKeys, setLeavingKeys] = useState(() => new Set());
  const [undo, setUndo] = useState(null);   // { key, hub, pid, lines:[{size,qty}], total, timer }

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
        c = { key, loc: r.loc, pid: r.pid, name: p?.name || r.pid, photo: p?.photoUrl || null, sizes: [], total: 0 };
        byPid.set(r.pid, c);
      }
      c.sizes.push({ size: r.size, qty: r.excess });
      c.total += r.excess;
    }
    const out = Array.from(byPid.values());
    for (const c of out) c.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
    out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return out;
  }, [rows, productsById, movedKeys]);

  const unitTotal = cards.reduce((t, c) => t + c.total, 0);

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

  // ── move + undo ──────────────────────────────────────────────────────────
  // Returns the lines that ACTUALLY moved. applyMovement resolves {ok, reason}
  // on a rejected write instead of throwing, so ok is checked explicitly; the
  // try/catch is only for a genuine exception (offline, auth loss).
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

  const tapMove = useCallback((card) => {
    if (movedKeys.has(card.key) || leavingKeys.has(card.key)) return;
    const lines = card.sizes.map((s) => ({ size: s.size, qty: s.qty }));

    setLeavingKeys((prev) => new Set(prev).add(card.key));
    window.setTimeout(() => {
      setMovedKeys((prev) => new Set(prev).add(card.key));
      setLeavingKeys((prev) => { const n = new Set(prev); n.delete(card.key); return n; });
    }, EXIT_MS);

    doMove(card.pid, lines, card.loc, "central").then((moved) => {
      if (!moved.length) {
        // Nothing moved — put the card straight back rather than leave the
        // operator believing a move happened.
        setMovedKeys((prev) => { const n = new Set(prev); n.delete(card.key); return n; });
        setLeavingKeys((prev) => { const n = new Set(prev); n.delete(card.key); return n; });
        return;
      }
      const total = moved.reduce((t, s) => t + s.qty, 0);
      // A new move supersedes the previous one's Undo (which becomes final)
      // rather than blocking the screen for five seconds.
      setUndo((prev) => {
        if (prev) window.clearTimeout(prev.timer);
        const timer = window.setTimeout(
          () => setUndo((u) => (u && u.key === card.key ? null : u)), UNDO_MS,
        );
        return { key: card.key, hub: card.loc, pid: card.pid, lines: moved, total, timer };
      });
    });
  }, [doMove, movedKeys, leavingKeys]);

  const undoNow = useCallback(() => {
    if (!undo) return;
    window.clearTimeout(undo.timer);
    const u = undo;
    setUndo(null);
    doMove(u.pid, u.lines, "central", u.hub).then(() => {
      setMovedKeys((prev) => { const n = new Set(prev); n.delete(u.key); return n; });
    });
  }, [undo, doMove]);

  useEffect(() => () => { if (undo) window.clearTimeout(undo.timer); }, [undo]);

  // ── fixed-row-height windowing ───────────────────────────────────────────
  const scrollerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const onResize = () => setViewportH(el.clientHeight || 600);
    onResize();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => { el.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onResize); };
  }, []);
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(cards.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = cards.slice(startIdx, endIdx);

  return (
    <div>
      {/* Header — literal "Hub N → Central" + segmented control + count pill */}
      <div style={{ ...GLASS, padding: "12px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{HUB_LABEL[hub] || hub} → Central</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", borderRadius: 999, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.03)", padding: 2 }}>
            {EXCESS_HUB_LOCATIONS.map((h) => (
              <button key={h} onClick={() => setHub(h)}
                aria-pressed={hub === h}
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

      {/* List — virtualized, fixed-row-height windowing */}
      <div ref={scrollerRef} style={{ height: "calc(100vh - 260px)", minHeight: 320, overflowY: "auto", position: "relative" }}>
        <div style={{ height: cards.length * ROW_HEIGHT, position: "relative" }}>
          {visible.map((c, i) => (
            <div key={c.key}
              style={{
                position: "absolute", left: 0, right: 0, top: (startIdx + i) * ROW_HEIGHT,
                height: ROW_HEIGHT - 8, transition: `opacity ${EXIT_MS - 20}ms ease, transform ${EXIT_MS - 20}ms ease`,
                opacity: leavingKeys.has(c.key) ? 0 : 1,
                transform: leavingKeys.has(c.key) ? "scale(0.96)" : "scale(1)",
                pointerEvents: leavingKeys.has(c.key) ? "none" : "auto",
              }}>
              <Card card={c} onMove={() => tapMove(c)} />
            </div>
          ))}
        </div>
      </div>

      {undo && (
        <div style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 80,
          display: "flex", justifyContent: "center", padding: "0 12px 16px",
        }}>
          <div style={{
            ...GLASS, background: "#0a0e18", display: "flex", alignItems: "center", gap: 14,
            padding: "12px 16px", borderRadius: 999, boxShadow: "0 20px 50px -18px rgba(0,0,0,.8)",
          }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>{undo.total}</span>
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

function Card({ card, onMove }) {
  return (
    <div style={{ ...GLASS, height: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", boxSizing: "border-box" }}>
      <div style={{ width: 50, height: 50, borderRadius: 11, flexShrink: 0, overflow: "hidden", background: "rgba(60,110,255,.1)" }}>
        {card.photo && <img src={card.photo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", flex: "0 1 auto", maxWidth: "34%", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {card.name}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6, overflowX: "auto", padding: "2px 0" }}>
        {card.sizes.map((s) => (
          <span key={s.size} style={{
            flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: "#dfe7ff",
            background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 999, padding: "5px 10px", whiteSpace: "nowrap",
          }}>
            {s.size} · {s.qty}
          </span>
        ))}
      </div>
      <button onClick={onMove} style={{
        flexShrink: 0, width: 46, height: 46, borderRadius: "50%", border: "1px solid rgba(74,222,128,.45)",
        background: "rgba(74,222,128,.16)", color: GREEN, fontWeight: 800, fontSize: 14.5, cursor: "pointer", fontFamily: FONT,
      }}>
        {card.total}
      </button>
    </div>
  );
}

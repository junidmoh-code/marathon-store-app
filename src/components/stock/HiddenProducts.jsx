// ─── MISSING PRODUCTS — THE HIDDEN TAB ────────────────────────────────────────
// Everything staff have hidden from the Missing Products list, with the reason
// and when, and a one-tap Unhide. Reached through a deliberately unlabelled
// control (the press-and-hold spot in HealthView's chip row — see HoldSpot
// below). That control is DISCRETION, NOT SECURITY: the point is that a
// customer looking over the counter sees no "Hidden" button and a stray tap
// can never open it, not that anyone is locked out. There is no password and
// no permission gate on VIEWING; unhide itself is canAct-gated like every
// other write on these screens.
//
// Each row states its status against the CURRENT card list:
//   STILL MISSING     — the product is still stranded; unhide puts its card
//                       straight back in the main list.
//   NO LONGER MISSING — it sold out, was collapsed, or a shop now carries it,
//                       so the main list dropped it on its own. THE RULE
//                       (hiddenProductsCore.js): the entry stays here, inert,
//                       until a human unhides it — never auto-purged, so a
//                       seasonal product that re-strands comes back HIDDEN.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, FONT } from "./ui";
import { ProductCard, Badge } from "./healthWidgets";
import { serverNowMs } from "../../utils/serverTime";
import { HIDE_REASONS, reasonLabel, hiddenRows, sortAndFilterHidden, unhideUpdate } from "./hiddenProductsCore";

const fmtAt = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date(serverNowMs()).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? `today ${hm}` : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
};

// `cards` is the FULL card list (before the hide partition) so each row can
// say whether its product is still stranded; `hiddenMap` is the node itself.
export default function HiddenProducts({ products = [], cards = [], hiddenMap = null }) {
  const { permRecord, isSuperAdmin } = usePermissions();
  const actorRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAct = ["store", "warehouse", "admin"].includes(actorRole);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [busyPid, setBusyPid] = useState(null);
  const [errPid, setErrPid] = useState({});
  // Sort + filter by reason and by date hidden — the scale controls: with
  // hundreds of seasonal entries parked here, "show me only Seasonal, oldest
  // first" is how a batch gets reviewed and unhidden.
  const [reasonFilter, setReasonFilter] = useState("all");
  const [sort, setSort] = useState("newest");

  const rows = useMemo(() => hiddenRows(hiddenMap, cards), [hiddenMap, cards]);
  const shown = useMemo(() => sortAndFilterHidden(rows, { reason: reasonFilter, sort }), [rows, reasonFilter, sort]);

  // Unhide is ONE action — delete the entry; the card (if the product is
  // still stranded) reappears in the main list via the same subscription
  // that removed it. Nothing else is written.
  const unhide = async (pid) => {
    if (busyPid || !canAct) return;
    setBusyPid(pid);
    try {
      await update(ref(database), unhideUpdate([pid]));
      setErrPid((e) => { const n = { ...e }; delete n[pid]; return n; });
    } catch (e) {
      setErrPid((prev) => ({ ...prev, [pid]: `Couldn't unhide — retry. (${e?.message || "error"})` }));
    }
    setBusyPid(null);
  };

  if (!rows.length) {
    return <div style={{ ...GLASS, padding: 18, color: GRAY, fontSize: 13 }}>Nothing hidden — every stranded product is showing in the main list.</div>;
  }

  const pill = (on) => ({
    padding: "7px 12px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: FONT,
    border: on ? "1px solid rgba(60,110,255,.5)" : "1px solid rgba(255,255,255,.1)",
    background: on ? "rgba(60,110,255,.14)" : "rgba(255,255,255,.03)",
    color: on ? BLUE_L : "rgba(255,255,255,.45)",
  });

  return (
    <>
      {!canAct && <div style={{ color: AMBER, fontSize: 12, marginBottom: 10 }}>You need a stock role to unhide — viewing only.</div>}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        {[["all", "All"], ...HIDE_REASONS.map((r) => [r.key, r.label]), ["none", "No reason"]].map(([key, label]) => (
          <button key={key} onClick={() => setReasonFilter(key)} style={pill(reasonFilter === key)}>{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setSort(sort === "newest" ? "oldest" : "newest")} style={pill(false)}>
          {sort === "newest" ? "Newest first" : "Oldest first"} ⇅
        </button>
      </div>
      {shown.map((r) => {
        const p = byId.get(r.pid);
        return (
          <ProductCard key={r.pid}
            photo={r.card?.photo || p?.photoUrl} name={r.card?.name || p?.name || r.pid}
            badges={<>
              {r.resolved
                ? <Badge tone={GREEN}>NO LONGER MISSING</Badge>
                : <Badge tone={AMBER}>STILL MISSING · {r.card.units} units at source</Badge>}
              <Badge tone={BLUE_L}>{reasonLabel(r.reason)}</Badge>
            </>}
            sub={`hidden ${fmtAt(r.at)}`}
            right={canAct && (
              <button onClick={() => unhide(r.pid)} disabled={busyPid === r.pid}
                style={{ background: "rgba(60,110,255,.1)", border: "1px solid rgba(60,110,255,.35)", color: BLUE_L, borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>
                {busyPid === r.pid ? "…" : "Unhide"}
              </button>
            )}
          >
            {errPid[r.pid] && <div style={{ fontSize: 11.5, color: RED }}>{errPid[r.pid]}</div>}
          </ProductCard>
        );
      })}
      {!shown.length && (
        <div style={{ ...GLASS, padding: 14, color: GRAY, fontSize: 12.5 }}>Nothing hidden matches this filter.</div>
      )}
    </>
  );
}

// ── THE INVISIBLE ENTRANCE ───────────────────────────────────────────────────
// A blank press-and-hold spot rendered as the chip row's trailing flex spacer
// in HealthView. Placement rationale (owner report, 2026-08-13):
//   • findable by staff who know: "hold your finger on the empty space at the
//     end of the chip row" is one sentence of training, on the exact screen
//     where hiding happens;
//   • invisible to a customer over the counter: it renders NOTHING — no
//     label, no icon, no border, no cursor affordance;
//   • impossible to hit by accident: a tap does nothing (600 ms hold
//     required), and any drift > 12 px — i.e. a scroll — cancels the timer,
//     so it cannot fire mid-swipe.
// This is discretion, not access control: no password, no role gate, and the
// tab it opens announces itself with a visible chip once open.
export function HoldSpot({ onTrigger, holdMs = 600 }) {
  // A ref, not state: the press is transient bookkeeping, and the timer must
  // be clearable from the unmount cleanup — a hold in progress when the
  // screen unmounts must never fire onTrigger into a dead tree.
  const press = useRef(null); // {x, y, timer}
  const cancel = () => { if (press.current) { clearTimeout(press.current.timer); press.current = null; } };
  useEffect(() => cancel, []);
  return (
    <div
      onPointerDown={(e) => {
        cancel();
        const timer = setTimeout(() => { press.current = null; onTrigger(); }, holdMs);
        press.current = { x: e.clientX, y: e.clientY, timer };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) cancel();
      }}
      onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
      style={{ flex: 1, alignSelf: "stretch", minWidth: 44, minHeight: 30, userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", touchAction: "pan-y" }}
    />
  );
}

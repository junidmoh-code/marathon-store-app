// ─── SEATING — THE ACTIONS ON ONE LOCATION ROW ───────────────────────────────
//
//   SWITCH OFF            this shop does not carry this line. No stock moves.
//   RE-SEAT               removes that fact and nothing else.
//
// ONE LOCATION AT A TIME. There is deliberately no bulk button: some empty
// seating is correct — a shop that stocks a line and is simply sold out — and a
// sweep cannot tell that apart from a mistake.

import React, { useMemo, useState } from "react";
import { switchOffBlockers, switchOffPlan, reseatPlan, switchOff, reseat } from "./seatingStore";
import { SEAT_REASON } from "./seatingCore";
import { nextScanAt } from "./enginePolicyCore";
import { serverNowMs } from "../../utils/serverTime";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGray, bRed, bGhost } from "./ui";

export default function SeatingActions({ seat, product, label, registry, locations, ctx, viewer, onDone, onFail }) {
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");   // "" | "off" | "reseat"

  const blockers = useMemo(() => switchOffBlockers(seat), [seat]);
  const plan = useMemo(() => switchOffPlan(ctx, seat.loc, seat.pid), [ctx, seat.loc, seat.pid]);
  const undo = useMemo(() => reseatPlan(ctx, seat.loc, seat.pid), [ctx, seat.loc, seat.pid]);
  const scan = useMemo(() => nextScanAt(serverNowMs()), []);

  const run = async (what, fn, done) => {
    if (busy) return;
    setBusy(what);
    try {
      const res = await fn();
      if (res.ok) onDone(done(res));
      else onFail(FAILURES[res.reason] || res.reason);
    } catch (e) {
      onFail(e?.message || String(e));
    } finally { setBusy(""); setConfirm(""); }
  };

  const canUndo = undo.restore.length > 0;

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" }}>

      {/* ── the refusal ── */}
      {blockers && (
        <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".7rem",
          border: `1px solid ${blockers.negativeOnly ? "rgba(251,191,36,.45)" : "rgba(248,113,113,.45)"}`,
          color: blockers.negativeOnly ? AMBER : RED, fontSize: ".82rem" }}>
          {blockers.negativeOnly
            ? `${blockers.units} here — move it out, do not strand a count error.`
            : `${blockers.units} units here — move them first.`}
        </div>
      )}

      {/* ── switch off ── */}
      {confirm === "off" ? (
        <div style={{ marginBottom: ".7rem" }}>
          <div style={{ fontSize: ".82rem", color: "#dfe7ff" }}>
            {plan.length} {plan.length === 1 ? "size" : "sizes"} set to 0 at {label}.
          </div>
          <div style={{ fontSize: ".75rem", color: GRAY, marginTop: 4 }}>
            {/* Not a promise about a build that is not deployed: the withdrawal
                pass keys off resolveTarget, which the deployed engine runs. */}
            Open refills retract themselves at {scan.label}.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: ".7rem", flexWrap: "wrap" }}>
            <button
              onClick={() => run("off", () => switchOff({ seat, ctx, viewer }),
                (r) => `${label} switched off — ${r.rowCount} ${r.rowCount === 1 ? "size" : "sizes"} at 0.`)}
              disabled={!!busy}
              style={{ ...bRed, opacity: busy ? .5 : 1 }}
            >{busy === "off" ? "…" : "Confirm"}</button>
            <button onClick={() => setConfirm("")} disabled={!!busy} style={bGhost}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => setConfirm("off")}
            disabled={!!busy || !!blockers || seat.reason === SEAT_REASON.SWITCHED_OFF}
            title={blockers ? "Move the stock out first" : "This shop does not carry this line"}
            style={{ ...bGray, opacity: (busy || blockers || seat.reason === SEAT_REASON.SWITCHED_OFF) ? .45 : 1 }}
          >Switch off</button>

          {canUndo && (
            <button
              onClick={() => run("reseat", () => reseat({ seat, ctx }),
                (r) => `${label} re-seated — ${r.rowCount} ${r.rowCount === 1 ? "row" : "rows"} restored.`)}
              disabled={!!busy}
              style={{ ...bGhost, opacity: busy ? .5 : 1 }}
            >{busy === "reseat" ? "…" : "Re-seat"}</button>
          )}
        </div>
      )}

      {undo.stuck.length > 0 && (
        <div style={{ fontSize: ".75rem", color: AMBER, marginTop: ".6rem" }}>
          {undo.stuck.length} {undo.stuck.length === 1 ? "row has" : "rows have"} no record to restore — left as they are.
        </div>
      )}
    </div>
  );
}

const FAILURES = {
  holds_units: "There is stock here — move it first.",
  no_sizes: "This product declares no sizes and holds no cells here.",
  unsafe_key: "A size key could not be written safely.",
  nothing_to_undo: "Nothing here was switched off from this screen.",
};

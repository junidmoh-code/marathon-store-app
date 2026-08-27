// ─── SEATING — THE ACTIONS ON ONE LOCATION ROW ───────────────────────────────
//
//   SWITCH OFF            this shop does not carry this line. No stock moves.
//   MOVE AND SWITCH OFF   the units go somewhere else and the source goes off,
//                         in one action. "Switch off the source" is TICKED BY
//                         DEFAULT and can be un-ticked — two shops genuinely
//                         carrying the same line is a real case, and the tick
//                         is what tells the two apart.
//   RE-SEAT               removes that fact and nothing else.
//
// ONE LOCATION AT A TIME. There is deliberately no bulk button: some empty
// seating is correct — a shop that stocks a line and is simply sold out — and a
// sweep cannot tell that apart from a mistake.

import React, { useMemo, useState } from "react";
import {
  switchOffBlockers, switchOffPlan, reseatPlan, switchOff, reseat,
  movePlan, moveBlockers, moveAndSwitchOff,
} from "./seatingStore";
import { seatingAt, SEAT_REASON } from "./seatingCore";
import { enginePolicySeatingWritable } from "../../config/enginePolicy";
import { nextScanAt } from "./enginePolicyCore";
import { labelFor } from "./locations";
import { serverNowMs } from "../../utils/serverTime";
import { SizeFactChip, CHIP_GRID } from "./healthWidgets";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGray, bRed, bGreen, bGhost } from "./ui";

// `locations` is the CARRIAGE CONTEXT — every location that can hold a cell,
// in_transit and deactivated ones included, because that is what the engine's
// dead-size rule counts and what the switch-off re-read must cover.
// `destinations` is what a human may PICK. They are deliberately not the same
// list: offering in_transit as a destination would park stock in the transit
// holding with no /transfers doc and nobody expecting it.
export default function SeatingActions({ seat, product, label, registry, locations, destinations, ctx, viewer, onDone, onFail }) {
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");   // "" | "off" | "move"
  const [dest, setDest] = useState("");
  // TICKED BY DEFAULT. Moving the stock out and leaving the seat on is the
  // deliberate minority case, so it costs a tap; the common case costs none.
  const [alsoOff, setAlsoOff] = useState(true);

  const blockers = useMemo(() => switchOffBlockers(seat), [seat]);
  const plan = useMemo(() => switchOffPlan(ctx, seat.loc, seat.pid), [ctx, seat.loc, seat.pid]);
  const undo = useMemo(() => reseatPlan(ctx, seat.loc, seat.pid), [ctx, seat.loc, seat.pid]);
  const scan = useMemo(() => nextScanAt(serverNowMs()), []);
  const lines = useMemo(() => movePlan(ctx, seat.loc, seat.pid), [ctx, seat.loc, seat.pid]);
  // THE LINES AND THE DESTINATION'S OWN SEAT ARE PART OF THE QUESTION. Called
  // with two arguments this skipped both negative-line checks, so the button
  // stayed enabled with no warning and the carefully worded refusal only
  // appeared — flattened into a generic string — after the confirm press.
  // (Adversarial re-review, PR #429.)
  const destBlocked = useMemo(
    () => moveBlockers(seat.loc, dest, lines, dest && ctx ? seatingAt(ctx, dest, seat.pid) : null),
    [seat.loc, seat.pid, dest, lines, ctx],
  );
  // A destination that is itself switched off would hold the stock with nothing
  // arming it. Said, not blocked — sending stock to a shelf is still a real act.
  const destOff = useMemo(() => {
    if (!dest || !ctx) return false;
    return seatingAt(ctx, dest, seat.pid).reason === SEAT_REASON.SWITCHED_OFF;
  }, [ctx, dest, seat.pid]);

  const run = async (what, fn, done) => {
    if (busy) return;
    setBusy(what);
    try {
      const res = await fn();
      if (res.ok) onDone(done(res));
      else onFail(res.message || FAILURES[res.reason] || res.reason);
    } catch (e) {
      onFail(e?.message || String(e));
    } finally { setBusy(""); setConfirm(""); }
  };

  const canUndo = undo.restore.length > 0;

  // ── THE WRITES ON THIS TAB ARE NOT THE CALLABLE'S ─────────────────────────
  // Everything else on this card goes through setCategoryPolicy, which writes
  // with the Admin SDK, so `engine_policy` is enough for it. These three
  // buttons write /stock_targets and /stock straight from the browser, and the
  // RULES ask for stockRole 'admin'. Asking the same question here turns a raw
  // PERMISSION_DENIED after the confirm press into a sentence before it.
  // See src/config/enginePolicy.js for why the permission does not simply
  // carry a stockRole. (Fable spec review, PR #469.)
  const canWrite = enginePolicySeatingWritable(viewer);
  if (!canWrite) {
    return (
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ ...GLASS, padding: ".7rem .9rem", border: "1px solid rgba(251,191,36,.45)",
          color: AMBER, fontSize: ".82rem" }}>
          Switching a shop off moves stock, so it needs Stock access as well as Engine
          Policy. Ask Junid to add it — everything else on this screen still works.
        </div>
      </div>
    );
  }

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

      {/* ── move and switch off ── */}
      {confirm === "move" && (
        <div style={{ marginBottom: ".7rem" }}>
          <div style={{ fontSize: ".82rem", color: "#dfe7ff", marginBottom: 6 }}>
            {lines.length} {lines.length === 1 ? "size" : "sizes"} out of {label}
          </div>

          {/* EVERY LINE IS SHOWN. One confirm, but never a blind one. */}
          <div style={CHIP_GRID}>
            {lines.map((l) => (
              <SizeFactChip
                key={l.sizeKey}
                size={l.size === "_" || l.size === "" ? "One size" : l.size}
                value={l.qty}
                tone={l.qty < 0 ? RED : BLUE_L}
              />
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: ".7rem" }}>
            {(destinations || []).filter((l) => l !== seat.loc).map((l) => (
              <button
                key={l}
                onClick={() => setDest(l)}
                disabled={!!busy}
                style={{ ...(dest === l ? bGreen : bGhost), padding: "7px 12px", fontSize: ".78rem" }}
              >{labelFor(l, registry)}</button>
            ))}
          </div>

          {destBlocked && (
            <div style={{ fontSize: ".75rem", color: AMBER, marginTop: ".6rem" }}>{destBlocked}</div>
          )}
          {!destBlocked && destOff && (
            <div style={{ fontSize: ".75rem", color: AMBER, marginTop: ".6rem" }}>
              {labelFor(dest, registry)} is switched off — re-seat it, or it holds stock the engine ignores.
            </div>
          )}
          {lines.some((l) => l.qty < 0) && (
            <div style={{ fontSize: ".75rem", color: AMBER, marginTop: ".6rem" }}>
              A negative travels with the line — its sign is kept.
            </div>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: ".7rem",
            fontSize: ".8rem", color: "#dfe7ff", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={alsoOff}
              onChange={(e) => setAlsoOff(e.target.checked)}
              aria-label="Switch off the source"
            />
            Switch off {label}
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: ".7rem", flexWrap: "wrap" }}>
            <button
              onClick={() => run("move",
                () => moveAndSwitchOff({ seat, ctx, viewer, dest, alsoSwitchOff: alsoOff, locations }),
                // "moved to" is only true of the positive legs; a negative
                // travels the other way, so the wording says "moved with".
                (r) => `${r.moved} ${lines.some((l) => l.qty < 0) ? "moved with" : "moved to"} ${labelFor(dest, registry)}`
                  + (r.replayed ? ` · ${r.replayed} already sent` : "")
                  + (r.failed.length ? ` · ${r.failed.length} failed: ${r.failed.join(" · ")}` : "")
                  + (alsoOff ? (r.switchedOff ? ` · ${label} switched off.` : ` · ${label} left ON (${FAILURES[r.offReason] || r.offReason || "see the row"}).`) : "."))}
              disabled={!!busy || !!destBlocked}
              style={{ ...bGreen, opacity: (busy || destBlocked) ? .5 : 1 }}
            >{busy === "move" ? "…" : alsoOff ? "Move and switch off" : "Move only"}</button>
            <button onClick={() => { setConfirm(""); setDest(""); }} disabled={!!busy} style={bGhost}>Cancel</button>
          </div>
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
              onClick={() => run("off", () => switchOff({ seat, ctx, viewer, locations }),
                (r) => `${label} switched off — ${r.rowCount} ${r.rowCount === 1 ? "size" : "sizes"} at 0.`)}
              disabled={!!busy}
              style={{ ...bRed, opacity: busy ? .5 : 1 }}
            >{busy === "off" ? "…" : "Confirm"}</button>
            <button onClick={() => setConfirm("")} disabled={!!busy} style={bGhost}>Cancel</button>
          </div>
        </div>
      ) : confirm === "move" ? null : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => setConfirm("off")}
            disabled={!!busy || !!blockers || seat.reason === SEAT_REASON.SWITCHED_OFF}
            title={blockers ? "Move the stock out first" : "This shop does not carry this line"}
            style={{ ...bGray, opacity: (busy || blockers || seat.reason === SEAT_REASON.SWITCHED_OFF) ? .45 : 1 }}
          >Switch off</button>

          <button
            onClick={() => setConfirm("move")}
            disabled={!!busy || !lines.length}
            title={lines.length ? "Move the stock, and switch this shop off" : "Nothing here to move"}
            style={{ ...bGray, opacity: (busy || !lines.length) ? .45 : 1 }}
          >Move and switch off</button>

          {canUndo && (
            <button
              onClick={() => run("reseat", () => reseat({ seat, ctx, locations }),
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
  holds_units: "there is stock here — move it first",
  // switchOff refuses when it cannot verify the location against live data —
  // it must say so in words, not print the bare token at the owner.
  unverified: "could not check this location's stock — reopen the product and try again",
  error: "the switch-off could not be written",
  destination: "that destination cannot be used",
  nothing_to_move: "nothing here to move",
  no_sizes: "This product declares no sizes and holds no cells here.",
  unsafe_key: "A size key could not be written safely.",
  nothing_to_undo: "Nothing here was switched off from this screen.",
};

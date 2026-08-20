// ─── STARVED — WHERE THE NOTEBOOK IS WRONG ────────────────────────────────────
//
// The engine now refuses a refill when /stock_provenance has no trace of a shop
// trading a line. Right default, silent failure: a wrong refusal produces no error,
// no request and no card — the shelf just runs dry, and nobody finds out until
// stocktake.
//
// This card is the detector. It shows every (shop, product) the index refuses while
// the shop shows evidence of trading it — units on the shelf, a sale in the ledger
// window, or an open ask — computed server-side by functions/lib/starved-list.cjs
// and delivered in the scan's exceptions like every other card here. Pairs with an
// explicit target > 0 never appear: the engine arms those without the index.
//
// EACH ROW CARRIES ITS OWN FIX, BEHIND A CONFIRM. `Introduce` writes the same
// `introduce: true` row the engine's opt-in reads and Solve writes (solveCarriage.js
// — one writer, one shape). But a HOLDS badge can be a stray collection cell or a
// mis-restocked return — the PE↔Trophy contamination class — and one uncontemplated
// tap would ratify that contamination as carriage and open the whole size run: the
// 2026-08-17 incident, manufactured from a red card (adversarial review, PR #383).
// So the press shows the CONSEQUENCE first — the run it opens, sized in units — and
// a second press commits. A committed introduce keeps an Undo that removes exactly
// the rows it wrote, by CAS on its own introducedAt stamp.
//
// EXCLUDED ROWS GET NO BUTTON. An all-zero target row is a standing "we do not
// stock this here"; introducing over it would silence this card while the zero rows
// keep outranking everything — the shelf starves on, reported as fixed. Worse,
// stamping introduce:true onto the protective rows turns the documented off-switch
// (delete the zero row) into an arming action. Those rows live in their own quiet
// section: visible, because a delisted line with contrary evidence deserves a look,
// but the fix is an admin editing the row that says so — and this card says exactly
// that.
//
// WHAT A ROW MEANS, AND WHY THE NUMBERS ARE ON IT
// `k / u` are printed because "we sent it and took it all back" (k=4, u=4) is a
// completely different situation from "we have never heard of this here" (no
// record), and they need different answers. Introducing is right for the second and
// probably wrong for the first — the units went back for a reason. (A listed row can
// never show sales in the index: s > 0 would mean carried.)

import React, { useState } from "react";
import { ref, update, get, runTransaction } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen } from "./ui";
import { ProductCard, Badge } from "./healthWidgets";
import { introduceUpdates } from "./solveCarriage";
import { useEngineConfig } from "./useStock";
import { effectiveRun } from "./introduceExistingCore";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", hub1: "Hub 1", central: "Central" };
const WHY_LABEL = { sold: "SOLD HERE", holds: "HOLDS UNITS", asked: "OPEN ASK" };
const WHY_TONE = { sold: RED, holds: AMBER, asked: BLUE_L };

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The sentence under a row — what the index actually holds, in words.
 *  Zero-valued fields are OMITTED from the payload (49 writes a day), so every
 *  read normalises through n(). A listed row can never carry s > 0 — that would
 *  mean carried — so the record sentence has exactly two shapes. */
export function evidenceLine(r) {
  const bits = [];
  if (n(r.sold) > 0) bits.push(`sold ${r.sold} here in the ledger window`);
  if (n(r.held) > 0) bits.push(`${r.held} unit${r.held === 1 ? "" : "s"} on the shelf`);
  if (n(r.openLines) > 0) bits.push(`${r.openLines} open refill line${r.openLines === 1 ? "" : "s"}`);
  const record = !r.rec
    ? "no stock history at all for this shop"
    : `stocked ${n(r.k)} and took ${n(r.u)} back, so the history nets to ${Math.max(n(r.k) - n(r.u), 0)}`;
  return `${bits.join(", ")} — but ${record}.`;
}

export default function StarvedList({ rows = [], total = 0, byId, canAct, sizesFor }) {
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(null);   // `${loc}|${pid}` awaiting the second press
  const [done, setDone] = useState({});                 // key → {ok, msg, undo?: {paths, at}}
  const engineConfig = useEngineConfig();

  // The run this introduce would open, in units — the consequence the confirm
  // shows. Same numbers the engine will use (effectiveRun mirrors its fallbacks).
  const unitsFor = (loc, sizes) => {
    const run = effectiveRun(engineConfig, loc) || {};
    return (sizes || []).reduce((t, s) => t + n(Number(run[String(s).toUpperCase()])), 0);
  };

  const introduce = async (r) => {
    const key = `${r.loc}|${r.pid}`;
    if (busy || !canAct) return;
    if (confirming !== key) { setConfirming(key); return; }   // first press: show the consequence
    setConfirming(null);
    setBusy(key);
    try {
      const sizes = sizesFor(r.pid).filter((s) => String(s).trim() !== "");
      if (!sizes.length) {
        setDone((d) => ({ ...d, [key]: { ok: false, msg: "This product declares no sizes, so there is no row to introduce it on. Fix the product record first." } }));
        setBusy(null);
        return;
      }
      // Re-read before writing: this card renders a scan snapshot up to 15 minutes
      // old, and the pair may have acquired carriage — or an explicit row — since.
      // BOTH kinds are checked: an introduce row means someone already made this
      // decision, and a NUMERIC row means the engine is managing (target > 0) or
      // the shop is deliberately excluded (all zero) — introducing over either
      // would claim or overrule a decision somebody else made.
      const live = (await get(ref(database, `stock_targets/${r.loc}/${r.pid}`))).val() || {};
      if (Object.keys(live).some((k) => live[k]?.introduce === true)) {
        setDone((d) => ({ ...d, [key]: { ok: true, msg: "Already introduced here — nothing written. The card clears on the next scan." } }));
        setBusy(null);
        return;
      }
      const numeric = Object.values(live).filter((row) => row && typeof row.target === "number");
      if (numeric.some((row) => row.target > 0)) {
        setDone((d) => ({ ...d, [key]: { ok: true, msg: "A target row appeared since the last scan — the engine already manages this here. Nothing written." } }));
        setBusy(null);
        return;
      }
      if (numeric.length > 0) {
        setDone((d) => ({ ...d, [key]: { ok: false, msg: "This shop is deliberately excluded from the line (target 0). Introducing would not refill it — the zero row outranks everything — and would hide this card while the shelf starves on. An admin edits the target row that excludes it." } }));
        setBusy(null);
        return;
      }
      const at = serverNowIso();
      const updates = introduceUpdates({
        plan: { introduce: [{ loc: r.loc }] }, pid: r.pid, sizes,
        at, by: auth.currentUser?.uid || null,
        note: `Introduced from the Starved list — ${LOC_LABEL[r.loc] || r.loc}; ${r.why.join("+")}.`,
      });
      await update(ref(database), updates);
      setDone((d) => ({ ...d, [key]: {
        ok: true, undo: { paths: Object.keys(updates), at },
        msg: `Introduced at ${LOC_LABEL[r.loc] || r.loc} — a standing decision. The engine raises the full run on its next scan.`,
      } }));
    } catch (e) {
      const denied = /permission|denied/i.test(String(e?.message || e));
      setDone((d) => ({ ...d, [key]: { ok: false, msg: denied
        ? "The introduce rule for /stock_targets hasn't been published yet, so this write is refused for every client. Nothing changed — ask Junid to publish the widened rule."
        : `Couldn't introduce — nothing changed, retry. (${e?.message || "error"})` } }));
    }
    setBusy(null);
  };

  // Remove exactly the rows this card wrote, by CAS on the introducedAt stamp —
  // a row somebody has edited since (a target added) aborts and stays whole.
  // Same authorship proof as Solve's undo (NetworkTransfer.removeIntroducedRows).
  const undoIntroduce = async (r) => {
    const key = `${r.loc}|${r.pid}`;
    const u = done[key]?.undo;
    if (!u || busy) return;
    setBusy(key);
    try {
      const results = await Promise.all(u.paths.map((p) =>
        runTransaction(ref(database, p), (cur) => {
          if (cur === null) return null;
          if (cur.introduce === true && cur.introducedAt === u.at && typeof cur.target !== "number") return null;
          return;
        })));
      const kept = results.filter((res) => !res.committed).length;
      setDone((d) => ({ ...d, [key]: { ok: true, msg: kept
        ? `Undone, except ${kept} row${kept === 1 ? "" : "s"} someone has edited since — those stand.`
        : "Introduction undone — nothing stands." } }));
    } catch (e) {
      setDone((d) => ({ ...d, [key]: { ...done[key], msg: `Couldn't undo — retry. (${e?.message || "error"})` } }));
    }
    setBusy(null);
  };

  if (!rows.length) {
    return (
      <div style={{ ...GLASS, padding: 20, textAlign: "center", color: GREEN, fontWeight: 700, fontSize: 14 }}>
        Nothing starved — every shop that holds, sells or asks for a line has the history to match 🎉
      </div>
    );
  }

  const active = rows.filter((r) => !r.excluded);
  const excluded = rows.filter((r) => r.excluded);

  // Group by product so one line appearing at two shops reads as one problem.
  const grouped = (list) => {
    const byPid = new Map();
    for (const r of list) {
      if (!byPid.has(r.pid)) byPid.set(r.pid, []);
      byPid.get(r.pid).push(r);
    }
    return [...byPid.entries()];
  };

  const renderRow = (r, { actionable }) => {
    const key = `${r.loc}|${r.pid}`;
    const res = done[key];
    const isConfirm = confirming === key;
    const sizes = sizesFor(r.pid).filter((s) => String(s).trim() !== "");
    const units = unitsFor(r.loc, sizes);
    return (
      <div key={key} style={{ padding: "9px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
            {LOC_LABEL[r.loc] || r.loc}
            {r.excluded && (
              <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: AMBER }}>
                · deliberately excluded here (target 0) — an admin edits that row; Introduce would not refill it
              </span>
            )}
          </div>
          {actionable && !res?.ok && (
            <button onClick={() => introduce(r)} disabled={!canAct || !!busy}
              title={!canAct ? "You do not have permission to change targets" : undefined}
              style={{ ...(isConfirm ? { ...bGreen, background: "rgba(245,158,11,.85)" } : bGreen), padding: "8px 14px", fontSize: 12, opacity: !canAct || busy ? 0.5 : 1 }}>
              {busy === key ? "Introducing…" : isConfirm ? "Press again to confirm" : "Introduce"}
            </button>
          )}
          {actionable && res?.ok && res?.undo && (
            <button onClick={() => undoIntroduce(r)} disabled={!!busy}
              style={{ background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.2)", color: "#fff", borderRadius: 10, padding: "7px 12px", fontWeight: 700, fontSize: 11.5, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
              Undo
            </button>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 4, lineHeight: 1.45 }}>
          {evidenceLine(r)}
        </div>
        {isConfirm && (
          <div style={{ fontSize: 11.5, marginTop: 5, color: AMBER, lineHeight: 1.45 }}>
            {`This records ${LOC_LABEL[r.loc] || r.loc} as newly stocking the line — a standing decision, not a one-off order. The engine opens its whole size run (${sizes.length} size${sizes.length === 1 ? "" : "s"}${units ? `, ~${units} units` : ""}) on the next scan. If those shelf units are a stray — a customer collection passing through, a wrong-shop return — do NOT introduce; fix the stock instead.`}
          </div>
        )}
        {res && (
          <div style={{ fontSize: 11.5, marginTop: 5, color: res.ok ? GREEN : RED, lineHeight: 1.4 }}>
            {res.msg}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, border: "1px solid rgba(245,158,11,.45)" }}>
        <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.5 }}>
          The engine refuses to refill these because it has no record of the shop trading them — yet each
          one holds stock, has sold, or has been asked for. <b style={{ color: "#fff" }}>Every row here is
          either a shop that needs introducing, or a gap in the stock history.</b> Sales rung up on the
          till do not always reach the history, so a line sold only at the counter can land here.
        </div>
        {total > rows.length && (
          <div style={{ fontSize: 11.5, color: AMBER, marginTop: 6 }}>
            {`Showing the worst ${rows.length} of ${total} — clear these and the rest surface on the next scan.`}
          </div>
        )}
      </div>

      {grouped(active).map(([pid, prows]) => (
        <ProductCard key={pid} photo={byId?.get(pid)?.photoUrl} name={byId?.get(pid)?.name || pid}
          badges={<>{[...new Set(prows.flatMap((r) => r.why))].map((w) => (
            <Badge key={w} tone={WHY_TONE[w] || GRAY}>{WHY_LABEL[w] || w.toUpperCase()}</Badge>
          ))}</>}>
          {prows.map((r) => renderRow(r, { actionable: true }))}
        </ProductCard>
      ))}

      {excluded.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, color: GRAY, textTransform: "uppercase", letterSpacing: ".05em", margin: "14px 2px 8px" }}>
            Standing exclusions with contrary evidence ({excluded.length}) — not alarms, worth a look
          </div>
          {grouped(excluded).map(([pid, prows]) => (
            <ProductCard key={pid} photo={byId?.get(pid)?.photoUrl} name={byId?.get(pid)?.name || pid}
              badges={<Badge tone={AMBER}>EXCLUDED · TARGET 0</Badge>}>
              {prows.map((r) => renderRow(r, { actionable: false }))}
            </ProductCard>
          ))}
        </>
      )}
    </>
  );
}

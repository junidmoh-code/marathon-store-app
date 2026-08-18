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
// and delivered in the scan's exceptions like every other card here.
//
// EACH ROW CARRIES ITS OWN FIX. `Introduce` writes the same `introduce: true` row the
// engine's opt-in reads and Solve writes (solveCarriage.js — one writer, one shape,
// so a row created here is indistinguishable from one created there). No numeric
// target: the size run keeps deciding the quantities.
//
// WHAT A ROW MEANS, AND WHY THE NUMBERS ARE ON IT
// `s / k / u` are printed because "we sent it and took it all back" (k=4, u=4) is a
// completely different situation from "we have never heard of this here" (no record),
// and they need different answers. Introducing is right for the second and probably
// wrong for the first — the units went back for a reason.
//
// A row flagged EXCLUDED has an explicit `target: 0` at that shop. That EXPLAINS the
// refusal: it is a standing decision, not a gap. Those sort last and are styled
// quietly — visible, because a shop excluded from a line it is actively selling is
// worth a look, but never nagging.

import React, { useState } from "react";
import { ref, update, get } from "firebase/database";
import { database, auth } from "../../firebase";
import { serverNowIso } from "../../utils/serverTime";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen } from "./ui";
import { ProductCard, Badge } from "./healthWidgets";
import { introduceUpdates } from "./solveCarriage";

const LOC_LABEL = { "marathon-pe": "Marathon PE", trophy: "Trophy", hub2: "Hub 2", hub1: "Hub 1", central: "Central" };
const WHY_LABEL = { sold: "SOLD HERE", holds: "HOLDS UNITS", asked: "OPEN ASK" };
const WHY_TONE = { sold: RED, holds: AMBER, asked: BLUE_L };

/** The sentence under a row — what the index actually holds, in words. */
export function evidenceLine(r) {
  const bits = [];
  if (r.sold > 0) bits.push(`sold ${r.sold} here in the ledger window`);
  if (r.held > 0) bits.push(`${r.held} unit${r.held === 1 ? "" : "s"} on the shelf`);
  if (r.openLines > 0) bits.push(`${r.openLines} open refill line${r.openLines === 1 ? "" : "s"}`);
  const record = !r.hasRecord
    ? "no stock history at all for this shop"
    : (r.k > 0 && r.k - r.u <= 0)
      ? `stocked ${r.k} and took ${r.u} back, so the history nets to nothing`
      : `history shows ${r.s} sale${r.s === 1 ? "" : "s"} and ${r.k - r.u} net units`;
  return `${bits.join(", ")} — but ${record}.`;
}

export default function StarvedList({ rows = [], byId, canAct, sizesFor }) {
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState({});      // `${loc}|${pid}` → {ok, msg}

  const introduce = async (r) => {
    const key = `${r.loc}|${r.pid}`;
    if (busy || !canAct) return;
    setBusy(key);
    try {
      const sizes = sizesFor(r.pid);
      if (!sizes.length) {
        setDone((d) => ({ ...d, [key]: { ok: false, msg: "This product declares no sizes, so there is no row to introduce it on. Fix the product record first." } }));
        setBusy(null);
        return;
      }
      // Re-read before writing: this card renders a scan snapshot up to 15 minutes
      // old, and the pair may have acquired carriage — or an explicit row — since.
      // Introducing over either would claim a decision somebody else already made.
      const live = (await get(ref(database, `stock_targets/${r.loc}/${r.pid}`))).val() || {};
      if (Object.keys(live).some((k) => live[k]?.introduce === true)) {
        setDone((d) => ({ ...d, [key]: { ok: true, msg: "Already introduced here — nothing written. The card clears on the next scan." } }));
        setBusy(null);
        return;
      }
      const updates = introduceUpdates({
        plan: { introduce: [{ loc: r.loc }] }, pid: r.pid, sizes,
        at: serverNowIso(), by: auth.currentUser?.uid || null,
        note: `Introduced from the Starved list — ${LOC_LABEL[r.loc] || r.loc}; ${r.why.join("+")}.`,
      });
      await update(ref(database), updates);
      setDone((d) => ({ ...d, [key]: { ok: true, msg: `Introduced at ${LOC_LABEL[r.loc] || r.loc} — the engine will apply the standard run on its next scan.` } }));
    } catch (e) {
      setDone((d) => ({ ...d, [key]: { ok: false, msg: `Couldn't introduce — nothing changed, retry. (${e?.message || "error"})` } }));
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

  // Group by product so one line appearing at two shops reads as one problem.
  const byPid = new Map();
  for (const r of rows) {
    if (!byPid.has(r.pid)) byPid.set(r.pid, []);
    byPid.get(r.pid).push(r);
  }

  return (
    <>
      <div style={{ ...GLASS, padding: "11px 14px", marginBottom: 12, border: "1px solid rgba(245,158,11,.45)" }}>
        <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.5 }}>
          The engine refuses to refill these because it has no record of the shop trading them — yet each
          one holds stock, has sold, or has been asked for. <b style={{ color: "#fff" }}>Every row here is
          either a shop that needs introducing, or a gap in the stock history.</b> Sales rung up on the
          till do not always reach the history, so a line sold only at the counter can land here.
        </div>
      </div>

      {[...byPid.entries()].map(([pid, prows]) => (
        <ProductCard key={pid} photo={byId?.get(pid)?.photoUrl} name={prows[0].name || byId?.get(pid)?.name || pid}
          badges={<>{[...new Set(prows.flatMap((r) => r.why))].map((w) => (
            <Badge key={w} tone={WHY_TONE[w] || GRAY}>{WHY_LABEL[w] || w.toUpperCase()}</Badge>
          ))}</>}>
          {prows.map((r) => {
            const key = `${r.loc}|${r.pid}`;
            const res = done[key];
            return (
              <div key={key} style={{ padding: "9px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
                    {LOC_LABEL[r.loc] || r.loc}
                    {r.excluded && (
                      <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: GRAY }}>
                        · deliberately excluded here (target 0)
                      </span>
                    )}
                  </div>
                  {!res?.ok && (
                    <button onClick={() => introduce(r)} disabled={!canAct || busy === key}
                      title={!canAct ? "You do not have permission to change targets" : undefined}
                      style={{ ...bGreen, padding: "8px 14px", fontSize: 12, opacity: !canAct || busy === key ? 0.5 : 1 }}>
                      {busy === key ? "Introducing…" : "Introduce"}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: GRAY, marginTop: 4, lineHeight: 1.45 }}>
                  {evidenceLine(r)}
                </div>
                {res && (
                  <div style={{ fontSize: 11.5, marginTop: 5, color: res.ok ? GREEN : RED, lineHeight: 1.4 }}>
                    {res.msg}
                  </div>
                )}
              </div>
            );
          })}
        </ProductCard>
      ))}
    </>
  );
}

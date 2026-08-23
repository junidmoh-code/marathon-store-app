// ─── AI SPEND — WHAT IMAGE GENERATION IS ACTUALLY COSTING ────────────────────
// Every paid AI run in this app already writes a line to
// /aiAssistant/usage/{YYYY-MM-DD}/{pushKey}: what kind of run it was, who ran
// it, how many images came out and what they cost. That ledger has existed for
// as long as the photo pipeline has — it was simply never readable. There is no
// rule on /aiAssistant/usage, so no browser could load it, and no screen asked
// for it. The money was being recorded into the dark.
//
// This is the screen that reads it back. It is a READOUT AND NOTHING ELSE: it
// enforces no cap, blocks no run, and writes nothing. Owner decision
// 2026-08-23 was explicit that photo generation gets no spend limit — the point
// is to be able to SEE the bill, not to police it.
//
// ── WHY A BOUNDED QUERY AND NOT THE NODE ─────────────────────────────────────
// /aiAssistant/usage accumulates one child per calendar day, forever, and each
// day holds a line per run. Reading the node would pull the entire history of
// every AI run ever made to render a month. `orderByKey().limitToLast(DAYS)`
// asks for the last N date buckets and nothing else — the keys are ISO dates,
// so key order IS date order and the newest N buckets are exactly the window.
//
// ── WHY THE EMAIL IS READ FROM THE RECORD ────────────────────────────────────
// A line carries `byEmail`, stamped when the run happened. Resolving the uid
// against /users at render time would be wrong twice over: it would show the
// account's CURRENT name rather than who spent the money, and it would show
// nothing at all once an account is deleted. Lines written before byEmail
// existed have only a uid, and are shown as a short uid rather than pretending
// to a name we do not have.
import { useEffect, useMemo, useState } from "react";
import { ref, onValue, query, orderByKey, limitToLast } from "firebase/database";
import { database } from "../firebase";

// How many day-buckets to pull. 60 covers "this month and last" — the two
// windows anyone actually asks about — while staying a small, bounded read.
const DAYS = 60;

// The paid run kinds this ledger carries, and how to name them. `kind` is
// written by the function that spent the money; anything unrecognised is shown
// under its raw kind rather than dropped, so a new paid path cannot go
// invisible just because this map was not updated.
const KIND_LABEL = {
  generateProductPhotos: "Product photos",
  generateSocialPosts:   "Social posts",
  analyzeReorderNeeds:   "Reorder analysis",
  cleanProductNames:     "Name cleanup",
  pickupVoice:           "Pickup voice",
  pickupVoiceVocab:      "Pickup voice (vocab)",
};

// A line's cost lives under one of two names depending on which function wrote
// it (estimatedCostUSD for the image/reasoning paths, costUSD for the voice
// ones). Read both rather than showing R0 for half the ledger.
function costOf(row) {
  const v = Number(row?.estimatedCostUSD ?? row?.costUSD ?? 0);
  return Number.isFinite(v) ? v : 0;
}

function usd(n) {
  return "$" + (Math.round(n * 100) / 100).toFixed(2);
}

// Who a line is attributed to, in a form a person can read.
function whoOf(row) {
  if (typeof row?.byEmail === "string" && row.byEmail) return row.byEmail.split("@")[0];
  if (typeof row?.by === "string" && row.by) return row.by.slice(0, 8) + "…";
  return "unknown";
}

export default function AiSpendTab() {
  const [days, setDays]   = useState(null);   // { "2026-08-23": { pushKey: row } }
  const [error, setError] = useState(null);

  useEffect(() => {
    const q = query(ref(database, "aiAssistant/usage"), orderByKey(), limitToLast(DAYS));
    const unsub = onValue(
      q,
      (snap) => { setDays(snap.val() || {}); setError(null); },
      (err)  => { setError(err.message); setDays({}); },
    );
    return () => unsub();
  }, []);

  // Flatten to rows once, then derive every panel from that. Sorted newest
  // first: the question this screen answers is almost always "what has it cost
  // me lately", not "what did it cost in June".
  const rows = useMemo(() => {
    const out = [];
    for (const [date, bucket] of Object.entries(days || {})) {
      for (const [id, row] of Object.entries(bucket || {})) {
        if (row && typeof row === "object") out.push({ ...row, date, id });
      }
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  }, [days]);

  const totals = useMemo(() => {
    const byPerson = {}, byKind = {};
    let all = 0, images = 0;
    // "This month" is computed from the DATE KEY, not from `at`. The key is the
    // South-African calendar date the run was filed under; `at` is a UTC epoch,
    // and a 01:00 SAST run belongs to the day its key says, not the day UTC
    // thinks it is.
    const monthPrefix = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }).slice(0, 7);
    let month = 0;
    for (const r of rows) {
      const c = costOf(r);
      all += c;
      if (String(r.date).startsWith(monthPrefix)) month += c;
      images += Number(r.imagesGenerated) || 0;
      const who = whoOf(r);
      byPerson[who] = (byPerson[who] || 0) + c;
      const k = KIND_LABEL[r.kind] || r.kind || "other";
      byKind[k] = (byKind[k] || 0) + c;
    }
    const rank = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
    return { all, month, images, byPerson: rank(byPerson), byKind: rank(byKind) };
  }, [rows]);

  const card = {
    background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.09)",
    borderRadius: 14, padding: "16px 18px",
  };
  const label = { fontSize: 11, fontWeight: 700, letterSpacing: .6, color: "rgba(255,255,255,.45)", textTransform: "uppercase" };

  if (error) {
    return (
      <div style={{ ...card, marginTop: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#FCA5A5" }}>Can’t read the spend log</div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.55)", marginTop: 6, lineHeight: 1.55 }}>
          {error}. /aiAssistant/usage needs a read rule in the Firebase console before this
          screen can load — it is in the rules block from
          <code style={{ margin: "0 4px" }}>scripts/social/print-social-rules.mjs</code>.
        </div>
      </div>
    );
  }
  if (days === null) {
    return <div style={{ ...card, marginTop: 20, color: "rgba(255,255,255,.5)", fontSize: 13 }}>Loading…</div>;
  }
  if (!rows.length) {
    return (
      <div style={{ ...card, marginTop: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Nothing spent in the last {DAYS} days</div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.55)", marginTop: 6 }}>
          Every paid AI run writes a line here as it happens.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[["This month", usd(totals.month)], [`Last ${DAYS} days`, usd(totals.all)], ["Images made", String(totals.images)]].map(([l, v]) => (
          <div key={l} style={{ ...card, flex: "1 1 150px", minWidth: 0 }}>
            <div style={label}>{l}</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, letterSpacing: -.6 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[["By person", totals.byPerson], ["By tool", totals.byKind]].map(([l, list]) => (
          <div key={l} style={{ ...card, flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ ...label, marginBottom: 10 }}>{l}</div>
            {list.map(([name, c]) => (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 }}>
                <span style={{ color: "rgba(255,255,255,.75)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{usd(c)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ ...label, padding: "14px 18px 10px" }}>Every run, newest first</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 520 }}>
            <thead>
              <tr style={{ color: "rgba(255,255,255,.4)", textAlign: "left" }}>
                {["Date", "Who", "What", "Images", "Cost"].map((h, i) => (
                  <th key={h} style={{ padding: "8px 18px", fontWeight: 700, textAlign: i >= 3 ? "right" : "left", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.date + r.id} style={{ borderTop: "1px solid rgba(255,255,255,.06)" }}>
                  <td style={{ padding: "8px 18px", color: "rgba(255,255,255,.6)", whiteSpace: "nowrap" }}>{r.date}</td>
                  <td style={{ padding: "8px 18px", color: "rgba(255,255,255,.85)" }}>{whoOf(r)}</td>
                  <td style={{ padding: "8px 18px", color: "rgba(255,255,255,.6)" }}>{KIND_LABEL[r.kind] || r.kind || "—"}</td>
                  <td style={{ padding: "8px 18px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Number(r.imagesGenerated) || 0}</td>
                  <td style={{ padding: "8px 18px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{usd(costOf(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 200 && (
          <div style={{ padding: "10px 18px", fontSize: 11.5, color: "rgba(255,255,255,.4)" }}>
            Showing the most recent 200 of {rows.length} runs. The totals above count all {rows.length}.
          </div>
        )}
      </div>
    </div>
  );
}

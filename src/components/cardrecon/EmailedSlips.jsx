// ─── EMAILED SLIPS — what the mailbox poller did, worst first ────────────────
// ITS OWN FILE, AND THAT IS THE POINT. This panel is the one place in a
// capture-only app that renders anything about a batch nobody in the shop
// captured by hand, so "it must never show a figure" needs to be checkable
// without a range: captureOnly.test.js scans this whole file and
// intakeFeed.js, rather than slicing a function out of the screen by string
// index: it scans every file in this directory except CardReconScreen.jsx, so
// a helper extracted from this panel is covered the moment it exists, where the
// same helper inside CardReconScreen.jsx could have slipped out of the slice
// unnoticed. (Independent review, PR #510.)
//
// READ-ONLY, and outcomes only: a file name, whether it was recorded, and why
// not. No total, no expected figure, no variance — the evidence itself stays in
// the owner-only records.
//
// A DENIED READ IS NOT AN EMPTY FEED — "no emailed slips" would be a lie that
// reads as good news. The rules for /card_batch_intake and
// /card_batch_poll_status went live on 2026-08-30
// (scripts/cardrecon/apply-card-intake-rules.mjs), so a denial now means
// something has changed rather than something is unfinished: the account has
// lost the card_recon flag, or the rule has been edited. The panel still says
// it, because the alternative is showing an empty feed to someone who cannot
// see it. A denied read, a broken read and a genuinely quiet feed are three
// different states and are shown as three.
import React, { useEffect, useMemo, useState } from "react";
import { ref as dbRef, onValue, query, orderByChild, limitToLast } from "firebase/database";
import { database } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { summariseIntake, attachmentRows, silenceNotice } from "./intakeFeed";
import { S, fmtTime } from "./cardReconStyles";

const INTAKE_FEED_SIZE = 25;

export default function EmailedSlips() {
  const [node, setNode] = useState(undefined);   // undefined = loading
  const [denied, setDenied] = useState(false);   // the rule is not published
  const [broken, setBroken] = useState(null);    // anything else went wrong
  const [open, setOpen] = useState(null);
  // THE HEARTBEAT, read separately and deliberately: one small node, written by
  // the poller every tick including the ones that find nothing. Without it, a
  // quiet mailbox and a dead poller are the same empty feed.
  const [status, setStatus] = useState(null);
  // A HEARTBEAT THAT CANNOT BE READ IS NOT A HEARTBEAT THAT IS MISSING. Both
  // used to land as `null`, and null falls back to judging the feed's own age —
  // so a heartbeat node that is merely unreadable (its rule not pasted, a
  // dropped connection) would have produced "the poller has not reported in at
  // all" about a poller that is reporting in perfectly well. Kept apart.
  const [statusUnreadable, setStatusUnreadable] = useState(false);

  useEffect(() => {
    const off = onValue(dbRef(database, "card_batch_poll_status"),
      (snap) => { setStatus(snap.val() || null); setStatusUnreadable(false); },
      (err) => { setStatus(null); setStatusUnreadable(true); console.warn("poller heartbeat: read failed", err?.code || err); });
    return () => off();
  }, []);

  // ── TIME HAS TO MOVE ON ITS OWN HERE ────────────────────────────────────────
  // The silence notice is the whole point of the heartbeat, and it is a function
  // of NOW — but nothing about a dead poller changes, so nothing re-renders, so
  // a clock read once at mount would sit at the moment the tab was opened and
  // the notice would never appear. This screen is one a manager leaves open on a
  // counter. One minute, bounded, cleared on unmount.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const t = setInterval(() => setNowMs(serverNowMs()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const off = onValue(
      // The TAIL, never the node. This grows by a row per message for ever.
      query(dbRef(database, "card_batch_intake"), orderByChild("at"), limitToLast(INTAKE_FEED_SIZE)),
      (snap) => { setNode(snap.val() || {}); setDenied(false); setBroken(null); },
      // TWO DIFFERENT FAILURES, AND ONLY ONE OF THEM IS ABOUT THE RULE.
      // "The rule has not been published" is precise, actionable advice — and
      // completely wrong for a dropped connection or a missing index, which is
      // what every non-permission error here is. Sending someone to Junid about
      // a rule that is already live is its own kind of lie.
      (err) => {
        const code = err?.code || "";
        // ONE test, not the same three-way comparison twice: the two would
        // drift the moment the accepted codes changed, and they decide which of
        // two very different things a person is told.
        const isDenied = /^permission[-_]denied$/i.test(code);
        setNode(null);
        setDenied(isDenied);
        setBroken(isDenied ? null : (code || "the feed could not be read"));
        console.warn("emailed slips: read failed", code || err);
      },
    );
    return () => off();
  }, []);

  const { rows, refusedCount, recordedCount, lastAt } = useMemo(() => summariseIntake(node), [node]);
  // The SERVER's clock, ticking. A handset with a wrong date must not raise or
  // silence an alarm on its own — and neither must a clock read once at mount.
  //
  // An UNREADABLE heartbeat does not silence the notice — it changes what the
  // notice can honestly claim. RTDB cancels a listener on permission-denied and
  // never retries, so this state persists for the life of the tab; suppressing
  // the alarm outright would have meant a screen opened before the rule was
  // pasted could never raise one again, on exactly the counter-top screen this
  // feature is for.
  const silence = silenceNotice(lastAt, nowMs, status, { statusUnreadable });

  if (denied) {
    return (
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 6 }}>Emailed slips</div>
        <div style={S.warn}>
          This account cannot read the emailed-slip feed. That rule has been live since 30 August, so
          this means the account no longer carries the card recon permission, or the rule itself has
          changed. Nothing is wrong with the slips — ask Junid.
        </div>
      </div>
    );
  }
  if (broken) {
    return (
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)", marginBottom: 6 }}>Emailed slips</div>
        <div style={S.warn}>
          The emailed-slip feed could not be read just now ({broken}). This says nothing about the slips
          themselves — try again in a moment.
        </div>
      </div>
    );
  }
  if (node === undefined) return null;

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(233,238,255,.6)" }}>Emailed slips</div>
        <div style={{ fontSize: 12, color: refusedCount ? "#FFB3B3" : "rgba(233,238,255,.5)", fontWeight: refusedCount ? 800 : 600 }}>
          {refusedCount ? `${refusedCount} refused` : `${recordedCount} recorded`}
        </div>
      </div>
      <div style={{ ...S.sub, fontSize: 12, marginTop: 4 }}>
        What the terminals emailed, captured automatically. Nothing here needs doing unless a line is red.
      </div>
      {silence && <div style={S.warn}>{silence}</div>}
      {statusUnreadable && (
        <div style={S.warn}>
          Whether the mailbox is still being checked could not be read just now. The slips below are
          real; what is missing is the proof that nothing NEW is being missed.
        </div>
      )}
      {rows.length === 0 && !silence && (
        <div style={{ ...S.sub, fontSize: 12.5, marginTop: 10 }}>Nothing has come in by email yet.</div>
      )}
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {rows.map((r) => {
          const bad = (r.refused || 0) > 0;
          return (
            // A BUTTON, not a div with a click handler — and phrasing content
            // inside it, because a <button> may not legally contain a <div>. It is the only
            // interactive thing in this panel, and a div gets no keyboard, no
            // focus ring and nothing to announce — on a screen whose whole
            // purpose is that a refusal is noticed. (CodeRabbit, PR #510.)
            <button key={r.id} type="button"
                 onClick={() => setOpen(open === r.id ? null : r.id)}
                 aria-expanded={open === r.id}
                 style={{ display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit",
                          border: `1px solid ${bad ? "rgba(255,107,107,.35)" : "rgba(255,255,255,.09)"}`,
                          background: bad ? "rgba(255,107,107,.07)" : "rgba(255,255,255,.03)",
                          borderRadius: 11, padding: "9px 11px", cursor: "pointer" }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: bad ? "#FFB3B3" : "#E9EEFF", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.subject || "(no subject)"}
                </span>
                <span style={{ color: "rgba(233,238,255,.45)", flex: "0 0 auto", fontSize: 12 }}>{fmtTime(r.at)}</span>
              </span>
              <span style={{ display: "block", fontSize: 11.5, color: "rgba(233,238,255,.5)", marginTop: 3 }}>
                {r.from || "unknown sender"}
                {" · "}
                {[
                  r.recorded ? `${r.recorded} recorded` : null,
                  r.refused ? `${r.refused} REFUSED` : null,
                  r.unrelated ? `${r.unrelated} not a slip` : null,
                ].filter(Boolean).join(" · ") || "nothing to capture"}
              </span>
              {open === r.id && (
                <span style={{ marginTop: 8, display: "grid", gap: 5 }}>
                  {attachmentRows(r).map((a, i) => (
                    <span key={i} style={{ display: "block", fontSize: 12, lineHeight: 1.45,
                                          color: a.outcome === "refused" ? "#FFB3B3" : a.outcome === "recorded" ? "#B7F0CC" : "rgba(233,238,255,.5)" }}>
                      <span style={{ fontWeight: 700 }}>{a.filename}</span>
                      {a.outcome === "recorded"
                        ? ` — batch ${a.batchKey}${a.tid ? ` · TID ${a.tid}` : ""}${a.linesCaptured ? "" : " (summary only)"}`
                        : ` — ${a.reason}`}
                      {(a.warnings || []).map((w, j) => (
                        <span key={j} style={{ display: "block", color: "#FDE9B0", fontSize: 11.5 }}>{w}</span>
                      ))}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

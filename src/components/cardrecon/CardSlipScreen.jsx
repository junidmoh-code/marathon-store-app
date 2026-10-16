// ─── CARD SLIP — ONE TILL, ONE PHOTO, ONE NUMBER ─────────────────────────────
// Junid, 16 Oct 2026: Yasmin sends Marathon PE Till 2's daily card slip and
// Amanda Trophy Till 2's. Each evening, for their own till:
//
//   1. a photo of the speedpoint slip,
//   2. the card TOTAL printed on it, in rands — 0 if no card sales,
//   3. Submit → "Sent — thank you".
//
// That is the whole screen. They see nothing back: no expected figure, no
// variance, no verdict — the same capture-only rule as the managers' screen
// (captureOnly.test.js scans this file too). Junid reads the typed total and
// opens the photo in his own Card Recon report.
//
// WHO SEES IT: an account whose /users record carries a per-till scope
// (cardSlipTills — see slipScope.js). The till shown is the one the scope
// names, with the machine standing at it now. The server refuses any other
// till (cardBatchCapture, action "slip"); this screen only draws one.
//
// BOTH ARE REQUIRED. Submit stays off until there is a photo AND a figure, and
// says which one it is waiting for. "0" is a figure. Sending twice is fine:
// the second is recorded as a correction of the first, never dropped.
//
// THE NUMBER BOX is the app's typed-total pattern (inputMode "decimal" — the
// phone's own number pad), the same field Junid's typed total uses.

import React, { useEffect, useMemo, useState, useRef } from "react";
import { ref as dbRef, onValue } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { serverNowMs } from "../../utils/serverTime";
import { describeCallableError } from "./captureFailure";
import { preparePhoto } from "./slipPhoto";
import { slipTills } from "./slipScope";
import { FONT } from "./cardReconStyles";

const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 300000 });

const S = {
  page: { minHeight: "100vh", background: "#05070D", color: "#E9EEFF", fontFamily: FONT,
          padding: "14px 16px 56px", maxWidth: 520, margin: "0 auto", boxSizing: "border-box" },
  back: { appearance: "none", border: 0, background: "transparent", color: "rgba(233,238,255,.5)",
          fontFamily: FONT, fontSize: 15, fontWeight: 600, padding: "8px 4px", margin: "0 0 18px -4px",
          cursor: "pointer", minHeight: 44, display: "block" },
  h1: { fontSize: 27, fontWeight: 700, letterSpacing: "-0.5px", margin: 0 },
  day: { fontSize: 14, color: "rgba(233,238,255,.42)", marginTop: 5 },
  till: { fontSize: 19, fontWeight: 650, margin: "28px 2px 12px", letterSpacing: "-0.2px" },
  sheet: { display: "grid", gap: 10, padding: 14, borderRadius: 18,
           background: "rgba(255,255,255,.045)", border: "1px solid rgba(255,255,255,.09)" },
  step: { fontSize: 13, fontWeight: 700, letterSpacing: "0.02em", color: "rgba(233,238,255,.55)", marginTop: 4 },
  pair: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 },
  option: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 52,
            padding: "0 12px", borderRadius: 12, cursor: "pointer", fontFamily: FONT, fontSize: 15.5, fontWeight: 600,
            color: "#E9EEFF", background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.16)",
            boxSizing: "border-box", minWidth: 0, textAlign: "center" },
  // Rendered, not display:none — see CardReconScreen.jsx on why a phone
  // browser will only open a file input its label can see.
  input: { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" },
  attached: { display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 48,
              fontSize: 15, fontWeight: 600, color: "#54D97F" },
  replace: { position: "relative", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "rgba(233,238,255,.7)", padding: "8px 4px" },
  amount: { boxSizing: "border-box", width: "100%", minWidth: 0, minHeight: 54, borderRadius: 12, padding: "0 14px",
            fontFamily: FONT, fontSize: 22, fontWeight: 600, color: "#E9EEFF", background: "rgba(0,0,0,.25)",
            border: "1px solid rgba(255,255,255,.16)" },
  hint: { fontSize: 13, color: "rgba(233,238,255,.5)", margin: "-2px 2px 0" },
  submit: { appearance: "none", boxSizing: "border-box", width: "100%", minHeight: 54, borderRadius: 12, cursor: "pointer",
            fontFamily: FONT, fontSize: 17, fontWeight: 700, color: "#05070D", background: "#54D97F", border: 0, marginTop: 6 },
  submitOff: { opacity: 0.35, cursor: "default" },
  waiting: { fontSize: 13.5, fontWeight: 600, color: "#FFD479", textAlign: "center" },
  sent: { display: "grid", gap: 6, justifyItems: "center", padding: "26px 14px", borderRadius: 18, textAlign: "center",
          background: "rgba(52,199,89,.08)", border: "1px solid rgba(52,199,89,.25)" },
  sentTitle: { fontSize: 21, fontWeight: 700, color: "#54D97F" },
  again: { appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: FONT,
           fontSize: 14, fontWeight: 600, color: "rgba(233,238,255,.6)", minHeight: 44, marginTop: 4 },
  fail: { fontSize: 14, lineHeight: 1.5, color: "#FFB3B3", background: "rgba(255,107,107,.07)",
          border: "1px solid rgba(255,107,107,.28)", borderRadius: 14, padding: "12px 14px" },
  quiet: { fontSize: 14, color: "rgba(233,238,255,.45)", lineHeight: 1.55, marginTop: 28 },
};

const dayLabel = (ms) => new Date(ms).toLocaleDateString("en-ZA", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long" });

/** A refusal always reads as a sentence. */
const reasonOf = (r) => (typeof r?.reason === "string" && r.reason.trim())
  ? r.reason
  : "The slip was not sent, and no reason came back. Try again.";

export default function CardSlipScreen({ onExit }) {
  const { permRecord } = usePermissions();

  // The registry: which machine stands at this account's till.
  const [terminals, setTerminals] = useState(null);   // null = loading
  useEffect(() => {
    const off = onValue(dbRef(database, "config/cardTerminals"),
      (snap) => setTerminals(snap.val() || {}),
      () => setTerminals({}));
    return () => off();
  }, []);
  const nowMs = serverNowMs();
  const tills = useMemo(() => slipTills(terminals, permRecord, nowMs), [terminals, permRecord, nowMs]);

  return (
    <div style={S.page}>
      <button onClick={onExit} style={S.back}>← Home</button>
      <h1 style={S.h1}>Card slip</h1>
      <div style={S.day}>{dayLabel(nowMs)}</div>
      {terminals === null && <div style={S.quiet}>Loading…</div>}
      {terminals !== null && tills.length === 0 && (
        <div style={S.quiet}>Your till's card machine isn't set up here yet. Tell Junid.</div>
      )}
      {tills.map((t) => <TillSlip key={t.tid} till={t} />)}
    </div>
  );
}

function TillSlip({ till }) {
  const [photo, setPhoto] = useState(null);          // { base64 } once attached
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("form");         // form | attaching | sending | sent
  const [error, setError] = useState(null);
  // Only the LATEST pick may land: a slow decode of an earlier photo must never
  // replace the one picked after it.
  const attachSeq = useRef(0);

  const onPhoto = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    const seq = ++attachSeq.current;
    setError(null);
    setPhase("attaching");
    const { photo: ready, refusal } = await preparePhoto(files);
    if (seq !== attachSeq.current) return;
    setPhase("form");
    if (refusal) { setError(refusal); return; }
    setPhoto(ready);
  };

  const figure = text.trim();
  const busy = phase === "sending" || phase === "attaching";
  const canSend = !!photo && figure !== "" && !busy;

  const submit = async () => {
    if (!canSend) return;
    setError(null);
    setPhase("sending");
    try {
      const { data } = await cardBatchCaptureFn({
        action: "slip", pickedTid: till.tid, photos: [{ base64: photo.base64 }], declaredTotal: figure,
      });
      if (!data?.ok) { setPhase("form"); setError(reasonOf(data)); return; }
      setPhoto(null);
      setText("");
      setPhase("sent");
    } catch (err) {
      const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      const failure = describeCallableError(err, { online });
      console.error(failure.logLine, err);
      setPhase("form");
      setError(failure.message);
    }
  };

  return (
    <section aria-label={`Card slip for ${till.label}`}>
      <div style={S.till}>{till.label}</div>
      {phase === "sent" ? (
        <div style={S.sent} role="status" data-testid="slip-sent">
          <div style={S.sentTitle}>Sent — thank you</div>
          <button type="button" style={S.again} onClick={() => setPhase("form")}>Send it again</button>
        </div>
      ) : (
        <div style={S.sheet} data-testid="slip-form">
          <div style={S.step}>1 · Photo of the slip</div>
          {photo ? (
            <div style={S.attached}>
              <span>✓ Photo attached</span>
              <label style={S.replace}>
                <input type="file" accept="image/*" style={S.input} disabled={busy} onChange={onPhoto} />
                Retake
              </label>
            </div>
          ) : phase === "attaching" ? (
            <div style={S.attached}>Attaching…</div>
          ) : (
            <div style={S.pair}>
              <label style={S.option}>
                <input type="file" accept="image/*" capture="environment" style={S.input} onChange={onPhoto} />
                Take photo
              </label>
              <label style={S.option}>
                <input type="file" accept="image/*" style={S.input} onChange={onPhoto} />
                Choose photo
              </label>
            </div>
          )}
          <label style={S.step} htmlFor={`slip-total-${till.tid}`}>2 · Card total on the slip (R)</label>
          <input id={`slip-total-${till.tid}`} style={S.amount} inputMode="decimal" autoComplete="off" enterKeyHint="done"
                 placeholder="0.00" value={text} disabled={phase === "sending"}
                 onChange={(e) => setText(e.target.value)} />
          <div style={S.hint}>Type 0 if there were no card sales.</div>
          <button type="button" style={{ ...S.submit, ...(canSend ? null : S.submitOff) }} disabled={!canSend} onClick={submit}>
            {phase === "sending" ? "Sending…" : "Submit"}
          </button>
          {!busy && !canSend && (
            <div style={S.waiting} role="status">
              {!photo && figure === "" ? "Add the slip photo and type the card total to submit."
                : !photo ? "Add the slip photo (step 1) to submit."
                : "Type the card total (step 2) to submit."}
            </div>
          )}
          {error && <div style={S.fail} role="alert">{error}</div>}
        </div>
      )}
    </section>
  );
}

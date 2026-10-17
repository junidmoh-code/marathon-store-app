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
// WHAT IS REQUIRED (Junid, 17 Oct 2026): a typed-total till (Trophy Till 2 —
// its printer puts no total on the paper) needs the photo AND the figure;
// every other till (Marathon PE Till 2) needs the PHOTO ONLY, and the total is
// read off it on the server. Submit says what it is still waiting for. "0" is
// a figure. Sending twice is fine:
// the second is recorded as a correction of the first, never dropped.
//
// "SENT" IS THE SERVER'S WORD, NEVER THE PHONE'S (Junid, 17 Oct 2026 — Yasmin
// believed Marathon PE Till 2's slip had gone; it never reached the server).
// "Sent — thank you" appears only when the reply carries the server's receipt
// (when it kept the slip, for which trading day); anything else — a refusal,
// a dropped connection, a reply without a receipt — is "Not sent — try
// again", with the reason. And the till itself says whether today's slip is
// in, from the server's own log (cardBatchCapture "slipTills"), so a phone
// that was closed mid-send, or reopened tomorrow, shows the truth.
//
// THE NUMBER BOX is the app's typed-total pattern (inputMode "decimal" — the
// phone's own number pad), the same field Junid's typed total uses.

import React, { useEffect, useMemo, useState, useRef } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { serverNowMs } from "../../utils/serverTime";
import { describeCallableError, receiptOf } from "./captureFailure";
import { preparePhoto } from "./slipPhoto";
import { slipTills } from "./slipScope";
import { peekSlipTerminals, subscribeSlipTerminals, isSlipTerminalsLive, peekServerTills, subscribeServerTills, fetchServerTills } from "./slipTerminals";
import { FONT } from "./cardReconStyles";

// Two minutes, not five: the server keeps a slip in about a second, so a send
// still going after two is a connection that has died — and the person should
// be told "Not sent" while they are still standing there, not five minutes on.
const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 120000 });

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
  failTitle: { display: "block", fontSize: 16, fontWeight: 700, color: "#FF8A8A", marginBottom: 2 },
  sentAt: { fontSize: 14, color: "rgba(233,238,255,.6)" },
  status: { fontSize: 14, fontWeight: 600, margin: "-4px 2px 10px" },
  statusIn: { color: "#54D97F" },
  statusOut: { color: "rgba(233,238,255,.5)" },
  quiet: { fontSize: 14, color: "rgba(233,238,255,.45)", lineHeight: 1.55, marginTop: 28 },
};

const dayLabel = (ms) => new Date(ms).toLocaleDateString("en-ZA", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long" });
const clockOf = (ms) => new Date(ms).toLocaleTimeString("en-ZA", {
  timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false });
// THE TRADING DAY, as the server files slips (functions/lib/card-staff-slip-log.cjs):
// before 06:00 SAST it is still the evening before.
const SAST_MS = 2 * 60 * 60 * 1000;
const tradingDayMs = (ms) => (new Date(ms + SAST_MS).getUTCHours() < 6 ? ms - 7 * 60 * 60 * 1000 : ms);
const dayOfYmd = (ymd) => Date.parse(`${ymd}T12:00:00+02:00`);

/** A refusal always reads as a sentence. */
const reasonOf = (r) => (typeof r?.reason === "string" && r.reason.trim())
  ? r.reason
  : "The slip was not sent, and no reason came back. Try again.";

export default function CardSlipScreen({ onExit }) {
  const { permRecord, user } = usePermissions();
  const uid = user?.uid || null;

  // The registry: which machine stands at this account's till. Drawn at once
  // from what the home screen already fetched (or this device's last copy),
  // then kept live (slipTerminals.js). null = nothing known yet.
  const [terminals, setTerminals] = useState(() => peekSlipTerminals());
  // Live = this session has heard the registry itself, not only the device copy.
  const [live, setLive] = useState(() => isSlipTerminalsLive());
  useEffect(() => subscribeSlipTerminals((v) => { setTerminals(v); setLive(isSlipTerminalsLive()); }), []);
  // The same answer over HTTP, which no big download can queue in front of.
  const [serverTills, setServerTills] = useState(() => peekServerTills(uid));
  useEffect(() => subscribeServerTills(uid, setServerTills), [uid]);
  const nowMs = serverNowMs();
  const fromRegistry = useMemo(() => (terminals === null ? null : slipTills(terminals, permRecord, nowMs)), [terminals, permRecord, nowMs]);
  // Live registry first; else the server's live answer; else whatever this
  // device last knew. Submit is open once EITHER live answer is in.
  const tills = live ? fromRegistry : serverTills?.live ? serverTills.tills : (serverTills?.tills ?? fromRegistry);
  const confirmed = live || serverTills?.live === true;
  // TODAY'S SLIP IS IN — only from the server's live answer this session; the
  // device copy may be yesterday's. undefined = not known (yet).
  const sentByTid = useMemo(() => {
    if (serverTills?.live !== true) return {};
    return Object.fromEntries((serverTills.tills || []).filter((t) => t && t.sent !== undefined).map((t) => [t.tid, t.sent]));
  }, [serverTills]);
  const day = serverTills?.live && serverTills.dayYmd ? dayOfYmd(serverTills.dayYmd) : tradingDayMs(nowMs);
  const recheck = () => { if (uid) fetchServerTills(uid, { force: true }); };

  return (
    <div style={S.page}>
      <button onClick={onExit} style={S.back}>← Home</button>
      <h1 style={S.h1}>Card slip</h1>
      <div style={S.day}>{dayLabel(day)}</div>
      {tills === null && <div style={S.quiet}>Loading…</div>}
      {tills !== null && tills.length === 0 && (
        <div style={S.quiet}>Your till's card machine isn't set up here yet. Tell Junid.</div>
      )}
      {(tills || []).map((t) => <TillSlip key={t.tid} till={t} live={confirmed} sent={sentByTid[t.tid]} onSent={recheck} />)}
    </div>
  );
}

// live: the till drawn is confirmed by the live registry. Until then the form
// can be filled in (photo, total) but not sent.
// sent: the server's answer for today — { at } when today's slip is in, null
// when it is not, undefined when not known.
function TillSlip({ till, live = true, sent, onSent = () => {} }) {
  const [photo, setPhoto] = useState(null);          // { base64 } once attached
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("form");         // form | attaching | sending | sent
  const [error, setError] = useState(null);           // why the last send was NOT sent
  const [receipt, setReceipt] = useState(null);       // the server's { at, dayYmd } for "Sent"
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
  // A typed-total till (Trophy Till 2) needs the photo AND the figure; every
  // other till needs the photo only — its total is read off it.
  const needsFigure = till.typed === true;
  const canSend = !!photo && (!needsFigure || figure !== "") && !busy && live;

  const submit = async () => {
    if (!canSend) return;
    setError(null);
    setPhase("sending");
    try {
      const { data } = await cardBatchCaptureFn({
        action: "slip", pickedTid: till.tid, photos: [{ base64: photo.base64 }],
        ...(needsFigure ? { declaredTotal: figure } : {}),
      });
      const kept = receiptOf(data);
      if (!kept) {
        // A refusal in the server's words; an "ok" with no receipt is not a
        // slip the server has said it kept, so it is not "Sent" either.
        if (data?.ok === true) console.error("cardBatchCapture slip: ok without a receipt", data);
        setPhase("form");
        setError(data?.ok === true ? "The server did not confirm it kept the slip." : reasonOf(data));
        return;
      }
      setReceipt(kept);
      setPhoto(null);
      setText("");
      setPhase("sent");
      onSent();
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
      {phase !== "sent" && sent !== undefined && (
        <div style={{ ...S.status, ...(sent ? S.statusIn : S.statusOut) }} role="status" data-testid="slip-today">
          {sent ? `✓ Today's slip is in — sent at ${clockOf(sent.at)}.` : "No slip sent yet today."}
        </div>
      )}
      {phase === "sent" && receipt ? (
        <div style={S.sent} role="status" data-testid="slip-sent">
          <div style={S.sentTitle}>Sent — thank you</div>
          <div style={S.sentAt}>Received at {clockOf(receipt.at)}</div>
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
          {needsFigure && (<>
          <label style={S.step} htmlFor={`slip-total-${till.tid}`}>2 · Card total on the slip (R)</label>
          <input id={`slip-total-${till.tid}`} style={S.amount} inputMode="decimal" autoComplete="off" enterKeyHint="done"
                 placeholder="0.00" value={text} disabled={phase === "sending"}
                 onChange={(e) => setText(e.target.value)} />
          <div style={S.hint}>Type 0 if there were no card sales.</div>
          </>)}
          <button type="button" style={{ ...S.submit, ...(canSend ? null : S.submitOff) }} disabled={!canSend} onClick={submit}>
            {phase === "sending" ? "Sending…" : "Submit"}
          </button>
          {!busy && !canSend && (
            <div style={S.waiting} role="status">
              {!photo && needsFigure && figure === "" ? "Add the slip photo and type the card total to submit."
                : !photo ? (needsFigure ? "Add the slip photo (step 1) to submit." : "Add the slip photo to submit.")
                : needsFigure && figure === "" ? "Type the card total (step 2) to submit."
                : "Checking your till… one moment."}
            </div>
          )}
          {error && (
            <div style={S.fail} role="alert" data-testid="slip-not-sent">
              <strong style={S.failTitle}>Not sent — try again</strong>
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

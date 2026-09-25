// ─── CARD RECON — one card per till, one tick each ───────────────────────────
// A manager settles a card machine, tears off the Batch Report, and this screen
// answers one question: is today's report in? One card per terminal, a tick
// when it is, nothing loud when it is not. Ten seconds, at arm's length.
//
// HOW MANY TILLS IS THE REGISTRY'S ANSWER, never this file's. There were four
// on 29 Aug 2026 and there are six today.
//
// MOST TERMINALS EMAIL THEIR REPORT and tick on their own — the poller on the
// Mac mini captures the PDF with nobody involved. EVERY CARD IS TAPPABLE ALL
// THE SAME, and no machine is written down here as the one that cannot email: a
// terminal whose email fails, or which has never emailed, is captured by hand,
// which is what this path has always been for. The estate changed twice in
// three weeks — tills renamed, machines swapped for hardware that emails — and
// a screen that named the exception would have been wrong both times without
// saying so. What has arrived by email is read from the mailbox's own record
// (todaysArrivals.js); which machines exist is read from the registry
// (terminalRegistry.js). Neither answer is written into this file.
//
// THE READING IS INVISIBLE. Tapping a card opens the photo picker and that is
// the whole interaction — the extraction, every validation and the variance all
// run server-side exactly as before, and the manager is told one of two things:
// recorded, or a plain sentence saying why not. No figures, no confidence, no
// review step, no "read the slip" button to press afterwards. The owner reads
// the variance, the emailed slips and the EFT pool on his own reports tab; none
// of that belongs on a screen a manager uses for ten seconds. This file no
// longer renders a single money figure, and captureOnly.test.js now scans it
// like every other file in this directory to keep it that way.
//
// WHY THE PICKER OPENS FROM A <label> AND NOT FROM ref.click().
// The screen this replaced put the photo in a hidden input and opened it with
// JavaScript, behind a numbered form whose final button — "Read the slip" — was
// disabled unless a checkbox in the section ABOVE it had been ticked, and which
// looked exactly the same disabled as enabled (S.btn sets its own background,
// border and colour inline, so the browser's disabled styling never shows). A
// manager who put their one photo in the wrong slot, or who never found the
// checkbox, tapped a live-looking button that did nothing, for ever. Nothing
// reached the server on 31 Aug 2026 — the OCR usage log records zero calls
// against two successful captures on the 29th and 30th, both of them
// single-photo, summary-only, made by someone who knew where the checkbox was.
// There is now no gate button, no checkbox and no slots: the label IS the
// control, the OS opens the picker natively, and the upload starts on pick.
//
// KEYED BY TILL, NEVER BY A NAME. The slip prints a TID and no cashier; the
// server rejects a slip whose printed TID is not the card that was tapped, so
// the wrong slip on the wrong till refuses itself. Who worked the till is
// derived server-side and nobody selects a person anywhere in this feature.
//
// NOBODY TYPES A FIGURE — except Junid, in one place. A bad read is a retake.
// The exception: some printers print half the slip (Trophy Till 2, Marathon
// Till 2), so the total is not on the paper and a retake cannot help. For
// those, and ONLY on the owner's account, a camera card offers "Type the
// total": the figure goes up WITH a photo (still required, still stored), the
// server still reads the TID, batch and window off the slip, and the record
// says the total was declared by hand. The server enforces all of that — this
// file only hides the field from everyone else. It renders no money figure: the
// typed text is sent as typed and never echoed back.
//
// NO CARD NUMBERS. The masked PAN is parsed server-side for line identity and
// is never sent to this client.
//
// Gate: the dedicated `card_recon` permission — checked by the tile, by the
// route, and independently by the callable. Everything money-shaped happens in
// functions/cardRecon/cardRecon.js; this file is capture UX only.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref as dbRef, onValue, query, orderByChild, limitToLast } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions, auth } from "../../firebase";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { decodeImageFile, isAcceptedImageFile, describePickedFile } from "../shopify/imageDecode";
import { planPhotoIntake, payloadRefusal } from "./photoIntake";
import { describeCallableError, describeDecodeError } from "./captureFailure";
import { serverNowMs, saDateStringAt } from "../../utils/serverTime";
import { emailedArrivals, refusedArrivals, handCaptures, rememberHandCapture } from "./todaysArrivals";
import { captureCards, takesPhoto } from "./terminalRegistry";
import TerminalSettings from "./TerminalSettings";
import { FONT } from "./cardReconStyles";

const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 300000 });

// Slip photos need legible 8pt thermal print, so the downscale budget is wider
// than the label reader's 1024px. ~2000px keeps a full receipt column sharp and
// a JPEG comfortably under the callable's per-photo ceiling.
const MAX_PHOTO_DIM = 2000;

// A bounded tail, never the whole node: /card_batch_intake grows by a row per
// message for ever, and this runs on a handset on shop wifi. The tail has to
// cover several DAYS of arrivals, so it is sized against the estate rather than
// pinned to the four terminals that existed when it was written: six machines
// reporting once a day fill 25 rows in four days, and each added machine eats
// into that. 60 keeps a week's arrivals in view with room for the estate to
// grow again, and is still a tail rather than the node.
const INTAKE_FEED_SIZE = 60;

// The day key has to move on its own — a phone left on the counter through
// midnight must clear its ticks without being touched.
const DAY_ROLL_MS = 60 * 1000;

/**
 * A picked file → a ~2000px JPEG, whatever the phone handed over.
 *
 * DECODING GOES THROUGH THE SHARED DECODER, not FileReader + `new Image()`: an
 * iPhone's library stores HEIC and `new Image()` cannot decode it outside
 * Safari, so the naive path fails on exactly the phones this exists for.
 * decodeImageFile falls back to a lazily-imported wasm decoder and resizes
 * DURING decode where the browser supports it — on a phone, the difference
 * between one upload and three. The resize is gated on the picture's own
 * PIXELS, so a heavy but modest-resolution file is never upscaled on the way in.
 */
async function downscalePhoto(file) {
  const decoded = await decodeImageFile(file, MAX_PHOTO_DIM);
  try {
    const { source, width, height } = decoded;
    // decodeImageFile may already have resized during decode; scale from what
    // it actually returned rather than assuming it did or did not.
    const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.88);
    return { base64: jpeg.split(",")[1] || "" };
  } finally {
    // An ImageBitmap holds its pixels outside the JS heap; the collector is in
    // no hurry, and this runs on cheap handsets.
    decoded.release();
  }
}

// ── SKIN ─────────────────────────────────────────────────────────────────────
// Its own, not the old screen's: that palette was built for a stack of dense
// panels. This is four rows and a lot of air.
const T = {
  page: { minHeight: "100vh", background: "#05070D", color: "#E9EEFF", fontFamily: FONT,
          padding: "14px 16px 56px", maxWidth: 520, margin: "0 auto" },
  back: { appearance: "none", border: 0, background: "transparent", color: "rgba(233,238,255,.5)",
          fontFamily: FONT, fontSize: 15, fontWeight: 600, padding: "8px 4px", margin: "0 0 18px -4px",
          cursor: "pointer", minHeight: 44, display: "block" },
  h1: { fontSize: 27, fontWeight: 700, letterSpacing: "-0.5px", margin: 0 },
  titleRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  gear: { appearance: "none", border: 0, background: "transparent", cursor: "pointer", width: 44, height: 44,
          margin: "-6px -10px 0 0", display: "flex", alignItems: "center", justifyContent: "center",
          color: "rgba(233,238,255,.55)" },
  cardStatic: { cursor: "default" },
  day: { fontSize: 14, color: "rgba(233,238,255,.42)", marginTop: 5, letterSpacing: "-0.1px" },
  list: { marginTop: 30, display: "grid", gap: 12 },
  card: { position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 14, minHeight: 78, padding: "0 20px", borderRadius: 18, cursor: "pointer",
          background: "rgba(255,255,255,.045)", border: "1px solid rgba(255,255,255,.075)",
          WebkitTapHighlightColor: "transparent" },
  cardDone: { background: "rgba(52,199,89,.07)", border: "1px solid rgba(52,199,89,.22)" },
  cardBusy: { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", cursor: "default" },
  name: { fontSize: 17.5, fontWeight: 600, letterSpacing: "-0.2px", color: "#E9EEFF" },
  tick: { width: 27, height: 27, borderRadius: 999, background: "rgba(52,199,89,.16)", color: "#54D97F",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800 },
  camera: { opacity: 0.3, display: "block" },
  working: { fontSize: 14, fontWeight: 500, color: "rgba(233,238,255,.45)" },
  fail: { fontSize: 13.5, lineHeight: 1.5, color: "#FFB3B3", background: "rgba(255,107,107,.07)",
          border: "1px solid rgba(255,107,107,.28)", borderRadius: 14, padding: "12px 14px", marginTop: -4 },
  again: { appearance: "none", width: "100%", minHeight: 46, marginTop: -2, borderRadius: 14, cursor: "pointer",
           fontFamily: FONT, fontSize: 14.5, fontWeight: 600, color: "rgba(233,238,255,.8)",
           background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)" },
  quiet: { fontSize: 13, color: "rgba(233,238,255,.35)", lineHeight: 1.55, marginTop: 26 },
  // Rendered, not display:none. A file input the browser has laid out is one
  // its label can always open; display:none inputs are the thing phone browsers
  // and webviews quietly refuse to activate.
  input: { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" },
  // Junid's typed-total row: quiet until opened, and plainly a different act.
  typeToggle: { appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: FONT,
                fontSize: 13, fontWeight: 600, color: "rgba(180,160,255,.75)", textAlign: "left",
                padding: "2px 4px 6px", marginTop: -6, minHeight: 32 },
  typeBox: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: -4, padding: 12, borderRadius: 14,
             background: "rgba(150,120,255,.06)", border: "1px solid rgba(150,120,255,.28)" },
  typeInput: { minWidth: 0, minHeight: 46, borderRadius: 12, padding: "0 12px", fontFamily: FONT, fontSize: 17,
               color: "#E9EEFF", background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.14)" },
  typeGo: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 46,
            padding: "0 14px", borderRadius: 12, cursor: "pointer", fontFamily: FONT, fontSize: 14, fontWeight: 700,
            color: "#E9EEFF", background: "rgba(150,120,255,.28)", border: "1px solid rgba(150,120,255,.5)" },
  typeGoOff: { opacity: 0.4, cursor: "default" },
  typeCancel: { appearance: "none", gridColumn: "1 / -1", justifySelf: "start", border: 0, background: "transparent",
                cursor: "pointer", fontFamily: FONT, fontSize: 13, color: "rgba(233,238,255,.5)", padding: "4px 2px" },
  typeNote: { gridColumn: "1 / -1", fontSize: 12.5, lineHeight: 1.5, color: "rgba(233,238,255,.5)" },
};

/**
 * A refusal always reads as a sentence.
 *
 * The server's own reason is shown verbatim — it is written for the person
 * holding the slip — but a response that refuses without one must not render as
 * an empty red box, which says nothing and looks like a bug in the screen
 * rather than an answer about the slip.
 */
const reasonOf = (r) => (typeof r?.reason === "string" && r.reason.trim())
  ? r.reason
  : "The slip was not recorded, and no reason came back. Try again.";

/** The only ornament on the screen: a quiet camera on a till with nothing in. */
function CameraGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#E9EEFF"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
         style={T.camera} aria-hidden="true">
      <path d="M4 8.5h3l1.5-2h7L17 8.5h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.2" />
    </svg>
  );
}

/** Owner-only: the way into the terminal settings. */
function GearGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

const dayLabel = (ms) => new Date(ms).toLocaleDateString("en-ZA", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long" });

export default function CardReconScreen({ onExit }) {
  // ── THE SETTINGS SHEET IS JUNID'S ALONE ────────────────────────────────────
  // The same account the card-recon reports are gated to. Hiding the icon is
  // convenience; the callable refuses everyone else regardless.
  const isOwner = auth.currentUser?.email === ADMIN_EMAIL;
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── the registry: which machines exist, and what each till is called ──
  const [terminals, setTerminals] = useState(null);   // null = loading
  useEffect(() => {
    const off = onValue(dbRef(database, "config/cardTerminals"),
      (snap) => setTerminals(snap.val() || {}),
      () => setTerminals({}));
    return () => off();
  }, []);

  // ── what the mailbox recorded: the tick for the three that email ──
  const [intake, setIntake] = useState(undefined);    // undefined = loading, null = unreadable
  useEffect(() => {
    const off = onValue(
      query(dbRef(database, "card_batch_intake"), orderByChild("at"), limitToLast(INTAKE_FEED_SIZE)),
      (snap) => setIntake(snap.val() || {}),
      (err) => { setIntake(null); console.warn("card recon: intake read failed", err?.code || err); });
    return () => off();
  }, []);

  // THE SERVER'S CLOCK, not the device's, and re-read while the screen sits
  // open so the ticks clear at midnight on their own.
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const id = setInterval(() => setNowMs(serverNowMs()), DAY_ROLL_MS);
    return () => clearInterval(id);
  }, []);
  const today = saDateStringAt(nowMs);

  // Hand captures are remembered per device (see todaysArrivals.js); this is
  // state rather than a read-through so a fresh capture ticks immediately.
  const [mine, setMine] = useState(() => handCaptures(saDateStringAt(serverNowMs())));
  useEffect(() => setMine(handCaptures(today)), [today]);

  // tid → { phase: "busy" | "failed", reason, canReplace }
  const [work, setWork] = useState({});
  // The photo of the last attempt, kept only so "replace the earlier capture"
  // does not ask for it to be taken again.
  const lastPhoto = useRef({});
  // …and the typed total that went with it, so the replace carries it too.
  const lastTyped = useRef({});

  // ── JUNID'S TYPED TOTAL — which card has the field open, and what is in it ──
  const [typing, setTyping] = useState({});   // tid → the text as typed
  const closeTyping = (tid) => setTyping((prev) => {
    const next = { ...prev };
    delete next[tid];
    return next;
  });

  // A RETIRED MACHINE HAS NO CARD. Which ones those are, and the order the rest
  // are drawn in, is the registry module's decision — see terminalRegistry.js.
  const terminalList = useMemo(() => captureCards(terminals), [terminals]);

  const arrived = useMemo(() => {
    const byEmail = emailedArrivals(intake, today, saDateStringAt);
    for (const tid of mine) byEmail.add(tid);
    return byEmail;
  }, [intake, today, mine]);

  // ── A REFUSED REPORT IS NEITHER A TICK NOR A SILENCE ──────────────────────
  // It used to be a silence: `arrived` takes recorded rows only — rightly — so
  // a refused report left the card showing the same camera glyph as a till
  // that had not reported at all. Marathon Till 1's refusal on 19 Sept 2026
  // was invisible all day for exactly that reason, while the server's own
  // sentence explaining it sat unread in the feed. See refusedArrivals.
  const refused = useMemo(
    () => refusedArrivals(intake, today, saDateStringAt),
    [intake, today]);

  const setPhase = (tid, value) => setWork((prev) => {
    const next = { ...prev };
    if (value) next[tid] = value; else delete next[tid];
    return next;
  });

  // ── THE CAPTURE, START TO FINISH, WITH NOTHING IN BETWEEN ──────────────────
  // extract → submit, in one go. The old screen parked the draft and asked the
  // manager to confirm the figures it had read; the figures are no longer shown,
  // so there is nothing to confirm. The callable is untouched: the same two
  // actions, the same payload one photo makes, the same refusals.
  const send = async (tid, base64, correction, declaredTotal) => {
    setPhase(tid, { phase: "busy" });
    try {
      const { data } = await cardBatchCaptureFn({
        action: "extract", pickedTid: tid, photos: [{ base64 }],
        // Junid's typed total, as typed; the server parses, gates and records it.
        ...(declaredTotal ? { declaredTotal } : {}),
        // ONE PHOTO IS A SUMMARY. It always was: the screen this replaced sent
        // `summaryOnly || detailPhotos.length === 0`, so a single-photo capture
        // was flagged summary-only whether or not the checkbox was ticked. The
        // record still carries the server's warning that no line-level match
        // can run for it.
        summaryOnly: true, correction,
      });
      if (!data.ok) {
        setPhase(tid, { phase: "failed", reason: reasonOf(data),
                        // The one refusal with a way out. Matched on the
                        // server's own words — widened to either half of the
                        // sentence it writes, so a re-word of one clause does
                        // not silently strand a manager with a bad capture.
                        canReplace: /already captured|resubmit as a correction/i.test(data.reason || "") });
        return;
      }
      // `{ data }`, not the envelope: a callable resolves to { data }, and
      // reading .ok off the envelope makes every submit look refused — with an
      // undefined reason, which renders as an empty red box saying nothing.
      const { data: done } = await cardBatchCaptureFn({ action: "submit", draftId: data.draftId });
      if (!done.ok) { setPhase(tid, { phase: "failed", reason: reasonOf(done) }); return; }
      rememberHandCapture(tid, today);
      setMine((prev) => new Set(prev).add(tid));
      setPhase(tid, null);
      delete lastPhoto.current[tid];
      delete lastTyped.current[tid];
      if (declaredTotal) closeTyping(tid);
    } catch (err) {
      // ── THE FAILURE NAMES ITSELF ─────────────────────────────────────────
      // This used to answer EVERY thrown error with "That did not go through.
      // Check the signal and try again." — including the whole of 19 Sept
      // 2026, when the signal was fine and the OCR account was out of credit.
      // A refusal the server wrote is now shown in the server's own words; a
      // transport failure says it was the connection; anything unidentified
      // says so and is logged with its code, so it can be chased afterwards.
      // See captureFailure.js.
      const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      const failure = describeCallableError(err, { online });
      console.error(failure.logLine, err);
      setPhase(tid, { phase: "failed", reason: failure.message,
                      // A duplicate refusal thrown as an error carries the same
                      // way out as one returned in the envelope.
                      canReplace: /already captured|resubmit as a correction/i.test(failure.message) });
    }
  };

  const onPick = (tid, declaredTotal) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    // The typed path never sends without a figure — nor, below, without a photo.
    if (declaredTotal !== undefined && !String(declaredTotal).trim()) {
      setPhase(tid, { phase: "failed", reason: "Type the total first, then photograph the slip." });
      return;
    }

    // The decision about what is usable stays in the tested pure module, cap 1:
    // a non-photo is refused BY NAME rather than as "that doesn't look like a
    // photo" about a photo.
    const { take, refusal } = planPhotoIntake({
      current: [], files, cap: 1, replace: true,
      isImage: isAcceptedImageFile, describe: describePickedFile,
    });
    if (refusal) { setPhase(tid, { phase: "failed", reason: refusal }); return; }

    setPhase(tid, { phase: "busy" });
    let photo;
    try {
      photo = await downscalePhoto(take[0]);
    } catch (err) {
      // The decoder writes its own sentences for a person — an unsupported or
      // Apple-format photo is named as such rather than parenthesised into a
      // raw message. See captureFailure.js.
      const failure = describeDecodeError(err);
      console.error(failure.logLine, err);
      setPhase(tid, { phase: "failed", reason: failure.message });
      return;
    }
    // Refused HERE rather than as a transport error nobody can read.
    const tooBig = payloadRefusal([photo]);
    if (tooBig) { setPhase(tid, { phase: "failed", reason: tooBig }); return; }
    lastPhoto.current[tid] = photo.base64;
    const typed = declaredTotal !== undefined ? String(declaredTotal).trim() : undefined;
    if (typed) lastTyped.current[tid] = typed; else delete lastTyped.current[tid];
    await send(tid, photo.base64, false, typed);
  };

  return (
    <div style={T.page}>
      <button onClick={onExit} style={T.back}>← Home</button>
      <div style={T.titleRow}>
        <h1 style={T.h1}>Card machines</h1>
        {isOwner && !settingsOpen && (
          <button style={T.gear} aria-label="Terminal settings" onClick={() => setSettingsOpen(true)}>
            <GearGlyph />
          </button>
        )}
      </div>
      <div style={T.day}>{dayLabel(nowMs)}</div>

      {isOwner && settingsOpen && (
        <TerminalSettings terminals={terminals} onClose={() => setSettingsOpen(false)} />
      )}

      {!settingsOpen && <div style={T.list}>
        {terminals === null && <div style={T.quiet}>Loading…</div>}
        {terminals !== null && terminalList.length === 0 && (
          <div style={T.quiet}>
            No card machines are registered yet. An admin maps each machine to its till under
            /config/cardTerminals before slips can be captured.
          </div>
        )}
        {terminalList.map((t) => {
          const state = work[t.tid] || {};
          const busy = state.phase === "busy";
          const done = arrived.has(t.tid);
          // AN EMAIL-ONLY TILL HAS NO CAMERA — set in the terminal settings.
          // Its card is the tick and nothing else: no input, nothing to tap.
          const camera = takesPhoto(t);
          const cardStyle = { ...T.card, ...(done ? T.cardDone : null), ...(busy ? T.cardBusy : null) };
          const face = (
            <>
              <span style={T.name}>{t.label || `${t.storeId} · ${t.tillId}`}</span>
              {busy ? <span style={T.working}>Reading…</span>
                : done ? <span style={T.tick} aria-label="today's report is in">✓</span>
                /* Quiet on purpose: a till with nothing in raises no alarm,
                   only the hint that a photo is what it takes. Drawn rather
                   than typed — an emoji renders as a grey smudge at this
                   opacity, and differently on every handset. */
                : camera ? <CameraGlyph /> : null}
            </>
          );
          return (
            <React.Fragment key={t.tid}>
              {camera ? (
                <label style={cardStyle}>
                  <input type="file" accept="image/*" style={T.input}
                         disabled={busy} onChange={onPick(t.tid)} />
                  {face}
                </label>
              ) : (
                <div style={{ ...cardStyle, ...T.cardStatic }}>{face}</div>
              )}
              {state.phase === "failed" && <div style={T.fail}>{state.reason}</div>}
              {/* The mailbox's own refusal, when this card has no capture of
                  its own on screen to say something more current. */}
              {state.phase !== "failed" && !done && refused.has(t.tid) && (
                <div style={T.fail}>
                  Its emailed report arrived today and was not recorded. {refused.get(t.tid)}
                </div>
              )}
              {state.phase === "failed" && state.canReplace && lastPhoto.current[t.tid] && (
                <button style={T.again}
                        onClick={() => send(t.tid, lastPhoto.current[t.tid], true, lastTyped.current[t.tid])}>
                  Replace the earlier capture
                </button>
              )}
              {/* JUNID ONLY: a total typed beside the photo, for a slip whose
                  printer did not print one. Never offered to anyone else, and
                  refused by the server for anyone else regardless. */}
              {isOwner && camera && !busy && (typing[t.tid] === undefined ? (
                <button style={T.typeToggle} onClick={() => setTyping((prev) => ({ ...prev, [t.tid]: "" }))}>
                  Slip didn&rsquo;t print its total? Type it
                </button>
              ) : (
                <div style={T.typeBox}>
                  <input style={T.typeInput} inputMode="decimal" autoComplete="off" enterKeyHint="done"
                         aria-label={`Total for ${t.label || t.tid}, typed by hand`}
                         placeholder="Total, e.g. 12,345.67" value={typing[t.tid]}
                         onChange={(e) => { const v = e.target.value; setTyping((prev) => ({ ...prev, [t.tid]: v })); }} />
                  <label style={{ ...T.typeGo, ...(typing[t.tid].trim() ? null : T.typeGoOff) }}>
                    <input type="file" accept="image/*" style={T.input}
                           disabled={!typing[t.tid].trim()} onChange={onPick(t.tid, typing[t.tid])} />
                    Photograph the slip
                  </label>
                  <button style={T.typeCancel} onClick={() => closeTyping(t.tid)}>Cancel</button>
                  <div style={T.typeNote}>
                    The photo is still required. The total is recorded as typed by you, and the
                    report marks this batch as declared by hand.
                  </div>
                </div>
              ))}
            </React.Fragment>
          );
        })}
      </div>}

      {/* A read that was DENIED is not an empty feed, and must never be shown as
          one: without the mailbox we cannot say whether the three that email
          have reported, and a missing tick would read as "it never arrived". */}
      {intake === null && (
        <div style={T.quiet}>
          What has arrived by email cannot be read right now, so those ticks may be missing.
        </div>
      )}
    </div>
  );
}

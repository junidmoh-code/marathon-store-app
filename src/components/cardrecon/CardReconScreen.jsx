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
// THE READING IS INVISIBLE — AND LATER. Tapping a card opens the photo picker
// and that is the whole interaction. Since 7 Oct 2026 the photo is RECEIVED:
// stored on the server at once, and read there afterwards with retries (the
// extraction, every validation and the variance run exactly as before, in a
// background job). The manager is told "Received" and nothing else — not even
// whether it read; a slip that never reads is Junid's, in his POS report and
// his inbox. Only a photo that did not reach the server is reported back. No figures, no confidence, no
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
// TAPPING A CARD OPENS A SMALL CHOOSER, under that card only, and nothing sits
// under a card otherwise: the list is one card per till, name plus tick or
// camera glyph. The chooser offers "Photograph the slip" (the camera) and
// "Choose from gallery / file" — each is a <label> around its own file input,
// for the reason above — and, for Junid alone, "Type the total".
//
// NOBODY TYPES A FIGURE — except Junid, in that one place. A bad read is a
// retake. Some printers print half the slip (Trophy Till 2, Marathon Till 2),
// so the total is not on the paper and a retake cannot help. "Type the total"
// runs in a fixed order: 1, attach the photo (still required, still stored);
// 2, type the total; 3, one Submit, enabled only once both are there. The
// server still reads the TID, batch and window off the slip, and the record
// says the total was declared by hand. The server enforces all of that — this
// file only hides the option from everyone else. It renders no money figure:
// the typed text is sent as typed and never echoed back.
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
import { captureCards, cardsBySection, takesPhoto, typesTotal } from "./terminalRegistry";
import { useMySections } from "../../utils/useMySections";
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
  // A section's name above its tills — drawn only when two sections are on screen.
  section: { fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
             color: "rgba(233,238,255,.42)", margin: "10px 2px -2px" },
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
  // The card as a tap target: a <button> that looks exactly like the card did.
  cardButton: { appearance: "none", width: "100%", textAlign: "left", fontFamily: FONT, color: "inherit",
                font: "inherit" },
  // The chooser and the typed-total panel: under the tapped card only.
  sheet: { display: "grid", gap: 8, marginTop: -4, padding: 12, borderRadius: 16,
           background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)" },
  option: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 48,
            padding: "0 14px", borderRadius: 12, cursor: "pointer", appearance: "none", fontFamily: FONT,
            fontSize: 15, fontWeight: 600, color: "#E9EEFF", background: "rgba(255,255,255,.06)",
            border: "1px solid rgba(255,255,255,.14)", width: "100%", boxSizing: "border-box", minWidth: 0,
            textAlign: "center" },
  sheetCancel: { appearance: "none", border: 0, background: "transparent", cursor: "pointer", fontFamily: FONT,
                 fontSize: 14, color: "rgba(233,238,255,.55)", minHeight: 40 },
  step: { fontSize: 12.5, fontWeight: 700, letterSpacing: "0.02em", color: "rgba(233,238,255,.5)", marginTop: 2 },
  pair: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 },
  attached: { display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44,
              fontSize: 14.5, fontWeight: 600, color: "#54D97F" },
  replace: { position: "relative", cursor: "pointer", fontSize: 13.5, fontWeight: 600, color: "rgba(233,238,255,.7)",
             padding: "8px 4px" },
  typeInput: { boxSizing: "border-box", width: "100%", minWidth: 0, minHeight: 48, borderRadius: 12, padding: "0 12px", fontFamily: FONT, fontSize: 17,
               color: "#E9EEFF", background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.14)" },
  submit: { appearance: "none", boxSizing: "border-box", width: "100%", minHeight: 50, borderRadius: 12, cursor: "pointer", fontFamily: FONT, fontSize: 16,
            fontWeight: 700, color: "#05070D", background: "#54D97F", border: 0, marginTop: 4 },
  submitOff: { opacity: 0.35, cursor: "default" },
  // What Submit is waiting for, said in words — a grey button alone did not.
  waiting: { fontSize: 13, fontWeight: 600, color: "#FFD479", textAlign: "center" },
  // "Received" — the whole of what a manager is told about a photographed slip.
  received: { fontSize: 13, fontWeight: 600, color: "#9BE7A7", padding: "2px 4px 6px" },
  typeNote: { fontSize: 12.5, lineHeight: 1.5, color: "rgba(233,238,255,.5)" },
  // The typed-total card's hint, where the camera glyph sits on the others.
  // Words rather than a glyph: there is no icon for "type a number" that a
  // manager reads correctly at arm's length, and the quiet grey keeps it at the
  // same weight as the camera it stands in for — a prompt, never an alarm.
  typedHint: { fontSize: 13, fontWeight: 600, color: "rgba(233,238,255,.4)", whiteSpace: "nowrap" },
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

  // Tills whose photo went in the background way this session — their tick
  // means "received", never "read".
  const [received, setReceived] = useState(() => new Set());
  // tid → { phase: "busy" | "failed", reason, canReplace }
  const [work, setWork] = useState({});
  // The photo of the last attempt, kept only so "replace the earlier capture"
  // does not ask for it to be taken again.
  const lastPhoto = useRef({});
  // …and the typed total that went with it, so the replace carries it too.
  const lastTyped = useRef({});

  // ── THE CHOOSER — open under ONE card at a time, or none ──────────────────
  const [chooserFor, setChooserFor] = useState(null);   // tid | null

  // ── JUNID'S TYPED TOTAL — one flow at a time: its till, photo and text ──────
  // photo: null | { base64 } once attached (already decoded and downscaled).
  const [typed, setTyped] = useState(null);             // { tid, photo, text } | null
  const [attaching, setAttaching] = useState(false);
  // Every attach gets a number; only the LATEST may land. A slow decode of an
  // earlier pick must never replace the photo picked after it. (CodeRabbit, PR #650.)
  const attachSeq = useRef(0);

  // A RETIRED MACHINE HAS NO CARD. Which ones those are, and the order the rest
  // are drawn in, is the registry module's decision — see terminalRegistry.js.
  //
  // …AND A TILL IN ANOTHER SECTION HAS NO CARD FOR THIS VIEWER. Which section a
  // till's store is in comes from the network registry; which sections this
  // account (or this enrolled device) works in from useMySections. The cards
  // are grouped by section, and the callable refuses the rest regardless.
  const { sections, registry } = useMySections();
  const cardGroups = useMemo(
    () => cardsBySection(captureCards(terminals), registry, sections),
    [terminals, registry, sections]);
  const terminalList = useMemo(() => cardGroups.flatMap((g) => g.cards), [cardGroups]);

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
    // ── A PHOTO IS RECEIVED, NOT READ, WHILE THE MANAGER WAITS ────────────────
    // Junid, 7 Oct 2026: the submit answers "Received" at once and the reading
    // happens on the server afterwards, with retries. The manager is told
    // nothing about how it went — not a figure, not a verdict, not even whether
    // it read. The ONE exception is Junid's typed total, which is checked
    // against the photo while he holds the phone (below).
    if (!declaredTotal) {
      setPhase(tid, { phase: "busy", sending: true });
      try {
        const { data } = await cardBatchCaptureFn({ action: "receive", pickedTid: tid, photos: [{ base64 }] });
        // A refusal here is never about the slip — it is a till this account
        // cannot capture (another section, set to email only), said in the
        // server's own words.
        if (!data?.ok) { setPhase(tid, { phase: "failed", reason: reasonOf(data) }); return; }
        rememberHandCapture(tid, today);
        setMine((prev) => new Set(prev).add(tid));
        setReceived((prev) => new Set(prev).add(tid));
        setPhase(tid, { phase: "received" });
        delete lastPhoto.current[tid];
      } catch (err) {
        // The photo did not reach the server — that, and only that, is worth
        // telling the manager, because sending it again is the fix.
        const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
        const failure = describeCallableError(err, { online });
        console.error(failure.logLine, err);
        setPhase(tid, { phase: "failed", reason: failure.message });
      }
      return;
    }
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
      // Only THIS till's panel closes — the send is async, and Junid may have
      // opened another card's by now. (CodeRabbit, PR #650.)
      if (declaredTotal) setTyped((prev) => (prev && prev.tid === tid ? null : prev));
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

  /**
   * A picked file → a sendable photo, or a sentence saying why not. Shared by
   * both paths, so a typed-total photo is decoded, downscaled and size-checked
   * exactly like any other.
   */
  const preparePhoto = async (files) => {
    // The decision about what is usable stays in the tested pure module, cap 1:
    // a non-photo is refused BY NAME rather than as "that doesn't look like a
    // photo" about a photo.
    const { take, refusal } = planPhotoIntake({
      current: [], files, cap: 1, replace: true,
      isImage: isAcceptedImageFile, describe: describePickedFile,
    });
    if (refusal) return { refusal };
    let photo;
    try {
      photo = await downscalePhoto(take[0]);
    } catch (err) {
      // The decoder writes its own sentences for a person — an unsupported or
      // Apple-format photo is named as such rather than parenthesised into a
      // raw message. See captureFailure.js.
      const failure = describeDecodeError(err);
      console.error(failure.logLine, err);
      return { refusal: failure.message };
    }
    // Refused HERE rather than as a transport error nobody can read.
    const tooBig = payloadRefusal([photo]);
    return tooBig ? { refusal: tooBig } : { photo };
  };

  // The ordinary capture: the pick IS the send — nothing stands in between.
  const onPick = (tid) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setChooserFor(null);
    setPhase(tid, { phase: "busy" });
    const { photo, refusal } = await preparePhoto(files);
    if (refusal) { setPhase(tid, { phase: "failed", reason: refusal }); return; }
    lastPhoto.current[tid] = photo.base64;
    delete lastTyped.current[tid];
    await send(tid, photo.base64, false);
  };

  // The typed-total path, step 1: the photo is ATTACHED, not sent.
  const onTypedPhoto = (tid) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setPhase(tid, null);
    const seq = ++attachSeq.current;
    setAttaching(true);
    const { photo, refusal } = await preparePhoto(files);
    if (seq !== attachSeq.current) return;   // a newer pick owns the panel (and its spinner)
    setAttaching(false);
    if (refusal) { setPhase(tid, { phase: "failed", reason: refusal }); return; }
    setTyped((prev) => (prev && prev.tid === tid ? { ...prev, photo } : prev));
  };

  // Step 3: one Submit, with both the photo and the figure — or not at all.
  const submitTyped = async () => {
    if (!typed || !typed.photo || !typed.text.trim()) return;
    const { tid, photo } = typed;
    const text = typed.text.trim();
    lastPhoto.current[tid] = photo.base64;
    lastTyped.current[tid] = text;
    await send(tid, photo.base64, false, text);
  };

  // ── A TYPED-TOTAL MACHINE — one figure, and that is the whole capture ──────
  // Trophy Till 2 cannot email and does not print its total, so there is no
  // photograph to take. Its card carries one box; this sends it. The server
  // does the rest, including deciding whether the machine really is set up this
  // way — the card is hidden from a machine that is not, and the callable
  // refuses it regardless.
  const sendTyped = async (tid, text, correction) => {
    setPhase(tid, { phase: "busy" });
    try {
      const { data } = await cardBatchCaptureFn({
        action: "typed", pickedTid: tid, declaredTotal: text, correction,
      });
      if (!data.ok) {
        setPhase(tid, { phase: "failed", reason: reasonOf(data),
                        // The one refusal with a way out, worded by the server:
                        // a figure already typed in today can be replaced.
                        canReplace: /already been typed in today|submit this one as a replacement/i.test(data.reason || "") });
        return;
      }
      const { data: done } = await cardBatchCaptureFn({ action: "submit", draftId: data.draftId });
      if (!done.ok) { setPhase(tid, { phase: "failed", reason: reasonOf(done) }); return; }
      rememberHandCapture(tid, today);
      setMine((prev) => new Set(prev).add(tid));
      setPhase(tid, null);
      delete lastTyped.current[tid];
      // Only THIS till's panel closes — another card's may have been opened
      // while this was in flight.
      setTyped((prev) => (prev && prev.tid === tid ? null : prev));
    } catch (err) {
      const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      const failure = describeCallableError(err, { online });
      console.error(failure.logLine, err);
      setPhase(tid, { phase: "failed", reason: failure.message,
                      canReplace: /already been typed in today|submit this one as a replacement/i.test(failure.message) });
    }
  };

  const submitTypedOnly = async (tid, correction = false) => {
    const text = (typed && typed.tid === tid ? typed.text : lastTyped.current[tid] || "").trim();
    if (!text) return;
    lastTyped.current[tid] = text;
    await sendTyped(tid, text, correction);
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
        {terminals !== null && terminalList.length === 0 && captureCards(terminals).length === 0 && (
          <div style={T.quiet}>
            No card machines are registered yet. An admin maps each machine to its till under
            /config/cardTerminals before slips can be captured.
          </div>
        )}
        {/* Machines exist, none of them in this viewer's section — a different
            sentence, because "none registered" would send them to Junid for a
            setup that is already done. */}
        {terminals !== null && terminalList.length === 0 && captureCards(terminals).length > 0 && (
          <div style={T.quiet}>
            There are no card machines in your section yet. Junid adds them in Card machines → settings.
          </div>
        )}
        {terminalList.map((t) => {
          // The section heading, above the FIRST card of each group — and only
          // when there is more than one group, so a one-section viewer sees the
          // plain list.
          const group = cardGroups.length > 1 ? cardGroups.find((g) => g.cards[0] === t) : null;
          const state = work[t.tid] || {};
          const busy = state.phase === "busy";
          const done = arrived.has(t.tid);
          // AN EMAIL-ONLY TILL HAS NO CAMERA — set in the terminal settings.
          // Its card is the tick and nothing else: no input, nothing to tap.
          const camera = takesPhoto(t);
          // A TYPED-TOTAL TILL HAS NO CAMERA EITHER, but it is not silent: it
          // is tappable, and what opens is one box for the figure. The two are
          // mutually exclusive by construction (terminalRegistry.js), so a card
          // can never offer both a camera and a figure box.
          const typedOnly = typesTotal(t);
          const cardStyle = { ...T.card, ...(done ? T.cardDone : null), ...(busy ? T.cardBusy : null) };
          const face = (
            <>
              <span style={T.name}>{t.label || `${t.storeId} · ${t.tillId}`}</span>
              {busy ? <span style={T.working}>{state.sending ? "Sending…" : "Reading…"}</span>
                /* A photo is RECEIVED, not yet read — the tick says so, and
                   says nothing about whether it read (that is Junid's). */
                : done ? <span style={T.tick} aria-label={received.has(t.tid) ? "today's slip is received" : "today's report is in"}>✓</span>
                /* Quiet on purpose: a till with nothing in raises no alarm,
                   only the hint that a photo is what it takes. Drawn rather
                   than typed — an emoji renders as a grey smudge at this
                   opacity, and differently on every handset. */
                : camera ? <CameraGlyph />
                /* A typed-total till says what it wants, because a camera
                   glyph would be a lie and a blank card reads as "nothing to
                   do here" — the one thing it must not say. */
                : typedOnly ? <span style={T.typedHint}>{isOwner ? "Type total" : "Junid enters this"}</span> : null}
            </>
          );
          return (
            <React.Fragment key={t.tid}>
              {group && group.name && <div style={T.section} data-section-heading={group.section}>{group.name}</div>}
              {camera ? (
                <button type="button" style={{ ...cardStyle, ...T.cardButton }} disabled={busy}
                        aria-expanded={chooserFor === t.tid}
                        onClick={() => { setTyped(null); setChooserFor(chooserFor === t.tid ? null : t.tid); }}>
                  {face}
                </button>
              ) : typedOnly && isOwner ? (
                <button type="button" style={{ ...cardStyle, ...T.cardButton }} disabled={busy}
                        aria-expanded={!!typed && typed.tid === t.tid}
                        onClick={() => { setChooserFor(null);
                          setTyped((prev) => (prev && prev.tid === t.tid ? null : { tid: t.tid, photo: null, text: "" })); }}>
                  {face}
                </button>
              ) : (
                <div style={{ ...cardStyle, ...T.cardStatic }}>{face}</div>
              )}
              {state.phase === "received" && <div style={T.received} role="status">Received</div>}
              {state.phase === "failed" && <div style={T.fail}>{state.reason}</div>}
              {/* The mailbox's own refusal, when this card has no capture of
                  its own on screen to say something more current. */}
              {state.phase !== "failed" && !done && refused.has(t.tid) && (
                <div style={T.fail}>
                  Its emailed report arrived today and was not recorded. {refused.get(t.tid)}
                </div>
              )}
              {state.phase === "failed" && state.canReplace && !typedOnly && lastPhoto.current[t.tid] && (
                <button style={T.again}
                        onClick={() => send(t.tid, lastPhoto.current[t.tid], true, lastTyped.current[t.tid])}>
                  Replace the earlier capture
                </button>
              )}
              {/* The same way out on the typed path: there is no photo to carry
                  over, only the figure that was just refused as a second entry
                  for today. Resent as a replacement, it supersedes the first —
                  both records are kept, as the server's own sentence says. */}
              {state.phase === "failed" && state.canReplace && typedOnly && lastTyped.current[t.tid] && (
                <button style={T.again} onClick={() => submitTypedOnly(t.tid, true)}>
                  Replace today's typed total
                </button>
              )}
              {/* THE CHOOSER — only under the card that was tapped. Each photo
                  option is a <label> around its own input: see the header on
                  why the picker is never opened by ref.click(). */}
              {camera && !busy && chooserFor === t.tid && (
                <div style={T.sheet} data-testid="capture-chooser">
                  <label style={T.option}>
                    <input type="file" accept="image/*" capture="environment" style={T.input}
                           onChange={onPick(t.tid)} />
                    Photograph the slip
                  </label>
                  <label style={T.option}>
                    <input type="file" accept="image/*" style={T.input} onChange={onPick(t.tid)} />
                    Choose from gallery / file
                  </label>
                  {/* JUNID ONLY. Never offered to anyone else, and refused by
                      the server for anyone else regardless. */}
                  {isOwner && (
                    <button type="button" style={T.option}
                            onClick={() => { setChooserFor(null); setTyped({ tid: t.tid, photo: null, text: "" }); }}>
                      Type the total
                    </button>
                  )}
                  <button type="button" style={T.sheetCancel} onClick={() => setChooserFor(null)}>Cancel</button>
                </div>
              )}
              {/* A TYPED-TOTAL MACHINE — one box, one button, no photo step.
                  JUNID ONLY again (7 Oct 2026: "Staff never type numbers").
                  Everyone else sees the card and who enters it, and nothing to
                  tap; an evening he is not here is entered later from the POS
                  report. The server holds the same line. */}
              {typedOnly && isOwner && typed && typed.tid === t.tid && (
                <div style={T.sheet} data-testid="typed-only">
                  <div style={T.step}>Total on the machine</div>
                  <input style={T.typeInput} inputMode="decimal" autoComplete="off" enterKeyHint="done"
                         aria-label={`Total for ${t.label || t.tid}, typed by hand`}
                         placeholder="e.g. 2,250.00" value={typed.text} disabled={busy}
                         onChange={(e) => { const v = e.target.value; setTyped((prev) => (prev ? { ...prev, text: v } : prev)); }} />
                  <button type="button" style={{ ...T.submit, ...(typed.text.trim() && !busy ? null : T.submitOff) }}
                          disabled={!typed.text.trim() || busy}
                          onClick={() => submitTypedOnly(t.tid)}>
                    {busy ? "Sending…" : "Submit"}
                  </button>
                  {!busy && !typed.text.trim() && (
                    <div style={T.waiting} role="status">Type the total to submit.</div>
                  )}
                  <button type="button" style={T.sheetCancel} disabled={busy} onClick={() => setTyped(null)}>Cancel</button>
                  <div style={T.typeNote}>
                    This machine has no slip to photograph, so the figure is the whole record.
                    It is kept against your name, and the period it covers runs from the last
                    time this machine was captured until now.
                  </div>
                </div>
              )}
              {/* THE TYPED TOTAL — photo first, then the figure, then Submit. */}
              {isOwner && camera && typed && typed.tid === t.tid && (
                <div style={T.sheet} data-testid="typed-total">
                  <div style={T.step}>1 · Photo of the slip</div>
                  {typed.photo ? (
                    <div style={T.attached}>
                      <span>✓ Photo attached</span>
                      <label style={T.replace}>
                        <input type="file" accept="image/*" style={T.input} disabled={busy}
                               onChange={onTypedPhoto(t.tid)} />
                        Replace
                      </label>
                    </div>
                  ) : attaching ? (
                    <div style={T.attached}>Attaching…</div>
                  ) : (
                    <div style={T.pair}>
                      <label style={T.option}>
                        <input type="file" accept="image/*" capture="environment" style={T.input}
                               onChange={onTypedPhoto(t.tid)} />
                        Take photo
                      </label>
                      <label style={T.option}>
                        <input type="file" accept="image/*" style={T.input} onChange={onTypedPhoto(t.tid)} />
                        Choose file
                      </label>
                    </div>
                  )}
                  <div style={T.step}>2 · Total</div>
                  <input style={T.typeInput} inputMode="decimal" autoComplete="off" enterKeyHint="done"
                         aria-label={`Total for ${t.label || t.tid}, typed by hand`}
                         placeholder="e.g. 12,345.67" value={typed.text} disabled={busy}
                         onChange={(e) => { const v = e.target.value; setTyped((prev) => (prev ? { ...prev, text: v } : prev)); }} />
                  <button type="button" style={{ ...T.submit, ...(typed.photo && typed.text.trim() && !busy ? null : T.submitOff) }}
                          disabled={!typed.photo || !typed.text.trim() || busy || attaching}
                          onClick={submitTyped}>
                    {busy ? "Sending…" : "Submit"}
                  </button>
                  {!busy && !attaching && (!typed.photo || !typed.text.trim()) && (
                    <div style={T.waiting} role="status">
                      {!typed.photo && !typed.text.trim() ? "Add the slip photo and type the total to submit."
                        : !typed.photo ? "Add the slip photo (step 1) to submit."
                        : "Type the total (step 2) to submit."}
                    </div>
                  )}
                  <button type="button" style={T.sheetCancel} disabled={busy} onClick={() => setTyped(null)}>Cancel</button>
                  <div style={T.typeNote}>
                    Recorded as typed by you. The report marks this batch as declared by hand.
                  </div>
                </div>
              )}
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

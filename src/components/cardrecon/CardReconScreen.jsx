// ─── CARD RECON — four tills, one tick each ──────────────────────────────────
// A manager settles a card machine, tears off the Batch Report, and this screen
// answers one question: is today's report in? One card per terminal, a tick
// when it is, nothing loud when it is not. Ten seconds, at arm's length.
//
// THREE OF THE FOUR TERMINALS EMAIL THEIR REPORT and tick on their own — the
// poller on the Mac mini captures the PDF with nobody involved. PE Till 1
// (0000HP1X) cannot email, so its slip is photographed here. Every card is
// tappable all the same: a terminal whose email fails is still capturable by
// hand, which is what this path has always been for.
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
// NOBODY TYPES A FIGURE, and there is no editable field to type one into. A bad
// read is a retake.
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
import { database, functions } from "../../firebase";
import { decodeImageFile, isAcceptedImageFile, describePickedFile } from "../shopify/imageDecode";
import { planPhotoIntake, payloadRefusal } from "./photoIntake";
import { serverNowMs, saDateStringAt } from "../../utils/serverTime";
import { emailedArrivals, handCaptures, rememberHandCapture } from "./todaysArrivals";
import { FONT } from "./cardReconStyles";

const cardBatchCaptureFn = httpsCallable(functions, "cardBatchCapture", { timeout: 300000 });

// Slip photos need legible 8pt thermal print, so the downscale budget is wider
// than the label reader's 1024px. ~2000px keeps a full receipt column sharp and
// a JPEG comfortably under the callable's per-photo ceiling.
const MAX_PHOTO_DIM = 2000;

// A bounded tail, never the whole node: /card_batch_intake grows by a row per
// message for ever, and this runs on a handset on shop wifi. Four terminals
// report once a day, so 25 rows covers several days of arrivals.
const INTAKE_FEED_SIZE = 25;

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

const dayLabel = (ms) => new Date(ms).toLocaleDateString("en-ZA", {
  timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long" });

export default function CardReconScreen({ onExit }) {
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

  const terminalList = useMemo(
    () => Object.entries(terminals || {}).map(([tid, t]) => ({ tid, ...t }))
      .sort((a, b) => String(a.label || a.tid).localeCompare(String(b.label || b.tid))),
    [terminals],
  );

  const arrived = useMemo(() => {
    const byEmail = emailedArrivals(intake, today, saDateStringAt);
    for (const tid of mine) byEmail.add(tid);
    return byEmail;
  }, [intake, today, mine]);

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
  const send = async (tid, base64, correction) => {
    setPhase(tid, { phase: "busy" });
    try {
      const { data } = await cardBatchCaptureFn({
        action: "extract", pickedTid: tid, photos: [{ base64 }],
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
    } catch (err) {
      // A transport failure is not a sentence a manager can act on, so it is
      // translated. The detail goes to the console, where it can be read by
      // whoever is asked to look.
      console.error("cardBatchCapture failed", err);
      setPhase(tid, { phase: "failed", reason: "That did not go through. Check the signal and try again." });
    }
  };

  const onPick = (tid) => async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;

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
      setPhase(tid, { phase: "failed", reason: `That photo could not be opened (${err?.message || err}).` });
      return;
    }
    // Refused HERE rather than as a transport error nobody can read.
    const tooBig = payloadRefusal([photo]);
    if (tooBig) { setPhase(tid, { phase: "failed", reason: tooBig }); return; }
    lastPhoto.current[tid] = photo.base64;
    await send(tid, photo.base64, false);
  };

  return (
    <div style={T.page}>
      <button onClick={onExit} style={T.back}>← Home</button>
      <h1 style={T.h1}>Card machines</h1>
      <div style={T.day}>{dayLabel(nowMs)}</div>

      <div style={T.list}>
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
          return (
            <React.Fragment key={t.tid}>
              <label
                style={{ ...T.card, ...(done ? T.cardDone : null), ...(busy ? T.cardBusy : null) }}>
                <input type="file" accept="image/*" style={T.input}
                       disabled={busy} onChange={onPick(t.tid)} />
                <span style={T.name}>{t.label || `${t.storeId} · ${t.tillId}`}</span>
                {busy ? <span style={T.working}>Reading…</span>
                  : done ? <span style={T.tick} aria-label="today's report is in">✓</span>
                  /* Quiet on purpose: a till with nothing in raises no alarm,
                     only the hint that a photo is what it takes. Drawn rather
                     than typed — an emoji renders as a grey smudge at this
                     opacity, and differently on every handset. */
                  : <CameraGlyph />}
              </label>
              {state.phase === "failed" && <div style={T.fail}>{state.reason}</div>}
              {state.phase === "failed" && state.canReplace && lastPhoto.current[t.tid] && (
                <button style={T.again}
                        onClick={() => send(t.tid, lastPhoto.current[t.tid], true)}>
                  Replace the earlier capture
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>

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

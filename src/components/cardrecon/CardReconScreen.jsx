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
import { STAGE, describeCallableFailure, rememberFailure, readFailures, failureLine } from "./captureFailure";
import { captureCards } from "./terminalRegistry";
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
  // The breadcrumb. Deliberately plain and small: it is evidence to read out or
  // photograph, not part of the ten-second job the rest of this screen is.
  crumbBtn: { appearance: "none", border: 0, background: "transparent", color: "rgba(233,238,255,.42)",
              fontFamily: FONT, fontSize: 13, fontWeight: 600, padding: "10px 4px", marginTop: 14,
              cursor: "pointer", minHeight: 44, display: "block", textAlign: "left", width: "100%" },
  crumbBox: { marginTop: 4, padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,.04)",
              border: "1px solid rgba(255,255,255,.09)" },
  crumb: { fontSize: 11.5, lineHeight: 1.45, color: "rgba(233,238,255,.62)",
           fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
           wordBreak: "break-word", margin: "0 0 8px" },
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
  // The last few failures, on this device. Read once on mount and kept in state
  // so a fresh one appears without a reload — see captureFailure.js for why
  // this is on the handset rather than in the database.
  const [failures, setFailures] = useState(() => readFailures());
  const [showFailures, setShowFailures] = useState(false);
  // The photo of the last attempt, kept only so "replace the earlier capture"
  // does not ask for it to be taken again.
  const lastPhoto = useRef({});

  // A RETIRED MACHINE HAS NO CARD. Which ones those are, and the order the rest
  // are drawn in, is the registry module's decision — see terminalRegistry.js.
  const terminalList = useMemo(() => captureCards(terminals), [terminals]);

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
  const fail = (tid, { stage, reason, kind, detail }) => {
    // ONE PLACE RECORDS, so a path added later cannot forget to. The breadcrumb
    // is what the owner reads on the phone; the sentence is what the manager
    // acts on. See captureFailure.js.
    rememberFailure({ at: serverNowMs(), tid, stage, kind, detail: detail || reason });
    setFailures(readFailures());
    return { phase: "failed", reason };
  };

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
        setPhase(tid, {
          ...fail(tid, { stage: STAGE.EXTRACT, kind: "refused", reason: reasonOf(data) }),
          // The one refusal with a way out. Matched on the server's own words —
          // widened to either half of the sentence it writes, so a re-word of
          // one clause does not silently strand a manager with a bad capture.
          canReplace: /already captured|resubmit as a correction/i.test(data.reason || ""),
        });
        return;
      }
      // `{ data }`, not the envelope: a callable resolves to { data }, and
      // reading .ok off the envelope makes every submit look refused — with an
      // undefined reason, which renders as an empty red box saying nothing.
      const { data: done } = await cardBatchCaptureFn({ action: "submit", draftId: data.draftId });
      if (!done.ok) {
        setPhase(tid, fail(tid, { stage: STAGE.SUBMIT, kind: "refused", reason: reasonOf(done) }));
        return;
      }
      rememberHandCapture(tid, today);
      setMine((prev) => new Set(prev).add(tid));
      setPhase(tid, null);
      delete lastPhoto.current[tid];
    } catch (err) {
      // EVERY REJECTION USED TO READ "check the signal", including the server's
      // own carefully-written refusals — which is how an exhausted AI account
      // was investigated for two days as a phone problem. The failure now names
      // itself (captureFailure.js), and the raw words are kept on the device
      // where the owner can read them without a laptop.
      console.error("cardBatchCapture failed", err);
      const { kind, reason } = describeCallableFailure(err);
      setPhase(tid, fail(tid, {
        stage: STAGE.EXTRACT, kind,
        reason,
        detail: `${err?.code || "no-code"} ${err?.message || ""}`.trim(),
      }));
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
    if (refusal) {
      setPhase(tid, fail(tid, { stage: STAGE.PICK, kind: "unusable-file", reason: refusal }));
      return;
    }

    setPhase(tid, { phase: "busy" });
    let photo;
    try {
      photo = await downscalePhoto(take[0]);
    } catch (err) {
      // decodeImageFile throws a sentence a person can read — an unopenable
      // HEIC, a decoder that would not load, a browser that cannot do it. It is
      // shown as written rather than wrapped in a second guess.
      setPhase(tid, fail(tid, {
        stage: STAGE.DECODE, kind: "decode",
        reason: `That photo could not be opened (${err?.message || err}).`,
        detail: String(err?.message || err),
      }));
      return;
    }
    // Refused HERE rather than as a transport error nobody can read.
    const tooBig = payloadRefusal([photo]);
    if (tooBig) {
      setPhase(tid, fail(tid, { stage: STAGE.PAYLOAD, kind: "too-big", reason: tooBig }));
      return;
    }
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
          one: without the mailbox we cannot say whether the terminals that email
          have reported, and a missing tick would read as "it never arrived". */}
      {intake === null && (
        <div style={T.quiet}>
          What has arrived by email cannot be read right now, so those ticks may be missing.
        </div>
      )}

      {/* ── THE BREADCRUMB ──────────────────────────────────────────────────
          Hidden until something has failed, and then one tap away. It exists
          because "That did not go through" was, for two days, the ONLY thing
          anybody could see about a capture that was in fact reaching the
          server and being refused by an AI account with no credit left. The
          reason now reaches the till; this is the evidence that goes with it,
          readable without a laptop. */}
      {failures.length > 0 && (
        <>
          <button style={T.crumbBtn} onClick={() => setShowFailures((v) => !v)}>
            {showFailures ? "▾" : "▸"} What went wrong ({failures.length})
          </button>
          {showFailures && (
            <div style={T.crumbBox}>
              {failures.map((row, i) => (
                <p key={i} style={T.crumb}>
                  {failureLine(row, row.at ? new Date(row.at).toLocaleString("en-ZA", {
                    timeZone: "Africa/Johannesburg", day: "numeric", month: "short",
                    hour: "2-digit", minute: "2-digit",
                  }) : "unknown time")}
                </p>
              ))}
              <div style={{ ...T.crumb, margin: 0, opacity: .75 }}>
                Read this to Junid as it stands.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

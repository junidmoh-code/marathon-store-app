// ─── PRINTED BARCODE CAPTURE — perfume keeps the code it already has ─────────
// Every perfume arrives with a real EAN-13 already printed on its box, and
// those codes are consistent across the stock. Minting a shop code for one is
// wasted work: a number to reserve, a label to print, a label to stick, and a
// second identity to reconcile forever after. So for perfume the barcode step
// asks the operator to photograph the code that is already there.
//
// ── THE LADDER, HARDEST-EVIDENCE FIRST ───────────────────────────────────────
//   1. DECODE the bar pattern (utils/barcodeDecode.js — client-side ZXing via
//      the html5-qrcode already in the bundle). Deterministic: a decode either
//      satisfies the symbology's check digit or it does not.
//   2. If no frame decodes, OCR the digits printed under the symbol, through
//      the SAME readStyleCodeLabel callable the tongue label uses — cached on
//      the image hash, so a retake re-bills nothing.
//   3. Manual typing, always available, never gated on the other two failing.
//
// Every rung ends at the same gate: normalisePrintedBarcode(). A code that
// fails its check digit is REFUSED whatever produced it, including a human
// typing it, and is never written.
//
// ── AND WHY IT IS NEVER A DEAD END ───────────────────────────────────────────
// A scuffed, wrapped or reprinted box happens. One deliberate tap falls back to
// the ordinary auto-generated shop barcode, so an operator is never stranded
// holding stock they cannot enter. It is a tap, not a timeout — the fallback
// has to be a decision somebody made.

import React, { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { LabelCamera } from "../stock/TongueLabelReader";
import { prepareLabelPhoto } from "../../utils/labelPhoto";
import { decodeFrames, readPrintedDigits } from "../../utils/barcodeDecode";
import {
  normalisePrintedBarcode,
  PRINTED_ALREADY, PRINTED_CONFLICT, PRINTED_SIZE_MISMATCH, PRINTED_INVALID,
} from "../../utils/eanBarcode";
import { inspectPrintedBarcode } from "../stock/printedBarcodeStore";
import { FONT, bBlue, bGray, bGhost, input, GREEN, RED } from "../stock/ui";

const readStyleCodeLabelFn = httpsCallable(functions, "readStyleCodeLabel");

// Group the digits the way the box prints them, for the CONFIRMATION display
// only. This is presentation and never touches the stored value — the code is
// stored and indexed as bare digits, always.
export function groupForDisplay(code) {
  const s = String(code || "");
  if (s.length === 13) return `${s.slice(0, 1)} ${s.slice(1, 7)} ${s.slice(7, 13)}`;
  if (s.length === 12) return `${s.slice(0, 1)} ${s.slice(1, 6)} ${s.slice(6, 11)} ${s.slice(11)}`;
  if (s.length === 8) return `${s.slice(0, 4)} ${s.slice(4)}`;
  return s;
}

function Note({ tone = "amber", children }) {
  const tones = {
    amber: { bg: "rgba(251,191,36,.07)", border: "rgba(251,191,36,.25)", color: "#FDE9B0" },
    red: { bg: "rgba(248,113,113,.09)", border: "rgba(248,113,113,.4)", color: "#FFC9C9" },
    green: { bg: "rgba(74,222,128,.08)", border: "rgba(74,222,128,.3)", color: "#B7F0CC" },
  }[tone];
  return (
    <div style={{ marginTop: 10, background: tones.bg, border: `1px solid ${tones.border}`,
                  borderRadius: 11, padding: "10px 12px", fontSize: 12.5, color: tones.color, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

/**
 * @param {string|null} productId   the product being captured for; null while
 *                                  creating one that does not exist yet.
 * @param {Array}       products    catalogue, to NAME a conflicting product.
 * @param {string|null} value       the accepted code, held by the parent.
 * @param {function}    onCapture   (code) => void — an accepted, checked code.
 * @param {function}    onClear     drop the captured code (retake).
 * @param {function}    onUseAuto   optional: the deliberate auto-generate tap.
 * @param {boolean}     usingAuto   true once that tap has been made.
 */
export default function PrintedBarcodeCapture({
  productId = null, products = [], value = null,
  onCapture, onClear, onUseAuto = null, usingAuto = false, busy = false,
}) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [working, setWorking] = useState(null);   // null | "decoding" | "digits" | "checking"
  const [note, setNote] = useState(null);         // { tone, text }
  const [conflict, setConflict] = useState(null); // { code, otherProductId }
  const [typed, setTyped] = useState("");
  const fileRef = useRef(null);

  // ── A CAPTURE BELONGS TO THE MOMENT IT WAS STARTED ────────────────────────
  // Decoding a burst and reading the index both take real time, during which
  // the operator can change category, close the flow or navigate to another
  // product. A result arriving after that must NOT call onCapture: it would
  // write a perfume's EAN onto whatever the form has become — and for a sized
  // product that means a one-size code on a product whose real sizes are "9"
  // and "10". Each run takes a token; only the current token may report.
  // (Codex review, PR #340.)
  const runRef = useRef(0);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; runRef.current++; };
  }, []);
  // Switching to a different product invalidates anything still in flight and
  // clears the surface, so a verdict about product A can never be shown — or
  // captured — against product B.
  useEffect(() => {
    runRef.current++;
    setNote(null);
    setConflict(null);
    setWorking(null);
    setTyped("");
  }, [productId]);
  const beginRun = () => ++runRef.current;
  const isCurrent = (token) => liveRef.current && runRef.current === token;

  const nameOf = (id) => {
    const p = (products || []).find((x) => x && x.id === id);
    return p && p.name ? p.name : id;
  };

  // ── THE INDEX CHECK — before anything is written, and before the operator
  //    moves on. /barcodes/$code is CREATE-ONLY at the rules layer, so a code
  //    already in the index cannot be overwritten; attempting it fails
  //    SILENTLY. Read it, and let what is there decide.
  // `noteOnSuccess` survives the accept. Setting a note BEFORE calling accept
  // did not work: the free-slot path clears the note, so the warning that a
  // reading came from OCR'd digits rather than the decoded bars — the one that
  // tells the operator to check it against the box — was wiped before it could
  // be read. Found by writing the ladder tests. (CodeRabbit, PR #340.)
  const accept = async (code, token = beginRun(), noteOnSuccess = null) => {
    setWorking("checking");
    try {
      const verdict = await inspectPrintedBarcode(code, productId);
      // Superseded or unmounted while the index was being read — drop it
      // silently. Reporting a stale verdict is worse than reporting nothing.
      if (!isCurrent(token)) return;
      if (verdict.kind === PRINTED_CONFLICT) {
        // The same printed code on two records means one physical product
        // exists twice in the catalogue. That is a duplicate, and it is
        // resolved where duplicates are resolved — not by writing more rows.
        setConflict({ code, otherProductId: verdict.otherProductId });
        setNote(null);
        return;
      }
      setConflict(null);
      if (verdict.kind === PRINTED_SIZE_MISMATCH) {
        // Ours, but the index points it at a different size. "Already
        // registered" would be a lie: the code resolves, to the wrong stock
        // cell. It cannot be corrected from here (create-only), so it is
        // surfaced rather than swallowed. (Codex review, PR #340.)
        setNote({ tone: "red", text:
          `${code} is already in the barcode index for this product but points at size ` +
          `“${verdict.indexedSize}”, not one-size. Scanning it would touch the wrong stock. ` +
          `An admin must reconcile that entry before this code can be used.` });
        return;
      }
      if (verdict.kind === PRINTED_INVALID) {
        setNote({ tone: "red", text: `“${code}” is not a valid printed barcode.` });
        return;
      }
      if (verdict.kind === PRINTED_ALREADY) {
        setNote({ tone: "green", text: `${code} is already registered to this product — nothing to do.` });
      } else {
        setNote(noteOnSuccess);
      }
      onCapture(code);
    } catch (err) {
      // A failed READ must not be reported as a free slot: accepting here
      // would send a code to a create-only write that may be denied silently.
      if (!isCurrent(token)) return;
      setNote({ tone: "red", text: `Could not check ${code} against the barcode index (${err?.message || err}). Try again in a moment.` });
    } finally {
      if (isCurrent(token)) setWorking(null);
    }
  };

  const processFrames = async (frames) => {
    const token = beginRun();
    setNote(null);
    setConflict(null);
    setWorking("decoding");
    try {
      const decoded = await decodeFrames(frames);
      if (!isCurrent(token)) return;
      if (decoded.ok) { await accept(decoded.code, token); return; }

      // No frame's SYMBOL read. Fall back to the printed digits — one vision
      // call, image-hash cached, and its answer faces the same check digit.
      setWorking("digits");
      const digits = await readPrintedDigits(frames, readStyleCodeLabelFn);
      if (!isCurrent(token)) return;
      if (digits.ok) {
        await accept(digits.code, token, {
          tone: "amber",
          text: "The bars would not read, so this came from the printed number under them — check it against the box before continuing.",
        });
        return;
      }
      setNote({ tone: "amber", text: `${decoded.message} ${digits.message}` });
    } catch (err) {
      if (!isCurrent(token)) return;
      setNote({ tone: "red", text: `Could not read that barcode (${err?.message || err}) — type it from the box instead.` });
    } finally {
      if (isCurrent(token)) setWorking((w) => (w === "checking" ? w : null));
    }
  };

  // Single-photo fallback for when the live stream is unavailable — the same
  // downscale budget as the burst (utils/labelPhoto.js).
  const handlePhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    // Downscaling is an await too, so this path takes a token like every other
    // one. It only covers the PREPARATION step — processFrames begins its own
    // run — but without it a stale error note could land on a surface the
    // operator has already moved on from. (CodeRabbit, PR #340.)
    const token = beginRun();
    setWorking("decoding");
    try {
      const photo = await prepareLabelPhoto(file);
      if (!isCurrent(token)) return;
      await processFrames([photo]);
    } catch (err) {
      if (!isCurrent(token)) return;
      setNote({ tone: "red", text: `Could not read that photo (${err?.message || err}) — type the number instead.` });
      setWorking(null);
    }
  };

  const applyTyped = async () => {
    if (working || busy) return;
    const result = normalisePrintedBarcode(typed);
    if (!result.ok) { setNote({ tone: "red", text: result.message }); return; }
    setTyped("");
    setNote(null);
    await accept(result.code);
  };

  const label = { fontSize: 11, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase",
                  color: "rgba(233,238,255,.5)", marginBottom: 8 };

  // ── ACCEPTED — shown LARGE, because this number is about to become the
  //    product's identity and the operator's last chance to compare it with
  //    the box is right here.
  if (value && !conflict) {
    return (
      <div>
        <div style={label}>Printed barcode</div>
        <div style={{ background: "rgba(74,222,128,.07)", border: "1px solid rgba(74,222,128,.35)",
                      borderRadius: 14, padding: "16px 14px", textAlign: "center" }}>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 26,
                        fontWeight: 800, color: GREEN, letterSpacing: ".06em", fontVariantNumeric: "tabular-nums",
                        wordBreak: "break-all" }}>
            {groupForDisplay(value)}
          </div>
          <div style={{ marginTop: 7, fontSize: 12, color: "rgba(233,238,255,.5)" }}>
            Check this against the box before you continue.
          </div>
        </div>
        {note && <Note tone={note.tone}>{note.text}</Note>}
        <button type="button" disabled={busy} onClick={() => { setNote(null); onClear(); }}
          style={{ ...bGhost, width: "100%", minHeight: 46, marginTop: 10 }}>
          Not this one — photograph it again
        </button>
      </div>
    );
  }

  // ── DUPLICATE — the code is on a DIFFERENT product. Refuse and route. ──────
  if (conflict) {
    return (
      <div>
        <div style={label}>Printed barcode</div>
        <div style={{ background: "rgba(248,113,113,.09)", border: "1px solid rgba(248,113,113,.45)",
                      borderRadius: 14, padding: "14px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 800, color: RED, marginBottom: 6 }}>
            That barcode is already on another product
          </div>
          <div style={{ fontSize: 12.5, color: "#FFC9C9", lineHeight: 1.55 }}>
            <b style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{conflict.code}</b> points at{" "}
            <b>{nameOf(conflict.otherProductId)}</b>. One printed code belongs to one product, so this is the
            same product already in the catalogue — or the wrong box was photographed.
            {productId
              ? " Check the box, or merge the two records from Stock → Merge Products."
              : " Do not create a second record. Check the box; if it really is this product already, add stock to the existing one instead, or merge the records from Stock → Merge Products."}
          </div>
        </div>
        <button type="button" disabled={busy} onClick={() => { setConflict(null); setNote(null); }}
          style={{ ...bGhost, width: "100%", minHeight: 46, marginTop: 10 }}>
          Photograph a different barcode
        </button>
      </div>
    );
  }

  const busyText = working === "decoding" ? "Reading the barcode…"
    : working === "digits" ? "Reading the printed number…"
    : working === "checking" ? "Checking the barcode index…" : null;

  return (
    <div>
      <div style={label}>Printed barcode</div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={handlePhoto} style={{ display: "none" }} />
      <button type="button" disabled={busy || !!working} onClick={() => setCameraOpen(true)}
        style={{ ...bBlue, width: "100%", minHeight: 64, fontSize: 16, fontFamily: FONT,
                 opacity: busy || working ? 0.5 : 1, cursor: busy || working ? "not-allowed" : "pointer" }}>
        {busyText || "📷 Photograph the barcode"}
      </button>
      <div style={{ marginTop: 7, fontSize: 11.5, color: "rgba(233,238,255,.42)", lineHeight: 1.45 }}>
        The barcode already printed on the box — not a label you stick on.
      </div>

      {cameraOpen && (
        <LabelCamera
          title="The barcode on the box"
          hint="Fill the frame with the barcode itself, straight on. One press takes three quick frames."
          shootLabel="◉ Capture the barcode"
          onFrames={(frames) => { setCameraOpen(false); processFrames(frames); }}
          onFallback={() => { setCameraOpen(false); fileRef.current && fileRef.current.click(); }}
          onClose={() => setCameraOpen(false)} />
      )}

      {note && <Note tone={note.tone}>{note.text}</Note>}

      <form onSubmit={(e) => { e.preventDefault(); applyTyped(); }}
            style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)}
               aria-label="Printed barcode number from the box"
               inputMode="numeric" placeholder="…or type the number, e.g. 6291106065114"
               style={{ ...input, flex: 1, minHeight: 48, fontSize: 15, fontVariantNumeric: "tabular-nums" }} />
        <button type="submit" disabled={!typed.trim() || !!working || busy}
                style={{ ...bGray, minHeight: 48, padding: "0 16px" }}>Set</button>
      </form>

      {/* THE DELIBERATE FALLBACK — one tap, and it says what it costs. */}
      {onUseAuto && (
        <button type="button" disabled={busy || !!working} onClick={onUseAuto}
          style={{ ...bGhost, width: "100%", minHeight: 46, marginTop: 10, fontSize: 12.5,
                   color: usingAuto ? GREEN : "rgba(233,238,255,.6)" }}>
          {usingAuto
            ? "✓ Using a shop-generated barcode — tap to undo"
            : "Barcode unreadable — generate a shop barcode instead"}
        </button>
      )}
      {usingAuto && (
        <Note tone="amber">
          A shop barcode will be generated on save, and you will need to print and stick a label on the box.
        </Note>
      )}
    </div>
  );
}

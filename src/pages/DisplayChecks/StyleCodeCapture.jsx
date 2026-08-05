// ─── DISPLAY CHECKS — OPTIONAL STYLE-CODE CAPTURE ────────────────────────────
// Bolted onto the flow staff ALREADY use to confirm a display, because that is
// the moment they are physically holding the shoe. Asking them to make a special
// trip to a separate screen to type a code would mean it never gets typed; here
// it costs one extra tap for the people who want to help the backfill along.
//
// ── OPTIONAL MEANS OPTIONAL ──────────────────────────────────────────────────
// It is collapsed by default and it NEVER blocks the display check. A staff
// member who ignores it entirely completes their check exactly as before, with
// no extra taps and nothing to dismiss. The two actions are also independent:
// the capture is enqueued on its own, so a failed capture cannot cost someone
// their display confirmation, and a failed confirmation cannot lose their code.
//
// ── WHAT IT PROMISES THE PERSON USING IT ─────────────────────────────────────
// The panel says, in words, that nothing about the product changes. That is not
// reassurance for its own sake — a staff member who believes this button might
// rename a product will not press it, and one who presses it expecting a rename
// will report a bug when nothing visibly happens.

import { useRef, useState } from "react";
import { auth } from "../../firebase";
import { FONT, MONO, BLUE, AMBER, INK, META } from "./tokens";
import {
  normaliseStyleCode,
  formatStyleCodeForDisplay,
  isKnownStyleCodeFormat,
} from "../../utils/styleCode";
import { prepareLabelPhoto } from "../../utils/labelPhoto";
import { enqueueStyleCodeCapture } from "../../utils/styleCodeCapture";
import { serverNowMs } from "../../utils/serverTime";

const GREEN = "#4ADE80";

export default function StyleCodeCapture({ productId, productName, existingCode, progress }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const normalised = normaliseStyleCode(typed);
  const canSave = !!normalised && !busy && !done;

  // Already stamped — show it and offer nothing. There is nothing to capture,
  // and a second capture would only be rejected by the immutability rule.
  if (existingCode) {
    return (
      <div style={{ ...META, fontSize: 10.5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: GREEN }}>✓ STYLE CODE</span>
        <span style={{ fontFamily: MONO, color: "rgba(233,238,255,.75)" }}>
          {formatStyleCodeForDisplay(existingCode)}
        </span>
        {progress && <ProgressLine progress={progress} />}
      </div>
    );
  }

  async function takePhoto(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      // Downscaled to 1024px in the browser before it goes anywhere.
      setPhoto(await prepareLabelPhoto(file));
    } catch (err) {
      setError((err && err.message) || "Couldn't read that photo.");
    }
  }

  async function save() {
    setBusy(true); setError(null);
    // enqueueStyleCodeCapture returns an error RESULT only for the final set().
    // push(), getDownloadURL() and serverNowMs() run outside that try, so the
    // promise itself can still reject. Without this catch, setBusy(false) never
    // ran: the button sat disabled on "Saving…" with no error and no way to
    // retry, which is the same "a failure the operator cannot see or act on"
    // problem as the claim messages. `finally` is what actually guarantees the
    // button comes back. (CodeRabbit, PR #312.)
    try {
      const res = await enqueueStyleCodeCapture({
        code: typed,
        productId,
        uid: auth.currentUser && auth.currentUser.uid,
        origin: "displayCheck",
        labelPhoto: photo,
        nowMs: serverNowMs(),
      });
      if (res.ok) { setDone(true); return; }
      setError(res.error);
    } catch (err) {
      setError((err && err.message) || "Couldn't save that style code. Nothing was changed on the product.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button type="button" onClick={() => setOpen(true)}
          style={{ ...META, fontSize: 11, background: "none", border: "1px dashed rgba(120,150,255,.28)",
                   borderRadius: 10, color: "rgba(233,238,255,.55)", cursor: "pointer",
                   padding: "10px 12px", minHeight: 40, letterSpacing: "0.08em" }}>
          + ADD STYLE CODE <span style={{ opacity: 0.6 }}>(OPTIONAL)</span>
        </button>
        {progress && <ProgressLine progress={progress} />}
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ border: `1px solid ${GREEN}55`, background: "rgba(74,222,128,.08)",
                    borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ ...META, fontSize: 11, color: GREEN, letterSpacing: "0.1em" }}>✓ STYLE CODE SAVED</div>
        <div style={{ fontFamily: FONT, fontSize: 13, color: INK, lineHeight: 1.5 }}>
          <span style={{ fontFamily: MONO }}>{formatStyleCodeForDisplay(normalised)}</span> is queued against{" "}
          {productName || "this product"}. Its name, photo and category are unchanged — anything the
          catalogue suggests waits for an admin to approve it.
        </div>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid rgba(120,150,255,.2)", background: "rgba(255,255,255,.03)",
                  borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...META, fontSize: 10.5, letterSpacing: "0.1em", color: "rgba(233,238,255,.55)" }}>
        STYLE CODE — INSIDE TONGUE LABEL
      </div>

      <input
        placeholder="CT8527-016"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off" autoCorrect="off" spellCheck={false}
        style={{ background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 10,
                 padding: "13px 14px", color: "#fff", fontSize: 17, fontWeight: 700, outline: "none",
                 width: "100%", boxSizing: "border-box", minHeight: 50, fontFamily: MONO,
                 letterSpacing: ".06em", textTransform: "uppercase" }}
      />
      {!!normalised && !isKnownStyleCodeFormat(normalised) && (
        <div style={{ ...META, fontSize: 10.5, color: AMBER }}>
          UNUSUAL FORMAT — SAVED ANYWAY, AN ADMIN WILL CHECK IT
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" capture="environment"
             onChange={takePhoto} style={{ display: "none" }} />
      <button type="button" onClick={() => fileRef.current && fileRef.current.click()}
        style={{ ...META, fontSize: 11, background: "none", border: "1px dashed rgba(120,150,255,.28)",
                 borderRadius: 10, color: "rgba(233,238,255,.55)", cursor: "pointer",
                 padding: "12px", minHeight: 44, letterSpacing: "0.08em" }}>
        {photo ? "📷 LABEL PHOTO ADDED — RETAKE" : "📷 PHOTO OF THE LABEL (OPTIONAL)"}
      </button>
      {photo && (
        <img src={photo.dataUrl} alt="label"
             style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8,
                      border: "1px solid rgba(120,150,255,.25)" }} />
      )}

      {/* The promise, stated plainly. A staff member who thinks this might
          rename a product will not press it. */}
      <div style={{ ...META, fontSize: 10.5, color: "rgba(233,238,255,.42)", lineHeight: 1.6 }}>
        THIS ONLY ADDS THE CODE. THE PRODUCT'S NAME, PHOTO AND CATEGORY ARE NOT CHANGED.
      </div>

      {error && <div style={{ ...META, fontSize: 10.5, color: AMBER }}>{String(error).toUpperCase()}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={!canSave} onClick={save}
          style={{ fontFamily: FONT, fontSize: 14, fontWeight: 750, flex: 1, padding: "12px",
                   borderRadius: 10, minHeight: 46, border: "none",
                   background: canSave ? BLUE : "rgba(74,127,255,.12)",
                   color: canSave ? "#04102e" : "rgba(233,238,255,.35)",
                   cursor: canSave ? "pointer" : "default" }}>
          {busy ? "Saving…" : "Save style code"}
        </button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null); }}
          style={{ ...META, fontSize: 11, background: "none", border: "none",
                   color: "rgba(233,238,255,.4)", cursor: "pointer", padding: "0 12px" }}>
          CANCEL
        </button>
      </div>
    </div>
  );
}

// "How far through are we" — visible where the work actually happens, so the
// backfill has a finish line rather than being an open-ended chore.
function ProgressLine({ progress }) {
  if (!progress || !progress.total) return null;
  return (
    <span style={{ ...META, fontSize: 10, color: "rgba(233,238,255,.4)", letterSpacing: "0.08em" }}>
      · {progress.confirmed}/{progress.total} SNEAKERS CODED ({progress.pct}%)
      {progress.needsReview > 0 && ` · ${progress.needsReview} AWAITING REVIEW`}
    </span>
  );
}

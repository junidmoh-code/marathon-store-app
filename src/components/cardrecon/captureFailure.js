// ─── WHY A CAPTURE FAILED, IN A SENTENCE THAT NAMES THE FAILURE ──────────────
// Pure: no React, no Firebase, no canvas. The screen owns the state and does
// the IO; this owns the wording, so the wording can be tested without mounting
// a module that imports Firebase at load time (the house convention — see
// photoIntake.js, which is split from the screen for the same reason).
//
// ── WHAT THIS EXISTS TO STOP ─────────────────────────────────────────────────
// On 19 Sept 2026 every photo capture in the estate failed, all day, on every
// till, and every manager who tried was told the same thing:
//
//     "That did not go through. Check the signal and try again."
//
// The signal was fine. Gemini had answered HTTP 402 — "Your prepayment credits
// are depleted" — to every OCR call since the small hours. Three layers each
// threw the reason away:
//
//   1. runSlipOcr threw `Error("gemini HTTP 402")`
//   2. the callable caught it, logged it, and threw HttpsError("unavailable",
//      "Could not read the photos right now — try again.")
//   3. the screen caught THAT and wrote the sentence above.
//
// Only step 1's log said anything true, and it was in Cloud Logging where no
// manager and no owner would ever look. A day of captures was lost to a
// sentence that named the one thing that was not wrong.
//
// So: EVERY failure on this path names itself, and a refusal that came from the
// SERVER is shown in the server's own words. The server writes its refusals for
// the person holding the slip — "Batch #58 for this terminal is already
// captured", "This slip prints TID 67365901, not the till you picked" — and
// collapsing those into a generic sentence is how a manager ends up retaking a
// photo that was never the problem.
//
// ── THE CATCH-ALL IS STILL HERE, AND IT IS NOW LOUD ──────────────────────────
// A genuinely unknown error still gets a generic sentence, because inventing a
// specific one would be worse. But it carries a short tag the owner can read
// back to us, and `logLine` puts the code, the name and the message into the
// console in one greppable line. An unknown failure must be identifiable after
// the fact; that is the whole difference between this and what it replaced.

/**
 * The failure classes. Each one produces its own sentence, and each one is a
 * different thing to DO about it — which is the test for whether a class earns
 * its place here.
 */
export const FAILURE = {
  FILE_REJECTED: "file-rejected",   // not a photo — pick another file
  DECODE: "decode",                 // this phone can't open that photo
  TOO_LARGE: "too-large",           // the payload won't fit — reshoot wider
  OFFLINE: "offline",               // the device knows it has no network
  TRANSPORT: "transport",           // the call never reached the server
  SERVER_REFUSED: "server-refused", // the server answered, and said no, and why
  SERVER_ERROR: "server-error",     // the server threw, with its own sentence
  UNKNOWN: "unknown",               // genuinely unidentified — log and tag it
};

// A callable rejection carries a `code` like "functions/unavailable". The bare
// status is what we key on.
const bareCode = (err) => String(err?.code || "").replace(/^functions\//, "");

// ── IS THIS MESSAGE THE SERVER'S OWN WORDS, OR THE TRANSPORT'S? ──────────────
// A Firebase callable uses the SAME error shape for "the server refused and
// said why" and "the request never arrived". Both can surface as
// `functions/unavailable` or `functions/internal`, so the code alone cannot
// separate them — and getting it wrong in the safe-looking direction is what
// produced the outage this file exists for.
//
// The discriminator is the message itself. Every refusal this server writes is
// a SENTENCE, written for a person: several words, and it ends in punctuation
// or is plainly prose. The transport's own messages are bare status tokens —
// "internal", "unavailable", "deadline-exceeded", "Response is missing data
// field" — echoes of the code, saying nothing a manager could act on.
//
// So a message that is prose is shown verbatim; a message that is a token is
// treated as transport and replaced with a sentence about the connection. When
// in doubt this errs toward SHOWING the server's words, because a real sentence
// shown at the wrong moment is still readable, while a swallowed one is the
// failure we are fixing.
const TRANSPORT_TOKENS = new Set([
  "internal", "unavailable", "deadline-exceeded", "cancelled", "aborted",
  "unknown", "data-loss", "resource-exhausted",
  "response is missing data field", "load failed", "failed to fetch",
  "network error", "networkerror when attempting to fetch resource.",
]);

export function looksLikeServerProse(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  if (TRANSPORT_TOKENS.has(text.toLowerCase())) return false;
  // A sentence has a space in it. A status token never does — and the few
  // multi-word transport strings are named above.
  return /\s/.test(text) && text.length >= 12;
}

/**
 * Classify a rejected callable, or any thrown error, from the capture path.
 *
 * @param {any} err  what was thrown
 * @returns {{kind:string, message:string, logLine:string}}
 *   `message` is what the manager reads. `logLine` is what goes to the console
 *   — always, for every class, so an unknown failure can be identified later.
 */
export function describeCallableError(err, { online = true } = {}) {
  const code = bareCode(err);
  const raw = String(err?.message || "");
  const logLine = `cardBatchCapture failed [code=${code || "none"}] [name=${err?.name || "none"}] ${raw || "(no message)"}`;

  // The device itself says there is no network. Nothing else can be true yet,
  // so this is checked before the error is read at all.
  if (!online) {
    return { kind: FAILURE.OFFLINE, logLine,
      message: "This phone is offline, so the slip was not sent. Reconnect and tap the till again — the photo is not lost." };
  }

  // ── THE SERVER ANSWERED, AND SAID WHY ──────────────────────────────────────
  // Shown VERBATIM. These sentences are written for the person holding the
  // slip, and they are the whole point of this change.
  if (looksLikeServerProse(raw)) {
    // `unauthenticated` is the one status worth a word of its own, because the
    // server's sentence ("Sign in required.") does not say that the session
    // expired underneath someone who WAS signed in a moment ago.
    if (code === "unauthenticated") {
      return { kind: FAILURE.SERVER_REFUSED, logLine,
        message: `${raw} Your session has expired — sign in again and retake the slip.` };
    }
    return { kind: FAILURE.SERVER_REFUSED, logLine, message: raw };
  }

  // ── THE CALL NEVER LANDED ──────────────────────────────────────────────────
  // A bare status token, or no message at all. There is nothing of the
  // server's to show, so this says what it actually knows: the request did not
  // complete. Distinguished from OFFLINE because the device believes it HAS a
  // connection, which is the shop-wifi case — associated, no route.
  if (code === "deadline-exceeded" || /timeout|timed out|aborted/i.test(raw)) {
    return { kind: FAILURE.TRANSPORT, logLine,
      message: "The slip took too long to send and the connection gave up. Try again on a stronger signal." };
  }
  if (code || raw) {
    return { kind: FAILURE.TRANSPORT, logLine,
      message: "The slip could not reach the server. Check the connection and tap the till again." };
  }

  // ── GENUINELY UNIDENTIFIED ─────────────────────────────────────────────────
  // The catch-all survives, for this and nothing else. It carries a tag so the
  // owner can read it back and it can be found in the console log above.
  return { kind: FAILURE.UNKNOWN, logLine,
    message: "The slip was not recorded and the reason was not identifiable. Tell Junid, and say it happened on this till — the details are in the phone's log." };
}

/**
 * The sentence for a photo that could not be decoded.
 *
 * decodeImageFile already throws sentences written for a person — it is the
 * module that exists because "that file isn't a JPEG, PNG or WebP image" was
 * shown to people holding an iPhone's only available file. So its words are
 * used as they are, and only a decoder that threw something shapeless (a
 * DOMException, a bare string) gets a sentence of ours.
 */
export function describeDecodeError(err) {
  const raw = String(err?.message || err || "");
  const logLine = `cardRecon decode failed [name=${err?.name || "none"}] ${raw || "(no message)"}`;
  if (looksLikeServerProse(raw)) return { kind: FAILURE.DECODE, logLine, message: raw };
  return { kind: FAILURE.DECODE, logLine,
    message: "That photo could not be opened on this phone. Take it again, or pick it from the camera roll rather than from Files." };
}

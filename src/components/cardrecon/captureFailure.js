// ─── WHEN A CAPTURE FAILS, IT SAYS WHICH FAILURE IT WAS ──────────────────────
// On 18 Sep 2026 a manager could not capture a slip, and the screen said "That
// did not go through. Check the signal and try again." for two days. The signal
// was fine. The photo reached the server, the server called Gemini, and Gemini
// answered HTTP 429 — *your prepayment credits are depleted*. Three layers each
// threw away what the one below it knew:
//
//   runSlipOcr        threw `gemini HTTP 429` and DISCARDED the response body,
//                     so even the log never said why.
//   the callable      turned that into "Could not read the photos right now —
//                     try again", which is advice that cannot work: trying
//                     again spends nothing and fixes nothing.
//   this screen       caught the rejection and said "check the signal", which
//                     sent everyone looking at the phone, the network and the
//                     registry change — anywhere but the account balance.
//
// A capture can fail in six distinguishable ways before a batch is recorded,
// and a manager can act on a different thing in each. So each one gets its own
// sentence, and the catch-all is what is left when none of them fits — never
// the first answer.
//
// Pure: no React, no Firebase, no clock of its own (`at` is passed in, from the
// SERVER's clock like everything else on this screen). Tested in
// captureFailure.test.js.

/** Where in the capture a failure happened. On the breadcrumb, not on screen. */
export const STAGE = {
  PICK: "pick",         // the picker handed over something unusable
  DECODE: "decode",     // this device could not open the image
  PAYLOAD: "payload",   // too big to send
  EXTRACT: "extract",   // the callable's read step
  SUBMIT: "submit",     // the callable's record step
};

/**
 * A rejected callable → the sentence a manager reads.
 *
 * THE SERVER'S OWN WORDS WIN. Every refusal the callable throws was written for
 * the person holding the slip ("Photo 1 is too large — retake it"), and this
 * screen had been replacing all of them with one sentence about the signal. The
 * only errors that get a sentence from here are the ones carrying no usable
 * message of their own: a transport failure, and whatever is left over.
 *
 * @param {unknown} err  the rejection from httpsCallable
 * @returns {{ kind: string, reason: string, retryable: boolean }}
 */
export function describeCallableFailure(err) {
  const code = String(err?.code || "");
  const raw = String(err?.message || "").trim();
  const said = raw && !/^internal$/i.test(raw) ? raw : "";

  if (code.startsWith("functions/")) {
    const kind = code.slice("functions/".length);

    // THE FIREBASE SDK REPORTS A DEAD NETWORK AS `functions/internal` WITH THE
    // MESSAGE "internal". That is the one callable code that is usually not the
    // server talking at all, so it is the one that must not be quoted back.
    if (kind === "internal" && !said) {
      return { kind: "transport", retryable: true,
        reason: "That did not reach the server. Check the signal and try again." };
    }
    if (kind === "resource-exhausted") {
      return { kind, retryable: false,
        reason: said || "The slip reader has no capacity left right now. This is not something a retake fixes — tell Junid." };
    }
    if (kind === "unavailable") {
      return { kind, retryable: true,
        reason: said || "The slip reader is not answering right now. Try once more; if it says this again, tell Junid." };
    }
    if (kind === "deadline-exceeded") {
      return { kind, retryable: true,
        reason: "That took too long to go through — usually a weak signal with a big photo. Try again on wifi." };
    }
    if (kind === "unauthenticated" || kind === "permission-denied") {
      return { kind, retryable: false,
        reason: said || "This device is not allowed to capture slips. Sign out and in again; if it says this again, tell Junid." };
    }
    // invalid-argument, failed-precondition, already-exists, …: the server
    // wrote a sentence for exactly this case. Use it.
    return { kind, retryable: false,
      reason: said || `The slip was refused (${kind}). Tell Junid what this says.` };
  }

  // Not a callable rejection at all: a fetch that never got a response, an
  // offline browser, a blocked request.
  if (/network|failed to fetch|load failed|offline|connection/i.test(raw)) {
    return { kind: "transport", retryable: true,
      reason: "That did not reach the server. Check the signal and try again." };
  }

  return { kind: "unknown", retryable: true,
    reason: said
      ? `Something went wrong sending that: ${said}`
      : "Something went wrong sending that, and it gave no reason. Try again, then tell Junid." };
}

// ─── THE BREADCRUMB ──────────────────────────────────────────────────────────
// WHAT THE OWNER CAN READ WITHOUT A LAPTOP. The sentence above is for acting
// on; this is for diagnosing, and until now it existed only in a console nobody
// on a shop floor can open. It is deliberately small — the last few failures,
// with the stage, the code and the server's raw words — and it lives on the
// device, like the hand-capture ticks, because this app may not write anywhere
// a manager's handset can reach.

const KEY = "cardRecon.failures";
/** Enough to show a pattern, small enough to read on a phone and to store. */
const KEEP = 5;
/** A refusal sentence can be long; a breadcrumb is evidence, not prose. */
const MAX_DETAIL = 300;

const safeStorage = () => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};

/** One line of evidence, newest first. Never throws: a breadcrumb that cannot
 *  be stored is a breadcrumb that is not shown, and nothing worse. */
export function rememberFailure(entry, storage = safeStorage()) {
  if (!storage) return;
  try {
    const held = readFailures(storage);
    const row = {
      at: Number(entry?.at) || 0,
      tid: String(entry?.tid || "").slice(0, 20),
      stage: String(entry?.stage || "").slice(0, 12),
      kind: String(entry?.kind || "").slice(0, 40),
      detail: String(entry?.detail || "").slice(0, MAX_DETAIL),
    };
    storage.setItem(KEY, JSON.stringify([row, ...held].slice(0, KEEP)));
  } catch { /* unstorable is the same as unshown */ }
}

/** @returns {{at:number,tid:string,stage:string,kind:string,detail:string}[]} */
export function readFailures(storage = safeStorage()) {
  if (!storage) return [];
  try {
    const held = JSON.parse(storage.getItem(KEY) || "[]");
    return Array.isArray(held) ? held.filter((r) => r && typeof r === "object").slice(0, KEEP) : [];
  } catch { return []; }
}

export function clearFailures(storage = safeStorage()) {
  if (!storage) return;
  try { storage.removeItem(KEY); } catch { /* nothing to do */ }
}

/**
 * One breadcrumb as a line to read aloud down a phone.
 *
 * The TIME IS SA LOCAL and formatted by the caller's own formatter, because
 * this module holds no clock and no locale — the screen has both.
 */
export function failureLine(row, timeText) {
  const bits = [timeText, row?.tid, row?.stage, row?.kind].filter(Boolean);
  return `${bits.join(" · ")}${row?.detail ? ` — ${row.detail}` : ""}`;
}

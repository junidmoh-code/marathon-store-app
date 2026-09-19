// ─── HAS TODAY'S BATCH REPORT ARRIVED FOR THIS TILL? ─────────────────────────
// The capture screen shows one card per terminal and a tick when that
// terminal's report for TODAY is in. This owns the "is it in?" decision, pure:
// no React, no Firebase, no clock of its own — every day boundary is handed in
// as a key computed from the SERVER's clock, because a phone with a wrong date
// would otherwise tick a till that has not reconciled since Tuesday.
//
// TWO SOURCES, BECAUSE THERE ARE TWO WAYS A REPORT LANDS — and WHICH tills use
// WHICH is not written down anywhere, here or in any other file.
//
//   BY EMAIL — a terminal emails its batch report to the shop's mailbox and the
//     poller records what it did with each message at /card_batch_intake. That
//     node carries the TID and the outcome of every attachment, so it answers
//     for a till authoritatively, on any device, with nobody touching anything.
//     A TID appearing in that feed IS the answer to "does this machine email?".
//     Nothing asks the question in advance.
//
//   BY HAND — any till, at any time. A machine that does not email, one whose
//     email failed tonight, one nobody has tested yet: the card is tapped and
//     the slip is photographed. The record that produces lives at /card_batches,
//     which this app is not allowed to read (owner-only, and deliberately so —
//     see captureOnly.test.js), so the tick for a hand-captured till is
//     remembered on THIS DEVICE, keyed by the SA day. That is honest about what
//     it is: a receipt for the capture this phone made, not a claim about what
//     the record holds. The owner's own reports tab remains the place where the
//     batch itself is read.
//
// THE EXCEPTION USED TO BE NAMED HERE, and it was wrong within three weeks. PE
// Till 1 (0000HP1X) was the one machine on the estate that could not email;
// it has since been replaced with a PAX A920Pro, the same hardware as the
// terminals that email themselves, and renamed Marathon Till 2. Whether the new
// machine actually emails is a question for the mailbox, not for this comment —
// so the manual path stays for every till and no till is written down as the
// one that needs it.
//
// The day key is the whole reset mechanism: nothing is cleared at midnight,
// because nothing needs to be. A stored "2026-08-31" simply stops matching
// tomorrow's key, and the screen starts empty again.

/** Where a hand capture is remembered. One small object: { [tid]: "YYYY-MM-DD" }. */
const LOCAL_KEY = "cardRecon.capturedOn";

/**
 * The TIDs whose report the mailbox recorded on `dayKey`.
 *
 * @param {object|null} intakeNode   the /card_batch_intake tail, as read
 * @param {string} dayKey            "YYYY-MM-DD", SA, from the server clock
 * @param {(ms:number)=>string} dayOf  the same formula, applied to a stamp
 * @returns {Set<string>}
 */
export function emailedArrivals(intakeNode, dayKey, dayOf) {
  const out = new Set();
  for (const rec of Object.values(intakeNode || {})) {
    // The mail's own arrival time is the truer stamp than the moment the poller
    // got round to it — a message picked up after midnight still belongs to the
    // day it was sent. `at` is the fallback for rows written before the poller
    // recorded receivedAt.
    const stamp = Number(rec?.receivedAt) || Number(rec?.at) || 0;
    if (!stamp || dayOf(stamp) !== dayKey) continue;
    // The poller writes attachments as an array; RTDB hands a sparse one back
    // as an object, so both shapes are walked rather than assumed.
    const attachments = Array.isArray(rec?.attachments)
      ? rec.attachments
      : Object.values(rec?.attachments || {});
    for (const a of attachments) {
      // RECORDED ONLY. A refused attachment is precisely the case a tick must
      // not cover: the report arrived and did NOT reconcile, which is the
      // failure this whole feature exists to make visible.
      if (a?.outcome === "recorded" && a?.tid) out.add(String(a.tid));
    }
  }
  return out;
}

/**
 * The terminal named in a bank report's subject line, or null.
 *
 * "Banking Report for Batch 58 of Terminal 67325636" → "67325636".
 *
 * A FALLBACK, never the primary answer — see refusedArrivals. NO LOOKBEHIND
 * (or any other regex a parse-time SyntaxError could blank the whole app with
 * on Safari below 16.4); this is a plain capture group.
 */
export function tidFromSubject(subject) {
  const m = /\bterminal\s+([A-Za-z0-9]{4,16})\b/i.exec(String(subject || ""));
  return m ? m[1].toUpperCase() : null;
}

/**
 * The tills whose emailed report ARRIVED TODAY AND WAS REFUSED, with the
 * server's reason.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A refused attachment used to produce nothing at all. `emailedArrivals` takes
 * only `outcome === "recorded"`, quite rightly — a refused report must never
 * tick — but the card then showed a camera glyph, which is the same thing it
 * shows for a till that has simply not reported yet. The two are not the same
 * fact and must not look alike.
 *
 * On 19 Sept 2026 Marathon Till 1's report was refused at 16:40 with a reason
 * the server had already written in plain words — "Batch #58 for this terminal
 * is already captured" — and nobody saw it, because nothing rendered it. The
 * owner spent the day believing the terminal had not reported.
 *
 * NOT A TICK AND NOT A SILENCE: a third state. The screen shows the reason.
 *
 * A TILL THAT WAS REFUSED AND THEN RECORDED IS NOT IN TROUBLE — the retry
 * worked — so anything that recorded today is excluded here, whatever else it
 * did. That is the Marathon Till 3 case on the same day: batch 79 recorded at
 * 16:38 and three later re-sends were refused as duplicates, which is the
 * system working exactly as intended and must not be reported as a problem.
 *
 * @param {object|null} intakeNode   the /card_batch_intake tail, as read
 * @param {string} dayKey            "YYYY-MM-DD", SA, from the server clock
 * @param {(ms:number)=>string} dayOf  the same formula, applied to a stamp
 * @returns {Map<string,string>}  tid → the most recent refusal reason
 */
export function refusedArrivals(intakeNode, dayKey, dayOf) {
  const out = new Map();
  const at = new Map();
  const recorded = emailedArrivals(intakeNode, dayKey, dayOf);
  for (const rec of Object.values(intakeNode || {})) {
    const stamp = Number(rec?.receivedAt) || Number(rec?.at) || 0;
    if (!stamp || dayOf(stamp) !== dayKey) continue;
    const attachments = Array.isArray(rec?.attachments)
      ? rec.attachments
      : Object.values(rec?.attachments || {});
    for (const a of attachments) {
      if (a?.outcome !== "refused") continue;
      // THE ROW'S OWN TID FIRST, and the subject only as a fallback.
      //
      // Refusals written before 19 Sept 2026 carry no TID at all — all 24 on
      // file, against 53 of 53 recorded rows that do — because the poller had
      // nothing to write: the callable refused before naming a terminal. Both
      // sides are fixed, so new rows carry it; this fallback is what makes the
      // refusals ALREADY in the feed visible, including the ones from the day
      // this was found.
      //
      // The subject is the bank's own ("Banking Report for Batch 58 of
      // Terminal 67325636") and is used for one thing only: deciding which
      // card to show a message against. No figure, no outcome and no identity
      // is ever read out of it.
      const tid = String(a.tid || tidFromSubject(rec?.subject) || "");
      if (!tid) continue;
      // A report that later recorded is not an outstanding refusal.
      if (recorded.has(tid)) continue;
      // The LATEST refusal for a till, not the first: a terminal that was
      // refused twice for different reasons should show the current one.
      if ((at.get(tid) || 0) > stamp) continue;
      at.set(tid, stamp);
      out.set(tid, String(a.reason || "Its emailed report was not recorded, and no reason came back."));
    }
  }
  return out;
}

/** What this device captured by hand on `dayKey`. Never throws: a browser with
 *  storage disabled (private window, a locked-down handset) must show a screen
 *  with no ticks, not a blank one. */
export function handCaptures(dayKey, storage = safeStorage()) {
  const out = new Set();
  if (!storage) return out;
  try {
    const held = JSON.parse(storage.getItem(LOCAL_KEY) || "{}");
    for (const [tid, day] of Object.entries(held || {})) if (day === dayKey) out.add(tid);
  } catch { /* unreadable is the same as empty */ }
  return out;
}

/** Remember a successful hand capture, and drop every other day's while we are
 *  here — the object holds one entry per till, not a growing history. */
export function rememberHandCapture(tid, dayKey, storage = safeStorage()) {
  if (!storage || !tid) return;
  try {
    const held = JSON.parse(storage.getItem(LOCAL_KEY) || "{}");
    const kept = Object.fromEntries(
      Object.entries(held || {}).filter(([, day]) => day === dayKey));
    kept[tid] = dayKey;
    storage.setItem(LOCAL_KEY, JSON.stringify(kept));
  } catch { /* a tick we cannot store is a tick that is not shown; nothing worse */ }
}

function safeStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

// ─── HAS TODAY'S BATCH REPORT ARRIVED FOR THIS TILL? ─────────────────────────
// The capture screen shows one card per terminal and a tick when that
// terminal's report for TODAY is in. This owns the "is it in?" decision, pure:
// no React, no Firebase, no clock of its own — every day boundary is handed in
// as a key computed from the SERVER's clock, because a phone with a wrong date
// would otherwise tick a till that has not reconciled since Tuesday.
//
// TWO SOURCES, BECAUSE THERE ARE TWO WAYS A REPORT LANDS.
//
//   BY EMAIL — three of the four terminals email their batch report to the
//     shop's mailbox and the poller records what it did with each message at
//     /card_batch_intake. That node carries the TID and the outcome of every
//     attachment, so it answers for those tills authoritatively, on any device,
//     with nobody touching anything.
//
//   BY HAND — PE Till 1 cannot email. Its slip is photographed here, and the
//     record it produces lives at /card_batches, which this app is not allowed
//     to read (owner-only, and deliberately so — see captureOnly.test.js). So
//     the tick for a hand-captured till is remembered on THIS DEVICE, keyed by
//     the SA day. That is honest about what it is: a receipt for the capture
//     this phone made, not a claim about what the record holds. The owner's own
//     reports tab remains the place where the batch itself is read.
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

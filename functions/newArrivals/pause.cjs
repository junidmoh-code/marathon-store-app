// ── THE PAUSE SWITCHES (Junid, 8 Oct): photo generation and WhatsApp posting ──
// Two switches, on the New Arrivals card, Junid only. Stored under
// /new_arrivals/pause (a server-only node: the client never reads or writes
// /new_arrivals, so no database rule is needed):
//
//   pause/generation { paused, at, by }   every image-model call refuses while true
//   pause/posting    { paused, at, by }   the Mac mini poster sends nothing while true
//
// ABSENT = NOT PAUSED, except that the switches are set to Paused at go-live.
// EVERY Cloud Function that makes an image reads this before it calls a
// model: newArrivalsStudio, generateSocialPosts, socialDailyAutopilot,
// generateProductPhotos. (A hand-run script with its own key is not gated.) A read
// that fails counts as PAUSED — a switch that cannot be read never lets a
// model be called.
const PAUSE = "new_arrivals/pause";
const SWITCHES = Object.freeze(["generation", "posting"]);
const LABEL = Object.freeze({ generation: "Photo generation", posting: "WhatsApp posting" });
const PAUSED_MESSAGE = "Paused — photo generation is switched off on the New Arrivals card.";

/** Is `which` paused? A failed read is "paused". */
async function isPaused(db, which) {
  if (!SWITCHES.includes(which)) throw new Error(`no such switch: ${which}`);
  try {
    return (await db.ref(`${PAUSE}/${which}/paused`).once("value")).val() === true;
  } catch (e) {
    console.error(`pause: could not read ${which} — treating it as paused (${String(e?.message || e).slice(0, 80)})`);
    return true;
  }
}

/** Both switches, as the card shows them. A failed read reads as paused. */
async function readPause(db) {
  const vals = await Promise.all(SWITCHES.map((w) => isPaused(db, w)));
  return Object.fromEntries(SWITCHES.map((w, i) => [w, vals[i]]));
}

/** Flip one switch. by: the uid; nowMs: the server's clock. Pure write; the caller has checked who. */
async function setPause(db, { which, paused, by }, nowMs) {
  if (!SWITCHES.includes(which)) throw new Error(`no such switch: ${which}`);
  const rec = { paused: paused === true, at: nowMs, by: by || null };
  // The switch and its log line in ONE write: never a switch that moved with no record, or a record of a
  // switch that did not move. (The log is keyed by time: one entry per flip, never a scan.)
  await db.ref(PAUSE).update({ [which]: rec, [`log/${nowMs}`]: { which, ...rec } });
  return rec;
}

module.exports = { PAUSE, SWITCHES, LABEL, PAUSED_MESSAGE, isPaused, readPause, setPause };

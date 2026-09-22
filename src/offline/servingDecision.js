// ─── OFFLINE MIRROR — WHICH LEGS MAY SKIP THEIR LIVE SUBSCRIPTION ────────────
//
// Every screen reading a mirrored node decides, on its first render, between
// the local copy and a whole-node live onValue (serving.js has the hint it
// reads). This is where that hint is COMPUTED, after every pass, and it is the
// whole of the rule:
//
//   a leg is served locally ONLY while ALL of these hold —
//     1. the fleet switch is on                      (the caller checks)
//     2. the leg's copy is complete and vouched for  (legVerdict "yes")
//     3. the change feed is current                  (feedIsStale false)
//
//   and the moment any of them stops holding, the leg leaves the hint and
//   every screen reading it reopens its live subscription on its next render.
//
// Pure: no IndexedDB, no firebase, no clock of its own. bootstrap.js feeds it
// facts and writes the answer; the tests feed it the same facts.
//
// ── TWO THINGS THAT ARE NOT "THE COPY IS BAD" ───────────────────────────────
//
// UNKNOWN. A check that could not be asked — the browser closed the IndexedDB
// connection of a frozen page, a transaction aborted — is not a verdict on the
// rows. Measured 22 Sep 2026: a phone waking from a pocket dropped EVERY leg
// from the hint for the 20–26 s until the next pass, and every mounted screen
// re-downloaded its whole node (~15 MB) for nothing. A leg that WAS being
// served keeps being served for UNKNOWN_GRACE_MS while it is asked again. Past
// that it is dropped, so a device whose database is genuinely gone reads live
// rather than sitting on a copy it cannot check. A leg that was NOT being
// served gets no grace: unknown never turns a live read into a local one.
//
// OFFLINE. "The feed is current" is asked only while the device is connected.
// With no connection the live read cannot answer either — opening it only
// queues a whole-node download that fires the instant the line returns, which
// is precisely the cost this exists to stop. Offline, the local copy is the
// only source there is, and it is served.

// How long the feed may go without a successful read, while CONNECTED, before
// the copy is treated as not current. A pass runs every minute and backs off
// to five after a failure, so this is three failed passes in a row on a live
// line — not one slow page.
export const FEED_STALE_MS = 15 * 60 * 1000;

// How long a leg that was being served keeps being served while its check
// cannot be asked.
export const UNKNOWN_GRACE_MS = 2 * 60 * 1000;

/**
 * Is the change feed too old to trust, right now?
 *
 * `feedOkAt` — the last pass whose feed step succeeded (null if none yet).
 * `startedAt` — when this session's mirror started: a device opened in the
 *   morning has not had a chance to read its feed yet, and "last night" is not
 *   evidence that it cannot.
 */
export function feedIsStale({ connected, feedOkAt, startedAt, now }) {
  if (!connected) return false;
  const since = Math.max(feedOkAt ?? 0, startedAt ?? 0);
  return now - since > FEED_STALE_MS;
}

/**
 * The legs to serve.
 *
 *   verdicts      { legName: "yes" | "no" | "unknown" }  (health.legVerdict)
 *   wasServing    (legName) => boolean — the hint as it stands
 *   unknownSince  Map legName → ms, carried between calls (mutated here)
 *   feedStale     boolean
 *   now           ms
 */
export function decideServing({ verdicts, wasServing, unknownSince, feedStale, now }) {
  const serving = [];
  for (const [leg, verdict] of Object.entries(verdicts)) {
    let serve = false;
    if (verdict === "yes") {
      unknownSince.delete(leg);
      serve = true;
    } else if (verdict === "unknown") {
      if (!unknownSince.has(leg)) unknownSince.set(leg, now);
      serve = wasServing(leg) && now - unknownSince.get(leg) < UNKNOWN_GRACE_MS;
    } else {
      unknownSince.delete(leg);
    }
    if (serve && !feedStale) serving.push(leg);
  }
  return serving;
}

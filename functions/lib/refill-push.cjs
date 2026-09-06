// ─── REFILL REQUEST → WEB PUSH FAN-OUT ───────────────────────────────────────
// One trigger, on the creation of a /refill_requests row, covering BOTH ways a
// request comes into being:
//
//   • the 15-minute engine sweep (functions/refill-scan.cjs), which writes
//     refill_requests/{pushId} for every live intent it claims, and
//   • the human paths — Missing Sneakers "raise a request" (both the per-card
//     and the picker variants), and the on-hold re-link that turns a customer
//     hold into an ordinary hub request.
//
// They are covered by one trigger and not by two because they converge on the
// same write. Hooking the button would miss the sweep; hooking the sweep would
// miss the button; hooking the row they both create misses neither, and any
// future path that creates a request is covered on the day it ships without
// anyone remembering to come back here.
//
// ── WHAT THIS MUST NOT DO ───────────────────────────────────────────────────
// It must not scan /users and it must not scan /push_tokens. Live bandwidth is
// the largest line on this project's bill, and a whole-node read of either on
// every refill request — of which the sweep alone can create hundreds in one
// run — would be the most expensive thing in the codebase. Instead the client
// maintains a denormalised index (src/push/registerPush.js) and this reads
// exactly two small nodes per burst: the destination's bucket and the `all`
// bucket, then one per-user token node for each uid they name.
//
// ── THE BURST WINDOW ────────────────────────────────────────────────────────
// The engine sweep does not create one request, it creates a run of them. Four
// hundred notifications for one sweep is not a notification system, it is a
// denial of service against the person holding the phone.
//
// So each request joins a per-destination WINDOW, and exactly one invocation —
// the one whose transaction CREATED the window — waits FLUSH_DELAY_MS, closes
// the window, and sends a single notification naming how many landed. Every
// other invocation increments the count and exits. The claim is the window's
// creation, which a transaction makes atomic, so "exactly one" is a property of
// the database rather than of timing.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
// Eventarc delivery is at-least-once, so the same creation can arrive twice.
// Every request id that has been counted is recorded in the window node's
// `seen` map, and the map SURVIVES the window closing (pruned by age, not
// emptied), so a redelivery minutes later is still recognised as a replay
// rather than starting a fresh window and sending a second time.
//
// The window node is CLOSED with a tombstone rather than deleted, which is what
// makes that possible and also makes the flush safely repeatable: a second
// flush of an already-closed window finds nothing claimed and sends nothing.

// ── HOW A WINDOW IS JUDGED ABANDONED: A HEARTBEAT, NOT A STOPWATCH ──────────
// The first version asked "has this window existed longer than WINDOW_MS?" and
// treated a yes as "its claimer died". That question cannot tell a dead claimer
// from a live one, and it is WRONG for exactly the case this feature exists to
// serve: the engine's apply loop is boxed at 200s, so a real sweep's claimer is
// legitimately still waiting long after any such threshold. The next request
// past the line would mint a new window, steal the count, and leave the live
// claimer to wake up, find someone else's window, and send nothing. For a sweep
// longer than the threshold that repeated every threshold-length — churning the
// whole node each time, and turning one notification back into instalments.
// Raising the constant only moves the line; it does not make the question
// answerable.
//
// So the claimer SAYS IT IS ALIVE. Each tick it stamps heartbeatAt. A window
// with a fresh heartbeat has someone waiting on it and is joined; a window
// whose heartbeat has gone quiet for three ticks has lost its claimer and is
// carried forward. This is answerable, it is independent of how long the burst
// runs, and it recovers from a dead claimer FASTER than the old threshold did.
const STALE_CLAIM_MS = 45 * 1000;

// ── THE CLAIMER WAITS FOR QUIET, NOT FOR A FIXED DELAY ──────────────────────
// A fixed delay does not collapse a burst; it collapses the first N seconds of
// one. The engine's apply loop is serial RTDB I/O — a few hundred ms per intent
// — and is time-boxed at 200s, so a sweep of any size runs far longer than any
// delay short enough to keep a single human-raised request feeling immediate.
// With a fixed 20s the first draft sent "40 new refill requests", then "35 new
// refill requests", then more: fewer notifications than one per request, but
// still not the one the brief asked for.
//
// So the claimer ticks instead: sleep, re-read the count, and go round again
// while the count is still MOVING. The wait therefore ends when the burst does.
// A lone request raised by hand waits exactly one tick; a 400-intent sweep is
// held until the sweep itself stops, and lands as one notification.
//
// FLUSH_TICK_MS is what a single human-raised request costs, so it is the
// number to weigh against "immediate". MAX_FLUSH_WAIT_MS is the stop: it must
// exceed the sweep's own 200s apply box (so a full sweep collapses) and stay
// under the function timeout with room for the send. A burst still running at
// the ceiling simply gets a second notification — the degradation is graceful.
const FLUSH_TICK_MS = 12 * 1000;
const MAX_FLUSH_WAIT_MS = 240 * 1000;

// Consecutive failed tick reads before the claimer gives up waiting and flushes
// with what it has. See the catch in the wait loop for why one is not enough.
const MAX_TICK_READ_FAILURES = 3;

// How long a request id is remembered as "already counted".
const REPLAY_TTL_MS = 30 * 60 * 1000;

// ── WHY THE REPLAY MEMORY IS CAPPED, NOT JUST AGED ──────────────────────────
// Every request for a hub runs a transaction on ONE node, and a transaction
// reads and writes the WHOLE node. So an uncapped `seen` map makes a burst cost
// O(n^2) bytes: the 400th request of a sweep would read and rewrite 400 remembered
// ids. Live bandwidth is this project's largest bill line, and the engine's
// first scan after a bulk target migration once computed 4,849 intents.
//
// Capping the map bounds one transaction at roughly 10 KB however large the
// burst gets, which makes the whole feature's worst case arithmetic rather than
// a surprise. What is given up is replay protection for the OLDEST ids in a
// burst bigger than the cap — and the cost of that is bounded too: such a
// replay joins the current window and adds one to a count, or at worst produces
// a single extra "1 new refill request". It cannot duplicate the burst.
const MAX_SEEN = 250;

// Ceiling on recipients resolved from the index. Not a policy — a blast-radius
// stop, so a corrupted or abused index cannot turn one refill request into
// hundreds of per-user reads. Grounded in the real staff count (~31 accounts),
// with headroom, rather than in a round number: the console rules scope every
// audience write to the writer's own uid, so the index cannot legitimately
// exceed the number of people who work here.
const MAX_RECIPIENTS = 60;

// The FCM error codes that mean "this address is dead, stop writing to it".
// Anything else — a quota error, a transport blip, an auth hiccup — is
// transient and must NOT cost a staff member their registration.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const HUB_LABEL = {
  hub1: "Hub 1",
  hub2: "Hub 2",
  hub3: "Hub 3",
  central: "Central",
  "marathon-pe": "Marathon PE",
  trophy: "Trophy",
  "marathon-pine": "Marathon Pine",
};

const hubLabel = (hub) => HUB_LABEL[hub] || String(hub || "a hub");

// ── ONLY LINK WHERE THE REQUEST IS ACTUALLY LISTED ──────────────────────────
// Source has two hub queues and only two: the "Hub 1 Refill" tab renders hub1,
// and the "Hub 2 Refill" ("clothing") tab renders hub2 — `activeHub` in
// SourceView maps the tab to a hub and to nothing else.
//
// The engine also raises requests for STORE destinations (marathon-pe, trophy,
// marathon-pine), whose work is an R### order in the warehouse queue rather
// than a row on either of those tabs. Sending those to "clothing" — as the
// first draft did — lands the person on the Hub 2 queue, where the thing they
// were just notified about is not listed. A notification that opens the wrong
// screen is worse than one that opens no particular screen, because the reader
// concludes the alert was wrong rather than that the link was.
//
// So: a tab for the two destinations that have one, and null for the rest,
// which the caller turns into a plain open of the app.
const sourceTabFor = (hub) => (hub === "hub1" ? "hub1refill" : hub === "hub2" ? "clothing" : null);

/** Drop remembered request ids older than the replay window, and keep only the
 *  newest MAX_SEEN of whatever survives. Returns a fresh object so a transaction
 *  re-run never mutates the value it was handed. */
function pruneSeen(seen, nowMs) {
  const fresh = [];
  if (seen && typeof seen === "object" && !Array.isArray(seen)) {
    for (const [id, ts] of Object.entries(seen)) {
      if (typeof ts === "number" && nowMs - ts < REPLAY_TTL_MS) fresh.push([id, ts]);
    }
  }
  // Newest first, then truncate: an id that has just been seen is the one a
  // redelivery is most likely to be about.
  if (fresh.length > MAX_SEEN) {
    fresh.sort((a, b) => b[1] - a[1]);
    fresh.length = MAX_SEEN;
  }
  const out = {};
  for (const [id, ts] of fresh) out[id] = ts;
  return out;
}

/** A closed window: no claim outstanding, count reset, replay memory kept. */
function tombstone(cur, nowMs) {
  return { windowId: null, startedAt: 0, count: 0, sample: null, closedAt: nowMs, seen: pruneSeen(cur && cur.seen, nowMs) };
}

/**
 * Is this row something a person should be told about?
 * Separated out because every one of these is a reason a notification would be
 * WRONG, not merely unnecessary, and they are the cheapest thing to get wrong.
 */
function shouldNotify(requestId, rec) {
  if (!rec || typeof rec !== "object") return "not_a_record";
  // SHADOW ROWS ARE NOT WORK. While a destination runs in shadow mode the
  // engine writes read-only "AUTO (Shadow)" artifacts into /refill_requests so
  // staff can see what live mode would look like. Nobody picks them, and the
  // sweep rewrites the whole set every 15 minutes — notifying on them would
  // mean a burst every quarter of an hour, forever, for work that does not
  // exist. Checked two independent ways because the flag and the key prefix are
  // written by the same line and either could be the one that changes.
  if (rec.shadow === true) return "shadow";
  if (typeof requestId === "string" && requestId.startsWith("SHDWrr-")) return "shadow_key";
  if (rec.status !== "open") return "not_open";
  const hub = typeof rec.requestingLocation === "string" ? rec.requestingLocation.trim() : "";
  if (!hub) return "no_destination";
  return null;
}

/** uids subscribed to this destination: the `all` wildcard plus the hub's own
 *  bucket. Two shallow reads of small nodes — never a scan of /users. */
async function resolveRecipients(db, hub) {
  const [allSnap, hubSnap] = await Promise.all([
    db.ref("push_audience/all").get(),
    db.ref(`push_audience/${hub}`).get(),
  ]);
  const uids = new Set();
  for (const snap of [allSnap, hubSnap]) {
    const val = snap && snap.val();
    if (val && typeof val === "object") for (const uid of Object.keys(val)) uids.add(uid);
  }
  return Array.from(uids).slice(0, MAX_RECIPIENTS);
}

/** Every live token for those uids, each carrying enough to delete it again. */
async function collectTokens(db, uids) {
  const rows = [];
  const snaps = await Promise.all(uids.map((uid) => db.ref(`push_tokens/${uid}`).get()));
  snaps.forEach((snap, i) => {
    const val = snap && snap.val();
    if (!val || typeof val !== "object") return;
    for (const [tokenId, rec] of Object.entries(val)) {
      const token = rec && typeof rec.token === "string" ? rec.token : null;
      if (token) rows.push({ uid: uids[i], tokenId, token });
    }
  });
  return rows;
}

/** The words. One request names the product; a burst names the number. */
async function composeMessage(db, hub, count, sample) {
  const where = hubLabel(hub);
  let productName = "";
  const pid = sample && sample.productId;
  if (pid) {
    try {
      const snap = await db.ref(`products/${pid}/name`).get();
      const name = snap && snap.val();
      if (typeof name === "string") productName = name.trim();
    } catch { /* a missing name must not stop the send */ }
  }
  // A burst names its FIRST product as well as the count. "6 items to pick" is
  // a number; "Nike Air Max 90 and 5 more" is a thing you can picture, and it
  // is what tells someone at a glance whether this is the delivery they were
  // waiting for. The sample is the first request of the window (refill-push
  // keeps `cur.sample || sample`), so it is stable for the whole burst.
  if (count > 1) {
    const rest = count - 1;
    return {
      title: `${count} new refill requests`,
      body: productName
        ? `${where} — ${productName} and ${rest} more to pick.`
        : `${where} — ${count} items to pick.`,
    };
  }
  const size = sample && sample.size != null && String(sample.size).trim() !== "" && String(sample.size) !== "_"
    ? ` · size ${sample.size}` : "";
  const qty = sample && Number(sample.qty) > 1 ? ` ×${Number(sample.qty)}` : "";
  return {
    title: "New refill request",
    body: productName ? `${where} — ${productName}${size}${qty}` : `${where} — 1 item to pick.`,
  };
}

/** Delete the tokens FCM just told us are dead. */
async function pruneDeadTokens(db, dead) {
  if (!dead.length) return;
  const upd = {};
  for (const row of dead) upd[`push_tokens/${row.uid}/${row.tokenId}`] = null;
  await db.ref().update(upd);
}

/**
 * @param {object} args
 * @param {object} args.db            admin.database()
 * @param {object} args.messaging     admin.messaging()
 * @param {string} args.requestId
 * @param {object} args.record        the created /refill_requests row
 * @param {number} args.nowMs
 * @param {function} args.sleep       injected so tests do not wait for real ticks
 * @param {function} [args.now]        wall clock for the wait ceiling; injected so a
 *        test can drive elapsed time instead of sleeping through it
 * @param {function} [args.newWindowId]
 */
async function notifyRefillRequest({ db, messaging, requestId, record, nowMs, sleep, now = Date.now, newWindowId }) {
  const skip = shouldNotify(requestId, record);
  if (skip) return { sent: false, skipped: skip };

  const hub = record.requestingLocation.trim();
  const windowId = (newWindowId || (() => `w_${nowMs}_${Math.random().toString(36).slice(2, 10)}`))();
  const burstRef = db.ref(`push_bursts/${hub}`);
  const sample = {
    productId: record.productId || null,
    size: record.size == null ? null : String(record.size),
    qty: Number(record.qty) || 1,
  };

  // ── JOIN OR OPEN THE WINDOW ────────────────────────────────────────────────
  // Returning undefined ABORTS, which is exactly right for a replay: nothing is
  // written and nothing is claimed. Every other path returns a value, so the
  // transaction always reaches the server and re-runs against the real record
  // even when the local cache started empty.
  let replay = false;
  const claim = await burstRef.transaction((cur) => {
    const seen = pruneSeen(cur && cur.seen, nowMs);
    if (seen[requestId]) { replay = true; return undefined; }
    seen[requestId] = nowMs;
    // Fresh heartbeat (or, before the first tick, a fresh start) = a claimer is
    // alive and waiting. heartbeatAt is preferred but startedAt is the fallback,
    // because a window is joinable for its first tick before any beat exists.
    const beat = Number((cur && (cur.heartbeatAt || cur.startedAt)) || 0);
    const open = !!(cur && cur.windowId && !cur.closedAt && nowMs - beat < STALE_CLAIM_MS);
    if (open) {
      return { ...cur, count: Number(cur.count || 0) + 1, sample: cur.sample || sample, seen };
    }
    // ── AN ABANDONED WINDOW IS CARRIED FORWARD, NOT DISCARDED ────────────────
    // A window whose claimer died (a crash, an instance killed mid-flush) is
    // still open and still holds a real count of requests nobody was told
    // about. Those requests are in `seen`, so they will never be re-counted —
    // discarding the count here would silently lose them and the next
    // notification would understate the work by however many were orphaned.
    // Taking the count with us turns "lost" into "late", which is the worst a
    // notification should ever be.
    const orphaned = cur && cur.windowId && !cur.closedAt ? Number(cur.count || 0) : 0;
    return {
      windowId, startedAt: nowMs, heartbeatAt: nowMs, count: 1 + orphaned,
      sample: (orphaned && cur.sample) || sample, seen, closedAt: null,
    };
  });

  if (replay) return { sent: false, skipped: "replay" };
  if (!claim.committed) return { sent: false, skipped: "claim_failed" };
  // Only the invocation that OPENED the window sends. Everyone else has done
  // their job by being counted.
  if (claim.snapshot.val() && claim.snapshot.val().windowId !== windowId) {
    return { sent: false, skipped: "joined_window" };
  }

  // ── WAIT FOR THE BURST TO GO QUIET, THEN CLOSE AND SEND ONCE ──────────────
  // One extra small read per tick, and only for the one invocation that is
  // already waiting. Every other invocation for this burst has long since
  // exited.
  const waitStart = now();
  let lastCount = -1;
  let readFailures = 0;
  for (;;) {
    await sleep(FLUSH_TICK_MS);
    const tickNow = nowMs + (now() - waitStart);
    let cur = null;
    try {
      cur = (await burstRef.get()).val();
      readFailures = 0;
    } catch {
      // ONE blip is not an answer. Breaking on the first failed read turns the
      // whole tick design back into a single fixed delay — silently, and under
      // exactly the load (contention during a large sweep) most likely to cause
      // the failure in the first place: a sustained read problem would fragment
      // one sweep into dozens of tiny notifications, which is the original bug
      // arriving through an error path instead of a timing constant. Only a run
      // of failures means "we genuinely cannot tell", and then flushing with
      // what we have is the conservative answer.
      readFailures += 1;
      if (readFailures >= MAX_TICK_READ_FAILURES) break;
      continue;
    }
    // Somebody closed or replaced this window (a restore, a manual clear).
    // Stop waiting; the close transaction below will find nothing claimed and
    // send nothing, which is correct.
    if (!cur || cur.windowId !== windowId) break;
    // SAY WE ARE ALIVE. Without this a joining request cannot tell this claimer
    // from a dead one, and will carry the count off into a new window. A plain
    // update rather than a transaction: it is a single leaf, and a transaction
    // here would have to handle the cold-cache null case, where aborting would
    // mean never writing the beat at all.
    try { await burstRef.update({ heartbeatAt: tickNow }); } catch { /* a missed beat only risks an early handoff */ }
    const seenCount = Number(cur.count) || 0;
    if (seenCount === lastCount) break;                            // quiet — the burst is over
    lastCount = seenCount;
    if (now() - waitStart >= MAX_FLUSH_WAIT_MS) break;             // still going: send an instalment
  }
  // Derived from the INJECTED clock plus however long we actually waited, not
  // from Date.now(). The wait is real elapsed time, but every timestamp this
  // function writes has to come from the same clock as the one it was handed —
  // otherwise the replay memory is pruned against a different epoch than the
  // one its entries were written in, and every remembered id evaporates the
  // moment the window closes.
  const closedAt = nowMs + (now() - waitStart);
  let captured = null;
  await burstRef.transaction((cur) => {
    // Someone else's window: leave it entirely alone. Reachable — a run of
    // missed heartbeats (a paused instance, a spell of failed updates) lets a
    // joining request judge this claim abandoned and open its own. That path is
    // lossless: the count was carried forward into the new window, so the right
    // thing for this claimer to do is exactly nothing.
    if (cur && cur.windowId && cur.windowId !== windowId) return undefined;
    if (cur && cur.windowId === windowId) captured = cur;
    // Always returns a value, never undefined — so a cold local cache still
    // forces the re-run that finds the real window.
    return tombstone(cur, closedAt);
  });
  // Already closed (a duplicate flush), or nothing to report.
  if (!captured) return { sent: false, skipped: "window_taken" };

  const count = Math.max(1, Number(captured.count) || 1);

  // ── FROM HERE THE COUNT EXISTS ONLY IN THIS INVOCATION'S MEMORY ───────────
  // The window has just been tombstoned, so the requests it counted are in
  // `seen` (never re-counted) and their count is gone from the database. If
  // anything below throws — a transient RTDB read, an FCM 503, a malformed
  // multicast — the whole burst would vanish with no notification and no
  // signal, which is strictly worse than a late one. Everything from here to
  // the send is therefore wrapped, and a failure PUTS THE COUNT BACK.
  try {
    return await deliver({ db, messaging, hub, count, captured, closedAt });
  } catch (err) {
    await restoreBurst({ burstRef, count, captured, closedAt }).catch(() => {});
    // The house alarm pattern (CARD_RECON_ALARM, SOCIAL_ENGINE_ALARM): a log
    // marker a Monitoring alert can match, so a lost-and-restored burst is
    // visible rather than merely survivable.
    console.error(`PUSH_ALARM refillRequestPush send failed for ${hub} (${count} request(s), count restored):`, err && err.message);
    return { sent: false, skipped: "send_failed", hub, count, error: err && err.message };
  }
}

/** Put a failed burst's count back so the next request for that hub flushes it.
 *  Re-opened as ALREADY EXPIRED, so it is carried forward on the very next
 *  transaction rather than waiting out another full window. */
async function restoreBurst({ burstRef, count, captured, closedAt }) {
  await burstRef.transaction((cur) => {
    const seen = pruneSeen(cur && cur.seen, closedAt);
    // A newer window opened while we were failing: fold the count into it
    // rather than clobbering a live claim.
    if (cur && cur.windowId && !cur.closedAt) {
      return { ...cur, count: Number(cur.count || 0) + count, sample: cur.sample || captured.sample, seen };
    }
    // startedAt 0, not "closedAt minus a window". Arithmetic on the current
    // clock only LOOKS expired: a request arriving a second later would still
    // be inside the window and would JOIN this one — becoming a counted joiner
    // of a window with no claimer, so nothing would ever flush it. Zero is
    // expired against every possible clock.
    return {
      windowId: `retry_${closedAt}`,
      startedAt: 0,
      // No heartbeat: nobody is waiting on a restored window, so it must read
      // as abandoned to the very next request, which is what flushes it.
      heartbeatAt: 0,
      count,
      sample: captured.sample || null,
      seen,
      closedAt: null,
    };
  });
}

/** Resolve, compose and send. Separated so the caller above can treat every
 *  failure in here as one recoverable unit. */
async function deliver({ db, messaging, hub, count, captured, closedAt }) {
  const recipients = await resolveRecipients(db, hub);
  if (!recipients.length) return { sent: false, skipped: "no_recipients", count };

  const rows = await collectTokens(db, recipients);
  if (!rows.length) return { sent: false, skipped: "no_tokens", count };

  const { title, body } = await composeMessage(db, hub, count, captured.sample);
  const tab = sourceTabFor(hub);
  const link = tab
    ? `/?push=refill&hub=${encodeURIComponent(hub)}&tab=${tab}`
    : "/";

  // DATA-ONLY. A `notification` payload is displayed by the browser itself,
  // including while the app is open, which is precisely the double-fire the
  // foreground behaviour exists to prevent. Data-only leaves the decision to
  // the service worker (backgrounded) or the page (foregrounded) — exactly one
  // of which runs for any message. Every value must be a string.
  const message = {
    tokens: rows.map((r) => r.token),
    data: {
      kind: "refill",
      hub,
      count: String(count),
      title,
      body,
      link,
      tag: `refill-${hub}`,
      sentAt: String(closedAt),
    },
    webpush: { fcmOptions: { link } },
  };

  const res = await messaging.sendEachForMulticast(message);
  const responses = (res && res.responses) || [];
  const dead = [];
  responses.forEach((r, i) => {
    if (r && r.success) return;
    const code = r && r.error && (r.error.code || r.error.errorInfo?.code);
    if (code && DEAD_TOKEN_CODES.has(code)) dead.push(rows[i]);
  });
  await pruneDeadTokens(db, dead);

  return {
    sent: true,
    hub,
    count,
    tokens: rows.length,
    delivered: (res && res.successCount) || 0,
    pruned: dead.length,
    title,
    body,
    link,
  };
}

module.exports = {
  notifyRefillRequest,
  restoreBurst,
  shouldNotify,
  pruneSeen,
  tombstone,
  composeMessage,
  hubLabel,
  sourceTabFor,
  STALE_CLAIM_MS,
  MAX_TICK_READ_FAILURES,
  FLUSH_TICK_MS,
  MAX_FLUSH_WAIT_MS,
  REPLAY_TTL_MS,
  MAX_SEEN,
  MAX_RECIPIENTS,
  DEAD_TOKEN_CODES,
};

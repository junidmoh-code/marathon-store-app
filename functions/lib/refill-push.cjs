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

// How long requests keep joining one window. Comfortably longer than the gap
// between two consecutive writes inside one engine sweep's apply loop (serial
// RTDB I/O, a few hundred ms each), so a whole sweep collapses into one send.
const WINDOW_MS = 90 * 1000;

// How long the claimer waits before sending. Must be < the function timeout and
// < WINDOW_MS. Long enough to gather a sweep's opening burst, short enough that
// a single human-raised request still feels immediate.
const FLUSH_DELAY_MS = 20 * 1000;

// How long a request id is remembered as "already counted".
const REPLAY_TTL_MS = 30 * 60 * 1000;

// Ceiling on recipients resolved from the index. Not a policy — a blast-radius
// stop, so a corrupted index cannot turn one refill request into thousands of
// per-user reads.
const MAX_RECIPIENTS = 250;

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

// hub1's queue is its own SourceView tab; every other destination is served by
// the Hub 2 / clothing queue. Mirrors src/push/pushConfig.js.
const sourceTabFor = (hub) => (hub === "hub1" ? "hub1refill" : "clothing");

/** Drop remembered request ids older than the replay window. Returns a fresh
 *  object so a transaction re-run never mutates the value it was handed. */
function pruneSeen(seen, nowMs) {
  const out = {};
  if (seen && typeof seen === "object") {
    for (const [id, ts] of Object.entries(seen)) {
      if (typeof ts === "number" && nowMs - ts < REPLAY_TTL_MS) out[id] = ts;
    }
  }
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
  if (count > 1) {
    return {
      title: `${count} new refill requests`,
      body: `${where} — ${count} items to pick.`,
    };
  }
  let productName = "";
  const pid = sample && sample.productId;
  if (pid) {
    try {
      const snap = await db.ref(`products/${pid}/name`).get();
      const name = snap && snap.val();
      if (typeof name === "string") productName = name.trim();
    } catch { /* a missing name must not stop the send */ }
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
 * @param {function} args.sleep       injected so tests do not wait 20 seconds
 * @param {function} [args.newWindowId]
 */
async function notifyRefillRequest({ db, messaging, requestId, record, nowMs, sleep, newWindowId }) {
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
    const open = !!(cur && cur.windowId && !cur.closedAt && nowMs - Number(cur.startedAt || 0) < WINDOW_MS);
    if (open) {
      return { ...cur, count: Number(cur.count || 0) + 1, sample: cur.sample || sample, seen };
    }
    return { windowId, startedAt: nowMs, count: 1, sample, seen, closedAt: null };
  });

  if (replay) return { sent: false, skipped: "replay" };
  if (!claim.committed) return { sent: false, skipped: "claim_failed" };
  // Only the invocation that OPENED the window sends. Everyone else has done
  // their job by being counted.
  if (claim.snapshot.val() && claim.snapshot.val().windowId !== windowId) {
    return { sent: false, skipped: "joined_window" };
  }

  // ── WAIT, THEN CLOSE AND SEND ONCE ────────────────────────────────────────
  await sleep(FLUSH_DELAY_MS);
  const closedAt = nowMs + FLUSH_DELAY_MS;
  let captured = null;
  await burstRef.transaction((cur) => {
    // Someone else's window: leave it entirely alone. Cannot happen while this
    // one is open (a new window only starts once this is closed), but a flush
    // that stomped a live window would silently swallow a whole burst, so it is
    // guarded rather than reasoned away.
    if (cur && cur.windowId && cur.windowId !== windowId) return undefined;
    if (cur && cur.windowId === windowId) captured = cur;
    // Always returns a value, never undefined — so a cold local cache still
    // forces the re-run that finds the real window.
    return tombstone(cur, closedAt);
  });
  // Already closed (a duplicate flush), or nothing to report.
  if (!captured) return { sent: false, skipped: "window_taken" };

  const count = Math.max(1, Number(captured.count) || 1);
  const recipients = await resolveRecipients(db, hub);
  if (!recipients.length) return { sent: false, skipped: "no_recipients", count };

  const rows = await collectTokens(db, recipients);
  if (!rows.length) return { sent: false, skipped: "no_tokens", count };

  const { title, body } = await composeMessage(db, hub, count, captured.sample);
  const link = `/?push=refill&hub=${encodeURIComponent(hub)}&tab=${sourceTabFor(hub)}`;

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
  shouldNotify,
  pruneSeen,
  tombstone,
  composeMessage,
  hubLabel,
  sourceTabFor,
  WINDOW_MS,
  FLUSH_DELAY_MS,
  REPLAY_TTL_MS,
  MAX_RECIPIENTS,
  DEAD_TOKEN_CODES,
};

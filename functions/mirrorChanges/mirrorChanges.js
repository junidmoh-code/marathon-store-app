// ─── /mirror_changes — THE CHANGE LOG THE DEVICES READ ───────────────────────
//
// WHAT THIS IS FOR. Every device in this business keeps a local copy of the
// nodes this app reads whole (docs/store-offline-mirror.md). After its one
// setup download, a device must never read a whole node again — so it needs a
// forward-only feed of "what changed", cheap enough to read every few seconds
// and complete enough to be trusted.
//
// Two of the mirrored nodes need no help: /insights_log has push keys, which
// encode write time, and /stock_movements has a live `.indexOn: ["ts"]`. Both
// are append-only, so a range from a cursor IS the feed.
//
// The other eighteen are MUTABLE, and nothing in them moves on every write. An
// `updatedAt` on each would have to be added at dozens of write sites across
// two repos and never missed once; a missed one is a stale price on a shelf,
// which is a real incident on the tills already. So instead, one trigger per
// node appends to one log:
//
//     /mirror_changes/{pushKey} = { n: "<node>", k: "<row key>", t: <ms> }
//
// Push keys, so a client reads `orderByKey().startAfter(cursor)` — ordered,
// resumable, and needing NO .indexOn. For each record the client re-reads that
// ONE child. A child that reads back null was deleted upstream and is removed
// locally, which is the thing a timestamp cursor can never do.
//
// ── WHY THE RECORD CARRIES NO VALUE ─────────────────────────────────────────
// It would be tempting to put the new value in the record and save the client a
// read. Two reasons not to. The log would then be as big as the traffic through
// every mirrored node, retained for thirty days, and every device would pay for
// every field of every write whether it needed it or not. And the record would
// be a SECOND copy of the truth: an at-least-once trigger that can fire late
// would let an older value land after a newer one. A pointer cannot go stale.
// The client re-reads, and what it gets is what is there.
//
// ── COMPLETENESS, WHICH IS THE WHOLE PROBLEM ────────────────────────────────
// A dropped invocation is a change that never reaches any device, for ever,
// silently. Three things answer it, and no one of them would be enough:
//
//   1. `retry: true`. Cloud Functions re-delivers a failed invocation. The
//      append is idempotent in the only sense that matters — a duplicate
//      record makes a client re-read a child it has already read.
//   2. THE DAILY CENSUS. mirrorCensus counts each node's rows server-side and
//      publishes them to /mirror_counts. A device compares its local count
//      against that number, and a leg that does not match re-runs its setup
//      download. This is the backstop that makes a dropped trigger a
//      self-healing fault rather than permanent drift — and it is the reason
//      the census must NOT be derived from the same trigger stream it checks.
//   3. RETENTION IS AN HONEST WALL. A cursor older than the oldest record kept
//      cannot catch up. The client is told so and re-runs setup, rather than
//      resuming from a cursor that skips a fortnight.
//
// ── DEPLOY ──────────────────────────────────────────────────────────────────
// Scoped by name, always — this is a shared project and a bare
// `--only functions` would redeploy everything in it:
//
//   firebase deploy --project marathon-club --only \
//     functions:mirrorChangeProducts,functions:mirrorChangeStock,…
//
// scripts/print-mirror-deploy.mjs prints the full comma-separated list.
//
// The rule for /mirror_changes and /mirror_counts must be pasted BEFORE these
// functions go live, or every device reads permission-denied and every leg
// records a failure. docs/store-offline-mirror.md §10.1 has the block.

const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const {
  LEGS, CHANGES_ROOT, COUNTS_ROOT, CHANGE_RETENTION_MS, triggerRef, rowKeyFromParams,
} = require("./legs.cjs");
// Pure decisions, node-tested without firebase-functions — the displayChecks
// convention. See mirrorChanges/lib.cjs.
const { changeRecord, pushKeyForMs } = require("./lib.cjs");

const INSTANCE = "marathon-club-default-rtdb";
// Records per delete batch, and batches per invocation. The product is what one
// nightly run can drain; the cap is what stops one runaway day turning into one
// runaway invocation that times out having committed nothing it can report.
const SWEEP_BATCH = 5000;
const SWEEP_MAX_BATCHES = 40;
const REGION = "europe-west1";

const baseOpts = {
  instance: INSTANCE,
  region: REGION,
  memory: "128MiB",
  timeoutSeconds: 60,
  // See "COMPLETENESS" above. A dropped append is a silent, permanent hole in
  // every device's copy; a duplicated one costs one re-read.
  retry: true,
};

// ─── THE TRIGGERS ───────────────────────────────────────────────────────────

function makeTrigger(leg) {
  return onValueWritten({ ...baseOpts, ref: triggerRef(leg) }, async (event) => {
    const before = event.data && event.data.before;
    const after = event.data && event.data.after;
    const record = changeRecord(
      leg,
      event.params || {},
      before && before.exists() ? before.val() : null,
      after && after.exists() ? after.val() : null,
      // Google's clock. There is no device in this loop at all, so there is
      // nothing for serverNowMs() to correct.
      Date.now(),
    );
    if (!record) {
      if (rowKeyFromParams(leg, event.params || {}) === null) {
        console.error(
          `MIRROR_ALARM ${leg.name}: a key segment is unrepresentable in a row key `
          + `(empty, or containing "|") — params ${JSON.stringify(event.params)}. `
          + "No change record written; devices will not see this row change.",
        );
      }
      return;
    }
    await admin.database().ref(CHANGES_ROOT).push(record);
  });
}

const triggers = {};
for (const leg of LEGS) triggers[leg.fn] = makeTrigger(leg);

// ─── THE CENSUS — the backstop that makes a dropped trigger self-healing ────
//
// Counts each mirrored node's rows server-side once a day and publishes them.
// A device compares its own count against this and re-runs a leg's setup
// download when they disagree. That is the ONLY thing that closes a dropped
// trigger, so it deliberately does not read the change log, does not read any
// counter the triggers maintain, and does not trust anything a device says.
//
// COUNTING WITHOUT PAYING FOR THE NODE. A `?shallow=true` REST read returns
// only the child KEYS, which for /insights_log is 112,968 keys against 35.8 MB
// of records. Depth-1 nodes are counted that way. Deeper nodes are counted by
// walking one shallow level per depth, which is a handful of small requests
// rather than a megabyte.
//
// This runs ONCE A DAY for the whole business, not once per device. Its cost is
// a rounding error against what one device used to pay per screen.
const mirrorCensus = onSchedule(
  {
    schedule: "15 2 * * *",           // 02:15 UTC — 04:15 SAST, nothing trading
    timeZone: "Etc/UTC",
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 540,
    retry: false,
  },
  async () => {
    const db = admin.database();
    const at = Date.now();
    const counts = {};
    for (const leg of LEGS) {
      try {
        counts[leg.name] = { rows: await countLeg(db, leg.node, leg.depth), at };
      } catch (err) {
        // A leg that cannot be counted publishes NOTHING rather than a zero. A
        // zero here would tell every device its complete copy was wrong and
        // send the whole estate back to a 104 MB download at once.
        console.error(`MIRROR_ALARM census could not count ${leg.node}:`, err && err.message);
      }
    }
    // The ranged legs are counted too: their feed cannot drop a row, but a
    // client that mis-parsed a cursor can still fall behind, and the check
    // costs one shallow read.
    for (const [name, node] of [["movements", "stock_movements"], ["insights", "insights_log"]]) {
      try { counts[name] = { rows: await countLeg(db, node, 1), at }; }
      catch (err) { console.error(`MIRROR_ALARM census could not count ${node}:`, err && err.message); }
    }
    if (Object.keys(counts).length === 0) return;
    await db.ref(COUNTS_ROOT).update(counts);
    console.log(`mirrorCensus: published ${Object.keys(counts).length} counts`);
  },
);

// How many rows a node holds at `depth`. Depth 0 is one document, so the
// answer is "does it exist" — 1 or 0.
async function countLeg(db, node, depth) {
  if (depth === 0) {
    const snap = await db.ref(node).get();
    return snap.exists() ? 1 : 0;
  }
  return countAtDepth(db, node, depth);
}

async function countAtDepth(db, path, depth) {
  const keys = await shallowKeys(db, path);
  if (depth === 1) return keys.length;
  let total = 0;
  for (const k of keys) total += await countAtDepth(db, `${path}/${k}`, depth - 1);
  return total;
}

// The child keys of a node, without its values. The admin SDK has no shallow
// read, so this goes through the REST API with the SDK's own credentials.
async function shallowKeys(db, path) {
  const token = await admin.app().options.credential.getAccessToken();
  const url = `https://${INSTANCE}.${REGION}.firebasedatabase.app/${path}.json`
    + `?shallow=true&access_token=${encodeURIComponent(token.access_token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`shallow read of /${path} failed: ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== "object") return [];
  return Object.keys(body);
}

// ─── RETENTION ──────────────────────────────────────────────────────────────
//
// Thirty days of change records, swept daily. The sweep ranges by KEY, which
// for push keys is time order, so it never reads the records it is not
// deleting. A device whose cursor falls off the back of this window is told
// so by the client-side feed reader and re-runs its setup download — see
// changeFeed.js CursorExpiredError.
const mirrorChangesSweep = onSchedule(
  {
    schedule: "45 2 * * *",
    timeZone: "Etc/UTC",
    region: REGION,
    memory: "256MiB",
    timeoutSeconds: 540,
    retry: false,
  },
  async () => {
    const db = admin.database();
    const cutoffKey = pushKeyForMs(Date.now() - CHANGE_RETENTION_MS);
    let removed = 0;
    // A BATCH IS NOT A DAY'S WORK. One limitToFirst(5000) and a return meant
    // that any day whose expiring backlog exceeded the batch left the surplus
    // standing with no second attempt until tomorrow — and tomorrow's would be
    // larger. The log would then grow without bound while the sweep reported
    // success every night. Harmless to readers, and a cost nobody would see
    // until the bill. (Sonnet architect review, PR #618.)
    //
    // So it drains, bounded by the invocation's own 540-second timeout and by
    // a pass cap that keeps one runaway day from becoming one runaway
    // invocation. What it does not do is stop after one batch and call that
    // finished.
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
      // endBefore, not endAt: the cutoff key is a PREFIX, and a record whose
      // key begins with it was written at the cutoff millisecond. Deleting it
      // would be deleting a record inside the window by one tick.
      const snap = await db.ref(CHANGES_ROOT)
        .orderByKey().endBefore(cutoffKey).limitToFirst(SWEEP_BATCH).get();
      const val = snap.val();
      if (!val) break;
      const keys = Object.keys(val);
      if (keys.length === 0) break;
      const patch = {};
      for (const k of keys) patch[k] = null;
      await db.ref(CHANGES_ROOT).update(patch);
      removed += keys.length;
      // A short batch is the end of the expired range; anything else would be
      // the query lying about its own limit.
      if (keys.length < SWEEP_BATCH) break;
      if (batch === SWEEP_MAX_BATCHES - 1) {
        console.warn(
          `MIRROR_ALARM mirrorChangesSweep hit its pass cap after ${removed} record(s) — `
          + "the expired backlog is larger than one invocation can drain. "
          + "It will continue tomorrow, but the log is growing faster than the sweep.",
        );
      }
    }
    if (removed > 0) {
      console.log(`mirrorChangesSweep: removed ${removed} record(s) older than 30 days`);
    }
  },
);

module.exports = {
  ...triggers,
  mirrorCensus,
  mirrorChangesSweep,
  // Exported for the node:test suite. index.js skips every underscore-prefixed
  // export when it re-exports this module, so none of them is ever deployed.
  _countLeg: countLeg,
};

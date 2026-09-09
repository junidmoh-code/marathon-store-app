// ─── STORE ORDER → WEB PUSH FAN-OUT ──────────────────────────────────────────
// One trigger, on a new entry under /orders, covering EVERY way an order comes
// into being:
//
//   • the store app's checkout (AssistantView.placeOrders) — sneakers and
//     clothing-customer lines, keyed by the daily sneaker number "001".."999",
//   • the store app's refill cart (AssistantView.placeRefillRequests) — one
//     R###-{line} node per clothing line, and
//   • the refill engine's own store legs (functions/refill-scan.cjs), which
//     write the SAME R###-{line} order shape with autoRefill: true.
//
// They are covered by one trigger and not by three because they converge on the
// same write. Hooking a button would miss the sweep; hooking the sweep would
// miss the button; hooking the node they all create misses neither, and any
// future producer is covered on the day it ships.
//
// ── WHAT IS DELIBERATELY NOT COVERED, BECAUSE IT CREATES NOTHING ────────────
// Stated rather than assumed, so a future reader does not have to re-derive it:
//
//   • the POS (marathon-pos-app/src/sale/markOrderCollected.js) only ever writes
//     status / collectedAt / updatedAt on an order that already exists. It has
//     never created one.
//   • the engine's resize and close transactions (refill-scan.cjs) rewrite an
//     existing order without touching createdAt.
//   • the shadow sync rewrites SHDW- artifacts every 15 minutes but preserves
//     `existing.createdAt`, so only their first appearance is an event at all —
//     and shadow rows are refused twice over regardless.
//   • the legacy {items:[…]} migration in useOrders would create nodes, but it
//     is long done (every live key is per-id) and a migrated row is not
//     "incoming", so it is refused.
//
// None of these is a gap: each writes something that is not a new order, and
// the trigger is keyed on the one field that only a new order changes.
//
// ── WHY THE TRIGGER IS ON createdAt AND NOT ON THE ORDER NODE ───────────────
// An order id is NOT unique. Both counters (orderCounter, refillCounter) reset
// daily and cycle 001–999, while the nodes they key persist: measured live on
// 2026-09-06 there were 2,942 order nodes, 2,377 of them R-keys going back to
// July, and R040-1 had just been REWRITTEN over an August record by that
// morning's engine run.
//
// So most new orders are a set() over an ALREADY EXISTING node. onValueCreated
// fires only on null → value, which means it would have fired for a first-ever
// id and stayed silent for the ordinary case — a notification system that works
// on the day a number is first used and never again. That failure is invisible:
// no error, no log, just staff who are not told.
//
// A write to /orders/{id}/createdAt whose VALUE CHANGES is exactly "a new order
// has taken this id", under both the fresh-id and the recycled-id case, and it
// is quiet for the ordinary lifecycle (status, readyAt, dispatch and collection
// all leave createdAt alone), so the invocation count stays at roughly one per
// order placed rather than one per order write.
//
// The record is then RE-READ rather than taken from the event payload — the
// house rule for RTDB triggers here (reference_rtdb_trigger_must_reread), and
// doubly right on a path whose id can be reused: a re-read tells us what the
// order IS now, and the createdAt check below refuses to notify about a record
// that has already been replaced by the next one at the same id.
//
// ── WHAT THIS MUST NOT DO ───────────────────────────────────────────────────
// It must not scan /orders, it must not scan /users and it must not scan
// /push_tokens. Live bandwidth is the largest line on this project's bill, and
// a whole-node read of any of them on every order — of which the engine sweep
// alone can create hundreds in one run — would be the most expensive thing in
// the codebase. Instead it reads ONE small node per burst — the assigned
// audience for that order's hub, /push_hub_audience/{hub} — then one per-user
// token node for each uid it names.
//
// ── WHO IS TOLD: AN ADMIN DECISION, SCOPED TO A HUB ─────────────────────────
// Until 2026-09-07 recipients came from /push_audience, an index each CLIENT
// wrote itself into, resolved from that person's stockRole, their destShop and
// an explicit preference they set on a switch in the app. Three sources of
// truth for one question, two of them fields maintained for entirely unrelated
// reasons.
//
// It is now one source of truth and it is not a preference: Junid assigns
// people to Hub 1, Hub 2 or both on the Order Alerts card, which writes
// /push_assignments and the derived index this reads (src/push/pushAssignments.js).
// ABSENCE OF AN ASSIGNMENT IS OFF. A person with a live token, full OS
// permission and no entry in this index receives nothing, and nothing here
// consults any other field to second-guess that.
//
// HUB 3 (PINE) IS ASSIGNABLE, since 2026-09-08. It used to resolve to nobody
// by construction — no assignment could name hub3, so /push_hub_audience/hub3
// was always empty and the burst closed quietly. Nothing in THIS file encoded
// that: the exclusion lived entirely in the closed hub list on the client
// (src/push/pushAssignments.js), which is why turning Pine on required no
// change to the fan-out. Every step here — the audience read, the burst window,
// the label, the deep link — has always been keyed by whatever hub the order
// names, and hub3 was only ever a hub with an empty audience.
//
// It was not a quiet exclusion in practice. Over the fourteen days to
// 2026-09-08 the live log holds 714 orders placed at hub3, every one carrying a
// real `hub` of "hub3" and a destShop of "marathon-pine" — none refused as
// no_hub or bad_hub, none a refill. They passed every guard below and arrived
// at an audience that could never have had anybody in it.
//
// ── THE BURST WINDOW ────────────────────────────────────────────────────────
// A store does not place one order, it places a cart; the engine's sweep does
// not place one either, it places a run. Four hundred notifications for one
// sweep is not a notification system, it is a denial of service against the
// person holding the phone.
//
// So each order joins a PER-HUB window, and exactly one invocation — the one
// whose transaction CREATED the window — waits, closes the window, and sends a
// single notification naming how many landed. Every other invocation increments
// the count and exits. The claim is the window's creation, which a transaction
// makes atomic, so "exactly one" is a property of the database rather than of
// timing.
//
// ── THE WINDOW IS KEYED BY THE HUB, AND THAT KEY IS LOAD-BEARING ────────────
// It was keyed by destShop until 2026-09-07, when the audience was bucketed
// that way. It is keyed by the fulfilling hub now, because the window key and
// the recipient key MUST be the same thing: a collapse keyed by anything other
// than what the audience is scoped to can swallow an order its recipients were
// never told about.
//
// Concretely, with destShop keying and hub-scoped recipients, a Hub 1 order and
// a Hub 2 order both destined for Marathon PE would share one window — one
// notification, sent to the union of both hubs' assignees, and the Hub 2 picker
// would read "Marathon PE — 2 new orders" for a burst containing one order that
// is not theirs while the Hub 1 order they cannot see is counted in it. Keyed
// by hub, a Hub 1 burst can only ever swallow Hub 1 orders, which is exactly
// the set its recipients are entitled to hear about.
//
// The store is not lost: it is carried on the window's sample and named in the
// body of a single-order notification.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
// Eventarc delivery is at-least-once, so the same creation can arrive twice.
// Every order id that has been counted is recorded in the window node's `seen`
// map, and the map SURVIVES the window closing (pruned by age, not emptied), so
// a redelivery minutes later is still recognised as a replay rather than
// starting a fresh window and sending a second time.
//
// The seen key is `${orderId}::${createdAt}`, never the bare id: the id is
// recycled daily, so a bare id would make TOMORROW's order 005 a replay of
// today's and silently drop it.
//
// The window node is CLOSED with a tombstone rather than deleted, which is what
// makes that possible and also makes the flush safely repeatable: a second
// flush of an already-closed window finds nothing claimed and sends nothing.

// ── HOW A WINDOW IS JUDGED ABANDONED: A HEARTBEAT, NOT A STOPWATCH ──────────
// The first version asked "has this window existed longer than WINDOW_MS?" and
// treated a yes as "its claimer died". That question cannot tell a dead claimer
// from a live one, and it is WRONG for exactly the case this feature exists to
// serve: the engine's apply loop is boxed at 200s, so a real sweep's claimer is
// legitimately still waiting long after any such threshold. The next order
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
// delay short enough to keep a single hand-placed order feeling immediate.
// With a fixed 20s the first draft sent "40 new orders", then "35 new
// orders", then more: fewer notifications than one per order, but
// still not the one the brief asked for.
//
// So the claimer ticks instead: sleep, re-read the count, and go round again
// while the count is still MOVING. The wait therefore ends when the burst does.
// A lone order placed by hand waits exactly one tick; a 400-intent sweep is
// held until the sweep itself stops, and lands as one notification.
//
// FLUSH_TICK_MS is what a single hand-placed order costs, so it is the
// number to weigh against "immediate". MAX_FLUSH_WAIT_MS is the stop: it must
// exceed the sweep's own 200s apply box (so a full sweep collapses) and stay
// under the function timeout with room for the send. A burst still running at
// the ceiling simply gets a second notification — the degradation is graceful.
const FLUSH_TICK_MS = 12 * 1000;
const MAX_FLUSH_WAIT_MS = 240 * 1000;

// Consecutive failed tick reads before the claimer gives up waiting and flushes
// with what it has. See the catch in the wait loop for why one is not enough.
const MAX_TICK_READ_FAILURES = 3;

// How long an order is remembered as "already counted".
const REPLAY_TTL_MS = 30 * 60 * 1000;

// ── WHY THE REPLAY MEMORY IS CAPPED, NOT JUST AGED ──────────────────────────
// Every order for a store runs a transaction on ONE node, and a transaction
// reads and writes the WHOLE node. So an uncapped `seen` map makes a burst cost
// O(n^2) bytes: the 400th order of a sweep would read and rewrite 400 remembered
// ids. Live bandwidth is this project's largest bill line, and the engine's
// first scan after a bulk target migration once computed 4,849 intents.
//
// Capping the map bounds one transaction at roughly 10 KB however large the
// burst gets, which makes the whole feature's worst case arithmetic rather than
// a surprise. What is given up is replay protection for the OLDEST ids in a
// burst bigger than the cap — and the cost of that is bounded too: such a
// replay joins the current window and adds one to a count, or at worst produces
// a single extra "1 new order". It cannot duplicate the burst.
const MAX_SEEN = 250;

// Ceiling on recipients resolved from the index. Not a policy — a blast-radius
// stop, so a corrupted index cannot turn one order into hundreds of per-user
// reads. Grounded in the real staff count (~31 accounts), with headroom,
// rather than in a round number.
//
// The reason it cannot LEGITIMATELY be exceeded changed with the model, and
// the old sentence here still described the old one. It used to be that the
// rules scoped every audience write to the writer's own uid, so the index
// could only ever hold people who had subscribed themselves. It is now that
// /push_hub_audience is ADMIN-WRITE ONLY — one person maintains it, from one
// screen, over the accounts that exist — so anything above this number is
// corruption or a compromised admin session, and neither is a case to fan out
// for. The cap is what makes that bounded rather than merely unlikely.
const MAX_RECIPIENTS = 60;

// The FCM error codes that mean "this address is dead, stop writing to it".
// Anything else — a quota error, a transport blip, an auth hiccup — is
// transient and must NOT cost a staff member their registration.
const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// The words a person reads. Destination stores are what an order NAMES; the
// hubs are here too because the same map answers "which hub queue" for the deep
// link, and because a destShop this app does not recognise must still produce a
// readable notification rather than an empty one.
const HUB_LABEL = {
  hub1: "Hub 1",
  hub2: "Hub 2",
  hub3: "Hub 3",
  central: "Central",
  "marathon-pe": "Marathon PE",
  trophy: "Trophy",
  "marathon-pine": "Marathon Pine",
};

const hubLabel = (hub) => HUB_LABEL[hub] || String(hub || "a store");

// ── WHERE A TAP LANDS: THE ORDER, NOT A LIST ────────────────────────────────
// An order is worked in the WAREHOUSE, on the queue of the hub that has to pick
// it — order.hub for hub1/hub2, placedAtHub for hub3/hubC (WarehouseView's own
// orderInHub rule). A clothing REFILL line at a CR hub is not on the order
// queue at all; it is a card on that hub's "CR Orders" (clothing) tab.
//
// So the link carries three things the app already navigates by — the
// workspace, the hub, and the tab — plus the order's own identity, so the card
// itself is scrolled to and ringed instead of the reader being dropped on a
// list to find their own order. The identity is id AND createdAt, because the
// id alone is recycled daily and would ring yesterday's card.
//
// A burst carries no order identity: several orders cannot be one card, so it
// opens the queue they are all on.
const CR_HUBS = new Set(["hub2", "hub3"]);

// ── ONE HUB VOCABULARY, BOTH ENDS ───────────────────────────────────────────
// These are the hubs the WAREHOUSE SELECTOR offers, which is a different set
// from HUB_LABEL (that one also names the destination stores, because a
// notification names a store). A link may only carry a hub the selector can
// render: the client refuses any other (src/push/deepLink.js VALID_HUBS), so
// emitting one here would produce a link that silently drops its hub and lands
// the reader on whichever hub they last used. Pinned to the same four strings
// on both ends.
const WAREHOUSE_HUBS = new Set(["hub1", "hub2", "hub3", "hubC"]);

/** The hub whose warehouse queue this order is worked on. */
function hubForOrder(rec) {
  const placed = typeof rec.placedAtHub === "string" ? rec.placedAtHub.trim() : "";
  const hub = typeof rec.hub === "string" ? rec.hub.trim() : "";
  // WarehouseView filters hub3/hubC by placedAtHub and hub1/hub2 by `hub`;
  // every live order writes both to the same value, so preferring `hub` and
  // falling back to placedAtHub agrees with the screen under every shape.
  return hub || placed || "";
}

/** Is this a shop-refill line (a CR card) rather than a customer order? */
function isRefillOrder(rec) {
  return rec.customerName === "Shop Refill" || rec.autoRefill === true;
}

/** Which warehouse tab lists this order. */
function warehouseTabFor(rec) {
  const hub = hubForOrder(rec);
  return isRefillOrder(rec) && CR_HUBS.has(hub) ? "clothing" : "queue";
}

/** The link a notification opens. `sample` is the first order of the window;
 *  a burst (count > 1) drops the per-order identity and opens the queue.
 *  A destination with no usable hub opens the app plainly — a link to the
 *  wrong screen is worse than a link to no particular screen, because the
 *  reader concludes the ALERT was wrong rather than that the link was. */
function orderLink(sample, count) {
  const hub = sample && typeof sample.hub === "string" ? sample.hub : "";
  if (!hub || !WAREHOUSE_HUBS.has(hub)) return "/";
  const tab = (sample && sample.tab) === "clothing" ? "clothing" : "queue";
  const base = `/?push=order&hub=${encodeURIComponent(hub)}&tab=${tab}`;
  if (count > 1 || !sample.orderId) return base;
  return base
    + `&order=${encodeURIComponent(sample.orderId)}`
    + `&at=${encodeURIComponent(sample.createdAt || "")}`;
}

/** Drop remembered order keys older than the replay window, and keep only the
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
 *
 * `expectedCreatedAt` is the value the trigger fired on. An order id is reused,
 * so by the time this runs the node may already hold the NEXT order at that id;
 * announcing the re-read record against the old event would name the wrong
 * thing, and the new record has its own event coming.
 */
function shouldNotify(orderId, rec, expectedCreatedAt) {
  if (!rec || typeof rec !== "object") return "not_a_record";
  // SHADOW ROWS ARE NOT WORK. While a destination runs in shadow mode the
  // engine writes read-only "AUTO (Shadow)" orders into /orders so staff can
  // see what live mode would look like. Nobody picks them, and the sweep
  // rewrites the whole set every 15 minutes — notifying on them would mean a
  // burst every quarter of an hour, forever, for work that does not exist.
  // Checked two independent ways because the flag and the key prefix are
  // written by the same line and either could be the one that changes.
  if (rec.autoShadow === true) return "shadow";
  if (typeof orderId === "string" && orderId.startsWith("SHDW-")) return "shadow_key";
  // Every producer writes a new order as "incoming" (App.jsx STATUS.INCOMING,
  // refill-scan.cjs). Anything else arriving on a createdAt write is a restore
  // or a migration replaying old rows, not work landing now.
  if (rec.status !== "incoming") return "not_incoming";
  // The event's createdAt must still be the record's — see the doc comment.
  // Compared as strings because that is what both producers write (an ISO
  // stamp), and a type change is itself a reason to refuse.
  if (expectedCreatedAt != null && String(rec.createdAt) !== String(expectedCreatedAt)) {
    return "superseded";
  }
  const dest = typeof rec.destShop === "string" ? rec.destShop.trim() : "";
  if (!dest) return "no_destination";
  // destShop is no longer a path segment — nothing is keyed by it since the
  // window moved to the hub — but this guard STAYS. It arrives from records
  // this function does not write, the data here is known to be dirty, and a
  // record whose destination is unusable is a record something else has gone
  // wrong with; announcing it as if it were fine is worse than refusing it.
  // Every live producer writes a clean destShop, so this costs nothing.
  if (/[.#$/[\]]/.test(dest)) return "bad_destination";
  // ── THE HUB, WHICH IS NOW THE KEY EVERYTHING ELSE HANGS OFF ───────────────
  // The hub is on the order AT CREATION, in the same object literal as
  // createdAt and status — every producer resolves it before the write
  // (AssistantView.placeOrders via the cart allocation, placeRefillRequests,
  // and refill-scan.cjs from the source hub) and writes it to BOTH `hub` and
  // `placedAtHub`. So by the time this trigger fires there is nothing to wait
  // for and nothing to resolve: the answer is in the record.
  //
  // Which is exactly why a record WITHOUT one is refused rather than guessed.
  // A missing hub on a live order is a malformed record, not a timing
  // question, and there is no safe default: sending to hub1 would put another
  // hub's work on Hub 1's phones, and sending to everyone would undo the
  // scoping this whole release is. The order still exists and is still worked
  // — it is on the warehouse queue like any other — it simply does not
  // announce itself. Refusing is the only outcome that cannot be WRONG.
  //
  // And, as with dest, THIS VALUE BECOMES A PATH SEGMENT (push_bursts/{hub},
  // push_hub_audience/{hub}). db.ref() throws SYNCHRONOUSLY on an illegal key,
  // before any try/catch downstream exists, so the whole invocation would die
  // rather than degrade.
  const hub = hubForOrder(rec);
  if (!hub) return "no_hub";
  if (/[.#$/[\]]/.test(hub)) return "bad_hub";
  return null;
}

/** The uids Junid has ASSIGNED to this hub. ONE shallow read of one small node
 *  — never a scan of /users, /push_assignments or /push_tokens.
 *
 *  There is no wildcard bucket and no fallback. An empty node means nobody was
 *  assigned to this hub, and nobody assigned means nobody is told: that is the
 *  default state of every account and it is the correct one. A "helpful"
 *  fallback here — to an `all` bucket, to a role, to the last known audience —
 *  would be the single line that quietly undoes the whole model. */
async function resolveRecipients(db, hub) {
  const snap = await db.ref(`push_hub_audience/${hub}`).get();
  const val = snap && snap.val();
  if (!val || typeof val !== "object") return [];
  return Object.keys(val).slice(0, MAX_RECIPIENTS);
}

// ── THE MUTE IS A VETO, APPLIED HERE AND NOWHERE ELSE ───────────────────────
// Recipients are the AND of two independent facts: Junid ASSIGNED this person
// to this hub, and this person has not silenced their own phone. The assignment
// is the only thing that grants, and it is resolved above; the mute is the only
// thing a staff member can write, and it can only ever take somebody OUT of a
// send. Neither can stand in for the other, and no order of evaluation makes
// one imply the other.
//
// ── ONE LEAF PER RECIPIENT, AND WHY IT IS CHEAPER THAN IT LOOKS ─────────────
// `push_mutes/{uid}/muted` is a single boolean — the smallest read RTDB can be
// asked for, and bounded by MAX_RECIPIENTS like everything else here. It runs
// BEFORE collectTokens on purpose: a muted person then costs this one leaf
// instead of a leaf plus their whole token node, and most people are not muted
// so most of the time it costs one extra tiny read on top of a send that was
// going to happen anyway. A single whole-node read of /push_mutes would be
// fewer round trips and is deliberately not done — this project does not take
// whole-node reads, and this one would grow with headcount forever.
//
// ── A MUTE THAT CANNOT BE READ IS NOT A MUTE ────────────────────────────────
// allSettled, and a refusal counts as AUDIBLE. Failing the other way would mean
// one RTDB blip silences everybody assigned to a hub — the exact silent,
// invisible non-delivery this whole release exists to end, and it would look
// identical to the feature being broken again. The cost of the choice made here
// is that a muted phone might buzz once during an outage, which the person can
// see and understand. The cost of the other choice is nobody hearing anything
// and nobody knowing why.
//
// allSettled also keeps ONE refused read from becoming a refused delivery.
// This runs inside deliver(), whose caller treats a throw as "the send failed"
// and puts the whole burst back — so a rejection here would postpone the
// notification rather than duplicate it (nothing has been multicast yet at this
// point), but a persistent refusal would postpone it for ever, which is the
// same silence by a slower route.
//
// The cost of failing open is stated rather than minimised: while a refusal
// persists, a muted person is notified on EVERY burst, not once. That is
// visible to them and they can act on it. The cost of failing closed is a hub
// hearing nothing, with nobody able to tell that anything is wrong.
async function dropMuted(db, uids) {
  const settled = await Promise.allSettled(
    uids.map((uid) => db.ref(`push_mutes/${uid}/muted`).get()));
  const audible = [];
  settled.forEach((res, i) => {
    if (res.status !== "fulfilled") {
      console.error("PUSH_ALARM orderPlacedPush could not read a mute (treated as audible):",
        res.reason && res.reason.message);
      audible.push(uids[i]);
      return;
    }
    // Only a REAL boolean true mutes. A stray string, a 1 or a null is
    // corruption in a node whose one writer is a switch, and corruption here
    // must degrade towards DELIVERY — mirrors isMuted() in src/push/pushMute.js.
    if (res.value && res.value.val() === true) return;
    audible.push(uids[i]);
  });
  return audible;
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

/** The words. One order names what was ordered; a burst names the number and
 *  still names the first thing, because "6 orders" is a number and "Nike Air
 *  Max 90 and 5 more" is something you can picture from a lock screen — which
 *  is what tells someone whether to walk to the back or finish their coffee. */
async function composeMessage(db, hub, count, sample) {
  // The TITLE names the HUB, because the hub is what the reader is assigned to
  // and what the burst was collapsed by. The STORE goes in the body of a single
  // order, where it still tells the picker where the box is going; a burst can
  // span stores, so it does not claim one.
  const where = hubLabel(hub);
  const store = sample && typeof sample.dest === "string" && sample.dest.trim()
    ? `${hubLabel(sample.dest.trim())} · ` : "";
  // The order node CARRIES productName (every producer writes it), so the
  // normal path costs no read at all. The /products fallback is for a record
  // written without one rather than the usual case.
  let productName = sample && typeof sample.productName === "string" ? sample.productName.trim() : "";
  const pid = sample && sample.productId;
  if (!productName && pid) {
    try {
      const snap = await db.ref(`products/${pid}/name`).get();
      const name = snap && snap.val();
      if (typeof name === "string") productName = name.trim();
    } catch { /* a missing name must not stop the send */ }
  }
  if (count > 1) {
    const rest = count - 1;
    return {
      title: `${where} — ${count} new orders`,
      body: productName
        ? `${productName} and ${rest} more to pick.`
        : `${count} items to pick.`,
    };
  }
  const size = sample && sample.size != null && String(sample.size).trim() !== "" && String(sample.size) !== "_"
    ? ` · size ${sample.size}` : "";
  const qty = sample && Number(sample.qty) > 1 ? ` ×${Number(sample.qty)}` : "";
  // The order number leads: it is what is written on the box, called over the
  // radio and printed on the slip, so it is the one token that lets a reader
  // match the notification to the physical job.
  const num = sample && sample.orderId ? `#${sample.orderId} · ` : "";
  const kind = sample && sample.refill ? "Shop refill: " : "";
  return {
    title: `${where} — new order`,
    body: productName
      ? `${store}${num}${kind}${productName}${size}${qty}`
      : `${store}${num}${kind}1 item to pick.`,
  };
}

/** Delete the tokens FCM just told us are dead. */
async function pruneDeadTokens(db, dead) {
  if (!dead.length) return;
  const upd = {};
  for (const row of dead) upd[`push_tokens/${row.uid}/${row.tokenId}`] = null;
  await db.ref().update(upd);
}

// ── THE REPLAY KEY IS EPOCH-MS, NEVER THE ISO STAMP ─────────────────────────
// This string becomes an OBJECT KEY inside the window node's `seen` map, so it
// is an RTDB key and lives under RTDB's key rules: no ".", "#", "$", "/", "["
// or "]". An ISO timestamp carries a dot in its milliseconds
// ("2026-09-06T07:07:41.633Z"), and the Admin SDK throws SYNCHRONOUSLY on an
// invalid key — before the transaction is even sent, so nothing downstream can
// catch it. The result is not a degraded notification, it is every claim
// throwing and nobody ever being told anything.
//
// This project has already paid for this lesson once: #269, where the refill
// engine built /refill_engine/retryHistory/{…|ISO} and crashed every scan that
// reached that line, intermittently, for hours. The fix then was epoch-ms and
// it is epoch-ms here.
//
// The identity still has to be id AND time — order numbers are recycled daily,
// so a bare id would make tomorrow's 005 a replay of today's and silently drop
// a real order. Epoch-ms preserves that distinction exactly for the ISO stamps
// every producer writes.
//
// The fallback is for a createdAt this app did not write (dirty data, a restore
// with a different shape): unparseable values keep their own text with every
// illegal character replaced, so two different malformed stamps stay different
// keys rather than collapsing into one and being read as replays of each other.
function replayKey(orderId, createdAt) {
  const raw = createdAt == null ? "" : String(createdAt);
  const ms = Date.parse(raw);
  const stamp = Number.isFinite(ms) ? String(ms) : raw.replace(/[.#$/[\]]/g, "-");
  return `${orderId}::${stamp}`;
}

/**
 * @param {object} args
 * @param {object} args.db            admin.database()
 * @param {object} args.messaging     admin.messaging()
 * @param {string} args.orderId       the /orders key ("005", "R041-2", …)
 * @param {object} args.record        the RE-READ /orders/{orderId} record
 * @param {string} [args.createdAt]   the createdAt the trigger fired on; a record
 *        whose createdAt has moved on has been replaced by the next order at
 *        this (recycled) id and is announced by its own event, not this one
 * @param {number} args.nowMs
 * @param {function} args.sleep       injected so tests do not wait for real ticks
 * @param {function} [args.now]        wall clock for the wait ceiling; injected so a
 *        test can drive elapsed time instead of sleeping through it
 * @param {function} [args.newWindowId]
 */
async function notifyOrderPlaced({ db, messaging, orderId, record, createdAt, nowMs, sleep, now = Date.now, newWindowId }) {
  const skip = shouldNotify(orderId, record, createdAt);
  if (skip) return { sent: false, skipped: skip };

  // Validated by shouldNotify above: non-empty, and a legal RTDB key.
  const hub = hubForOrder(record);
  const seenKey = replayKey(orderId, record.createdAt);
  const windowId = (newWindowId || (() => `w_${nowMs}_${Math.random().toString(36).slice(2, 10)}`))();
  const burstRef = db.ref(`push_bursts/${hub}`);
  const sample = {
    orderId,
    createdAt: record.createdAt == null ? null : String(record.createdAt),
    productId: record.productId || null,
    productName: typeof record.productName === "string" ? record.productName : null,
    size: record.size == null ? null : String(record.size),
    qty: Number(record.qty) || 1,
    refill: isRefillOrder(record),
    hub,
    // The destination STORE, carried so a single-order notification can still
    // say where the box is going. It is no longer a path segment anywhere.
    dest: record.destShop.trim(),
    tab: warehouseTabFor(record),
  };

  // ── JOIN OR OPEN THE WINDOW ────────────────────────────────────────────────
  // Returning undefined ABORTS, which is exactly right for a replay: nothing is
  // written and nothing is claimed. Every other path returns a value, so the
  // transaction always reaches the server and re-runs against the real record
  // even when the local cache started empty.
  let replay = false;
  const claim = await burstRef.transaction((cur) => {
    const seen = pruneSeen(cur && cur.seen, nowMs);
    if (seen[seenKey]) { replay = true; return undefined; }
    seen[seenKey] = nowMs;
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
    // still open and still holds a real count of orders nobody was told
    // about. Those orders are in `seen`, so they will never be re-counted —
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
  // Seeded with the count this invocation actually claimed, NOT -1. Starting
  // below every possible count makes the first tick unable to conclude "quiet",
  // so a single hand-placed order that attracts no joiners waited two ticks —
  // 24s, not the one tick the comments promise.
  let lastCount = Number((claim.snapshot.val() || {}).count) || 0;
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
    // SAY WE ARE ALIVE. Without this a joining order cannot tell this claimer
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
  const closeRes = await burstRef.transaction((cur) => {
    // Someone else's window: leave it entirely alone. Reachable — a run of
    // missed heartbeats (a paused instance, a spell of failed updates) lets a
    // joining order judge this claim abandoned and open its own. That path is
    // lossless: the count was carried forward into the new window, so the right
    // thing for this claimer to do is exactly nothing.
    if (cur && cur.windowId && cur.windowId !== windowId) return undefined;
    if (cur && cur.windowId === windowId) captured = cur;
    // Always returns a value, never undefined — so a cold local cache still
    // forces the re-run that finds the real window.
    return tombstone(cur, closedAt);
  });
  // Already closed (a duplicate flush), or nothing to report.
  //
  // `committed` is checked as well as `captured`, and the order matters. A
  // transaction handler runs MORE than twice against a contended node, and
  // `captured` is assigned from inside it — so a run that saw our window (a
  // stale local value) followed by a run that saw somebody else's (the server's
  // truth, which aborts) would leave `captured` set on a transaction that
  // changed nothing. Sending then would duplicate the notification of whichever
  // claimer actually owns the window now. Nothing was closed, so nothing is
  // sent.
  if (!closeRes.committed || !captured) return { sent: false, skipped: "window_taken" };

  const count = Math.max(1, Number(captured.count) || 1);

  // ── FROM HERE THE COUNT EXISTS ONLY IN THIS INVOCATION'S MEMORY ───────────
  // The window has just been tombstoned, so the orders it counted are in
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
    console.error(`PUSH_ALARM orderPlacedPush send failed for ${hub} (${count} order(s), count restored):`, err && err.message);
    return { sent: false, skipped: "send_failed", hub, count, error: err && err.message };
  }
}

/** Put a failed burst's count back so the next order for that store flushes it.
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
    // clock only LOOKS expired: an order arriving a second later would still
    // be inside the window and would JOIN this one — becoming a counted joiner
    // of a window with no claimer, so nothing would ever flush it. Zero is
    // expired against every possible clock.
    return {
      windowId: `retry_${closedAt}`,
      startedAt: 0,
      // No heartbeat: nobody is waiting on a restored window, so it must read
      // as abandoned to the very next order, which is what flushes it.
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
  const assigned = await resolveRecipients(db, hub);
  if (!assigned.length) return { sent: false, skipped: "no_recipients", count };

  // ASSIGNED AND NOT MUTED. A muted uid never reaches collectTokens, so its
  // token is never in the multicast, so it can never appear in `dead` and can
  // never be pruned for being muted — the row stays live and unmuting works
  // instantly, with nothing to re-register.
  const recipients = await dropMuted(db, assigned);
  if (!recipients.length) return { sent: false, skipped: "all_muted", count };

  const rows = await collectTokens(db, recipients);
  if (!rows.length) return { sent: false, skipped: "no_tokens", count };

  const { title, body } = await composeMessage(db, hub, count, captured.sample);
  const link = orderLink(captured.sample, count);

  // DATA-ONLY. A `notification` payload is displayed by the browser itself,
  // including while the app is open, which is precisely the double-fire the
  // foreground behaviour exists to prevent. Data-only leaves the decision to
  // the service worker (backgrounded) or the page (foregrounded) — exactly one
  // of which runs for any message. Every value must be a string.
  const message = {
    tokens: rows.map((r) => r.token),
    data: {
      kind: "order",
      hub,
      count: String(count),
      title,
      body,
      link,
      // One tag PER HUB, so a second notification for the same hub REPLACES the
      // first on the lock screen instead of stacking — and, just as
      // importantly, so a Hub 2 notification never replaces a Hub 1 one on the
      // phone of somebody assigned to both.
      tag: `order-${hub}`,
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
  // NEVER fatal. This runs AFTER the multicast has already been delivered, and
  // the caller's catch treats a throw as "the send failed" and puts the whole
  // burst back — so a failed tidy-up would re-notify every device that had just
  // been told. Housekeeping cannot be allowed to undo the thing it comes after.
  try {
    await pruneDeadTokens(db, dead);
  } catch (err) {
    console.error("PUSH_ALARM orderPlacedPush could not prune dead tokens (delivery already succeeded):", err && err.message);
  }

  // NOBODY GOT IT IS NOT A SEND. A multicast where every token failed for a
  // transient reason (a quota spell, an FCM blip) would otherwise consume the
  // burst: the count is gone, the ids are remembered as seen, and no device
  // received anything — the exact silent loss the restore path exists for. A
  // partial success is left alone, because the alternative is re-notifying the
  // devices that did get it.
  const delivered = (res && res.successCount) || 0;
  if (!delivered && rows.length) {
    throw new Error(`multicast delivered 0 of ${rows.length} tokens`);
  }

  return {
    sent: true,
    hub,
    count,
    tokens: rows.length,
    delivered,
    pruned: dead.length,
    title,
    body,
    link,
  };
}

module.exports = {
  notifyOrderPlaced,
  restoreBurst,
  shouldNotify,
  pruneSeen,
  tombstone,
  composeMessage,
  replayKey,
  hubLabel,
  WAREHOUSE_HUBS,
  hubForOrder,
  isRefillOrder,
  warehouseTabFor,
  orderLink,
  STALE_CLAIM_MS,
  MAX_TICK_READ_FAILURES,
  FLUSH_TICK_MS,
  MAX_FLUSH_WAIT_MS,
  REPLAY_TTL_MS,
  MAX_SEEN,
  MAX_RECIPIENTS,
  DEAD_TOKEN_CODES,
};

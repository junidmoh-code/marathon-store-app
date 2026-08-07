// ─── REFILL HISTORY — the pure core ───────────────────────────────────────────
// Everything the Hub 1 / Hub 2 refill history computes, with no React and no
// Firebase, so the date maths and the outcome classification are testable
// without a browser or a live database.
//
// WHAT THE VIEW HAS TO ANSWER, and why it needs two sources rather than one:
//
//   • WHAT WAS ASKED FOR AND HOW IT ENDED — requested, fulfilled, rejected,
//     cancelled, withdrawn, parked, with the reason and the person. Only
//     /refill_requests knows this. A movement records that stock moved; it can
//     never tell you a request was REFUSED, because a refusal moves nothing.
//   • WHAT PHYSICALLY MOVED, AND FROM WHERE — /stock_movements. This is the only
//     honest answer to "which location supplied this", and the only durable
//     record of DISPLAY refills, whose orders are overwritten by the daily
//     order-number reset.
//
// Neither source subsumes the other, so rows are built from both and tagged with
// their `kind`. A fulfilled request and its own `rrf_` movement are the same
// event seen twice — mergeRows() folds them into one row rather than showing the
// work double.
//
// ─── BANDWIDTH ───────────────────────────────────────────────────────────────
// This project has a live RTDB download-cost problem: an unindexed whole-node
// read once cost hundreds of dollars a month. So:
//
//   • MOVEMENTS are queried by `ts` against the index that ALREADY EXISTS
//     (database.rules.json, stock_movements/.indexOn: ["ts"]). Range-scoped from
//     the first render, no new rule needed.
//   • REQUESTS have NO index on /refill_requests. Firing an unindexed
//     orderByChild would be the worst possible outcome: RTDB answers it by
//     shipping the ENTIRE node and sorting on the client — the exact spend this
//     view is supposed to avoid, silently. So the ranged query is gated behind
//     REQUESTS_INDEXED below and stays OFF until the rule is pasted.
//
// WHAT THE FALLBACK COSTS — stated plainly, because an earlier version of this
// comment was WRONG. It claimed the fallback rode a subscription the Source
// screen already held. It does not: Hub2RefillQueue, the other consumer of
// /refill_requests, mounts only on the `clothing` and `hub1refill` tabs, and the
// history is its own tab. So the fallback is a real, full read of the node
// (~11,800 rows, ~3.7 MB), filtered in memory.
//
// Two things keep that honest rather than cheap-sounding:
//   • it is a ONE-SHOT get(), not a live onValue listener — a listener would
//     re-materialise the whole node on every append for as long as the tab is open
//   • it does NOT re-read when the date range changes, because the range is
//     applied in memory; one read per mount, not one per chip tap
// The on-screen banner says the same thing. Pasting the index below replaces
// this with a genuinely range-scoped query.
//
// See REQUESTS_INDEXED for the exact rule line.

// ─── THE RULE TO PASTE ───────────────────────────────────────────────────────
// Ranged loading of /refill_requests needs an index. Add to the "refill_requests"
// node in the Firebase console (Realtime Database → Rules), as a SIBLING of the
// existing ".read":
//
//     ".indexOn": ["createdAt", "resolvedAt"],
//
// i.e. the node becomes:
//
//     "refill_requests": {
//       ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
//       ".indexOn": ["createdAt", "resolvedAt"],
//       "$refillId": { ... unchanged ... }
//     }
//
// Two fields because a request raised last month and fulfilled yesterday belongs
// in yesterday's history: createdAt finds what was ASKED in the range,
// resolvedAt what was ANSWERED in it, and the two result sets are merged by id.
//
// Flip this to true ONLY after the rule is live. Set true while the index is
// missing and every range query silently downloads all ~11,800 records.
export const REQUESTS_INDEXED = false;

// SA is UTC+2 year-round, no DST — the same constant serverTime.js uses. Every
// boundary in this file is an SA calendar boundary: "yesterday" means the
// trading day the staff worked, not a UTC window that cuts it at 02:00.
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for an instant, in SA time. */
export function saDayOf(ms) {
  return new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of 00:00:00 SA on an SA calendar day ("YYYY-MM-DD"). */
export function saDayStartMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`) - SA_OFFSET_MS;
}

export const QUICK_RANGES = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "month", label: "This month" },
];

/**
 * Resolve a range key to a half-open UTC window [fromMs, toMs) and the SA
 * calendar days it spans, so the same object drives both the RTDB query and the
 * date inputs.
 *
 * HALF-OPEN IS DELIBERATE. An inclusive end would need "the last millisecond of
 * the day", and every off-by-one in a date filter this project has had came from
 * someone picking 23:59:59 and losing the events in that final second.
 */
export function resolveRange(key, nowMs, custom = {}) {
  const today = saDayOf(nowMs);
  // saDayStartMs() already returns the UTC instant of SA midnight, and saDayOf()
  // adds the offset back — so stepping whole days here needs no further nudging.
  const dayBefore = (d, n) => saDayOf(saDayStartMs(d) - n * 864e5);
  let fromDay = today, toDay = today;
  if (key === "yesterday") { fromDay = toDay = dayBefore(today, 1); }
  else if (key === "last7") { fromDay = dayBefore(today, 6); toDay = today; }
  else if (key === "month") { fromDay = `${today.slice(0, 7)}-01`; toDay = today; }
  else if (key === "custom") {
    fromDay = custom.from || today;
    toDay = custom.to || fromDay;
    // A backwards range is a typo, not an empty result — swap rather than show
    // a blank screen the operator has to diagnose.
    if (toDay < fromDay) [fromDay, toDay] = [toDay, fromDay];
  }
  return {
    key, fromDay, toDay,
    fromMs: saDayStartMs(fromDay),
    toMs: saDayStartMs(toDay) + 864e5,          // exclusive: start of the next day
    fromIso: new Date(saDayStartMs(fromDay)).toISOString(),
    toIso: new Date(saDayStartMs(toDay) + 864e5).toISOString(),
    days: Math.round((saDayStartMs(toDay) - saDayStartMs(fromDay)) / 864e5) + 1,
  };
}

// ─── OUTCOMES ────────────────────────────────────────────────────────────────
// Six buckets, because "cancelled" alone tells an operator nothing. The
// distinction that matters on the floor is WHO said no and whether it comes
// back: a human refusal is a fact about the shelf, an engine withdrawal is the
// system correcting itself, and a park is a promise to return.
export const STATUSES = ["requested", "fulfilled", "rejected", "withdrawn", "parked", "cancelled"];

export const STATUS_LABEL = {
  requested: "Open",
  fulfilled: "Refilled",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  parked: "Parked",
  cancelled: "Cancelled",
};

// cancelReason is the discriminator the engine already writes, and its ABSENCE
// is load-bearing: a cancelled request with no cancelReason is a HUMAN reject
// (Hub2RefillQueue's ✕ deliberately omits the field, and the engine reads that
// shape as a rejection with a cooldown). Never invent a default here — doing so
// would relabel 976 live human refusals as engine withdrawals.
const WITHDRAWN_REASONS = new Set(["no_longer_needed", "unfillable", "order_lost", "already_in_stock"]);
const PARKED_REASONS = new Set(["awaiting_upstream"]);

export function classifyRequest(r) {
  if (!r) return null;
  if (r.status === "fulfilled") return "fulfilled";
  if (r.status === "open") return "requested";
  if (r.status !== "cancelled") return "cancelled";
  if (!r.cancelReason) return "rejected";                     // human ✕ — see above
  if (PARKED_REASONS.has(r.cancelReason)) return "parked";
  if (WITHDRAWN_REASONS.has(r.cancelReason)) return "withdrawn";
  return "cancelled";                                         // an unknown reason stays honest
}

// Plain-English reason text. Engine reasons are terse identifiers written for
// the ledger; nobody working a hub should have to learn them.
export const REASON_TEXT = {
  no_longer_needed: "target already met — stock arrived another way",
  already_in_stock: "the destination already held enough",
  unfillable: "no stock anywhere in the network",
  awaiting_upstream: "source had none — returns automatically when it restocks",
  order_lost: "its order record was lost (daily number reuse)",
};

/** When did this request's OUTCOME happen? Open ones are dated by when they
 *  were raised — that is the only event they have had. */
export const eventMsOf = (r) => Date.parse((r.status === "open" ? r.createdAt : (r.resolvedAt || r.createdAt)) || "") || 0;

// ─── ROWS FROM /refill_requests ──────────────────────────────────────────────

/**
 * @param requests rows with `id`, as useRefillRequests() returns them.
 * @param range from resolveRange().
 * @param hubs which destinations to include, e.g. ["hub1","hub2"].
 *
 * A request is IN RANGE if either end of its life falls inside it — raised in
 * the window, or resolved in it. A refill asked for on Monday and picked on
 * Wednesday is real work on both days and must not vanish from either.
 */
export function requestRows(requests = [], range, hubs = []) {
  const want = new Set(hubs);
  const out = [];
  for (const r of requests) {
    if (!r || !want.has(r.requestingLocation)) continue;
    if (r.shadow) continue;                       // read-only previews, never history
    const created = Date.parse(r.createdAt || "") || 0;
    const resolved = Date.parse(r.resolvedAt || "") || 0;
    const inRange = (t) => t >= range.fromMs && t < range.toMs;
    if (!inRange(created) && !inRange(resolved)) continue;
    const status = classifyRequest(r);
    // THE ROW IS DATED BY THE EVENT THAT FELL IN THE RANGE, not simply by its
    // outcome. A request raised yesterday and picked this morning is real work
    // on both days — but under "yesterday" it must read 20:50 yesterday (when it
    // was raised), not 12:31 today. Dating every row by its outcome put
    // tomorrow's timestamps at the top of yesterday's list.
    const outcome = eventMsOf(r);
    const ts = inRange(outcome) ? outcome : created;
    out.push({
      key: `rr:${r.id}`,
      kind: "refill",
      refillId: r.id,
      ts,
      raisedMs: created,
      resolvedMs: resolved || null,
      productId: r.productId,
      size: String(r.size ?? ""),
      qty: Number(r.qty) || 1,
      // Where it came FROM. createdFrom.source is stamped at creation on every
      // one of the 11,780 live rows, so this is never a guess.
      source: r.createdFrom?.source || null,
      dest: r.requestingLocation,
      status,
      // WHO. resolvedBy is the uid (stamped since 2026-08-07); rejectedBy is the
      // older role-only field, kept as a fallback so the 440 rows that predate
      // the uid still say something true rather than nothing.
      actorUid: typeof r.resolvedBy === "string" && r.resolvedBy.length > 20 ? r.resolvedBy : null,
      actorRole: r.rejectedBy || (r.createdFrom?.engine ? "engine" : null),
      reason: r.cancelReason || null,
      auto: !!r.createdFrom?.engine,
      via: r.createdFrom?.via || null,
      uncounted: !!r.fulfilledBy?.uncounted,
    });
  }
  return out;
}

// ─── ROWS FROM /stock_movements ──────────────────────────────────────────────
// Which movements are "refill activity at a hub"? Three families, identified by
// the id prefix and reason their writers actually use — not by guessing from the
// type, which is `transfer_out` for nearly everything.
//
//   rrf_<refillId>   Hub2RefillQueue.commit — a refill request being picked.
//   dispreg_<hub>_…  HubCleanup display registration — a display becoming hub
//                    stock. (PR #324: "displays ARE hub stock".)
//   disp_<order>_…   a display/partner order dispatched OUT of a hub.
//
// The `disp_` family is the one the request node cannot see at all, which is
// exactly why the movement half of this view exists.
export const REFILL_MOVEMENT_KINDS = [
  { kind: "refill", test: (id) => id.startsWith("rrf_") },
  { kind: "display_in", test: (id) => id.startsWith("dispreg_") },
  { kind: "display_out", test: (id) => id.startsWith("disp_") },
];

export function movementKind(m) {
  const id = String(m?.id || "");
  for (const k of REFILL_MOVEMENT_KINDS) if (k.test(id)) return k.kind;
  // Reason-tagged refills that carry a push-id instead of a prefixed one (the
  // uncounted-send path writes reason, not a special id).
  const reason = String(m?.reason || "");
  if (/_auto_refill$|_refill_uncounted$/.test(reason)) return "refill";
  return null;
}

/**
 * Movement rows touching the selected hubs inside the range.
 *
 * A movement is included when EITHER end of it is a selected hub, because both
 * directions are refill activity: stock arriving at Hub 1 and a display leaving
 * Hub 1 are both things that happened to Hub 1's stock. `dest`/`source` are
 * taken straight from the ledger's to/from, so "which location supplied this" is
 * answered by the record rather than inferred.
 */
export function movementRows(movements = [], range, hubs = []) {
  const want = new Set(hubs);
  const out = [];
  for (const m of movements) {
    if (!m) continue;
    const kind = movementKind(m);
    if (!kind) continue;
    if (!want.has(m.to) && !want.has(m.from)) continue;
    const ts = Date.parse(m.ts || m.appliedAt || "") || 0;
    if (ts < range.fromMs || ts >= range.toMs) continue;
    out.push({
      key: `mv:${m.id}`,
      kind,
      movementId: m.id,
      refillId: m.link?.refillId || null,
      ts,
      raisedMs: null,
      resolvedMs: ts,
      productId: m.productId,
      size: String(m.size ?? ""),
      qty: Number(m.qty) || 0,
      source: m.from || null,
      dest: m.to || null,
      status: "fulfilled",
      actorUid: m.actor || null,
      actorRole: null,
      reason: m.reason || null,
      auto: false,
      via: null,
      uncounted: m.type === "received" && /_refill_uncounted$/.test(String(m.reason || "")),
    });
  }
  return out;
}

/**
 * One event, one row. A fulfilled request and the `rrf_` movement that fulfilled
 * it are the same act recorded twice; showing both would double every refilled
 * line in the totals.
 *
 * The REQUEST row wins the merge and absorbs the movement's facts, because the
 * request knows things the ledger does not — who asked, when, whether it was
 * short — while the ledger only adds the true source location and the actor.
 */
export function mergeRows(reqRows = [], mvRows = []) {
  // Clone before absorbing: the caller's rows are memoised upstream, and a pure
  // function that quietly rewrites its own inputs would make a re-render with
  // the same data produce different output the second time.
  const out = reqRows.map((r) => ({ ...r }));
  const byRefill = new Map();
  for (const r of out) if (r.refillId) byRefill.set(r.refillId, r);
  for (const m of mvRows) {
    const twin = m.refillId ? byRefill.get(m.refillId) : null;
    if (twin) {
      // The ledger is the authority on WHERE the units physically came from and
      // WHO moved them; keep the request's own fields when the ledger is silent.
      twin.source = m.source || twin.source;
      twin.actorUid = twin.actorUid || m.actorUid;
      twin.movementId = m.movementId;
      twin.movedQty = m.qty;
      continue;
    }
    out.push(m);
  }
  return out.sort((a, b) => b.ts - a.ts || String(a.key).localeCompare(String(b.key)));
}

/** Per-status counts and unit totals for the selected range. */
export function totalsFor(rows = []) {
  const out = {};
  for (const s of [...STATUSES, "display_in", "display_out"]) out[s] = { rows: 0, units: 0 };
  for (const r of rows) {
    const bucket = r.kind === "display_in" || r.kind === "display_out" ? r.kind : r.status;
    if (!out[bucket]) out[bucket] = { rows: 0, units: 0 };
    out[bucket].rows += 1;
    out[bucket].units += Number(r.movedQty ?? r.qty) || 0;
  }
  return out;
}

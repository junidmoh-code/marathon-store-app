// ─── DISPLAY ROW CLOSE — the decisions, pure ─────────────────────────────────
//
// (Owner spec clause 3, 2026-09-08.) Everything the sale trigger decides lives
// here, with no admin SDK and no firebase-functions import, so `node --test`
// can drive it directly. The trigger itself (closeDisplayRowOnSale.js) is the
// plumbing around these answers.
//
// ── WHY THE TRIGGER IS ON /stock_movements AND NOT ON THE POS ────────────────
// marathon-pos-app must not change. It already writes ONE `sold` movement per
// (sale, product, size) cell with `from` = the selling shop — proven for the
// Display Checks work (docs/display-checks-sale-source.md) and the same source
// onClothingSale has fired off since it shipped. So the close fires from ANY
// till, on any device, with no POS deploy and no POS awareness that this exists.
//
// ── WHAT COUNTS AS A CLOSE ───────────────────────────────────────────────────
//   SOLD      a `sold` movement at a display store, matching an open row's
//             product AND the row's CAPTURED SIZE. The size match is what stops
//             an ordinary shelf sale of size 8 closing the display record for
//             the size 10 standing on the wall.
// A shop→hub transfer is NOT a display return — a display stays booked at its
// hub and is therefore not in the shop's cell, so a transfer out of a shop is
// ordinary shop stock. See the trigger header. Anything else is ignored.
//
// ── SIZE MATCHING IS ON THE KEY, NOT THE LABEL ───────────────────────────────
// A movement carries a human size ("9.5"); a row carries both `size` and
// `sizeKey`. They are compared as KEYS, through the same encoder the app uses,
// because "9.5" and "9,5" and " 9.5 " are the same shelf and three different
// strings. The encoder is duplicated from src/utils/sizeKey.js the way
// displayChecks/lib.cjs duplicates it — functions/ cannot import from src/ —
// and the two copies are differential-tested over a shared corpus by
// src/components/stock/displayRowFuzz.test.js (it can require() this file;
// nothing under functions/ can import from src/, so the test has to live on
// that side). A drift is a red test, not a silent mismatch.
//
// ── ONE SALE MUST NOT CLOSE TWO PAIRS ────────────────────────────────────────
// A movement of qty 1 closes AT MOST ONE row. When a wall has duplicates (the
// state the Duplicate Displays tab exists for), the OLDEST matching open row
// goes first — it is the one that has been claimed longest and is likeliest to
// be the stale record. `qty` may close more, bounded by the matching rows.
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
// Gen-2 RTDB triggers are at-least-once. A lease at
// /settings/displayRows_meta/{store}/processed/{movementId} is claimed before
// any write and marked done after; a replay of the same movement finds the
// lease and returns without touching a row. A STALE lease (a crashed execution)
// is stealable after LEASE_MS so a crash retries instead of wedging.
//
// The lease alone is not the whole guarantee, and the second half matters more:
// the close is EXPRESSED AS FIELD WRITES ON A NAMED ROW, and closing an already
// closed row is a no-op by construction — `decideCloses` only ever returns rows
// whose status is "open". So even a lease that is lost cannot double-close: the
// second run sees no open row to close. Belt and braces, in that order.

"use strict";

/** The stores whose walls this trigger watches. Hub 1 and Hub 2 serve these two;
 *  Pine's displays are booked at hub3 and are out of scope by owner constraint
 *  (GATED_SNEAKER_HUBS). A store not in this list returns immediately, which is
 *  also what makes the trigger cheap on every unrelated stock movement. */
const DISPLAY_STORES = ["marathon-pe", "trophy"];

/** The hubs a display may be booked at. */
const DISPLAY_HUBS = ["hub1", "hub2"];

const LEASE_MS = 5 * 60 * 1000;

/**
 * HOW OLD A SALE MAY BE AND STILL BE ATTRIBUTED FROM THE HUB CELL.
 *
 * The hub inference reads the cell NOW and reasons about an event that happened
 * THEN. The gap between them is not bounded by anything in Cloud Functions: a
 * cold start, a redelivery, a 60-second timeout and retry, or the mini's
 * offline queue draining can all put minutes between the sale and this read.
 *
 * Minutes are enough to break the premise, and the break is silent:
 *
 *   hub1 size 9 holds two — one on the shelf, one booked as Trophy's display.
 *   10:00  the SHELF pair sells. Cell → 1. This trigger is delayed.
 *   10:04  a counter adjusts the cell, or an operator transfers the remaining
 *          unit to hub2. Cell → 0.
 *   10:05  the trigger finally reads: 0, one open row. It closes Trophy's row.
 *
 * Trophy's pair is still on the wall, and the record now says nothing is out
 * there — which is the failure that ends in a counter posting a negative
 * adjustment against a unit that exists. (Independent second-brain review; the
 * earlier claim that "the race only ever makes the cell look FULLER" covered
 * only the movement's own apply and was wrong about every later decrement.)
 *
 * Two minutes is chosen to cover an ordinary cold start and one redelivery
 * while leaving no room for a human to touch the cell in between. A sale older
 * than this is REFUSED and logged — a missed close, which the wall walk and the
 * duplicate tab both surface, and never a wrong one.
 */
const HUB_INFERENCE_MAX_AGE_MS = 2 * 60 * 1000;

// Size → the /stock cell key. Byte-identical to encodeSizeKey/stockSizeKey in
// src/utils/sizeKey.js, INCLUDING the "Free Size" fold and the whitespace class
// in the character set. A first cut of this file trimmed and used a narrower
// character class; it agreed on every size anybody types and disagreed on " 8"
// and "Free Size", which is precisely the kind of near-miss a differential test
// exists to catch. src/components/stock/displayRowFuzz.test.js runs both copies
// over a shared corpus — from that side, because functions/ cannot import src/.
const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;

function encodeSizeKey(size) {
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
}

function stockSizeKey(size) {
  if (size == null || size === "" || size === "Free Size") return "_";
  return encodeSizeKey(size);
}

/**
 * Is this movement one that can close a display row, and at which store?
 * → { kind: "sold" | "sold_hub", store|hub, productId, sizeKey, qty } | null
 */
function classifyMovement(m) {
  if (!m || typeof m !== "object") return null;
  if (!m.productId) return null;
  const sizeKey = stockSizeKey(m.size);
  // "_" is the one-size sentinel and can never be a display row. A key of
  // NOTHING BUT underscores is the same statement in a longer form — it is what
  // the shared encoder makes of a whitespace-only size ("   " → "___"), and it
  // carries no size at all. The encoder is deliberately left byte-identical to
  // the app's (a differential test pins that), so the refusal lives here rather
  // than in a private variant of the encoder. Found by the test below.
  if (/^_+$/.test(sizeKey)) return null;
  const qty = Math.max(1, Number(m.qty) || 1);

  if (m.type === "sold" && DISPLAY_STORES.includes(m.from)) {
    return { kind: "sold", store: m.from, productId: m.productId, sizeKey, qty };
  }
  // ── A SALE THAT CAME OUT OF A HUB CELL ─────────────────────────────────────
  // Sneakers sell from the HUB, not from the shop. Measured over the newest
  // 6,000 stock movements on 2026-09-08:
  //
  //     marathon-pe / sized 1539    hub1 / sized 761
  //     trophy      / sized  267    hub2 / sized 478
  //     (hub3 / sized 273 — Pine, out of scope)
  //
  // So the shop-sourced branch above catches 1,806 of the 3,045 in-scope sized
  // sales and MISSES 1,239 of them. A trigger that only watched `from` = a shop
  // would leave two in five display sales standing on the record forever, which
  // is the residual this whole function exists to close.
  //
  // But a hub-sourced movement carries NO STORE. Its fields are exactly
  // { actor, appliedAt, from, link:{saleId}, productId, qty, size, ts, type },
  // `/sales/{saleId}` is empty for these ids, and `actor` cannot separate PE
  // from Trophy (the manager account that rings both carries
  // posAccess.storeIds ["central"]). All verified against live data — none of
  // it is inferred from the code.
  //
  // So it is returned as its own kind and the trigger must EARN the close from
  // evidence. See resolveHubSale below for the two conditions, and for why a
  // bare hub sale must never close anything.
  if (m.type === "sold" && DISPLAY_HUBS.includes(m.from)) {
    return { kind: "sold_hub", hub: m.from, store: null, productId: m.productId, sizeKey, qty };
  }
  // A shop→hub transfer is DELIBERATELY NOT a display return. A display unit
  // stays booked at its hub and is therefore not in the shop's cell at all, so
  // a transfer_out FROM a shop moves ordinary shop stock and can never be the
  // display pair. Closing a row on one would take a real display off the record
  // every time a shop sends excess back. See the trigger's header.
  // (CodeRabbit found the movement was generic; the booking model makes it
  // impossible rather than merely ambiguous.)
  return null;
}

/** Positive test for an open row, matching src/components/stock/displayRowCore.js.
 *
 *  "_" is the one-size sentinel; a key of NOTHING BUT underscores says the same
 *  thing in a longer form (the shared encoder turns "   " into "___" and ".."
 *  into "__"). classifyMovement already refuses those, so a row carrying one
 *  could never be closed by a sale — it would sit open forever asserting a
 *  display no till can ever retire. The two predicates now refuse the same set.
 *  (Senior-architect review.) */
function rowIsOpen(row) {
  return !!row && row.status === "open" && typeof row.sizeKey === "string"
    && row.sizeKey.length > 0 && !/^_+$/.test(row.sizeKey);
}

/**
 * Which rows this movement closes.
 *
 * @param byRow  /settings/displayRows/{store}/{productId} → { rowId: row }
 * @param sizeKey the movement's size, as a key
 * @param qty     how many units moved
 * → [{ rowId, row }] — oldest first, at most `qty` of them, possibly empty.
 */
function decideCloses(byRow, sizeKey, qty, movementTs = null) {
  const open = Object.entries(byRow || {})
    .map(([rowId, row]) => ({ rowId, row }))
    // `movementTs` excludes rows opened AFTER the sale — see rowPredatesSale.
    // Omitted, nothing is excluded, which is what the hub path wants (it does
    // its own age split in splitByHub so it can COUNT what it excludes).
    .filter(({ row }) => rowIsOpen(row) && row.sizeKey === sizeKey && rowPredatesSale(row, movementTs));
  open.sort((a, b) =>
    String(a.row.openedAt || "").localeCompare(String(b.row.openedAt || "")) || a.rowId.localeCompare(b.rowId));
  return open.slice(0, Math.max(0, Number(qty) || 0));
}

/**
 * THE CLAIM — the transaction body that closes ONE row, or refuses.
 *
 * The lease dedupes REPLAYS OF ONE MOVEMENT. It does nothing about TWO
 * MOVEMENTS: two tills selling the same shoe in the same size at the same shop
 * within a second of each other get two movement ids, two leases, and — with a
 * plain read-then-update — two executions that both read "2 open rows", both
 * pick the oldest, and both close THE SAME ONE. The second real sale then
 * closes nothing, and a row stays open asserting a display that has gone.
 * (Senior-architect review; the fuzz could not have found it, being a
 * sequential walk.)
 *
 * So the close is a CAS on the row itself: it commits only if the row is still
 * open at the instant the transaction runs. The loser aborts and the caller
 * moves to the next candidate, which is exactly the right answer — there WAS
 * another pair on that wall, and it is the one that just sold.
 */
function claimClose(cur, { at, reason, via, movementId, inferred = null }) {
  if (!rowIsOpen(cur)) return undefined;                 // someone else took it
  const eventId = `closed_${String(at).replace(/[.#$/[\]\s:]/g, "-")}`;
  return {
    ...cur,
    status: "closed",
    closedAt: at,
    closedBy: `system:${via}`,
    closedReason: reason,
    closedVia: via,
    closedRef: movementId || null,
    events: { ...(cur.events || {}), [eventId]: {
      at, what: "closed", by: `system:${via}`,
      detail: { reason, movementId: movementId || null, ...(inferred ? { inferred } : {}) },
    } },
  };
}

/** The field writes for ONE close, relative to the row's own path. Mirrors the
 *  client's closeFields — the same shape, so a row closed by the till and one
 *  closed by an operator are indistinguishable to every reader.
 *
 *  Kept and exercised because it IS the shape claimClose writes; the trigger
 *  itself now goes through claimClose, which is the same fields under a CAS. */
function closeUpdates(basePath, { at, reason, via, movementId }) {
  const eventId = `closed_${String(at).replace(/[.#$/[\]\s:]/g, "-")}`;
  return {
    [`${basePath}/status`]: "closed",
    [`${basePath}/closedAt`]: at,
    [`${basePath}/closedBy`]: `system:${via}`,
    [`${basePath}/closedReason`]: reason,
    [`${basePath}/closedVia`]: via,
    [`${basePath}/closedRef`]: movementId || null,
    [`${basePath}/events/${eventId}`]: {
      at, what: "closed", by: `system:${via}`,
      detail: { reason, movementId: movementId || null },
    },
  };
}

/**
 * A HUB-SOURCED SALE — which row, if any, it may close.
 *
 * A bare hub sale must never close a display record. Hub 1 holding four pairs
 * of size 9 and one of them on Trophy's wall: an ordinary shelf sale of size 9
 * is not the display, and closing Trophy's row on it would take a real display
 * off the record and hand the next counter a discrepancy that is not real.
 *
 * The close is only ever taken when the sale COULD NOT HAVE BEEN ANYTHING ELSE.
 * Two conditions, both required:
 *
 *   1. EXACTLY ONE open row for this product at this size is booked at this
 *      hub, across every display store. Two walls each claiming a size 9 makes
 *      one sale ambiguous, and an ambiguous close is a guess.
 *   2. THE HUB CELL IS NOW EMPTY. A display unit stays BOOKED at its hub (PR
 *      #324, "displays are hub stock" — displaySlots.js's own header). So if
 *      the cell for that product and size is at zero and a row still claims a
 *      unit of it is standing on a wall, the unit that just sold IS that unit.
 *      There is nothing else it could have been.
 *
 * Cell qty is read AFTER the movement, and the read can race the write that
 * applies it. That race only ever makes the cell look FULLER than it is, so the
 * failure mode is a missed close, never a wrong one — the safe direction, and
 * the wall walk and the duplicate tab both surface what is missed.
 *
 * @param openRowsByStore  { store: [{ rowId, row }] } — open rows for this
 *                         product at this sizeKey, already filtered to rows
 *                         booked at this hub.
 * @param cellQty          /stock/{hub}/{productId}/{sizeKey}/qty, read now.
 * → { store, rowId } | null, with `why` when it refuses.
 */
/**
 * THE STALENESS BOUND, on its own so the trigger can check it BEFORE spending
 * any reads. See HUB_INFERENCE_MAX_AGE_MS for why it exists.
 *
 * A movement with no readable instant is refused: "we cannot tell how old this
 * is" is not "it is fresh". A STRING, and only a string — `Date.parse(12345)`
 * coerces to "12345" and parses it as the YEAR 12345, so a movement carrying
 * epoch millis instead of an ISO instant would have read as fresh by three
 * hundred centuries. (Found by a test that passed a number in.) A future-dated
 * sale is refused too: a wrong clock is not evidence.
 *
 * → null when it is fresh enough; the refusal reason otherwise.
 */
function hubSaleTooOld(movementTs, nowMs) {
  const ts = typeof movementTs === "string" ? Date.parse(movementTs) : NaN;
  if (!Number.isFinite(ts)) return "the sale carries no readable instant, so its age cannot be judged";
  const age = Number(nowMs) - ts;
  if (!(age >= 0 && age <= HUB_INFERENCE_MAX_AGE_MS)) {
    return `the sale is ${Math.round(age / 1000)}s old — too long to attribute it from the hub's stock now`;
  }
  return null;
}

function resolveHubSale({ openRowsByStore, cellQty, movementTs, nowMs,
                          hublessCount = 0, postSaleCount = 0, unknownAgeCount = 0 }) {
  const tooOld = hubSaleTooOld(movementTs, nowMs);
  if (tooOld) return { ok: false, why: tooOld };

  const candidates = [];
  for (const [store, rows] of Object.entries(openRowsByStore || {})) {
    for (const r of rows || []) candidates.push({ store, rowId: r.rowId });
  }
  // THE BLOCKER CHECK COMES FIRST, and the order is the whole point. The caller
  // may count MORE explanations than it offers as closable — a row with no
  // bookedHub is an equally good reason for the empty cell but must never be
  // the row that gets closed. When the ONLY explanation is a hubless row,
  // `candidates` is empty AND blockers is not, and returning "no open row at
  // this hub" first recorded a refusal reason that was simply false — which
  // defeats the point of recording it. (Adversarial review of the fix round.)
  // The caller reports each blocker kind separately so the refusal names the one
  // it actually hit. There is no longer a single opaque "ambiguityCount": it
  // was dead in production and, if a caller had passed it alongside these, the
  // sentence could have enumerated a different number than the total it used.
  const hublessN = Number(hublessCount) || 0;
  const postSaleN = Number(postSaleCount) || 0;
  const unknownN = Number(unknownAgeCount) || 0;
  if (hublessN || postSaleN || unknownN) {
    const why = [];
    if (postSaleN) why.push(`${postSaleN} display record${postSaleN === 1 ? " was" : "s were"} registered after this sale`);
    if (unknownN) why.push(`${unknownN} display record${unknownN === 1 ? " does" : "s do"} not say when it was registered`);
    if (hublessN) why.push(`${hublessN} display record${hublessN === 1 ? " names" : "s name"} no hub`);
    return { ok: false, why: `${why.join(", ")}, so which one sold is not knowable` };
  }
  if (candidates.length === 0) return { ok: false, why: "no open row at this hub for this size" };
  if (candidates.length > 1) {
    // Two rows on ONE wall land here too, so a duplicated wall's sales never
    // close automatically — the residual persists exactly where it is already
    // worst. That is the correct trade (a guess there would close a row a human
    // is about to judge) and it is why the Duplicate Displays tab exists, but it
    // is stated rather than left to be discovered.
    return { ok: false, why: `${candidates.length} display records claim this size — which one sold is not knowable` };
  }
  // An ABSENT cell is zero stock, not an unknown: RTDB has no node for a cell
  // that holds nothing, and the Admin SDK throws on a failed read rather than
  // returning null, so `null` here really does mean "the hub has none". Anything
  // else that is not a finite number IS unknown, and unknown is a refusal —
  // reading a garbage value as zero would close a real display.
  // `Number(x)` is far too generous to lean on here: Number([]) and Number("")
  // are both 0, so a garbage value would read as an empty shelf and close a
  // real display. Only an actual number counts, and only null/undefined means
  // "no cell". (Found by the test below, which passed [] in.)
  const q = cellQty == null ? 0 : (typeof cellQty === "number" ? cellQty : NaN);
  if (!Number.isFinite(q)) {
    return { ok: false, why: "the hub's stock for this size could not be read, so the sale cannot be attributed" };
  }
  // EXACTLY ZERO, not "zero or less". A negative cell means the books are
  // already wrong about that shelf — it is not evidence that the unit which
  // sold was the display, and treating it as such closes the only matching row
  // and moves the slot mirror on the strength of a number nobody trusts.
  // (CodeRabbit.)
  if (q !== 0) {
    return { ok: false, why: q > 0
      ? `the hub still holds ${q} of this size, so the sale need not have been the display`
      : `the hub's count for this size is ${q}, which is not a shelf state anything can be concluded from` };
  }
  return { ok: true, ...candidates[0] };
}

/**
 * SPLIT ONE STORE'S OPEN ROWS INTO THE ONES A HUB SALE MAY CLOSE AND THE ONES
 * THAT MERELY BLOCK IT.
 *
 * This lived inline in the trigger, where nothing could test it — the test that
 * "covered" the rule hand-fed resolveHubSale a number and proved only that the
 * helper honours one, never that the caller computes it. (Adversarial review of
 * the fix round.)
 *
 *   CLOSABLE   booked at this hub, and already open when the sale happened.
 *   HUBLESS    no bookedHub at all. An equally good explanation for the empty
 *              cell, so it makes the attribution unknowable — but it never
 *              claimed to be at this hub, so it is never the row closed.
 *   POST-SALE  opened AFTER the sale. It cannot be the pair that sold, and its
 *              presence still muddies the question.
 *   UNKNOWN    no readable openedAt. It might predate the sale or not; it
 *              blocks for the same reason, but it is NOT "registered after the
 *              sale" and must not be reported as though it were.
 *   IGNORED    booked at ANOTHER hub. It explains nothing about THIS hub's
 *              cell, so it neither closes nor blocks.
 *
 * HUB IS TESTED BEFORE AGE, and the order is load-bearing. Testing age first
 * put a row booked at hub2 into the blocker set whenever it happened to
 * postdate a hub1 sale — so a hub1 sale with an empty hub1 cell and exactly one
 * hub1 row was refused because of a row on another hub's books, and told to
 * blame it. This docstring already said other-hub rows neither close nor block;
 * the code did not agree with it. (Adversarial review.)
 */
function splitByHub(openRows, hub, movementTs = null) {
  const closable = [], hubless = [], postSale = [], unknownAge = [];
  for (const entry of openRows || []) {
    const row = (entry && entry.row) || {};
    const h = row.bookedHub;
    if (h && h !== hub) continue;                        // another hub's books — irrelevant here
    const age = rowAgeVsSale(row, movementTs);
    if (age === "after") { postSale.push(entry); continue; }
    if (age === "unknown") { unknownAge.push(entry); continue; }
    if (h === hub) closable.push(entry);
    else hubless.push(entry);
  }
  // THREE KINDS OF BLOCKER, REPORTED APART. Collapsing them is how a refusal
  // ends up stating something false — first a post-sale row reported as "names
  // no hub", then an unknown-age row reported as "registered after this sale".
  // `blockers` stays as the total, for callers that only need a count.
  return { closable, hubless, postSale, unknownAge,
           blockers: [...hubless, ...postSale, ...unknownAge] };
}

/**
 * Where this row sits relative to the sale: "before" | "after" | "unknown".
 *
 * "unknown" is its own answer, not a synonym for "after". A row whose openedAt
 * was lost (a hand-fixed record, a partial write, an older shape) predates
 * every sale in reality — it just cannot prove it. It must still block, because
 * it might be the pair that sold; it must NOT be described as "registered after
 * this sale", because that is a claim about it that is false and it goes into
 * the lease as the permanent answer to "why did this not close?".
 * (Adversarial review.)
 *
 * `null` movementTs means the caller is applying no ordering constraint.
 */
function rowAgeVsSale(row, movementTs) {
  if (movementTs == null) return "before";
  const sale = typeof movementTs === "string" ? Date.parse(movementTs) : NaN;
  if (!Number.isFinite(sale)) return "unknown";
  const opened = typeof (row && row.openedAt) === "string" ? Date.parse(row.openedAt) : NaN;
  if (!Number.isFinite(opened)) return "unknown";
  return opened <= sale ? "before" : "after";
}

/** The boolean the row selectors want: may this row be closed by that sale? */
function rowPredatesSale(row, movementTs) {
  return rowAgeVsSale(row, movementTs) === "before";
}

/**
 * WHY THE AGE FILTER EXCLUDED EVERY CANDIDATE — in words that are TRUE.
 *
 * The shop-sourced path had one sentence for two different facts. It asked
 * "did the age filter remove rows the size filter had kept?" and, if so, said
 * "registered after this sale". But `rowPredatesSale` collapses "after" and
 * "unknown" into the same `false`, so a row whose `openedAt` is missing or
 * unparseable — a hand-fixed record, a partial write, an older shape — was
 * reported as having been registered after a sale it may well predate. That
 * sentence is written into the lease as the PERMANENT answer to "why did this
 * display record not close?", so a false one is worse than a vague one.
 *
 * This is the distinction the hub path already draws (splitByHub reports
 * postSale and unknownAge apart, for exactly this reason). The shop path never
 * got it. Same defect, second location. (Senior-architect review.)
 *
 * A third cause is answered here too — when the SALE carries no readable
 * instant, `rowAgeVsSale` answers "unknown" for every row, so every candidate
 * is excluded and nothing about the ROWS is wrong at all.
 *
 * THAT THIRD BRANCH IS UNREACHABLE FROM THE TRIGGER, and the round that added
 * it claimed otherwise. closeDisplayRowOnSale.js refuses an unreadable `m.ts`
 * outright, before either path runs, with its own message — a gate a previous
 * round already added. So the branch here is defence for a caller that does not
 * exist yet rather than a cause this function newly names. It is kept because
 * this module is pure and unit-driven and a future caller may not have that
 * gate, and it is described accurately so nobody reads it as live coverage.
 * (Adversarial review of the fix round.)
 *
 * → the sentence, or null when the age filter is not what emptied the list.
 */
function ageRefusalReason(byRow, sizeKey, movementTs) {
  const saleMs = typeof movementTs === "string" ? Date.parse(movementTs) : NaN;
  if (movementTs != null && !Number.isFinite(saleMs)) {
    return "this sale carries no readable instant, so no display record could be ordered against it";
  }
  let after = 0, unknown = 0;
  for (const row of Object.values(byRow || {})) {
    if (!rowIsOpen(row) || row.sizeKey !== sizeKey) continue;
    const age = rowAgeVsSale(row, movementTs);
    if (age === "after") after++;
    else if (age === "unknown") unknown++;
  }
  if (after && unknown) {
    return "the display records for this size were either registered after this sale or cannot be dated against it, so neither can be shown to be what sold";
  }
  if (after) {
    return after === 1
      ? "the display record for this size was registered after this sale, so it cannot be what sold"
      : "the display records for this size were all registered after this sale, so none can be what sold";
  }
  if (unknown) {
    return unknown === 1
      ? "the display record for this size carries no readable registration time, so it cannot be shown to be what sold"
      : "the display records for this size carry no readable registration time, so none can be shown to be what sold";
  }
  return null;
}

/**
 * The lease decision — returns the record to write, or undefined to ABORT the
 * transaction (already done, or somebody else holds a fresh lease).
 * Same shape as displayChecks/lib.cjs processedClaimDecision, deliberately.
 */
function leaseDecision({ cur, nowMs }) {
  if (cur && cur.done === true) return undefined;                        // already processed
  if (cur && Number(cur.at) && nowMs - Number(cur.at) < LEASE_MS) return undefined;  // fresh lease held
  return { at: nowMs, done: false };
}

module.exports = {
  DISPLAY_STORES, DISPLAY_HUBS, LEASE_MS, HUB_INFERENCE_MAX_AGE_MS,
  encodeSizeKey, stockSizeKey, classifyMovement, rowIsOpen, decideCloses, closeUpdates, claimClose, resolveHubSale, hubSaleTooOld, splitByHub, rowPredatesSale, rowAgeVsSale, ageRefusalReason, leaseDecision,
};

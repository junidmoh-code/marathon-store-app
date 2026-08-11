// ─── HEADWEAR ONE-SIZE COLLAPSE — CORE (pure logic, io-injected) ──────────────
//
// Beanies AND caps are quantities, not sizes. This module is the shared brain of
// the census, the pre-flight probe, the migration and the rollback, so none of
// them can drift from the others on what is in scope or what a collapse does.
//
// ── CAPS ARE NOT BEANIES (2026-08-10) ────────────────────────────────────────
// The beanie half of this work (PRs #343/#344) could take two shortcuts that the
// cap half cannot:
//   • every beanie held stock in at most ONE size, so "merge the quantities"
//     never actually merged anything. 47 caps hold stock across two or more
//     sizes at once, and one holds a negative and a positive at the SAME
//     location, so the paired-movement path now has real arithmetic to get right.
//   • every beanie had exactly ONE barcode, so "which code keeps the '_' slot"
//     answered itself. 87 caps carry two or more, so the keep-code rule is a
//     decision with consequences for labels already on physical stock.
// Read planStep2's keep-code rule and legIds' per-size id scheme with that in
// mind; both were written for the beanie case and both changed here.
//
// ── BUCKET HATS JOINED THE SCOPE (2026-08-11) ────────────────────────────────
// #345 excluded them from the same shelf as visors. That was right for visors
// and wrong for bucket hats: they are the same kind of thing as the rest, and
// they are now in scope as their own kind. The full argument — including why
// they are the only kind needing BOTH the shelf and the name, and why they were
// not simply folded into "cap" — is at the scope rule below. NOTHING about the
// migration's mechanics changed; the widening is a scope edit and nothing else.
//
// The migration's decision-making, extracted from the CLI so the behaviour is
// testable against a fake RTDB. NOTHING in here touches firebase directly: every
// read/write goes through an injected `io` with two methods —
//
//   io.read(path)      → Promise<value|null>
//   io.update(updates) → Promise<void>   ONE atomic multi-path update from root
//
// The live CLI (scripts/collapse-one-size-headwear.mjs) binds these to the Admin
// SDK; the tests bind them to a fake that reproduces real RTDB semantics —
// including the one that invalidates naive fakes: RTDB DELETES a child whose
// written value is null, an empty object or an empty array.
//
// ── WHY MOVEMENTS ARE RE-IMPLEMENTED HERE (applyMovementAdmin) ───────────────
// All stock writes go through applyMovement — but the canonical implementation
// (src/components/stock/applyMovement.js) is a CLIENT module: it imports the
// client firebase handle and stamps auth.currentUser. A server-side migration
// cannot call it. applyMovementAdmin reproduces its CONTRACT, field for field:
//   • the movement and every touched cell land in ONE atomic multi-path update
//   • the movement id is the idempotency key — if it exists, no-op
//   • cell writes increment `v` by exactly 1 and change `mv`; new cells start
//     at v=0 (client: `typeof v === "number" ? v+1 : 0`)
//   • a negative-going adjustment may not overdraw the cell — refused unless
//     the caller opts in with allowNegative (same escape hatch the client has)
//   • before/after per-location audit snapshot derived from the SAME read that
//     computes the write
// The behavioural tests pin each of these points; drift between the two
// implementations fails a test, not a stock count.
//
// ── SIZE KEYS ────────────────────────────────────────────────────────────────
// Everything goes through the existing chokepoint (src/utils/sizeKey.js):
// stockCellPath builds every cell path, so a display label ("Free Size") can
// never reach a storage key — stockSizeKey folds it to the "_" sentinel, and
// assertSafeSegment throws on anything illegal before a write exists.
//
// ── MOVEMENT IDS ─────────────────────────────────────────────────────────────
// Deterministic per (product, location, size), so a re-run is a no-op:
//   positive stock   OUT  onesize_<pid>_<loc>_out_<sizeKey>     (sized cell → 0)
//                    IN   onesize_<pid>_<loc>_in_us_<sizeKey>   ("_" cell += n)
//   negative stock   OUT  onesize_<pid>_<loc>_out_us_<sizeKey>  ("_" cell -= n, allowNegative)
//                    IN   onesize_<pid>_<loc>_in_<sizeKey>      (sized cell → 0)
//
// The IN id carries the SOURCE size key. The spec's shape (one `_in_us` per
// location) collides when a product holds stock in TWO sizes at one location:
// the second pair's IN leg would hit the first's id, be skipped as idempotent,
// and silently lose that size's units. Per-size ids keep re-runs no-ops AND
// make the M+L merge correct — the mutation test "M 100 + L 100 → single _
// cell of 200" fails on the collided shape.
//
// ON BEANIES THIS WAS INSURANCE. ON CAPS IT FIRES. The beanie census found zero
// multi-size holders, so the collided shape would have passed unnoticed through
// the entire live run. 47 caps hold two or more sizes at one location — one
// holds four (marathon-pe L 2, M 1, S 2, XL 1) — so on the collided id shape
// three of that product's four sizes would have been silently dropped on the
// floor while every leg reported ok. The per-size id is the only reason the cap
// half of this migration is arithmetically correct.
//
// A NEGATIVE sized cell (census: Nike beanie green, marathon-pe S = −1, an
// oversell signal) cannot ride the normal pair — the OUT leg would overdraw.
// The MIRRORED pair moves the shortage instead of the stock: OUT from "_" with
// allowNegative (the honest-shortage escape hatch applyMovement documents),
// then IN to the sized cell to bring it to 0. Total unchanged; the −1 keeps
// telling the truth from the cell scans actually hit. OUT runs first so an
// interruption leaves the total conservatively LOW, never fabricated HIGH.

import { encodeSizeKey, stockSizeKey, stockCellPath, assertSafeSegment } from "../../src/utils/sizeKey.js";

const ACTOR = "system:headwear-onesize-collapse";
export const BATCH = "headwear-onesize-collapse";

// ── SCOPE — THE ONE PLACE THAT DECIDES WHAT IS IN ────────────────────────────
// In scope: beanies, caps and bucket hats. Nothing else, ever.
//
// The three are told apart by different evidence, and it is worth being exact
// about why, because the asymmetry looks arbitrary until you look at the data:
//
//   A BEANIE IS DECIDED BY ITS NAME. /beanie/i, wherever it is filed. The name
//   is unambiguous — no other product line uses the word — and a beanie
//   mis-filed outside Caps & Hats is still a beanie. (Live 2026-08-10: all 134
//   sit in Caps & Hats, so this admits nothing extra today; isUnexpectedSub-
//   category below still flags one if it ever appears.)
//
//   A CAP IS DECIDED BY ITS SHELF, MINUS AN EXCLUSION LIST. A name rule cannot
//   work here: 24 of the 167 live caps have no headwear word in the name at all
//   ("Armani exchange mustard", "New Era Atlanta Braves 59FIFTY fitted Black",
//   "Nike Dri-FIT Fly Maroon"). They are caps, they are on the cap shelf, and a
//   /cap/i rule would silently leave them sized while their siblings collapsed.
//   So the subcategory admits, and NOT_A_CAP removes the two things that share
//   that shelf without being caps.
//
//   A BUCKET HAT IS DECIDED BY ITS SHELF *AND* ITS NAME — BOTH. It is the only
//   kind that needs two pieces of evidence, and the reason is a constraint the
//   owner set rather than anything in the data: bucket hats are in scope, visors
//   are NOT, and nothing outside the Caps & Hats shelf may be pulled in by
//   widening. A name-only rule (the beanie treatment) would admit a bucket hat
//   filed anywhere in the catalogue and break that second promise. A shelf-only
//   rule (the cap treatment) cannot distinguish it from a cap at all. So it is
//   the intersection, which is strictly narrower than either — and a bucket hat
//   filed OFF the shelf stays out and is reported by isExcludedHeadwear, so it
//   cannot fall silently between the two lists.
//
// ── WHY BUCKET HATS ARE THEIR OWN KIND AND NOT SIMPLY CAPS (2026-08-11) ──────
// Deleting `bucket hats?` from NOT_A_CAP would have admitted them in one
// character-level edit, as kind "cap". It was rejected for one operational
// reason: a collapse is only free when the size run was never a real fit
// distinction. On beanies and caps it never was. SOME BRANDS GENUINELY SHIP
// BUCKET HATS IN S/M AND L/XL, which are two different physical fits, and
// merging those makes one quantity out of two things a customer cannot swap
// between — irreversibly, because the sized cells are gone afterwards.
//
// Live today that hazard does not fire (no bucket hat holds positive stock in
// more than one size key; 16 of 17 already declare ["_"]), so nothing is being
// guarded against right now. What the separate kind buys is that the cohort
// stays VISIBLE and separately runnable — the census counts them apart, the
// operator can run `--kind=bucket` on its own, and the day a two-fit bucket hat
// does arrive it is discussed as a bucket-hat question rather than disappearing
// into a count of caps. The scope decision the owner is asked to confirm should
// be the one they actually made.
//
// ── WHAT IS STILL EXCLUDED, AND WHY IT IS NOT AN OVERSIGHT ───────────────────
// VISORS — 7 of them, 6 on the shelf plus one mis-filed under "Clothing —
// Uncategorized" (Alo yoga airlift solar visor black). A visor is not headwear
// of this kind and the owner has not scoped it in; five of the seven carry live
// standard-policy target rows at hub2 and marathon-pe, so collapsing one would
// silently change what the refill engine is aiming at. They are reported by the
// census and left alone. isExcludedHeadwear names them so "excluded" is a stated
// decision with a list, not silence — and it matches on the NAME wherever the
// record is filed, not only on the shelf, because the mis-filed visor is
// precisely the record a reader would want to see accounted for and a
// shelf-only predicate made it vanish from both lists. (CodeRabbit, PR #345.)
//
// A mergedInto record is a redirect stub with no stock identity of its own
// (product-merge.cjs) and must never be collapsed in place.
//
// Exported and imported by the CLI, the census, the probe and the tests rather
// than restated in each, so a change to the rule cannot pass a test that still
// applies the old one.
export const HEADWEAR_SUBCATEGORY = "Caps & Hats";
const BEANIE_NAME = /beanie/i;
const VISOR_NAME = /\bvisors?\b/i;
const BUCKET_NAME = /\bbucket\s*hats?\b/i;
// Reporting only — never gates anything. Splits the admitted caps into "the
// name says cap" and "admitted because of where it is filed", so the census can
// print the second list for a human to eyeball before anything moves.
const CAP_NAME = /\bcaps?\b/i;

// The canonical kind list. Every caller that tallies by kind builds its counter
// from this rather than from a `{ beanie: 0, cap: 0 }` literal — such a literal
// yields `undefined++` → NaN the moment a kind is added, which is exactly what
// adding "bucket" would have done to four separate scripts' summary lines.
export const HEADWEAR_KINDS = ["beanie", "cap", "bucket"];
export const emptyKindCount = () => Object.fromEntries(HEADWEAR_KINDS.map((k) => [k, 0]));

// ── THE NAME PATTERNS ARE NEVER COPIED OUT OF THIS FILE ──────────────────────
// Reporting-only classifiers, exported so that no other script needs its own
// copy of these regexes. That matters more than it looks: this widening moved
// bucket hats from "rejected" to "admitted" by editing ONE pattern, and any
// second copy elsewhere would have kept quietly applying the old answer to
// whatever it decided. A test enforces the invariant directly — this module is
// the ONLY file under scripts/ that may contain a headwear name pattern.
// None of these three gates anything; headwearKind is the only scope decision.
export const isBeanieNamed = (product) => BEANIE_NAME.test(String(product?.name || ""));
export const isVisorNamed = (product) => VISOR_NAME.test(String(product?.name || ""));
export const isBucketHatNamed = (product) => BUCKET_NAME.test(String(product?.name || ""));

// Which heading an EXCLUDED record is printed under. Reporting only, and it
// lives here rather than in the report script for one reason: the tie between
// "visor" and "bucket hat" has to break the same way the scope rule breaks it,
// or the report contradicts the rule it exists to be compared against. Grouping
// on "matches one and not the other" put a dual match under "the name cannot
// classify this" — a false claim, about a record headwearKind reads perfectly
// well as a visor, while also dropping it from the visor count.
// "unclassifiable" is therefore reserved for its real meaning: a record the
// caller believes is excluded headwear whose name says neither word.
// (CodeRabbit, PR #346.)
export function excludedHeadwearGroup(product) {
  if (isVisorNamed(product)) return "visor";
  if (isBucketHatNamed(product)) return "bucket";
  return "unclassifiable";
}

export function headwearKind(product) {
  if (!product || product.mergedInto) return null;
  const name = String(product.name || "");
  // ── THE VISOR TEST RUNS FIRST, BEFORE EVERY ADMISSION ──────────────────────
  // Ahead of the bucket-hat test, and ahead of the BEANIE test too. A name
  // matching two of these words is pathological and there is none live today —
  // but the tie has to break somewhere, and "visor" is the one word the owner
  // explicitly did not authorise, so it wins every tie by refusing admission.
  //
  // Ahead of the beanie test specifically because the beanie rule is
  // shelf-independent: with the order reversed, a record named "…visor beanie…"
  // was admitted as a beanie ANYWHERE in the catalogue, and isExcludedHeadwear
  // then reported it as not-excluded (it is in scope), so it would have been
  // collapsed with nothing in either census list saying a visor word was
  // involved. First is the only position where this check cannot be bypassed.
  // (CodeRabbit, PR #346.)
  if (VISOR_NAME.test(name)) return null;
  if (BEANIE_NAME.test(name)) return "beanie";
  if (product.subcategory !== HEADWEAR_SUBCATEGORY) return null;
  if (BUCKET_NAME.test(name)) return "bucket";
  return "cap";
}

export function isInScope(product) {
  return headwearKind(product) !== null;
}

// Named as a visor or a bucket hat, and NOT admitted by the scope rule above.
// Reporting only — these are never in scope. Defined as the complement of
// isInScope rather than as its own independent name test, so the two can never
// drift into either overlapping (a record in both lists) or leaving a gap (a
// record in neither): widening the scope rule automatically shrinks this one.
//
// It therefore covers the 7 visors wherever they are filed, plus any bucket hat
// filed OFF the Caps & Hats shelf — which the scope rule declines on purpose,
// and which would otherwise be accounted for nowhere at all.
export function isExcludedHeadwear(product) {
  if (!product || product.mergedInto) return false;
  if (isInScope(product)) return false;
  return isVisorNamed(product) || isBucketHatNamed(product);
}

// Admitted as a cap by the shelf alone — the name carries no "cap"/"caps". These
// are the records whose scope decision rests entirely on the subcategory field,
// so they are the ones worth reading before a run. In scope; reported, not gated.
export function isCapByShelfOnly(product) {
  return headwearKind(product) === "cap" && !CAP_NAME.test(String(product.name || ""));
}

// A record whose NAME says beanie but whose filing does not. It stays in scope
// (the name is decisive) but it is worth a human's eye before its identity is
// rewritten, so the census flags it and exits non-zero. Lives here, next to the
// scope rule it qualifies, so it is testable rather than buried in a live-data
// script with no unit surface. (CodeRabbit, PR #343.)
export function isUnexpectedSubcategory(product) {
  return headwearKind(product) === "beanie" && product.subcategory !== HEADWEAR_SUBCATEGORY;
}

// ── WHAT COUNTS AS AN OPEN REFERENCE ─────────────────────────────────────────
// A product is gated only when some FUTURE action would still move stock in the
// size key this migration is about to retire. An order's base status alone does
// not say that:
//
//   • A "Shop Refill" (CR) line resolves via clothingRefillStatus, NOT status —
//     its base status stays "incoming" forever (App.jsx:17183; the engine's own
//     resolution test is `clothingRefillStatus != null`). The live census found
//     43 beanie CR lines at "incoming"; 37 were fulfilled weeks ago and can
//     never clear, so gating on status would block those products permanently
//     and gain nothing.
//   • What a RESOLVED CR line can still do is be UNDONE, and undo reverses real
//     stock keyed by the line's size (App.jsx:10232, reverseCRRefill). The undo
//     control exists only while the batch sits in the completed list, bounded by
//     RESOLVED_VISIBLE_MS = 24h (App.jsx:9468). Past that it is terminal in the
//     UI as well as in the ledger.
//   • An UNRESOLVED CR line is a live pick: Send fires the hub→shop transfer on
//     that size. Always blocks.
//   • A customer order in a live status still has its dispatch ahead of it.
// ── WHAT COUNTS AS A SIZE THIS MIGRATION IS ABOUT TO RETIRE ──────────────────
// This WAS an enumeration: /^(XS|S|M|L|XL|XXL|XXXL)$/. On beanies that was
// complete — the only sizes in play were S and M. On caps it is a FAIL-OPEN
// HOLE, and not a theoretical one. Live caps hold stock in "28", "55" and "62"
// and declare "4XL" and "55"…"63" (fitted caps are sized by head circumference
// in centimetres). Every one of those fails the old regex, so an open order, an
// unreceived transfer or a live refill request against a 59FIFTY in size 57
// read as "no real size — does not block" and the product would have been
// collapsed out from under it.
//
// The fix is to stop enumerating and ask the question the gate actually means:
// "would this reference still move stock in a cell that is about to stop
// existing?" Every cell key except the one-size sentinel is about to be retired,
// so a size blocks unless it already IS the sentinel — decided by the same
// stockSizeKey chokepoint that decides the cell key itself, so the gate and the
// storage can never disagree about what one-size means. "Free Size" (the
// synthetic display label) folds to "_" and correctly does NOT block; a genuine
// "M", "4XL" or "57" does.
//
// It errs toward blocking: an unrecognised size string is not proven safe, so
// it gates the product and gets reported. That is the same direction every
// other gate in this file takes.
export function isRetiredSize(size) {
  if (size == null || size === "") return false;         // no size named — nothing to retire
  return stockSizeKey(size) !== "_";
}

// A /stock or transfer-line KEY (already encoded) that this migration retires.
export function isRetiredSizeKey(sizeKey) {
  return typeof sizeKey === "string" && sizeKey !== "" && sizeKey !== "_";
}

// out_of_stock is a LIVE hold, not a terminal state — the customer is still
// owed the item and the order can be revived and dispatched on its size.
// (Kimi review, PR #343: it was missing, which is the fail-OPEN direction.)
export const LIVE_ORDER_STATUSES = new Set(["incoming", "ready", "coming_tomorrow", "on_hold", "out_of_stock"]);
export const CR_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export function orderBlocks(order, pid, nowMs) {
  if (!order) return null;
  // FAIL-SAFE ON AN UNRECOGNISED SHAPE. Every live order record carries a
  // top-level productId + size (verified across all 2,396 today), so the
  // structured read below is correct. But if a record ever nests its lines
  // instead, `order.productId !== pid` would quietly return "does not block"
  // and the gate would wave through a live order on a size about to be
  // retired. So: if the record MENTIONS this product but does not present the
  // shape this function understands, block it and say why. Being unable to
  // prove a thing is safe is not the same as it being safe.
  // (Kimi review, PR #343.)
  if (order.productId !== pid) {
    return JSON.stringify(order).includes(pid)
      ? `order ${order.id || ""} references this product in a shape this gate does not understand (no top-level productId) — clear it or check it by hand`
      : null;
  }
  if (!isRetiredSize(order.size)) return null;   // one-size / no size named — nothing to retire
  if (order.customerName === "Shop Refill") {
    if (order.clothingRefillStatus == null) return `unresolved refill line ${order.id || ""} (size ${order.size}) — Send would move stock in the retired size`;
    // An UNPARSEABLE resolution stamp must fail SAFE. `|| 0` treated a garbled
    // or missing timestamp as the epoch, i.e. "resolved long ago, undo window
    // closed, does not block" — the fail-OPEN direction on the one field that
    // decides whether an undo can still reverse stock on this size.
    // (CodeRabbit, PR #343.)
    const stamp = order.clothingRefilledAt || order.clothingOutOfStockAt || order.updatedAt || order.createdAt;
    const resolvedMs = Date.parse(stamp);
    if (!Number.isFinite(resolvedMs)) {
      return `refill line ${order.id || ""} has an unreadable resolution timestamp (${JSON.stringify(stamp)}) — cannot prove its undo window has closed`;
    }
    if (nowMs - resolvedMs < CR_UNDO_WINDOW_MS) {
      return `refill line ${order.id || ""} resolved ${new Date(resolvedMs).toISOString()} — inside the 24h undo window, and undo reverses stock in size ${order.size}`;
    }
    return null;
  }
  return LIVE_ORDER_STATUSES.has(order.status)
    ? `live customer order ${order.id || ""} (${order.status}, size ${order.size}) — dispatch would move stock in the retired size`
    : null;
}

// ── WHEN DID THIS PRODUCT LAST MOVE? ─────────────────────────────────────────
// Feeds the recent-activity gate. A movement whose timestamp cannot be read
// must NOT leave the product looking quiet — that is the fail-open direction on
// a gate whose entire job is to stop a race with a till. "I cannot tell when
// this last moved" is not "it has not moved", so unreadable stamps are counted
// separately and the caller blocks on them. (CodeRabbit, PR #343.)
// WINDOWED, and it must be. An unreadable stamp blocks its product, and over an
// UNBOUNDED ledger that block never expires: one piece of malformed debris from
// any point in a product's life would gate it forever, with no way to clear it —
// unlike the 24h undo window and the 15-minute activity window, which both
// self-clear. It fails safe, but a permanent unexplainable gate is its own trap.
// Reading only the recent slice keeps the gate answering the question it is
// actually asking ("is this product busy RIGHT NOW"), and the ids of the
// offending movements come back so the message can name them.
// (Sonnet re-review, PR #343.)
export function movementRecency(movements, { nowMs = Date.now(), windowDays = 45 } = {}) {
  const lastMs = new Map();
  const unreadable = new Map();
  const cutoff = nowMs - windowDays * 86400000;
  for (const [id, m] of Object.entries(movements || {})) {
    if (!m || !m.productId) continue;
    const raw = m.appliedAt || m.ts;
    const ts = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ts)) {
      // An unreadable stamp cannot be placed in time, so it cannot be excluded
      // by the window either — but the ledger key is push-ordered, so an id
      // below the window's key is old debris rather than live activity.
      // Without that discriminator every malformed record would be permanent.
      const idMs = pushKeyMs(id);
      if (idMs !== null && idMs < cutoff) continue;
      const seen = unreadable.get(m.productId) || [];
      seen.push(id);
      unreadable.set(m.productId, seen);
      continue;
    }
    if (ts < cutoff) continue;
    if (ts > (lastMs.get(m.productId) || 0)) lastMs.set(m.productId, ts);
  }
  return { lastMs, unreadable };
}

// Firebase push ids encode their creation time in the FIRST 8 characters, in a
// custom base-64 whose alphabet sorts lexicographically by time. Decoding it
// dates a record whose own timestamp field is unusable. Returns null for any id
// that is not a push key (the migration's own deterministic ids, for instance).
//
// The leading "-" is not a separator — it is the alphabet's ZERO character,
// which is simply what the timestamp's high bits decode to at present-day
// magnitudes. Skipping it shifts every digit and dates 2026 records to the year
// 5500s; the first version of this function did exactly that. Calibrated
// against live ledger ids: -OxNIloqoe_3VnGVZWi4 → 2026-07-12T21:50:07Z, which
// matches that record's own createdAt to the second.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
export function pushKeyMs(id) {
  if (typeof id !== "string" || id.length < 8) return null;
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    const v = PUSH_CHARS.indexOf(id[i]);
    if (v < 0) return null;
    ms = ms * 64 + v;
  }
  // A decode that lands outside any plausible ledger era means this was not a
  // push key at all (it just happened to use legal characters).
  return ms > 946684800000 && ms < 4102444800000 ? ms : null;   // 2000 … 2100
}

// ── TRANSFERS KEY THEIR SIZES, THEY DO NOT LABEL THEM ────────────────────────
// A transfer record is { from, to, status, lines: { <pid>: { <sizeKey>: qty } },
// received: { … same shape } }. The size is a KEY, so the obvious
// `/"size"\s*:\s*"M"/` scan over the record's JSON NEVER matches and the gate
// silently never fires — which is exactly what it did before this fix. Read the
// structure instead. (Kimi review, PR #343; proved against the live shape.)
export function transferBlocks(transfer, pid) {
  if (!transfer || transfer.status === "received") return null;
  // "Understood" is not merely "the pid key exists" — it is "the entry has the
  // DOCUMENTED shape", { <sizeKey>: <qty number> }. An entry like
  // { sizes: { M: 2 } } has the pid but hides its sizes one level down, and
  // treating that as read would return a clean bill on a transfer that really
  // does carry size M. Numbers all the way down, or it is not understood.
  // Judged PER NODE, then combined. A single `understood` flag set by whichever
  // node happened to be well-formed was sticky: a good lines[pid] would vouch
  // for a malformed received[pid], and the mention check never fired — a clean
  // bill on a transfer that really did carry a real size in the node nobody
  // could read. Every node that mentions the product must be readable.
  // (Kimi review of the lock delta, PR #343.)
  const sizes = new Set();
  let found = false, malformed = false;
  for (const node of [transfer.lines, transfer.received]) {
    const entry = node?.[pid];
    if (!entry || typeof entry !== "object") continue;
    found = true;
    const values = Object.values(entry);
    if (!(values.length && values.every((v) => typeof v === "number"))) { malformed = true; continue; }
    // SIZES ARE ONLY HARVESTED FROM A NODE THAT READ CLEANLY. This used to be
    // safe by accident: the size test was an enumeration of letter sizes, so a
    // malformed { sizes: { M: 2 } } contributed nothing because "sizes" is not
    // a letter size. Widening the test to "any key that is not the sentinel"
    // (which is what caps required — 28, 55, 4XL are all real) made "sizes"
    // itself look like a size, and the gate reported `carrying size sizes`
    // instead of "I cannot read this record". Both block, so nothing was
    // unsafe, but the operator was told a confident falsehood about a record
    // nobody had actually parsed. Reading a node and trusting a node are now
    // the same decision.
    for (const k of Object.keys(entry)) if (isRetiredSizeKey(k)) sizes.add(k);
  }
  const understood = found && !malformed;
  if (understood && sizes.size) return `open transfer (${transfer.status || "no status"}) ${transfer.from || "?"}→${transfer.to || "?"} carrying size ${[...sizes].sort().join(", ")}`;
  if (malformed) {
    return `open transfer (${transfer.status || "no status"}) presents this product in a shape this gate does not understand`
      + `${sizes.size ? ` (a readable node also carries size ${[...sizes].sort().join(", ")})` : ""} — check it by hand`;
  }
  // Unrecognised shape that still names the product: same fail-safe rule as
  // orderBlocks — block rather than assume.
  //
  // The mention check runs whenever the structural read did not actually FIND
  // this product — not merely when both nodes are absent. A record nesting
  // differently — lines: { <loc>: { <pid>: { M: 2 } } } — leaves `lines`
  // present but `lines[pid]` missing, so the earlier guard skipped the check
  // and returned "does not block": the fail-OPEN direction this function exists
  // to close.
  //
  // `understood` is what keeps that from over-blocking: a transfer whose
  // lines[pid] IS found and holds only "_" was read correctly and carries
  // nothing this migration retires, so it passes. Read-and-found-nothing-real
  // is a clean bill; could-not-read is not. (CodeRabbit, PR #343.)
  if (!understood && JSON.stringify(transfer).includes(pid)) {
    return `open transfer (${transfer.status || "no status"}) references this product in a shape this gate does not understand — check it by hand`;
  }
  return null;
}

export const legIds = (pid, loc, sizeKey) => ({
  out: `onesize_${pid}_${loc}_out_${sizeKey}`,
  in: `onesize_${pid}_${loc}_in_us_${sizeKey}`,
  negOut: `onesize_${pid}_${loc}_out_us_${sizeKey}`,
  negIn: `onesize_${pid}_${loc}_in_${sizeKey}`,
});

function emptyLink() {
  return { orderId: null, transferId: null, refillId: null, saleId: null, deviceId: null };
}

// ── applyMovementAdmin — see header for the contract this mirrors ─────────────
//
// ── WHY THE VERSION RE-CHECK EXISTS (Kimi review, PR #343) ───────────────────
// The client applyMovement gets its optimistic concurrency from the SECURITY
// RULE, not from its own code: the rule refuses any cell write whose `v` is not
// exactly data.v + 1, so a concurrent writer that landed in between makes the
// write bounce and the client re-reads and retries.
//
// The Admin SDK bypasses every rule. Copying the `v + 1` FIELD without the rule
// that enforces it copies the shape of the protection and none of its effect: a
// till sale landing between this function's read and its write would be
// silently overwritten, because the update SETS an absolute qty computed from
// the stale read. The unit would vanish with no error and no ledger gap that
// the totals check could see — before and after would both look right.
//
// So the guard is re-implemented here: read, compute, then re-read immediately
// before the write and confirm nothing moved; on a change, start over. The
// window is not closed (RTDB has no compare-and-set across paths), but it
// shrinks from "the whole run" to the microseconds between two adjacent reads,
// and a persistent conflict fails loudly instead of quietly winning. The
// operational half of this guard is the trading-hours window and the
// recent-activity gate in the CLI — neither replaces the other.
const CONFLICT_RETRIES = 5;

export async function applyMovementAdmin(io, movement, { nowIso }) {
  if (!movement || movement.type !== "adjustment") return { ok: false, reason: "invalid_type" };
  if (!movement.productId || !movement.size) return { ok: false, reason: "missing_product_or_size" };
  if (!(Number(movement.qty) > 0)) return { ok: false, reason: "qty_must_be_positive" };
  if (!(movement.reason && String(movement.reason).trim())) return { ok: false, reason: "adjustment_requires_reason" };
  if (!movement.movementId) return { ok: false, reason: "movement_id_required" };
  const mvId = assertSafeSegment(movement.movementId, "movementId");

  const loc = movement.to || movement.from;
  const delta = movement.to ? +Number(movement.qty) : -Number(movement.qty);
  if (!loc) return { ok: false, reason: "missing_location" };

  const path = stockCellPath(loc, movement.productId, movement.size);
  const sameCell = (a, b) => {
    const q = (c) => (c && typeof c.qty === "number" ? c.qty : 0);
    const v = (c) => (c && typeof c.v === "number" ? c.v : null);
    return q(a) === q(b) && v(a) === v(b);
  };

  for (let attempt = 1; attempt <= CONFLICT_RETRIES; attempt++) {
    // IDEMPOTENCY IS CHECKED INSIDE THE LOOP, not once before it. Checked only
    // at the top, two overlapping callers could both pass it before either
    // wrote — and for a POSITIVE leg (the IN into "_") there is no negative
    // floor to refuse the second one, so a 6-unit move could land 12 with the
    // single ledger record silently overwritten, erasing the evidence. Inside
    // the loop the check is re-run on every attempt, immediately before the
    // guarded write. (Sonnet re-review, PR #343. The CLI's own single-process
    // sequential loop cannot race itself; the run lock in the CLI is what
    // stops two processes, and this is the belt to that pair of braces.)
    const existing = await io.read(`stock_movements/${mvId}`);
    if (existing) return { ok: true, movementId: mvId, idempotent: true };

    const cell = await io.read(path);
    const curQty = cell && typeof cell.qty === "number" ? cell.qty : 0;
    const newQty = curQty + delta;
    if (delta < 0 && newQty < 0 && !movement.allowNegative) {
      return { ok: false, reason: "insufficient_stock", location: loc, available: curQty, requested: Number(movement.qty) };
    }

    const mv = {
      type: "adjustment",
      productId: movement.productId,
      size: movement.size,
      qty: Number(movement.qty),
      from: movement.from ?? null,
      to: movement.to ?? null,
      before: { [loc]: curQty },
      after: { [loc]: newQty },
      actor: ACTOR,
      actorRole: "admin",
      ts: movement.ts || nowIso,
      appliedAt: nowIso,
      reason: movement.reason,
      link: emptyLink(),
    };

    const updates = {};
    updates[`stock_movements/${mvId}`] = mv;
    const newV = cell && typeof cell.v === "number" ? cell.v + 1 : 0;
    updates[`${path}/qty`] = newQty;
    updates[`${path}/v`] = newV;
    updates[`${path}/mv`] = mvId;
    updates[`${path}/lastType`] = "adjustment";
    updates[`${path}/updatedAt`] = nowIso;
    updates[`${path}/updatedBy`] = ACTOR;

    // The re-check. Anything that moved this cell since the read above makes the
    // computed qty stale, and writing it would erase that other writer's change.
    const recheck = await io.read(path);
    if (!sameCell(cell, recheck)) continue;              // someone else wrote — recompute

    await io.update(updates);
    return { ok: true, movementId: mvId, qty: Number(movement.qty), newQty };
  }
  return { ok: false, reason: "conflict_retries_exhausted", location: loc };
}

// ── STEP 1 — plan the paired movements for one product ───────────────────────
// Resume-aware: a pair whose OUT leg already landed derives the IN leg's qty
// from the LEDGER, never from the (already emptied) live cell — that is what
// makes an interrupted run completable. Returns [{loc, sizeKey, pairs:[...]}].
export async function planStep1(io, pid, declaredSizes, cellsByLoc) {
  const plans = [];
  for (const [loc, bySize] of Object.entries(cellsByLoc || {})) {
    for (const [sizeKey, cell] of Object.entries(bySize || {})) {
      if (sizeKey === "_") continue;
      const q = cell && typeof cell.qty === "number" ? cell.qty : 0;
      const ids = legIds(pid, loc, sizeKey);
      // ── RAW SIZE FOR THE MOVEMENT RECORD ────────────────────────────────
      // This used to be `size = sizeKey` guarded by
      // `if (encodeSizeKey(size) !== sizeKey) throw`. That guard could never
      // fire: sizeKey comes from a /stock cell KEY, RTDB rejects every
      // character encodeSizeKey substitutes, so the key is already encoded and
      // encoding it again is a no-op. The one case the comment claimed to
      // catch — a half size — was exactly the case that slipped through: "5.5"
      // is stored under key "5_5", the assertion passed, and the movement
      // recorded `size: "5_5"` rather than "5.5". The cell path re-encodes, so
      // the arithmetic stayed right, but the ledger disagreed with the
      // catalogue about what was moved. (CodeRabbit, PR #345.)
      //
      // So resolve the key back through the product's DECLARED sizes, which is
      // where the raw form actually lives. Every live headwear size encodes to
      // itself, so this changes nothing today; it stops the ledger lying the
      // first time a size that does not.
      const declaredMatch = (declaredSizes || []).map(String).find((s) => encodeSizeKey(s) === sizeKey);
      const size = declaredMatch ?? sizeKey;

      // ── THE LEDGER IS CONSULTED FIRST, ALWAYS ───────────────────────────────
      // This used to happen ONLY in the `q === 0` branch, on the assumption that
      // a half-applied pair always leaves its source cell at exactly zero. It
      // does — until anything else touches that cell, and the cell stays a
      // DECLARED size the whole time, so a till or a warehouse receive is
      // perfectly entitled to. Both independent reviews of PR #345 found this
      // and both reproduced it end to end:
      //
      //   OUT lands (M 5 → 0, "_" not yet credited), the run is interrupted.
      //   • A till oversells M to −1. On resume q < 0, so the MIRRORED pair is
      //     planned and `ids.in` is never planned at all. The mirror closes M at
      //     0, assertDrained sees no residue, Step 2 collapses identity, and
      //     verifyProduct passes because this run's baseline was taken AFTER the
      //     loss. FIVE UNITS GONE, every check green.
      //   • A receive puts 2 into M. On resume q > 0, so OUT is re-planned under
      //     its SPENT id (no-op) while IN applies with the NEW qty — crediting 2
      //     instead of the owed 5. Two units minted into "_", five still lost.
      //
      // The ids are keyed by (product, location, size) with no quantity in them,
      // which is what makes a re-run a no-op; the price is that a spent id can
      // never be reused for a different quantity. So: read the ledger first,
      // finish any half-applied pair from the LEDGER's recorded quantity, and
      // only plan a fresh pair when its own ids are untouched. A cell holding
      // units whose pair is already spent is STRANDED — reported, never planned,
      // and assertDrained refuses to collapse the product until it is cleared.
      let resolvedByResume = false;
      const [out, inMv, negOut, negIn] = await Promise.all([
        io.read(`stock_movements/${ids.out}`),
        io.read(`stock_movements/${ids.in}`),
        io.read(`stock_movements/${ids.negOut}`),
        io.read(`stock_movements/${ids.negIn}`),
      ]);

      // 1. Finish a half-applied pair, from the ledger, whatever the cell says.
      if (out && !inMv) {
        const n = Number(out.qty);
        plans.push({ loc, sizeKey, kind: "resume-in", qty: n, legs: [
          { id: ids.in, movement: { type: "adjustment", productId: pid, size: "_", qty: n, to: loc, movementId: ids.in,
            reason: `Collapse to one-size: receive from size ${size}` } },
        ] });
      }
      // The mirrored pair is net-zero on the network: negOut debits "_" by n,
      // negIn credits the sized cell by n. Half-applied, the books therefore
      // read n LOW, and negIn is OWED — unconditionally, exactly like the
      // positive pair's IN leg, and for exactly the same reason. Where the
      // units land afterwards is assertDrained's problem, not the planner's.
      //
      // A previous attempt made this conditional on the cell still reading −n,
      // reasoning that a receive settling the cell in the gap would make a
      // second close a MINT. That was an arithmetic error: the receive adds a
      // real unit, so the correct total rises with it, and refusing negIn
      // leaves the network permanently short by the n that negOut removed —
      // with the stranded note asserting the opposite of what happened, and
      // every later re-run repeating the same refusal because the cell never
      // returns to −n. Conservation is the test, not the cell's current value.
      if (negOut && !negIn) {
        const n = Number(negOut.qty);
        plans.push({ loc, sizeKey, kind: "resume-neg-in", qty: -n, legs: [
          { id: ids.negIn, movement: { type: "adjustment", productId: pid, size, qty: n, to: loc, movementId: ids.negIn,
            reason: `Collapse to one-size: close oversold size ${size} cell` } },
        ] });
        resolvedByResume = true;
      }

      // 2. The cell's own balance — only if the pair it needs is untouched.
      // `!(negOut && !negIn)` — a pending MIRROR resume must finish on its own
      // before this cell's positive balance is planned. Two reasons, both real:
      // the quantity here was read BEFORE that resume leg applies, so the pair
      // would be planned against a number about to change; and planning legs
      // against a cell whose sibling leg is mid-flight is precisely the
      // half-applied state this whole block exists to stop reasoning about. The
      // resume lands, assertDrained refuses the collapse, and the next run
      // plans this balance cleanly at its true value. (Review of PR #345.)
      if (q > 0 && !out && !inMv && !(negOut && !negIn)) {
        plans.push({ loc, sizeKey, kind: "positive", qty: q, legs: [
          { id: ids.out, movement: { type: "adjustment", productId: pid, size, qty: q, from: loc, movementId: ids.out,
            reason: `Collapse to one-size: move size ${size} → _` } },
          { id: ids.in, movement: { type: "adjustment", productId: pid, size: "_", qty: q, to: loc, movementId: ids.in,
            reason: `Collapse to one-size: receive from size ${size}` } },
        ] });
      } else if (q < 0 && !negOut && !negIn) {
        const n = -q;
        plans.push({ loc, sizeKey, kind: "negative", qty: q, legs: [
          { id: ids.negOut, movement: { type: "adjustment", productId: pid, size: "_", qty: n, from: loc, movementId: ids.negOut,
            allowNegative: true, reason: `Collapse to one-size: carry oversell of size ${size} into _` } },
          { id: ids.negIn, movement: { type: "adjustment", productId: pid, size, qty: n, to: loc, movementId: ids.negIn,
            reason: `Collapse to one-size: close oversold size ${size} cell` } },
        ] });
      } else if (q !== 0 && !resolvedByResume) {
        // STRANDED — stock in a size whose pair is spent, with nothing planned
        // that will zero it. Planning it again would either no-op (losing it)
        // or apply half a pair (minting). Neither is acceptable, and neither is
        // silence.
        //
        // `resolvedByResume` is load-bearing: a cell sitting at −1 with negOut
        // spent is NOT stranded — the resume leg planned above is precisely
        // what brings it to 0, and the execute path treats a stranded plan as a
        // hard failure, so getting this wrong would refuse the very interrupted
        // run this fix exists to let finish. It also stops a cell the mirror
        // resume ALREADY reported being reported a second time here.
        // What is genuinely stranded is a cell no planned leg will zero:
        // positive with its OUT already spent, or negative with its closing leg
        // already spent (a fresh oversell after the mirror completed).
        plans.push({ loc, sizeKey, kind: "stranded", qty: q, legs: [],
          note: `${loc}/${sizeKey} holds ${q} but its movement pair is already spent — this stock arrived after the pair ran. Move it to "_" by hand (or clear it) before collapsing; Step 2 will refuse until you do.` });
      }
    }
  }
  return plans;
}

// ── STEP 2 — ONE atomic multi-path update per product ────────────────────────
// products/{pid}/sizes = ["_"], products/{pid}/barcodes = {"_": keepCode}, and
// EVERY /barcodes/{code}/size = "_". Split across separate writes in any order
// and every scan for the product breaks in the window (see the balaclava
// header for the two failure orderings) — so this function returns exactly ONE
// updates object, and the CLI hands it to ONE io.update call.
//
// ── THE KEEP-CODE RULE ───────────────────────────────────────────────────────
// A one-size product's `barcodes` map is keyed by size and therefore holds
// exactly ONE entry: {"_": code}. So when a product carries several codes, one
// of them has to own that slot. This was trivial for beanies (every one had
// exactly one code) and is a real decision for caps: 87 of 167 carry two or
// more, and the choice decides which physical labels keep their meaning.
//
// WHAT HAPPENS TO THE CODES THAT DO NOT WIN THE SLOT — the important half, and
// the reason this is safe. NOTHING is deleted. Step 2 rewrites EVERY
// /barcodes/{code} record of this product to size "_" and leaves productId
// untouched, and /barcodes is the reverse index a scan actually resolves
// through (barcode.js: "resolution is a reverse-index lookup, NOT parsing").
// So every code — kept or not — still resolves to this product, at the one cell
// the product now has. A former-M label and a former-L label scan to the same
// place, which is exactly right, because the hat they are stuck to no longer
// has a size. The only thing a losing code loses is its slot in the product's
// own map, and that slot no longer exists for anyone.
//
// The slot matters for ONE thing: ensureBarcode reads
// /products/{id}/barcodes/{sizeKey} and reuses a valid code rather than minting
// a fresh one (barcodeStore.js:111). A filled "_" slot therefore stops the app
// ever minting a NEW code for a product that already has perfectly good labels
// in the field. Which of the existing codes fills it changes nothing about
// resolution — only about which code a newly printed label carries.
//
// So the rule optimises for exactly that: newly printed labels should match the
// codes already out there on the most stock.
//
//   1. AN EXISTING "_" SLOT WINS. If the product already has one, it is already
//      correct and nothing should move.
//   2. OTHERWISE THE CODE OF THE SIZE HOLDING THE MOST UNITS, network-wide.
//      That is the code on the largest number of labels physically on stock, so
//      it is the choice that makes the fewest future reprints disagree with the
//      shelf. Ties break on size key ascending, then code ascending.
//   3. NO STOCK ANYWHERE (42 live caps) — the code of the first DECLARED size
//      that has one, in catalogue order. Nothing on a shelf to match, so the
//      tie-break just has to be stable and explicable.
//   4. LAST RESORT — the lowest code. Codes are 8-digit zero-padded, so
//      lexicographic order IS numeric order, and the oldest code wins.
//
// Every branch is deterministic and total: the same product always yields the
// same keepCode, whatever order its barcodes map happens to enumerate in, and
// there is no input with a code that yields none.
export function planStep2(pid, product, indexCodes, heldUnitsBySizeKey) {
  const bySlot = {};
  for (const [slot, c] of Object.entries(product.barcodes || {})) {
    if (typeof c === "string" || typeof c === "number") bySlot[slot] = String(c);
  }
  const codes = [...new Set([...Object.values(bySlot), ...Object.keys(indexCodes || {}).map(String)])].sort();
  if (codes.length === 0) return { error: "no_barcodes" };

  let keepCode = null, rule = null;
  if (bySlot["_"]) {
    keepCode = bySlot["_"];
    rule = `existing "_" slot`;
  } else if (codes.length === 1) {
    keepCode = codes[0];
    rule = "only code";
  } else {
    // Units per SIZE KEY across every location, sentinel and non-positive
    // excluded — a size holding 0 or a negative has no labels to protect.
    const ranked = Object.entries(heldUnitsBySizeKey || {})
      .filter(([k, n]) => isRetiredSizeKey(k) && Number(n) > 0 && bySlot[k])
      .sort((a, b) => (Number(b[1]) - Number(a[1]))
        || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        || (bySlot[a[0]] < bySlot[b[0]] ? -1 : 1));
    if (ranked.length) {
      const [sizeKey, units] = ranked[0];
      keepCode = bySlot[sizeKey];
      rule = `code of size ${sizeKey}, the most-stocked size (${units} unit${units === 1 ? "" : "s"} on hand)`;
    } else {
      const declared = (product.sizes || []).map(String).find((s) => bySlot[encodeSizeKey(s)]);
      if (declared) {
        keepCode = bySlot[encodeSizeKey(declared)];
        rule = `code of declared size ${declared} (no stock on hand anywhere)`;
      } else {
        keepCode = codes[0];
        rule = "lowest code (no stock, no declared size carries a code)";
      }
    }
  }

  // ── ONLY REWRITE INDEX RECORDS THAT EXIST ───────────────────────────────────
  // A code listed in the product's `barcodes` map with NO /barcodes record is
  // possible (the two are written together but nothing enforces the pair). For
  // such a code, `barcodes/{code}/size = "_"` does not rewrite a record — it
  // CREATES one, holding a size and nothing else. That record has no productId,
  // so it resolves to nothing on a scan, and it violates the live rule
  // (`newData.hasChildren(['productId'])`) which the Admin SDK bypasses rather
  // than enforces. The migration would silently mint junk in the index it is
  // supposed to be repairing.
  //
  // The CLI does gate this (it refuses a product whose map names a code with no
  // record), so no live run could reach it today. But planStep2 is called
  // directly by the census for reporting and is the function that decides what
  // gets written, so it must not depend on a caller's gate to stay correct.
  // Unindexed codes come back named, rather than being written blind or dropped
  // in silence. (CodeRabbit, PR #345.)
  // Keyed on the RECORD, not the key. Both real callers represent "the index
  // has no record for this code" as a present key with a null VALUE
  // (`indexCodes[code] = barcodesIdx[code] ?? null`), so keying on
  // Object.keys() classified exactly the missing records as indexed and put the
  // orphan-creating write straight back. The guard is supposed to hold without
  // a caller's help; keyed on the key it held only for a shape neither caller
  // produces. (Review of PR #345.)
  const indexed = new Set(Object.entries(indexCodes || {}).filter(([, rec]) => !!rec).map(([code]) => String(code)));
  const unindexedCodes = codes.filter((c) => !indexed.has(c));

  const updates = {};
  updates[`products/${assertSafeSegment(pid, "productId")}/sizes`] = ["_"];
  updates[`products/${pid}/barcodes`] = { [stockSizeKey(null)]: keepCode };   // {"_": code} via the chokepoint
  for (const code of codes) {
    if (!indexed.has(code)) continue;
    updates[`barcodes/${assertSafeSegment(code, "barcode")}/size`] = "_";
  }
  // droppedCodes is REPORTING, not a write — the codes that keep resolving via
  // the index but lose their slot in the product's own map. The census and the
  // dry run print them so "what happens to the others" is answered per product
  // before anything moves, not inferred afterwards.
  return { updates, keepCode, rule, codes, unindexedCodes,
    droppedCodes: codes.filter((c) => c !== keepCode) };
}

// ── THE DRAIN CHECK — Step 2's precondition, on FRESH reads ─────────────────
// Step 2 is the irreversible half: the moment `sizes` becomes ["_"], any unit
// still sitting in a sized cell is invisible to the app and to the engine.
// Step 1 reporting success is NOT proof that the cells are empty, because the
// movement id is scoped to (product, location, size) with no attempt number:
//
//   run 1  Step 1 lands in full (M drained to 0, "_" holds the units) and the
//          operator stops before Step 2 — the state this file's header calls
//          safe, and it IS safe, because the product still declares M.
//   …then  a legitimate warehouse receive lands 2 units into M, exactly as it
//          should, because M is still a declared size.
//   run 2  planStep1 sees M = 2 and plans the pair again — but BOTH movement
//          ids already exist, so applyMovementAdmin no-ops each leg and
//          reports ok+idempotent. Nothing moves. Step 2 fires anyway and the
//          2 units are stranded in a size the product no longer declares.
//
// Reproduced end-to-end against these exact functions (Sonnet review, PR #343).
// The recent-activity gate does not cover it: the realistic trigger is a pause
// of hours, not minutes. So Step 2 asks the database directly, immediately
// before it commits, whether every sized cell is actually at zero — and the
// caller must refuse to collapse the product if any is not. Idempotency stays
// exactly as it is; what changes is that success is now verified, not inferred.
export async function assertDrained(io, pid) {
  const stock = (await io.read("stock")) || {};
  const residue = [];
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const [sizeKey, cell] of Object.entries(byPid?.[pid] || {})) {
      if (sizeKey === "_") continue;
      const q = typeof cell?.qty === "number" ? cell.qty : 0;
      if (q !== 0) residue.push(`${loc}/${sizeKey}=${q}`);
    }
  }
  return residue;
}

// Already in the Step 2 end state? (makes a re-run a read-only no-op)
export function step2Done(product, indexCodes, keepCode) {
  const sizesOk = JSON.stringify(product.sizes || null) === JSON.stringify(["_"]);
  const map = product.barcodes || {};
  const mapOk = Object.keys(map).length === 1 && String(map["_"]) === String(keepCode);
  const idxOk = Object.values(indexCodes || {}).every((rec) => rec && rec.size === "_");
  return sizesOk && mapOk && idxOk;
}

// ── STEP 3 — retire explicit target rows on dead sizes ───────────────────────
// target 0 = "deliberately excluded" (the engine's own vocabulary). Rows keyed
// "_" are untouched; rows already retired are skipped so re-runs are no-ops.
export function planStep3(pid, targetRowsByLoc, nowIso) {
  const updates = {};
  for (const [loc, rows] of Object.entries(targetRowsByLoc || {})) {
    for (const [sizeKey, row] of Object.entries(rows || {})) {
      if (sizeKey === "_") continue;
      if (row && row.target === 0 && row.source === "excluded") continue;
      updates[`stock_targets/${assertSafeSegment(loc, "location")}/${pid}/${assertSafeSegment(sizeKey, "size key")}`] = {
        target: 0, minQty: 0,
        source: "excluded", batchId: BATCH, approvedBy: "owner", approvedAt: nowIso,
      };
    }
  }
  return updates;
}

// ── THE POLICY-ROW DECISIONS (used by scripts/apply-headwear-policy.mjs) ─────
// They live here, next to the migration they depend on, so they are covered by
// the same behavioural suite instead of being untestable logic inside a script
// that only runs against live RTDB.

// Mirrors the LIVE rule at /stock_targets/$loc/$pid/$size:
//   hasChildren(['target','minQty']) && target.isNumber() && minQty.isNumber()
// The Admin SDK bypasses rules, so an invalid row would be accepted here and
// then rejected the first time anything client-side touched it.
export function invalidTargetRow(row) {
  if (!row || typeof row !== "object") return "not an object";
  if (typeof row.target !== "number" || !Number.isFinite(row.target)) return "target is not a finite number";
  if (typeof row.minQty !== "number" || !Number.isFinite(row.minQty)) return "minQty is not a finite number (the live rule REQUIRES it)";
  if (row.target < 0 || row.minQty < 0) return "negative target/minQty";
  // reorderPoint is optional. When present the engine honours only a finite
  // >= 0; anything else silently falls back to "no gate" (eager ordering), so a
  // row that MEANT to gate would quietly not. Refuse it rather than write it.
  //
  // null is refused for a second, sharper reason: RTDB DELETES a null child, so
  // `reorderPoint: null` writes a row with no reorderPoint — which is a
  // perfectly valid intent, but it then reads back as ABSENT and a verify that
  // compares null against undefined reports a false failure on a write that
  // did exactly what was asked. Omit the key to mean absent. (CodeRabbit #345.)
  if ("reorderPoint" in row
    && !(typeof row.reorderPoint === "number" && Number.isFinite(row.reorderPoint) && row.reorderPoint >= 0)) {
    return `reorderPoint ${JSON.stringify(row.reorderPoint)} would be ignored by the engine — omit the key to mean absent`;
  }
  return null;
}

// Whether a product may have a policy row written / removed.
//
// ARMING and REMOVING are NOT symmetric, and treating them as one gate broke
// the documented off switch. Arming demands the product be in scope AND already
// collapsed. Removing must always be possible: a product that was merged or
// renamed after being armed fails isInScope, and its rows are still live and
// still driving the refill engine. Refusing to remove them would leave a policy
// with no off switch — the one thing the design promises. (CodeRabbit #345.)
export function policyRowGate(product, { remove = false } = {}) {
  if (!product) return remove ? { ok: true, note: "product no longer exists — removing its row anyway" } : { ok: false, reason: "missing", detail: "no such product" };
  if (remove) {
    return isInScope(product)
      ? { ok: true }
      : { ok: true, note: "no longer in headwear scope (merged or renamed) — removing its row anyway" };
  }
  if (!isInScope(product)) return { ok: false, reason: "not-headwear", detail: "is not a beanie or a cap" };
  if (JSON.stringify(product.sizes || null) !== JSON.stringify(["_"])) {
    return { ok: false, reason: "not-collapsed", detail: `still declares ${JSON.stringify(product.sizes)}` };
  }
  return { ok: true };
}

// ── per-product verification (fresh reads, after execute) ────────────────────
// Location totals must equal the totals BEFORE the product's migration; every
// sized cell must sit at 0; identity and index must be fully collapsed.
export async function verifyProduct(io, pid, keepCode, allCodes, totalsBefore, expectedDelta = {}) {
  const problems = [];
  const product = await io.read(`products/${pid}`);
  if (JSON.stringify(product?.sizes || null) !== JSON.stringify(["_"])) problems.push(`sizes = ${JSON.stringify(product?.sizes)}`);
  const map = product?.barcodes || {};
  if (!(Object.keys(map).length === 1 && String(map["_"]) === String(keepCode))) problems.push(`barcodes map = ${JSON.stringify(map)}`);
  for (const code of allCodes) {
    const rec = await io.read(`barcodes/${code}`);
    if (!rec || rec.productId !== pid || rec.size !== "_") problems.push(`index ${code} = ${JSON.stringify(rec)}`);
  }
  const stock = (await io.read("stock")) || {};
  const totalsAfter = {};
  for (const [loc, byPid] of Object.entries(stock)) {
    const bySize = byPid?.[pid];
    if (!bySize) continue;
    let sum = 0;
    for (const [sizeKey, cell] of Object.entries(bySize)) {
      const q = typeof cell?.qty === "number" ? cell.qty : 0;
      sum += q;
      if (sizeKey !== "_" && q !== 0) problems.push(`${loc}/${sizeKey} still holds ${q}`);
    }
    totalsAfter[loc] = sum;
  }
  for (const loc of new Set([...Object.keys(totalsBefore || {}), ...Object.keys(totalsAfter)])) {
    // expectedDelta is non-zero only where this run resumed a pair an earlier
    // run left half-applied — a credit whose debit is already in the baseline.
    const b = (totalsBefore?.[loc] || 0) + (expectedDelta?.[loc] || 0), a = totalsAfter[loc] || 0;
    if (b !== a) problems.push(`${loc} total ${(totalsBefore?.[loc] || 0)} → ${a}, expected ${b}${expectedDelta?.[loc] ? ` (including +${expectedDelta[loc]} owed by a resumed pair)` : ""} (units lost or minted)`);
  }
  const targets = (await io.read("stock_targets")) || {};
  for (const [loc, byPid] of Object.entries(targets)) {
    for (const [sizeKey, row] of Object.entries(byPid?.[pid] || {})) {
      if (sizeKey !== "_" && row && row.target !== 0) problems.push(`target row ${loc}/${sizeKey} target=${row.target} not retired`);
    }
  }
  return problems;
}

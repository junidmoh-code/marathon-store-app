// ─── REFILL ENGINE CORE (pure) ────────────────────────────────────────────────
// The deterministic heart of the automated clothing-refill system. Every 15
// minutes the refillHealthScan Cloud Function snapshots the RTDB and calls
// computeRefillPlan() below; the function then APPLIES the plan (creates refill
// intents / R### orders, closes finished locks, writes exceptions). All policy
// lives HERE, pure and node-tested — the function is just I/O.
//
// DESIGN RULES (see plan "AI-Driven Inventory Refill"):
//  • The engine NEVER writes /stock. It creates intents; humans move stock via
//    the existing CR fulfilment (fulfillCRBatch) and Transfer flows.
//  • Scan-only, stateless: every run recomputes deficits from scratch, so a
//    crashed run, a lost intent, or a human mistake heals on the next pass (L3).
//  • Routing is CONFIG (config.routes), never code — flexible topology.
//  • qty < 0 (oversell signals) counts as 0 available and never inflates a
//    deficit; it feeds the confidence score instead.
//  • Idempotency: ONE open intent per (dest, product, size), tracked in
//    /refill_engine/open. R-numbers are daily-recycled and are never identity.
//
// Terminology:
//  • dest      — a location being kept at target (marathon-pe, trophy, hub2)
//  • source    — where its refills come from (config.routes[dest])
//  • intent    — "move qty of (product,size) source→dest", surfaced as a
//                /refill_requests record (+ an R### order for store legs)

// Group and per-size resolution lives in a LEAF module (it requires nothing),
// so this file can consume it without the module that reasons about this file
// having to reach back in. See policy-resolve.cjs for the precedence order.
const { locationPolicyFor, armedGroupForCategory, effectivePolicyFor } = require("./policy-resolve.cjs");

// RTDB keys can't contain . # $ / [ ] — mirror of src/utils/sizeKey.js.
function encodeSizeKey(size) {
  const s = String(size == null ? "" : size).trim();
  if (!s) return "_";
  return s.replace(/[.#$/\[\]\s]/g, "_");
}

// RTDB keys may NOT contain . # $ [ ] / — so a timestamp used inside a key must be
// an integer epoch-ms, never an ISO string (which contains a "."). Building the
// retryHistory key with an ISO timestamp threw synchronously on .update() and
// crashed every engine run (2026-07-22 outage). The ISO string is still stored as
// a FIELD (a value, where dots are fine); only the KEY uses epoch-ms.
function retryHistoryKey(dest, pid, sizeKey, tsIso) {
  const ms = Date.parse(tsIso);
  return `${dest}|${pid}|${sizeKey}|${Number.isFinite(ms) ? ms : 0}`;
}

// ─── RTDB WRITE HARDENING (outages 2026-07-22 and 2026-07-24) ────────────────
// firebase-admin validates .update() / .set() arguments SYNCHRONOUSLY and THROWS
// before it ever returns a promise. That means `.update(x).catch(...)` does NOT
// catch these — the catch is never attached, the exception escapes the await,
// and the whole scan dies mid-apply. Two classes have now each caused a live
// outage in this exact code path:
//   • forbidden char (. # $ [ ] /) inside a KEY  → #269, 2026-07-22
//   • an `undefined` VALUE anywhere in the payload → 2026-07-24, engine down 26h
//     (retryState "retry" op omitted firstRejectedAt/lastRejectedAt)
// sanitizeUpdate() strips both classes BEFORE the call and RETURNS what it
// dropped so the caller can log it. A single malformed record then degrades to
// one skipped field instead of stopping every refill in the business.
//
// This is a BACKSTOP, NOT A LICENCE. Anything it reports is a real bug at the
// write site and must be fixed there — the guard only stops it being an outage.
const FORBIDDEN_KEY_CHARS = /[.#$\[\]]/;   // "/" excluded: legal as a PATH separator

// Multi-path update keys are paths ("a/b/c"); each SEGMENT must be a valid key.
function badPathSegments(path) {
  const segs = String(path).split("/");
  return segs.some((s) => s.length === 0 || FORBIDDEN_KEY_CHARS.test(s));
}

// Recursively drop `undefined` leaves and forbidden nested keys. Returns the
// cleaned value, or the UNDEF sentinel when the whole value must be dropped.
const UNDEF = Symbol("drop");
function cleanValue(val, trail, problems) {
  if (val === undefined) {
    problems.push(`undefined value at ${trail}`);
    return UNDEF;
  }
  // null is LEGAL (it deletes the node) — never strip it.
  if (val === null || typeof val !== "object") return val;
  // Arrays MUST be recursed: RTDB stores them as numeric-keyed objects and
  // throws on an undefined element exactly like it does on an object field.
  // An undefined element becomes null rather than being spliced out — dropping
  // it would shift every later index and silently corrupt the record.
  // (exceptions payloads are arrays of freeform objects, so this path is real.)
  if (Array.isArray(val)) {
    return val.map((v, i) => {
      const c = cleanValue(v, `${trail}[${i}]`, problems);
      return c === UNDEF ? null : c;
    });
  }
  // SERVER VALUE SENTINEL — admin.database.ServerValue.TIMESTAMP is literally
  // { ".sv": "timestamp" } (increment is { ".sv": { increment: n } }). That key
  // starts with a "." and would be stripped as "forbidden", which is the guard
  // corrupting a payload RTDB accepts happily. Worse, under strict mode it would
  // abort intent creation on EVERY scan forever — a permanent stall caused by
  // the safety net. Pass sentinels through untouched. (Kimi review, PR #276.)
  const keys = Object.keys(val);
  if (keys.length === 1 && keys[0] === ".sv") {
    const sv = val[".sv"];
    if (typeof sv === "string") return val;                       // {".sv":"timestamp"}
    if (sv && typeof sv === "object" && !Array.isArray(sv)) {
      // {".sv":{increment:n}} — the BODY still has to be validated, or an
      // `undefined` inside it rides straight through the guard to the driver
      // and throws exactly as before. A sentinel is ATOMIC: if any part of its
      // body is malformed the whole sentinel is meaningless, so drop it rather
      // than persist a corrupted one. (CodeRabbit, PR #276.)
      const before = problems.length;
      const body = cleanValue(sv, `${trail}/.sv`, problems);
      if (body !== UNDEF && problems.length === before) return { ".sv": body };
    }
    problems.push(`malformed ServerValue sentinel at ${trail}`);
    return UNDEF;
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (k.length === 0 || FORBIDDEN_KEY_CHARS.test(k) || k.includes("/")) {
      problems.push(`forbidden key "${k}" at ${trail}`);
      continue;
    }
    const c = cleanValue(v, `${trail}/${k}`, problems);
    if (c !== UNDEF) out[k] = c;
  }
  return out;
}

// upd: the multi-path update object. Returns { safe, problems }.
function sanitizeUpdate(upd) {
  const problems = [];
  const safe = {};
  for (const [path, val] of Object.entries(upd || {})) {
    if (badPathSegments(path)) {
      problems.push(`forbidden path "${path}"`);
      continue;
    }
    const c = cleanValue(val, path, problems);
    if (c === UNDEF) continue;
    safe[path] = c;
  }
  return { safe, problems };
}

// Device-local SA date key, matching App.jsx getTodayKey() EXACTLY (including
// the 0-based month!). The refill counter's daily reset compares this string —
// the server must produce the same value the shop tablets (UTC+2) produce, or
// a scan near midnight would fight the tablets over the counter's day.
function saTodayKey(nowMs) {
  const d = new Date(nowMs + 2 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Deterministic fingerprint of a product's stock across the whole network —
// the "ignore until inventory changes" decision stores this; ANY movement
// (receive, sale, transfer, adjustment) changes it and resurfaces the card.
// MUST stay in lockstep with the copy in src/components/stock/NoTargetQueue.jsx.
function stockFingerprint(stock, pid) {
  const parts = [];
  for (const loc of Object.keys(stock || {}).sort()) {
    const bySize = stock[loc]?.[pid];
    if (!bySize) continue;
    for (const sizeKey of Object.keys(bySize).sort()) {
      const q = num(bySize[sizeKey]?.qty);
      if (q !== 0) parts.push(`${loc}:${sizeKey}:${q}`);
    }
  }
  return parts.join("|") || "empty";
}
const cellQty = (stock, loc, pid, size) =>
  num(stock?.[loc]?.[pid]?.[encodeSizeKey(size)]?.qty);
const avail = (q) => Math.max(q, 0);

// Is this product clothing? Prefer the explicit flag; legacy size heuristic.
function isClothing(product) {
  if (!product) return false;
  if (product.productType) return product.productType === "clothing";
  return (product.sizes || []).some((s) => /^(XS|S|M|L|XL|XXL|XXXL)$/i.test(String(s)));
}

// ── Is this product footwear? ────────────────────────────────────────────────
// CATEGORY, not productType — measured on the live catalogue 2026-07-30:
//   category === "Footwear"      → 1,369 products
//   productType === "sneaker"    →   580 products
//   Footwear WITHOUT the type    →   801 products  ← would be silently unmanaged
// productType is absent on 858 records altogether, so keying off it would leave
// most of the shoe catalogue invisible to targeting. `category` is also what the
// admin category system (#280) writes and what `categoryKey`/`subcategory`
// agree with.
//
// DISJOINT FROM isClothing BY CONSTRUCTION — verified across the whole catalogue
// on 2026-07-30: zero products satisfy both. The single collision that existed
// ("Lacoste navy with white": productType "clothing" + category "Footwear" +
// sizes 6-11) was a data-entry error and was corrected in the product record
// rather than accommodated here. If a future record re-creates that state,
// isClothing wins in resolveTarget (its branch is evaluated first) and the shoe
// silently gets no target — so the invariant is worth a catalogue assertion, not
// a code fallback.
function isFootwear(product) {
  return product?.category === "Footwear";
}

// ── Is this product DEACTIVATED? ─────────────────────────────────────────────
// A finished line, retired reversibly from the Leftovers tab (owner spec
// 2026-08-25). One truthy check on the record the snapshot already carries —
// lockstep twin of src/utils/deactivation.js isDeactivated. The guard lives at
// the TOP of resolveTarget, above the explicit-row branch, so neither a stale
// /stock_targets row, a category policy, nor a kill switch can re-arm a
// deactivated product; a null target also flips needGone in the reconcile
// pass, withdrawing any in-flight request as no_longer_needed. Receiving stock
// clears the flag (applyMovement auto-reactivates), so the engine resumes
// without a scan ever having to know why.
function isDeactivated(product) {
  return !!(product && product.deactivated);
}

// Store carries a product if the stock node exists (regardless of qty).
// Zero-qty cells persist indefinitely (applyMovement never deletes cells), so
// node presence is a reliable assortment indicator even after sellouts.
function storeCarries(stock, loc, pid) {
  return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;
}

// Product catalog sizes — the source of truth for what a product comes in.
function productSizes(products, pid) {
  return (products?.[pid]?.sizes || []).map(String);
}

// ═══ KILL SWITCH — /config/refillEngine/ruleBasedTargets ═════════════════════
// THE one key that turns rule-based clothing targets off, live, with no code
// change and no deploy. Set it and the very next scan (≤15 min) obeys.
//
//   ruleBasedTargets: true              → ON at every destination
//   ruleBasedTargets: false             → OFF — engine reverts to the v5
//                                         explicit-targets-only behaviour
//   ruleBasedTargets: { trophy: true, hub2: false, "marathon-pe": true }
//                                       → per-destination; a location that is
//                                         absent from the map is OFF
//   key ABSENT / any other type         → OFF  (fail-safe, see below)
//
// FAIL-SAFE BY DESIGN: absent means OFF, so deleting the key is a valid
// emergency kill, and a config read that returns a partial/garbled node can
// never silently switch 6,000+ cells ON. Explicit-only under-orders; the rule
// over-orders — when in doubt the engine must take the conservative side.
// (This is why the dead `autoAdoptTargets` key was NOT revived: its stale live
// value {hub2:true} would have meant "hub2 only", silently changing behaviour
// the moment this shipped. It is inert and should be deleted from config.)
//
// Turning it off NEVER half-states anything: rule-based targets are computed in
// memory per scan and never persisted, so there is nothing to unwind. Explicit
// /stock_targets rows are untouched and keep working either way.
function ruleTargetsEnabled(config, dest) {
  const v = config?.ruleBasedTargets;
  if (v === true) return true;
  if (v && typeof v === "object" && !Array.isArray(v)) return v[dest] === true;
  return false;   // false, undefined, null, or anything unexpected → OFF
}

// ═══ KILL SWITCH — /config/refillEngine/footwearTargets ══════════════════════
// FOOTWEAR's own switch, deliberately SEPARATE from ruleBasedTargets so either
// product class can be killed without touching the other. Same grammar, same
// fail-safe (absent → OFF), same zero-unwind property: footwear targets are
// computed in memory per scan and never persisted.
//
//   footwearTargets: true                → ON at every destination
//   footwearTargets: { hub1: true }      → per-destination; absent from the map
//                                          is OFF (this is the intended rollout
//                                          shape — hub1 first, then hub2)
//   key ABSENT / any other type          → OFF  (fail-safe)
//
// WHY THIS IS READ *BEFORE* ruleTargetsEnabled IN resolveTarget: that function
// early-returns on `!ruleTargetsEnabled(...)` at the clothing gate. Had the
// footwear branch been placed after it, killing CLOTHING would also have killed
// footwear — the two switches would have been secretly coupled, defeating the
// whole point of a separate key. The branch order below is therefore load-bearing
// and must not be "tidied" into one block.
function footwearTargetsEnabled(config, dest) {
  const v = config?.footwearTargets;
  if (v === true) return true;
  if (v && typeof v === "object" && !Array.isArray(v)) return v[dest] === true;
  return false;   // false, undefined, null, or anything unexpected → OFF
}

// ═══ SUBCATEGORY POLICY — /config/refillEngine/subcategoryRunByLocation ══════
// A standing "keep N of every product in this subcategory" rule, keyed by the
// catalogue's own /products/{id}.subcategory field.
//
//   subcategoryRunByLocation: { hub2: { Watches: 2 }, trophy: { Watches: 2 } }
//
// WHY IT EXISTS (owner directive 2026-08-03): the clothing rule keys its target
// off SIZE (defaultRunByStore), which cannot express "watches keep 2". Watches
// are one-size — catalogue size "_" — and defaultRunByStore holds only garment
// letters, so every watch resolved to no target and sat unmanaged. The obvious
// shortcut, adding "_" to defaultRunByStore, was REJECTED by the owner and must
// not be revived: "_" is shared by every one-size product, so it would have
// silently armed 20 pairs of sunglasses, 4 belts and 4 jewellery lines carried
// at Trophy/PE alongside the 6 watches. Subcategory is the narrow key that says
// what was actually meant. (Perfume is untouched either way — it carries no
// productType and is not clothing, so it never reaches this branch; its policy
// stays explicit /stock_targets rows.)
//
// TWO INDEPENDENT OFF-SWITCHES, both fail-safe:
//   • delete /config/refillEngine/subcategoryRunByLocation → policy gone, live,
//     no deploy. Absent / non-object / non-positive → no policy, exactly as
//     before this shipped. Nothing is persisted, so there is nothing to unwind.
//   • ruleBasedTargets:false still kills this too — the branch sits AFTER that
//     kill switch on purpose. This is deliberately the opposite choice from the
//     footwear rule above (which sits BEFORE it to stay independent): footwear
//     is a separate estate with its own rollout, whereas a subcategory policy is
//     a REFINEMENT of the clothing rule and must die with the one big red button
//     rather than outlive it.
//
// It carries NO reorderPoint, for the same reason the clothing rule pins it to
// null: a top-up policy's trigger belongs on an approved row, not a code default.
function subcategoryRun(config, products, pid, dest) {
  const sub = products?.[pid]?.subcategory;
  if (typeof sub !== "string" || !sub) return null;
  const run = config?.subcategoryRunByLocation?.[dest];
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const t = run[sub];
  // Positive finite only. A 0 here is NOT "deliberately excluded" (that meaning
  // belongs to an explicit row a human wrote); at policy level it can only be a
  // typo, and honouring it would silently stop replenishing a whole category.
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

// ── target resolution — EXPLICIT OVERRIDE, THEN GLOBAL CLOTHING RULE ─────────
// Priority order (owner decision 2026-07-21, re-landed under review 2026-07-25):
//   1. explicit manual override (/stock_targets) — always wins
//   2. subcategory policy (config.subcategoryRunByLocation), then the global
//      clothing rule (config.defaultRunByStore + catalog sizes) — both ONLY
//      where ruleBasedTargets is enabled for this destination
//   3. null (non-clothing, store does not carry, or deliberately excluded)
// Explicit target 0 continues to mean "deliberately excluded".
//
// ── reorderPoint (2026-07-27) ────────────────────────────────────────────────
// OPTIONAL per-row field, explicit targets only. Absent → null → the deficit
// loop's gate is inert and the cell behaves EXACTLY as it always has (propose
// as soon as on-hand falls below target). That is what makes this change a
// no-op on all 8,419 existing clothing cells and opt-in one row at a time.
//
// It is deliberately NOT minQty. minQty keeps its one and only job — card
// priority at :938 — because minQty is already populated on every existing row
// (ceil(target/2) or target-1), so reusing it would have silently changed the
// trigger for the entire live catalogue in a single deploy.
//
// VALIDATION IS FAIL-SAFE IN THE OVER-ORDERING DIRECTION. Only a finite number
// >= 0 arms the gate; absent, null, negative, NaN or a non-number all fall back
// to today's eager behaviour. A negative is the case that matters: `have > -1`
// is true for every non-negative on-hand, so honouring it would silently STOP
// replenishing that cell forever. Under-ordering starves a shop silently while
// over-ordering is merely visible noise — so garbage resolves to "no gate",
// matching the file's standing rule that the engine takes the conservative side
// (see the kill switch's fail-safe note above).
// ═══ CATEGORY POLICY — the map itself ════════════════════════════════════════
// Shape, at /config/refillEngine/categoryPolicy:
//
//   {
//     "<categoryKey>": {
//       "perSize": true,                       // absent/false → one-size mode
//       "<dest>": { "target": N, "reorderPoint": N, "minQty": N },
//     },
//   }
//
// A location absent from an entry gets NOTHING there (decision 5: Trophy and
// marathon-pine are simply not named). reorderPoint absent → null → eager
// top-up, matching resolveTarget's standing fail-safe direction. minQty absent
// → ceil(target/2), the ratio every armed batch has used (8/4, 10/5, 5/3).
//
// TWO SIZE MODES, because the two mapped classes keep different promises:
//
//   ONE-SIZE (default) — the entry speaks for the "_" sentinel cell ONLY.
//   Any other size falls through to the branches below. This is what makes
//   arming a one-size category safe while its legacy records still carry
//   letter cells: the letters keep their existing clothing-rule resolution
//   (they are collapsed later by the migration, not starved now by the map),
//   while every "_" cell — and every script-imported one-size record —
//   resolves the category numbers with no row.
//
//   PER-SIZE (perSize: true) — the entry speaks for EVERY declared catalogue
//   size, replacing the garment run outright. A size that is declared but
//   holds ZERO units anywhere in the network right now resolves an EXPLICIT
//   TARGET 0 — a stop, not a fall-through — so a fitted cap's paper-only XXXL
//   (declared on 54 products, stocked on none) can never be re-armed by the
//   letter run below, exactly like a human-written 0 row. The moment real
//   units of that size arrive anywhere, the same test arms it automatically:
//   the category — not a row — is the policy.
//
// ═══ TWO EXTENSIONS, 2026-08-22 ══════════════════════════════════════════════
//
// GROUPS. A category with no entry of its own falls through to an ARMED group
// that names it (/config/refillEngine/policyGroups). A category WITH its own
// entry never consults a group — not per location, at all — so grouping can
// never override a deliberate per-category setting, and can never arm a shop
// the category's own policy deliberately left out. A DISARMED group is not in
// the resolution at all. All of that is locationPolicyFor's job; see
// policy-resolve.cjs.
//
// PER-SIZE MAPS. Under perSize:true a location may hold
// { sizes: { "<encodedSize>": { target, minQty, reorderPoint? } } } instead of
// one collapsed number. The engine walks exactly the sizes named there.
// Size keys are ENCODED — 5.5 is stored "5_5", the same key as the /stock cell
// it governs, because RTDB cannot hold a "." in a key at all.
//
// The return shape gains `sizes`. Everything that only tests this function for
// truthiness (managedPids, the class filter, the decision gate) is unaffected;
// sizesFor and categoryPolicyTarget read it.
//
// (2026-08-25, superseded same day) A `carriedOnly` carriage scope gate lived
// here briefly; the owner removed it — a category policy arms EVERY product of
// the category at the location, carriage or not, and the actionable-only
// source gate below is the only thing that decides whether a request line is
// actually raised. `stock` stays in the signature (call sites thread it) but
// is no longer consulted here.
function categoryPolicyEntry(config, products, stock, pid, dest) {
  const key = products?.[pid]?.categoryKey;
  if (typeof key !== "string" || !key) return null;
  // target must be a positive finite number — the entry arms; the computed
  // dead-size 0 below is the only zero this branch ever produces. Garbage
  // (string "5", NaN, negative) arms nothing, the conservative side. Under a
  // per-size map the same test is applied per row, and a map in which no row
  // passes it arms nothing either.
  const r = locationPolicyFor(config, key, dest);
  if (!r) return null;
  return { target: r.target, reorderPoint: r.reorderPoint, minQty: r.minQty,
    perSize: r.perSize, sizes: r.sizes,
    policySource: r.source, groupKey: r.groupKey };
}

// Units of one size across EVERY location — the per-size dead-size test.
// Negative counted cells clamp to 0: a count error must not arm a size.
function sizeUnitsAnywhere(stock, pid, size) {
  const k = encodeSizeKey(size);
  let n = 0;
  for (const loc of Object.keys(stock || {})) n += avail(num(stock[loc]?.[pid]?.[k]?.qty));
  return n;
}

function categoryPolicyTarget(config, products, stock, dest, pid, size) {
  const entry = categoryPolicyEntry(config, products, stock, pid, dest);
  if (!entry) return null;
  const rp = entry.reorderPoint;
  const shape = (target, minQty, reorderPoint) => ({
    target,
    minQty: typeof minQty === "number" && Number.isFinite(minQty) && minQty >= 0
      ? minQty
      : (target > 0 ? Math.ceil(target / 2) : 0),
    reorderPoint: typeof reorderPoint === "number" && Number.isFinite(reorderPoint) && reorderPoint >= 0
      ? reorderPoint : null,
    source: "category_policy",
  });
  const shaped = (target) => shape(target, entry.minQty, rp);
  // ── PER-SIZE MAP ───────────────────────────────────────────────────────────
  // The entry names its sizes one by one, each with its own three numbers.
  // A size the map does not name resolves NOTHING here and falls through — the
  // map speaks for what it names and no more, which is the same promise the
  // one-size mode makes about the "_" cell.
  //
  // The dead-size rule is kept: a named size with zero units ANYWHERE in the
  // network resolves an explicit 0 — a stop, not a fall-through — so a paper-
  // only size can never be re-armed by the letter run below, and arms itself
  // the moment real units arrive. Identical to the uniform per-size branch, so
  // switching a category from one collapsed number to a full map changes which
  // numbers apply and nothing about how absence behaves.
  if (entry.sizes) {
    if (encodeSizeKey(size) === "_") return null;
    const row = entry.sizes[encodeSizeKey(size)];
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    if (typeof row.target !== "number" || !Number.isFinite(row.target) || row.target <= 0) return null;
    if (!productSizes(products, pid).includes(String(size))) return null;
    return shape(sizeUnitsAnywhere(stock, pid, size) > 0 ? row.target : 0, row.minQty, row.reorderPoint);
  }
  if (!entry.perSize) {
    // One-size mode: the "_" cell only; letters fall through (see block above).
    return encodeSizeKey(size) === "_" ? shaped(entry.target) : null;
  }
  // Per-size mode: declared catalogue sizes only — a size the product does not
  // come in resolves nothing here, exactly like the clothing rule below. The
  // "_" sentinel is REFUSED outright: a per-size product declaring one-size is
  // a data error, and answering for it would put a one-size target on a sized
  // product from a map entry that was written about its sizes. Fall through
  // (no run holds a "_" key, so it resolves nothing) and let the record be
  // fixed, conservatively — the same direction every malformed input takes.
  // (CodeRabbit, PR #352 — and mirrored byte-for-byte in solvePlan.js.)
  if (encodeSizeKey(size) === "_") return null;
  if (!productSizes(products, pid).includes(String(size))) return null;
  return shaped(sizeUnitsAnywhere(stock, pid, size) > 0 ? entry.target : 0);
}

function resolveTarget({ targets, config, products, stock }, dest, pid, size) {
  // Deactivated products resolve NOTHING — before the explicit row, so no
  // stored policy of any kind can raise a request for a finished line.
  if (isDeactivated(products?.[pid])) return null;
  const explicit = targets?.[dest]?.[pid]?.[encodeSizeKey(size)];
  if (explicit && typeof explicit.target === "number") {
    const rp = explicit.reorderPoint;
    return {
      target: num(explicit.target),
      minQty: num(explicit.minQty),
      // NOT `num()` and NOT a truthiness check: num() maps garbage to 0, which
      // would arm the gate at "only when empty" — the silent-starvation case.
      // 0 itself IS valid and must survive (propose only at zero on-hand).
      reorderPoint: typeof rp === "number" && Number.isFinite(rp) && rp >= 0 ? rp : null,
      source: "explicit",
    };
  }
  // ── CATEGORY POLICY — /config/refillEngine/categoryPolicy (2026-08-13) ─────
  // The owner's standing rule: THE CATEGORY A PRODUCT IS GIVEN IS WHAT ARMS IT.
  // A category in this map is managed at the mapped locations with no
  // per-product row, ever — a perfume script-imported tomorrow is governed the
  // moment it exists, because resolution happens LIVE here rather than by
  // stamping rows at creation (which bulk imports never pass through).
  //
  // Placement is the precedence: explicit row > category policy > footwear
  // rule > kill switch > clothing rules. An explicit row still wins — so
  // deleting a row is NO LONGER the off switch for a mapped product. THE OFF
  // SWITCH IS THE MAP ENTRY: delete /config/refillEngine/categoryPolicy/<key>
  // and the very next scan drops the whole category back to exactly what the
  // branches below say (live, no deploy). Fail-safe by the same construction
  // as every switch in this file: an absent, garbled or unreadable entry arms
  // NOTHING.
  //
  // Sitting ABOVE the kill switch is deliberate and mirrors explicit rows:
  // this map is owner-armed policy, not a rule the engine invented, so
  // ruleBasedTargets=false does not silence it. Sitting ABOVE the clothing
  // rules means a mapped clothing category (headwear) overrides the garment
  // size run for exactly the sizes the entry speaks for — and no others; see
  // categoryPolicyTarget for the two size modes and their fall-through.
  const catT = categoryPolicyTarget(config, products, stock, dest, pid, size);
  if (catT) return catT;
  // ── FOOTWEAR RULE (2026-07-30) ─────────────────────────────────────────────
  // Evaluated BEFORE the clothing kill switch below — see footwearTargetsEnabled
  // for why that ordering is load-bearing (a shared early-return would couple the
  // two switches). Structurally identical to the clothing rule otherwise: the
  // location's standard run applied to every catalog size the location carries.
  //
  // reorderPoint comes FROM CONFIG here, unlike the clothing rule which pins it
  // to null. Footwear is being switched on across an existing 6,445-cell estate,
  // and at reorderPoint null the first scan proposes 993 intents at once (measured
  // 2026-07-30). A reorderPoint of 0 — propose only when a cell hits zero — cuts
  // that to 578 and is the intended launch setting. It is read per location so the
  // throttle can be relaxed later without a deploy. Absent/garbage → null → the
  // eager below-target behaviour, matching resolveTarget's existing fail-safe
  // direction (over-order visibly rather than starve silently).
  const fp = products?.[pid];
  if (footwearTargetsEnabled(config, dest) && isFootwear(fp) && storeCarries(stock, dest, pid)) {
    if (productSizes(products, pid).includes(size)) {
      const run = config?.footwearRunByLocation?.[dest] || {};
      // encodeSizeKey, NOT the raw size — RTDB rejects "." in a key, so the half
      // size 5.5 can only be STORED in config as "5_5" (same encoding as the
      // /stock cell it governs; see sizeKey.js and the epoch-ms key note above).
      // A raw `run[size]` lookup would silently miss every half size: 538 live
      // cells holding 865 units, the second-largest size band in the catalogue,
      // would read as "no target" and never be replenished. The clothing rule
      // above is unaffected either way because letter sizes encode to themselves.
      const t = run[encodeSizeKey(size)];
      if (typeof t === "number" && t > 0) {
        const rp = config?.footwearReorderPoint?.[dest];
        return {
          target: t,
          minQty: Math.max(1, t - 1),
          reorderPoint: typeof rp === "number" && Number.isFinite(rp) && rp >= 0 ? rp : null,
          source: "footwear_default",
        };
      }
    }
  }
  if (!ruleTargetsEnabled(config, dest)) return null;   // ← kill switch
  // Global clothing rule: apply the location's standard run to every catalog
  // size, but only where the store actually carries the product.
  const p = products?.[pid];
  if (isClothing(p) && storeCarries(stock, dest, pid)) {
    const sizes = productSizes(products, pid);
    if (sizes.includes(size)) {
      // MORE SPECIFIC WINS: a subcategory policy overrides the size run for the
      // products it names. Today that decides exactly two live records — the two
      // watches mis-filed with garment sizes S and M — and it resolves both to
      // the same 2 the size run would have given them at Trophy/PE, so this
      // ordering changes no live cell. It is written this way so "watches keep 2"
      // stays true of EVERY watch, including any future one that arrives with a
      // stray letter size, instead of silently falling back to the garment run.
      //
      // A BLANK size is refused. It reads as another spelling of one-size, but
      // the encodings disagree exactly where it matters: stockSizeKey("") is the
      // "_" cell that holds the stock, while encodeSizeKey("") is "" — so a
      // policy honoured here would chase a phantom "" cell that can never be
      // filled while the real units sit in "_". The size run never reached this
      // case (no run has a "" key), so the policy must not introduce it. No live
      // product has a blank size today; this keeps it harmless if one is created.
      const subT = typeof size === "string" && size.trim() !== ""
        ? subcategoryRun(config, products, pid, dest)
        : null;
      if (subT !== null) {
        return { target: subT, minQty: Math.max(1, subT - 1), reorderPoint: null, source: "subcategory_default" };
      }
      const run = config?.defaultRunByStore?.[dest] || {};
      const t = run[size];
      if (typeof t === "number" && t > 0) {
        // Rule-based targets carry NO reorder point — the standard run is a
        // top-up policy, and inventing one here would change clothing behaviour
        // network-wide from a code default rather than from an approved row.
        return { target: t, minQty: Math.max(1, t - 1), reorderPoint: null, source: "default" };
      }
    }
  }
  return null;
}

// ── the plan ──────────────────────────────────────────────────────────────────
function computeRefillPlan(snapshot) {
  const {
    nowMs, config, targets = {}, stock = {}, products = {},
    openIndex = {}, refillRequests = {}, orders = {}, movements = [],
    targetDecisions = {},   // /stock_targets_decisions — "keep as is" acks from the No Target queue
    rejectStreak = {},      // /refill_engine/rejectStreak — persisted reject-while-stock-shown counters (loop guard)
    retryState = {},        // /refill_engine/retryState — persisted rejected-request retry state
    heldLines = {},         // /settings/stockHold/held — central→hub credits parked in transit (count-integrity hold lane)
  } = snapshot;

  const errors = [];
  const routes = config?.routes || {};
  // Dests ordered so downstream (stores) compute before their source when the
  // source is itself a dest (hub2) — pass-through demand must land first.
  const dests = Object.keys(routes).sort((a, b) => {
    if (routes[a] === b) return -1;
    if (routes[b] === a) return 1;
    return a.localeCompare(b);
  });

  const ctx = { targets, config, products, stock };

  // ── inbound & reservations from EXISTING open intents ──────────────────────
  // inbound[dest|pid|size] = qty already on its way. Manual (human-placed) Shop
  // Refill order lines count as inbound too, so the engine never duplicates a
  // request a shop just placed — engine-created orders carry autoRefill:true and
  // are already represented by their open lock, so they're excluded here.
  const inbound = new Map();
  // v9: units at a SOURCE already promised to open requests — a second
  // destination must never get a card for the same physical unit.
  const sourceReserved = new Map();
  const bump = (map, key, q) => map.set(key, (map.get(key) || 0) + q);
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        bump(inbound, `${dest}|${pid}|${sizeKey}`, num(entry.qty) || 1);
        const s = entry.source || routes[dest];
        if (s) bump(sourceReserved, `${s}|${pid}|${sizeKey}`, num(entry.qty) || 1);
      }
    }
  }
  for (const o of Object.values(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.autoRefill) continue;
    if (o.clothingRefillStatus != null || o.status !== "incoming") continue;
    if (!o.destShop || !o.productId || o.size == null) continue;
    bump(inbound, `${o.destShop}|${o.productId}|${encodeSizeKey(o.size)}`, num(o.qty) || 1);
  }
  // HELD central→hub credits (count-integrity hold lane, 2026-08-12): a fulfil
  // with holding on deducts the source and parks the units at stock/in_transit
  // until the owner releases the physical box. The request is CLOSED as
  // fulfilled — so without this walk the same scan would see the destination
  // still short, no lock, no inbound, and raise a brand-new request for every
  // held cell. A held line IS inbound until it is released or withdrawn.
  // No sourceReserved leg: the units already left the source cell at fulfil.
  for (const [dest, byLine] of Object.entries(heldLines || {})) {
    for (const line of Object.values(byLine || {})) {
      if (!line || !line.productId || (line.sizeKey == null && line.size == null)) continue;
      const sizeKey = line.sizeKey != null ? String(line.sizeKey) : encodeSizeKey(line.size);
      bump(inbound, `${dest}|${line.productId}|${sizeKey}`, num(line.qty) || 1);
    }
  }

  // ── reconcile: close locks whose intent finished; flag stale ones (L6) ─────
  const closes = [];
  const resizes = [];   // owner approval 2026-07-13: open requests track reality, not history
  // PLAN-SIDE OBSERVABILITY (2026-07-28). PR #286 instrumented the APPLY drops,
  // but this suppression happens during PLANNING and reported nothing at all —
  // the plan simply came back empty. That gap cost a full day of investigation
  // aimed at the wrong half of the pipeline: the apply path was working
  // correctly throughout while the planner silently discarded every store-leg
  // resize. Same reason discipline as counts.resizeDropped, so both halves of
  // the pipeline are legible from the run record.
  const resizeSuppressed = {};
  const noteSuppressed = (why) => { resizeSuppressed[why] = (resizeSuppressed[why] || 0) + 1; };
  const stuckRefills = [];
  // Orders with PHYSICAL fulfilment evidence in the ledger (a movement linked
  // to them) — their status write may still be in flight, so the PLAN skips
  // withdrawing them. NOTE: this is plan-level advisory only — the actual
  // safety boundary is the conditional transaction in refill-scan.cjs that
  // re-reads the order live at write time. Never relax that guard because
  // this set exists (it is built from the same stale snapshot).
  // ── LEDGER-LINK IDENTITY (fixed 2026-07-28) ────────────────────────────────
  // This was a bare `Set` of movement link.orderId values, asked `.has(orderId)`,
  // and treated a match as proof that a pick had physically happened. That broke
  // the invariant stated at the top of this file (line 17): "R-numbers are
  // daily-recycled and are never identity." An order id is a LABEL the system
  // reissues every single day — R001..R999 — so across the 45-day movement
  // window the same string names dozens of unrelated orders.
  //
  // Measured on live data the day this was fixed: 6,160 movements in the window
  // carried a link.orderId, and ZERO of them were a genuine in-flight signal for
  // any open lock. "R026-1" alone appeared on 9 movements spanning 10 days,
  // every one a different product. 69 of 180 open store-leg locks (38%) were
  // flagged in-flight by a stranger's movement and could not be resized.
  //
  // That is also why the failure GREW: on 2026-07-13 the window held a few days
  // of movements and 161 resizes landed; every day after added ~1,000 more
  // movements minting more label collisions, until store-leg resizes stopped
  // almost entirely. No commit caused it — the window filled up.
  //
  // The fix is the identity check this file already uses elsewhere. orderIsOurs
  // (below) matches product + size + createdAt precisely because a label is not
  // an identity; this index now applies the same rule, plus an AGE BOUND: a
  // movement cannot belong to an order that did not exist when it was written.
  // The anchor is entry.orderCreatedAt — the value stored on the LOCK, which
  // orderIsOurs already trusts — never order.createdAt, which may belong to a
  // recycled node.
  const touchedByOrder = new Map();
  for (const m of movements) {
    const oid = m?.link?.orderId;
    if (!oid) continue;
    const arr = touchedByOrder.get(oid) || [];
    arr.push({ pid: m.productId, sizeKey: encodeSizeKey(m.size), ts: m.ts || m.appliedAt || "" });
    touchedByOrder.set(oid, arr);
  }
  // True only when a movement plausibly belongs to THIS lock's order: same
  // product, same size, and written at or after the order existed.
  //
  // NO ANCHOR → NOT TOUCHED, and that branch is unreachable in the resize path
  // by construction: a lock carrying an orderId whose orderCreatedAt does not
  // match its order node fails orderIsOurs, which makes orderLost true, which
  // closes the lock and `continue`s well before inFlight is consulted (the
  // zombie-leg rule, #234). So whenever this is reached with an orderId, the
  // anchor is present and already verified against the order node. Returning
  // false is the honest answer for the impossible case rather than a silent
  // fallback that would quietly reintroduce label-only matching.
  const ledgerTouched = (entry, pid, sizeKey) => {
    if (!entry?.orderId || !entry.orderCreatedAt) return false;   // hub legs carry no order — never touched
    const hits = touchedByOrder.get(entry.orderId);
    if (!hits) return false;
    return hits.some((h) => h.pid === pid && h.sizeKey === sizeKey && h.ts && h.ts >= entry.orderCreatedAt);
  };
  const staleMs = (num(config?.staleIntentHours) || 48) * 3600e3;
  // Total on-hand for a (pid,size) across every location the scan can see.
  const networkQtyOf = (pid, size) =>
    Object.keys(stock).reduce((t, loc) => t + avail(cellQty(stock, loc, pid, size)), 0);
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      for (const [sizeKey, entry] of Object.entries(bySize || {})) {
        if (!entry) continue;
        // ORPHANED PENDING LOCK self-heal: a scan that died between claiming a
        // lock and creating its request (function timeout, crash) leaves
        // pending:true with no refillId — phantom inbound that would suppress
        // the cell forever while merely being reported stale. Any pending lock
        // older than an hour can't belong to a live run (run-lock steal is
        // 10 min) → remove it; the released inbound lets the deficit re-propose
        // in this very plan. Younger pending locks stay untouched (in-flight).
        if (entry.pending && !entry.refillId) {
          if (nowMs - Date.parse(entry.createdAt || 0) > 3600e3) {
            closes.push({ dest, pid, sizeKey, refillId: null, reason: "orphaned_pending" });
          }
          continue;
        }
        const rr = entry.refillId ? refillRequests[entry.refillId] : null;
        const order = entry.orderId ? orders[entry.orderId] : null;
        // The order node is only "ours" if it still matches — R-numbers recycle
        // daily, so a same-key node created later is a DIFFERENT order.
        const orderIsOurs = order && order.productId === pid &&
          encodeSizeKey(order.size) === sizeKey && order.createdAt === entry.orderCreatedAt;
        // ZOMBIE LEG (owner decision 2026-07-16): a store leg whose /orders
        // node is GONE (or was recycled by the daily R-number reset into a
        // different order) can never resolve — its clothingRefillStatus lived
        // on the lost node, so unresolvedOurs is false and every branch below
        // skips the entry forever, while the lock keeps suppressing re-proposal
        // for that product+size (found live 2026-07-16: 26 such requests, some
        // with REAL unmet need that the engine could no longer re-ask for).
        // Withdraw it: cancel the request, drop the lock. Stateless self-heal —
        // if the deficit is still real, the very next scan re-proposes a fresh
        // request + order. removeOrderId is deliberately NOT set: a same-key
        // node, when present, belongs to a DIFFERENT (later) order.
        const orderLost = entry.orderId && !orderIsOurs && rr && rr.status === "open";
        if (orderLost) {
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId,
            reason: "order_lost", cancelReason: "order_lost", rrStatus: "cancelled",
          });
          continue;
        }
        const size = order?.size ?? rr?.size ?? (sizeKey === "_" ? "" : sizeKey);
        const destHave = avail(cellQty(stock, dest, pid, size));
        const unresolvedOurs = (orderIsOurs && order.clothingRefillStatus == null) || (!entry.orderId && rr && rr.status === "open");
        // SELF-REVERSAL (owner rule 2026-07-13): stock can arrive by paths the
        // engine didn't plan — a manual Central→shop transfer, a direct stock
        // add, a bulk customer return. If the destination no longer NEEDS this
        // request (target met counting all OTHER inbound), the engine withdraws
        // its own ask — order deleted, request cancelled — instead of letting
        // the warehouse deliver a surplus.
        const t = unresolvedOurs ? resolveTarget(ctx, dest, pid, size) : null;
        const otherInbound = Math.max((inbound.get(`${dest}|${pid}|${sizeKey}`) || 0) - (num(entry.qty) || 1), 0);
        const needGone = unresolvedOurs && (!t || t.target <= 0 || t.target - destHave - otherInbound <= 0);
        // Certainly-unfillable PURGE (owner rule 2026-07-13): zero stock
        // anywhere upstream → withdrawn; staff never see unpickable requests.
        const unfillable = unresolvedOurs && networkQtyOf(pid, size) - destHave <= 0;
        // ACTIONABLE-ONLY withdraw (owner v9, 2026-07-13): an open engine
        // request whose SOURCE can no longer fulfil it (sold out / never had
        // it) leaves the working queue — staff must never scroll past work
        // they can't do. Self-withdrawal, so NO cooldown: the moment the
        // source restocks, the deficit re-proposes automatically (cascade).
        // IN-FLIGHT GUARD: a fulfil attempt that has locked its split
        // (clothingPlanGen) or already partially sent (clothingRefillGen > 0)
        // must never have its card deleted under the picker's hands — the
        // warehouse finishes what it started; the scan only tidies untouched
        // requests.
        // clothingPlanGen = a fulfil attempt locked its split; ledger link = a
        // pick physically happened (status write may lag). Either one parks
        // the withdraw. (clothingRefillGen deliberately NOT used — it only
        // counts UNDOs, not in-progress picks.)
        const inFlightPlanGen = orderIsOurs && order.clothingPlanGen != null;
        const inFlightLedger = ledgerTouched(entry, pid, sizeKey);
        const inFlight = inFlightPlanGen || inFlightLedger;
        const sourceLoc = entry.source || routes[dest];
        const sourceEmpty = unresolvedOurs && !needGone && !unfillable && !inFlight &&
          sourceLoc && avail(cellQty(stock, sourceLoc, pid, size)) <= 0;
        if (needGone || unfillable || sourceEmpty) {
          const why = needGone ? "no_longer_needed" : unfillable ? "unfillable" : "awaiting_upstream";
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId,
            reason: why, cancelReason: why,
            rrStatus: "cancelled",
            removeOrderId: orderIsOurs ? entry.orderId : null,
          });
        } else if (rr && rr.status && rr.status !== "open") {
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId, reason: rr.status,
            // An rr cancelled OUTSIDE the engine without a cancelReason is a
            // human "no" (Hub2RefillQueue reject / manual dismiss — engine
            // self-withdrawals always stamp cancelReason). Without this the
            // hub2 leg would recheck forever with no strike cap (review
            // blocker, PR #252 round 1).
            ...(rr.status === "cancelled" && !rr.cancelReason
              ? { humanReject: true, denier: entry.source || routes[dest] } : {}),
          });
        } else if (orderIsOurs && order.clothingRefillStatus != null) {
          const wasFulfilled = order.clothingRefillStatus === "available";
          closes.push({
            dest, pid, sizeKey, refillId: entry.refillId,
            reason: wasFulfilled ? "fulfilled" : "cancelled",
            rrStatus: wasFulfilled ? "fulfilled" : "cancelled",
            // Human rejection (vs the engine's own withdrawals, which carry
            // cancelReason) — feeds the reject-streak loop guard below.
            ...(wasFulfilled ? {} : { humanReject: true, denier: entry.source || routes[dest] }),
          });
        } else if (nowMs - Date.parse(entry.createdAt || 0) > staleMs) {
          stuckRefills.push({ dest, pid, sizeKey, refillId: entry.refillId || null, ageHours: Math.round((nowMs - Date.parse(entry.createdAt || 0)) / 3600e3) });
        }
        // AUTO-RESIZE (owner approval 2026-07-13): every surviving open request
        // is continuously trued to expected = min(current deficit, source stock
        // net of OTHER reservations, maxUnitsPerIntent). Same request identity,
        // history preserved, never a replacement — a quantity is data, not
        // demand. Skipped while a pick is in flight (retries next scan). An
        // expected of 0 never lands here: the withdraw branches above own the
        // zero cases; the one residue (source stocked but fully reserved by a
        // sibling request) deliberately keeps its quantity until the sibling
        // resolves — deterministic, no claim-stealing between open requests.
        // Count a resize the in-flight guard alone suppressed: everything else
        // that blocks here (needGone / unfillable / sourceEmpty) already emits a
        // visible close, so silence was unique to this branch.
        if (unresolvedOurs && inFlight && !needGone && !unfillable && !sourceEmpty) {
          noteSuppressed(inFlightPlanGen ? "in_flight_plan_gen" : "in_flight_ledger_link");
        }
        if (unresolvedOurs && !inFlight && !needGone && !unfillable && !sourceEmpty) {
          const srcLoc2 = entry.source || routes[dest];
          const srcHave2 = srcLoc2 ? avail(cellQty(stock, srcLoc2, pid, size)) : 0;
          const ownQty = num(entry.qty) || 1;
          const srcKey2 = `${srcLoc2}|${pid}|${sizeKey}`;
          // SHRINK to real demand is always safe (a reduced claim can never
          // overcommit) — no source math needed. GROW only into units that are
          // genuinely unclaimed: srcHave minus the FULL threaded reservation
          // (which this block MUTATES on every decision — Sonnet HIGH
          // 2026-07-13: reading stale reservations let two growing siblings
          // promise 16 units against 10 physical, and a grow + a same-scan new
          // intent overcommit a shared source. Every decision below is
          // immediately visible to later siblings AND to the deficit loop).
          const desired = Math.min(Math.max((t?.target || 0) - destHave - otherInbound, 0), num(config?.maxUnitsPerIntent) || 20);
          // Sequential fair allocation: my share = source on-hand minus what
          // everyone ELSE currently reserves (threaded — later siblings see my
          // decision). If my share is zero but I am oversized, I still shrink
          // to my true demand (a reduced claim can never overcommit) — this is
          // what converges the fully-overcommitted symmetric case instead of
          // freezing it.
          const availForMe = Math.max(srcHave2 - ((sourceReserved.get(srcKey2) || 0) - ownQty), 0);
          let expected = Math.min(desired, availForMe);
          if (expected === 0 && desired > 0) expected = Math.min(desired, ownQty);
          if (expected > 0 && expected !== ownQty) {
            bump(sourceReserved, srcKey2, expected - ownQty);   // thread the decision
            resizes.push({ dest, pid, sizeKey, refillId: entry.refillId || null, orderId: orderIsOurs ? entry.orderId : null, from: ownQty, to: expected });
          }
        }
      }
    }
  }
  // ─── SATISFIED-BY-STOCK WITHDRAWAL (2026-08-07) ────────────────────────────
  // WHY THIS PASS EXISTS — the bug it fixes, stated plainly.
  //
  // Everything above walks `openIndex` (/refill_engine/open). That is the
  // engine's OWN lock table, and it is the only thing the reconcile loop can
  // see. `needGone` on line ~603 already implements the owner's self-reversal
  // rule ("stock can arrive by paths the engine didn't plan — withdraw the
  // ask"), and it works correctly — but ONLY for a request the engine itself
  // created and locked.
  //
  // A /refill_requests row can exist with NO lock, and then nothing on earth
  // closes it but a human. Two populations do exactly that:
  //
  //   1. MISSING SNEAKERS (MissingFootwear.jsx `solve` / `request`) writes
  //      /refill_requests directly — by design, since sneakers must never be
  //      auto-generated. It never claims a lock, so the engine has never once
  //      looked at those rows.
  //   2. ORPHANED ENGINE REQUESTS — a lock removed while its request survived
  //      (a close whose rr transaction bailed, a partially-applied run). Same
  //      end state: an immortal "open".
  //
  // Measured live 2026-08-07: 146 open requests, 26 with no lock, 10 of those
  // already fully covered by stock at their own destination. Timberland Premium
  // 6-Inch Wheat was the reported case — 5 sizes raised into Hub 1 at 20:50 on
  // 2026-08-06, then MANUALLY TRANSFERRED central→hub1 (transfer
  // -OzQ4L7BrRds21dcNgkB, 3 units × 5 sizes) at 07:17 the next morning. The
  // stock was on the shelf; the requests stayed open, and Central kept being
  // told to pick them.
  //
  // SATISFACTION IS A FUNCTION OF THE CELL, NOT OF THE CODE PATH. This pass
  // asks one question of the destination cell — "does it already hold what this
  // request asked for?" — and never asks how it got there. A manual transfer, a
  // supplier receive, a customer return and an engine fulfilment are all the
  // same answer.
  //
  // WHY IT CANNOT CHURN OR LOOP:
  //  • It only ever CANCELS. It never creates work, so it cannot feed itself.
  //  • Cancellation is terminal — a cancelled row is never re-opened by any
  //    code path, and the transaction in refill-scan only fires while the live
  //    row still reads "open". Each request is withdrawn at most once, ever.
  //  • The withdrawal condition is monotone in the right direction: it fires
  //    on stock ARRIVING. A later sale lowering the cell cannot un-cancel
  //    anything, so there is no oscillation.
  //  • It cannot fight the deficit loop below. A re-proposal needs a genuine
  //    target deficit, and this pass only withdraws a request whose need is
  //    already met — the two can never both be true of one cell in one scan.
  //  • It cannot fight the MISSING SNEAKERS screen either: that screen only
  //    shows products with ZERO units at BOTH hubs, and a satisfied cell means
  //    units > 0, so the card that raised this request cannot even be rendered.
  //  • ONE UNIT SATISFIES ONE REQUEST. `claimed` below allocates the cell
  //    oldest-request-first, so two sibling requests on the same cell can never
  //    both be retired by the same physical pair.
  //
  // WHY IT DOES NOT TOUCH LOCKED REQUESTS. A locked request already has
  // `needGone`, which is strictly better informed: it uses the approved TARGET
  // and nets off other inbound, so it keeps a request alive when the shelf has
  // 1 of a target of 3. Withdrawing on the raw request quantity there would
  // silently downgrade the target policy. Locked cells stay with the loop above.
  //
  // WHY IT DOES NOT TOUCH /refill_engine/open. There is no lock to remove — and
  // blindly nulling the lock path for a request that merely SHARES a cell with
  // some other live lock would delete a lock the engine is still relying on.
  // This is applied by its own loop in refill-scan.cjs that writes exactly one
  // node: the request's own status.
  const satisfiedClosures = [];
  {
    // Locked refillIds are owned by the reconcile loop above — skip them here.
    const lockedIds = new Set();
    for (const byPid of Object.values(openIndex)) {
      for (const bySize of Object.values(byPid || {})) {
        for (const entry of Object.values(bySize || {})) {
          if (entry?.refillId) lockedIds.add(entry.refillId);
        }
      }
    }
    // OLDEST FIRST — a deterministic, replayable allocation. Ties break on the
    // request id so two rows stamped in the same millisecond (the engine writes
    // a whole run with one timestamp) still order identically on every scan.
    const openRows = Object.entries(refillRequests)
      .filter(([id, r]) => r && r.status === "open" && !lockedIds.has(id) &&
        r.requestingLocation && r.productId && r.size != null && !r.shadow)
      .sort((a, b) => String(a[1].createdAt || "").localeCompare(String(b[1].createdAt || "")) || a[0].localeCompare(b[0]));
    // LOCKED SIBLINGS CLAIM THEIR UNITS FIRST. A lock on the same cell means
    // those units are already spoken for by a request this pass is not allowed
    // to touch, so an unlocked sibling must not be retired against them. Being
    // over-conservative here costs one extra card on a queue; being
    // under-conservative cancels an ask that — for a Missing Sneakers row —
    // nothing will ever raise again (that screen only shows products with zero
    // units at BOTH hubs, so a covered cell hides the card that created it).
    // (Kimi review, PR #332.)
    const claimed = new Map();
    for (const [dest, byPid] of Object.entries(openIndex)) {
      for (const [pid, bySize] of Object.entries(byPid || {})) {
        for (const [sizeKey, entry] of Object.entries(bySize || {})) {
          if (!entry?.refillId) continue;
          const k = `${dest}|${pid}|${sizeKey}`;
          claimed.set(k, (claimed.get(k) || 0) + Math.max(num(entry.qty) || 1, 1));
        }
      }
    }
    for (const [id, r] of openRows) {
      const dest = r.requestingLocation;
      const sizeKey = encodeSizeKey(r.size);
      // A DEACTIVATED product's lock-less request is withdrawn REGARDLESS of
      // stock (CodeRabbit, PR #445): these rows (Missing Footwear, the on-hold
      // "coming tomorrow" writer) carry no engine lock, so the reconcile
      // loop's needGone can never reach them, and the satisfied path below
      // demands covering stock a finished line will never receive. Stock proof
      // is waived — `deactivated: true` tells the apply pass to skip its
      // live-cell re-check (there is no cell condition to verify).
      if (isDeactivated(products?.[r.productId])) {
        satisfiedClosures.push({
          refillId: id, dest, pid: r.productId, sizeKey, size: r.size,
          qty: 0, have: 0, rrStatus: "cancelled", cancelReason: "no_longer_needed",
          deactivated: true,
        });
        continue;
      }
      // A destination the scan did not load has NO stock in `stock` and would
      // read as 0 — silence, not a wrong withdrawal. Being explicit anyway, so
      // a future route change can never turn "not loaded" into "not needed".
      if (!Object.prototype.hasOwnProperty.call(stock, dest)) continue;
      const k = `${dest}|${r.productId}|${sizeKey}`;
      const free = avail(cellQty(stock, dest, r.productId, r.size)) - (claimed.get(k) || 0);
      const want = Math.max(num(r.qty) || 1, 1);
      if (free < want) continue;
      claimed.set(k, (claimed.get(k) || 0) + want);
      satisfiedClosures.push({
        refillId: id, dest, pid: r.productId, sizeKey, size: r.size,
        qty: want, have: avail(cellQty(stock, dest, r.productId, r.size)),
        rrStatus: "cancelled", cancelReason: "already_in_stock",
      });
    }
  }

  // Manual refill lines stuck too long are equally worth surfacing.
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.autoRefill) continue;
    if (o.clothingRefillStatus != null || o.status !== "incoming") continue;
    if (nowMs - Date.parse(o.createdAt || 0) > staleMs) {
      stuckRefills.push({ dest: o.destShop || null, pid: o.productId || null, sizeKey: encodeSizeKey(o.size), orderId: id, manual: true, ageHours: Math.round((nowMs - Date.parse(o.createdAt || 0)) / 3600e3) });
    }
  }
  // A lock being closed THIS scan no longer holds real inbound units — release
  // them so the deficit is honest in the SAME pass (a rejected ask whose stock
  // just arrived re-plans now, not 15 minutes later). Releasing fulfilled
  // closes is equally safe: their units are already inside destHave.
  for (const c of closes) {
    const entry = openIndex[c.dest]?.[c.pid]?.[c.sizeKey];
    if (!entry) continue;
    const k = `${c.dest}|${c.pid}|${c.sizeKey}`;
    const left = (inbound.get(k) || 0) - (num(entry.qty) || 1);
    if (left > 0) inbound.set(k, left); else inbound.delete(k);
    // Release the SOURCE reservation too — a closed lock frees its units for
    // siblings and new intents in this same pass (symmetric with inbound).
    const sLoc = entry.source || routes[c.dest];
    if (sLoc) {
      const sk = `${sLoc}|${c.pid}|${c.sizeKey}`;
      const sLeft = (sourceReserved.get(sk) || 0) - (num(entry.qty) || 1);
      if (sLeft > 0) sourceReserved.set(sk, sLeft); else sourceReserved.delete(sk);
    }
  }

  // ── managed universe per dest: explicit targets + clothing products the store carries ──
  // Both honour the kill switch: with rule-based targets off, the universe
  // collapses back to exactly the explicit-target keys (v5 behaviour), so the
  // engine does not even walk the ~6,000 rule-only cells. resolveTarget would
  // return null for them anyway — this keeps the scan cheap as well as correct.
  // FOOTWEAR (2026-07-30) rides the same two helpers on its OWN switch. Both
  // classes must be admitted here or resolveTarget is never even consulted for
  // them — the deficit loop walks managedPids × sizesFor, so a target that
  // resolves correctly still yields nothing if the pid never enters this set.
  // When footwear is off, every expression below reduces to the original
  // clothing-only form (see the tests pinning deep-equality of the clothing plan).
  // A product that somehow satisfied BOTH predicates would be treated as
  // clothing, matching resolveTarget's branch order.
  const managedPids = (dest) => {
    const out = new Set(Object.keys(targets?.[dest] || {}));
    const ruleOn = ruleTargetsEnabled(config, dest);
    const footOn = footwearTargetsEnabled(config, dest);
    // CATEGORY POLICY (2026-08-13): a mapped category's products are managed at
    // the mapped locations UNCONDITIONALLY — no carriage gate, exactly like
    // explicit-target keys, because the category IS the owner's arming act. A
    // stranded perfume with no cell anywhere must still resolve its buffer
    // target at hub2 or the standing policy would only govern products someone
    // had already introduced by hand — the per-product step it abolishes. The
    // map is empty in production until the owner writes it, so this admits
    // nothing by default; and it survives the kill switches below by the same
    // reasoning resolveTarget's branch order does.
    const catOn = config?.categoryPolicy && typeof config.categoryPolicy === "object";
    if (!ruleOn && !footOn && !catOn) return out;
    for (const [pid, p] of Object.entries(products || {})) {
      if (catOn && categoryPolicyEntry(config, products, stock, pid, dest)) { out.add(pid); continue; }
      if (!storeCarries(stock, dest, pid)) continue;
      if (ruleOn && isClothing(p)) out.add(pid);
      else if (footOn && isFootwear(p)) out.add(pid);
    }
    return out;
  };
  const sizesFor = (dest, pid) => {
    const out = new Set(Object.keys(targets?.[dest]?.[pid] || {}));
    const ruleOn = ruleTargetsEnabled(config, dest);
    const footOn = footwearTargetsEnabled(config, dest);
    // Mapped sizes ride along regardless of the switches, mirroring
    // managedPids: one-size mode walks the "_" cell alone (letters stay the
    // clothing rules' business and are added below only when those rules
    // manage this product); per-size mode walks every declared size —
    // resolveTarget then answers 0 for the dead ones, and the deficit loop's
    // `target <= 0` guard skips them at nearly zero cost.
    const cat = categoryPolicyEntry(config, products, stock, pid, dest);
    if (cat) {
      // A per-size MAP walks exactly the sizes it names, intersected with what
      // the product declares — categoryPolicyTarget refuses an undeclared size
      // anyway, and walking it would cost a resolveTarget call per phantom cell
      // on every product in the category.
      if (cat.sizes) {
        const declared = new Set(productSizes(products, pid).map(encodeSizeKey));
        for (const k of Object.keys(cat.sizes)) if (declared.has(k)) out.add(k);
      } else if (cat.perSize) for (const s of productSizes(products, pid)) out.add(encodeSizeKey(s));
      else out.add("_");
    }
    if (!ruleOn && !footOn) return out;
    const p = products?.[pid];
    const managedHere = (ruleOn && isClothing(p)) || (footOn && isFootwear(p));
    if (managedHere && storeCarries(stock, dest, pid)) {
      for (const s of productSizes(products, pid)) out.add(encodeSizeKey(s));
    }
    return out;
  };
  // Encoded key → raw size (clothing letters are identity; keep a map anyway).
  // The catalogue-miss fallback DECODES ("5_5"→"5.5") rather than passing the
  // encoded key through: `size` fields on requests/orders are raw-size space,
  // and an encoded value there renders as "5_5" and misses every availability
  // lookup in the app (which indexes decoded cell maps by raw size).
  const rawSize = (pid, sizeKey) => {
    for (const s of products?.[pid]?.sizes || []) if (encodeSizeKey(s) === sizeKey) return String(s);
    return sizeKey === "_" ? "" : String(sizeKey).replace(/(\d)_(\d)/g, "$1.$2");
  };

  // ── REJECT STREAK — loop-guard state (incident 2026-07-19: wrong shelf) ─────
  // A human "no" while the denier's counted cell still SHOWS stock is a
  // count-vs-shelf mismatch signal. Each reconciled human rejection either
  // increments the cell's persisted streak (stock still claimed — evidence of
  // mismatch) or resets it (denier genuinely empty — the "no" agrees with the
  // database, nothing suspicious). Fulfilment resets too. The streak is the
  // ONLY persisted rejection state — the cooldown map above stays stateless.
  // The scan applies these ops to /refill_engine/rejectStreak after closes.
  const streakOf = (d, p, s) => rejectStreak?.[d]?.[p]?.[s] || null;
  const streakOps = [];
  const retryOps = [];   // retryState + retryHistory writes for the 24h auto-retry
  const nowIso = new Date(nowMs).toISOString();
  const retryOf = (d, p, s) => retryState?.[d]?.[p]?.[s] || null;
  // Close-derived ops are ATTACHED to each close (c.streakOp) by the loop
  // further down (after the arrival-lift/staleness machinery it needs is in
  // scope). The scan applies them in the SAME multi-path update as that
  // close's lock removal, so a lost fulfilment-reset re-emerges with the
  // close itself on the next scan (the lock still exists) instead of being a
  // one-shot event — the old separate-bulk-write design's real failure mode.
  // (Withdraw-type closes, the ones whose order txn can bail, never carry a
  // streakOp — the branches are mutually exclusive — so bailing isn't the
  // scenario this protects against.) Only the deficit-loop's self-heal resets
  // — recomputable from live state every scan — travel via the streakOps
  // array. KNOWN RESIDUAL (accepted, review round 3): an inc's count is an
  // absolute cur+1 from the snapshot — staff clearing the node in the seconds
  // between snapshot and write get it recreated for one cycle; tapping clear
  // again resolves.

  // ── deficits (L1/L2/L4) — propose, don't suppress ───────────────────────────
  // Owner philosophy (2026-07-12 v3): the warehouse is the validation layer.
  // A deficit ALWAYS becomes a request (system availability is advisory — real
  // shelves beat database cells); staff fulfil or reject per size. The only
  // suppressors are: an intent already open for the cell, and a recent
  // warehouse REJECTION of the same cell (cooldown, so a "no" isn't re-asked
  // every 15 minutes). Zero-stock-anywhere still surfaces as a missing-size
  // reorder candidate IN ADDITION to the request.
  const intents = [];
  const belowTarget = [];
  const missingSizes = [];
  const waitingForStock = [];   // demand parked behind a rejection — never silently dropped
  const awaitingUpstream = [];  // v9: source empty but the chain is flowing — auto-creates when it lands
  const awaitingSupplier = [];  // v9: whole upstream chain empty — supplier reorder / excess return
  const recountNeeded = [];     // loop guard: rejected N× while the denier's count claims stock — recount, don't re-ask
  let managedCells = 0;   // cells with a resolvable target > 0 (Health-score denominator)
  // Counted SEPARATELY and deliberately kept OUT of managedCells: HealthView uses
  // stats.managedCells as the Health-score denominator, and footwear adds ~6,445
  // managed cells against clothing's ~8,400 — folding them in would move the
  // displayed score for reasons that have nothing to do with clothing health, the
  // moment footwearTargets is enabled. Sneakers have their own tab and their own
  // rule; they get their own metric. (CodeRabbit #289.)
  let footwearManagedCells = 0;
  const maxUnits = num(config?.maxUnitsPerIntent) || 20;

  // Rejection cooldown: (dest|pid|sizeKey) → { ts, by } — the most recent human
  // rejection AND the location that physically said no (recorded on the record
  // itself: order.placedAtHub / rr.source; falls back to the CURRENT route for
  // legacy data). The arrival lift must watch the location that denied, not
  // whatever the route happens to be today — topology is config and can change.
  const cooldownMs = (num(config?.rejectCooldownHours) || 24) * 3600e3;
  // RE-CHECK ON REJECT (incident 2026-07-19): when the denier's counted cell
  // STILL shows stock after a "no", the full cooldown is wrong both ways —
  // either the count is stale (don't wait a day to find out) or the item is
  // physically there on another shelf (re-ask soon). Those cells rest a SHORT
  // recheck window instead; the loop guard below stops the cycle at N strikes.
  const recheckMs = Math.max(1, num(config?.recheckCooldownMinutes) || 30) * 60e3;   // clamped: 0/negative would spam every scan
  const streakLimit = Math.max(1, num(config?.rejectStreakLimit) || 3);              // clamped: ≤0 would flag on the first strike
  // One definition of the evidence-based window — used by the propose gate AND
  // the srcParked labelling so they can never drift apart.
  const effWindowMs = (denierHas) => (denierHas > 0 ? recheckMs : cooldownMs);
  const rejectedAt = new Map();
  const setDenial = (map, key, ts, by) => {
    const cur = map.get(key);
    if (!cur || ts > cur.ts) map.set(key, { ts, by: by || null });
  };
  // Confirmed-out learning (owner rule 2026-07-13): a human "not available" at
  // BOTH supply levels beats the counted cells. Track the latest denial per
  // (pid|sizeKey) at each level — SHOP level (a Shop Refill line rejected by
  // the hub2 warehouse, or a cancelled store-destined request) and CENTRAL
  // level (a cancelled hub2 request — Central's Hub 2 Refill queue said no).
  const rejShopLevel = new Map();
  const rejCentralLevel = new Map();
  for (const o of Object.values(orders)) {
    if (!o || o.customerName !== "Shop Refill" || o.clothingRefillStatus !== "rejected") continue;
    if (!o.destShop || !o.productId || o.size == null) continue;
    const ts = Date.parse(o.clothingOutOfStockAt || o.updatedAt || 0) || 0;
    const by = o.placedAtHub || o.hub || routes[o.destShop] || null;
    const k = `${o.destShop}|${o.productId}|${encodeSizeKey(o.size)}`;
    setDenial(rejectedAt, k, ts, by);
    const lk = `${o.productId}|${encodeSizeKey(o.size)}`;
    setDenial(rejShopLevel, lk, ts, by);
  }
  for (const [id, rr] of Object.entries(refillRequests)) {
    if (!rr || rr.status !== "cancelled" || !rr.requestingLocation || !rr.productId) continue;
    // Engine self-withdrawals (unfillable / no_longer_needed) are NOT human
    // rejections — they must never impose a cooldown. If the shop dips below
    // target again five minutes later, the engine may re-ask immediately.
    if (rr.cancelReason) continue;
    const ts = Date.parse(rr.resolvedAt || 0) || 0;
    const by = rr.source || rr.createdFrom?.source || routes[rr.requestingLocation] || null;
    const k = `${rr.requestingLocation}|${rr.productId}|${encodeSizeKey(rr.size)}`;
    setDenial(rejectedAt, k, ts, by);
    const lk = `${rr.productId}|${encodeSizeKey(rr.size)}`;
    const levelMap = rr.requestingLocation === "hub2" ? rejCentralLevel : rejShopLevel;
    setDenial(levelMap, lk, ts, by);
  }

  // ── ARRIVAL LIFT (owner rule 2026-07-13: requests are LIVE demand) ──────────
  // A human "not available" is trusted only until stock demonstrably ARRIVES at
  // the location that said no. Any inbound ledger movement — supplier receive,
  // return, positive adjustment, either transfer leg — newer than the denial is
  // fresh physical evidence that beats the stale "no": the demand re-asks on
  // the very next scan instead of resting out the cooldown / confirmed-out
  // window. arrivedAt: (loc|pid|sizeKey) → latest inbound movement ts there.
  // (Movement types whose `to` gains stock mirror applyMovement's cellDeltas;
  // transfers carry a REAL from+to — no in_transit hop — so both legs count.)
  // Only cells with an active denial can need lift evidence, so the map covers
  // exactly those (pid|size) pairs — not every movement in the 45-day window.
  // Where the ledger recorded the resulting balance, it must be POSITIVE: an
  // arrival that leaves the cell at ≤0 (the Negative Inventory "Fix → 0"
  // adjustment, a receive into a deep oversell hole) created no pickable stock
  // and lifts nothing.
  const INBOUND_TYPES = new Set(["received", "opening", "return", "adjustment", "transfer_in", "transfer_out"]);
  const deniedPairs = new Set([...rejShopLevel.keys(), ...rejCentralLevel.keys()]);
  for (const k of rejectedAt.keys()) deniedPairs.add(k.slice(k.indexOf("|") + 1));
  const arrivedAt = new Map();
  for (const m of movements) {
    if (!m || !m.to || !m.productId || m.size == null) continue;
    if (!INBOUND_TYPES.has(m.type) || num(m.qty) <= 0) continue;
    const sizeKey = encodeSizeKey(m.size);
    if (!deniedPairs.has(`${m.productId}|${sizeKey}`)) continue;
    const afterTo = m.after?.[m.to];
    if (typeof afterTo === "number" && afterTo <= 0) continue;
    const ts = Date.parse(m.ts || 0) || 0;
    const k = `${m.to}|${m.productId}|${sizeKey}`;
    if (ts > (arrivedAt.get(k) || 0)) arrivedAt.set(k, ts);
  }
  const arrivedAfter = (loc, pid, sizeKey, ts) =>
    (arrivedAt.get(`${loc}|${pid}|${sizeKey}`) || 0) > ts;
  // Both levels denied within the window (default 14 days) → the size is OUT
  // no matter what the cells claim: no requests to ANY destination, straight
  // to the Missing Sizes reorder list. When the window lapses, the normal
  // cooldown cycle resumes — one re-ask; two fresh denials re-confirm it out.
  // Clamped ≥1 day: a 0/negative config value would make EVERY denial and
  // streak instantly "stale" — silently disabling both confirmed-out and the
  // reject-streak loop guard (review round 3).
  const confirmedOutMs = Math.max(1, num(config?.confirmedOutDays) || 14) * 86400e3;
  // Route-derived fallbacks for LEGACY denial records that carry no source of
  // their own: Central (hub2's source) denies hub2 asks; the stores' sources
  // deny store asks. Denials recorded with a `by` use that exact location.
  const centralLevelLoc = routes["hub2"] || "central";
  const shopLevelLocs = [...new Set(dests.filter((d) => d !== "hub2").map((d) => routes[d]).filter(Boolean))];
  const confirmedOut = (pid, sizeKey) => {
    const lk = `${pid}|${sizeKey}`;
    const c = rejCentralLevel.get(lk);
    const s = rejShopLevel.get(lk);
    if (!c || !s || nowMs - c.ts >= confirmedOutMs || nowMs - s.ts >= confirmedOutMs) return false;
    // Stock arrived at the denying location AFTER it said no → no longer
    // confirmed out: one re-ask resumes (two fresh denials re-confirm it out).
    if (arrivedAfter(c.by || centralLevelLoc, pid, sizeKey, c.ts)) return false;
    if (s.by ? arrivedAfter(s.by, pid, sizeKey, s.ts)
             : shopLevelLocs.some((l) => arrivedAfter(l, pid, sizeKey, s.ts))) return false;
    return true;
  };

  const networkQty = (pid, size) =>
    Object.keys(stock).reduce((t, loc) => t + avail(cellQty(stock, loc, pid, size)), 0);

  // ── streak flag evaluation (loop guard) ─────────────────────────────────────
  // A cell is PARKED by the guard when its streak is at limit AND the denier's
  // cell still counts stock AND nothing has arrived since the last strike. A
  // dormant streak older than the ledger window can't be cross-checked against
  // arrivals (movements read is windowed) — reset it rather than flagging a
  // months-old mismatch nobody remembers. `resetWorthy` streaks are cleared by
  // the caller so the cell resumes normal cooldown handling.
  // Staleness aligned with the confirmed-out window: human "no" evidence
  // expires at ONE rate everywhere (and stays inside the ledger read window,
  // so arrival-lift evidence always covers a live streak).
  const streakState = (loc, pid, sizeKey, size, fallbackDenier) => {
    const s = streakOf(loc, pid, sizeKey);
    if (!s) return { flagged: false };
    const ts = Date.parse(s.lastTs || 0) || 0;
    // Staleness applies to EVERY streak, not only at-limit ones — otherwise
    // strikes 1–2 could age for months and a fresh single rejection would
    // flag "3× rejected" on evidence nobody remembers.
    if (nowMs - ts > confirmedOutMs) return { flagged: false, resetWorthy: true };
    if (num(s.count) < streakLimit) return { flagged: false };
    const denier = s.by || fallbackDenier;
    const has = denier ? avail(cellQty(stock, denier, pid, size)) : 0;
    if (has <= 0 || arrivedAfter(denier, pid, sizeKey, ts)) {
      return { flagged: false, resetWorthy: true };
    }
    return { flagged: true, count: num(s.count), denier, has };
  };

  // Attach streak ops to the reconciled closes (see the streakOf block above
  // for why they ride the close). A fresh strike CONTINUES the persisted
  // streak only while its prior evidence is still live — a stale streak or
  // one lifted by a demonstrated arrival restarts the count at 1, so expired
  // strikes never combine with a fresh "no" into a premature flag.
  for (const c of closes) {
    if (c.reason === "fulfilled") {
      if (streakOf(c.dest, c.pid, c.sizeKey)) c.streakOp = { op: "reset" };
      // Fulfilment clears the retry state too — the cell is satisfied.
      if (retryOf(c.dest, c.pid, c.sizeKey)) retryOps.push({ dest: c.dest, pid: c.pid, sizeKey: c.sizeKey, op: "reset" });
      continue;
    }
    if (!c.humanReject) continue;
    const cDenier = c.denier || routes[c.dest];
    const cSize = rawSize(c.pid, c.sizeKey);
    const cDenierHas = cDenier ? avail(cellQty(stock, cDenier, c.pid, cSize)) : 0;
    const sPrev = streakOf(c.dest, c.pid, c.sizeKey);
    if (cDenierHas > 0) {
      let cur = 0;
      if (sPrev) {
        const pts = Date.parse(sPrev.lastTs || 0) || 0;
        const prevDenier = sPrev.by || cDenier;
        if (nowMs - pts <= confirmedOutMs && !arrivedAfter(prevDenier, c.pid, c.sizeKey, pts)) cur = num(sPrev.count) || 0;
      }
      c.streakOp = { op: "inc", count: cur + 1, ts: nowIso, by: cDenier };
    } else if (sPrev) {
      c.streakOp = { op: "reset" };
    }
    // 24h auto-retry tracking: record the rejection and schedule the next retry.
    const rPrev = retryOf(c.dest, c.pid, c.sizeKey);
    const retryCount = (rPrev?.retryCount || 0) + 1;
    retryOps.push({
      dest: c.dest, pid: c.pid, sizeKey: c.sizeKey, op: "reject",
      retryCount,
      firstRejectedAt: rPrev?.firstRejectedAt || nowIso,
      lastRejectedAt: nowIso,
      nextRetryAt: new Date(nowMs + cooldownMs).toISOString(),
      lastRejectionReason: c.cancelReason || c.reason || "rejected",
      source: cDenier,
    });
    retryOps.push({
      dest: c.dest, pid: c.pid, sizeKey: c.sizeKey, op: "history",
      type: "rejection", timestamp: nowIso,
      rejectionReason: c.cancelReason || c.reason || "rejected",
      retryAttempt: retryCount, source: cDenier, destination: c.dest,
      qty: num(c.qty) || 1,
    });
  }

  for (const dest of dests) {
    const mode = config?.mode?.[dest] || "off";
    const src = routes[dest];
    for (const pid of managedPids(dest)) {
      // Defensive class filter (managedPids already admitted this pid). Footwear
      // is added here for the same reason it is added there: without it a shoe
      // with no explicit row is dropped before resolveTarget is consulted. Still
      // safe when footwear is off — resolveTarget then returns null and the
      // `!t` guard below skips the cell, exactly as it does today. A mapped
      // category (perfume is neither clothing nor footwear and needs no row)
      // passes for the same reason explicit-target pids do: the class filter
      // must not drop what managedPids deliberately admitted.
      if (!isClothing(products?.[pid]) && !isFootwear(products?.[pid]) && !targets?.[dest]?.[pid]
          && !categoryPolicyEntry(config, products, stock, pid, dest)) continue;
      for (const sizeKey of sizesFor(dest, pid)) {
        const size = rawSize(pid, sizeKey);
        const t = resolveTarget(ctx, dest, pid, size);
        if (!t || t.target <= 0) continue;
        if (isFootwear(products?.[pid])) footwearManagedCells++; else managedCells++;
        const q = cellQty(stock, dest, pid, size);
        const have = avail(q);
        const inb = inbound.get(`${dest}|${pid}|${sizeKey}`) || 0;
        const deficit = t.target - have - inb;
        if (deficit <= 0) continue;

        // ── REORDER-POINT GATE (owner policy 2026-07-27) ─────────────────────
        // With a reorderPoint set, the cell is a MIN/MAX row, not a top-up row:
        // it stays quiet while on-hand sits above the point, then asks for the
        // whole gap at once. Without one (every clothing row today) this is a
        // no-op and the cell tops up continuously exactly as before.
        //
        // Why this position is load-bearing — the gate sits AFTER the deficit
        // check but BEFORE every push below, so an above-point cell is treated
        // as "no deficit": silent, and identical to a cell that has met target.
        // Placing it lower would leak the cell into belowTarget and then into
        // missingSizes / awaitingSupplier, surfacing a perfectly healthy shelf
        // as a supplier reorder candidate.
        //
        // The test is on `have`, NOT `have + inb`: the policy is written about
        // physical on-hand ("reorders when on-hand drops to 3"). Inbound is
        // already fully accounted for by `deficit` above, so a cell with stock
        // on the way has a deficit of 0 and never reaches this line — there is
        // no double-count and no re-ask while a delivery is in flight.
        //
        // `!= null` is deliberate: reorderPoint 0 is a legitimate row meaning
        // "ask only when the shelf is empty", and a truthiness test would treat
        // it as absent and silently restore eager top-up.
        if (t.reorderPoint != null && have > t.reorderPoint) continue;

        belowTarget.push({ loc: dest, pid, size, have: q, target: t.target, inbound: inb, deficit });

        // Denied by humans at BOTH supply levels → confirmed out. The counted
        // cells may still show stock, but Central and the hub both physically
        // looked and said no — the shelves beat the database. Reorder list,
        // no request, regardless of destination.
        if (confirmedOut(pid, sizeKey)) {
          // Both levels said no, yet a denying location's counted cell still
          // claims stock → the strongest count-vs-shelf mismatch there is.
          // The confirmed-out suppression stands (no requests), but the
          // mismatch is surfaced for a recount instead of going dark. These
          // rows flag IMMEDIATELY (no N-strike wait — two independent levels
          // denying is stronger evidence than N same-level strikes) and carry
          // rejections:null; the Health clear button is hidden for them (no
          // streak node to clear) — the note states the real remedies.
          // NOTE: a streak may keep accruing via closes while confirmedOut
          // masks this gate; the streak-staleness window (= confirmedOutMs)
          // bounds any pile-up when the mask lapses.
          const lk = `${pid}|${sizeKey}`;
          // Legacy shop-level denials carry no `by` — fall back to the route-
          // derived shop-level locations, exactly as confirmedOut() itself does.
          const shopBy = rejShopLevel.get(lk)?.by;
          const denialLocs = [rejCentralLevel.get(lk)?.by || centralLevelLoc, ...(shopBy ? [shopBy] : shopLevelLocs)].filter(Boolean);
          const showingLoc = denialLocs.find((l) => avail(cellQty(stock, l, pid, size)) > 0);
          if (showingLoc) {
            recountNeeded.push({
              loc: dest, pid, size, deficit, source: showingLoc, rejections: null,
              showing: avail(cellQty(stock, showingLoc, pid, size)),
              note: `confirmed out at BOTH levels while ${showingLoc} still counts stock — recount ${showingLoc}: a count correction re-opens asks at once; if the count is right, move the stock manually (Transfer) — this card lifts on arrival or when the window lapses`,
            });
          }
          missingSizes.push({ loc: dest, pid, size, wanted: deficit, note: "denied at both Hub 2 and Central — confirmed out, reorder candidate" });
          continue;
        }

        // Certainly unfillable — ZERO stock anywhere else in the network — is
        // never a request (owner rule 2026-07-13: "if you're 100% sure it
        // exists nowhere, don't even start it — 1000s of unavailable requests
        // are a lot"). It goes straight to the Missing Sizes reorder list and
        // returns to the queue the moment inventory for it appears anywhere.
        if (networkQty(pid, size) - have <= 0) {
          missingSizes.push({ loc: dest, pid, size, wanted: deficit, note: "zero stock upstream — reorder candidate" });
          continue;
        }

        // Suppress for: an intent already on its way, or a fresh rejection —
        // UNLESS stock has arrived at the source since the rejection (arrival
        // lift above: the "no" is stale, the demand reopens automatically).
        // A cell still resting on its cooldown is surfaced as WAITING FOR
        // STOCK so parked demand is always visible, never silently dropped.
        if (inb > 0) continue;
        const rej = rejectedAt.get(`${dest}|${pid}|${sizeKey}`);
        const rejTs = rej?.ts || 0;
        const denier = rej?.by || src;   // watch the location that SAID no, not today's route
        const denierHas = avail(cellQty(stock, denier, pid, size));
        // ── LOOP GUARD (incident 2026-07-19) — RESTORED 2026-07-25 ────────────
        // N human rejections while the denier's counted cell claims stock means
        // the COUNT is the problem, not the demand. Stop re-asking into the void
        // — park the cell in Recount Needed until the count changes, stock
        // demonstrably arrives, or staff clear the streak from Health.
        //
        // PRECEDENCE IS LOAD-BEARING: this check MUST come before the 24h
        // auto-retry below. #259 removed the `continue` and let the retry own
        // the cell, which silently reduced the guard to a notification — a
        // flagged cell was re-asked every 24h forever, exactly the loop the
        // 07-19 incident fix existed to stop. Park beats retry. Pinned in tests
        // ("streak park beats the 24h auto-retry").
        const st = streakState(dest, pid, sizeKey, size, denier);
        if (st.flagged) {
          recountNeeded.push({
            loc: dest, pid, size, deficit, source: st.denier,
            rejections: st.count, showing: st.has,
            note: `rejected ${st.count}× at ${st.denier} while its count shows ${st.has} — recount, then "Ask again" in Health`,
          });
          continue;
        }
        // Denier no longer claims stock, stock arrived after the last strike,
        // or the streak went stale — evidence changed; clear it and resume
        // normal cooldown handling below.
        if (st.resetWorthy) streakOps.push({ dest, pid, sizeKey, op: "reset" });
        // 24h auto-retry (owner rule 2026-07-21): a rejected cell retries
        // every 24h while the destination still needs stock and the source
        // still has inventory. It is the cooldown policy for ORDINARY
        // rejections — the streak guard above still parks pathological ones.
        const rt = retryOf(dest, pid, sizeKey);
        if (rt && rt.nextRetryAt && Date.parse(rt.nextRetryAt) > nowMs) {
          waitingForStock.push({
            loc: dest, pid, size, deficit, source: denier, rejectedAt: rt.lastRejectedAt,
            note: `retry ${rt.retryCount || 0} scheduled for ${rt.nextRetryAt} — last rejected at ${rt.lastRejectedAt}`,
          });
          continue;
        }
        // RE-CHECK ON REJECT: denier still counting stock → short recheck
        // window (the mismatch resolves fast either way); denier counted empty
        // → the full cooldown, as before. Arrival lift still beats both.
        if (nowMs - rejTs < effWindowMs(denierHas) && !arrivedAfter(denier, pid, sizeKey, rejTs)) {
          waitingForStock.push({
            loc: dest, pid, size, deficit, source: denier, rejectedAt: new Date(rejTs).toISOString(),
            note: denierHas > 0
              ? `rejected at ${denier} while its count shows ${denierHas} — re-checks in ${Math.round(recheckMs / 60e3)}min`
              : `rejected at ${denier} — reopens when stock arrives at ${denier} (or after the ${Math.round(cooldownMs / 3600e3)}h cooldown)`,
          });
          continue;
        }

        // ── ACTIONABLE-ONLY QUEUES (owner v9, 2026-07-13 — supersedes v3's
        // propose-don't-suppress) ────────────────────────────────────────────
        // A request enters a working queue ONLY if the source can physically
        // fulfil it right now. Source empty → no card; the demand parks in a
        // passive category instead, and the CASCADE emerges naturally:
        // Trophy needs X, hub2 has none, central does → this scan creates only
        // the central→hub2 leg (hub2's own buffer deficit); when hub2 receives,
        // the NEXT scan creates the Trophy leg. No downstream request exists
        // before its upstream leg is fulfilled, and staff never see work they
        // cannot complete. qty is capped to what the source actually has —
        // every card is fully pickable as written; the remainder re-proposes
        // after the upstream chain tops the source up.
        // Free = on-hand at the source MINUS units already promised to open
        // requests (any destination) MINUS units allocated to intents earlier
        // in THIS scan — two stores can never be sent after one physical unit.
        const srcKey = `${src}|${pid}|${sizeKey}`;
        const srcAvail = avail(cellQty(stock, src, pid, size)) - (sourceReserved.get(srcKey) || 0);
        if (srcAvail <= 0) {
          const upstreamOfSrc = routes[src];   // e.g. central for hub2-sourced legs
          const upstreamAvail = upstreamOfSrc ? avail(cellQty(stock, upstreamOfSrc, pid, size)) : 0;
          // "Chain is flowing" must be TRUE, not hopeful: stock already on its
          // way to the source, or stock one level up AND the source's own leg
          // is not itself parked behind a rejection cooldown / confirmed-out
          // (Codex P2 — otherwise demand sits mislabelled for the whole window).
          const srcRej = rejectedAt.get(`${src}|${pid}|${sizeKey}`);
          // Same effective window as the propose gate: a source leg whose
          // denier still counts stock re-checks fast, so it is only "parked"
          // inside the SHORT window — the blocked label must not outlive the
          // gate that causes it.
          const srcDenier = srcRej?.by || upstreamOfSrc;
          const srcDenierHas = srcDenier ? avail(cellQty(stock, srcDenier, pid, size)) : 0;
          // A streak-FLAGGED source leg is parked indefinitely (Recount Needed
          // awaits a human) — the store demand must say "blocked", not
          // "flowing", or it starves behind a self-healing label. RESTORED
          // 2026-07-25 with the guard above; it matters MORE under rule-based
          // targets, because srcCanPull is now almost always true for carried
          // clothing, so this is the main remaining signal that an upstream leg
          // is genuinely stuck rather than merely waiting.
          const srcStreakFlagged = streakState(src, pid, sizeKey, size, upstreamOfSrc).flagged;
          const srcParked = (srcRej && nowMs - srcRej.ts < effWindowMs(srcDenierHas) && !arrivedAfter(srcDenier, pid, sizeKey, srcRej.ts))
            || srcStreakFlagged
            || confirmedOut(pid, sizeKey);
          // "Chain is flowing" additionally requires the source to HAVE a
          // buffer target for this cell — without one the engine will never
          // compute a source deficit, so no upstream leg would EVER create and
          // the demand would starve silently behind a self-healing label
          // (Sonnet HIGH, 2026-07-13). No target at the source = a CONFIG gap,
          // surfaced as blocked, not as flowing.
          const srcTarget = upstreamOfSrc ? resolveTarget(ctx, src, pid, size) : null;
          const srcCanPull = !!(srcTarget && srcTarget.target > 0);
          if ((inbound.get(`${src}|${pid}|${sizeKey}`) || 0) > 0 || (upstreamAvail > 0 && srcCanPull && !srcParked)) {
            awaitingUpstream.push({ loc: dest, pid, size, deficit, source: src, note: `waiting for ${src} to receive stock${upstreamOfSrc ? ` from ${upstreamOfSrc}` : ""}` });
          } else {
            awaitingSupplier.push({
              loc: dest, pid, size, deficit, source: src,
              note: srcParked ? `upstream leg blocked — ${src} ${srcStreakFlagged ? "awaits a recount (see Recount Needed)" : srcDenierHas > 0 ? "recently rejected — re-checks shortly" : "recently rejected / confirmed out"}`
                : (upstreamAvail > 0 && !srcCanPull) ? `${src} has no buffer target for this size — set one (or transfer manually); stock waits at ${upstreamOfSrc}`
                : "upstream chain empty — supplier reorder or excess return needed",
            });
          }
          continue;
        }

        const qty = Math.min(deficit, srcAvail, maxUnits);
        bump(sourceReserved, srcKey, qty);   // claim the units within this scan
        intents.push({
          dest, source: src, productId: pid, size, sizeKey,
          qty, priority: have < t.minQty ? "high" : "normal", mode,
        });
        // Record the retry in history and update the retry state.
        // The "retry" op REPLACES the whole retryState node (the scan writes an
        // object, not a merge), so it must carry EVERY field that node holds —
        // including the two rejection stamps it does not itself change. Omitting
        // firstRejectedAt/lastRejectedAt made them `undefined` at write time and
        // crashed every scan for 26h (outage 2026-07-24; same class as #269).
        // Carry them forward from the previous state, never leave them absent.
        if (rt && rt.retryCount > 0) {
          retryOps.push({
            dest, pid, sizeKey, op: "retry",
            retryCount: rt.retryCount,
            firstRejectedAt: rt.firstRejectedAt || rt.lastRejectedAt || nowIso,
            lastRejectedAt: rt.lastRejectedAt || rt.firstRejectedAt || nowIso,
            lastRetryAt: nowIso,
            nextRetryAt: new Date(nowMs + cooldownMs).toISOString(),
            // `|| null`: a legacy/partial retryState node without this field
            // would otherwise put `undefined` in the payload — the same omission
            // class as the outage. It currently survives only because the scan
            // normalises with `?? null`; the engine-level contract must hold on
            // its own, so both layers default it. (CodeRabbit, PR #276.)
            lastRejectionReason: rt.lastRejectionReason || null,
            source: src,
          });
          retryOps.push({
            dest, pid, sizeKey, op: "history",
            type: "retry", timestamp: nowIso,
            rejectionReason: rt.lastRejectionReason,
            retryAttempt: rt.retryCount, source: src, destination: dest,
            qty,
          });
        }
      }
    }
  }

  // ── circuit breaker — FAIR across destinations ──────────────────────────────
  // A global top-N starves the smaller locations (Marathon PE's backlog alone
  // can fill the cap, so Trophy and hub2 never surface). Round-robin across
  // destinations instead: each dest's list is priority-sorted, then slots are
  // dealt one per dest until the cap is reached.
  // THROTTLE — /config/refillEngine/maxIntentsPerRun (live, no deploy).
  // The number of NEW intents any single scan may create, dealt fairly across
  // destinations, high-priority first. This is the "slow it down without
  // switching it off" control: set it to e.g. 50 and the queue grows by at most
  // 50 cards per 15-minute scan instead of the full computed backlog. Anything
  // not dealt this run is simply re-proposed next run — the engine is stateless,
  // so throttling delays work, it never loses it. Default 200 if unset.
  // CLAMPED, like every other numeric knob in this file (recheckMs, streakLimit,
  // confirmedOutMs). Unclamped, a NEGATIVE value is truthy, so maxIntents = -5
  // trips the breaker every scan and the deal loop exits immediately → ZERO
  // intents, indefinitely, while the run record reports throttled:true. That is
  // a silent total stop on the key whose whole job is live incident control.
  // (Kimi review, PR #277.) 0 is likewise not a valid throttle — use the kill
  // switch to stop the engine, not a zero cap.
  const maxIntents = Math.max(1, num(config?.maxIntentsPerRun) || 200);
  // The round-robin, factored out so the two product classes can be dealt
  // SEPARATELY. Behaviour is unchanged for a single class.
  const dealFairly = (list, cap) => {
    if (list.length <= cap) return list;
    const byDest = new Map();
    for (const i of list) {
      if (!byDest.has(i.dest)) byDest.set(i.dest, []);
      byDest.get(i.dest).push(i);
    }
    for (const q of byDest.values()) q.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
    const out = [];
    const queues = [...byDest.values()];
    for (let round = 0; out.length < cap; round++) {
      let dealt = false;
      for (const q of queues) {
        if (round < q.length && out.length < cap) { out.push(q[round]); dealt = true; }
      }
      if (!dealt) break;
    }
    return out;
  };

  // ── FOOTWEAR GETS ITS OWN CAP (CodeRabbit #289, major) ──────────────────────
  // maxIntentsPerRun is a GLOBAL cap dealt round-robin across destinations. Left
  // shared, footwear would compete with clothing for the same 75 slots — directly
  // inside hub2, which carries both classes, and by adding hub1 as another queue
  // that takes round-robin turns. Enabling footwear would then delay or reorder
  // clothing intents, which is precisely the coupling this feature promises not to
  // create. The initial footwear backlog makes it certain rather than theoretical:
  // 578-993 intents against a cap of 75.
  //
  // So the classes are capped INDEPENDENTLY. Clothing is dealt first from the
  // untouched `intents` list with the untouched cap, so its allocation is
  // identical to what it would be with footwear switched off — same inputs, same
  // round-robin, same output. Footwear is then dealt from its own list under
  // maxFootwearIntentsPerRun (default 25, the launch throttle) and appended.
  //
  // Partitioning by PRODUCT rather than by destination is deliberate: hub2 holds
  // both classes, so a destination split would not separate them.
  const isFootwearIntent = (i) => isFootwear(products?.[i.productId]);
  const clothingIntents = intents.filter((i) => !isFootwearIntent(i));
  const footwearIntents = intents.filter(isFootwearIntent);
  const maxFootwearIntents = Math.max(1, num(config?.maxFootwearIntentsPerRun) || 25);
  const plannedClothing = dealFairly(clothingIntents, maxIntents);
  const plannedFootwear = dealFairly(footwearIntents, maxFootwearIntents);
  const plannedIntents = [...plannedClothing, ...plannedFootwear];
  if (clothingIntents.length > maxIntents) {
    errors.push(`circuit breaker: ${clothingIntents.length} intents computed, capped to ${maxIntents} (fair per destination, high-priority first)`);
  }
  if (footwearIntents.length > maxFootwearIntents) {
    errors.push(`circuit breaker (footwear): ${footwearIntents.length} intents computed, capped to ${maxFootwearIntents}`);
  }

  // ── inventory intelligence (plan §Inventory Intelligence — CLOTHING ONLY) ───
  const onlyInCentral = [];
  const onlyInHub2 = [];
  const excess = [];        // network-wide: hub2 (any surplus) + stores (significant surplus)
  const negativeCells = [];
  // Outstanding deficit per (pid,size) across ALL destinations — surplus at one
  // location is NOT excess while another location starves for the same size
  // (bugfix 2026-07-12, the "Cortez contradiction": hub2 XL flagged for return
  // to Central while Marathon PE sat at 0/2 XL). Stock flows TOWARD deficits;
  // only what remains after every deficit is covered may leave the network arm.
  const deficitBySize = new Map();
  for (const b of belowTarget) {
    const k = `${b.pid}|${encodeSizeKey(b.size)}`;
    deficitBySize.set(k, (deficitBySize.get(k) || 0) + b.deficit);
  }
  const sumLoc = (loc, pid) => Object.values(stock?.[loc]?.[pid] || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
  // Stores legitimately sell down their overage, so only SIGNIFICANT store
  // excess is flagged; hub2 is a strict buffer — any unit above target counts.
  const storeExcessMin = num(config?.storeExcessMinUnits) || 2;
  const allPids = new Set([
    ...Object.keys(stock?.central || {}), ...Object.keys(stock?.hub2 || {}),
    ...Object.keys(stock?.["marathon-pe"] || {}), ...Object.keys(stock?.trophy || {}),
  ]);
  for (const pid of allPids) {
    if (!isClothing(products?.[pid])) continue;
    const ce = sumLoc("central", pid), h2 = sumLoc("hub2", pid);
    const pe = sumLoc("marathon-pe", pid), tr = sumLoc("trophy", pid);
    if (ce > 0 && h2 === 0 && pe === 0 && tr === 0) onlyInCentral.push({ pid, units: ce });
    if (h2 > 0 && pe === 0 && tr === 0) onlyInHub2.push({ pid, units: h2 });
    for (const loc of dests) {
      for (const [sizeKey, cell] of Object.entries(stock?.[loc]?.[pid] || {})) {
        // Excess must be measured against the target that ACTUALLY applies —
        // resolveTarget, not the explicit row. Asking `targets[loc][pid][size]`
        // made every rule-managed cell invisible to Move Excess, and the
        // "surfaced as noTarget below instead" safety net no longer catches
        // them either (managedHere skips rule-managed products). Concrete miss:
        // trophy holds 14 × M against a rule target of 4 — the 10-unit overage
        // appeared in NO queue at all. (Kimi review, PR #277.)
        // THREE distinct states (owner decision 2026-07-12 v5) — never conflated:
        //   configured target  → excess = qty − target (hub2 strict ≥1, stores ≥2)
        //   explicit target 0  → deliberately excluded here: EVERY unit is excess
        //   no target at all   → NOT excess; surfaced by the blind-spot guard
        // resolveTarget preserves all three: explicit 0 still returns target 0,
        // and "nothing resolves" still returns null.
        const t = resolveTarget(ctx, loc, pid, rawSize(pid, sizeKey));
        if (!t || typeof t.target !== "number") continue;
        const raw = num(cell?.qty) - t.target;
        // TWO-LEG MOVE EXCESS (owner directive 2026-07-13, supersedes the
        // net-only display of the Cortez fix while KEEPING its protection):
        //   • HUB 2 rows stay NET-based — its held units have an automated
        //     mover (the hub→store refill legs), so they are not excess.
        //   • STORE rows are RAW-based with an allocation split — a store has
        //     NO automated mover; Move Excess is its only path, so the card
        //     must move the WHOLE overage in one visit: deficit-covering units
        //     → Hub 2 (never Central — Cortez preserved), remainder → Central.
        //     The shop finishes exactly on target in one operation.
        //   • Allocation is THREADED: deficitBySize is consumed as stores
        //     allocate, so two over-target stores can never both be told to
        //     fill the same Hub 2 deficit (the resize-reservation lesson,
        //     applied at design time).
        const dKey = `${pid}|${sizeKey}`;
        if (loc === "hub2") {
          const heldForRefills = Math.min(Math.max(raw, 0), deficitBySize.get(dKey) || 0);
          const ex = raw - heldForRefills;
          if (ex >= 1) excess.push({ loc, pid, sizeKey, have: num(cell.qty), target: t.target, excess: ex, ...(heldForRefills > 0 ? { heldForRefills } : {}) });
        } else {
          const minEx = t.target === 0 ? 1 : storeExcessMin;
          if (raw >= minEx) {
            const need = deficitBySize.get(dKey) || 0;
            const toHub = Math.min(raw, need);
            deficitBySize.set(dKey, need - toHub);   // consume — no double-fill
            excess.push({ loc, pid, sizeKey, have: num(cell.qty), target: t.target, excess: raw, toHub, toCentral: raw - toHub, ...(toHub > 0 ? { heldForRefills: toHub } : {}) });
          }
        }
      }
    }
  }
  for (const loc of new Set([...dests, ...Object.values(routes)])) {
    for (const [pid, bySize] of Object.entries(stock?.[loc] || {})) {
      if (!isClothing(products?.[pid])) continue;   // sneakers never appear in Health
      for (const [sizeKey, cell] of Object.entries(bySize || {})) {
        if (num(cell?.qty) < 0) negativeCells.push({ loc, pid, sizeKey, qty: num(cell.qty) });
      }
    }
  }

  // ── Decision Queue + Unintroduced (v8): SETUP split from MIGRATION ──────────
  // (owner architecture 2026-07-13) Two completely different concepts that the
  // old queue conflated, now separated:
  //   • NEW PRODUCT (loc "central", isNew) — stock at Central, no targets at
  //     ANY destination AND no stock at any destination: genuinely entering the
  //     network for the first time. The ONLY place target quantities are a
  //     business decision. Introduction wizard → targets → initial distribution
  //     → engine takes over permanently.
  //   • UNINTRODUCED (exceptions.unintroduced, one entry per product) — already
  //     circulating at PE/Trophy/Hub 2 but with no targets anywhere: an
  //     existing product that simply never entered engine management. The
  //     standard run is ALREADY the approved policy for these, so they are NOT
  //     decisions — the one-tap "Introduce Existing Products" migration in
  //     Health applies the standard targets in bulk and the engine takes over.
  //   • Genuine decisions that remain in the queue:
  //       – noStandard: circulating product whose stocked sizes the standard
  //         run doesn't cover (numeric jeans etc.) — no approved quantities
  //         exist, a human must set them;
  //       – assortment leftover: stock at a location for a product that HAS
  //         targets elsewhere — include here, transfer away, or exclude.
  // Decision records (/stock_targets_decisions/{loc}/{pid}) suppress entries:
  //   keep         — permanent (legacy)
  //   snooze       — until the `until` timestamp passes (remind me later)
  //   until_change — until the product's network-wide stock FINGERPRINT changes
  //                  (any receive/sale/transfer resurfaces the card)
  const noTarget = [];
  const unintroduced = [];
  // ── "MANAGED" MUST MEAN THE SAME THING HERE AS IN THE PLANNER ───────────────
  // These queues used to ask `targets?.[loc]?.[pid]` — explicit rows only. That
  // was correct under v5, where explicit WAS the whole policy. #259 changed what
  // the planner manages but not what these queues ask, so every rule-managed
  // product still demanded a human decision it did not need: 382 noTarget + 211
  // unintroduced phantom entries live on 2026-07-25, on products the engine was
  // actively refilling. Both now ask the SINGLE question the planner asks —
  // "does a target RESOLVE for this cell?" — so the two can never drift again,
  // and they automatically follow the kill switch: turn rule-based targets off
  // and these queues repopulate exactly as they did under v5.
  const targetResolves = (loc, pid, size) => {
    const t = resolveTarget(ctx, loc, pid, size);
    return !!(t && t.target > 0);
  };
  // For the BLIND-SPOT guard the question is subtly different: "has this size
  // been DECIDED?", not "does it have a positive target". An explicit target of
  // 0 means deliberately excluded — a human already ruled on it, so it is not a
  // blind spot even though no target resolves. Collapsing those two states was
  // the v5 three-state rule's whole point ("no target" ≠ "target 0"), and the
  // suite caught it: using targetResolves here re-flagged every excluded cell.
  const sizeDecided = (loc, pid, sizeKey) => {
    const explicit = targets?.[loc]?.[pid]?.[sizeKey];
    if (explicit && typeof explicit.target === "number") return true;   // incl. 0
    return targetResolves(loc, pid, rawSize(pid, sizeKey));
  };
  // Explicit rows (INCLUDING an explicit 0 = "deliberately excluded here") count
  // as managed — a human already decided. Otherwise fall back to the rule.
  const managedHere = (loc, pid) => {
    if (targets?.[loc]?.[pid]) return true;
    // The category policy is a decision too — and it survives the kill switch
    // (resolveTarget's branch order), so it must be consulted BEFORE the
    // switch return below. Skipping this had the Decision Queue calling a
    // mapped product "needs a decision" at the exact moment the planner was
    // refilling it — the drift the block comment above exists to prevent.
    // Entry presence is the test, not a positive resolution: an entry whose
    // sizes all resolve dead-0 is "deliberately excluded", the same reading
    // an explicit 0 row gets one branch up. (CodeRabbit + Sonnet, PR #352.)
    if (categoryPolicyEntry(config, products, stock, pid, loc)) return true;
    if (!ruleTargetsEnabled(config, loc)) return false;
    for (const s of productSizes(products, pid)) if (targetResolves(loc, pid, s)) return true;
    return false;
  };
  const decisionActive = (loc, pid) => {
    const d = targetDecisions?.[loc]?.[pid];
    if (!d) return false;
    if (d.decision === "keep") return true;
    if (d.decision === "snooze") return Date.parse(d.until || 0) > nowMs;
    if (d.decision === "until_change") return d.fingerprint === stockFingerprint(stock, pid);
    return false;
  };
  // Sizes the standard run covers (letters only — numeric sizes have no
  // approved standard quantity). MUST stay in lockstep with the client copy in
  // src/components/stock/introduceExistingCore.js.
  const STANDARD_SIZE_RE = /^(S|M|L|XL|XXL|XXXL)$/i;
  // Cell PRESENCE, not quantity (consistent with `circulates`): a standard
  // size whose cells all sold to zero still gets a target on migration — its
  // demand is proven and the engine should replenish or reorder it, not let
  // the product vanish from both workflows.
  const stockedStandardSizes = (pid) => {
    const out = new Set();
    for (const l of Object.keys(stock)) {
      for (const sk of Object.keys(stock[l]?.[pid] || {})) {
        if (STANDARD_SIZE_RE.test(sk)) out.add(sk);
      }
    }
    return [...out];
  };
  // NEW products at Central FIRST — the exceptions snapshot caps its item list,
  // and the introduction queue is the primary workflow, so it must never be the
  // part that gets truncated.
  // Circulation evidence is cell PRESENCE, not current quantity: applyMovement
  // never deletes a cell, so a destination cell at qty 0 still proves the
  // product has been out in the network — a sell-through to zero must NOT flip
  // a product back to "NEW" (it already circulated; it belongs to migration).
  const circulates = (pid) => dests.some((d) => stock?.[d]?.[pid] && Object.keys(stock[d][pid]).length > 0);
  for (const [pid, bySize] of Object.entries(stock?.central || {})) {
    if (!isClothing(products?.[pid])) continue;
    if (isDeactivated(products?.[pid])) continue;           // finished line — no decision owed
    if (dests.some((d) => managedHere(d, pid))) continue;   // managed somewhere (explicit OR rule)
    if (circulates(pid)) continue;                          // circulating → unintroduced, NOT new
    if (decisionActive("central", pid)) continue;
    const units = Object.values(bySize || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
    if (units > 0) noTarget.push({ loc: "central", pid, units, isNew: true });
  }
  const seenUnintroduced = new Set();
  for (const loc of dests) {
    for (const [pid, bySize] of Object.entries(stock?.[loc] || {})) {
      if (!isClothing(products?.[pid])) continue;
      if (isDeactivated(products?.[pid])) continue;    // finished line — no decision owed
      if (managedHere(loc, pid)) continue;             // target resolves here → managed
      if (!Object.keys(bySize || {}).length) continue;
      const units = Object.values(bySize || {}).reduce((t, c) => t + avail(num(c?.qty)), 0);
      if (!dests.some((d) => managedHere(d, pid))) {
        // Zero targets anywhere + has circulated = awaiting migration, one
        // entry per product (never per location — no duplicate cards). A
        // sold-to-zero product still migrates: its demand is proven and the
        // engine will redistribute it the moment targets exist. The dedup
        // applies ONLY to the network-wide migration entry — noStandard
        // decisions stay per-location so no location's stock goes invisible.
        const standardSizes = stockedStandardSizes(pid);
        if (standardSizes.length) {
          if (seenUnintroduced.has(pid)) continue;
          seenUnintroduced.add(pid);
          unintroduced.push({
            pid, standardSizes,
            units: dests.reduce((t, d) => t + sumLoc(d, pid), 0),
            byLoc: Object.fromEntries(["central", ...dests].map((l) => [l, sumLoc(l, pid)])),
          });
        } else if (units > 0 && !decisionActive(loc, pid)) {
          noTarget.push({ loc, pid, units, noStandard: true });
        }
        continue;
      }
      if (units <= 0) continue;
      if (decisionActive(loc, pid)) continue;
      noTarget.push({ loc, pid, units });   // assortment leftover — genuine decision
    }
  }
  // SIZE-SCOPED blind-spot guard (review 2026-07-13; WIDENED 2026-07-13 after
  // the owner's "can a refill ever be silently missed?" audit found 13 live
  // cells): a MANAGED product can hold stocked sizes no human ever targeted —
  // numeric sizes the standard run doesn't cover, AND standard sizes that
  // arrived after the product was introduced (a new "S" of a product migrated
  // on M/L). The pid-level managed gate above would hide those cells forever:
  // no deficit is ever computed for an untargeted size, so no refill would
  // EVER generate — the exact silent-miss class. Every stocked size lacking a
  // target under a managed product surfaces as a decision. Hub 2 additionally
  // checks sizes stocked at ITS SOURCE (central) — a brand-new size arriving
  // upstream must surface at the buffer before it can flow anywhere.
  // The universe here must be MANAGED products, not explicitly-targeted ones.
  // Iterating `targets[loc]` was right under v5 (explicit WAS managed), but a
  // rule-managed product has no explicit row — so a numeric size it holds
  // (jeans 32 under a product the rule covers on M/L) would be skipped by the
  // queues above (managedHere → continue) AND never visited here: no target, no
  // request, surfaced nowhere. That is precisely the silent-miss class this
  // guard exists to catch. (CodeRabbit, PR #277.) With the kill switch OFF,
  // managedHere collapses to explicit rows and this is identical to v5.
  for (const loc of dests) {
    const guardPids = new Set([...Object.keys(targets?.[loc] || {}), ...Object.keys(stock?.[loc] || {})]);
    for (const pid of guardPids) {
      if (!isClothing(products?.[pid])) continue;
      if (isDeactivated(products?.[pid])) continue;   // finished line — no decision owed
      if (!managedHere(loc, pid)) continue;   // unmanaged → already handled by the queues above
      if (decisionActive(loc, pid)) continue;
      let units = 0;
      const seenSk = new Set();
      // A size is only a blind spot if it has not been DECIDED — no explicit row
      // (including an explicit 0 = deliberately excluded) and no rule target.
      // Under rule-based targeting the standard sizes resolve automatically;
      // numeric / non-standard sizes still surface here, which is the purpose.
      for (const [sk, c] of Object.entries(stock?.[loc]?.[pid] || {})) {
        const q = avail(num(c?.qty));
        if (q > 0 && !sizeDecided(loc, pid, sk)) { units += q; seenSk.add(sk); }
      }
      if (loc === "hub2") {
        const up = routes[loc];   // central — new sizes land there first
        for (const [sk, c] of Object.entries(stock?.[up]?.[pid] || {})) {
          if (seenSk.has(sk) || sizeDecided(loc, pid, sk)) continue;
          if (avail(num(c?.qty)) > 0 && !dests.some((d) => sizeDecided(d, pid, sk))) units += avail(num(c?.qty));
        }
      }
      if (units > 0) noTarget.push({ loc, pid, units, noStandard: true });
    }
  }
  // (v5: the Policy Warnings layer was REMOVED at the owner's direction — the
  // engine no longer second-guesses targets. Unconfigured stock is surfaced as
  // "No Target Configured" below; everything else is the warehouse's call.)

  // Failed refills (visible 48h): any Shop Refill line rejected recently.
  const failedRefills = [];
  for (const [id, o] of Object.entries(orders)) {
    if (!o || o.customerName !== "Shop Refill") continue;
    if (o.clothingRefillStatus === "rejected" && nowMs - Date.parse(o.clothingOutOfStockAt || o.updatedAt || 0) < 48 * 3600e3) {
      failedRefills.push({ orderId: id, pid: o.productId || null, size: o.size, dest: o.destShop || null });
    }
  }

  const cap = (arr, n = 300) => ({ count: arr.length, items: arr.slice(0, n) });
  return {
    intents: plannedIntents,
    closes,
    // Lock-less open requests whose destination cell already holds what they
    // asked for. Applied by its own loop (status write only, no lock touch).
    satisfiedClosures,
    resizes,
    streakOps,
    retryOps,
    errors,
    // policy: the switch/throttle state THIS scan actually ran under, echoed
    // into /refill_engine/runs. During an incident nobody should have to guess
    // whether rule-based targeting was on — the run record states it.
    policy: {
      ruleBasedTargets: Object.fromEntries(dests.map((d) => [d, ruleTargetsEnabled(config, d)])),
      // Footwear rollout state, per destination — during an incident nobody
      // should have to guess which hubs were armed. (CodeRabbit #289.)
      footwearTargets: Object.fromEntries(dests.map((d) => [d, footwearTargetsEnabled(config, d)])),
      maxIntentsPerRun: maxIntents,
      maxFootwearIntentsPerRun: maxFootwearIntents,
      intentsComputed: intents.length,
      intentsPlanned: plannedIntents.length,
      // Split so a capped run shows WHICH class was throttled.
      footwearIntentsComputed: footwearIntents.length,
      footwearIntentsPlanned: plannedFootwear.length,
      throttled: clothingIntents.length > maxIntents,
      footwearThrottled: footwearIntents.length > maxFootwearIntents,
    },
    stats: { managedCells, footwearManagedCells, ...(Object.keys(resizeSuppressed).length ? { resizeSuppressed } : {}) },
    exceptions: {
      noTarget: cap(noTarget),
      unintroduced: cap(unintroduced, 900),
      belowTarget: cap(belowTarget, 1500),
      missingSizes: cap(missingSizes),
      waitingForStock: cap(waitingForStock),
      awaitingUpstream: cap(awaitingUpstream, 900),
      awaitingSupplier: cap(awaitingSupplier, 900),
      recountNeeded: cap(recountNeeded),
      stuckRefills: cap(stuckRefills),
      failedRefills: cap(failedRefills),
      onlyInCentral: cap(onlyInCentral),
      onlyInHub2: cap(onlyInHub2),
      excess: cap(excess),
      negativeCells: cap(negativeCells),
    },
  };
}

// ── confidence scoring (plan §Inventory Confidence Score) ─────────────────────
// Per (location, product): start at 100, subtract for accuracy risk signals.
// Only entries below the threshold are returned (the "Needs Review" list).
function computeConfidence({ nowMs, stock = {}, movements = [], openIndex = {}, products = {}, threshold = 85 }) {
  const byLocPid = new Map();
  const ensure = (loc, pid) => {
    const k = `${loc}|${pid}`;
    if (!byLocPid.has(k)) byLocPid.set(k, { negative: 0, adjustments: 0, uncounted: 0, lastMoveMs: 0, stuck: 0 });
    return byLocPid.get(k);
  };
  const clothingOnly = Object.keys(products).length > 0;
  const skip = (pid) => clothingOnly && !isClothing(products[pid]);
  for (const [loc, byPid] of Object.entries(stock)) {
    for (const [pid, bySize] of Object.entries(byPid || {})) {
      if (skip(pid)) continue;
      for (const cell of Object.values(bySize || {})) {
        if (num(cell?.qty) < 0) ensure(loc, pid).negative++;
        const upd = Date.parse(cell?.updatedAt || 0) || 0;
        const f = ensure(loc, pid);
        if (upd > f.lastMoveMs) f.lastMoveMs = upd;
      }
    }
  }
  const d30 = nowMs - 30 * 864e5;
  for (const m of movements) {
    if (!m || skip(m.productId)) continue;
    const ts = Date.parse(m.ts || 0) || 0;
    if (m.type === "adjustment" && ts >= d30) {
      if (m.from) ensure(m.from, m.productId).adjustments++;
      if (m.to) ensure(m.to, m.productId).adjustments++;
    }
    if (m.reason === "clothing_cr_uncounted" && ts >= d30 && m.to) ensure(m.to, m.productId).uncounted++;
  }
  for (const [dest, byPid] of Object.entries(openIndex)) {
    for (const pid of Object.keys(byPid || {})) if (!skip(pid)) ensure(dest, pid); // presence only
  }
  const out = {};
  for (const [k, f] of byLocPid) {
    const [loc, pid] = k.split("|");
    let score = 100;
    if (f.negative > 0) score -= 30;
    score -= Math.min(f.adjustments * 5, 25);
    if (f.lastMoveMs && nowMs - f.lastMoveMs > 45 * 864e5) score -= 15;
    score -= Math.min(f.uncounted * 10, 20);
    score = Math.max(0, score);
    if (score < threshold) {
      ((out[loc] ||= {})[pid] = { score, factors: { negativeCells: f.negative, adjustments30d: f.adjustments, uncountedSends30d: f.uncounted, staleDays: f.lastMoveMs ? Math.round((nowMs - f.lastMoveMs) / 864e5) : null } });
    }
  }
  return out;
}

module.exports = { computeRefillPlan, computeConfidence, resolveTarget, subcategoryRun, encodeSizeKey, retryHistoryKey, saTodayKey, isClothing, stockFingerprint, sanitizeUpdate, categoryPolicyTarget, categoryPolicyEntry, armedGroupForCategory, effectivePolicyFor };

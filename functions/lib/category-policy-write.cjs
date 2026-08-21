// ─── setCategoryPolicy — THE WRITE PATH ───────────────────────────────────────
//
// The whole of the callable's behaviour lives here, with `db` and the caller's
// email injected, so every branch — including the two that must never be
// deletable — is exercisable by a test with a fake database. functions/index.js
// holds only the onCall wrapper.
//
// ── GATE 3 OF 3: THE SERVER CHECK ────────────────────────────────────────────
// assertSuperAdmin below is the THIRD independent gate on the Engine Policy
// feature. The other two are in the client (the home tile does not render, and
// the route refuses to mount the component). Those two are CONVENIENCE AND
// HONESTY, not security: anyone can edit their own JavaScript. This one is the
// only gate an attacker cannot reach around, and it fails closed on an absent
// token, an anonymous session, a staff {username}@marathon.internal account,
// and any Google account that is not the owner's.
//
// ── AND IT IS STILL NOT A SECURITY BOUNDARY, TODAY ───────────────────────────
// STATE THIS PRECISELY, BECAUSE an earlier version of this comment
// asserted that the root RTDB rules were `auth !== null` for read AND write and
// that /config carried no tighter rule. That was never verified against
// anything: it was repeated from the brief this feature was built to, and BOTH
// the live rules AND the repo's own database.rules.json already said otherwise.
// Checked 2026-08-21 via /.settings/rules.json:
//
//   • no root ".read" and no root ".write" at all — unmatched paths DENY
//   • /config          ".read":  auth != null && sign_in_provider != 'anonymous'
//   • /config/refillEngine ".write": …the same, AND
//     root.child('users').child(auth.uid).child('stockRole').val() === 'admin'
//
// So the policy node is writable by any stockRole 'admin' account — four of
// them on the live /users node today (Ibrahim, Ahmed, Mike, 2POS) — not by
// every signed-in staff member, and not by nobody.
//
// Any of those four can write it straight from a tablet, bypassing this
// function entirely, and none of the validation, drift checks, rollback
// snapshot or audit entry below would run.
//
// This function is therefore the only SUPPORTED way to change the policy, and
// the only one that leaves evidence — but it is not yet the only POSSIBLE way.
// The console rule printed by scripts/print-engine-policy-rule.mjs narrows
// those four accounts to one. Until it is pasted, treat every gate in this
// feature as an operational control, not a security control.
//
// ── WHY THE HISTORY IS WRITTEN BEFORE THE MUTATION ───────────────────────────
// A rollback snapshot written afterwards is a snapshot you do not have when the
// write is the thing that went wrong. The order here is: read live → drift
// check → WRITE THE HISTORY ENTRY (holding `before` in full) → re-read live →
// drift check AGAIN → mutate → re-read and verify. If the process dies at any
// point after the history write, the previous policy is on disk in RTDB and one
// tap of Revert in the card restores it.

const {
  validateCategoryPolicy, diffCategoryPolicy, modelCategoryPolicy, defaultMinQty,
  carriageForCategory,
} = require("./category-policy.cjs");

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const HISTORY_PATH = "engine_policy_history";
const POLICY_PATH = "config/refillEngine/categoryPolicy";

// Canonical JSON, for equality only. Key order in RTDB is not stable across
// reads, so a raw JSON.stringify comparison would report drift that is not
// there — and a drift check that cries wolf gets switched off.
function canonical(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const sameValue = (a, b) => canonical(a) === canonical(b);

// ── GATE 3 ───────────────────────────────────────────────────────────────────
// Email identity, deliberately, and deliberately NOT a permissions array:
// the owner's own /users record carries no permissions array at all — his
// access works because hasPermission short-circuits on the hardcoded admin
// constant. A permission-based gate here would lock out the one person the
// feature exists for while letting through anyone a permission was granted to.
// Staff sign in as {username}@marathon.internal and can never match.
//
// DELETING THIS FUNCTION, OR ITS CALL, MUST FAIL TESTS. See
// scripts/mutation-proof-engine-policy.mjs (M-SERVER).
function assertSuperAdmin(callerEmail, adminEmail) {
  if (!adminEmail) throw httpsError("failed-precondition", "Admin identity is not configured.");
  if (typeof callerEmail !== "string" || callerEmail !== adminEmail) {
    throw httpsError("permission-denied", "Engine policy is owner-only.");
  }
}

// The callable protocol's error shape, produced without importing
// firebase-functions so this module stays unit-testable in plain node. The
// wrapper in index.js re-throws these as real HttpsErrors.
function httpsError(code, message, details) {
  const e = new Error(message);
  e.httpsCode = code;
  if (details) e.details = details;
  return e;
}

// Paged map read. Live bandwidth is billed and a preview must not cost a
// whole-node download; this is the same cursor discipline as
// scripts/lib/rtdbPaged.mjs (snapshot iteration order, inclusive startAt,
// terminate on NEW records rather than raw key count).
async function readMapPaged(db, path, pageSize = 500) {
  const out = {};
  let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });
    let added = 0;
    for (const k of keys) {
      if (k === lastKey) continue;
      out[k] = snap.child(k).val();
      added += 1;
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return out;
}

const val = (db, path) => db.ref(path).once("value").then((s) => s.val());

// ── NORMALISE THE INCOMING EDIT ──────────────────────────────────────────────
// The card sends whole numbers or blanks. Blank "Ask at" means ABSENT, which is
// a real and different policy from 0 (absent = top up eagerly; 0 = ask only
// when the shelf is empty), so it is dropped from the object rather than
// coerced. minQty is filled from ceil(keep / 2) when the caller omits it, which
// is the ratio every armed batch has used and what the engine falls back to
// anyway — so the owner never types it from scratch and the value is never a
// surprise.
function normalizePolicy(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out = {};
  if (input.perSize === true) out.perSize = true;
  for (const [loc, raw] of Object.entries(input)) {
    if (loc === "perSize") continue;
    if (raw === null || raw === undefined) continue;      // location removed
    if (typeof raw !== "object" || Array.isArray(raw)) { out[loc] = raw; continue; }
    // Unknown fields are CARRIED THROUGH, not stripped. Stripping them would
    // make the validator's unknown-field guard unreachable and turn a typo
    // ("reorderpoint: 2") into a silently ignored edit that the owner watches
    // save successfully and then does nothing. Let validation say so instead.
    const entry = { ...raw, target: raw.target };
    entry.minQty = raw.minQty === undefined || raw.minQty === null
      ? defaultMinQty(raw.target)
      : raw.minQty;
    if (raw.reorderPoint === undefined || raw.reorderPoint === null) delete entry.reorderPoint;
    out[loc] = entry;
  }
  return out;
}

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
// Reads only what the model needs: the catalogue, and the stock / target /
// open-intent maps for the locations actually involved. Central is always
// included because it is the only place a hub deficit can be filled from and
// "Central holds N" is half the verdict.
async function buildPreview(db, { config, categoryKey, policyAfter, locations }) {
  const configAfter = {
    ...config,
    categoryPolicy: { ...(config.categoryPolicy || {}), ...(policyAfter === null ? {} : { [categoryKey]: policyAfter }) },
  };
  if (policyAfter === null) delete configAfter.categoryPolicy[categoryKey];

  const involved = new Set(["central"]);
  for (const src of [config.categoryPolicy?.[categoryKey], policyAfter]) {
    if (src && typeof src === "object") for (const k of Object.keys(src)) if (k !== "perSize") involved.add(k);
  }
  // Every configured destination, because the model now walks legs the map does
  // not arm (a category still refills there off explicit rows, and the engine
  // counts those). Reading only the armed ones would hand the model an empty
  // targets map for those legs and silently reproduce the under-reporting bug
  // the differential fuzz caught.
  for (const loc of Object.keys(config.mode || {})) involved.add(loc);
  // Sources too: a leg's requests are capped by what its source can pick, so a
  // preview that never read the source's stock would report requests the engine
  // will not create.
  for (const loc of [...involved]) { const src = config.routes?.[loc]; if (src) involved.add(src); }
  // Carriage has to be answered for EVERY location the card can offer, not just
  // the armed ones — "Not carried" is the reason a row is not editable, so the
  // card needs the answer for the rows it greys out too.
  const carriageLocs = [...new Set([...involved, ...(locations || [])])];

  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of carriageLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`);
  for (const loc of involved) {
    targets[loc] = await readMapPaged(db, `stock_targets/${loc}`);
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`);
  }
  const args = {
    products, stock, targets, openIndex, categoryKey, locations: carriageLocs,
    maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
  };
  return {
    before: modelCategoryPolicy({ config, ...args }),
    after: modelCategoryPolicy({ config: configAfter, ...args }),
  };
}

// ── THE CENSUS ───────────────────────────────────────────────────────────────
// What the card's LIST needs, answered server-side in one call: per category,
// the product count, units on hand, which locations carry it, whether it is
// armed, and how many products are overridden by their own explicit rows.
//
// ── WHAT THIS COSTS, STATED HONESTLY ────────────────────────────────────────
// Paging a node is not the same as not reading it. This walks the WHOLE of
// /products, because there is no index on categoryKey and every category has
// to be counted — an unarmed one is exactly what the "Set policy" button is
// for. Paging bounds each request and makes it resumable; it does not make the
// bytes free. So two things reduce the bill instead of pretending it away:
//
//   1. STOCK IS READ FOR DESTINATIONS + CENTRAL ONLY. It used to walk every
//      key in /locations — including base, studio, in_transit, hub1 and hub3,
//      none of which the card can arm or offer. central is in because it is
//      the only place a hub deficit can be filled from and "Central holds N"
//      is half of every verdict.
//   2. A WARM INSTANCE REUSES THE LAST ANSWER for CENSUS_TTL_MS. The owner
//      opening the screen, expanding a row, saving and looking again is four
//      calls in two minutes; without this it was four full catalogue reads.
//      The cache is per-instance and in-memory — it dies with the instance,
//      is never shared between callers, and is dropped outright whenever a
//      write lands, so a save is never followed by a stale list.
//
// It is still server-side rather than in the browser for the original reason:
// a client deriving these numbers would download the catalogue and the stock
// tree onto a phone on a shop network on every visit.
//
// The override count is the expensive part of the computation and is worth it:
// a map edit that appears to do nothing is the most confusing thing this
// system does, and the reason is always an explicit row outranking the map.
const CENSUS_TTL_MS = 120000;
let censusCache = null;    // { at, key, payload } — per-instance, never shared

function invalidateCensusCache() { censusCache = null; }

async function buildCensus(db, { config, taxonomy, knownLocations }) {
  const policy = isPlainObject(config.categoryPolicy) ? config.categoryPolicy : {};
  const cats = isPlainObject(taxonomy?.cats) ? taxonomy.cats : {};
  const keys = [...new Set([...Object.keys(policy), ...Object.keys(cats)])].sort();

  const destinations = Object.keys(config.mode || {});
  // Every location the map ALREADY names, even one that is not a configured
  // destination. Without this an armed-but-not-a-destination location got
  // `targets[loc] === undefined`, so resolveTarget found no explicit row and
  // the census reported "0 overridden" for a category that was in fact fully
  // overridden there — the single number this screen is built around.
  const armedAnywhere = new Set();
  for (const entry of Object.values(isPlainObject(config.categoryPolicy) ? config.categoryPolicy : {})) {
    if (isPlainObject(entry)) for (const k of Object.keys(entry)) if (k !== "perSize" && isPlainObject(entry[k])) armedAnywhere.add(k);
  }
  // The locations the card can show, arm, or reason about — plus central, the
  // only place a hub deficit can be filled from. Reading the rest (studio,
  // in_transit, base) was reading them for nothing.
  // Route SOURCES too. The model's actionable-only gate reads the source's
  // stock, so a source whose node was never read looks empty and every cell it
  // feeds parks as "no stock upstream". Today every source happens to be a
  // destination, so this changes nothing — but one routes edit away it would
  // have silently zeroed a whole leg's requests. buildPreview already does it.
  const sources = Object.values(config.routes || {});
  const stockLocs = [...new Set([...destinations, ...armedAnywhere, ...sources, "central"])];
  const rowLocs = [...new Set([...destinations, ...armedAnywhere])];

  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of stockLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`);
  for (const loc of rowLocs) {
    targets[loc] = await readMapPaged(db, `stock_targets/${loc}`);
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`);
  }

  const categories = [];
  for (const key of keys) {
    const entry = isPlainObject(policy[key]) ? policy[key] : null;
    const armed = entry ? Object.keys(entry).filter((k) => k !== "perSize" && isPlainObject(entry[k])) : [];
    const { pids, byLocation } = carriageForCategory({ products, stock, categoryKey: key, locations: stockLocs });
    // resolveTarget is only run where the map is armed. An unarmed category
    // resolves nothing through it by definition, and walking every product at
    // every location for forty categories would be a minute of nothing.
    const m = armed.length
      ? modelCategoryPolicy({ config, products, stock, targets, openIndex, categoryKey: key,
          locations: stockLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent })
      : null;
    categories.push({
      key,
      label: cats[key]?.label || key,
      inTaxonomy: !!cats[key],
      active: cats[key]?.active !== false,
      sizeMode: entry?.perSize === true ? "list" : (cats[key]?.sizeMode || "one"),
      perSize: entry?.perSize === true,
      entry,
      armed,
      products: pids.length,
      units: Object.values(byLocation).reduce((n, v) => n + v.units, 0),
      carriage: byLocation,
      overriddenProducts: m ? m.overriddenProducts : 0,
      overriddenCells: m ? m.legs.reduce((n, l) => n + l.overrides, 0) : 0,
      // Explicit rows the engine honours on sizes this map does not speak for.
      // Not an override — a cleanup backlog, and a different sentence.
      legacyRowProducts: m ? m.legacyRowProducts : 0,
      legacyRowCells: m ? m.legacyRowCells : 0,
      // Both, because "how many resolve the map" has two honest answers and
      // reporting only one of them invited the wrong comparison: the override
      // figure next to it is per PRODUCT, so a cells-only number here read as
      // though the two could be subtracted.
      // cells MINUS both kinds of explicit row. A legacy row resolves
      // source:"explicit" just as an override does — it simply sits on a size
      // the map does not speak for — so subtracting only overrides counted
      // every one of them as "resolving the map". On caps-beanies that
      // overstated the figure by exactly 188.
      resolvesMapCells: m ? m.legs.reduce((n, l) => n + (l.cells - l.overrides - l.legacyRows), 0) : 0,
      resolvesMapProducts: m ? Math.max(pids.length - m.overriddenProducts, 0) : 0,
    });
  }
  return { categories, destinations };
}

// The audit trail, newest first, bounded. `.indexOn: ["at"]` is part of the
// console rule this feature ships with; without it RTDB downloads the node and
// sorts on the client, which is the thing being avoided.
async function readHistory(db, limit = 25) {
  const snap = await db.ref(HISTORY_PATH).orderByChild("at").limitToLast(limit).once("value");
  const out = [];
  snap.forEach((c) => { out.push({ id: c.key, ...(c.val() || {}) }); });
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ── THE ENTRY POINT ──────────────────────────────────────────────────────────
async function applyCategoryPolicy({ db, callerEmail, adminEmail, callerUid, data, nowMs }) {
  assertSuperAdmin(callerEmail, adminEmail);

  const d = data && typeof data === "object" ? data : {};
  const categoryKey = d.categoryKey;
  const dryRun = d.dryRun === true;

  const [config, taxonomy, locationsNode] = await Promise.all([
    val(db, "config/refillEngine"), val(db, "settings/productTaxonomy"), val(db, "locations"),
  ]);
  const cfg = config && typeof config === "object" ? config : {};
  const knownCategoryKeys = Object.keys(taxonomy?.cats || {});
  const knownLocations = Object.keys(locationsNode || {});

  // Read-only. Reached only after the owner check above, so a refused caller
  // does not get a catalogue-wide census either.
  if (d.action === "census") {
    // The cache key includes the live policy, so arming a category through any
    // other route (a script, the console) invalidates it too — the cache can
    // go stale on stock movements within the TTL, never on the policy itself,
    // which is what this screen is actually about. `refresh: true` skips it.
    const key = canonical({ policy: cfg.categoryPolicy ?? null, cap: cfg.maxIntentsPerRun ?? null, mode: cfg.mode ?? null });
    const fresh = !!censusCache && censusCache.key === key && (nowMs - censusCache.at) < CENSUS_TTL_MS;
    const census = fresh && d.refresh !== true
      ? censusCache.payload
      : await buildCensus(db, { config: cfg, taxonomy, knownLocations });
    if (!fresh || d.refresh === true) censusCache = { at: nowMs, key, payload: census };
    return {
      ok: true,
      action: "census",
      ...census,
      // History is ALWAYS read live, never from the cache: it is the audit
      // trail, and a stale audit trail is worse than a slow one.
      cached: fresh && d.refresh !== true,
      locations: knownLocations,
      cap: cfg.maxIntentsPerRun ?? null,
      maxUnitsPerIntent: cfg.maxUnitsPerIntent ?? null,
      history: await readHistory(db),
      serverNowMs: nowMs,
    };
  }

  // ── UN-ARMING MUST BE SAID, NOT IMPLIED ───────────────────────────────────
  // `policy: null` is the documented off switch and stays legal. An ABSENT
  // policy field is refused outright: a truncated payload, a renamed field or a
  // half-built call would otherwise be indistinguishable from a deliberate
  // "delete this category's policy", and would silently un-arm a live category
  // with only the audit entry to show for it.
  if (!("policy" in d)) {
    throw httpsError("invalid-argument",
      'policy is required — send `policy: null` to un-arm a category. Omitting it is refused, because a dropped field must not delete a live policy.');
  }
  const policyAfter = normalizePolicy(d.policy);
  const err = validateCategoryPolicy(categoryKey, policyAfter, { knownLocations, knownCategoryKeys });
  if (err) throw httpsError("invalid-argument", err);

  const before = cfg.categoryPolicy?.[categoryKey] ?? null;

  // ── DRIFT ─────────────────────────────────────────────────────────────────
  // The card sends back the exact entry it rendered the editor from. If live no
  // longer matches it, somebody (or something) changed the policy while this
  // edit was open, and saving would silently discard their change. Abort and
  // make the owner re-open it.
  //
  // A dryRun skips this on purpose: a preview is a question, not a write, and
  // refusing to answer it because the world moved is unhelpful.
  //
  // DELETING THIS CHECK MUST FAIL TESTS. See mutation M-DRIFT.
  if (!dryRun && d.expectedBefore !== undefined && !sameValue(before, d.expectedBefore === null ? null : d.expectedBefore)) {
    throw httpsError("failed-precondition",
      "The policy changed while this was open. Close and re-open the category to see the current numbers.",
      { drift: true, live: before });
  }

  const changes = diffCategoryPolicy(before, policyAfter);
  const preview = await buildPreview(db, { config: cfg, categoryKey, policyAfter, locations: knownLocations });

  if (dryRun) {
    return { ok: true, dryRun: true, categoryKey, before, after: policyAfter, changes, preview, live: before };
  }
  if (!changes.length) {
    return { ok: true, noChange: true, categoryKey, before, after: policyAfter, changes: [], preview };
  }

  // ── HISTORY FIRST ─────────────────────────────────────────────────────────
  const historyRef = db.ref(HISTORY_PATH).push();
  await historyRef.set({
    categoryKey,
    at: nowMs,
    by: callerEmail,
    byUid: callerUid || null,
    before: before === undefined ? null : before,
    after: policyAfter,
    changes,
    // The model the decision was taken on, kept small: the per-leg totals only,
    // not the row lists. A revert six weeks from now should be able to see what
    // was expected at the time without re-deriving it against stock that moved.
    modelled: {
      requestsBefore: preview.before.totalRequests, requestsAfter: preview.after.totalRequests,
      unitsBefore: preview.before.totalUnits, unitsAfter: preview.after.totalUnits,
      centralOnHand: preview.after.centralOnHand, cap: preview.after.cap,
      overriddenProducts: preview.after.overriddenProducts,
    },
    status: "pending",
  });

  // ── RE-READ AND DRIFT AGAIN, IMMEDIATELY BEFORE THE MUTATION ──────────────
  // The preview above can take seconds (it pages the catalogue). This is the
  // check that actually protects the write; the earlier one just fails fast.
  const liveNow = await val(db, `${POLICY_PATH}/${categoryKey}`);
  if (!sameValue(liveNow ?? null, before)) {
    await historyRef.update({ status: "aborted_on_drift", liveAtAbort: liveNow ?? null });
    throw httpsError("failed-precondition",
      "The policy changed while this was being saved. Nothing was written.",
      { drift: true, live: liveNow ?? null, historyId: historyRef.key });
  }

  await db.ref(`${POLICY_PATH}/${categoryKey}`).set(policyAfter);
  // A save must never be followed by a stale list. The key check above would
  // catch this anyway; dropping it outright means one fewer thing to reason
  // about at the moment it matters most.
  invalidateCensusCache();

  // ── POST-VERIFY ───────────────────────────────────────────────────────────
  const written = await val(db, `${POLICY_PATH}/${categoryKey}`);
  const verified = sameValue(written ?? null, policyAfter);
  await historyRef.update({ status: verified ? "applied" : "unverified", verifiedAt: nowMs });
  if (!verified) {
    throw httpsError("internal",
      "The policy was written but did not read back as expected. Check the category before relying on it.",
      { historyId: historyRef.key, written: written ?? null });
  }

  return {
    ok: true, categoryKey, before, after: policyAfter, changes, preview,
    historyId: historyRef.key, history: await readHistory(db),
  };
}

module.exports = {
  applyCategoryPolicy, assertSuperAdmin, buildCensus, readHistory, invalidateCensusCache, normalizePolicy, canonical, sameValue,
  HISTORY_PATH, POLICY_PATH, httpsError, readMapPaged,
};

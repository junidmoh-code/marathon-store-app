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
  carriageForCategory, validateLocationEntry, REFUSED_CATEGORY_KEYS,
} = require("./category-policy.cjs");
const { validatePolicyGroup, sizeRunForCategory, sizeRunForGroup, fillAllSizes } = require("./policy-groups.cjs");
const { effectivePolicyFor, locationEntryMode, armedGroupForCategory } = require("./policy-resolve.cjs");
const { encodeSizeKey } = require("./refill-engine.cjs");

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const HISTORY_PATH = "engine_policy_history";
const POLICY_PATH = "config/refillEngine/categoryPolicy";
const GROUPS_PATH = "config/refillEngine/policyGroups";
const TARGETS_PATH = "stock_targets";

// ── EDITING AN EXPLICIT ROW: WHAT IS AND IS NOT ALLOWED ──────────────────────
// Junid has armed clothing by hand over months — 7,797 rows on 1,666 products,
// measured live 2026-08-22. Those rows are the SOURCE OF TRUTH for the products
// that carry them, not a mess to be tidied. So this path:
//
//   • UPDATES a row that already exists, in place
//   • REFUSES to create a row that does not exist (that is arming a new cell,
//     which is a different act with a different blast radius)
//   • REFUSES to delete a row, always, under any argument
//
// The third is a hard constraint of this build, not a default. There is no
// flag, no `force`, and no code path below that calls .remove() or writes null
// to a row. If a row ever needs to go, it goes through a reviewed bulk script
// with its own preview and its own rollback file, the same as every other bulk
// row change in this repo.
const MAX_ROW_EDITS_PER_CALL = 200;

// ── AND THE READ IS BOUNDED TOO ──────────────────────────────────────────────
// The row list used to return EVERY explicit row for a category with no limit.
// t-shirts has 1,870 of them, measured live 2026-08-22: the whole list crossed
// the callable in one payload and the panel drew three inputs per row — five
// and a half thousand inputs, on a phone, on a shop network. The write path
// already caps a save at 200; the read had no matching bound, which is the
// wrong way round, because the read is the one that happens every time the chip
// is tapped. (CodeRabbit, PR #401.)
//
// The response now carries `total`, `truncated` and the per-location counts, so
// the panel can say "showing N of M" honestly and offer a location to narrow
// to, rather than silently showing a prefix.
const MAX_ROWS_PER_READ = 300;

// The three fields this screen owns, normalised for comparison. An absent
// reorderPoint is null, never 0 — the two are different policies, and a drift
// check that conflated them would refuse a save that changed nothing.
const shapeOf = (r) => ({
  target: r?.target ?? null,
  minQty: r?.minQty ?? null,
  reorderPoint: typeof r?.reorderPoint === "number" ? r.reorderPoint : null,
});

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
    // ── A PER-SIZE MAP IS NORMALISED ROW BY ROW ─────────────────────────────
    // The uniform path below stamps `target` and a defaulted `minQty` onto the
    // location object. Run over a size map that produced { sizes, target:
    // undefined, minQty: 0 } — a shape the validator then refused with "unknown
    // field target next to a size map", which reads as the caller's mistake and
    // was this function's. Each size row gets the SAME treatment a uniform entry
    // gets — minQty defaulted from ceil(keep / 2), a blank Ask at dropped rather
    // than zeroed — and the location object itself is left alone.
    if (raw.sizes && typeof raw.sizes === "object" && !Array.isArray(raw.sizes) && raw.target === undefined) {
      const sizes = {};
      for (const [sk, row] of Object.entries(raw.sizes)) {
        if (row === null || row === undefined) continue;          // size removed
        if (typeof row !== "object" || Array.isArray(row)) { sizes[sk] = row; continue; }
        const e = { ...row, target: row.target };
        e.minQty = row.minQty === undefined || row.minQty === null ? defaultMinQty(row.target) : row.minQty;
        if (row.reorderPoint === undefined || row.reorderPoint === null) delete e.reorderPoint;
        sizes[sk] = e;
      }
      out[loc] = { ...raw, sizes };
      continue;
    }
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

// THE LOCATION SET THE SIZE RUN IS DERIVED OVER — one definition, used by the
// census (which decides what the editor OFFERS) and by the write path (which
// decides what it ACCEPTS). They were two different sets: the census walked
// destinations ∪ armed ∪ sources ∪ central, the write path every key under
// /locations, including studio, in_transit and base. The enforced run was
// therefore a strict superset of the offered one, and a size that exists only
// as in-transit stock was writable but never shown. (Adversarial review, #404.)
function censusLocationsFor(config) {
  const destinations = Object.keys(config?.mode || {});
  const sources = Object.values(config?.routes || {});
  return [...new Set([...destinations, ...rowLocationsFor(config), ...sources, "central"])];
}

// The locations that can hold an explicit row worth reading: every configured
// destination, plus any location the map or a group already arms. Central is a
// source, not a destination, and has no rows.
function rowLocationsFor(config) {
  const out = new Set(Object.keys(config?.mode || {}));
  const collect = (entry) => {
    if (!isPlainObject(entry)) return;
    for (const k of Object.keys(entry)) if (k !== "perSize" && isPlainObject(entry[k])) out.add(k);
  };
  for (const e of Object.values(isPlainObject(config?.categoryPolicy) ? config.categoryPolicy : {})) collect(e);
  for (const g of Object.values(isPlainObject(config?.policyGroups) ? config.policyGroups : {})) collect(g?.policy);
  return [...out];
}

// ── WHAT ARMING A GROUP WOULD COST, BEFORE IT IS ALLOWED ─────────────────────
// Models EVERY member through the same modelCategoryPolicy the preview panel
// uses, against a copy of the config with the group armed — never written. The
// number is a ceiling by the same construction as every other number that
// function produces, which is the right direction for a gate: it refuses on the
// worst case rather than being talked past by the best one.
async function modelGroupArming(db, { config, groupKey, group, knownLocations }) {
  const configAfter = {
    ...config,
    policyGroups: { ...(config.policyGroups || {}), [groupKey]: { ...group, armed: true } },
  };
  const involved = new Set(["central", ...Object.keys(config.mode || {})]);
  for (const k of Object.keys(group.policy || {})) if (k !== "perSize") involved.add(k);
  for (const loc of [...involved]) { const src = config.routes?.[loc]; if (src) involved.add(src); }
  const carriageLocs = [...new Set([...involved, ...(knownLocations || [])])];

  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of carriageLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`);
  for (const loc of involved) {
    targets[loc] = await readMapPaged(db, `${TARGETS_PATH}/${loc}`);
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`);
  }
  const perMember = [];
  let totalRequests = 0, totalUnits = 0;
  for (const key of (group.memberCategoryKeys || [])) {
    const m = modelCategoryPolicy({
      config: configAfter, products, stock, targets, openIndex, categoryKey: key,
      locations: carriageLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent,
    });
    perMember.push({ key, products: m.products, requests: m.totalRequests, units: m.totalUnits,
      liveRequests: m.liveRequests, policySource: m.policySource });
    totalRequests += m.totalRequests;
    totalUnits += m.totalUnits;
  }
  const cap = typeof config.maxIntentsPerRun === "number" && config.maxIntentsPerRun > 0 ? config.maxIntentsPerRun : 200;
  return { groupKey, perMember, totalRequests, totalUnits, cap, exceedsCap: totalRequests > cap };
}

// The derived size run for ONE category, read on demand. Same function the
// census uses, so the run the editor offered and the run the server enforces
// are the same list rather than two derivations that agree today.
async function deriveSizeRun(db, { config, categoryKey, knownLocations }) {
  void knownLocations;
  const locs = censusLocationsFor(config);
  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {};
  for (const loc of locs) {
    stock[loc] = await readMapPaged(db, `stock/${loc}`);
    targets[loc] = await readMapPaged(db, `${TARGETS_PATH}/${loc}`);
  }
  const taxonomy = await val(db, "settings/productTaxonomy");
  return sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey, locations: locs });
}

// The derived size run for a whole GROUP — the union of its members' runs, with
// every size marked by which members carry it. Same function the card's editor
// offers and the same one the write path validates against, so the run on
// screen and the run enforced are one list rather than two derivations.
async function deriveSizeRunForGroup(db, { config, memberCategoryKeys, knownLocations }) {
  void knownLocations;
  const locs = censusLocationsFor(config);
  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {};
  for (const loc of locs) {
    stock[loc] = await readMapPaged(db, `stock/${loc}`);
    targets[loc] = await readMapPaged(db, `${TARGETS_PATH}/${loc}`);
  }
  const taxonomy = await val(db, "settings/productTaxonomy");
  return sizeRunForGroup({ products, stock, targets, taxonomy, memberCategoryKeys, locations: locs });
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
  const groups = isPlainObject(config.policyGroups) ? config.policyGroups : {};
  const cats = isPlainObject(taxonomy?.cats) ? taxonomy.cats : {};
  // Every key the map names, every key the taxonomy knows, and every key a
  // GROUP names. The last one matters: a grouped category with no entry of its
  // own is governed, and it must be in the list that governs it.
  const groupedKeys = Object.values(groups).flatMap((g) => (Array.isArray(g?.memberCategoryKeys) ? g.memberCategoryKeys : []));
  const keys = [...new Set([...Object.keys(policy), ...Object.keys(cats), ...groupedKeys])].sort();

  const destinations = Object.keys(config.mode || {});
  // Every location the map ALREADY names, even one that is not a configured
  // destination. Without this an armed-but-not-a-destination location got
  // `targets[loc] === undefined`, so resolveTarget found no explicit row and
  // the census reported "0 overridden" for a category that was in fact fully
  // overridden there — the single number this screen is built around.
  // GROUPS COUNT TOO — including disarmed ones. A disarmed group resolves
  // nothing, but its locations are exactly what the editor will show when
  // somebody opens it, and reading a location's rows only once it is armed means
  // the numbers appear for the first time at the moment they start to matter.
  const armedAnywhere = new Set();
  const collectLocs = (entry) => {
    if (!isPlainObject(entry)) return;
    for (const k of Object.keys(entry)) if (k !== "perSize" && isPlainObject(entry[k])) armedAnywhere.add(k);
  };
  for (const entry of Object.values(isPlainObject(config.categoryPolicy) ? config.categoryPolicy : {})) collectLocs(entry);
  for (const g of Object.values(isPlainObject(config.policyGroups) ? config.policyGroups : {})) collectLocs(g?.policy);
  // The locations the card can show, arm, or reason about — plus central, the
  // only place a hub deficit can be filled from. Reading the rest (studio,
  // in_transit, base) was reading them for nothing.
  // Route SOURCES too. The model's actionable-only gate reads the source's
  // stock, so a source whose node was never read looks empty and every cell it
  // feeds parks as "no stock upstream". Today every source happens to be a
  // destination, so this changes nothing — but one routes edit away it would
  // have silently zeroed a whole leg's requests. buildPreview already does it.
  const sources = Object.values(config.routes || {});
  const stockLocs = censusLocationsFor(config);
  // THE SAME SET THE SIZE RUN IS DERIVED OVER, not a narrower one. The size-run
  // helpers read /stock_targets to decide which sizes are real, so reading the
  // maps over a smaller set here made the census OFFER a narrower run than the
  // write path ACCEPTS — a row-only size at a route source (central) was
  // writable and never shown. One set, one answer. (CodeRabbit, PR #404.)
  const rowLocs = censusLocationsFor(config);

  const products = await readMapPaged(db, "products");
  const stock = {}, targets = {}, openIndex = {};
  for (const loc of stockLocs) stock[loc] = await readMapPaged(db, `stock/${loc}`);
  for (const loc of rowLocs) {
    targets[loc] = await readMapPaged(db, `stock_targets/${loc}`);
    openIndex[loc] = await readMapPaged(db, `refill_engine/open/${loc}`);
  }

  // ── ROWS PER CATEGORY, FOR EVERY CATEGORY ────────────────────────────────
  // The shipped census computed the explicit-row count only where the map was
  // ARMED, so an unarmed clothing category with hundreds of hand-made rows
  // reported zero — t-shirts has 1,870 of them. The chip says "N with their own
  // rows" for every category now, which is only true if every category is
  // counted. Cheap: it walks the targets maps that are already in memory and
  // never calls the resolver.
  const rowsByCategory = {};
  for (const loc of rowLocs) {
    for (const [pid, bySize] of Object.entries(targets[loc] || {})) {
      const key = products[pid]?.categoryKey;
      if (!key) continue;
      const r = rowsByCategory[key] || (rowsByCategory[key] = { cells: 0, products: new Set(), byLocation: {}, bySize: {} });
      const n = Object.keys(bySize || {}).length;
      r.cells += n;
      r.products.add(pid);
      r.byLocation[loc] = (r.byLocation[loc] || 0) + n;
      // Kept per SIZE as well, so "N old rows" can be a count of ROWS on the
      // legacy sizes rather than a count of the sizes themselves. A category
      // with three legacy sizes holding 188 rows read "3 old rows".
      // (Fable review, PR #404.)
      for (const sk of Object.keys(bySize || {})) r.bySize[sk] = (r.bySize[sk] || 0) + 1;
    }
  }
  // A category that exists ONLY as rows — no taxonomy entry, no map entry. Live
  // today that is `visors` (12 rows, refused by owner decision) and `packaging`
  // (8 rows). They are real policy of a kind and are listed, read-only.
  const rowOnlyKeys = Object.keys(rowsByCategory).filter((k) => !keys.includes(k)).sort();

  const categories = [];
  // Kept so the group entries below can reuse them rather than deriving the
  // same runs a second time from the same maps.
  const runByCategory = {};
  for (const key of [...keys, ...rowOnlyKeys]) {
    const entry = isPlainObject(policy[key]) ? policy[key] : null;
    const armed = entry ? Object.keys(entry).filter((k) => k !== "perSize" && isPlainObject(entry[k])) : [];
    const { pids, byLocation } = carriageForCategory({ products, stock, categoryKey: key, locations: stockLocs });
    // The GROUP that speaks for this category, if it has no entry of its own.
    const g = armedGroupForCategory(config, key);
    const eff = effectivePolicyFor(config, key);
    const effEntry = eff ? eff.entry : null;
    const effArmed = isPlainObject(effEntry)
      ? Object.keys(effEntry).filter((k) => k !== "perSize" && locationEntryMode(effEntry[k]) !== "invalid") : [];
    // resolveTarget is only run where SOMETHING is armed — its own entry or its
    // group's. An unarmed, ungrouped category resolves nothing through the map
    // by definition, and walking every product at every location for forty
    // categories would be a minute of nothing.
    const m = effArmed.length
      ? modelCategoryPolicy({ config, products, stock, targets, openIndex, categoryKey: key,
          locations: stockLocs, maxIntentsPerRun: config.maxIntentsPerRun, maxUnitsPerIntent: config.maxUnitsPerIntent })
      : null;
    // The size run the per-size editor may offer, DERIVED from live data. An
    // empty run at a category the registry calls sized is a STOP — the card
    // refuses the per-size editor rather than offering a guessed list.
    const run = sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: key, locations: stockLocs });
    runByCategory[key] = run;
    const rows = rowsByCategory[key];
    categories.push({
      key,
      label: cats[key]?.label || key,
      // The studio photograph, cached on the taxonomy entry by
      // scripts/generate-category-images.mjs. Absent is normal and normal is
      // fine — the card falls back to the category's emoji.
      imageUrl: typeof cats[key]?.imageUrl === "string" ? cats[key].imageUrl : null,
      inTaxonomy: !!cats[key],
      active: cats[key]?.active !== false,
      sizeMode: effEntry?.perSize === true ? "list" : (cats[key]?.sizeMode || "one"),
      perSize: effEntry?.perSize === true,
      entry,
      // Where the numbers on screen come from. A grouped category shows the
      // group's numbers and must SAY SO — editing them here would give it an
      // entry of its own, which takes it out of the group. That is a bigger
      // change than the numbers suggest and the card says it out loud.
      policySource: eff ? eff.source : null,
      groupKey: g ? g.groupKey : null,
      groupLabel: g ? (g.group.label || g.groupKey) : null,
      effectiveEntry: effEntry,
      armedEffective: effArmed,
      // The shape each armed location holds — "uniform" or "per-size".
      shapes: isPlainObject(effEntry)
        ? Object.fromEntries(effArmed.map((l) => [l, locationEntryMode(effEntry[l])])) : {},
      sizeRun: run.sizes,
      sizeRunExtra: run.extra,
      // The ROWS sitting on those legacy sizes. Zero is normal and meaningful:
      // an extra size can come from a /stock cell with no row at all, and a
      // chip offering to open rows that do not exist is a chip that opens an
      // empty list.
      extraSizeRowCells: run.extra.reduce((n, sk) => n + (rowsByCategory[key]?.bySize?.[sk] || 0), 0),
      sizeRunEmpty: run.empty,
      // Explicit rows, counted for EVERY category rather than only armed ones.
      ownRowCells: rows ? rows.cells : 0,
      ownRowProducts: rows ? rows.products.size : 0,
      ownRowsByLocation: rows ? rows.byLocation : {},
      rowOnly: !cats[key] && !entry,
      refused: REFUSED_CATEGORY_KEYS.has(key),
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
  // ── A GROUP IS ONE ENTRY IN THE SAME LIST ────────────────────────────────
  // Not a section above it. See buildGroupEntries.
  const groupEntries = buildGroupEntries({ config, taxonomy, categories, products, stock, targets,
    locations: stockLocs, runByCategory });
  const memberKeys = new Set(groupEntries.flatMap((g) => g.memberCategoryKeys));
  for (const c of categories) if (memberKeys.has(c.key)) c.memberOfGroup = groupEntries.find((g) => g.memberCategoryKeys.includes(c.key)).groupKey;

  return { categories, groupEntries, destinations, groups, rowLocations: rowLocs };
}

// ── A GROUP, PRESENTED AS ONE CATEGORY ───────────────────────────────────────
// The Sneakers policy governs seven categories and is ONE thing the owner sets.
// It used to be a separate section at the top of the screen with three
// paragraphs explaining what a group was; it is now one entry in the same list
// as every category, sorted in with them, opened the same way.
//
// So the census hands the card a row of the SAME SHAPE a category row has —
// photo, counts, armed state — with the members' numbers summed, and the member
// list attached so they stay reachable from inside it. The members are marked
// `memberOfGroup` and the card leaves them out of the top-level list: a category
// that appears twice, once under its group and once beside it, is the thing the
// separate section was.
//
// NOTHING HERE ARMS ANYTHING. The entry reports `armed` straight off the group
// node, and a group seeded disarmed reads as disarmed until somebody arms it
// deliberately, with a preview, through the write path.
function buildGroupEntries({ config, taxonomy, categories, products, stock, targets, locations, runByCategory }) {
  const groups = isPlainObject(config?.policyGroups) ? config.policyGroups : {};
  const cats = isPlainObject(taxonomy?.cats) ? taxonomy.cats : {};
  const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
  const out = [];
  for (const [groupKey, g] of Object.entries(groups)) {
    if (!isPlainObject(g)) continue;
    const memberCategoryKeys = (Array.isArray(g.memberCategoryKeys) ? g.memberCategoryKeys : []).filter((k) => typeof k === "string");
    const entry = isPlainObject(g.policy) ? g.policy : null;
    const armedLocs = entry
      ? Object.keys(entry).filter((k) => k !== "perSize" && locationEntryMode(entry[k]) !== "invalid") : [];
    // The union of the members' runs, every size marked with who carries it.
    // `runByCategory` is what the census loop ALREADY derived for every category
    // a moment ago; without it this walked /products and every /stock and
    // /stock_targets map a second time, once per member. (Architecture review.)
    const run = sizeRunForGroup({ products, stock, targets, taxonomy, memberCategoryKeys, locations,
      precomputed: runByCategory });
    // Carriage is merged across the members: a location carries the group if it
    // carries ANY member, and its counts are the members' counts added up.
    const carriage = {};
    let productCount = 0, unitCount = 0, ownRowCells = 0, ownRowProducts = 0, overridden = 0;
    const members = [];
    for (const key of memberCategoryKeys) {
      const c = byKey[key];
      if (!c) { members.push({ key, label: cats[key]?.label || key, missing: true }); continue; }
      productCount += c.products; unitCount += c.units;
      ownRowCells += c.ownRowCells || 0; ownRowProducts += c.ownRowProducts || 0;
      overridden += c.overriddenProducts || 0;
      for (const [loc, v] of Object.entries(c.carriage || {})) {
        const m = carriage[loc] || (carriage[loc] = { carries: false, products: 0, units: 0 });
        m.carries = m.carries || v.carries === true;
        m.products += v.products || 0;
        m.units += v.units || 0;
      }
      members.push({
        key, label: c.label, imageUrl: c.imageUrl, products: c.products, units: c.units,
        // A member with numbers of its own is NOT governed by this group — its
        // own policy beats the group's entirely. The member list says so, in
        // one line rather than a paragraph.
        hasOwnPolicy: !!c.entry,
        armedEffective: c.armedEffective || [],
        ownRowCells: c.ownRowCells || 0,
        sizeRun: run.byMember[key]?.sizes || [],
      });
    }
    out.push({
      key: `group:${groupKey}`, groupKey, isGroup: true,
      label: g.label || groupKey,
      // The group borrows the photo of the member it is named after when there
      // is one, and the first member with a photo otherwise.
      // The first member that has a photo. There is no "the member it is named
      // after" rule: the group key and the member keys are independent strings,
      // and a heuristic that strips "-all" matched nothing for the live group.
      imageUrl: members.find((m) => m.imageUrl)?.imageUrl || null,
      memberCategoryKeys, members,
      armedGroup: g.armed === true,
      // THE LIVE NODE, VERBATIM. The card sends this back as `expectedBefore`,
      // and a rebuilt {label, memberCategoryKeys, armed, policy} would compare
      // unequal to a node that simply lacks a key — so every save would fail
      // with "the group changed while this was open", which is both false and
      // inescapable. (Adversarial review, #404.)
      rawGroup: g,
      entry, effectiveEntry: entry, policySource: "group",
      perSize: entry?.perSize === true,
      armed: armedLocs, armedEffective: g.armed === true ? armedLocs : [],
      // What the group's policy NAMES, whether or not the group is armed. The
      // editor needs it to render the numbers already typed into a disarmed
      // group; `armedEffective` is what the ENGINE acts on, and for a disarmed
      // group that is nothing at all.
      policyLocations: armedLocs,
      shapes: entry ? Object.fromEntries(armedLocs.map((l) => [l, locationEntryMode(entry[l])])) : {},
      sizeRun: run.sizes, sizeRunPartial: run.partial, sizeRunByMember: run.byMember,
      sizeRunCarriedBy: run.carriedBy, sizeRunEmpty: run.empty,
      membersWithoutRun: run.membersWithoutRun,
      // Cells the members hold on sizes outside the offered run — the legacy
      // rows. Aggregated across members rather than left empty: they are only
      // reachable through a member now, and a count of 0 on the group entry
      // said there were none. They are counted here and listed per member; the
      // chip that OPENS them stays on the member, because the row list is
      // keyed by categoryKey and a group is not one.
      sizeRunExtra: [...new Set(members.flatMap((m) => runByCategory?.[m.key]?.extra || []))],
      products: productCount, units: unitCount, carriage,
      ownRowCells, ownRowProducts, overriddenProducts: overridden,
      inTaxonomy: false, active: true, refused: false, rowOnly: false,
    });
  }
  return out.sort((a, b) => String(a.label).localeCompare(String(b.label)));
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
    // policyGroups is in the cache key for the same reason categoryPolicy is:
    // arming a group through any other route must not be served a stale list.
    const key = canonical({ policy: cfg.categoryPolicy ?? null, groups: cfg.policyGroups ?? null,
      cap: cfg.maxIntentsPerRun ?? null, mode: cfg.mode ?? null });
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

  // ── THE EXPLICIT-ROW LIST — "N with their own rows", opened for editing ───
  // Read-only. Returns every /stock_targets row on the products in a category,
  // with the product's name and the current three numbers, so the card can show
  // them as the current values rather than as a warning count.
  if (d.action === "rows") {
    if (typeof categoryKey !== "string" || !categoryKey) {
      throw httpsError("invalid-argument", "categoryKey is required to list rows.");
    }
    const allRowLocs = rowLocationsFor(cfg);
    // An optional narrowing. Validated against the known set rather than
    // interpolated on trust — this string becomes a path segment.
    const onlyLoc = typeof d.loc === "string" && d.loc ? d.loc : null;
    if (onlyLoc && !allRowLocs.includes(onlyLoc)) {
      throw httpsError("invalid-argument", `unknown location "${onlyLoc}"`);
    }
    // EVERY LOCATION IS COUNTED, whatever `loc` narrows the RESULT to. Counting
    // only the narrowed location made `total` mean "rows at Hub 2" while the
    // panel rendered it on an "All" chip — so narrowing a 1,870-row category to
    // one shop made the All chip read "All (240)". The bound this action exists
    // for is on the PAYLOAD, not on the count. (Delta review, PR #401.)
    const products = await readMapPaged(db, "products");
    const pids = new Set(Object.keys(products).filter((pid) => products[pid]?.categoryKey === categoryKey));
    const all = [];
    const byLocation = {};
    for (const loc of allRowLocs) {
      const t = await readMapPaged(db, `${TARGETS_PATH}/${loc}`);
      for (const [pid, bySize] of Object.entries(t)) {
        if (!pids.has(pid)) continue;
        for (const [sizeKey, row] of Object.entries(bySize || {})) {
          if (!isPlainObject(row)) continue;
          byLocation[loc] = (byLocation[loc] || 0) + 1;
          all.push({
            loc, pid, sizeKey,
            name: products[pid]?.name || "",
            target: typeof row.target === "number" ? row.target : null,
            minQty: typeof row.minQty === "number" ? row.minQty : null,
            reorderPoint: typeof row.reorderPoint === "number" ? row.reorderPoint : null,
          });
        }
      }
    }
    all.sort((a, b) => a.name.localeCompare(b.name) || a.loc.localeCompare(b.loc) || a.sizeKey.localeCompare(b.sizeKey));
    const shown = onlyLoc ? all.filter((r) => r.loc === onlyLoc) : all;
    const rows = shown.slice(0, MAX_ROWS_PER_READ);
    return {
      ok: true, action: "rows", categoryKey, rows,
      count: rows.length,
      // `total` is every row on the category. `matching` is how many the
      // current narrowing has. Two numbers because the panel shows both, and
      // conflating them is what made the All chip lie.
      total: all.length,
      matching: shown.length,
      truncated: shown.length > rows.length,
      // Whether narrowing further can help. Once a SINGLE location is still
      // over the limit there is no other axis, and telling the owner to "narrow
      // to one location" while they already have is worse than saying so.
      narrowingHelps: !onlyLoc && shown.length > rows.length,
      limit: MAX_ROWS_PER_READ,
      loc: onlyLoc, locations: allRowLocs, byLocation,
      serverNowMs: nowMs,
    };
  }

  // ── EDIT EXPLICIT ROWS IN PLACE ───────────────────────────────────────────
  // One multi-path update, so a half-applied batch is not a state the estate can
  // end up in. Every edit is checked against the row that is LIVE right now: an
  // absent row is refused (this path never creates), and a row whose current
  // numbers do not match what the editor was opened on is refused (somebody else
  // changed it while this was open). Deletion is not expressible.
  if (d.action === "setRows") {
    const edits = Array.isArray(d.rows) ? d.rows : null;
    if (!edits || !edits.length) throw httpsError("invalid-argument", "rows must be a non-empty list of edits.");
    if (edits.length > MAX_ROW_EDITS_PER_CALL) {
      throw httpsError("invalid-argument", `at most ${MAX_ROW_EDITS_PER_CALL} rows per save — split the change.`);
    }
    const knownLocs = new Set(knownLocations);
    const update = {}, applied = [], changes = [], expectations = [];
    for (const e of edits) {
      if (!isPlainObject(e)) throw httpsError("invalid-argument", "each row edit must be an object.");
      const { loc, pid, sizeKey } = e;
      for (const [name, v] of [["loc", loc], ["pid", pid], ["sizeKey", sizeKey]]) {
        if (typeof v !== "string" || !v || !/^[A-Za-z0-9_-]+$/.test(v)) {
          throw httpsError("invalid-argument", `${name} ${JSON.stringify(v)} is not a single key segment.`);
        }
      }
      if (knownLocs.size && !knownLocs.has(loc)) throw httpsError("invalid-argument", `unknown location "${loc}"`);
      const next = { target: e.target, minQty: e.minQty };
      if (e.reorderPoint !== undefined && e.reorderPoint !== null) next.reorderPoint = e.reorderPoint;
      const err = validateLocationEntry(next, { where: `${loc} ${pid} ${sizeKey}`, perSize: false });
      if (err) throw httpsError("invalid-argument", err);

      const path = `${TARGETS_PATH}/${loc}/${pid}/${sizeKey}`;
      const live = await val(db, path);
      // NEVER CREATE. An absent row here is either a stale list or an attempt to
      // arm a new cell through the wrong door; both are refused, loudly.
      if (!isPlainObject(live)) {
        throw httpsError("failed-precondition",
          `${loc} / ${pid} / ${sizeKey} has no row today. This screen edits rows that already exist; it does not create them.`,
          { missing: { loc, pid, sizeKey } });
      }
      // ── DRIFT, PER ROW, AND IT IS NOT OPTIONAL ──────────────────────────
      // `expected` is what the editor rendered. It was optional, which meant a
      // caller that omitted it got NO drift protection at all — and the one
      // shape most likely to omit it is a retry or a script, exactly where
      // silently reverting somebody else's write does the most damage. It is
      // required now.
      if (!isPlainObject(e.expected)) {
        throw httpsError("invalid-argument",
          `${loc} / ${pid} / ${sizeKey}: expected is required — send the numbers the editor was opened on, so a change made underneath is refused rather than overwritten.`);
      }
      const wantShape = shapeOf(e.expected);
      if (!sameValue(shapeOf(live), wantShape)) {
        throw httpsError("failed-precondition",
          `${loc} / ${pid} / ${sizeKey} changed while this was open. Close and re-open the list.`,
          { drift: true, live: shapeOf(live) });
      }
      expectations.push({ path, wantShape });
      // The whole row is REPLACED with the validated shape, so a blank "Ask at"
      // removes the field rather than leaving the old one behind — the same
      // absent-is-not-zero rule the map obeys. Every other field the row carries
      // is preserved: the engine reads target/minQty/reorderPoint, but a row may
      // hold provenance the scan wrote and this screen has no business dropping.
      const preserved = { ...live };
      delete preserved.target; delete preserved.minQty; delete preserved.reorderPoint;
      update[path] = { ...preserved, ...next };
      applied.push({ loc, pid, sizeKey, before: live, after: update[path] });
      for (const f of ["target", "minQty", "reorderPoint"]) {
        const from = typeof live[f] === "number" ? live[f] : null;
        const to = typeof next[f] === "number" ? next[f] : null;
        if (from !== to) changes.push({ loc, pid, sizeKey, field: f, from, to });
      }
    }
    if (!changes.length) return { ok: true, action: "setRows", noChange: true, changes: [] };

    // HISTORY FIRST, holding every `before` in full — same ordering and same
    // reasoning as the policy write below.
    const historyRef = db.ref(HISTORY_PATH).push();
    await historyRef.set({
      kind: "rows", categoryKey: categoryKey || null, at: nowMs, by: callerEmail, byUid: callerUid || null,
      rowCount: applied.length, before: applied.map((a) => ({ loc: a.loc, pid: a.pid, sizeKey: a.sizeKey, row: a.before })),
      changes, status: "pending",
    });
    // ── RE-VERIFY IMMEDIATELY BEFORE THE WRITE ───────────────────────────────
    // The loop above is up to 200 sequential round-trips; on a large category
    // that is seconds, and the values it read are seconds old by the time the
    // update goes out. Without this, a concurrent write landing mid-batch — an
    // auto-adopt run, a second admin tab — was silently reverted, with no error
    // and no trace in the returned diff, which was computed against the stale
    // read. The category-policy and group writes both re-read immediately
    // before their mutation for exactly this reason; this path did not.
    // (Architecture review, PR #401.)
    for (const { path, wantShape } of expectations) {
      const nowLive = await val(db, path);
      if (!isPlainObject(nowLive) || !sameValue(shapeOf(nowLive), wantShape)) {
        await historyRef.update({ status: "aborted_on_drift", driftedPath: path, liveAtAbort: nowLive ?? null });
        throw httpsError("failed-precondition",
          `${path} changed while this was being saved. Nothing was written.`,
          { drift: true, path, live: nowLive ?? null, historyId: historyRef.key });
      }
    }
    await db.ref().update(update);
    invalidateCensusCache();
    await historyRef.update({ status: "applied", verifiedAt: nowMs });
    return { ok: true, action: "setRows", categoryKey: categoryKey || null, changes,
      rowCount: applied.length, historyId: historyRef.key, history: await readHistory(db) };
  }

  // ── GROUPS ────────────────────────────────────────────────────────────────
  // One write path for creating, editing, arming and deleting a group. Arming
  // is not a separate verb: it is the `armed` field, validated with everything
  // else, so a group can never be armed by a call that skipped the shape check.
  if (d.action === "setGroup") {
    const groupKey = d.groupKey;
    if (!("group" in d)) {
      throw httpsError("invalid-argument",
        "group is required — send `group: null` to delete it. Omitting it is refused, because a dropped field must not delete a live group.");
    }
    const liveGroups = isPlainObject(cfg.policyGroups) ? cfg.policyGroups : {};
    const before = liveGroups[groupKey] ?? null;
    const after = d.group;
    // ── THE MEMBER LIST IS CHECKED FOR SHAPE BEFORE ANYTHING READS IT ───────
    // A group whose memberCategoryKeys is missing, a string, or an object threw
    // "not iterable" out of the refusal loop below, or reported "no size run
    // can be worked out" — both instead of validatePolicyGroup's precise
    // "memberCategoryKeys must name at least one category". Shape first, then
    // the reads. (CodeRabbit, PR #404.)
    const membersUsable = after === null || (isPlainObject(after) && Array.isArray(after.memberCategoryKeys));
    if (!membersUsable) {
      const shapeErr = validatePolicyGroup(groupKey, after, {
        knownCategoryKeys, knownLocations, existingGroups: liveGroups, categoryPolicy: cfg.categoryPolicy });
      throw httpsError("invalid-argument", shapeErr || "group must be an object, or null to delete it");
    }

    // CHEAP REFUSALS FIRST. This used to sit after the size-run derivation, so
    // a group naming a refused category paid for a full catalogue read before
    // being told no. (Architecture review.)
    for (const m of (after?.memberCategoryKeys || [])) {
      if (REFUSED_CATEGORY_KEYS.has(m)) {
        throw httpsError("invalid-argument", `"${m}" carries no policy by owner decision and cannot be put in a group`);
      }
    }

    // ── THE SIZES THIS GROUP MAY BE GIVEN A POLICY ON ──────────────────────
    // The union of its members' derived runs. Only read when the edit actually
    // carries a size map, because deriving it costs a catalogue page and a
    // uniform edit has no use for it. An empty union is a STOP: a group whose
    // members have no derivable size run does not get a per-size editor with a
    // guessed list in it, and does not get a per-size write either.
    let groupAllowedSizes = null;
    const groupCarriesSizeMap = isPlainObject(after?.policy)
      && Object.keys(after.policy).some((k) => k !== "perSize" && locationEntryMode(after.policy[k]) === "per-size");
    if (groupCarriesSizeMap) {
      const run = await deriveSizeRunForGroup(db, {
        config: cfg, memberCategoryKeys: after.memberCategoryKeys, knownLocations });
      if (run.empty) {
        throw httpsError("failed-precondition",
          `No size run can be worked out for the "${groupKey}" group from the live data — none of its categories declares a size, holds a cell or carries a row. A size-by-size policy here would be a guess.`,
          { sizeRunEmpty: true, group: true });
      }
      groupAllowedSizes = run.sizes;
    }
    const err = validatePolicyGroup(groupKey, after, {
      knownCategoryKeys, knownLocations, existingGroups: liveGroups, categoryPolicy: cfg.categoryPolicy,
      allowedSizes: groupAllowedSizes,
    });
    if (err) throw httpsError("invalid-argument", err);

    // ── ARMING IS MODELLED BEFORE IT IS ALLOWED ──────────────────────────────
    // A group that would produce more requests in one scan than the per-scan cap
    // does not get armed from this screen. Measured live 2026-08-22, arming
    // footwear-all would produce 2,176 requests against a cap of 75 — 29x, and
    // the cap is SHARED with every clothing category, so it would not merely be
    // slow, it would starve everything else. That is not a confirmation dialog's
    // job; it is a refusal with the number in it.
    // THE TEST IS THE RESULTING STATE, NOT THE TRANSITION. An earlier version
    // gated on `before?.armed !== true`, so it fired once — when a group was
    // first armed — and never again. Editing an ALREADY-ARMED group then
    // skipped the cap entirely: adding forty categories to memberCategoryKeys,
    // or raising every target from 5 to 100, left `before.armed === true`, so
    // the model never ran and the write went straight through. That is the
    // 2,176-against-75 scenario this gate exists for, reached by the one path
    // the gate did not cover. (Architecture review, PR #401.)
    //
    // Every write that leaves the group armed is modelled now. It costs a
    // catalogue page per group edit, and group edits are rare.
    // A DRY RUN MODELS A DISARMED GROUP TOO, and says it is hypothetical. The
    // Sneakers group is seeded disarmed and stays that way; without this, its
    // editor could never run a preview, and Save is gated on a preview of the
    // numbers currently on screen. "If this were armed, the next scan would ask
    // for N" is exactly the question somebody editing a disarmed group has.
    let armModel = null;
    let hypothetical = false;
    if (after && after.armed !== true && d.dryRun === true && isPlainObject(after.policy)) {
      armModel = await modelGroupArming(db, { config: cfg, groupKey, group: after, knownLocations });
      hypothetical = true;
    }
    if (after && after.armed === true) {
      armModel = await modelGroupArming(db, { config: cfg, groupKey, group: after, knownLocations });
      if (armModel.exceedsCap) {
        throw httpsError("failed-precondition",
          `Arming "${groupKey}" would ask for ${armModel.totalRequests} refills on the next scan, against a limit of ${armModel.cap} shared with every other category. That is ${Math.round(armModel.totalRequests / armModel.cap)}x the limit. Bring the numbers down, or arm fewer categories, before turning it on.`,
          { overCap: true, model: armModel });
      }
    }

    if (d.dryRun === true) {
      return { ok: true, dryRun: true, action: "setGroup", groupKey, before, after, armModel, hypothetical };
    }
    if (sameValue(before, after)) {
      return { ok: true, action: "setGroup", noChange: true, groupKey, before, after };
    }
    if (d.expectedBefore !== undefined && !sameValue(before, d.expectedBefore === null ? null : d.expectedBefore)) {
      throw httpsError("failed-precondition",
        "The group changed while this was open. Close and re-open it to see the current numbers.",
        { drift: true, live: before });
    }

    const historyRef = db.ref(HISTORY_PATH).push();
    await historyRef.set({
      kind: "group", groupKey, at: nowMs, by: callerEmail, byUid: callerUid || null,
      before, after, armed: after?.armed === true,
      modelled: armModel ? { requests: armModel.totalRequests, units: armModel.totalUnits, cap: armModel.cap } : null,
      status: "pending",
    });
    const liveNow = await val(db, `${GROUPS_PATH}/${groupKey}`);
    if (!sameValue(liveNow ?? null, before)) {
      await historyRef.update({ status: "aborted_on_drift", liveAtAbort: liveNow ?? null });
      throw httpsError("failed-precondition", "The group changed while this was being saved. Nothing was written.",
        { drift: true, live: liveNow ?? null, historyId: historyRef.key });
    }
    await db.ref(`${GROUPS_PATH}/${groupKey}`).set(after);
    invalidateCensusCache();
    const written = await val(db, `${GROUPS_PATH}/${groupKey}`);
    const verified = sameValue(written ?? null, after);
    await historyRef.update({ status: verified ? "applied" : "unverified", verifiedAt: nowMs });
    if (!verified) {
      throw httpsError("internal", "The group was written but did not read back as expected.",
        { historyId: historyRef.key, written: written ?? null });
    }
    return { ok: true, action: "setGroup", groupKey, before, after, armModel,
      historyId: historyRef.key, history: await readHistory(db) };
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
  // ── THE SIZES THIS CATEGORY MAY BE GIVEN A POLICY ON ──────────────────────
  // Derived from live data — what its products declare, what /stock holds, what
  // /stock_targets rows exist — intersected with the registry's declared run.
  // Only read when the edit actually carries a per-size map, because deriving it
  // costs a catalogue page and a uniform edit has no use for it.
  let allowedSizes = null;
  const carriesSizeMap = isPlainObject(policyAfter)
    && Object.keys(policyAfter).some((k) => k !== "perSize" && locationEntryMode(policyAfter[k]) === "per-size");
  if (carriesSizeMap) {
    const run = await deriveSizeRun(db, { config: cfg, categoryKey, knownLocations });
    if (run.empty) {
      // Two different problems, two different sentences. A one-size category is
      // not broken — it simply has no sizes, and its map speaks for the "_" cell
      // alone. A sized category with no derivable run IS broken, and offering an
      // editor for it would mean guessing.
      throw httpsError(run.oneSize ? "invalid-argument" : "failed-precondition",
        run.oneSize
          ? `"${categoryKey}" is a one-size category — it has no sizes to set numbers against. Any letter cells it still holds are legacy rows, editable in the "with their own rows" list.`
          : `No size run can be worked out for "${categoryKey}" from the live data — no product declares a size, no cell exists and no row exists. A size-by-size policy here would be a guess.`,
        { sizeRunEmpty: true, oneSize: run.oneSize });
    }
    allowedSizes = run.sizes;
  }
  const err = validateCategoryPolicy(categoryKey, policyAfter, { knownLocations, knownCategoryKeys, allowedSizes });
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
  modelGroupArming, rowLocationsFor, censusLocationsFor, deriveSizeRun, deriveSizeRunForGroup, buildGroupEntries,
  HISTORY_PATH, POLICY_PATH, GROUPS_PATH, TARGETS_PATH,
  MAX_ROW_EDITS_PER_CALL, MAX_ROWS_PER_READ, httpsError, readMapPaged,
};

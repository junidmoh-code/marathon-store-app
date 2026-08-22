// ─── POLICY GROUPS AND PER-SIZE POLICY — THE SHARED CORE ──────────────────────
//
// Two extensions to the category map that shipped in #397, in ONE module so the
// engine, the callable, the census script and the card all answer from the same
// implementation rather than four that drift.
//
//   PART A — GROUPS.  /config/refillEngine/policyGroups/<groupKey>
//   PART B — PER-SIZE POLICY.  a location entry may hold a `sizes` map instead
//            of one collapsed number.
//
// Nothing in this file writes. It validates, it resolves, and it derives — the
// callers decide what to do with the answers.
//
// ═══ PART A — GROUPS ═════════════════════════════════════════════════════════
//
// Shape, at /config/refillEngine/policyGroups/<groupKey>:
//
//   {
//     "label": "All footwear except soccer boots",
//     "memberCategoryKeys": ["sneakers", "slides", …],
//     "armed": false,
//     "policy": { "perSize": true, "<dest>": { … } }     // same shape a
//                                                        // category entry has
//   }
//
// The brief for this build names label / memberCategoryKeys / armed. `policy`
// is the fourth field and it is not optional in spirit: "its group's policy" is
// a step in the resolution order, and a group with no policy is a step that
// resolves nothing. It is allowed to be absent — that is simply a group that
// has been drawn but not yet given numbers — and such a group can never arm
// anything, whatever `armed` says.
//
// ── THE RESOLUTION ORDER, AND THE ONE RULE THAT MAKES GROUPING SAFE ──────────
//
//   explicit /stock_targets row
//     > that category's OWN policy
//       > its group's policy
//         > footwear rule > kill switch > subcategory > size run
//
// A CATEGORY THAT HAS ITS OWN ENTRY NEVER CONSULTS ITS GROUP. Not "own entry at
// this location wins, group fills the gaps" — the whole group is skipped. The
// difference matters at a location the category's own entry does not name:
// under a per-location merge, adding a category to a group would silently arm
// it at a shop its own policy had deliberately left out, which is exactly the
// PE/Trophy contamination shape. Under this rule, grouping a category that has
// its own numbers changes NOTHING about it, which is what "a category's own
// policy always beats its group's" has to mean to be worth relying on.
//
// ── ARMED:FALSE MEANS THE GROUP IS NOT IN THE RESOLUTION AT ALL ──────────────
// Not "resolves to zero", not "resolves and then gets suppressed" — the lookup
// below returns null before it reads the policy. A disarmed group therefore
// cannot produce an intent by any path, and a group seeded disarmed is inert
// the moment it is written. Fail-safe by construction, and mutation-proved.
//
// ── OVERLAPPING MEMBERSHIP ───────────────────────────────────────────────────
// Refused at write time (a category may belong to at most one group). At READ
// time, if two armed groups somehow both claim a category, the lexicographically
// first group key wins and the overlap is reported — deterministic, so the
// engine and the preview cannot disagree, and visible rather than silent.
//
// ═══ PART B — PER-SIZE POLICY ════════════════════════════════════════════════
//
// A location entry is one of two shapes, never both:
//
//   UNIFORM   { "target": N, "minQty": N, "reorderPoint": N }
//   PER-SIZE  { "sizes": { "<encodedSize>": { "target": N, "minQty": N, … } } }
//
// The per-size shape is legal ONLY under perSize:true — a one-size category's
// map speaks for the "_" sentinel cell and nothing else, so a run of sizes
// there would describe cells the engine will never ask it about.
//
// SIZE KEYS ARE ENCODED (encodeSizeKey): RTDB forbids "." in a key, so 5.5 is
// stored as "5_5" — the same encoding as the /stock cell the row governs. A raw
// "5.5" key cannot be written at all, and a policy keyed the other way would
// miss the second-largest size band in the catalogue.
//
// "Same across all sizes" in the UI writes EACH SIZE INDIVIDUALLY into this
// map. It is a quick-fill, not a storage mode: a collapsed number would have to
// be re-expanded by every reader, and the first reader to expand it differently
// would be a silent divergence.

const { encodeSizeKey } = require("./refill-engine.cjs");
// validateLocationEntry lives in category-policy.cjs, not here: the CATEGORY
// validator needs it too, and category-policy.cjs cannot require this file
// without a cycle. Re-exported below so callers have one import either way.
const { validatePolicyEntry, validateLocationEntry, MAX_SIZES_PER_LOCATION, MAX_TARGET } =
  require("./category-policy.cjs");
// Resolution itself lives in the LEAF module the ENGINE consumes, so there is
// exactly ONE implementation of "which policy speaks here". A copy on this side
// would agree with the engine right up until the precedence changed, and this
// module's whole job is to be the same answer the scan will give.
const { locationEntryMode, armedGroupForCategory, effectivePolicyFor, locationPolicyFor } =
  require("./policy-resolve.cjs");

const GROUPS_PATH = "config/refillEngine/policyGroups";
const MAX_GROUP_MEMBERS = 60;

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const KEY_RE = /^[A-Za-z0-9_-]+$/;

// The sizes a per-size location entry speaks for, ENCODED, in map order.
function sizesOfLocationEntry(locEntry) {
  if (locationEntryMode(locEntry) !== "per-size") return [];
  return Object.keys(locEntry.sizes);
}

// ── VALIDATION — A WHOLE GROUP ───────────────────────────────────────────────
// `existingGroups` is the live policyGroups node minus the group being written,
// so overlapping membership is refused against what is actually there rather
// than against an assumption.
function validatePolicyGroup(groupKey, group, {
  knownCategoryKeys, knownLocations, existingGroups, categoryPolicy, allowedSizes,
} = {}) {
  if (typeof groupKey !== "string" || !groupKey) return "groupKey must be a non-empty string";
  if (!KEY_RE.test(groupKey)) {
    return `groupKey must be letters, digits, hyphens or underscores only (got ${JSON.stringify(groupKey)})`;
  }
  if (group === null) return null;                  // delete = the off switch
  if (!isPlainObject(group)) return "group must be an object, or null to delete it";

  const allowed = ["label", "memberCategoryKeys", "armed", "policy"];
  for (const k of Object.keys(group)) {
    if (!allowed.includes(k)) return `unknown field "${k}" (allowed: ${allowed.join(", ")})`;
  }
  if (typeof group.label !== "string" || !group.label.trim()) return "label is required";
  if (group.label.length > 120) return "label is too long";
  if (typeof group.armed !== "boolean") return "armed must be true or false";

  const members = group.memberCategoryKeys;
  if (!Array.isArray(members) || !members.length) return "memberCategoryKeys must name at least one category";
  if (members.length > MAX_GROUP_MEMBERS) return `a group cannot hold more than ${MAX_GROUP_MEMBERS} categories`;
  const seen = new Set();
  for (const m of members) {
    if (typeof m !== "string" || !KEY_RE.test(m)) return `member ${JSON.stringify(m)} is not a category key`;
    if (seen.has(m)) return `${m} is listed twice`;
    seen.add(m);
    if (Array.isArray(knownCategoryKeys) && knownCategoryKeys.length && !knownCategoryKeys.includes(m)) {
      return `unknown categoryKey "${m}" — it is not in /settings/productTaxonomy`;
    }
    for (const [otherKey, other] of Object.entries(existingGroups || {})) {
      if (otherKey === groupKey) continue;
      if (Array.isArray(other?.memberCategoryKeys) && other.memberCategoryKeys.includes(m)) {
        return `${m} is already in the "${otherKey}" group — a category belongs to at most one group`;
      }
    }
  }

  if (group.policy !== undefined && group.policy !== null) {
    const p = group.policy;
    if (!isPlainObject(p)) return "policy must be an object, or absent";
    if (p.perSize !== undefined && typeof p.perSize !== "boolean") return "policy.perSize must be true or false";
    const locs = Object.keys(p).filter((k) => k !== "perSize");
    if (!locs.length) return "policy must name at least one location, or be absent";
    for (const loc of locs) {
      if (Array.isArray(knownLocations) && knownLocations.length && !knownLocations.includes(loc)) {
        return `unknown location "${loc}"`;
      }
      // `allowedSizes` is the GROUP'S derived run — the union of its members'
      // — when the caller has read it. A size outside that union is a size no
      // member of this group carries, so a number against it would govern a
      // cell that cannot exist. Absent (a caller that has not derived the run)
      // still validates every other rule; the write path always derives it
      // before letting a size map through.
      const err = validateLocationEntry(p[loc], {
        where: loc, perSize: p.perSize === true,
        allowedSizes: Array.isArray(allowedSizes) ? allowedSizes : null });
      if (err) return err;
    }
  }

  // ── ARMING IS THE DANGEROUS HALF, SO IT IS CHECKED HARDEST ────────────────
  // A group with no policy resolves nothing; arming it would be a switch with
  // no wire behind it, and the owner would reasonably read the armed chip as
  // "these categories are now managed". Refuse rather than mislead.
  if (group.armed === true && (group.policy === undefined || group.policy === null)) {
    return "this group has no numbers yet — give it a policy before arming it";
  }
  // Members that already carry their own policy are inert under this group by
  // the precedence rule above. Legal, and worth saying out loud at the point of
  // arming rather than leaving as a surprise — but the caller reports it; a
  // refusal here would stop a correct change.
  void categoryPolicy;
  return null;
}

// ── SIZE RUN, FROM LIVE DATA ─────────────────────────────────────────────────
// The sizes a category's per-size editor offers. Derived, never hardcoded, from
// three live sources — and each one is reported so a run that looks wrong can
// be traced to where it came from:
//
//   declared   sizes on the products that carry this categoryKey
//   stocked    /stock cell keys those products actually hold
//   rowed      /stock_targets row keys those products already carry
//
// ── AND WHY THE UNION IS NOT THE ANSWER ON ITS OWN ───────────────────────────
// Measured live 2026-08-22, the raw union is polluted by legacy records: 1,246
// sneakers declare S/M/L/XL/XXL/XXXL/4XL between them (garment sizes on
// footwear), fitted caps carry a stray "28", and a one-size category like bags
// has a full letter run of husk cells. Handing that to a per-size editor would
// invite a policy on cells that are a data fault, at a category that has no
// such size.
//
// So the OFFERED run is the union INTERSECTED with the taxonomy's declared run
// whenever the registry declares one — the registry says what sizes the
// category has, the live data says which of them are real, and the editor wants
// both conditions. Where the registry declares nothing, the union stands alone.
//
// The rest is not thrown away. `extra` holds the sizes that exist in live data
// but not in the registry: they still refill off their own rows, so they are
// SHOWN — read-only, editable through the explicit-rows path — rather than
// hidden behind a run that pretends they are not there.
//
// Returns { sizes, extra, sources, empty }. `empty` is a STOP: a category whose
// run cannot be derived must not be given a per-size editor with a guessed list
// in it.
function sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey, locations }) {
  const pids = Object.keys(products || {}).filter((pid) => products[pid]?.categoryKey === categoryKey);
  const declared = new Set(), stocked = new Set(), rowed = new Set();
  for (const pid of pids) {
    for (const raw of (products[pid]?.sizes || [])) {
      const k = encodeSizeKey(raw);
      if (k !== "_") declared.add(k);
    }
  }
  const locs = Array.isArray(locations) && locations.length ? locations : Object.keys(stock || {});
  for (const loc of locs) {
    for (const pid of pids) {
      for (const k of Object.keys(stock?.[loc]?.[pid] || {})) if (k !== "_") stocked.add(k);
      for (const k of Object.keys(targets?.[loc]?.[pid] || {})) if (k !== "_") rowed.add(k);
    }
  }
  const union = [...new Set([...declared, ...stocked, ...rowed])].sort(bySizeRank);
  const registered = taxonomy?.cats?.[categoryKey];
  const taxSizes = (registered?.sizes || []).map((s) => encodeSizeKey(s)).filter((s) => s !== "_");
  // ── A ONE-SIZE CATEGORY HAS NO RUN, WHATEVER ITS CELLS SAY ────────────────
  // caps-beanies is one-size and carries 188 explicit rows on letter sizes,
  // every one left behind by the headwear collapse. The raw union therefore
  // produces a five-letter "size run" for a category whose map speaks for the
  // "_" cell alone — and a per-size editor built on it would let the owner write
  // a policy the engine can never consult. So a registry entry that declares
  // one-size (sizeMode "one", or a sizes list holding nothing but "_") has an
  // EMPTY offered run, and every real cell goes to `extra` where it belongs: a
  // legacy row, visible, edited through the explicit-rows path.
  const oneSize = !!registered && (registered.sizeMode === "one" || taxSizes.length === 0);
  const offered = oneSize ? [] : (taxSizes.length ? union.filter((s) => taxSizes.includes(s)) : union);
  const extra = oneSize ? union : (taxSizes.length ? union.filter((s) => !taxSizes.includes(s)) : []);
  return {
    sizes: offered,
    // The registry calls this category one-size. Reported rather than folded
    // into `empty`, because the two need different sentences: "this category has
    // no sizes" and "this category's sizes cannot be worked out" are different
    // problems with different fixes.
    oneSize,
    // Real cells outside the registry's run. Never editable as policy — the map
    // would be speaking for a size the category does not have — but visible,
    // because their rows produce real refills.
    extra,
    union,
    empty: offered.length === 0,
    products: pids.length,
    sources: {
      declared: [...declared].sort(bySizeRank),
      stocked: [...stocked].sort(bySizeRank),
      rowed: [...rowed].sort(bySizeRank),
      declaredByTaxonomy: taxSizes,
    },
    // A size the taxonomy promises that no product declares, stocks or has a
    // row for. Offering it would invite a policy on a cell that cannot exist.
    taxonomyOnly: taxSizes.filter((s) => !union.includes(s)),
    // The reverse, named for what it is at the call sites that report it.
    unregistered: extra,
  };
}

// ── SIZE RUN, FOR A WHOLE GROUP ──────────────────────────────────────────────
// The group is ONE policy over several categories, so its per-size editor needs
// ONE run. It is the UNION of its members' derived runs — never a hardcoded
// list, and never one member's run standing in for the rest.
//
// UNION, NOT INTERSECTION, and the difference is the whole reason `partial`
// exists. Intersecting would drop every size only some members carry: live,
// kids-shoes carries 1–6 and running-shoes 6–12, so the intersection is almost
// empty and a group policy built on it would arm nothing at either end of the
// run. The union covers both, and every size is marked with WHICH members
// actually carry it, so a number typed against a size only one category has is
// visibly that rather than silently that.
//
// A member with no derivable run of its own (a one-size category put in a sized
// group, or a category with no live data) contributes NOTHING and is named in
// `membersWithoutRun`. It is not an error — the other members still have a run
// — but it is not silence either: that member resolves the group's location
// entries through the "_" cell alone, and the owner should know which ones.
//
// Returns { sizes, byMember, carriedBy, partial, membersWithoutRun, empty }.
// `empty` is a STOP for the per-size editor, exactly as it is for a category.
// `precomputed` is a { categoryKey: run } map a caller has ALREADY derived from
// the same maps — the census derives one per category a moment before it builds
// the group entries, and deriving them twice walks /products and every /stock
// and /stock_targets map a second time. It is an optimisation only: a key that
// is absent is derived here, so the answer is the same either way.
function sizeRunForGroup({ products, stock, targets, taxonomy, memberCategoryKeys, locations, precomputed }) {
  const members = Array.isArray(memberCategoryKeys) ? [...memberCategoryKeys].sort() : [];
  const byMember = {};
  const carriedBy = {};
  const membersWithoutRun = [];
  for (const key of members) {
    const run = (precomputed && precomputed[key])
      || sizeRunForCategory({ products, stock, targets, taxonomy, categoryKey: key, locations });
    byMember[key] = { sizes: run.sizes, oneSize: run.oneSize, products: run.products, extra: run.extra };
    if (!run.sizes.length) membersWithoutRun.push(key);
    for (const s of run.sizes) (carriedBy[s] || (carriedBy[s] = [])).push(key);
  }
  const sizes = Object.keys(carriedBy).sort(bySizeRank);
  // A size some members do not carry. Marked, never dropped: see above.
  const partial = sizes.filter((s) => carriedBy[s].length < members.length);
  return {
    sizes, byMember, carriedBy, partial, membersWithoutRun,
    members, empty: sizes.length === 0,
  };
}

// Letters first in their conventional order, then numerics ascending, then
// anything else. Mirrors src/components/stock/hubSizeRank.js — pinned equal by
// test rather than by hope (functions/ is CommonJS, the browser bundle must not
// reach into it).
const LETTER_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const NUMERIC_SIZE = /^\d+(?:\.\d+)?$/;
function sizeRank(s) {
  const raw = String(s ?? "");
  const i = LETTER_ORDER.indexOf(raw.toUpperCase());
  if (i >= 0) return i;
  const token = raw.replace("_", ".");
  if (!NUMERIC_SIZE.test(token)) return 999;
  return 100 + Number.parseFloat(token);
}
const bySizeRank = (a, b) => sizeRank(a) - sizeRank(b) || String(a).localeCompare(String(b));

// ── "SAME ACROSS ALL SIZES" ──────────────────────────────────────────────────
// Expands one row into a full per-size map. Every size gets its OWN stored
// entry — the quick-fill is a typing aid, not a storage shape. Callers pass the
// derived run; this function has no opinion about what the sizes are.
function fillAllSizes(sizes, row) {
  const out = {};
  for (const s of sizes || []) {
    const e = { target: row.target, minQty: row.minQty };
    if (row.reorderPoint !== undefined && row.reorderPoint !== null) e.reorderPoint = row.reorderPoint;
    out[encodeSizeKey(s)] = e;
  }
  return out;
}

// ── MERGE CANDIDATES — A PROPOSAL LIST, AND ONLY THAT ────────────────────────
// Categories that look like they could share one policy. NOTHING here merges
// anything, changes a categoryKey, or writes: the output is a list for a person
// to read, ranked by how confident the signal is.
//
// Two signals, deliberately crude, because a confident-looking wrong merge is
// worse than an obvious tentative one:
//
//   TINY        fewer than `tinyProducts` products in the category. A category
//               with four products does not need its own row on a screen.
//   TWINNED     two categories under the same taxonomy top with the same size
//               run and movement within `movementRatio` of each other.
//
// `movement` is units sold per category over the caller's window; the caller
// supplies it, so the window is visible at the call site rather than baked in.
function mergeCandidates({ taxonomy, countsByCategory, movementByCategory, policy, groups }, {
  tinyProducts = 8, movementRatio = 1.5,
} = {}) {
  const cats = isPlainObject(taxonomy?.cats) ? taxonomy.cats : {};
  const grouped = new Set();
  for (const g of Object.values(groups || {})) {
    for (const m of (g?.memberCategoryKeys || [])) grouped.add(m);
  }
  const keys = Object.keys(cats).sort();
  const out = [];

  for (const k of keys) {
    const n = countsByCategory?.[k] ?? 0;
    if (n > 0 && n < tinyProducts && !grouped.has(k)) {
      out.push({
        kind: "tiny", categories: [k], products: n,
        movement: movementByCategory?.[k] ?? 0,
        armed: isPlainObject(policy?.[k]),
        why: `${n} product${n === 1 ? "" : "s"} — too few to be worth its own policy row`,
      });
    }
  }

  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = keys[i], b = keys[j];
      const ca = cats[a], cb = cats[b];
      if (ca.top !== cb.top) continue;
      if (ca.sizeMode !== cb.sizeMode) continue;
      const sa = (ca.sizes || []).map(String).join(","), sb = (cb.sizes || []).map(String).join(",");
      if (sa !== sb) continue;
      const ma = movementByCategory?.[a] ?? 0, mb = movementByCategory?.[b] ?? 0;
      if (ma === 0 && mb === 0) continue;               // two dead categories say nothing
      const hi = Math.max(ma, mb), lo = Math.min(ma, mb);
      if (lo === 0 || hi / lo > movementRatio) continue;
      if (grouped.has(a) || grouped.has(b)) continue;
      out.push({
        kind: "twinned", categories: [a, b],
        products: (countsByCategory?.[a] ?? 0) + (countsByCategory?.[b] ?? 0),
        movement: ma + mb,
        armed: isPlainObject(policy?.[a]) || isPlainObject(policy?.[b]),
        why: `same ${ca.top} size run (${sa || "one size"}) and near-identical movement (${ma} vs ${mb} units)`,
      });
    }
  }
  // Loudest first: most movement, then most products.
  return out.sort((x, y) => y.movement - x.movement || y.products - x.products);
}

module.exports = {
  GROUPS_PATH, MAX_GROUP_MEMBERS, MAX_SIZES_PER_LOCATION, MAX_TARGET,
  locationEntryMode, sizesOfLocationEntry, validateLocationEntry, validatePolicyGroup,
  armedGroupForCategory, effectivePolicyFor, locationPolicyFor,
  sizeRunForCategory, sizeRunForGroup, sizeRank, bySizeRank, fillAllSizes, mergeCandidates,
};

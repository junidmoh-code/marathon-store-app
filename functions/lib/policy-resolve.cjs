// ─── POLICY RESOLUTION PRIMITIVES ─────────────────────────────────────────────
//
// A LEAF MODULE. It requires nothing, and that is the whole reason it exists:
// the refill engine needs group and per-size resolution, and so does every
// module that reasons about the engine (category-policy.cjs, policy-groups.cjs,
// the callable, the census). Putting these functions in any of those would make
// the engine require a module that requires the engine.
//
// So this file holds the primitives, refill-engine.cjs consumes them, and
// policy-groups.cjs re-exports them. There is exactly ONE implementation of
// "which policy speaks for this category at this location", and it is here.
//
// ── THE ORDER ────────────────────────────────────────────────────────────────
//
//   explicit /stock_targets row        (resolveTarget, one branch above)
//     > that category's OWN policy     (config.categoryPolicy[key])
//       > its ARMED group's policy     (config.policyGroups[gk].policy)
//         > footwear rule > kill switch > subcategory > size run
//
// A CATEGORY WITH ITS OWN ENTRY NEVER CONSULTS A GROUP. Not per-location — at
// all. See the long note in policy-groups.cjs for why the per-location merge
// was rejected: it would silently arm a category at a shop its own policy had
// deliberately left out.
//
// A DISARMED GROUP IS NOT IN THE ORDER. armedGroupForCategory returns before it
// ever reads the policy, so a group seeded `armed: false` cannot produce an
// intent by any path. That is the property the footwear group is seeded on, and
// it is mutation-proved.
//
// Everything here is FAIL-SAFE in the engine's standing direction: a garbled,
// half-written or unreadable entry arms NOTHING.

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const positiveTarget = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

// ── THE SHAPE OF ONE LOCATION ENTRY ──────────────────────────────────────────
//   "uniform"   { target, minQty, reorderPoint?, carriedOnly? }
//   "per-size"  { sizes: { "<encodedSize>": { target, minQty, reorderPoint? } },
//                 carriedOnly? }
//   "invalid"   anything else, INCLUDING both at once
//
// carriedOnly (2026-08-25, Hub 1 sneaker policy): `carriedOnly: true` scopes
// the entry to products the location ALREADY HOLDS A STOCK CELL FOR
// (storeCarries — cell presence, not units). The default (absent/false) keeps
// the map's standing promise: the category itself is the arming act, carriage
// or not. The flag exists because a per-size sneaker policy at a hub without
// it would arm every product in the category (~1,245 at Hub 1) against a
// source that could never fill it. The gate itself lives in the engine's
// categoryPolicyEntry — the one choke point every consumer resolves through —
// because this leaf module never sees stock. Here it is only carried through.
// A PRESENT key gates unless it is literally `false`: a garbled value ("yes",
// 1) means somebody tried to scope the entry, and honouring the scope arms
// FEWER products — the engine's standing conservative side. Only absence or
// an explicit false means "unscoped". (The write path additionally refuses
// non-boolean values outright; this rule is for a hand-edited live node.)
function locationEntryMode(locEntry) {
  if (!isPlainObject(locEntry)) return "invalid";
  const hasSizes = isPlainObject(locEntry.sizes);
  const hasTarget = locEntry.target !== undefined;
  if (hasSizes && hasTarget) return "invalid";
  if (hasSizes) return "per-size";
  if (hasTarget) return "uniform";
  return "invalid";
}

// The carriage-scope flag of one location entry — see the shape note above.
// Present-and-not-false gates; absent or explicit false is unscoped.
function carriedOnlyOf(locEntry) {
  return isPlainObject(locEntry)
    && locEntry.carriedOnly !== undefined && locEntry.carriedOnly !== false;
}

// The armed group that speaks for a category, or null.
// Returns { groupKey, group, overlaps } — `overlaps` names the other armed
// groups that also claim it, a state the write path refuses but a live node
// edited by hand could still hold. The winner is the lexicographically first
// key, so the engine and every preview agree without coordinating.
function armedGroupForCategory(config, categoryKey) {
  if (typeof categoryKey !== "string" || !categoryKey) return null;
  // OWN POLICY WINS — and "own policy" means THE KEY IS PRESENT, not "the key
  // holds something this file can read".
  //
  // Testing isPlainObject here let a GARBLED own entry fall through to the
  // group: categoryPolicy: { sneakers: "garbage" } resolved the group's
  // numbers, identical to having no entry at all. That is the unsafe direction
  // twice over — garbage produced MORE intents than a correct entry would, and
  // it did so at a category somebody had deliberately given its own policy.
  //
  // A present-but-unreadable entry now arms NOTHING and consults no group,
  // which is this file's standing direction for every malformed input.
  // (Adversarial review, PR #401.)
  //
  // null and undefined are ABSENT, not present: RTDB deletes a key written
  // null, so a live node can never hold one, and treating it as present would
  // make deleting a category's policy fail to release it back to its group.
  const own = config?.categoryPolicy?.[categoryKey];
  if (own !== undefined && own !== null) return null;
  const groups = config?.policyGroups;
  if (!isPlainObject(groups)) return null;
  const claiming = Object.keys(groups).sort().filter((gk) => {
    const g = groups[gk];
    if (!isPlainObject(g)) return false;
    if (g.armed !== true) return false;                  // DISARMED = NOT IN THE ORDER
    if (!isPlainObject(g.policy)) return false;          // no numbers = nothing to resolve
    return Array.isArray(g.memberCategoryKeys) && g.memberCategoryKeys.includes(categoryKey);
  });
  if (!claiming.length) return null;
  return { groupKey: claiming[0], group: groups[claiming[0]], overlaps: claiming.slice(1) };
}

// The whole policy object a category resolves through, and where it came from.
// { entry, source: "category" | "group", groupKey } — or null.
function effectivePolicyFor(config, categoryKey) {
  const own = config?.categoryPolicy?.[categoryKey];
  if (isPlainObject(own)) return { entry: own, source: "category", groupKey: null };
  const g = armedGroupForCategory(config, categoryKey);
  if (!g) return null;
  return { entry: g.group.policy, source: "group", groupKey: g.groupKey };
}

// What governs ONE location, resolved and shape-normalised for the engine.
//
//   { perSize, mode, target, minQty, reorderPoint, sizes, source, groupKey }
//
// `sizes` is the raw per-size map when mode is "per-size", else null. target /
// minQty / reorderPoint are the location-wide numbers when mode is "uniform",
// else null. A location the policy does not name, or names with an unusable
// entry, resolves NULL — the conservative side, every time.
function locationPolicyFor(config, categoryKey, dest) {
  const eff = effectivePolicyFor(config, categoryKey);
  if (!eff) return null;
  const cat = eff.entry;
  if (!isPlainObject(cat)) return null;
  const loc = cat[dest];
  const mode = locationEntryMode(loc);
  if (mode === "invalid") return null;
  const perSize = cat.perSize === true;
  if (mode === "per-size") {
    // A per-size map outside per-size mode describes cells the engine will
    // never ask this entry about. Refuse it rather than half-honour it.
    if (!perSize) return null;
    // At least one usable row, or the entry arms nothing.
    const usable = Object.keys(loc.sizes).some((k) => positiveTarget(loc.sizes[k]?.target));
    if (!usable) return null;
    return { perSize: true, mode, target: null, minQty: null, reorderPoint: null,
      sizes: loc.sizes, carriedOnly: carriedOnlyOf(loc), source: eff.source, groupKey: eff.groupKey };
  }
  if (!positiveTarget(loc.target)) return null;
  return { perSize, mode, target: loc.target, minQty: loc.minQty, reorderPoint: loc.reorderPoint,
    sizes: null, carriedOnly: carriedOnlyOf(loc), source: eff.source, groupKey: eff.groupKey };
}

module.exports = { locationEntryMode, carriedOnlyOf, armedGroupForCategory, effectivePolicyFor, locationPolicyFor };

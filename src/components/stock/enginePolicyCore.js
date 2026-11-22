// ─── ENGINE POLICY CARD — THE LOGIC, WITHOUT THE PIXELS ───────────────────────
//
// Everything the card decides, as pure functions: what state a category row is
// in, which locations may be edited, what the changed-fields banner says, when
// a preview stops being valid, and how the next scan time is worked out.
//
// It is separate from the JSX so the rules can be tested as rules. Two of them
// are worth more than the rest:
//
//   • A LOCATION THAT DOES NOT CARRY THE CATEGORY IS NOT EDITABLE. Not warned
//     about — refused. Carriage is cell presence, and a category-mapped product
//     is managed at a mapped location UNCONDITIONALLY (refill-engine.cjs
//     managedPids: no carriage gate, by design). So arming an uncarried store
//     does not quietly do nothing; it manufactures demand for every product in
//     the category at a shop that has never stocked one. That is the shape of
//     the PE/Trophy clothing contamination, and of marathon-pine's three
//     zero-quantity headwear husks. Arming it has to be a separate, deliberate
//     act with its own button and its own confirmation.
//
//   • SAVE IS DISABLED UNTIL A PREVIEW HAS RUN AGAINST THE CURRENT VALUES.
//     A preview of numbers that are no longer on screen is worse than no
//     preview: it is a reassurance about something else. So the preview is
//     keyed on the exact field values it was computed from, and any edit
//     invalidates it.

// Field labels — the owner's words, fixed. "target/minQty/reorderPoint" is the
// engine's vocabulary and stays in the data; nobody has to learn it to use the
// screen.
export const COLUMN_LABELS = { target: "Keep", minQty: "Minimum", reorderPoint: "Ask at" };
export const FIELD_ORDER = ["target", "minQty", "reorderPoint"];

// Mirrors functions/lib/category-policy.cjs defaultMinQty. Duplicated rather
// than imported because that file is CommonJS inside functions/ and the browser
// bundle must not reach into it — pinned equal by test.
export const defaultMinQty = (target) =>
  (typeof target === "number" && Number.isFinite(target) && target > 0 ? Math.ceil(target / 2) : 0);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ═════════════════════════════════════════════════════════════════════════════
// PER-SIZE POLICY — THE SECOND SHAPE
// ═════════════════════════════════════════════════════════════════════════════
// A location entry is one of two things, never both:
//
//   UNIFORM   { target, minQty, reorderPoint? }        one number for the shop
//   PER-SIZE  { sizes: { "<storedSize>": { … } } }     one row per size
//
// In the DRAFT (what the inputs hold) that is expressed by the presence of a
// `sizes` object on the location's row. Every function below that predates this
// behaves exactly as it did when `sizes` is absent, which is what keeps the
// shipped one-size path — and its tests — untouched.
//
// SIZE KEYS ARE STORED KEYS. 5.5 is "5_5" everywhere: in /stock, in a
// /stock_targets row, and here. RTDB cannot hold a "." in a key at all, so
// there is no other option, and a policy keyed the other way would silently
// miss the second-largest size band in the catalogue.
export const encodeSizeKeyClient = (size) => {
  const s = String(size == null ? "" : size).trim();
  if (!s) return "_";
  return s.replace(/[.#$/\[\]\s]/g, "_");
};

export const isPerSizeRow = (row) => isObj(row) && isObj(row.sizes);

// Letters first, then numerics ascending, then anything else. Mirrors
// hubSizeRank.js and functions/lib/policy-groups.cjs — pinned equal by test.
const LETTER_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL"];
const NUMERIC_SIZE = /^\d+(?:\.\d+)?$/;
export function sizeRank(s) {
  const raw = String(s ?? "");
  const i = LETTER_ORDER.indexOf(raw.toUpperCase());
  if (i >= 0) return i;
  const token = raw.replace("_", ".");
  if (!NUMERIC_SIZE.test(token)) return 999;
  return 100 + Number.parseFloat(token);
}
export const bySizeRank = (a, b) => sizeRank(a) - sizeRank(b) || String(a).localeCompare(String(b));

// The display form of a stored key: "5_5" reads as 5.5 to a person, and the
// screen is for a person. Only the display changes — nothing writes this back.
export const sizeLabel = (k) => (/^\d+_\d+$/.test(String(k)) ? String(k).replace("_", ".") : String(k));

// ── PER-SIZE IS A PROPERTY OF THE CATEGORY, NOT OF WHAT WAS SAVED LAST TIME ──
//
// `perSize` is NOT a shape marker. For a UNIFORM leg it decides WHICH CELLS the
// one number governs (refill-engine.cjs categoryPolicyTarget):
//
//   perSize absent  → the leg speaks for the "_" one-size cell and NOTHING else
//   perSize true    → the leg speaks for every size the product declares
//
// The card used to send back whatever the STORED entry carried. For a category
// that had never been armed per-size that was `false`, so arming soccer jerseys
// wrote `{trophy:{target:3}}` — an entry that resolves NOTHING for S, M, L, XL
// or XXL. Not coarse: inert. Measured against the real engine and written up in
// docs/POLICY-PER-PRODUCT-TARGETS.md §5.
//
// So the flag is DERIVED from the category instead: a category with a size run
// is per-size, a one-size category is not. The run itself is derived from live
// data server-side (sizeRunForCategory), so this answer changes when the
// catalogue does and never because of what somebody saved in June.
export const perSizeMode = (category) => ((category?.sizeRun || []).length > 0);

// ── ROW STATE ────────────────────────────────────────────────────────────────
// One of three, and the third is the one people get wrong:
//
//   armed        the map governs this category and nothing outranks it
//   overridden   the map is armed but N products still carry explicit
//                /stock_targets rows, which BEAT the map — so editing the
//                numbers here does not reach those products at all
//   none         no policy; the engine falls through to its rules
//
// "overridden" exists because a map edit that appears to do nothing is the
// single most confusing thing this system does, and the reason is always the
// same: 79 fitted caps still carry introduce-existing letter rows.
export function categoryRowState({ entry, overriddenProducts = 0 }) {
  const locs = armedLocations(entry);
  if (!locs.length) return { state: "none", locations: [], overriddenProducts: 0 };
  if (overriddenProducts > 0) return { state: "overridden", locations: locs, overriddenProducts };
  return { state: "armed", locations: locs, overriddenProducts: 0 };
}

// The locations a map entry validly governs. Byte-for-byte the engine's own
// test (categoryPolicyEntry): a positive finite numeric target arms; anything
// else — a string "5", NaN, 0, a negative — arms NOTHING. Fail-safe on both
// sides, so the card never shows a location as armed that the engine ignores.
export function armedLocations(entry) {
  if (!isObj(entry)) return [];
  const perSize = entry.perSize === true;
  return Object.entries(entry)
    .filter(([loc, e]) => loc !== "perSize" && isObj(e) && locationArms(e, perSize))
    .map(([loc]) => loc)
    .sort();
}

// Does ONE location entry arm, by the engine's own test? Mirrors
// policy-resolve.cjs locationEntryMode + locationPolicyFor, and the mirroring is
// pinned by a differential test over a shape table rather than by this comment.
//
// Three shapes used to disagree, all in the unsafe direction — the card showed
// a location as armed where the engine is silent, which is the exact thing this
// function exists to prevent:
//
//   { hub2: { sizes: {…} } }               a size map with NO perSize:true
//   { hub2: { target: 5, sizes: {…} } }    both shapes at one location
//
// The first describes cells the engine will never ask this entry about; the
// second is ambiguous and the engine refuses it outright. (Adversarial review,
// PR #401.)
function locationArms(e, perSize) {
  const hasSizes = isObj(e.sizes);
  const hasTarget = e.target !== undefined;
  if (hasSizes && hasTarget) return false;            // never both
  if (hasSizes) {
    // A PER-SIZE MAP ARMS THE LOCATION, and it has no `target` of its own —
    // but only under perSize:true. Testing for a positive target alone reported
    // a fully-armed per-size leg as unarmed, so the editor rendered no row for
    // it, the draft omitted it, and the save (which .set()s the whole entry)
    // would have DELETED it. Same data-loss shape as the armed-non-destination
    // bug, same invisibility to the drift check.
    if (!perSize) return false;
    return Object.values(e.sizes).some((r) => isObj(r)
      && typeof r.target === "number" && Number.isFinite(r.target) && r.target > 0);
  }
  return typeof e.target === "number" && Number.isFinite(e.target) && e.target > 0;
}

// ── EDITOR ROWS ──────────────────────────────────────────────────────────────
// One row per location the estate has, not per location already armed: the
// screen has to be able to say "Not carried" about the others, and to offer
// arming a carried-but-unarmed one. Destination locations only — central is a
// source, in_transit and studio are not shops, and offering them would invite
// a policy the engine has no destination for.
//
// `follows` (optional) is the census's { location: the location whose numbers
// it reads } — a LIVE location with no entry of its own that the engine arms
// through the policy template. It is carried on the row as a FACT to show
// ("follows Hub 2") and nothing else: the row stays `armed: false`, so it is
// not in the draft and a save never writes numbers for it — which is what
// keeps it following. Giving it numbers of its own is the ordinary "arm this
// location" edit, and from then on it no longer follows.
export function editorRows({ entry, carriage, destinations, follows }) {
  const armed = new Set(armedLocations(entry));
  // ARMED LOCATIONS ARE ALWAYS ROWS, even ones absent from config.mode.
  // Without this, a location armed in the map but not a configured destination
  // got no row, was therefore absent from the draft, and the save — which
  // .set()s the whole entry — DELETED ITS ARMING. Worse, if the only armed
  // location were a non-destination the draft would be empty, policyFromDraft
  // would return null, and the card would silently un-arm the whole category.
  // The drift check cannot catch either: live still matched what was rendered.
  const locs = [...new Set([...(destinations || []), ...armed])];
  return locs.map((loc) => {
    const c = carriage?.[loc] || {};
    const e = isObj(entry?.[loc]) ? entry[loc] : null;
    return {
      loc,
      carries: c.carries === true,
      productsCarried: c.products || 0,
      unitsHeld: c.units || 0,
      armed: armed.has(loc),
      follows: !armed.has(loc) && isObj(follows) && typeof follows[loc] === "string" ? follows[loc] : null,
      // "uniform" | "per-size" | null — which of the two shapes this leg holds
      // today. The editor renders one row or a run of size rows accordingly.
      shape: e ? (isObj(e.sizes) ? "per-size" : "uniform") : null,
      sizes: isObj(e?.sizes) ? e.sizes : null,
      // A location that does not carry the category is NOT editable, whatever
      // the map currently says. An already-armed uncarried location stays
      // visible and editable so it can be corrected — refusing to let the owner
      // fix a mistake is not a safety feature.
      editable: c.carries === true || armed.has(loc),
      // Carriage scope (2026-08-25): true = this leg speaks only for products
      // the location already holds a stock cell for. Rendered as a chip and a
      // toggle; the ENGINE is what enforces it (categoryPolicyEntry).
      carriedOnly: e?.carriedOnly === true,
      target: e?.target ?? null,
      minQty: e?.minQty ?? null,
      reorderPoint: e?.reorderPoint ?? null,
    };
  });
}

// ── DRAFT ────────────────────────────────────────────────────────────────────
// The editor's working copy. Fields are held as STRINGS because that is what an
// input holds, and because "" has to survive as a distinct value: a blank
// "Ask at" means absent (top up eagerly), which is a different policy from 0
// (ask only when the shelf is empty). Coercing "" to 0 anywhere in this path
// would silently change the behaviour of every location it touched.
export function draftFromEntry({ entry, carriage, destinations }) {
  const rows = editorRows({ entry, carriage, destinations });
  const out = {};
  for (const r of rows) {
    if (!r.armed) continue;
    if (r.sizes) {
      // A per-size leg becomes a map of string rows, one per size the entry
      // names, in size order. `sizes` present IS the shape marker; there is no
      // separate mode flag to get out of step with it.
      const sizes = {};
      for (const k of Object.keys(r.sizes).sort(bySizeRank)) sizes[k] = strRow(r.sizes[k]);
      out[r.loc] = r.carriedOnly ? { sizes, carriedOnly: true } : { sizes };
      continue;
    }
    out[r.loc] = r.carriedOnly ? { ...strRow(r), carriedOnly: true } : strRow(r);
  }
  return out;
}

// Numbers (or absent) in, the strings an input holds out. "" survives as a
// distinct value: a blank "Ask at" means ABSENT (top up eagerly), which is a
// different policy from 0 (ask only when the shelf is empty).
function strRow(e) {
  return {
    target: e?.target == null ? "" : String(e.target),
    minQty: e?.minQty == null ? "" : String(e.minQty),
    reorderPoint: e?.reorderPoint == null ? "" : String(e.reorderPoint),
  };
}

// Seed a location that is being armed for the first time. Minimum is filled in
// from ceil(keep / 2) rather than left blank — the column stays visible, but it
// is never typed from scratch.
// A CATEGORY LEAVING ITS GROUP FOR ITS OWN NUMBERS starts from the group's —
// but only for ITS OWN SIZES. Kids Shoes opens on the Footwear policy: Hub 3's
// one number for every size is kept exactly as it is, and each size-by-size
// location (Hub 1, Hub 2) is laid out on the kids run (24–35), carrying the
// group's number for any size both name and BLANK for the rest — never the
// adult sizes a kids shoe does not come in, and never a number nobody chose.
export function draftForOwnRun(draft, sizeRun) {
  const run = [...new Set(sizeRun || [])].sort(bySizeRank);
  if (!run.length) return draft || {};
  const out = {};
  for (const [loc, row] of Object.entries(draft || {})) {
    if (!isPerSizeRow(row)) { out[loc] = row; continue; }
    const sizes = {};
    for (const k of run) sizes[k] = row.sizes[k] || { target: "", minQty: "", reorderPoint: "" };
    out[loc] = row.carriedOnly === true ? { sizes, carriedOnly: true } : { sizes };
  }
  return out;
}

export function seedLocation(target) {
  const t = Number(target);
  return {
    target: Number.isFinite(t) && t > 0 ? String(t) : "",
    minQty: Number.isFinite(t) && t > 0 ? String(defaultMinQty(t)) : "",
    reorderPoint: "",
  };
}

// Editing "Keep" re-seeds "Minimum" ONLY while Minimum still holds the value
// the default would have produced. Once the owner has typed their own number,
// it is theirs and nothing overwrites it.
export function onTargetChanged(row, nextTarget) {
  const prev = Number(row?.target);
  const next = Number(nextTarget);
  const wasDefault = row?.minQty === "" ||
    (Number.isFinite(prev) && prev > 0 && String(defaultMinQty(prev)) === String(row?.minQty));
  return {
    ...row,
    target: nextTarget,
    minQty: wasDefault && Number.isFinite(next) && next > 0 ? String(defaultMinQty(next)) : row?.minQty ?? "",
  };
}

// ── DRAFT → POLICY ───────────────────────────────────────────────────────────
// The object sent to the callable. A blank or absent "Ask at" is OMITTED, never
// zeroed. A row with no target at all is dropped (that is how a location is
// un-armed from the editor). An empty result is `null` — the documented off
// switch for the whole category.
export function policyFromDraft(draft, { perSize = false } = {}) {
  const out = {};
  for (const [loc, row] of Object.entries(draft || {})) {
    // ── PER-SIZE ────────────────────────────────────────────────────────────
    // Every size is written INDIVIDUALLY. "Same across all sizes" is a
    // quick-fill in the editor, not a storage shape: a collapsed number would
    // have to be re-expanded by every reader, and the first reader to expand it
    // differently would be a silent divergence.
    if (isPerSizeRow(row)) {
      const sizes = {};
      for (const [sizeKey, sr] of Object.entries(row.sizes)) {
        const e = entryFromStrings(sr);
        if (e) sizes[sizeKey] = e;
      }
      // A location whose every size was cleared is DROPPED — the same way a
      // uniform row with no target is. That is how a leg is un-armed.
      if (Object.keys(sizes).length) out[loc] = row.carriedOnly === true ? { sizes, carriedOnly: true } : { sizes };
      continue;
    }
    const entry = entryFromStrings(row);
    if (entry) out[loc] = row.carriedOnly === true ? { ...entry, carriedOnly: true } : entry;
  }
  if (!Object.keys(out).length) return null;
  if (perSize) out.perSize = true;
  return out;
}

// One { target, minQty, reorderPoint? } from three strings, or null when there
// is no target at all. A blank or absent "Ask at" is OMITTED, never zeroed.
function entryFromStrings(row) {
  const target = numOrNull(row?.target);
  if (target === null) return null;
  const entry = { target };
  const min = numOrNull(row?.minQty);
  entry.minQty = min === null ? defaultMinQty(target) : min;
  const rp = numOrNull(row?.reorderPoint);
  if (rp !== null) entry.reorderPoint = rp;
  return entry;
}

// Strings in, numbers or null out. A blank is null (absent). Anything that is
// not a clean whole number is null too — so it is dropped rather than sent as
// NaN, and the local validator below names it.
function numOrNull(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── LOCAL VALIDATION ─────────────────────────────────────────────────────────
// Mirrors the server's rules so the owner is told at the keyboard rather than
// after a round trip. The SERVER is still the authority — this never decides
// whether a write happens, only whether the Save button is worth pressing.
export function validateDraft(draft) {
  const errors = {};
  for (const [loc, row] of Object.entries(draft || {})) {
    if (isPerSizeRow(row)) {
      // Each size is held to the SAME rules a whole-location row is, and the
      // error is keyed per size so the message lands on the input that caused
      // it rather than at the top of a run of twelve.
      let filled = 0;
      for (const [sizeKey, sr] of Object.entries(row.sizes)) {
        if (String(sr?.target ?? "").trim() === "") continue;   // blank size = not stocked here
        filled += 1;
        const err = validateOneRow(sr);
        if (err) errors[`${loc}::${sizeKey}`] = err;
      }
      if (!filled) errors[loc] = "Give at least one size a number, or remove the location";
      continue;
    }
    const raw = String(row?.target ?? "").trim();
    if (raw === "") { errors[loc] = "Keep is required — clear the whole row to stop stocking this category here"; continue; }
    if (!/^\d+$/.test(raw) || Number(raw) < 1) { errors[loc] = "Keep must be a whole number of 1 or more"; continue; }
    const target = Number(raw);
    if (target > 500) { errors[loc] = "Keep cannot be more than 500"; continue; }
    const minRaw = String(row?.minQty ?? "").trim();
    if (minRaw !== "" && (!/^\d+$/.test(minRaw) || Number(minRaw) > target)) {
      errors[loc] = `Minimum must be a whole number no higher than Keep (${target})`; continue;
    }
    const rpRaw = String(row?.reorderPoint ?? "").trim();
    if (rpRaw === "") continue;                       // blank = absent, legal
    if (!/^\d+$/.test(rpRaw)) { errors[loc] = "Ask at must be a whole number, or blank"; continue; }
    if (Number(rpRaw) >= target) {
      errors[loc] = `Ask at must be below Keep (${target}) — at or above it the setting does nothing`;
    }
  }
  return errors;
}

// The rules for ONE row, shared by the whole-location path above and by every
// size inside a per-size leg. Returns a message or null.
function validateOneRow(row) {
  const raw = String(row?.target ?? "").trim();
  if (raw === "") return "Keep is required — clear it to stop stocking this size here";
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return "Keep must be a whole number of 1 or more";
  const target = Number(raw);
  if (target > 500) return "Keep cannot be more than 500";
  const minRaw = String(row?.minQty ?? "").trim();
  if (minRaw !== "" && (!/^\d+$/.test(minRaw) || Number(minRaw) > target)) {
    return `Minimum must be a whole number no higher than Keep (${target})`;
  }
  const rpRaw = String(row?.reorderPoint ?? "").trim();
  if (rpRaw === "") return null;
  if (!/^\d+$/.test(rpRaw)) return "Ask at must be a whole number, or blank";
  if (Number(rpRaw) >= target) return `Ask at must be below Keep (${target}) — at or above it the setting does nothing`;
  return null;
}

// ── THE PREVIEW KEY ──────────────────────────────────────────────────────────
// The identity of the numbers a preview was computed from. Save is enabled only
// while the preview in hand carries the key of what is currently on screen —
// so any edit, anywhere, invalidates it without anyone having to remember to
// clear it. Category and perSize are in the key too: switching category with a
// stale preview object would otherwise look valid.
export function previewKey(categoryKey, draft, { perSize = false } = {}) {
  const locs = Object.keys(draft || {}).sort();
  const body = locs.map((loc) => {
    const r = draft[loc] || {};
    // A per-size leg's key covers EVERY size. Keying it on the location alone
    // would let a preview survive an edit to any size in the run — a
    // reassurance about numbers that are no longer on screen, which is the one
    // thing this key exists to prevent.
    if (isPerSizeRow(r)) {
      const inner = Object.keys(r.sizes).sort().map((k) =>
        `${k}=${FIELD_ORDER.map((f) => String(r.sizes[k]?.[f] ?? "").trim()).join("/")}`).join(",");
      return `${loc}:{${inner}}`;
    }
    return `${loc}:${FIELD_ORDER.map((f) => String(r[f] ?? "").trim()).join("/")}`;
  }).join("|");
  return `${categoryKey}::${perSize ? "size" : "one"}::${body}`;
}

// ── "SAME ACROSS ALL SIZES" ──────────────────────────────────────────────────
// The quick-fill. Writes the three values into EVERY size in the run as its own
// row — the editor then shows twelve identical rows, each of which can be
// changed on its own, and the save writes twelve entries. Nothing anywhere
// stores "they are all 4".
export function fillAllSizes(sizeRun, row) {
  const sizes = {};
  for (const k of (sizeRun || [])) {
    sizes[k] = {
      target: String(row?.target ?? ""),
      minQty: String(row?.minQty ?? ""),
      reorderPoint: String(row?.reorderPoint ?? ""),
    };
  }
  return { sizes };
}

// The apply-to-all input: one number into every size field at once, so a flat
// target is one entry rather than six. Minimum follows the same default a typed
// Keep gets; "Ask at" is left alone, because it is a separate decision and the
// owner may have already made it.
export function setEverySize(row, value, sizeRun) {
  const keys = [...new Set([...(sizeRun || []), ...Object.keys(row?.sizes || {})])].sort(bySizeRank);
  const sizes = {};
  const t = String(value ?? "").trim();
  for (const k of keys) {
    const prev = row?.sizes?.[k] || { target: "", minQty: "", reorderPoint: "" };
    sizes[k] = { ...prev, target: t, minQty: /^\d+$/.test(t) && Number(t) > 0 ? String(defaultMinQty(Number(t))) : "" };
  }
  return { ...(row || {}), sizes };
}

// Seed a per-size leg from the category's derived run, every size blank. The
// owner then types once and quick-fills, or fills the sizes they care about.
export function seedPerSizeLocation(sizeRun) {
  return fillAllSizes(sizeRun, { target: "", minQty: "", reorderPoint: "" });
}

// ── ARMING A LOCATION SEATS NOTHING (2026-09-09) ──────────────────────────────
// The draft row for a location being armed FOR THE FIRST TIME. It is always
// `carriedOnly` — this leg reaches only products the location already holds a
// stock cell for (a zero cell counts; a sold-out product stays armed).
//
// A POLICY SAYS HOW MANY TO KEEP, NEVER WHERE TO KEEP. On 2026-09-08 Slides was
// armed at hub1 and hub2 with neither leg mentioning carriage, and the map's
// standing promise did the rest: all 64 slides became demand at both hubs when
// 3 are actually kept at both — 181 open lines, 125 of them at a hub with no
// cell for the product.
//
// The SERVER is the gate (applyCategoryPolicy's gateNewLegsToSeated refuses to
// write a new leg any other way, so a script cannot arm wide either). This
// function exists so the chip on screen tells the truth from the first render
// rather than after the save, and so the rule is testable without a browser.
//
// It shapes a NEW leg only. An existing leg is loaded by draftFromEntry, which
// carries whatever the live entry holds — narrowing a live policy nobody asked
// to narrow is the same class of mistake in the other direction.
export function seedArmedLocation({ sizeRun = [], target = null } = {}) {
  const run = Array.isArray(sizeRun) ? sizeRun : [];
  return { ...(run.length ? seedPerSizeLocation(run) : seedLocation(target)), carriedOnly: true };
}

export function canSave({ preview, previewKeyNow, errors, busy }) {
  if (busy) return false;
  if (errors && Object.keys(errors).length) return false;
  if (!preview || preview.key !== previewKeyNow) return false;
  return true;
}

// ── CHANGED FIELDS ───────────────────────────────────────────────────────────
// "old -> new" for every edit, in the owner's words. Absent renders as "not
// set", never as 0 — the two are different policies and the banner is the last
// place the difference is visible before it is saved.
export function changedFields(before, after, { perSize = null } = {}) {
  const out = [];
  // ── THE FLAG THAT CHANGES WHAT EVERY NUMBER MEANS ──────────────────────────
  // A leg's numbers can be byte-identical and govern a completely different set
  // of cells, because perSize decides whether they speak for the "_" cell or
  // for the product's declared sizes. A banner that showed "no changes" while
  // silently flipping it would be the worst line on this screen.
  // …BUT NOT ON A REMOVAL. `after === null` un-arms the category outright, and
  // a line saying its numbers "now apply to every size" is about numbers that
  // apply nowhere at all — the banner's last word before the write, and the one
  // place it must not describe a policy that is being deleted. (CodeRabbit, #497.)
  if (isObj(before) && isObj(after) && perSize !== null && (before.perSize === true) !== (perSize === true)) {
    out.push({ loc: null, field: "perSize", from: before.perSize === true, to: perSize === true,
      label: "Sizes", text: perSize
        ? "these numbers now apply to every size the product comes in, not to the one-size cell"
        : "these numbers now apply to the one-size cell only" });
  }
  const b = isObj(before) ? before : {};
  const a = after === null ? {} : (isObj(after) ? after : {});
  const locs = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "perSize").sort();
  for (const loc of locs) {
    const bl = isObj(b[loc]) ? b[loc] : null;
    const al = isObj(a[loc]) ? a[loc] : null;
    if (bl && !al) { out.push({ loc, label: "Stopped stocking here", from: "armed", to: "removed" }); continue; }
    if (!bl && al) out.push({ loc, label: "Started stocking here", from: "not armed", to: "armed" });
    // ── A LEG THAT CHANGED SHAPE ────────────────────────────────────────────
    // One number for the whole shop, or a number per size. Reporting only the
    // fields would have shown "Keep 5 -> not set" for a leg that is now fully
    // armed size by size, which reads as an un-arming and is the opposite of
    // what happened.
    if (bl && al && isPerSizeRow(bl) !== isPerSizeRow(al)) {
      out.push({ loc, label: "Changed", from: isPerSizeRow(bl) ? "size by size" : "one number",
        to: isPerSizeRow(al) ? "size by size" : "one number",
        text: `now set ${isPerSizeRow(al) ? "size by size" : "as one number for the whole shop"}` });
    }
    if (isPerSizeRow(bl) || isPerSizeRow(al)) {
      const bs = isPerSizeRow(bl) ? bl.sizes : {};
      const as = isPerSizeRow(al) ? al.sizes : {};
      for (const sz of [...new Set([...Object.keys(bs), ...Object.keys(as)])].sort(bySizeRank)) {
        for (const f of FIELD_ORDER) {
          const from = isObj(bs[sz]) && typeof bs[sz][f] === "number" ? bs[sz][f] : null;
          const to = isObj(as[sz]) && typeof as[sz][f] === "number" ? as[sz][f] : null;
          if (from === to) continue;
          out.push({ loc, size: sz, field: f, label: COLUMN_LABELS[f], from, to,
            text: `${sizeLabel(sz)} — ${COLUMN_LABELS[f]} ${from === null ? "not set" : from} -> ${to === null ? "not set" : to}` });
        }
      }
      // ON PER-SIZE → UNIFORM, KEEP GOING. `continue`ing here listed every old
      // size going to "not set" and then said "now set as one number for the
      // whole shop" — without ever showing WHAT that one number is. The banner
      // is the last thing the owner reads before saving, so the number that now
      // governs the entire location has to be in it. (CodeRabbit, PR #401.)
      if (isPerSizeRow(al)) continue;
    }
    // `leftPerSize` prefixes the uniform lines when the leg just came OUT of
    // per-size, so the banner does not read as a contradiction: the per-size
    // block above has already said every old size went to "not set", and a bare
    // "Keep not set -> 7" next to it looks like a second, unrelated change
    // rather than the number that replaced them. (Delta review, PR #401.)
    const leftPerSize = isPerSizeRow(bl) && !isPerSizeRow(al);
    for (const f of FIELD_ORDER) {
      const from = leftPerSize ? null : (bl && typeof bl[f] === "number" ? bl[f] : null);
      const to = al && typeof al[f] === "number" ? al[f] : null;
      if (from === to) continue;
      out.push({ loc, field: f, label: COLUMN_LABELS[f], from, to, leftPerSize,
        text: leftPerSize
          ? `the whole shop — ${COLUMN_LABELS[f]} ${to === null ? "not set" : to}`
          : `${COLUMN_LABELS[f]} ${from === null ? "not set" : from} -> ${to === null ? "not set" : to}` });
    }
  }
  return out;
}

// ── NEXT SCAN ────────────────────────────────────────────────────────────────
// The scan runs "every 60 minutes from 07:00 to 19:00" in Africa/Johannesburg
// (refill-scan.cjs) — on the hour, 07:00 through 19:00 inclusive, thirteen runs.
// Africa/Johannesburg is UTC+2 year-round with no daylight saving, so the offset
// is a constant and not a lie waiting for October.
//
// This predictor is rendered as "Next scan" in the Engine Policy tile, in the
// save toast ("the next scan (11:00) uses these numbers") and in Seating
// actions. It is the one place in the app that RESTATES the function's
// schedule, so it has to move whenever the schedule does.
//
// Nothing enforces that automatically, and it is worth saying so plainly: this
// module cannot read refill-scan.cjs, so its test pins the thirteen labels
// independently. The functions-side test parses the real schedule string; this
// one asserts the answer it should produce. Two halves of the same contract,
// held together by a reader rather than by code.
//
// Returns { at: epochMs, label } — or { at: null } when the day's last scan has
// run, because "in 13 hours" is a worse answer than "tomorrow from 07:00".
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
export function nextScanAt(nowMs) {
  if (!Number.isFinite(nowMs)) return { at: null, label: "unknown" };
  const sa = new Date(nowMs + SA_OFFSET_MS);
  const h = sa.getUTCHours(), m = sa.getUTCMinutes();
  const dayStart = nowMs - ((h * 60 + m) * 60000 + sa.getUTCSeconds() * 1000 + sa.getUTCMilliseconds());
  if (h < 7) return { at: dayStart + 7 * 3600000, label: "07:00" };
  // 19:00 is the LAST run, not the end of a window that still has runs in it:
  // once the clock has reached 19:00 the day's scanning is done.
  if (h >= 19) return { at: null, label: "tomorrow from 07:00" };
  const at = dayStart + (h + 1) * 3600000;
  const d = new Date(at + SA_OFFSET_MS);
  return { at, label: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
}

// ── THE VERDICT ──────────────────────────────────────────────────────────────
// One plain-English sentence about what the next scan does, from the model the
// server returned. It leads with the number that constrains the outcome, and it
// never claims certainty the model does not have: the model is a ceiling, so
// the wording is "at most".
export function previewVerdict(model, { cap, centralOnHand } = {}) {
  if (!model) return "Run a preview to see what the next scan would do.";
  const req = model.totalRequests || 0;
  const units = model.totalUnits || 0;
  const parked = (model.legs || []).reduce((n, l) => n + (l.parked || 0), 0);
  const theCap = cap ?? model.cap ?? null;
  const central = centralOnHand ?? model.centralOnHand ?? 0;
  if (req === 0) {
    return parked > 0
      ? `The next scan asks for nothing. ${parked} ${parked === 1 ? "shelf is" : "shelves are"} below target, but there is no stock upstream to fill them — those wait for a delivery, not for this setting.`
      : "The next scan asks for nothing — every shelf in this category is already at or above target.";
  }
  const parts = [`The next scan asks for at most ${req} ${req === 1 ? "refill" : "refills"} (${units} ${units === 1 ? "unit" : "units"}).`];
  if (theCap != null) {
    parts.push(req > theCap
      ? `That is more than the ${theCap}-per-scan limit, so it lands over several scans through the day.`
      : `That fits inside the ${theCap}-per-scan limit, which is shared with every other category.`);
  }
  parts.push(units > central
    ? `Central holds ${central}, so ${units - central} ${units - central === 1 ? "unit" : "units"} cannot be sent yet and waits on a purchase order.`
    : `Central holds ${central}, which covers it.`);
  if (parked > 0) parts.push(`A further ${parked} ${parked === 1 ? "shelf is" : "shelves are"} below target with nothing upstream to fill them.`);
  if (model.overriddenProducts > 0) {
    parts.push(`${model.overriddenProducts} ${model.overriddenProducts === 1 ? "product is" : "products are"} still on their own rows and ignore these numbers entirely.`);
  }
  // A destination that is not live has its requests COMPUTED but never written
  // (refill-scan only persists for mode "live"). Reporting the total without
  // this overstates what actually happens, which is the one thing this sentence
  // exists not to do.
  const nonLive = Array.isArray(model.nonLiveLegs) ? model.nonLiveLegs : [];
  if (nonLive.length) {
    const n = nonLive.reduce((t, l) => t + (l.requests || 0), 0);
    parts.push(`${n} of those ${n === 1 ? "is" : "are"} for ${nonLive.map((l) => `${l.loc} (${l.mode})`).join(", ")}, which the scan works out but does not send — so ${model.totalRequests - n} actually go out.`);
  }
  return parts.join(" ");
}

// ── THE VERDICT'S FIRST SENTENCE ─────────────────────────────────────────────
// The panel shows only the leading sentence — the number that constrains the
// outcome. It used to be cut by splitting on a LOOKBEHIND assertion, and that
// is not a detail here: Safari only gained lookbehind assertions in 16.4 (March 2023),
// and an unsupported group is a SyntaxError at PARSE time, not at call time. It
// does not degrade this one line — the whole bundle fails to load, so the shop
// screen is blank on any tablet still on iOS 16.3 or older. No device inventory
// exists to say whether one is (nothing stores a userAgent), so this assumes
// the worst.
//
// Index-based rather than a cleverer regex, and identical in result: everything
// up to and including the first "." that is followed by whitespace, or the whole
// string when there is no such break.
export function firstSentence(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "." && /\s/.test(s[i + 1] || "")) return s.slice(0, i + 1);
  }
  return s;
}

// ── LAST CHANGE ──────────────────────────────────────────────────────────────
// The header stamp, from the audit trail. Only APPLIED entries count: an
// aborted save changed nothing and must not be presented as the current state's
// provenance.
export function lastChange(historyEntries) {
  const applied = (historyEntries || []).filter((h) => h && h.status === "applied" && Number.isFinite(h.at));
  if (!applied.length) return null;
  return applied.reduce((best, h) => (h.at > best.at ? h : best));
}

// ═════════════════════════════════════════════════════════════════════════════
// THE MAIN LIST — EVERY CATEGORY HAS A ROW; A GROUP'S MEMBERS SIT UNDER IT
// ═════════════════════════════════════════════════════════════════════════════
// The census returns categories AND groupEntries (one per group, carrying the
// same fields a category carries, counts summed).
//
// EVERY CATEGORY IS ON THE LIST (Junid, 22 Nov 2026). The list used to HIDE a
// group's members — eight footwear categories folded into one "Footwear" row,
// reachable only from inside it. Junid went to arm Kids Shoes and could not
// find it: there was no row with that name, and nothing said its sizes
// (26–33) had no numbers under a Footwear policy that only speaks for 3–13.
// A member now has its own row, directly under its group's, saying whose
// numbers it uses and — policyGaps below — which of its sizes have none.
//
// Order: governed first (they are what somebody came to change), then anything
// with products or rows, then the empty rest — alphabetical inside each. A
// group is "governed" only when it is ARMED and names a location: a disarmed
// group with numbers in it governs nothing, and the list must not rank it as
// if it did. Members follow their group wherever it lands, alphabetical.
export function mainListEntries(census) {
  const cats = Array.isArray(census?.categories) ? census.categories : [];
  const groups = Array.isArray(census?.groupEntries) ? census.groupEntries : [];
  const top = [...cats.filter((c) => !c.memberOfGroup), ...groups];
  const governed = (c) => (c.isGroup ? (c.armed === true && (c.armedEffective || []).length > 0) : (c.armedEffective || []).length > 0);
  const band = (c) => (governed(c) ? 0 : (c.products > 0 || c.ownRowCells > 0) ? 1 : 2);
  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));
  top.sort((a, b) => band(a) - band(b) || byLabel(a, b));
  const out = [];
  const placed = new Set();
  for (const c of top) {
    out.push(c);
    if (!c.isGroup) continue;
    const gk = c.groupKey || String(c.key).replace(/^group:/, "");
    for (const m of cats.filter((x) => x.memberOfGroup === gk).sort(byLabel)) {
      out.push({ ...m, underGroup: c.key });
      placed.add(m.key);
    }
  }
  // A member whose group entry the census did not send (the shape before
  // groups were entries) is still a category, and still gets a row.
  for (const m of cats.filter((x) => x.memberOfGroup && !placed.has(x.key)).sort(byLabel)) out.push(m);
  return out;
}

// ── WHICH OF A CATEGORY'S SIZES HAVE NO NUMBER ───────────────────────────────
// "Armed at 3" is true of Kids Shoes and useless: the Footwear policy is armed
// at Hub 1 and Hub 2 SIZE BY SIZE, for 3–13, and a kids shoe is a 26–33. The
// engine keeps nothing of a size the per-size map does not name, so the
// category is unarmed there in every way that matters. This says so, from the
// census alone — the category's own derived run against the numbers in force.
//
//   { [location]: { missing: [sizeKey…], all: true|false } }
//
// Only per-size locations can have a gap: a location armed with ONE number
// speaks for every size. A one-size category has no run and so no gap.
export function policyGaps(category) {
  const run = Array.isArray(category?.sizeRun) ? category.sizeRun : [];
  const entry = category?.effectiveEntry;
  const out = {};
  if (!run.length || !entry || typeof entry !== "object") return out;
  for (const loc of category.armedEffective || []) {
    const leg = entry[loc];
    if (!leg || typeof leg !== "object" || !leg.sizes || typeof leg.sizes !== "object") continue;
    const missing = run.filter((k) => !(Number(leg.sizes[k]?.target) > 0));
    if (missing.length) out[loc] = { missing, all: missing.length === run.length };
  }
  return out;
}

// Where a category is armed in name only — a per-size location that names
// NONE of its sizes — and where it genuinely is.
export function armedInTruth(category) {
  const gaps = policyGaps(category);
  const armed = category?.armedEffective || [];
  return { real: armed.filter((l) => !gaps[l]?.all), hollow: armed.filter((l) => gaps[l]?.all), partial: armed.filter((l) => gaps[l] && !gaps[l].all) };
}

// ── THE CATALOGUE AGAINST THE LIST ───────────────────────────────────────────
// The census lists every category the taxonomy, the policy map or a group
// names, plus any that exists only as rows. Two things a product can be that
// reach none of those, and so had no row anywhere on this card:
//
//   noCategory   products with NO category key (and not a legacy sneaker). No
//                category policy can ever reach them — the "earlier footwear
//                case" again, for everything else. Counted by what the
//                product's old category/subcategory says, so the owner can see
//                what they are.
//   unlisted     a category key some product carries that the census did not
//                return at all (a key outside the category list with no rows).
//
// Computed in the browser from the catalogue the app already holds — no read.
// `categoryKeyOf` is the engine's own resolution (productTaxonomy.js
// effectiveCategoryKey, the browser copy of policyCategoryKey). Deactivated
// products are finished lines and are left out.
export function catalogueOutsideTheList({ products, census, categoryKeyOf, isDeactivated }) {
  const listed = new Set((Array.isArray(census?.categories) ? census.categories : []).map((c) => c.key));
  const none = new Map();       // legacy label → count
  const unlisted = new Map();   // key → count
  let noCategory = 0;
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || (isDeactivated && isDeactivated(p))) continue;
    const key = categoryKeyOf(p);
    if (!key) {
      noCategory += 1;
      const label = [p.category, p.subcategory].filter((x) => typeof x === "string" && x.trim()).join(" › ") || "Nothing recorded";
      none.set(label, (none.get(label) || 0) + 1);
    } else if (!listed.has(key)) {
      unlisted.set(key, (unlisted.get(key) || 0) + 1);
    }
  }
  const sorted = (m) => [...m.entries()].map(([label, products]) => ({ label, products })).sort((a, b) => b.products - a.products || a.label.localeCompare(b.label));
  return { noCategory, noCategoryBy: sorted(none), unlisted: sorted(unlisted).map(({ label, products }) => ({ key: label, products })) };
}

// A group's preview comes back from setGroup's dry run as an `armModel` —
// what the next scan would ask for IF THE GROUP WERE ARMED, per member. The
// detail screen renders every preview through one panel, so the model is
// reshaped to the category preview's fields here. `armed` is carried so the
// panel can say the honest thing about a disarmed group: the next scan asks
// for nothing from it, whatever the numbers.
export function previewFromArmModel(armModel, { armed = false } = {}) {
  if (!armModel || typeof armModel !== "object") return null;
  return {
    totalRequests: armModel.totalRequests || 0,
    totalUnits: armModel.totalUnits || 0,
    cap: armModel.cap ?? null,
    centralOnHand: null,
    legs: [],
    overriddenProducts: (armModel.perMember || []).reduce((n, m) => n + (m.overriddenProducts || 0), 0),
    perMember: armModel.perMember || [],
    exceedsCap: armModel.exceedsCap === true,
    ifArmed: true,
    armed: armed === true,
  };
}

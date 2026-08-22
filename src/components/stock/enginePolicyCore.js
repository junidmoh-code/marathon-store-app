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
  return Object.entries(entry)
    .filter(([loc, e]) => loc !== "perSize" && isObj(e)
      && typeof e.target === "number" && Number.isFinite(e.target) && e.target > 0)
    .map(([loc]) => loc)
    .sort();
}

// ── EDITOR ROWS ──────────────────────────────────────────────────────────────
// One row per location the estate has, not per location already armed: the
// screen has to be able to say "Not carried" about the others, and to offer
// arming a carried-but-unarmed one. Destination locations only — central is a
// source, in_transit and studio are not shops, and offering them would invite
// a policy the engine has no destination for.
export function editorRows({ entry, carriage, destinations }) {
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
      // A location that does not carry the category is NOT editable, whatever
      // the map currently says. An already-armed uncarried location stays
      // visible and editable so it can be corrected — refusing to let the owner
      // fix a mistake is not a safety feature.
      editable: c.carries === true || armed.has(loc),
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
    out[r.loc] = {
      target: r.target == null ? "" : String(r.target),
      minQty: r.minQty == null ? "" : String(r.minQty),
      reorderPoint: r.reorderPoint == null ? "" : String(r.reorderPoint),
    };
  }
  return out;
}

// Seed a location that is being armed for the first time. Minimum is filled in
// from ceil(keep / 2) rather than left blank — the column stays visible, but it
// is never typed from scratch.
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
    const target = numOrNull(row?.target);
    if (target === null) continue;
    const entry = { target };
    const min = numOrNull(row?.minQty);
    entry.minQty = min === null ? defaultMinQty(target) : min;
    const rp = numOrNull(row?.reorderPoint);
    if (rp !== null) entry.reorderPoint = rp;
    out[loc] = entry;
  }
  if (!Object.keys(out).length) return null;
  if (perSize) out.perSize = true;
  return out;
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
    return `${loc}:${FIELD_ORDER.map((f) => String(r[f] ?? "").trim()).join("/")}`;
  }).join("|");
  return `${categoryKey}::${perSize ? "size" : "one"}::${body}`;
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
export function changedFields(before, after) {
  const out = [];
  const b = isObj(before) ? before : {};
  const a = after === null ? {} : (isObj(after) ? after : {});
  const locs = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "perSize").sort();
  for (const loc of locs) {
    const bl = isObj(b[loc]) ? b[loc] : null;
    const al = isObj(a[loc]) ? a[loc] : null;
    if (bl && !al) { out.push({ loc, label: "Stopped stocking here", from: "armed", to: "removed" }); continue; }
    if (!bl && al) out.push({ loc, label: "Started stocking here", from: "not armed", to: "armed" });
    for (const f of FIELD_ORDER) {
      const from = bl && typeof bl[f] === "number" ? bl[f] : null;
      const to = al && typeof al[f] === "number" ? al[f] : null;
      if (from === to) continue;
      out.push({ loc, field: f, label: COLUMN_LABELS[f], from, to,
        text: `${COLUMN_LABELS[f]} ${from === null ? "not set" : from} -> ${to === null ? "not set" : to}` });
    }
  }
  return out;
}

// ── NEXT SCAN ────────────────────────────────────────────────────────────────
// The scan runs "every 15 minutes from 07:00 to 19:00" in Africa/Johannesburg
// (refill-scan.cjs). Africa/Johannesburg is UTC+2 year-round with no daylight
// saving, so the offset is a constant and not a lie waiting for October.
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
  if (h >= 19) return { at: null, label: "tomorrow from 07:00" };
  const nextMin = (Math.floor(m / 15) + 1) * 15;
  const at = dayStart + h * 3600000 + nextMin * 60000;
  // 19:00 is past the window's end — the 18:45 run is the day's last.
  if (nextMin >= 60 && h + 1 >= 19) return { at: null, label: "tomorrow from 07:00" };
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

// ── LAST CHANGE ──────────────────────────────────────────────────────────────
// The header stamp, from the audit trail. Only APPLIED entries count: an
// aborted save changed nothing and must not be presented as the current state's
// provenance.
export function lastChange(historyEntries) {
  const applied = (historyEntries || []).filter((h) => h && h.status === "applied" && Number.isFinite(h.at));
  if (!applied.length) return null;
  return applied.reduce((best, h) => (h.at > best.at ? h : best));
}

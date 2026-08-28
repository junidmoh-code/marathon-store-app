// ─── ONE MECHANISM FOR EVERY TARGET WRITE THIS CARD MAKES ────────────────────
//
// Switch off, arm a product, override one size, clear an override, re-seat.
// Five buttons, ONE explicit-row path, and this file is it. Before this, the
// card had two writers with two different opinions (seatingStore's switch-off
// and the rows panel's in-place edit) and no way at all to say "keep 4 of size
// M here". A second answer to one question is how the estate ends up with rows
// nobody can explain.
//
// ── THE ROW IS THE ENGINE'S FIRST BRANCH, AND THAT IS THE WHOLE DESIGN ───────
// /stock_targets/{loc}/{pid}/{sizeKey} is read before anything else
// (refill-engine.cjs:496) and its `target` is honoured whatever the number is —
// proven, not assumed, in docs/POLICY-PER-PRODUCT-TARGETS.md §2. So:
//
//   an explicit 4   beats a category policy of 2          → the override
//   an explicit 0   beats everything                      → the off switch
//   NO ROW AT ALL   falls through to the category policy  → inherit
//
// Those are not three mechanisms. They are one row, present with a number,
// present with zero, or absent.
//
// ── BLANK MEANS INHERIT. IT HAS NEVER MEANT ZERO. ───────────────────────────
// A blank field writes no row and the size falls through to whatever the
// category, the footwear rule or the size run says. An entered 0 writes a row
// that says "not here", which outranks all of them. Coercing "" to 0 anywhere
// in this path would silently switch off every size somebody left alone — the
// single most destructive typo this screen could make — so "" survives as a
// distinct value from the input to the payload, and `numOrNull` is the only
// place a string becomes a number.
//
// ── WHAT IS SAVED FOR A LOCATION IS THE COMPLETE EXPLICIT SET FOR IT ────────
// A size left blank has its row REMOVED, because that is what "inherit" means.
// Removal is not a silent delete: the row's full previous value travels in the
// history entry, one tap puts it back, and a row this card did not write is
// named and confirmed before it goes (`foreign` below). The 7,797 hand-made
// rows are the source of truth for the products carrying them; they may be
// edited and they may be deliberately retired, but never quietly.
//
// ── minQty IS DERIVED, NOT TYPED ────────────────────────────────────────────
// The live rule requires target AND minQty on every row. ceil(target/2) is the
// ratio every armed batch has used and what the engine itself falls back to,
// so deriving it changes nothing about behaviour and removes a field from a
// grid that already has one per size.

import { resolveTarget, seatingSizes, rawSizeOf, engineSizeKey, SEATING_OFF_SOURCE } from "./seatingCore";
import { bySizeRank, sizeLabel } from "./enginePolicyCore";

// The `source` stamp this card puts on a row it writes. SEATING_OFF_SOURCE is
// the older stamp for the same act (switch off) and is still recognised
// everywhere this one is — rows written before this build must stay clearable.
export const OVERRIDE_SOURCE = "policy_target";
export const OURS = new Set([OVERRIDE_SOURCE, SEATING_OFF_SOURCE]);
export const isOurs = (row) => !!row && typeof row === "object" && OURS.has(row.source);

// The shape /stock_targets/$loc/$pid/$size accepts: target and minQty present
// and numeric (live rules, checked 2026-08-24). Admin-SDK scripts bypass that
// rule, so shapes the rule refuses DO exist on the node — a captured prevRow of
// { target: 0 } with no minQty, or { target: "4" }. One of those included in a
// restore used to fail the entire multi-path update with a bare
// PERMISSION_DENIED: nothing restored, no way forward. Such a row is reported
// and LEFT AS IT IS. Repairing it would be worse: coercing "4" to a number
// nobody wrote, or to 0, silently switches a shop off.
export const writableRow = (row) =>
  typeof row?.target === "number" && Number.isFinite(row.target) &&
  typeof row?.minQty === "number" && Number.isFinite(row.minQty) && row.minQty <= row.target;

export const derivedMinQty = (target) =>
  (Number.isFinite(target) && target > 0 ? Math.ceil(target / 2) : 0);

// Strings in, a whole number or null out. Blank is null — that is the inherit
// signal and it must never become 0. Anything that is not a clean whole number
// is null too, so it is dropped rather than sent as NaN; validateOverrideDraft
// names it at the keyboard first.
export function numOrNull(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── WHAT THIS SIZE WOULD RESOLVE TO WITH NO ROW OF ITS OWN ───────────────────
// The ghost placeholder, the "why this number" line and the changed-fields
// banner all need the same answer: what does the engine say here if the
// override goes away. Answered by running the engine's own precedence with
// THIS PRODUCT'S rows at THIS LOCATION removed — not by re-deriving the
// category policy, which would be a fourth copy of resolution.
export function inheritedAt(ctx, loc, pid, sizeKey) {
  const stripped = {
    ...ctx,
    targets: { ...(ctx?.targets || {}), [loc]: { ...(ctx?.targets?.[loc] || {}), [pid]: {} } },
  };
  const size = rawSizeOf(ctx?.products, pid, sizeKey);
  return resolveTarget(stripped, loc, pid, size);
}

// The engine's source token in the owner's words. "Not carried" is the honest
// answer for null: nothing arms this cell, so nothing will be sent.
export const WHY = {
  explicit: "Product target",
  category_policy: "Category policy",
  footwear_default: "Footwear rule",
  subcategory_default: "Subcategory rule",
  default: "Size run",
};
export const whyLabel = (source) => WHY[source] || "Not carried";

// One line under a location: what decides this product's numbers there, now.
// Reads the seat's own resolved sources rather than re-deciding, so the line
// and the badge can never disagree.
export function whyLine(seat) {
  if (!seat) return "Not carried";
  const sources = new Set(seat.sizes.filter((s) => s.source).map((s) => s.source));
  if (!sources.size) return "Not carried";
  if (sources.size === 1) return whyLabel([...sources][0]);
  // A mixed location is the normal state once one size is overridden. Naming
  // the strongest source alone would hide the others; naming all of them in
  // engine order says which sizes answer to what.
  const order = ["explicit", "category_policy", "footwear_default", "subcategory_default", "default"];
  return order.filter((s) => sources.has(s)).map(whyLabel).join(" · ");
}

// ── THE DRAFT ────────────────────────────────────────────────────────────────
// One row per size the engine would arm here (seatingSizes — the union of the
// product's declared sizes, its cells and its existing rows, plus the "_" cell
// a one-size category policy speaks for). Values are the EXISTING explicit
// row's numbers, or blank where there is no row, so opening the editor and
// saving it again is a no-op.
//
// A ONE-SIZE PRODUCT GETS EXACTLY ONE ROW and no size grid. That falls out of
// seatingSizes rather than being special-cased: a product declaring no sizes
// has "_" and nothing else.
export function overrideDraft(ctx, loc, pid) {
  const rows = ctx?.targets?.[loc]?.[pid] || {};
  const cells = ctx?.stock?.[loc]?.[pid] || {};
  const sizes = {};
  let reorderPoint = "";
  let sawRp = false;
  for (const sizeKey of seatingSizes(ctx, loc, pid).slice().sort(bySizeRank)) {
    const row = rows[sizeKey];
    const has = !!row && typeof row === "object" && typeof row.target === "number";
    sizes[sizeKey] = {
      sizeKey,
      label: sizeKey === "_" ? "One size" : sizeLabel(sizeKey),
      target: has ? String(row.target) : "",
      onHand: typeof cells[sizeKey]?.qty === "number" ? cells[sizeKey].qty : 0,
      hasCell: cells[sizeKey] !== undefined,
      prev: row ?? null,
      foreign: !!row && !isOurs(row),
    };
    // The location's "Ask at", taken from the rows that already carry one. Two
    // rows disagreeing is possible on hand-made data; the field then opens
    // blank (inherit) rather than picking a winner nobody chose.
    if (has && typeof row.reorderPoint === "number") {
      if (!sawRp) { reorderPoint = String(row.reorderPoint); sawRp = true; }
      else if (reorderPoint !== String(row.reorderPoint)) reorderPoint = "";
    }
  }
  return { loc, pid, sizes, reorderPoint };
}

// Every size set to 0 — the off switch, expressed as an override like any
// other. Same draft shape, so it goes through the same plan, the same preview
// and the same history entry as a typed number.
export function switchOffDraft(ctx, loc, pid) {
  const d = overrideDraft(ctx, loc, pid);
  for (const k of Object.keys(d.sizes)) d.sizes[k] = { ...d.sizes[k], target: "0" };
  return { ...d, reorderPoint: "" };
}

// Every size blank — inherit everything. The clear/re-seat draft.
export function clearDraft(ctx, loc, pid) {
  const d = overrideDraft(ctx, loc, pid);
  for (const k of Object.keys(d.sizes)) d.sizes[k] = { ...d.sizes[k], target: "" };
  return { ...d, reorderPoint: "" };
}

// Fill every size from one number. The apply-to-all input: a typing aid, never
// a storage shape — each size still lands as its own row, and each can be
// changed on its own afterwards.
export function applyToAll(draft, value) {
  const sizes = {};
  for (const [k, r] of Object.entries(draft?.sizes || {})) sizes[k] = { ...r, target: String(value ?? "") };
  return { ...draft, sizes };
}

// ── LOCAL VALIDATION ─────────────────────────────────────────────────────────
// Mirrors the server so the owner is told at the keyboard. The server is still
// the authority. 0 IS LEGAL HERE and is not legal in a category policy: a
// category-level 0 is a typo, a product-level 0 is a decision.
export const MAX_TARGET = 500;
export function validateOverrideDraft(draft) {
  const errors = {};
  for (const [k, r] of Object.entries(draft?.sizes || {})) {
    const raw = String(r?.target ?? "").trim();
    if (raw === "") continue;                       // blank = inherit, always legal
    if (!/^\d+$/.test(raw)) { errors[k] = "Whole numbers only — leave it blank to follow the category"; continue; }
    if (Number(raw) > MAX_TARGET) errors[k] = `More than ${MAX_TARGET} is not a shelf`;
  }
  const rp = String(draft?.reorderPoint ?? "").trim();
  if (rp !== "" && !/^\d+$/.test(rp)) errors.reorderPoint = "Ask at must be a whole number, or blank";
  else if (rp !== "") {
    // "Ask at" at or above the smallest target it governs does nothing — the
    // gate is `have > reorderPoint → stay silent`, and a deficit only exists
    // below target. Same rule the category editor holds, one level down.
    const targets = Object.values(draft?.sizes || {})
      .map((r) => numOrNull(r?.target)).filter((n) => n !== null && n > 0);
    if (targets.length && Number(rp) >= Math.min(...targets)) {
      errors.reorderPoint = `Ask at must be below the smallest Keep (${Math.min(...targets)}) — at or above it the setting does nothing`;
    }
  }
  return errors;
}

// ── THE PLAN ─────────────────────────────────────────────────────────────────
// Pure. What would be written, what would be removed, what changes, and which
// removals touch a row this card did not write. The screen shows it, the
// preview is computed from it and the payload is built from it — one object, so
// what was shown and what is sent cannot differ.
//
//   rows      sizes that get an explicit row (target present, 0 included)
//   remove    sizes whose row goes away because the field was left blank
//   restore   rows this card wrote that carry the row they replaced — a clear
//             puts the original back rather than deleting somebody's numbers
//   foreign   removals of rows this card did not write, named so the screen can
//             ask before they go
export function overridePlan(ctx, loc, pid, draft) {
  const live = ctx?.targets?.[loc]?.[pid] || {};
  const rp = numOrNull(draft?.reorderPoint);
  const rows = [], remove = [], restore = [], foreign = [], stuck = [], changes = [];
  const keys = [...new Set([...Object.keys(draft?.sizes || {}), ...Object.keys(live)])].sort(bySizeRank);

  for (const sizeKey of keys) {
    const prev = live[sizeKey] ?? null;
    const prevTarget = prev && typeof prev.target === "number" ? prev.target : null;
    const inherited = inheritedAt(ctx, loc, pid, sizeKey);
    // A size the draft does not name at all (a row on a size the product no
    // longer declares) is LEFT ALONE. The editor never rendered it, so it was
    // never a decision, and this path does not act on numbers nobody saw.
    if (!(sizeKey in (draft?.sizes || {}))) continue;
    const target = numOrNull(draft.sizes[sizeKey]?.target);

    if (target === null) {
      if (prev === null) continue;                                   // already inheriting
      // A row this card wrote may carry the row it replaced. Clearing puts that
      // back; clearing one we created deletes it. Both are "stop overriding",
      // and only one of them is a delete.
      const back = isOurs(prev) && prev.prevRow && typeof prev.prevRow === "object" ? prev.prevRow : null;
      // A captured row the live rule would refuse is REPORTED, not repaired and
      // not sent: see writableRow. The size keeps the row it has.
      if (back && !writableRow(back)) { stuck.push(sizeKey); continue; }
      if (back) {
        restore.push({ sizeKey, prev, to: back });
        changes.push({ sizeKey, from: prevTarget, to: back.target ?? null, kind: "restored" });
      } else {
        remove.push({ sizeKey, prev });
        if (!isOurs(prev)) foreign.push({ sizeKey, prev });
        changes.push({ sizeKey, from: prevTarget, to: inherited ? inherited.target : null,
          kind: "inherit", inheritedFrom: inherited ? inherited.source : null });
      }
      continue;
    }

    const prevRp = prev && typeof prev.reorderPoint === "number" ? prev.reorderPoint : null;
    // ── AN "ASK AT" NEVER RIDES ON A 0 ──────────────────────────────────────
    // The gate is "have > reorderPoint → stay silent", and a target of 0 has no
    // room below it — the server refuses the pair outright (reorderPoint must
    // be below Keep). So the value that would actually LAND is worked out once
    // and used for the no-change test, the row and the change list alike.
    //
    // Comparing the TYPED value while writing the effective one made a size
    // already at 0 fail the no-change test the moment an "Ask at" was typed for
    // the location: it was rewritten with byte-identical content, which
    // re-stamps somebody else's row as this card's doing and files a history
    // entry for a change that changed nothing. The trigger is an ordinary mixed
    // save — some sizes kept, one switched off, one "Ask at". (CodeRabbit, #497.)
    const effRp = rp !== null && target > 0 ? rp : null;
    // A SIZE WHOSE NUMBERS DID NOT MOVE IS NOT REWRITTEN. Sending it anyway
    // would re-stamp the row as this card's doing — quietly taking ownership of
    // somebody else's decision — and would fill the history with entries that
    // changed nothing. A STORED "Ask at" on a switched-off row is still
    // stripped: prevRp is non-null there and effRp is null, so the row does not
    // match and is rewritten without it.
    if (prev !== null && prevTarget === target && prevRp === effRp) continue;
    const row = { sizeKey, target, minQty: derivedMinQty(target) };
    if (effRp !== null) row.reorderPoint = effRp;
    rows.push(row);
    changes.push({ sizeKey, from: prevTarget, to: target, kind: prevTarget === null ? "added" : "changed",
      reorderPointFrom: prevRp, reorderPointTo: effRp,
      inheritedFrom: inherited ? inherited.source : null,
      inheritedTarget: inherited ? inherited.target : null });
  }
  return { loc, pid, rows, remove, restore, foreign, stuck, changes, dirty: changes.length > 0 };
}

// The drift expectation: the numbers the editor was opened on, per size, for
// every size the plan touches. `null` is a real value here — "there was no row"
// — and the server checks it, so a row created underneath is refused rather
// than blind-overwritten.
// ── THE SERVER'S shapeOf, MIRRORED EXACTLY ───────────────────────────────────
// The drift check compares this against `shapeOf(live)` in
// category-policy-write.cjs, and the two must normalise IDENTICALLY or the
// check fires on rows that never changed.
//
// target and minQty pass through RAW — a stored `target: "4"` stays "4". That
// looks careless and is the opposite: Admin-SDK scripts write /stock_targets
// directly and bypass the rule that requires numbers, so string targets exist
// on the live node. Coercing one to `null` here (the old behaviour) made its
// expectation disagree with the server's for a row nobody had touched, so
// CLEARING a script-written row failed with a bare failed-precondition and no
// way forward. Coercing it to `4` instead would be worse — it would claim the
// row holds a number it does not. Passed through, the two sides agree about
// exactly what is there. Only reorderPoint is numeric-or-null, because absent
// and 0 are different policies and the server draws that line too.
// (CodeRabbit, PR #497.)
export function shapeOfRow(r) {
  return {
    target: r?.target ?? null,
    minQty: r?.minQty ?? null,
    reorderPoint: typeof r?.reorderPoint === "number" ? r.reorderPoint : null,
  };
}

export function expectationFor(ctx, loc, pid, plan, draft = null) {
  const live = ctx?.targets?.[loc]?.[pid] || {};
  const out = {};
  const touched = [...plan.rows.map((r) => r.sizeKey), ...plan.remove.map((r) => r.sizeKey), ...plan.restore.map((r) => r.sizeKey)];
  for (const sizeKey of touched) {
    // ── THE NUMBERS THE EDITOR WAS OPENED ON, NOT THE ONES IT HOLDS NOW ─────
    // The draft captured each size's row when it was built. The ctx can be
    // REPLACED underneath it — the Refresh button does exactly that, and so
    // does any re-read — and taking the expectation from the fresh ctx would
    // make the drift check agree with a change the owner never saw: somebody
    // else's edit, silently overwritten by a save of numbers typed before it.
    // The captured row is what the owner decided against, so it is what the
    // server is asked to still find there.
    const prev = draft?.sizes?.[sizeKey] && "prev" in draft.sizes[sizeKey]
      ? draft.sizes[sizeKey].prev
      : live[sizeKey];
    out[sizeKey] = prev && typeof prev === "object" ? shapeOfRow(prev) : null;
  }
  return out;
}

// The callable payload. ONE shape for every one of the five buttons — that is
// the point of this file. `restore` rides as ordinary rows so the server has a
// single write path too; the distinction is kept in `changes` for the history.
export function targetPayload(ctx, loc, pid, draft, { allowRemoveForeign = false, dryRun = false } = {}) {
  const plan = overridePlan(ctx, loc, pid, draft);
  const rows = [
    ...plan.rows,
    ...plan.restore.map((r) => ({ sizeKey: r.sizeKey, ...threeFields(r.to) })),
  ];
  return {
    payload: {
      action: "setProductTargets",
      loc, pid,
      // The product's category travels with the write so the history entry
      // files itself under that category — the card's history panel filters by
      // categoryKey, and an entry with none would show up under every category
      // on the screen. The server takes it as a label, never as authority: it
      // reads the product record for itself.
      ...(typeof ctx?.products?.[pid]?.categoryKey === "string" && ctx.products[pid].categoryKey
        ? { categoryKey: ctx.products[pid].categoryKey } : null),
      rows,
      remove: plan.remove.map((r) => r.sizeKey),
      expected: expectationFor(ctx, loc, pid, plan, draft),
      ...(allowRemoveForeign ? { allowRemoveForeign: true } : null),
      ...(dryRun ? { dryRun: true } : null),
    },
    plan,
  };
}

// A captured prevRow reduced to the three fields the engine reads. Only ever
// called on a row writableRow() has already passed, so nothing is coerced and
// nothing is invented — the numbers that go back are the numbers that were
// there. Provenance the old row carried is deliberately not resurrected: the
// server preserves whatever the LIVE row holds and stamps the write itself.
function threeFields(row) {
  const out = { target: row.target, minQty: row.minQty };
  if (typeof row.reorderPoint === "number" && Number.isFinite(row.reorderPoint) && row.reorderPoint < row.target) {
    out.reorderPoint = row.reorderPoint;
  }
  return out;
}

// ── THE LOCAL PREVIEW ────────────────────────────────────────────────────────
// What the next scan sees, per size, computed from the plan against the context
// already on screen — no extra read, no whole node. The server's own dry run
// answers the same question with live data and is what Save waits for; this is
// what the owner reads while typing.
export function previewRows(ctx, loc, pid, draft) {
  const plan = overridePlan(ctx, loc, pid, draft);
  const byKey = new Map(plan.rows.map((r) => [r.sizeKey, r]));
  const removed = new Set(plan.remove.map((r) => r.sizeKey));
  const restored = new Map(plan.restore.map((r) => [r.sizeKey, r.to]));
  const out = [];
  for (const sizeKey of Object.keys(draft?.sizes || {}).sort(bySizeRank)) {
    const before = resolveTarget(ctx, loc, pid, rawSizeOf(ctx?.products, pid, sizeKey));
    let after;
    if (byKey.has(sizeKey)) after = { target: byKey.get(sizeKey).target, source: "explicit" };
    else if (restored.has(sizeKey)) after = { target: restored.get(sizeKey).target ?? 0, source: "explicit" };
    else if (removed.has(sizeKey)) after = inheritedAt(ctx, loc, pid, sizeKey);
    else after = before;
    out.push({
      sizeKey,
      label: sizeKey === "_" ? "One size" : sizeLabel(sizeKey),
      onHand: draft.sizes[sizeKey]?.onHand ?? 0,
      before: before ? before.target : null,
      beforeSource: before ? before.source : null,
      after: after ? after.target : null,
      afterSource: after ? after.source : null,
      changed: (before ? before.target : null) !== (after ? after.target : null),
      // A size whose target drops to 0 or to nothing retracts its open refill
      // on the next scan — needGone reads resolveTarget (refill-engine.cjs:805)
      // and closes the request as no_longer_needed with nobody rejecting it.
      retracts: !!before && before.target > 0 && (!after || after.target <= 0),
    });
  }
  return out;
}

export { engineSizeKey };

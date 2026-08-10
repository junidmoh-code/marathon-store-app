// ─── WHY IS THIS BUTTON GREY? — disable reasons in warehouse language ────────
// Owner directive 2026-08-10: "never grey something without saying why". Every
// disabled action in the Missing Products tab must state its reason ON THE ROW,
// in words a warehouse operator can act on — never a silently dead button.
//
// WHY THIS IS A MODULE AND NOT A TERNARY IN THE JSX. The reasons were already
// half-computed inside the components (NetworkTransfer had a `whyNot` string,
// MissingFootwear a `solveTitle`), but both were passed to `title=` — a DESKTOP
// HOVER TOOLTIP. This runs on warehouse tablets, where there is no hover and no
// cursor, so on the actual hardware those strings were unreachable: the operator
// saw a dead button and nothing else. Reasons live here so they can be rendered
// as visible text, and so the "is it enabled" test and the "why not" text are
// computed from ONE expression and cannot drift into a button that is greyed for
// a reason the row denies (or, worse, an armed button under a "can't do this"
// line).
//
// THE CONTRACT EVERY CALLER RELIES ON: a null return means the action is
// AVAILABLE. Any string means it is disabled, and that string is what the
// operator reads. There is no third state — so a component can write
// `disabled={!!reason}` and be structurally unable to grey a button silently.
//
// Order matters. Reasons are checked most-blocking first, so an operator with no
// stock role is told THAT rather than being sent to look at a refill policy they
// could not act on anyway.

// ── the clothing Solve (NetworkTransfer) ────────────────────────────────────
// Solve seeds qty-0 carriage cells and promises the engine will then refill
// them, so every reason here is really one question: "would the engine refill
// what I am about to seed?" — plus the two states where we cannot yet tell.
export function solveReason({
  canAct,          // operator holds a stock role
  configLoaded,    // /config/refillEngine has answered
  configError,     // …or failed to read (fail-safe: treated as no switches)
  targetsLoaded,   // /stock_targets has ANSWERED (or failed) — not "is non-empty"
  targetsError,    // …and the answer was a failure, so explicit rows are unknown
  hasSourceStock,  // real units at the card's source location
  policyAtAnyStore,// a positive target resolves for ≥1 size at ≥1 store
  ruleOnAnywhere,  // rule-based targeting enabled at ≥1 seed location
  oneSize,         // the product's only catalogue size is the "_" sentinel
} = {}) {
  if (!canAct) return "You need a stock role to solve this — you're viewing only.";
  if (!configLoaded) return "Checking the refill settings — one moment.";
  if (configError) return "Can't read the refill settings, so Solve is off until they load. Move it manually instead.";
  if (!targetsLoaded) return "Checking the refill settings — one moment.";
  // Cards are built from source stock, so this is normally unreachable from the
  // list. It IS reachable from the open confirm panel, where the operator may be
  // looking at a row whose stock was moved out from under them by another till.
  if (!hasSourceStock) return "No stock at any source — there's nothing to send.";
  if (policyAtAnyStore) return null;
  // No policy: say WHICH of the three reasons, because they send you to three
  // different places. A failed targets read is not the product's fault and must
  // not be reported as "no policy" — the row may well have one we could not see.
  // A killed switch is an engine setting; a missing policy is a target row.
  if (targetsError) return "Can't read the refill settings, so any target set for this product can't be checked. Move it manually instead.";
  if (!ruleOnAnywhere) return "Automatic refills are switched off, so nothing would refill this. Move it manually instead.";
  return oneSize
    ? "No refill policy covers this one-size product yet — it needs a target set before the engine will refill it. Move it manually instead."
    : "No refill policy covers this product, so nothing would refill it. Move it manually instead.";
}

// ── the clothing Solve's inline confirm button ──────────────────────────────
// The outer button asks "is ANY store solvable"; this asks it of the ONE store
// the operator nominated, which can differ under a per-location policy.
export function solveConfirmReason({ canAct, busy, sizesInPlan, storeLabel } = {}) {
  if (!canAct) return "You need a stock role to solve this — you're viewing only.";
  if (busy) return "Working on it…";
  if (!sizesInPlan) return `No refill policy covers this product at ${storeLabel || "this shop"} — pick the other shop, or move it manually.`;
  return null;
}

// ── "Move manually" (the direct transfer) ───────────────────────────────────
export function moveReason({ canAct, busy, units } = {}) {
  if (!canAct) return "You need a stock role to move stock — you're viewing only.";
  if (busy) return "Working on it…";
  if (!units) return "Set a quantity above zero to move.";
  return null;
}

// ── the sneaker list (MissingFootwear) ──────────────────────────────────────
// Its Solve raises refill REQUESTS rather than seeding carriage, so its reasons
// are about the footwear standard and what is already queued — but the contract
// (null = available, string = the words on the row) is identical.
export function footwearSolveReason({ canAct, runLoaded, linesAtAnyHub } = {}) {
  if (!canAct) return "You need a stock role to solve this — you're viewing only.";
  if (!runLoaded) return "Sneaker refill sizes aren't set up yet, so there's nothing to raise. Use Request instead.";
  if (!linesAtAnyHub) return "Nothing left to raise — every size is already queued, or Central has none.";
  return null;
}

export function footwearRequestReason({ canAct } = {}) {
  if (!canAct) return "You need a stock role to raise requests — you're viewing only.";
  return null;
}

export function footwearConfirmReason({ canAct, busy, lines, hubLabel } = {}) {
  if (!canAct) return "You need a stock role to raise requests — you're viewing only.";
  if (busy) return "Working on it…";
  if (!lines) return `Nothing to raise at ${hubLabel || "this hub"} — every size is already queued there, or Central has none.`;
  return null;
}

export function footwearRequestSubmitReason({ canAct, busy, units } = {}) {
  if (!canAct) return "You need a stock role to raise requests — you're viewing only.";
  if (busy) return "Working on it…";
  if (!units) return "Set a quantity above zero to request.";
  return null;
}

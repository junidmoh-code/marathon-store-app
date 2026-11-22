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
  why,             // the plain reason nothing can be solved at any shop, when known
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
  // A shop that keeps this from Central and has nothing left to solve says
  // exactly why (centralFedNoPlanReason) — "no policy" would be untrue there.
  if (why && !targetsError) return why;
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
// `why` (optional): the plain reason this shop has nothing to solve, when it is
// known (centralFedNoPlanReason below). "No refill policy covers…" is only said
// when nothing better is known — it is untrue of a shop that already carries
// the product.
export function solveConfirmReason({ canAct, busy, sizesInPlan, storeLabel, why } = {}) {
  if (!canAct) return "You need a stock role to solve this — you're viewing only.";
  if (busy) return "Working on it…";
  if (!sizesInPlan) return why || `No refill policy covers this product at ${storeLabel || "this shop"} — pick the other shop, or move it manually.`;
  return null;
}

// ── A SHOP KEPT FROM CENTRAL WITH NOTHING TO SOLVE — say what is true ───────
// At Pine and Concrete (and any central-fed store) Solve starts a size the shop
// has no cell for. When every size is already something else, the panel used to
// fall through to two sentences that were both untrue: "No refill policy covers
// this product at Marathon Pine" and "Central has none of this product's
// sizes" — over a card reading "28 units at Central" (Junid, 22 Nov 2026: a
// product Pine already carried, sold out, its refills paused for the count).
//   sizes: [{ size, target, switchedOff, hasCell, trusted, qty }] — one per size
//          the product is kept in; `target` is what the shop keeps, and
//          `switchedOff` says a target of 0 is a row written for this shop.
//   paused: the shop's refills are paused (its count is running).
//   onTheWay: units already requested for this shop, when the caller has read
//          the open requests (0 when it has not).
// Returns null when some size CAN be solved, else { code, text }:
//   switched_off  every size is switched off at this shop
//   no_keep       no policy keeps any size of it here
//   uncounted     the shop holds units of it that have not been counted
//   on_the_way    the shop already carries it and a request for it is open
//   carried       the shop already carries it; the scan refills it
export function centralFedNoPlanReason({ sizes = [], storeLabel, paused = false, onTheWay = 0 } = {}) {
  const shop = storeLabel || "This shop";
  let off = 0, byRow = 0, carried = 0, uncounted = 0;
  for (const s of sizes) {
    if (!(Number(s.target) > 0)) { off += 1; if (s.switchedOff) byRow += 1; continue; }
    if (!s.hasCell) return null;
    if (s.trusted) { carried += 1; continue; }
    if (Number(s.qty) > 0) { uncounted += 1; continue; }
    return null;   // an untrusted cell holding nothing: Solve takes it over
  }
  if (!sizes.length || (!carried && !uncounted)) {
    // Off by a row somebody wrote (the Seating tab), or simply not kept: a
    // size nobody in the network holds resolves no keep until stock arrives.
    return off > 0 && byRow === off
      ? { code: "switched_off", text: `${shop} has this switched off. Switch it back on from the Seating tab to keep it there.` }
      : { code: "no_keep", text: `No refill policy keeps any size of this at ${shop} yet, so there is nothing to solve there.` };
  }
  if (!carried) {
    return { code: "uncounted", text: `${shop} holds stock of this that has not been counted yet. It is refilled once the count confirms it — there is nothing to solve.` };
  }
  // A request already raised for it (the Solve that started it, or the scan):
  // that is the whole answer, whatever else is true.
  if (Number(onTheWay) > 0) {
    return { code: "on_the_way", text: `${shop} already carries this and ${onTheWay} ${onTheWay === 1 ? "is" : "are"} already requested from Central for it, so there is nothing more to solve.` };
  }
  return { code: "carried", text: paused
    ? `${shop} already carries this, so there is nothing to solve. Its refills are paused while ${shop} is being counted; when the count is finished the scan asks Central for it.`
    : `${shop} already carries this, so there is nothing to solve. The scan asks Central for it when the shelf runs low.` };
}

// The sizes CAN be solved but nothing is being sent now — say where Central's
// stock actually is. `centralUnits` is everything Central holds of the product,
// `inSizes` what it holds in the sizes being solved, `free` what is left of
// those after requests already promised. The rest of Central's stock is in
// `otherSizes` — sizes the product's catalogue does NOT list — or in
// `excludedSizes` — listed sizes outside this solve (the shop already carries
// them, or has them switched off). Only the first is a catalogue problem.
export function centralFedNothingSentReason({ storeLabel, centralUnits = 0, inSizes = 0, free = 0, otherSizes = [], excludedSizes = [] } = {}) {
  const shop = storeLabel || "this shop";
  const n = (u) => `${u} unit${u === 1 ? "" : "s"}`;
  if (!(centralUnits > 0)) return `Central has none of this product — nothing to send to ${shop} yet.`;
  if (!(inSizes > 0)) {
    const parts = [];
    if (excludedSizes.length) parts.push(`in ${excludedSizes.length === 1 ? "a size" : "sizes"} ${shop} already carries or has switched off (${excludedSizes.join(", ")}) — the scan refills those when the shelf runs low`);
    if (otherSizes.length) parts.push(`in ${otherSizes.length === 1 ? "a size" : "sizes"} this product does not list (${otherSizes.join(", ")}) — those wait until the product's sizes are corrected`);
    if (!parts.length) parts.push("in a size this panel cannot place");
    return `Central holds ${n(centralUnits)}, but ${parts.join("; and ")}. Nothing more to send to ${shop} now.`;
  }
  if (!(free > 0)) return `Central holds ${n(inSizes)} of these sizes, all already promised to other requests — nothing to send to ${shop} yet.`;
  return `Nothing is sent to ${shop} now. It is marked as carried there and the scan asks Central for it.`;
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
  if (!runLoaded) return "Sneaker refill sizes aren't set up yet, so there's nothing to raise.";
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

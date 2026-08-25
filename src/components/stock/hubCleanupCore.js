// ─── HUB STOCK CLEANUP — PURE CORE ───────────────────────────────────────────
// The decision logic behind the combined Display Register + Hub Sneaker Count
// card: display registration (pass one), the scan-first count (pass two), the
// Leftovers list, and scan resolution. No firebase imports — everything here is
// a pure function over plain data, which is what the mutation tests exercise.
//
// THE MODEL (owner spec 2026-08-06): a display shoe sitting on a shop shelf IS
// hub stock. Registering it ADDS one unit to the hub's existing quantity for
// that size, through applyMovement like every other stock write. Scope is
// HUB 1 and HUB 2 only — Pine (marathon-pine / hub3) is entirely out of scope
// and no id from it may ever appear here.

import { normaliseStyleCode } from "../../utils/styleCode.js";
import { choosePrimaryCodeIndex } from "../../utils/labelPrimary.js";
import { buildLinkSuggestions } from "../../utils/linkSuggestions.js";
import { isMergedAway } from "../../utils/mergedProducts.js";
import { productIsFootwear } from "../../utils/footwearLine.js";
import { isRegistered } from "../../utils/labelIdentity.js";
import { isDeactivated } from "../../utils/deactivation.js";
import { claimOwnerIds, allRegisteredSiblings } from "../../utils/styleCodeSiblings.js";

// The ONLY hubs this feature touches. A closed list, deliberately NOT derived
// from the location registry: the registry contains hub3 (Pine's lane), and
// "everything warehouse-shaped" is exactly the derivation that would leak it in.
export const CLEANUP_HUBS = Object.freeze(["hub1", "hub2"]);
export const CLEANUP_HUB_LABELS = Object.freeze({ hub1: "Hub 1", hub2: "Hub 2" });

export function isCleanupHub(hub) {
  return CLEANUP_HUBS.includes(hub);
}

// The shop floors a hub display can stand on (owner spec 2026-08-12: a display
// is a SLOT per product per STORE). A closed list for the same reason as
// CLEANUP_HUBS — Pine is out of scope, and deriving "everything store-shaped"
// from the registry would leak marathon-pine in.
export const DISPLAY_STORES = Object.freeze(["marathon-pe", "trophy"]);
export const DISPLAY_STORE_LABELS = Object.freeze({ "marathon-pe": "Marathon PE", trophy: "Trophy" });

// ── REGISTRATION KEYS ────────────────────────────────────────────────────────
// One registration slot per (product, size) per hub, and a DETERMINISTIC
// movement id derived from that slot. The movement id is the idempotency key
// applyMovement enforces, so scanning the same display twice — same device,
// other device, retry after a network drop — collapses to ONE stock unit.
export function registerKey(productId, sizeKey) {
  return `${productId}__${sizeKey}`;
}

export function registerMovementId(hub, productId, sizeKey) {
  return `dispreg_${hub}_${productId}_${sizeKey}`;
}

// The n-th EXTRA unit (a second physical display of the same product+size) gets
// its own deterministic id, derived from the quantity already registered — two
// devices racing to add "one more" onto the same base build the SAME id, and
// applyMovement lets exactly one of them count.
export function extraUnitMovementId(hub, productId, sizeKey, priorQty) {
  return `dispreg_${hub}_${productId}_${sizeKey}_a${priorQty}`;
}

// ── SCAN RESOLUTION ──────────────────────────────────────────────────────────
// A scan is one of: an 8-digit shop label (the /barcodes index answers, with a
// size when the label was per-size), a manufacturer style code off the tongue
// label (matched on styleCodeNormalised), or noise. The decision is pure; the
// caller does the /barcodes lookup and hands the row in.
//
//   { kind: "product", product, size|null }   resolved (size known when per-size)
//   { kind: "unresolved", code }              nothing owns this code — NOT an
//                                             error: in pass two this is the
//                                             signal the item was never
//                                             registered as a product at all.
export function resolveCleanupScan(raw, { products = [], barcodeRow = null } = {}) {
  const code = String(raw ?? "").trim();
  if (!code) return { kind: "unresolved", code };

  if (barcodeRow && barcodeRow.productId) {
    const p = (products || []).find((x) => x && x.id === barcodeRow.productId);
    if (p && !isMergedAway(p)) {
      return { kind: "product", product: p, size: barcodeRow.size != null ? String(barcodeRow.size) : null };
    }
    // A row pointing at a merged-away or unknown product: follow the pointer if
    // the survivor is in the catalogue; otherwise it is unresolved.
    if (p && isMergedAway(p)) {
      const survivor = (products || []).find((x) => x && x.id === p.mergedInto);
      if (survivor) return { kind: "product", product: survivor, size: barcodeRow.size != null ? String(barcodeRow.size) : null };
    }
    return { kind: "unresolved", code };
  }

  const normalised = normaliseStyleCode(code);
  if (normalised) {
    const owners = (products || []).filter((p) => p && !isMergedAway(p) && p.styleCodeNormalised === normalised);
    if (owners.length === 1) return { kind: "product", product: owners[0], size: null };
    if (owners.length > 1) {
      // Two live products claiming one code IS the duplicate case — surface it,
      // never guess which one the operator is holding.
      return { kind: "duplicate", code, products: owners };
    }
  }
  return { kind: "unresolved", code };
}

// ── REGISTRATION ENTRY (owner correction 2026-08-06) ─────────────────────────
// Nothing is CREATED during registration — every shoe already has a product
// record. The operator FINDS the shoe first (name search, or the not-yet-
// registered list; a barcode scan is only an optional shortcut), and the panel
// then captures TWO facts in one save: the manufacturer style number off the
// INNER TONGUE LABEL, and the size on display. Every entry path builds its
// panel through THIS one function, so search, the list and the shortcut are
// provably the same screen.
export function registerPanelFor(product, size = null) {
  if (!product || !product.id) return null;
  return { mode: "register", product, size: size != null ? String(size) : null, code: null };
}

// The style-number step's outcome, from a tongue-label read or typing. The
// register save refuses to complete until one of these holds:
//   on file  — the product already carries an immutable styleCodeNormalised
//   captured — a code was read from the label or typed (normalises non-empty)
//   skipped  — a deliberate, reasoned "this shoe has no readable style number"
export const STYLE_SKIP_REASONS = Object.freeze(["label_unreadable", "label_missing", "no_code_exists"]);

export function styleStepSatisfied(product, styleCode) {
  if (product && product.styleCodeNormalised) return true;
  if (styleCode && typeof styleCode.code === "string" && normaliseStyleCode(styleCode.code)) return true;
  // A LABEL READING (token set) is a full identity too — it becomes an alias
  // in /label_aliases, never a styleCodeNormalised (owner design fix
  // 2026-08-06: aliases, not keys — so immutability can never dead-end).
  if (styleCode && Array.isArray(styleCode.aliasTokens) && styleCode.aliasTokens.length >= 2) return true;
  if (styleCode && STYLE_SKIP_REASONS.includes(styleCode.skipped)) return true;
  return false;
}

// What a tongue-label OCR response means for the UI: one clean candidate is
// chosen outright; several become tap-chips — UNLESS a learned LAYOUT RULE
// already answers "which token is the style number" (server `autoPick`, owner
// spec 2026-08-08: a question a human has answered for this label layout is
// not asked twice). An auto-pick still carries every candidate in
// `allCandidates` so the caller files ALL of them as identities for the
// resolved product — which token wins can no longer split one shoe in two.
// NO known format but readable text offers the label FINGERPRINT (a stable
// identity built from the label's non-variable tokens — never a rejection);
// nothing readable falls back to typing, with copy that says what to DO next.
export function chooseFromLabelRead(data) {
  const candidates = Array.isArray(data && data.candidates) ? data.candidates.filter(Boolean) : [];
  const display = Array.isArray(data && data.displayCandidates) && data.displayCandidates.length === candidates.length
    ? data.displayCandidates : candidates;
  if (candidates.length === 1) return { kind: "chosen", code: display[0], allCandidates: candidates };
  if (candidates.length > 1) {
    // TWO servers picks can decide a multi-candidate read, in strict order:
    //   autoPick   — a LAYOUT RULE a human taught ("learned" wording);
    //   preferred  — tier 2's own read of the label (owner spec 2026-08-13:
    //                tier 2 prefers, it no longer erases — the full candidate
    //                set rides `allCandidates` and files as identities).
    // Either pick must name one of THIS read's candidates — anything else (a
    // stale rule, a mismatched response) falls back to asking. Fail closed.
    const autoPick = typeof (data && data.autoPick) === "string" ? data.autoPick : null;
    const i = autoPick ? candidates.indexOf(autoPick) : -1;
    if (i >= 0) return { kind: "chosen", code: display[i], auto: true, autoSource: "layout", allCandidates: candidates };
    const preferred = typeof (data && data.preferred) === "string" ? data.preferred : null;
    const j = preferred ? candidates.indexOf(preferred) : -1;
    if (j >= 0) return { kind: "chosen", code: display[j], auto: true, autoSource: "read", allCandidates: candidates };
    // NO server pick — the reader used to ASK here ("tap the style number").
    // It no longer does (owner spec 2026-08-23: never ask which code): the
    // head of the set is chosen by the deterministic rule in
    // utils/labelPrimary.js and the full set rides along. The choice is
    // announced with override chips (a tap still teaches the layout rule), but
    // nothing waits for it.
    const k = choosePrimaryCodeIndex(candidates);
    return { kind: "chosen", code: display[k], auto: true, autoSource: "rule", allCandidates: candidates };
  }
  const tokens = Array.isArray(data && data.tokens) ? data.tokens.filter(Boolean) : [];
  if (tokens.length >= 2) {
    return {
      kind: "tokens", tokens,
      message: "No brand article number on this label — the label's own wording identifies this shoe.",
    };
  }
  const broken = Array.isArray(data && data.errors) && data.errors.length > 0;
  return { kind: "none", message: broken
    ? "The label reader is down right now. Type the style number from the tongue label below — that always works."
    : "Nothing readable on that photo. Get closer and fill the frame with the label — or type the style number below. If this brand prints no code at all, use “This shoe has no readable style number”." };
}

// ── COUNT ENTRY (owner reversal 2026-08-06) ──────────────────────────────────
// The count pass brings a shoe up the SAME way registration does: read the
// style number off the INNER TONGUE LABEL. Every count entry path — the label
// read, manual style-number entry, name search, and the subordinate barcode
// shortcut — builds its panel through THIS one constructor, so all of them are
// provably the same screen.
export function countPanelFor(product, size = null) {
  if (!product || !product.id) return null;
  return { mode: "count", product, size: size != null ? String(size) : null, code: null };
}

// Resolve a STYLE NUMBER (label-read or typed) to its product, in count mode.
// /style_code_index is THE authority on who owns a code — and a code may now
// own SEVERAL products (colourway siblings, utils/styleCodeSiblings.js). The
// ONE unbreakable rule (owner spec 2026-08-07): a code that resolves to MORE
// THAN ONE product NEVER resolves silently. The operator sees every candidate
// side by side and picks, or says "none of these". A code owning exactly one
// product still resolves in one step, exactly as before. Outcomes:
//   { kind: "claim", productId }         the index named ONE owner — caller
//                                        follows the id (and any merge pointer)
//   { kind: "product", product }         a single live catalogue owner
//   { kind: "choose", products,          2+ candidates — the human picks.
//     siblings, unloadedIds }            `siblings` true = the index vouches
//                                        for ALL of them (colourways, no
//                                        merge banner); false = at least one
//                                        pairing is an unexplained collision.
//   { kind: "unresolved", normalised }   a CLEAN read that nothing owns: the
//                                        never-registered signal, the primary
//                                        detector of this whole pass
export function resolveStyleNumber(code, { products = [], claim = null } = {}) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return { kind: "unresolved", normalised: "" };

  // Candidates from BOTH directions: products STAMPED with the code (codes
  // that pre-date the index — this repo's own twin-collision incident), and
  // products the INDEX names as owners (primary + siblings), resolved against
  // the loaded catalogue. Neither alone sees everything.
  const stamped = styleCodeOwners(normalised, products);
  const indexOwnerIds = claimOwnerIds(claim);
  const byId = new Map(stamped.map((p) => [p.id, p]));
  const unloadedIds = [];
  for (const id of indexOwnerIds) {
    if (byId.has(id)) continue;
    const known = (products || []).find((x) => x && x.id === id);
    // A merged-away owner is neither a candidate NOR unloaded: the claim still
    // names an id whose SURVIVOR answers for it now (a failed or in-flight
    // merge repoint leaves this state). Counting it as unloaded would push a
    // one-live-owner code off the one-step path and offer a merge banner for
    // a set that is not a collision — so it is dropped here.
    if (known && isMergedAway(known)) continue;
    if (known) byId.set(id, known);
    else unloadedIds.push(id); // named by the index but not visible here
  }
  const candidates = [...byId.values()];

  if (candidates.length === 1 && !unloadedIds.length) {
    // Exactly one visible candidate and the index names nothing else: the
    // one-owner fast path, unchanged.
    const only = candidates[0];
    if (claim && claim.productId === only.id) return { kind: "claim", productId: only.id, normalised };
    if (!indexOwnerIds.length) return { kind: "product", product: only, normalised };
    // The index names exactly this product (as primary or sibling) — follow it.
    return { kind: "claim", productId: only.id, normalised };
  }

  if (candidates.length + unloadedIds.length > 1) {
    return {
      kind: "choose",
      products: candidates,
      normalised,
      claimProductId: claim && claim.productId ? claim.productId : null,
      // True only when the index vouches for EVERY candidate — then this is a
      // set of registered colourways, and no merge banner belongs on it.
      siblings: allRegisteredSiblings(claim, candidates.map((p) => p.id)) && !unloadedIds.length,
      unloadedIds,
    };
  }

  if (claim && claim.productId) {
    // The index names one owner we cannot see locally — follow it anyway; the
    // caller fetches the product (and its merge pointer) by id.
    return { kind: "claim", productId: claim.productId, normalised };
  }
  return { kind: "unresolved", normalised };
}

// ─── EVERY TOKEN ON THE LABEL, ONE LIST (owner spec 2026-08-15) ──────────────
// THE DEFECT THIS REPLACES: the count read every code-shaped number a label
// printed, auto-picked ONE of them (a learned layout rule, or tier 2's own
// preference — chooseFromLabelRead above), and then ran the whole resolution
// chain against that single token. Whatever the OTHER numbers owned was
// invisible: a Timberland label printing A6CWNEN3 and A8425 showed only the
// first token's products, and the shoe the operator was holding could be
// sitting behind the second.
//
// The admin intake gate never had this problem, because its candidate list is
// built from the token SET (buildLinkSuggestions with allCodes, plus one
// resolveAnyCode round trip over [primary, ...others]) while the auto-pick only
// decides what goes in the text field. This is that same gather, for the count.
//
// PURE. The caller does the reads and hands them in:
//   tokens        every normalised code-shaped token, PRIMARY FIRST (the
//                 ordering carries through to the picker, so the auto-picked
//                 token's owners still lead the list — ordering, never filtering)
//   claims        { [token]: /style_code_index row | null }
//   serverOwners  labelAlias resolveAnyCode's owners — [{ productId, code }] —
//                 which is the ONLY way an alias-only owner (a code filed
//                 against a product that never stamped it) can be seen
//   resolved      { [productId]: product } for ids not in `products`, already
//                 followed through any merge pointer by the caller
//
// Returns candidates in insertion order with the tokens that found each, plus
// the ids the index/server named that this device cannot show. A merged-away
// product is NEITHER a candidate NOR unloaded — its survivor answers for it
// (same rule as resolveStyleNumber).
export function labelTokenSet(display, allCodes) {
  const out = [];
  for (const raw of [display, ...(Array.isArray(allCodes) ? allCodes : [])]) {
    const n = normaliseStyleCode(raw);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function mergeTokenCandidates({ tokens = [], products = [], claims = {}, serverOwners = [], resolved = {} } = {}) {
  const byId = new Map();      // productId → { product, codes: [] }
  const unloaded = new Map();  // productId → [codes]
  const known = (id) => (products || []).find((x) => x && x.id === id) || null;

  const add = (id, code) => {
    if (!id) return;
    const local = known(id);
    // The claim (or an unrepointed alias row) still names a merged-away id;
    // its survivor answers for it now. Neither candidate nor unloaded.
    if (local && isMergedAway(local)) return;
    // INVARIANT GUARD, not a live-bug fix (Sonnet architect review, PR #371).
    // The only production feed for `resolved` is fetchProductFollowingMerge,
    // which returns a record ONLY on its `!p.mergedInto` branch — so today it
    // cannot hand back a merged-away one, and this branch is unreachable
    // through that call site. It is kept because this module is pure and must
    // not depend on its caller for the invariant: if a future caller resolves
    // ids some other way, a merged-away record must land in UNLOADED (visible,
    // "reload before trusting this list") rather than become a countable row.
    const fetched = (resolved && resolved[id]) || null;
    const product = local || (fetched && !isMergedAway(fetched) ? fetched : null);
    if (product) {
      if (!byId.has(product.id)) byId.set(product.id, { product, codes: [] });
      const row = byId.get(product.id);
      if (code && !row.codes.includes(code)) row.codes.push(code);
      return;
    }
    if (!unloaded.has(id)) unloaded.set(id, []);
    if (code && !unloaded.get(id).includes(code)) unloaded.get(id).push(code);
  };

  for (const token of tokens) {
    // Products STAMPED with the token, and the ids the index names as owners
    // (primary + registered colourway siblings). Neither alone sees everything.
    for (const p of styleCodeOwners(token, products)) add(p.id, token);
    for (const id of claimOwnerIds((claims && claims[token]) || null)) add(id, token);
  }
  for (const o of serverOwners || []) {
    if (!o || !o.productId) continue;
    add(o.productId, normaliseStyleCode(o.code) || null);
  }

  const candidates = [...byId.values()];
  const unloadedIds = [...unloaded.keys()];
  // Which of the label's numbers this candidate set answers to. ONE distinct
  // code across every owner is the colourway-sibling shape; two or more means
  // the label's own numbers name different products, which is the duplicate
  // question and must never be dressed up as a colourway choice.
  const ownerCodes = [...new Set([
    ...candidates.flatMap((c) => c.codes),
    ...[...unloaded.values()].flat(),
  ].filter(Boolean))];
  return { candidates, unloadedIds, ownerCodes };
}

// ── THE REGISTRATION COLLISION QUESTION (owner spec 2026-08-07) ──────────────
// At registration the operator has ALREADY selected the product — a human has
// vouched for the identity — so a code owned by a DIFFERENT product is a
// QUESTION, never an automatic anything:
//   "none"     no collision — save proceeds
//   "ask"      collision, unanswered — the save is HELD until the human says
//              "same shoe" (→ merge flow) or "different colourway" (→ sibling)
//   "resolved" answered "different colourway" (or the index already registers
//              the pair as siblings) — save proceeds, both keep the code
// Silence is not an outcome. There is no branch that resolves a collision
// without an answer, and the test suite mutation-proves that.
export function collisionQuestion({ conflictOwners = [], siblingOk = false } = {}) {
  if (!conflictOwners || !conflictOwners.length) return "none";
  return siblingOk ? "resolved" : "ask";
}

// Live products already claiming this code — the duplicate case, surfaced
// before the save so the operator routes to Merge instead of guessing.
export function styleCodeOwners(code, products, excludeId = null) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return [];
  return (products || []).filter((p) =>
    p && p.id !== excludeId && !isMergedAway(p) && p.styleCodeNormalised === normalised);
}

// An open /duplicate_candidates row involving this product, if any — the scan
// flow surfaces it as a Merge entry point.
export function openDuplicateFor(productId, duplicateRows) {
  for (const [pairId, row] of Object.entries(duplicateRows || {})) {
    if (!row || row.status !== "open") continue;
    if (row.productIdA === productId || row.productIdB === productId) {
      return { pairId, ...row, otherId: row.productIdA === productId ? row.productIdB : row.productIdA };
    }
  }
  return null;
}

// ── THE REGISTER SEARCH POOL (owner fixes 1+2, 2026-08-06) ───────────────────
// Footwear ONLY — sneakers, soccer boots and the rest of the footwear group —
// through the ONE cross-app classifier (productIsFootwear). The classifier is
// preferred over the raw category field and deliberately not widened here: its
// byte-identical twin in marathon-pos-app decides hub-vs-shop deduction.
export function registerSearchPool(products) {
  return (products || []).filter((p) => p && p.id && productIsFootwear(p) && !isMergedAway(p));
}

// ── SIZES ────────────────────────────────────────────────────────────────────
// Real, pickable sizes: the "_" one-size sentinel is never a display size, and
// the raw size string is what callers hand BACK to the stock layer — the
// encoding into a storage key happens inside applyMovement/stockSizeKey, never
// here. Keeping label and key on separate code paths is what stops a display
// label ever minting a phantom cell.
export function realSizes(product) {
  const raw = product && product.sizes;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return arr.map(String).map((s) => s.trim()).filter((s) => s && s !== "_");
}

// ── LEFTOVERS ────────────────────────────────────────────────────────────────
// After registration: every footwear product that HOLDS stock at this hub and
// is NOT REGISTERED. One card per product; qty per location comes from
// `allStock` = { loc: { pid: { sizeKey: cell } } }.
//
// ── THE RULE, AND THE DEFECT IT REPLACES (owner spec 2026-08-23) ─────────────
//     A PRODUCT REGISTERED WITH A LABEL NUMBER IS NOT A LEFTOVER. EVER.
//
// This list used to key on the REGISTER PASS RECORD — /settings/hubSneakerCount
// /register/{hub} — i.e. on "was this shoe walked past on the floor during this
// hub's registration pass". That is a different question from the one the card
// asks, and it is the wrong one:
//
//   • it is per-HUB and per-PASS, so a product registered with its code at the
//     other hub, at the intake form, at the count, or by the merge picker was
//     still a leftover here;
//   • it ignored every identity store. styleCodeNormalised was never consulted,
//     /style_code_index was never consulted, /label_aliases was never
//     consulted. A shoe could carry a claimed manufacturer code and sit on this
//     list forever;
//   • a NEWLY CREATED product, registered at the moment of creation, appeared
//     here the instant it was given stock.
//
// The register record is still honoured — being seen on the floor is still a
// perfectly good reason not to be a leftover — but it is now one of FOUR
// reasons, and the other three come from `identityMap` (the productIdentity
// callable, folded in src/utils/labelIdentity.js).
//
// FAIL SOFT. An absent or empty identityMap degrades to the style-code field
// plus the register record: fewer exclusions, never more. A product is only
// ever KEPT on the list by the absence of evidence, so a failed identity read
// can leave a registered product listed for one session — it can never hide an
// unregistered one, which is the direction that would lose stock.
export function buildLeftovers({ hub, products = [], hubStock = {}, registered = {}, allStock = null, identityMap = null }) {
  const registeredPids = new Set(Object.values(registered || {}).map((r) => r && r.productId).filter(Boolean));
  const out = [];
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !productIsFootwear(p)) continue;
    const cells = hubStock[p.id];
    if (!cells) continue;
    const hubQty = totalQty(cells);
    if (hubQty <= 0) continue;                 // nothing actually held here
    if (isDeactivated(p)) continue;            // retired — the Deactivated list shows it
    if (registeredPids.has(p.id)) continue;    // seen on the floor — not a leftover
    if (isRegistered(p, identityMap)) continue; // carries a code, a claim or an alias
    out.push({
      product: p,
      hubQty,
      locations: allStock ? locationsHolding(p.id, allStock) : null,
    });
  }
  out.sort((a, b) => b.hubQty - a.hubQty || String(a.product.name || "").localeCompare(String(b.product.name || "")));
  return out;
}

// ── FINISHED LINES ───────────────────────────────────────────────────────────
// The census gap (2026-08-25): an unregistered footwear product whose cells
// have ALL sold to zero appears in NO list — buildLeftovers requires stock at
// the hub, yet the empty cells still arm the refill engine (storeCarries is
// cell PRESENCE, and under the per-size category policy a stray unit anywhere
// wakes the size). These are the finished lines the deactivate action exists
// for. NETWORK-WIDE by owner order (2026-08-25, Hub 1 arming): cells at ANY
// location — not just this hub — zero (or negative) total quantity at EVERY
// location, not registered, not deactivated yet. `cellLocs` names where the
// empty cells sit, since locationsHolding (nonzero-only) is empty for these
// by definition. Same identity rule, same fail-soft direction as
// buildLeftovers — absence of evidence keeps a product listed, never hides it.
export function buildFinishedLines({ hub, products = [], hubStock = {}, registered = {}, allStock = null, identityMap = null }) {
  if (!allStock) return [];   // needs the network view to prove "zero everywhere"
  const registeredPids = new Set(Object.values(registered || {}).map((r) => r && r.productId).filter(Boolean));
  const out = [];
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !productIsFootwear(p)) continue;
    if (isDeactivated(p)) continue;
    if (registeredPids.has(p.id)) continue;
    if (isRegistered(p, identityMap)) continue;
    let everywhere = 0;
    const cellLocs = [];
    for (const [loc, prods] of Object.entries(allStock)) {
      if (!prods?.[p.id]) continue;
      cellLocs.push(loc);
      everywhere += totalQty(prods[p.id]);
    }
    if (!cellLocs.length) continue;            // no cells anywhere — nothing arms it
    if (everywhere > 0) continue;              // holds stock — that is a leftover, not a finished line
    out.push({ product: p, cellLocs });
  }
  out.sort((a, b) => String(a.product.name || "").localeCompare(String(b.product.name || "")));
  return out;
}

// ── DEACTIVATED ──────────────────────────────────────────────────────────────
// EVERY deactivated product, stock-holders first — the visibility guarantee:
// a deactivated product holding stock anywhere must never be silently lost.
// Deliberately NOT footwear-gated and NOT identity-gated: whatever carries the
// flag shows here, with a one-tap Reactivate.
export function buildDeactivatedRows({ products = [], allStock = null }) {
  const out = [];
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !isDeactivated(p)) continue;
    let units = 0;
    if (allStock) for (const prods of Object.values(allStock)) units += totalQty(prods?.[p.id]);
    out.push({ product: p, units, locations: allStock ? locationsHolding(p.id, allStock) : [] });
  }
  out.sort((a, b) => (b.units - a.units)
    || (Number(b.product.deactivated?.at) || 0) - (Number(a.product.deactivated?.at) || 0)
    || String(a.product.name || "").localeCompare(String(b.product.name || "")));
  return out;
}

export function totalQty(cells) {
  let sum = 0;
  for (const [k, cell] of Object.entries(cells || {})) {
    if (k === "_meta" || !cell || typeof cell !== "object") continue;
    if (typeof cell.qty === "number") sum += cell.qty;
  }
  return sum;
}

/** Every location this product holds stock at (non-zero), with qty and per-size detail. */
export function locationsHolding(productId, allStock) {
  const out = [];
  for (const [loc, prods] of Object.entries(allStock || {})) {
    const cells = prods && prods[productId];
    if (!cells) continue;
    const qty = totalQty(cells);
    const sizes = {};
    for (const [k, cell] of Object.entries(cells)) {
      if (k === "_meta" || !cell || typeof cell !== "object") continue;
      if (typeof cell.qty === "number" && cell.qty !== 0) sizes[k] = cell.qty;
    }
    if (qty !== 0 || Object.keys(sizes).length) out.push({ loc, qty, sizes });
  }
  out.sort((a, b) => b.qty - a.qty);
  return out;
}

// ── PROGRESS ─────────────────────────────────────────────────────────────────
// "Scanned versus expected" for the zone (the hub): how many stock-holding
// footwear products have been seen (registered) against how many the hub holds.
export function registrationProgress({ products = [], hubStock = {}, registered = {} }) {
  const registeredPids = new Set(Object.values(registered || {}).map((r) => r && r.productId).filter(Boolean));
  let expected = 0;
  let seen = 0;
  for (const p of products) {
    if (!p || !p.id || isMergedAway(p) || !productIsFootwear(p)) continue;
    const cells = hubStock[p.id];
    if (!cells || totalQty(cells) <= 0) {
      // Products with no hub stock can still be registered (that is how a
      // forgotten display gets its unit back) — count them as seen-extras.
      if (registeredPids.has(p.id)) seen += 0; // not part of "expected"
      continue;
    }
    expected += 1;
    if (registeredPids.has(p.id)) seen += 1;
  }
  return { seen, expected, units: Object.values(registered || {}).reduce((n, r) => n + (Number(r && r.qty) || 0), 0) };
}

// ── THE NEVER-EMPTY CANDIDATE LIST (owner spec 2026-08-23) ───────────────────
// The merge picker and the assistant finder show the SAME thing after a label
// read: the exact owners every token found (photo, name, "found by <token>"),
// then the ranked near-matches, padded with the closest catalogue rows so the
// panel is never empty. ONE pure helper so the two panels cannot drift.
//   exactRows     rows already resolved as owners (exactCandidateRow below)
//   products      the catalogue this surface may offer (already filtered)
//   excludeIds    ids never to pad with (the merge loser, for instance)
//   minRows       the floor the pad fills to (default 8)
//   ...args       buildLinkSuggestions args: kind, normalised, allCodes,
//                 modelName, tokens, aliasCandidates
// Exact rows always lead; the pad never outranks them and never repeats them.
export const NEVER_EMPTY_MIN_ROWS = 8;

export function exactCandidateRow(product, reason, code = null) {
  return { product, code, field: "confirmed", tier: "exact", score: 105, reasons: [reason] };
}

export function padCandidateRows({ exactRows = [], products = [], excludeIds = [], minRows = NEVER_EMPTY_MIN_ROWS, ...args } = {}) {
  const exclude = [...excludeIds, ...exactRows.map((r) => r.product.id)].filter(Boolean);
  const ranked = buildLinkSuggestions({
    ...args, excludeIds: exclude, products, includeExact: false,
    fillToMin: Math.max(0, minRows - exactRows.length),
  });
  return exactRows.concat(ranked);
}

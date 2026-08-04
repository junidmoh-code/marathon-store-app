// ─── STYLE CODE — CLAIM-FIRST UNIQUENESS ─────────────────────────────────────
// A style code may belong to exactly one product. This module is how that is
// enforced, and the enforcement is a CLAIM, never a CHECK.
//
// ── WHY NOT CHECK-THEN-WRITE ─────────────────────────────────────────────────
// The obvious version — "does any product already have this code? no? then
// create one" — is a race with a window wide enough to drive a delivery through.
// Two staff scanning the same shoe on two tablets both read "no", both create a
// product, and the catalogue now holds two records for one shoe with stock split
// across them. Nothing detects it; it surfaces weeks later as a shoe that is
// somehow always short.
//
// The RTDB rules close that window: /style_code_index/{code} is CREATE-ONCE.
// Two writers race, one wins, the other is denied. The database arbitrates, not
// the client, so there is no window at all.
//
// ── THE ORDER, AND WHY IT IS THIS ORDER ──────────────────────────────────────
//   1. mint the product id            ("p" + serverNowMs())
//   2. CLAIM /style_code_index/{code} create-once, with that id
//   3. claim won  → create the product, stamped with the code
//      claim lost → read the winner's productId and route to ADD STOCK on it
//
// The id is minted before the product exists, which is what makes claiming
// before creating possible. The claim is made as LATE as possible — immediately
// before the product write — so the window in which a claim can outlive a failed
// product write is as small as it can be. That window cannot be closed entirely
// (there are two writes and no transaction across them), so the orphan it can
// leave is detected and reported rather than pretended away — see
// resolveStyleCode's `claimOrphaned`.
//
// ── WHAT THE RULES VALIDATE ──────────────────────────────────────────────────
// /style_code_index/$normalisedCode
//   required: productId, claimedAt (number)
//   optional: claimedBy — MUST equal auth.uid
//   NO OTHER CHILD KEYS ARE PERMITTED. An extra field fails the write, and a
//   failed write here looks exactly like "someone else owns this code", which
//   would be a maddening bug to chase. Hence buildClaim() constructs the object
//   field by field rather than spreading anything into it.

import { ref, get, set } from "firebase/database";
import { database } from "../firebase";
import { normaliseStyleCode } from "./styleCode";

export const STYLE_CODE_INDEX_PATH = "style_code_index";

/** Outcome kinds — exhaustive, so callers can switch without a default case. */
export const CLAIM_OK = "claimed";
export const CLAIM_TAKEN = "taken";
export const CLAIM_FAILED = "failed";

/**
 * EXACTLY the three permitted fields, built one at a time.
 * `claimedBy` must equal auth.uid or the rules reject the write.
 */
export function buildClaim({ productId, uid, nowMs }) {
  const claim = { productId: String(productId), claimedAt: Number(nowMs) };
  if (uid) claim.claimedBy = String(uid);
  return claim;
}

/**
 * Attempt the create-once claim.
 *
 * @returns {Promise<
 *   | { kind: "claimed", normalised: string }
 *   | { kind: "taken", normalised: string, productId: string|null, readable: boolean }
 *   | { kind: "failed", normalised: string, error: Error }
 * >}
 *
 * "taken" and "failed" are DELIBERATELY different. A denied write can mean the
 * code is spoken for, or that this user lacks a stockRole — telling a staff
 * member "that shoe already exists" when the real problem is their permissions
 * sends them hunting for a product that isn't there. So on denial we try to read
 * the winning claim: if we can read a productId, it is genuinely taken; if we
 * cannot, we say so honestly rather than guessing.
 */
export async function claimStyleCode(code, { productId, uid, nowMs }) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return { kind: CLAIM_FAILED, normalised: "", error: new Error("empty style code") };

  const slot = ref(database, `${STYLE_CODE_INDEX_PATH}/${normalised}`);
  try {
    await set(slot, buildClaim({ productId, uid, nowMs }));
    return { kind: CLAIM_OK, normalised };
  } catch (err) {
    // Denied. Who won?
    try {
      const snap = await get(ref(database, `${STYLE_CODE_INDEX_PATH}/${normalised}/productId`));
      const winner = snap.exists() ? snap.val() : null;
      if (typeof winner === "string" && winner) {
        return { kind: CLAIM_TAKEN, normalised, productId: winner, readable: true };
      }
      // Nothing there, yet the write was refused — that is a permission problem,
      // not a collision. Do not dress it up as one.
      return { kind: CLAIM_FAILED, normalised, error: err };
    } catch (readErr) {
      void readErr;
      return { kind: CLAIM_TAKEN, normalised, productId: null, readable: false };
    }
  }
}

/**
 * Read the current claim without attempting one. Used by the intake gate to
 * show "this code is already on a product" BEFORE the operator fills a form in.
 * A read failure returns null — the claim attempt is the authority, this is a
 * courtesy.
 */
export async function readStyleCodeClaim(code) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return null;
  try {
    const snap = await get(ref(database, `${STYLE_CODE_INDEX_PATH}/${normalised}`));
    const val = snap.exists() ? snap.val() : null;
    if (!val || typeof val.productId !== "string" || !val.productId) return null;
    return { productId: val.productId, claimedAt: Number(val.claimedAt) || null, claimedBy: val.claimedBy || null };
  } catch {
    return null;
  }
}

/**
 * Message for a claim outcome that is not a win. Written for a person on a shop
 * floor holding a shoe, not for a developer reading a stack trace.
 */
export function claimFailureMessage(outcome) {
  if (!outcome) return "Could not check this style code. Try again.";
  if (outcome.kind === CLAIM_TAKEN) {
    return outcome.productId
      ? "This style code is already on another product. Add stock to that product instead of creating a new one."
      : "This style code is already taken by another product, but that product could not be read. Ask an admin to check it.";
  }
  // CLAIM_FAILED — most often no stockRole. Say the likely cause; a bare
  // "permission denied" leaves a staff member with nothing to act on.
  return "Could not reserve this style code — you may not have stock permission. " +
    "Nothing was saved. Ask an admin to add the product, or try again.";
}

// ─── STYLE-CODE ORPHANS — WHEN A CLAIM'S OWNERS ARE GONE ─────────────────────
// A /style_code_index claim outlives its product when the product is deleted.
// The code then looks taken and nothing owns it. This module decides what such a
// claim is and, when it is truly dead, releases it. resolveStyleCode calls it on
// the way through a lookup; scripts/sweep-style-code-orphans.mjs calls it for
// every claim. One rule, two callers.
//
//   primary live                        leave alone
//   primary merged away                 answer with the survivor, write nothing
//   every owner absent from /products   DEAD: release and log
//   primary absent, a sibling lives     keep the claim, answer with live owners
//   redirect that dangles or loops      keep the claim, report it
//
// A record that exists is never dead, whatever it says about itself: a hidden or
// deactivated product is a flag on its /products row, and that row still exists.
//
// READS ONE PRODUCT AT A TIME, never /products. Existence is the whole record's,
// not one field's: probing /products/{id}/id would call a legacy row with no
// `id` child dead and detach a real product from its code.

"use strict";

const { claimOwnerIds } = require("./style-code-siblings.cjs");

const STYLE_CODE_INDEX_PATH = "style_code_index";
const STYLE_CODE_ORPHANS_PATH = "style_code_orphans";

const CLAIM_LIVE = "live";
const CLAIM_REDIRECTED = "redirected";
const CLAIM_DEAD = "dead";
const CLAIM_SIBLINGS_ONLY = "siblings-only";
const CLAIM_UNRESOLVED = "unresolved";

/**
 * What answers for this product id today? Follows `mergedInto` the way
 * src/utils/mergedProducts.followMerge does, with the same cycle guard.
 *
 * A read error propagates: "could not tell" must never read as "does not exist".
 *
 * @returns {{state:"live"|"merged", id:string}|{state:"dead"}|{state:"unresolved", reason:string}}
 */
async function resolveOwner(db, startId) {
  const seen = new Set();
  let id = String(startId);
  for (;;) {
    if (seen.has(id)) return { state: "unresolved", reason: "merge-cycle" };
    seen.add(id);
    const record = (await db.ref(`products/${id}`).get()).val();
    if (!record) {
      return seen.size === 1 ? { state: "dead" } : { state: "unresolved", reason: "merge-dangling" };
    }
    if (!record.mergedInto) return { state: seen.size === 1 ? "live" : "merged", id };
    id = String(record.mergedInto);
  }
}

/**
 * @param {object} node  the raw /style_code_index/{code} value
 * @returns {{kind:string, owners:string[], reason?:string}} `owners` is who
 *   answers for the code, primary first. Empty for a dead or unresolved claim.
 */
async function inspectClaim(db, node) {
  const ids = claimOwnerIds(node);
  if (!ids.length) return { kind: CLAIM_UNRESOLVED, owners: [], reason: "no-owners" };

  const primary = await resolveOwner(db, ids[0]);
  if (primary.state === "live") return { kind: CLAIM_LIVE, owners: ids };

  const resolved = [primary, ...(await Promise.all(ids.slice(1).map((id) => resolveOwner(db, id))))];
  const answering = [...new Set(resolved.filter((r) => r.id).map((r) => r.id))];

  if (primary.state === "merged") return { kind: CLAIM_REDIRECTED, owners: answering };
  if (primary.state === "unresolved") return { kind: CLAIM_UNRESOLVED, owners: [], reason: primary.reason };

  // The primary is gone. The claim is dead only if nothing else answers for it.
  if (answering.length) return { kind: CLAIM_SIBLINGS_ONLY, owners: answering };
  const unsure = resolved.find((r) => r.state === "unresolved");
  if (unsure) return { kind: CLAIM_UNRESOLVED, owners: [], reason: unsure.reason };
  return { kind: CLAIM_DEAD, owners: [] };
}

function sameClaim(a, b) {
  const sibs = (c) => Object.keys((c && c.siblings) || {}).sort().join(",");
  return !!a && !!b && a.productId === b.productId && sibs(a) === sibs(b);
}

/**
 * Release a claim already judged dead, and log it.
 *
 * THE LOG GOES FIRST. There is no atomic write across "compare this claim" and
 * "record the release", so one of them has to come first, and the failure each
 * order leaves is different: log-first can leave a record of a release that did
 * not happen, which the next lookup repeats; release-first can leave a release
 * with no record, which is the one thing that must not happen.
 *
 * A TRANSACTION, because the claim can change between the read and now (a
 * sibling registered, a merge repointing it). Only the claim that was judged is
 * removed. It must answer null to a null first pass: the Admin SDK runs the
 * update against its empty local cache first, and returning anything else there
 * would abort without ever seeing the server value.
 *
 * @returns {Promise<{released:boolean}>} released:false when the claim changed.
 *   Rejects when the log or the release could not be written.
 */
async function releaseDeadClaim(db, { code, node, releasedBy, nowMs, source }) {
  const logRef = db.ref(`${STYLE_CODE_ORPHANS_PATH}/${code}`);
  const prior = (await logRef.get()).val();

  const record = { productId: node.productId, releasedAt: nowMs, releasedBy, source };
  if (node.claimedAt != null) record.claimedAt = node.claimedAt;
  if (node.claimedBy != null) record.claimedBy = node.claimedBy;
  if (node.siblings != null) record.siblings = node.siblings;
  if (prior) {
    record.previous = {
      productId: prior.productId || null,
      releasedAt: prior.releasedAt || null,
      releasedBy: prior.releasedBy || null,
    };
  }
  await logRef.set(record);

  // A rejected transaction leaves the outcome unknown, so the log stays: a
  // record of a release that did not happen is the harmless way round.
  const result = await db.ref(`${STYLE_CODE_INDEX_PATH}/${code}`).transaction((current) => {
    if (current === null) return null;
    return sameClaim(current, node) ? null : undefined;
  });

  if (!result.committed) {
    try {
      await logRef.set(prior);
    } catch (err) {
      console.warn(`style-code-orphans: could not withdraw the log for ${code}:`, err && err.message);
    }
    return { released: false };
  }

  console.warn(`style-code-orphans: RELEASED dead claim ${code} (was ${node.productId}) by ${releasedBy} via ${source}`);
  return { released: true };
}

/**
 * Apply the rule to a list of codes. Read-only unless `apply` is exactly true.
 * One bad claim never stops the sweep: it lands in `failed` and the walk goes on.
 */
async function sweepOrphanClaims(db, { codes, apply = false, releasedBy, nowMs, concurrency = 8 }) {
  const report = {
    applied: apply === true,
    scanned: codes.length,
    live: 0,
    redirected: [],
    dead: [],
    released: [],
    siblingsOnly: [],
    unresolved: [],
    malformed: [],
    changed: [],
    failed: [],
  };

  const handle = async (code) => {
    try {
      const node = (await db.ref(`${STYLE_CODE_INDEX_PATH}/${code}`).get()).val();
      if (!node || typeof node.productId !== "string" || !node.productId) {
        report.malformed.push(code);
        return;
      }
      const verdict = await inspectClaim(db, node);
      const row = { code, productId: node.productId, owners: verdict.owners };
      switch (verdict.kind) {
        case CLAIM_LIVE: report.live += 1; return;
        case CLAIM_REDIRECTED: report.redirected.push(row); return;
        case CLAIM_SIBLINGS_ONLY: report.siblingsOnly.push(row); return;
        case CLAIM_UNRESOLVED: report.unresolved.push({ ...row, reason: verdict.reason }); return;
        default:
      }
      report.dead.push(row);
      if (apply !== true) return;
      const { released } = await releaseDeadClaim(db, { code, node, releasedBy, nowMs, source: "sweep" });
      (released ? report.released : report.changed).push(row);
    } catch (err) {
      report.failed.push({ code, error: (err && err.message) || String(err) });
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < codes.length) await handle(codes[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return report;
}

module.exports = {
  STYLE_CODE_ORPHANS_PATH,
  CLAIM_LIVE,
  CLAIM_REDIRECTED,
  CLAIM_DEAD,
  CLAIM_SIBLINGS_ONLY,
  CLAIM_UNRESOLVED,
  resolveOwner,
  inspectClaim,
  releaseDeadClaim,
  sweepOrphanClaims,
};

// ─── DEPLOY PREFLIGHT — the decisions, pure ─────────────────────────────────
//
// Everything the preflight decides lives here, with no git, no network and no
// process.exit, so `node --test` can drive every combination — including the
// ones that are painful to stage for real (a live build from an unpushed
// commit, a rollback, an acknowledged outage).
//
// scripts/deploy-preflight.mjs is the plumbing: it gathers the facts and prints
// the answers. It is wired as a `predeploy` hook in firebase.json, so the
// Firebase CLI runs it before hosting AND before functions, and a non-zero exit
// aborts the deploy.
//
// ── WHY EACH REFUSAL IS A REFUSAL AND NOT A WARNING ─────────────────────────
// This repo has ~150 git worktrees on one clone. Every one of these failures is
// SILENT: the deploy succeeds, the output says nothing is wrong, and merged
// work quietly leaves production. A warning in that output is a warning nobody
// reads at the moment it matters.

/** The order matters: the earliest refusal is the one reported, and they are
 *  ordered by how badly the deploy would go wrong, worst first. */
export const REFUSAL = Object.freeze({
  DIRTY: "dirty",
  BEHIND_MAIN: "behind_main",
  NO_LIVE: "no_live",
  LIVE_UNKNOWN: "live_unknown",
  ROLLBACK: "rollback",
});

/**
 * @param facts.dirty        git status --porcelain output ("" when clean)
 * @param facts.behindMain   how many commits origin/main has that HEAD lacks
 * @param facts.liveSha      the sha from /version.json, or null when unreadable
 * @param facts.liveKnown    whether this checkout contains that commit
 * @param facts.behindLive   how many commits the LIVE build has that HEAD lacks
 * @param facts.ackNoLive    the DEPLOY_PREFLIGHT_ACK_NO_LIVE escape hatch
 * @param facts.functionsOnly  a functions deploy: hosting liveness is not its subject
 * → { ok: true } | { ok: false, refusal }
 */
export function preflightDecision(facts = {}) {
  const {
    dirty = "", behindMain = 0, liveSha = null, liveKnown = true,
    behindLive = 0, ackNoLive = false, functionsOnly = false,
  } = facts;

  // 1. A dirty deploy cannot be reproduced, reverted or reasoned about. No
  //    override: this one is cheap to fix and expensive to have shipped.
  if (String(dirty).trim()) return { ok: false, refusal: REFUSAL.DIRTY };

  // 2. The stale-checkout failure. No override either — it is THE failure this
  //    exists to stop, and an override that exists is an override that is used.
  if (Number(behindMain) > 0) return { ok: false, refusal: REFUSAL.BEHIND_MAIN };

  // A functions deploy is past its subject here: /version.json describes the
  // hosting bundle and says nothing about which code a function is running.
  // The two git invariants above still applied, and they are the load-bearing
  // ones.
  if (functionsOnly) return { ok: true };

  // 3. Liveness unreadable. The carry-list is the point of the check, so this
  //    refuses — but it is the ONE case with an escape hatch, because a site
  //    outage must not wedge deploys forever.
  if (!liveSha) {
    return ackNoLive ? { ok: true, liveUnverified: true } : { ok: false, refusal: REFUSAL.NO_LIVE };
  }

  // 4. The live build's commit is not in this repository, so any carry-list
  //    would be fiction. The ack does NOT cover this: an unknown live build is
  //    a sign the deployer is in the wrong repository, which is worse than an
  //    outage, not milder.
  if (!liveKnown) return { ok: false, refusal: REFUSAL.LIVE_UNKNOWN };

  // 5. The live build is AHEAD of this checkout: deploying rolls production
  //    backwards. Distinct from behind-main — main can be current while somebody
  //    deployed from a commit that never merged.
  if (Number(behindLive) > 0) return { ok: false, refusal: REFUSAL.ROLLBACK };

  return { ok: true };
}

/** The short sha a /version.json `version` names, or null.
 *  The field is `<short-sha>.<epoch-millis>` — vite writes it, hosting serves it
 *  no-cache, and it is the only trustworthy statement of what is live. Bundle
 *  FILENAME hashes are not: they differ between machines for identical source
 *  (measured 2026-09-08 — two builds of one commit, 58 bytes apart, and the 58
 *  bytes were this very stamp). */
export function liveShaFrom(versionJson) {
  const v = versionJson && typeof versionJson === "object" ? versionJson.version : null;
  if (typeof v !== "string" || !v) return null;
  const sha = v.split(".")[0];
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

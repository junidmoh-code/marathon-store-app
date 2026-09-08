#!/usr/bin/env node
// ─── DEPLOY PREFLIGHT — the deploy REFUSES, it does not warn ─────────────────
//
// (Owner directive, 2026-09-08.) This repo has ~150 git worktrees on one clone.
// A person deploying from whichever directory their terminal happens to be in
// is one `cd` away from shipping a tree that is behind main, or one that has
// uncommitted edits in it — and the result is a silent REGRESSION: work that is
// merged and believed live quietly disappears from production, and nothing in
// the deploy output says so.
//
// So this blocks. It is wired as a `predeploy` hook in firebase.json, which the
// Firebase CLI runs before hosting and before functions, and a non-zero exit
// ABORTS the deploy. Nobody has to remember to run it; there is no deploy route
// through the CLI that skips it.
//
// ── THE THREE HARD REFUSALS ─────────────────────────────────────────────────
//   1. DIRTY TREE      — uncommitted or untracked changes. What you deploy must
//                        be something the repo can name. A dirty deploy cannot
//                        be reproduced, reverted or reasoned about later.
//   2. BEHIND main     — HEAD is missing commits that are on origin/main. This
//                        is the stale-checkout case, and it is the one that
//                        silently un-ships other people's merged work.
//   3. DETACHED/UNKNOWN— HEAD is not an ancestor-complete view: origin/main
//                        could not be resolved at all. Refuse rather than guess.
//
// ── AND ONE REPORT, ALWAYS PRINTED ──────────────────────────────────────────
// Every commit the deploy would carry beyond the CURRENTLY LIVE build, named.
// Liveness comes from https://<site>/version.json, which vite already emits and
// hosting already serves `no-cache` — it carries `<short-sha>.<epoch>`, so the
// live commit is a fact to be read, not a guess from bundle hashes. (Bundle
// hashes are NOT stable across machines here; a build-stamp sha is.)
//
// ── THE ONE ESCAPE HATCH, AND WHY IT IS NARROW ──────────────────────────────
// If version.json cannot be fetched (network, an outage, a first-ever deploy)
// the carry-list cannot be computed. That alone must not wedge a deploy
// forever, so it may be acknowledged with:
//
//     DEPLOY_PREFLIGHT_ACK_NO_LIVE=1 firebase deploy --only hosting:marathon-club
//
// It covers ONLY the unreachable-liveness case. A dirty tree and a behind-main
// checkout have NO override — those are the two that cause the harm, and an
// override that exists is an override that gets used.
//
// Usage (also runnable by hand):
//     node scripts/deploy-preflight.mjs            # hosting + git checks
//     node scripts/deploy-preflight.mjs --functions # git checks only

import { execSync } from "node:child_process";
import { preflightDecision, liveShaFrom, REFUSAL } from "./lib/deployPreflightCore.mjs";

const VERSION_URL = "https://marathon-club.web.app/version.json";
const FUNCTIONS_ONLY = process.argv.includes("--functions");

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function die(title, lines) {
  console.error("");
  console.error(red(bold(`  ✗ DEPLOY REFUSED — ${title}`)));
  console.error("");
  for (const l of lines) console.error(`    ${l}`);
  console.error("");
  process.exit(1);
}

console.log("");
console.log(bold("  ── deploy preflight ──────────────────────────────────────"));
console.log(`  cwd    ${process.cwd()}`);

// ── 1. Which tree is this, and is it clean? ─────────────────────────────────
let head, branch, dirty;
try {
  head = sh("git rev-parse HEAD");
  branch = sh("git rev-parse --abbrev-ref HEAD");
  dirty = sh("git status --porcelain");
} catch (err) {
  die("this is not a git checkout", [String(err.message || err)]);
}
console.log(`  head   ${head.slice(0, 8)} (${branch})`);

if (preflightDecision({ dirty }).refusal === REFUSAL.DIRTY) {
  const files = dirty.split("\n").slice(0, 20);
  die("the working tree is dirty", [
    "Uncommitted or untracked changes are present. A deploy from a dirty tree",
    "cannot be reproduced, reverted, or reasoned about after the fact.",
    "",
    ...files.map((f) => `  ${f}`),
    dirty.split("\n").length > 20 ? `  …and ${dirty.split("\n").length - 20} more` : "",
    "",
    "Commit them, or stash them with an explicit tag, then deploy again.",
  ].filter(Boolean));
}
console.log(`  tree   ${green("clean")}`);

// ── 2. Is this checkout BEHIND origin/main? ─────────────────────────────────
// The fetch is part of the check, not a courtesy: a stale remote ref would let
// a stale checkout pass, which is exactly the failure this exists to stop.
try {
  execSync("git fetch --quiet origin main", { stdio: ["ignore", "pipe", "pipe"] });
} catch (err) {
  die("origin/main could not be fetched", [
    "The preflight cannot prove this checkout is current, so it refuses.",
    String(err.message || err).split("\n")[0],
  ]);
}

let behind;
try {
  behind = sh("git rev-list --count HEAD..origin/main");
} catch (err) {
  die("origin/main could not be resolved", [String(err.message || err)]);
}

if (preflightDecision({ behindMain: Number(behind) }).refusal === REFUSAL.BEHIND_MAIN) {
  const missing = sh("git log --oneline HEAD..origin/main --format='  %h  %s'").split("\n");
  die(`this checkout is ${behind} commit(s) BEHIND origin/main`, [
    "Deploying it would UN-SHIP work that is already merged and believed live.",
    "This is the stale-checkout failure, and it is silent — the deploy would",
    "succeed and the regression would not appear in its output.",
    "",
    bold("    Missing from this checkout:"),
    ...missing,
    "",
    "Run:  git fetch origin && git merge origin/main    (or deploy from a",
    "checkout that is current), then deploy again.",
  ]);
}
console.log(`  vs main ${green("up to date")}`);

// ── 3. What would this deploy actually carry? ───────────────────────────────
if (FUNCTIONS_ONLY) {
  console.log(`  scope  functions (liveness of a function is not readable from version.json)`);
  console.log(green(bold("  ✓ preflight passed")));
  console.log("");
  process.exit(0);
}

let liveSha = null;
try {
  const res = await fetch(VERSION_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  liveSha = liveShaFrom(await res.json());
  if (!liveSha) throw new Error(`no usable build stamp in ${VERSION_URL}`);
} catch (err) {
  if (preflightDecision({ liveSha: null, ackNoLive: !!process.env.DEPLOY_PREFLIGHT_ACK_NO_LIVE }).refusal === REFUSAL.NO_LIVE) {
    die("the currently live build could not be read", [
      `${VERSION_URL} — ${String(err.message || err)}`,
      "",
      "Without it the preflight cannot list what this deploy would carry, and",
      "that list is the point of the check.",
      "",
      "If the site is genuinely unreachable and you still need to deploy:",
      bold("    DEPLOY_PREFLIGHT_ACK_NO_LIVE=1 <your deploy command>"),
      "",
      "That override covers ONLY this check. A dirty tree and a behind-main",
      "checkout cannot be overridden at all.",
    ]);
  }
  console.log(yellow(`  live   UNKNOWN — ${String(err.message || err)} (acknowledged)`));
  console.log(green(bold("  ✓ preflight passed (liveness unverified, by explicit acknowledgement)")));
  console.log("");
  process.exit(0);
}

console.log(`  live   ${liveSha}`);

// The live sha must be an object this checkout knows, or the carry-list is a
// fiction. A shallow clone or a live build from an unpushed commit lands here.
let known = true;
try { sh(`git cat-file -e ${liveSha}^{commit}`); } catch { known = false; }

if (preflightDecision({ liveSha, liveKnown: known }).refusal === REFUSAL.LIVE_UNKNOWN) {
  die("the live build's commit is unknown to this checkout", [
    `The site reports it is running ${liveSha}, which this repository does not`,
    "contain. Either the live build came from an unpushed commit, or this is",
    "not the repository that produced it.",
    "",
    "Deploying would overwrite a build whose contents cannot be diffed.",
    "Run:  git fetch --all    and look at what is live before continuing.",
  ]);
}

const carry = sh(`git log --oneline ${liveSha}..HEAD --format='  %h  %s'`);
console.log("");
if (!carry) {
  console.log(bold("  This deploy carries NOTHING beyond the live build — it is a rebuild."));
} else {
  const n = carry.split("\n").length;
  console.log(bold(`  This deploy carries ${n} commit(s) beyond the live build (${liveSha}):`));
  console.log(carry);
}

// Behind-live is its own alarm: the live site is AHEAD of this checkout, which
// means somebody deployed something this tree has never seen.
const behindLive = sh(`git rev-list --count HEAD..${liveSha}`);
if (preflightDecision({ liveSha, behindLive: Number(behindLive) }).refusal === REFUSAL.ROLLBACK) {
  const lost = sh(`git log --oneline HEAD..${liveSha} --format='  %h  %s'`);
  die(`the LIVE build is ${behindLive} commit(s) ahead of this checkout`, [
    "Deploying would roll production BACKWARDS. These are live and would go:",
    "",
    lost,
  ]);
}

console.log("");
console.log(green(bold("  ✓ preflight passed")));
console.log("");

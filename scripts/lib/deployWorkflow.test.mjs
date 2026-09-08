// ─── THE CI DEPLOY ROUTE — pinned, because the preflight cannot guard it ────
//
// Two deploy routes exist for hosting:
//
//   1. A HUMAN running `firebase deploy`. Guarded by the predeploy hooks in
//      firebase.json, which the Firebase CLI runs and which abort on a non-zero
//      exit (scripts/deploy-preflight.mjs).
//   2. .github/workflows/deploy.yml on every push to main. It uses
//      FirebaseExtended/action-hosting-deploy, which talks to the Hosting API
//      directly — it does NOT invoke the Firebase CLI, so it does NOT run
//      predeploy hooks. The preflight cannot reach it.
//
// Route 2 does not NEED the preflight, and that is a property of its shape
// rather than luck: `actions/checkout@v4` with no `ref:` checks out exactly the
// commit that was pushed, into a fresh runner, and builds it there. Such a
// checkout can never be behind main (it IS main) and can never be dirty.
//
// That property is one line away from being lost — a `ref:` pinning a branch, a
// `fetch-depth` change, or a build step reading from somewhere else — and if it
// were lost the failure would be the silent one this whole guard exists to
// stop. So it is asserted here rather than assumed.
//
// ── AND THE ROUTE IS CURRENTLY BROKEN ───────────────────────────────────────
// Measured 2026-09-08: THIRTY of thirty runs have failed, every one at the
// deploy step, back to 2026-08-30 —
//     Error: Input required and not supplied: firebaseServiceAccount
// The FIREBASE_SERVICE_ACCOUNT repository secret is not set. So every merge to
// main since then has produced a red run that deployed nothing, and every live
// deploy has in fact been a manual one. That is exactly why the preflight is
// worth having on the human route: the human route is the ONLY route.
//
// A test cannot fix a missing secret. It can make sure the workflow still has
// the shape that makes it safe on the day the secret is added.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const WF_RAW = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

// COMMENTS STRIPPED BEFORE MATCHING. The workflow's own header spells out the
// commands it must never gain — "must never gain a `firebase deploy --only
// functions`" — so matching the raw file finds the PROHIBITION and calls it a
// breach. Caught the moment these tests first ran, which is the third time on
// this work that an assertion read a comment instead of the thing it names.
const WF = WF_RAW.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");

describe("the CI deploy builds exactly the pushed commit", () => {
  it("checkout takes no `ref:` — the runner builds what was pushed, so it cannot be stale", () => {
    const checkout = WF.slice(WF.indexOf("actions/checkout"), WF.indexOf("actions/setup-node"));
    expect(checkout).not.toMatch(/\bref:/);
  });

  it("it builds in the runner rather than deploying a dist from anywhere else", () => {
    expect(WF).toMatch(/- run: npm ci/);
    expect(WF).toMatch(/- run: npm run build/);
    // the build must come BEFORE the deploy action, or it ships a stale dist
    expect(WF.indexOf("npm run build")).toBeLessThan(WF.indexOf("action-hosting-deploy"));
  });

  it("it fires on main only", () => {
    expect(WF).toMatch(/branches:\s*\[main\]/);
  });
});

describe("the CI deploy stays HOSTING-only", () => {
  it("never deploys functions — they are shared with marathon-pos-app", () => {
    // A bare functions deploy from this repo offers to DELETE the POS app's
    // functions. The workflow's own header says this must never be added; this
    // is that sentence made enforceable.
    expect(WF).not.toMatch(/--only\s+functions/);
    expect(WF).not.toMatch(/only:\s*functions/);
  });

  it("never deploys database rules from CI", () => {
    expect(WF).not.toMatch(/--only\s+database/);
    expect(WF).not.toMatch(/database\.rules/);
  });

  it("targets the live channel of marathon-club, explicitly", () => {
    expect(WF).toMatch(/projectId:\s*marathon-club/);
    expect(WF).toMatch(/channelId:\s*live/);
  });
});

// ─── THE DATABASE TARGET IS REFUSED, NOT PREFLIGHTED ────────────────────────
//
// `firebase deploy --only database` is always wrong from this repository: the
// live rules are console-managed and database.rules.json is a stale copy, so
// deploying it REPLACES the live document and deletes every node the copy has
// never heard of.
//
// The preflight was wired here first, which closed a real gap (the target had
// no check at all) and introduced a worse one: "✓ preflight passed" printed
// immediately before a known-destructive deploy reads as sanction. (CodeRabbit.)
describe("the database target refuses outright", () => {
  const FB = JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url), "utf8"));

  it("its predeploy is the refusal, never the preflight", () => {
    const hook = (FB.database.predeploy || []).join(" ");
    expect(hook).toMatch(/refuse-database-deploy/);
    expect(hook).not.toMatch(/deploy-preflight/);
  });

  it("storage keeps the ordinary git preflight — it has no such divergence", () => {
    const hook = (FB.storage.predeploy || []).join(" ");
    expect(hook).toMatch(/deploy-preflight\.mjs --git-only/);
    expect(hook).not.toMatch(/refuse-database-deploy/);
  });

  it("hosting and functions keep theirs too", () => {
    expect((FB.hosting.predeploy || []).join(" ")).toMatch(/deploy-preflight\.mjs/);
    expect((FB.functions[0].predeploy || []).join(" ")).toMatch(/deploy-preflight\.mjs --git-only/);
  });

  it("every deployable target has SOME predeploy hook — none may be added without one", () => {
    // The original defect was a target declared with no hook at all.
    expect(FB.database.predeploy?.length).toBeGreaterThan(0);
    expect(FB.storage.predeploy?.length).toBeGreaterThan(0);
    expect(FB.hosting.predeploy?.length).toBeGreaterThan(0);
    expect(FB.functions[0].predeploy?.length).toBeGreaterThan(0);
    // and the set of top-level deployable keys is the set we have covered
    expect(Object.keys(FB).sort()).toEqual(["database", "functions", "hosting", "storage"]);
  });
});

// ── THE SOCIAL PUBLISHER ─────────────────────────────────────────────────────
// The only program in this repository that posts to Instagram, Facebook or
// TikTok. It runs on the Mac mini beside the Shopify reconciler, on the same
// launchd pattern, and it is the far end of every rule the queue enforces.
//
//   node scripts/social/publish.mjs              post everything due
//   node scripts/social/publish.mjs --dry-run    say what it WOULD post
//   node scripts/social/publish.mjs --status     credentials + what is queued
//
// ── APPROVAL IS CHECKED HERE, NOT ONLY IN THE APP ────────────────────────────
// The queue greys out its Approve button, and that is a courtesy. THIS is the
// gate: postBlocker() from src/components/social/socialCore.js is called on
// every item immediately before the first platform call, on the machine that
// does the posting, with requireDue set. A record hand-edited in the console,
// a replayed old node, a bug in the app that wrote the wrong status — none of
// them reach a platform, because none of them can get past a function that
// refuses anything whose status is not "approved".
//
// ── A FAILED POST IS LOUD, AND IT COMES BACK ─────────────────────────────────
// Nothing is ever silently dropped. Every attempt is recorded per platform on
// the post itself (results.{platform} = { state, attempts, error, at }) and in
// the rotated log with the word FAILED. A retryable failure — Meta 5xx, a rate
// limit, a container still transcoding — is left approved and outstanding, so
// the next run picks it up. A permanent one (a revoked token, an image Meta
// will not accept) is counted too, and after MAX_ATTEMPTS the whole post moves
// to "failed", where the queue shows it in red with the last error. Retrying a
// revoked token four times would just be four identical lines in a log.
//
// ── PARTIAL SUCCESS IS A REAL STATE ──────────────────────────────────────────
// A post going to three platforms can succeed on two. Each platform's result
// is written the moment it lands, so a crash between Instagram and Facebook
// cannot cause Instagram to be posted twice: the next run sees results.instagram
// = ok and skips it. `outstandingPlatforms()` is what drives the loop, not a
// blanket "has this post been sent".
//
// ── THE CLAIM ────────────────────────────────────────────────────────────────
// Before posting, the item is claimed with a transaction that flips
// approved → posting. Two runners can never both post the same item; the loser
// sees the status already changed and moves on. As everywhere in this project,
// the transaction's FIRST attempt may see null on a cold cache — that is not a
// refusal and must not abort the claim.
import { createRequire } from "module";
import {
  postBlocker, outstandingPlatforms, attemptsExhausted, captionFor,
  MAX_ATTEMPTS, describePost, formatSlot,
} from "../../src/components/social/socialCore.js";
import { readSecret, credentialStatus } from "./secrets.mjs";
import { publishInstagram, publishFacebook, metaPreflight } from "./meta.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const flags = process.argv.slice(2);
const DRY_RUN = flags.includes("--dry-run");
const STATUS_ONLY = flags.includes("--status");
// How many due items one run posts. Three a week means this is never reached;
// it is a bound against a queue that somehow filled up, so one run cannot spend
// an hour posting forty things to a live Instagram account.
const MAX_PER_RUN = 6;

admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const POSTS = "social_posts";
const log = (...a) => console.log(...a);

/** Everything approved, newest first. One bounded indexed query — never the node. */
async function loadApproved() {
  const snap = await db.ref(POSTS).orderByChild("status").equalTo("approved").limitToLast(100).once("value");
  return Object.entries(snap.val() || {})
    .map(([id, body]) => ({ id, ...body }))
    .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
}

/**
 * Claim one post for this run: approved → posting, atomically.
 *
 * COLD-CACHE NULL: a transaction's first attempt is routinely handed null
 * because the client has not cached the node yet. Returning `undefined` (abort)
 * on that first null would make every cold claim fail, which is the exact bug
 * this project has hit before. So null ABORTS ONLY when the node has genuinely
 * gone (checked with a read afterwards, via the committed/snapshot pair) —
 * here it simply retries by returning the same value, and the post-transaction
 * snapshot decides.
 */
async function claim(postId) {
  const ref = db.ref(`${POSTS}/${postId}/status`);
  const res = await ref.transaction((cur) => {
    if (cur === null) return null;          // cold cache — let Firebase re-run with the real value
    if (cur !== "approved") return undefined; // somebody else has it, or it was un-approved
    return "posting";
  });
  // committed with a value of "posting" is the only outcome that means WE won.
  return res.committed && res.snapshot.val() === "posting";
}

/** Record one platform's outcome. Merge-only: never clobbers a sibling result. */
async function recordResult(postId, platformKey, patch) {
  const ref = db.ref(`${POSTS}/${postId}/results/${platformKey}`);
  const prev = (await ref.once("value")).val() || {};
  await ref.update({
    ...patch,
    attempts: Number(prev.attempts || 0) + (patch.state === "ok" ? 0 : 1),
    at: Date.now(),
  });
}

async function setStatus(postId, status, extra = {}) {
  await db.ref(`${POSTS}/${postId}`).update({
    status, ...extra, updatedAt: Date.now(), updatedBy: "script:social-publish",
  });
}

// ── PLATFORM DISPATCH ────────────────────────────────────────────────────────
// Each returns { ok, id, permalink } or throws. A thrown error carries
// `.retryable` when it is worth trying again on the next run.

/**
 * "Missing" and "we were refused" are different states and the log must say
 * which. A missing secret means Junid has not run the setup; a refusal means
 * the machine cannot reach Secret Manager, and telling him to re-run the setup
 * would send him down the wrong path entirely.
 */
function credentialProblem(creds, names) {
  const hits = names.map((n) => creds.problems?.[n]).filter(Boolean);
  if (!hits.length) return null;
  return `Secret Manager could not be read (${hits[0]}). This is not a missing setup — the credentials may well be there.`;
}

async function sendInstagram(post, creds) {
  if (!creds.token || !creds.igUserId) {
    const why = credentialProblem(creds, ["meta-page-access-token", "meta-ig-user-id"]);
    const e = new Error(why || "Instagram is not connected — no Meta token or Instagram account id in Secret Manager. Run scripts/social/meta-token.mjs.");
    e.notConnected = true;
    throw e;
  }
  const { caption } = captionFor(post, "instagram");
  return publishInstagram({ igUserId: creds.igUserId, token: creds.token, media: post.media, caption });
}

async function sendFacebook(post, creds) {
  if (!creds.token || !creds.pageId) {
    const why = credentialProblem(creds, ["meta-page-access-token", "meta-page-id"]);
    const e = new Error(why || "Facebook is not connected — no Meta token or Page id in Secret Manager. Run scripts/social/meta-token.mjs.");
    e.notConnected = true;
    throw e;
  }
  const { caption } = captionFor(post, "facebook");
  return publishFacebook({ pageId: creds.pageId, token: creds.token, media: post.media, caption });
}

// ── TIKTOK ───────────────────────────────────────────────────────────────────
// TikTok is NOT posted by this program, and pretending otherwise would be the
// dishonest option. Two real routes exist and neither is available to an
// unattended launchd job today:
//
//   · The Higgsfield connection can publish to TikTok, but only through the
//     Higgsfield MCP tools inside a Claude session — there is no HTTP endpoint
//     this script can call — AND no TikTok account is connected to that
//     workspace yet (checked 2026-08-22: tiktok_accounts returned none).
//     Connecting one is a browser step Junid does once.
//
//   · TikTok's own Content Posting API would let this script post directly,
//     but the video.publish scope requires a TikTok for Developers app that
//     has passed audit. That is an approval process with a real review, not a
//     credential to paste.
//
// So an approved post with TikTok switched on is recorded as SKIPPED with the
// reason, on every run, and it stays visible in the queue. It is not counted
// as a failure (nothing is broken) and it does not consume the post's retries.
// scripts/social/tiktok-handoff.mjs lists exactly what is waiting, so it can be
// published from a Claude session in the meantime.
async function sendTikTok(post, creds) {
  if (creds.tiktokToken) {
    const e = new Error("a TikTok token is present but direct posting is not built — see the header of scripts/social/publish.mjs");
    e.notConnected = true;
    throw e;
  }
  const e = new Error("TikTok is not connected yet — run scripts/social/tiktok-handoff.mjs to publish it from a Claude session, or connect TikTok in Higgsfield.");
  e.notConnected = true;
  throw e;
}

const SENDERS = { instagram: sendInstagram, facebook: sendFacebook, tiktok: sendTikTok };

// ── READING A CREDENTIAL MUST NOT KILL THE RUN ───────────────────────────────
// readSecret throws when Secret Manager REFUSES us (a missing
// secretAccessor role, an outage, a disabled billing account) as opposed to
// when a secret merely does not exist. Letting that propagate had two bad
// consequences, both found by running this against production:
//
//   · `--status`, whose entire job is to say what is and is not connected,
//     died before printing anything.
//   · A run whose queue needed nothing from Meta — everything already posted,
//     or waiting on TikTok — was killed by a Meta credential it was never
//     going to use.
//
// So a refusal is captured, not thrown. The affected platform reports itself
// as not connected WITH the reason, which is louder and more useful than a
// stack trace, and the rest of the run proceeds.
async function readCredential(name, problems) {
  try {
    return await readSecret(name);
  } catch (err) {
    problems[name] = String(err?.message || err);
    return null;
  }
}

async function main() {
  const credProblems = {};
  const creds = {
    token: await readCredential("meta-page-access-token", credProblems),
    pageId: await readCredential("meta-page-id", credProblems),
    igUserId: await readCredential("meta-ig-user-id", credProblems),
    tiktokToken: await readCredential("tiktok-access-token", credProblems),
  };
  creds.problems = credProblems;
  for (const [name, why] of Object.entries(credProblems)) {
    log(`⚠ could not read ${name}: ${why}`);
  }

  if (STATUS_ONLY) {
    let status;
    try { status = await credentialStatus(); }
    catch (err) { status = { error: String(err?.message || err) }; }
    log("credentials:", JSON.stringify(status, null, 2));
    const approved = await loadApproved();
    log(`\n${approved.length} approved post(s):`);
    for (const p of approved) {
      log(`  ${p.id}  ${describePost(p)}  due ${formatSlot(p.scheduledAt)}  ${postBlocker(p, { requireDue: true }) || "DUE NOW"}`);
    }
    return 0;
  }

  // A read-only preflight, so a revoked token is one clear line at the top of
  // the log rather than an identical failure on every post below it. It is NOT
  // fatal: TikTok-only posts and dry runs do not need Meta at all.
  if (creds.token && creds.pageId) {
    try {
      const pf = await metaPreflight({ token: creds.token, pageId: creds.pageId, igUserId: creds.igUserId });
      log(`meta: ready — Page "${pf.page}", Instagram ${pf.instagram || "not connected to this Page"}`);
    } catch (err) {
      log(`meta: PREFLIGHT FAILED — ${err.message}`);
    }
  } else {
    log("meta: not connected (no token / page id in Secret Manager)");
  }

  const approved = await loadApproved();
  const now = Date.now();
  const due = approved.filter((p) => !postBlocker(p, { now, requireDue: true })).slice(0, MAX_PER_RUN);
  const held = approved.length - due.length;
  log(`${approved.length} approved · ${due.length} due · ${held} not due or not postable`);
  if (!due.length) return 0;

  let posted = 0, failed = 0, skipped = 0;

  for (const post of due) {
    // ── THE GATE ─────────────────────────────────────────────────────────
    // Re-checked immediately before anything is claimed, against a FRESH read
    // — the list above could be seconds old and Junid may have un-approved it
    // in that window.
    const fresh = (await db.ref(`${POSTS}/${post.id}`).once("value")).val();
    const blocked = postBlocker(fresh ? { ...fresh, id: post.id } : null, { now: Date.now(), requireDue: true });
    if (blocked) { log(`SKIP ${post.id} — ${blocked}`); skipped++; continue; }

    if (DRY_RUN) {
      log(`WOULD POST ${post.id}  ${describePost(fresh)}`);
      for (const key of outstandingPlatforms(fresh)) {
        const c = captionFor(fresh, key);
        log(`   → ${key}: ${JSON.stringify(c).slice(0, 200)}`);
      }
      continue;
    }

    if (!(await claim(post.id))) { log(`SKIP ${post.id} — claimed by another run`); skipped++; continue; }

    const outstanding = outstandingPlatforms(fresh);
    let anyOk = false, anyRetryable = false, anySkipped = false;

    for (const key of outstanding) {
      if (attemptsExhausted(fresh, key)) {
        log(`  ${key}: out of retries (${MAX_ATTEMPTS}) — leaving it failed`);
        continue;
      }
      try {
        const res = await SENDERS[key](fresh, creds);
        await recordResult(post.id, key, { state: "ok", id: res.id, permalink: res.permalink || null, error: null });
        log(`  ${key}: posted ${res.permalink || res.id}`);
        anyOk = true;
      } catch (err) {
        if (err.notConnected) {
          // NOT a failure and NOT a retry: nothing is broken, the platform
          // simply is not wired up. Recorded so the queue can say so, and
          // deliberately without incrementing attempts.
          await db.ref(`${POSTS}/${post.id}/results/${key}`).update({
            state: "skipped", error: err.message, at: Date.now(),
          });
          log(`  ${key}: SKIPPED — ${err.message}`);
          anySkipped = true;
          continue;
        }
        await recordResult(post.id, key, { state: "error", error: String(err.message).slice(0, 400) });
        const retry = err.retryable === true;
        anyRetryable = anyRetryable || retry;
        log(`  ${key}: FAILED${retry ? " (will retry)" : " (permanent)"} — ${err.message}`);
      }
    }

    // ── WHERE THE POST LANDS ─────────────────────────────────────────────
    // Re-read: recordResult wrote per-platform state and we must decide from
    // what is actually stored, not from what we think we wrote.
    const after = (await db.ref(`${POSTS}/${post.id}`).once("value")).val();
    const stillOut = outstandingPlatforms(after).filter((k) => (after.results?.[k] || {}).state !== "skipped");
    const allExhausted = stillOut.length > 0 && stillOut.every((k) => attemptsExhausted(after, k));

    if (!stillOut.length) {
      await setStatus(post.id, "posted", { postedAt: Date.now() });
      log(`  → posted${anySkipped ? " (some platforms skipped)" : ""}`);
      posted++;
    } else if (allExhausted || (!anyRetryable && !anyOk)) {
      // Either every outstanding platform has burned its retries, or this run
      // achieved nothing and nothing about it was transient. Park it LOUDLY.
      await setStatus(post.id, "failed");
      log(`  → FAILED — ${stillOut.join(", ")} still unsent after ${MAX_ATTEMPTS} attempt(s). It is in the queue's Failed tab.`);
      failed++;
    } else {
      // Something is still worth trying. Back to approved so the next run
      // picks it up — the claim is released, the results survive.
      await setStatus(post.id, "approved");
      log(`  → partly sent; ${stillOut.join(", ")} will be retried on the next run`);
    }
  }

  log(`done: ${posted} posted, ${failed} failed, ${skipped} skipped`);
  // A run that failed something exits non-zero so the launchd wrapper banners
  // it as FAILED and counts it toward the consecutive-failure tally.
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("social publish FAILED:", err && err.message);
    process.exit(1);
  });

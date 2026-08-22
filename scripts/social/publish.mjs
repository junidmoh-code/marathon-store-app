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
  postBlocker, outstandingPlatforms, attemptsExhausted, captionFor, needsVerification,
  MAX_ATTEMPTS, STALE_CLAIM_MS, describePost, formatSlot, nextSlots,
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
// The next posting slot after `from`. A local twin of nextSlots in socialCore —
// importing it would be cleaner, but this file already imports that module, so
// it simply uses it.
const socialNextSlot = (from) => nextSlots(from + 1000, 1)[0] || null;
const log = (...a) => console.log(...a);
// ── WARNINGS GO TO STDERR, ON PURPOSE ────────────────────────────────────────
// The launchd wrapper buffers stdout until it can classify the tick, and an
// idle tick's buffer is DISCARDED so a quiet log stays quiet. A revoked token
// or an unreadable Secret Manager was reported on a tick with nothing due —
// and vanished. Any stderr output forces the runner to go live, so these are
// the lines that must never be swallowed.
const warn = (...a) => console.error(...a);

/** Everything approved, newest first. One bounded indexed query — never the node. */
const APPROVED_PAGE = 100;
async function loadApproved() {
  const snap = await db.ref(POSTS).orderByChild("status").equalTo("approved").limitToLast(APPROVED_PAGE).once("value");
  const rows = Object.entries(snap.val() || {})
    .map(([id, body]) => ({ id, ...body }))
    .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  // A full page means there may be more, and silently working on a slice of an
  // unknown whole is how a post waits forever without anybody knowing.
  if (rows.length >= APPROVED_PAGE) {
    warn(`⚠ ${APPROVED_PAGE} approved posts came back — there may be more than this run can see.`);
  }
  return rows;
}

// ── RECLAIM ABANDONED CLAIMS ─────────────────────────────────────────────────
// A run killed between the claim and the final status write leaves its item in
// "posting" — claimed by a process that no longer exists. Nothing used to look
// at those again: loadApproved only queries "approved", so the item sat in a
// state with no owner and no retry.
//
// Reclaiming is safe BECAUSE of the per-platform results. Anything that
// actually reached a platform is recorded "ok" and is not re-sent; anything
// recorded "sending" is held for a human (see needsVerification). So the worst
// case of reclaiming is that the remaining platforms are tried again, which is
// exactly what should happen.
async function reclaimStaleClaims() {
  const snap = await db.ref(POSTS).orderByChild("status").equalTo("posting").limitToLast(50).once("value");
  const rows = Object.entries(snap.val() || {});
  let reclaimed = 0;
  for (const [id, post] of rows) {
    // claimedAt, never updatedAt — see claim(). A post with no claimedAt at all
    // was claimed by a build older than this field; fall back to updatedAt so
    // it can still be recovered rather than sitting forever.
    const claimedAt = Number(post.claimedAt) || Number(post.updatedAt) || 0;
    const age = Date.now() - claimedAt;
    if (!(age > STALE_CLAIM_MS)) continue;
    // Transactional so a live run that is merely slow cannot have its claim
    // stolen out from under it by a concurrent tick.
    const res = await db.ref(`${POSTS}/${id}/status`).transaction((cur) => {
      if (cur === null) return null;
      if (cur !== "posting") return undefined;
      return "approved";
    });
    if (res.committed && res.snapshot.val() === "approved") {
      reclaimed++;
      warn(`⚠ reclaimed ${id} — it was left mid-send ${Math.round(age / 60000)} min ago and is back in the queue.`);
    }
  }
  return reclaimed;
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
  const won = res.committed && res.snapshot.val() === "posting";
  // ── STAMP WHEN THE CLAIM WAS TAKEN, NOT WHEN THE POST WAS LAST EDITED ─────
  // reclaimStaleClaims used to measure staleness from `updatedAt`, which is the
  // last time ANYTHING on the post changed. A post approved on Monday and
  // scheduled for Saturday carries a five-day-old updatedAt, so the instant it
  // was claimed it already looked abandoned — and a concurrent publisher could
  // reclaim a live claim and send the same post alongside it. `claimedAt` is
  // written by the claim and by nothing else, so it can only ever mean "this
  // run took it at this moment".
  if (won) await db.ref(`${POSTS}/${postId}/claimedAt`).set(Date.now());
  return won;
}

/**
 * Mark a platform as IN FLIGHT before the call is made.
 *
 * This is the record that closes the double-post window. Without it, a publish
 * that succeeded on the platform but whose response was lost — a 502 from
 * Meta's edge, the process killed mid-call, the network dropping — looked
 * identical to one that never happened, and the retry created a SECOND live
 * post that nothing in this program can undo.
 *
 * The attempt is counted here too, so a crash between this write and the
 * outcome still burns an attempt rather than looping forever.
 */
async function markSending(postId, platformKey) {
  const ref = db.ref(`${POSTS}/${postId}/results/${platformKey}`);
  const prev = (await ref.once("value")).val() || {};
  await ref.update({
    state: "sending",
    attempts: Number(prev.attempts || 0) + 1,
    error: null,
    at: Date.now(),
  });
}

/**
 * Record one platform's outcome. Merge-only: never clobbers a sibling result.
 * `attempts` is NOT incremented here — markSending already did it before the
 * call, which is the only place it can be counted safely.
 */
async function recordResult(postId, platformKey, patch) {
  const ref = db.ref(`${POSTS}/${postId}/results/${platformKey}`);
  await ref.update({ ...patch, at: Date.now() });
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
    warn(`⚠ could not read ${name}: ${why}`);
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
      warn(`meta: PREFLIGHT FAILED — ${err.message}`);
    }
  } else {
    log("meta: not connected (no token / page id in Secret Manager)");
  }

  // Take back anything a dead run left claimed, BEFORE deciding what is due —
  // a reclaimed post must be eligible in this same tick, not the next one.
  const reclaimed = await reclaimStaleClaims();
  if (reclaimed) log(`reclaimed ${reclaimed} abandoned claim(s)`);

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

    // ── EVERYTHING FROM HERE IS INSIDE A GUARD ───────────────────────────────
    // The post is now CLAIMED, which means it is in "posting" and no longer
    // visible to loadApproved. If anything below throws — an RTDB blip on a
    // result write, the final read, the status write — an unguarded loop left
    // it stranded in "posting" forever AND abandoned every remaining post in
    // the run. The catch puts it back where the next run will find it.
    try {
      // Re-read AFTER winning the claim. `fresh` was read before it, and a
      // caption edited in that window is not the caption that should go out.
      const claimed = (await db.ref(`${POSTS}/${post.id}`).once("value")).val();
      if (!claimed) { log(`SKIP ${post.id} — the post was deleted mid-run`); skipped++; continue; }
      const item = { ...claimed, id: post.id };

      if (DRY_RUN) { log(`WOULD POST ${post.id}`); continue; }

      const outstanding = outstandingPlatforms(item);
      let anyOk = false, anyRetryable = false, anySkipped = false, anyUnverified = false;

      for (const key of outstanding) {
        // ── NEVER BLIND-RETRY AN UNCONFIRMED SEND ──────────────────────────
        // "sending" means we asked the platform to publish and never learned
        // the answer. Re-sending is how one post becomes two on a live public
        // account, and nothing here can undo that. Held for a human instead.
        if (needsVerification(item, key)) {
          anyUnverified = true;
          warn(`  ${key}: NEEDS CHECKING — a previous run sent this and never got a confirmation. ` +
               `Look at the account: if it posted, mark it; if not, un-approve and re-approve to retry.`);
          continue;
        }
        if (attemptsExhausted(item, key)) {
          log(`  ${key}: out of retries (${MAX_ATTEMPTS}) — leaving it failed`);
          continue;
        }
        try {
          await markSending(post.id, key);          // BEFORE the call, always
          const res = await SENDERS[key](item, creds);
          await recordResult(post.id, key, { state: "ok", id: res.id, permalink: res.permalink || null, error: null });
          log(`  ${key}: posted ${res.permalink || res.id}`);
          anyOk = true;
        } catch (err) {
          if (err.notConnected) {
            // NOT a failure and NOT a retry — nothing is broken, the platform
            // simply is not wired up. It never reached a send, so the
            // in-flight marker is replaced outright.
            // `attempts` is preserved when the platform has genuinely FAILED
            // before. Resetting it unconditionally let a Secret Manager outage
            // erase two real Instagram failures and present the post as
            // "nothing is broken, just skipped" — while handing it four fresh
            // attempts. It is only reset when there was no real failure to
            // forget, which is the ordinary "TikTok isn't connected" case.
            const prevState = (item.results?.[key] || {}).state;
            const keepAttempts = prevState === "error" || prevState === "sending";
            await db.ref(`${POSTS}/${post.id}/results/${key}`).update({
              state: "skipped",
              error: err.message,
              ...(keepAttempts ? {} : { attempts: 0 }),
              at: Date.now(),
            });
            log(`  ${key}: SKIPPED — ${err.message}`);
            anySkipped = true;
            continue;
          }
          await recordResult(post.id, key, { state: "error", error: String(err.message).slice(0, 400) });
          const retry = err.retryable === true;
          anyRetryable = anyRetryable || retry;
          warn(`  ${key}: FAILED${retry ? " (will retry)" : " (permanent)"} — ${err.message}`);
        }
      }

      // ── WHERE THE POST LANDS ─────────────────────────────────────────────
      // Decided from what is actually STORED, not from what we think we wrote.
      const after = (await db.ref(`${POSTS}/${post.id}`).once("value")).val();
      if (!after) { log(`  → the post was deleted while sending; nothing written back`); continue; }

      const results = after.results || {};
      const enabled = outstandingPlatforms({ ...after, results: {} });   // every enabled platform
      const sent = enabled.filter((k) => (results[k] || {}).state === "ok");
      const stillOut = outstandingPlatforms(after)
        .filter((k) => (results[k] || {}).state !== "skipped");
      const allExhausted = stillOut.length > 0 && stillOut.every((k) => attemptsExhausted(after, k));

      if (anyUnverified) {
        // Held, deliberately, in a state a person must look at. Not "posted"
        // (we do not know) and not retried (that is the double-post).
        await setStatus(post.id, "failed", { needsCheck: true });
        warn(`  → HELD FOR CHECKING — an earlier send was never confirmed. It is in the Failed tab.`);
        failed++;
      } else if (!stillOut.length && sent.length) {
        await setStatus(post.id, "posted", { postedAt: Date.now() });
        log(`  → posted${anySkipped ? " (some platforms skipped)" : ""}`);
        posted++;
      } else if (!stillOut.length && !sent.length) {
        // ── SKIPPED IS NOT POSTED ──────────────────────────────────────────
        // Every enabled platform was skipped, so nothing went anywhere. This
        // used to be marked "posted" with a postedAt — a TikTok-only post
        // landed in the Posted tab having reached nobody, and was never
        // surfaced again. It stays approved so it goes out the day the
        // platform is connected.
        // ── AND IT MOVES TO THE BACK OF THE QUEUE ───────────────────────
        // Left with its original (past) scheduledAt it sorted to the FRONT of
        // `due` on every run, forever. Six TikTok-only posts would occupy all
        // six slots of every run and no real post would ever be reached again.
        // Pushing it to the next slot keeps it approved, keeps it visible, and
        // keeps it retried — without starving everything behind it.
        const nextSlot = socialNextSlot(Date.now());
        await setStatus(post.id, "approved", nextSlot ? { scheduledAt: nextSlot } : {});
        warn(`  → NOTHING WAS SENT — every platform on this post is skipped. It stays approved${nextSlot ? `, moved to ${formatSlot(nextSlot)}` : ""}.`);
        skipped++;
      } else if (allExhausted || (!anyRetryable && !anyOk)) {
        await setStatus(post.id, "failed");
        warn(`  → FAILED — ${stillOut.join(", ")} unsent after ${MAX_ATTEMPTS} attempt(s). It is in the queue's Failed tab.`);
        failed++;
      } else {
        await setStatus(post.id, "approved");
        log(`  → partly sent; ${stillOut.join(", ")} will be retried on the next run`);
      }
    } catch (err) {
      // The claim must not outlive the run that took it. Back to approved so
      // the next tick picks it up; per-platform results already record
      // anything that did land, so nothing is re-sent.
      warn(`  ✗ ${post.id} errored mid-send: ${err && err.message}`);
      failed++;
      try {
        await setStatus(post.id, "approved");
      } catch (releaseErr) {
        // Even the release failed. reclaimStaleClaims() at the top of the next
        // run is the backstop for exactly this.
        warn(`  ✗ could not release the claim on ${post.id}: ${releaseErr && releaseErr.message} — the next run reclaims it.`);
      }
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

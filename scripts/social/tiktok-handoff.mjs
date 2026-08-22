// ── TIKTOK: WHAT IS WAITING, AND HOW IT GETS THERE ───────────────────────────
//   node scripts/social/tiktok-handoff.mjs
//
// READS ONLY. Prints the approved, due posts that have TikTok switched on and
// have not been posted there, in a form a Claude session can act on directly.
//
// ── WHY THIS SCRIPT EXISTS INSTEAD OF A THIRD PUBLISHING LEG ─────────────────
// Investigated 2026-08-22. There are exactly two ways to post to TikTok from
// this project, and NEITHER is available to an unattended launchd job today:
//
//   1. THE HIGGSFIELD CONNECTION. It genuinely can publish — tiktok_publish
//      does a real DIRECT_POST, with the AIGC and commercial-content
//      declarations TikTok requires. Two things stop it being wired into
//      publish.mjs:
//        · It is an MCP tool, reachable from inside a Claude session. There is
//          no HTTP endpoint, no API key, nothing a node script on a Mac mini
//          can call. Building one would mean building a Higgsfield API client
//          against an interface that is not published.
//        · No TikTok account is connected to the workspace at all. Checked
//          against the live account: tiktok_accounts returned an empty list.
//          Connecting one is a browser OAuth Junid does once (tiktok_connect
//          from a Claude session hands him the link).
//      There is also a media constraint worth knowing before anyone tries:
//      TikTok only accepts media from a verified source domain, so Higgsfield
//      requires the file to be HIGGSFIELD-HOSTED. Our images are Firebase
//      Storage URLs, so each post's media would have to be imported to
//      Higgsfield first (media_import_url). And TikTok rejects PNG for photo
//      posts — ours are JPEG, so that one is already handled.
//
//   2. TIKTOK'S OWN CONTENT POSTING API. This is what a script would use, and
//      it is the right long-term answer. It needs an app on TikTok for
//      Developers with the video.publish scope, and that scope is granted only
//      after an AUDIT — a real review with a demo video and a privacy policy,
//      not a credential to paste. Until an audited app exists there is no
//      token to put in Secret Manager, which is why `tiktok-access-token` is
//      on the secrets allow-list and empty.
//
// So the publisher records TikTok as SKIPPED with the reason, on every run,
// and the post stays visible in the queue with Instagram and Facebook already
// sent. Nothing is lost and nothing is silently dropped — but nor does the log
// claim a post went somewhere it did not.
import { createRequire } from "module";
import { postBlocker, captionFor, formatSlot, describePost } from "../../src/components/social/socialCore.js";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const snap = await db.ref("social_posts").orderByChild("status").equalTo("approved").limitToLast(100).once("value");
const rows = Object.entries(snap.val() || {})
  .map(([id, b]) => ({ id, ...b }))
  .filter((p) => p.platforms?.tiktok === true)
  .filter((p) => (p.results?.tiktok || {}).state !== "ok")
  .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));

if (!rows.length) {
  console.log("Nothing is waiting for TikTok.");
  process.exit(0);
}

console.log(`${rows.length} approved post(s) with TikTok switched on and not yet posted there:\n`);
for (const p of rows) {
  const blocked = postBlocker(p, { requireDue: true });
  const { title, description } = captionFor(p, "tiktok");
  console.log(`── ${p.id} ────────────────────────────────────────────`);
  console.log(`   ${describePost(p)}`);
  console.log(`   due:   ${formatSlot(p.scheduledAt)}${blocked ? `  (${blocked})` : "  — DUE NOW"}`);
  console.log(`   title: ${title}`);
  console.log(`   desc:  ${description.replace(/\n/g, "\n          ")}`);
  for (const m of p.media || []) console.log(`   media: ${m.type} ${m.url}`);
  console.log();
}

console.log(`
To publish these from a Claude session with the Higgsfield tools connected:

  1. tiktok_accounts — if it returns nothing, tiktok_connect first (a browser
     step Junid does once).
  2. For each media URL above: media_import_url to get a Higgsfield-hosted copy.
     TikTok only accepts media from a verified source domain, so a Firebase
     Storage URL will be rejected.
  3. tiktok_prepare_publish { media_type: "PHOTO", photo_images: [...],
     title, description, mode: "DIRECT_POST" }, then tiktok_publish with the
     confirmations it asks for. Our images are AI-generated for every post type
     except "new arrivals", so is_aigc must be TRUE on those — that is a legal
     declaration, not a formality.
  4. Then mark it here so the publisher stops listing it:
       node scripts/social/tiktok-handoff.mjs --mark <postId> --url <permalink>
`);

// Marking is deliberately a separate, explicit command rather than something
// this script infers. It writes exactly what the Mac-mini publisher would have
// written on a successful send, so the queue reads the same either way.
const flags = process.argv.slice(2);
const markIdx = flags.indexOf("--mark");
if (markIdx !== -1) {
  const postId = flags[markIdx + 1];
  const urlIdx = flags.indexOf("--url");
  const url = urlIdx === -1 ? null : flags[urlIdx + 1];
  if (!postId) { console.error("--mark needs a post id"); process.exit(2); }
  await db.ref(`social_posts/${postId}/results/tiktok`).update({
    state: "ok", permalink: url || null, id: null, error: null, at: Date.now(),
  });
  console.log(`marked ${postId} as posted to TikTok.`);
}
process.exit(0);

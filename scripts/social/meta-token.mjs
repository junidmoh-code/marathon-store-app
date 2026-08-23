// ── ONE-TIME: MINT THE NEVER-EXPIRING META PAGE TOKEN ────────────────────────
// Junid runs this ONCE, after the browser step below, and the social publisher
// can then post to Instagram and Facebook forever without another token dance.
//
//   node scripts/social/meta-token.mjs --short-lived <TOKEN>
//   node scripts/social/meta-token.mjs --check          (read-only, prints no secret)
//
// ── WHY A TOKEN THAT DOES NOT EXPIRE IS POSSIBLE ─────────────────────────────
// Meta's token chain is genuinely confusing and most people end up with a
// 60-day token and a calendar reminder. It does not have to be that way:
//
//   1. A USER token from the Graph API Explorer lasts about an hour.
//   2. Exchanged with grant_type=fb_exchange_token it becomes a LONG-LIVED
//      user token: 60 days.
//   3. A PAGE token read from /me/accounts USING A LONG-LIVED USER TOKEN does
//      NOT EXPIRE. That is the documented behaviour and it is the whole trick:
//      the expiry is inherited from the user token used to fetch it, and a
//      long-lived user token yields a permanent page token.
//
// Step 3 is why this script insists on doing step 2 itself rather than letting
// anyone paste a page token straight in. A page token minted from a
// short-lived user token expires in an hour, works perfectly in testing, and
// dies unattended on a Saturday evening.
//
// ── WHAT THE PAGE TOKEN CAN DO ───────────────────────────────────────────────
// Both legs. Instagram publishing is authorised by the token of the FACEBOOK
// PAGE the Instagram Business account is connected to — there is no separate
// Instagram token to manage.
//
// ── THE BROWSER STEP JUNID DOES, EXACTLY ─────────────────────────────────────
// (Also in scripts/social/SOCIAL-SETUP.md, with screenshots' worth of detail.)
//
//   a. developers.facebook.com → My Apps → Create App → type "Business".
//      Name it anything; "Marathon Social" is fine.
//   b. In the app: Add Product → "Instagram" (Instagram Graph API) and
//      "Facebook Login for Business".
//   c. App Roles → Roles: confirm his own account is listed as Administrator.
//      This is the step that means NO APP REVIEW IS NEEDED: an app in
//      Development mode can call the API on behalf of people who hold a role
//      on it, indefinitely. App Review is for acting on behalf of the public,
//      which this app never does.
//   d. Tools → Graph API Explorer. Pick the app in the top-right. Click
//      "Generate Access Token" and grant these permissions:
//         instagram_basic
//         instagram_content_publish
//         pages_show_list
//         pages_read_engagement
//         pages_manage_posts
//      (ads_management / ads_read are only needed if the Page sits under a
//      Business Manager that demands them; add them if the token exchange
//      below complains about a missing scope.)
//   e. Copy the token it shows and run this script with it. It lasts an hour,
//      which is plenty, and it is the LAST token he ever has to copy.
//
// The app id and secret are needed for the exchange in step 2 and are read
// from the environment — META_APP_ID and META_APP_SECRET — so they are never
// typed on a command line where a shell history would keep them.
//
// NOTHING IS EVER PRINTED. Not the short-lived token, not the long-lived one,
// not the page token. The script prints names, ids and "stored".
import { writeSecret, readSecret, credentialStatus, secretWriteCheck, credentialSource } from "./secrets.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";
const flags = process.argv.slice(2);
const argOf = (n) => { const i = flags.indexOf(n); return i === -1 ? null : flags[i + 1]; };

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(2); }

async function get(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const e = json?.error;
    // The error body can echo the token back inside a message. Only the
    // message text is surfaced, and only after the token is stripped from it.
    const msg = e ? `${e.message}${e.error_subcode ? ` [${e.code}/${e.error_subcode}]` : ""}` : text.slice(0, 200);
    throw new Error(msg.replace(/EA[A-Za-z0-9]{20,}/g, "<token>"));
  }
  return json;
}

if (flags.includes("--check")) {
  console.log("credentials in Secret Manager:");
  for (const [k, v] of Object.entries(await credentialStatus())) console.log(`  ${k}: ${v}`);
  const token = await readSecret("meta-page-access-token");
  const pageId = await readSecret("meta-page-id");
  if (!token || !pageId) { console.log("\nMeta is not connected yet. Run this script with --short-lived <TOKEN>."); process.exit(0); }
  const page = await get(pageId, { access_token: token, fields: "name,instagram_business_account" });
  console.log(`\nPage: ${page.name} (${pageId})`);
  console.log(`Instagram account: ${page.instagram_business_account?.id || "NOT CONNECTED — connect it in the Instagram app: Settings → Account type and tools → Share to other apps → Facebook"}`);
  process.exit(0);
}

const shortLived = argOf("--short-lived");
if (!shortLived) die("usage: node scripts/social/meta-token.mjs --short-lived <TOKEN>   (see the header of this file for where to get it)");

const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
if (!appId || !appSecret) {
  die("set META_APP_ID and META_APP_SECRET in the environment first (Facebook app → Settings → Basic). " +
      "They are deliberately not command-line arguments — a shell history is not a secret store.");
}

// ── PREFLIGHT: CAN WE STORE THE RESULT? ──────────────────────────────────────
// Asked before the first Meta call, because the alternative is discovering it
// after the last one. Everything below this point spends a token that lasts an
// hour and cannot be re-used; a permission failure at step 4/4 costs the whole
// browser pass, not just the run. See secretWriteCheck in secrets.mjs for which
// identity has what, and why the publisher's service account deliberately is
// NOT the one that can write.
const src = credentialSource();
console.log(`0/4  checking these credentials can store a secret…`);
console.log(`     using: ${src.kind}`);
const perm = await secretWriteCheck();
if (!perm.ok) {
  if (perm.unknown) {
    die(`could not check permissions (HTTP ${perm.status ?? "?"}) using ${src.kind}.\n` +
        `  If that is an auth failure, refresh the login:  gcloud auth application-default login\n` +
        `  Nothing has been sent to Meta, so your token is still good.`);
  }
  die(`these credentials may READ secrets but not WRITE them (missing: ${perm.missing.join(", ")}).\n` +
      `  In play: ${src.kind}\n` +
      (process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? `           ${src.path}\n\n` +
          `  That is the PUBLISHER's service account. It holds roles/secretmanager.secretAccessor\n` +
          `  — read only — which is exactly right for the publisher and not enough for setup.\n\n` +
          `  FIX: run this again in a shell where the variable is not set:\n` +
          `           unset GOOGLE_APPLICATION_CREDENTIALS\n` +
          `       so it falls back to your own gcloud login (roles/owner).\n`
        : `\n  FIX: log in as the project owner:  gcloud auth application-default login\n`) +
      `\n  Nothing has been sent to Meta, so your one-hour token is still good.`);
}
console.log(`     ✓ can create secrets and add versions`);

console.log("1/4  exchanging the short-lived token for a 60-day one…");
const longLived = await get("oauth/access_token", {
  grant_type: "fb_exchange_token",
  client_id: appId,
  client_secret: appSecret,
  fb_exchange_token: shortLived,
}).catch((e) => die(`exchange refused: ${e.message}`));
if (!longLived?.access_token) die("the exchange returned no token.");
console.log(`     done (expires_in ${longLived.expires_in ?? "?"}s — this one is a stepping stone, not what gets stored)`);

console.log("2/4  reading the Pages this account manages…");
const accounts = await get("me/accounts", { access_token: longLived.access_token, fields: "id,name,access_token" })
  .catch((e) => die(`could not list Pages: ${e.message}`));
const pages = accounts?.data || [];
if (!pages.length) {
  die("this account manages no Facebook Pages. The Instagram account must be a Business account with a Page connected — " +
      "check in the Instagram app: Settings → Account type and tools.");
}
if (pages.length > 1) {
  console.log("     more than one Page:");
  pages.forEach((p, i) => console.log(`       [${i}] ${p.name} (${p.id})`));
  const pick = argOf("--page");
  if (!pick) die(`pick one and re-run with --page <id>, e.g. --page ${pages[0].id}`);
  const chosen = pages.find((p) => p.id === pick);
  if (!chosen) die(`--page ${pick} is not one of the Pages above.`);
  pages.length = 0;
  pages.push(chosen);
}
const page = pages[0];
console.log(`     Page: ${page.name} (${page.id})`);
// This is the token that does not expire — because it came from a LONG-LIVED
// user token. Never printed.
if (!page.access_token) die("the Page came back without an access token — the granted scopes are probably missing pages_show_list.");

console.log("3/4  finding the Instagram Business account connected to that Page…");
const withIg = await get(page.id, { access_token: page.access_token, fields: "instagram_business_account,name" })
  .catch((e) => die(`could not read the Page: ${e.message}`));
const igId = withIg?.instagram_business_account?.id;
if (!igId) {
  die(`no Instagram Business account is connected to "${page.name}". In the Instagram app: Settings → ` +
      "Account type and tools → Share to other apps → Facebook, and connect this Page. Then re-run this script.");
}
console.log(`     Instagram account: ${igId}`);

// Prove the token actually works for publishing BEFORE storing it. A stored
// credential that has never made a real call is a credential that fails first
// on a Saturday evening with nobody watching. This is a read, not a post.
console.log("4/4  verifying the token can see the publishing endpoints…");
await get(`${igId}/content_publishing_limit`, { access_token: page.access_token })
  .catch((e) => die(`the token cannot reach Instagram publishing: ${e.message}. Re-generate it with instagram_content_publish granted.`));

// Each write is guarded: writeSecret already refuses to let a gaxios error
// (which carries the base64 token in its request body) escape, and this catch
// is the second belt — a rejection that reached the top level would be printed
// by Node's own handler, object and all.
try {
  await writeSecret("meta-page-access-token", page.access_token);
  await writeSecret("meta-page-id", page.id);
  await writeSecret("meta-ig-user-id", igId);
} catch (err) {
  die(`could not store the credentials: ${String(err?.message || err)}`);
}

console.log(`
✓ stored in Secret Manager (project marathon-club):
    meta-page-access-token   (never printed; does not expire)
    meta-page-id             ${page.id}
    meta-ig-user-id          ${igId}

The publisher will pick these up on its next run. Check it any time with:
    node scripts/social/meta-token.mjs --check
    node scripts/social/publish.mjs --status

If the token is ever revoked — Junid changes his Facebook password, or removes
the app — every post will fail with a [190] error in logs/social-publish.log.
The fix is to run this script again from step (d).
`);
process.exit(0);

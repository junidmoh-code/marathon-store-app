#!/usr/bin/env node
// Add "updatedAt" to /shopify_publish's .indexOn in the LIVE, console-managed
// marathon-club RTDB rules. Dry run by default; writes only with --apply.
//
//   node scripts/rules/apply-shopify-publish-updatedat-index.mjs          # diff
//   node scripts/rules/apply-shopify-publish-updatedat-index.mjs --apply  # write
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A `firebase deploy --only database`
// ---------------------------------------------------------------------------
// The live rules and this repo's database.rules.json are NOT the same document
// and have not been for a long time. database.rules.json has no shopify_publish
// key and no shopify_sync key. Deploying it to make this one-word change would
// therefore ALSO drop the existing "state" index and drop the `.read: false /
// .write: false` lock on /shopify_sync — a security regression shipped as a
// side effect of a performance fix. So we merge one node into the live document
// and prove by diff that nothing else moved.
//
// Method (same as pos-app scripts/apply-refunded-qty-cap-rule.mjs):
// GET live -> backup -> patch ONE array in memory -> print -> re-GET and prove
// the live document has not moved under us -> PUT -> re-GET -> verify the array
// landed verbatim AND every other byte is identical, else restore the backup.
//
// WHAT IT BUYS
// scripts/shopify/reconcileScope.mjs runs
//   db.ref("shopify_publish").orderByChild("updatedAt").startAt(since)
// on a loop. With no index on updatedAt the server cannot answer that query
// from an index, so it ships the WHOLE node to the client and filters there —
// the read-only-what-changed work is paid for and not received. The index is
// what makes that query actually cost what it looks like it costs.
//
// WHY THIS CANNOT DO WHAT THE refundedQty VALIDATE DID
// A hand-applied `.validate` took every till down this morning because a
// validate is evaluated on every write and can REFUSE one (that rule used
// data.parent(), which is null on a create, so it refused every new sale).
// `.indexOn` is in a different class entirely: it is a query-planning hint. It
// is never evaluated against a write, it can never return false, and it has no
// deny path — there is no input to it that can reject a read or a write. The
// only behaviour it changes is whether the server answers an orderByChild query
// from an index or by streaming the node and filtering. A WRONG .indexOn (an
// index on a field nothing queries) wastes a little write-side bookkeeping; it
// cannot break a read. The blast radius of this change is bounded at "the query
// gets faster" and "writes to /shopify_publish maintain one more index entry".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const EXPECTED = ["state"];            // the only state this script may replace
const NEXT = ["state", "updatedAt"];   // what it replaces it with

async function token() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8"));
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.tokens.refresh_token,
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  return (await r.json()).access_token;
}

// NOTE ON ETags, because the script this one is modelled on is misleading here.
// `/.settings/rules.json` does NOT return an ETag header, with or without
// X-Firebase-ETag: true (verified against live, 2026-09-04 — the response
// carries no etag at all). The pos-app script asks for one, gets null, and
// sends no If-Match; its "conditional PUT" has always been an unconditional
// one. Rather than pretend, we send If-Match when the server gives us something
// to match on, and otherwise close the window the only way this endpoint allows:
// re-read immediately before the PUT and refuse if the document moved.
async function getRules(t) {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`, { headers: { "X-Firebase-ETag": "true" } });
  if (!r.ok) throw new Error(`GET rules failed: ${r.status}`);
  return { rules: await r.json(), etag: r.headers.get("etag") };
}
async function putRules(t, body, etag) {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { ...(etag ? { "If-Match": etag } : {}), "X-Firebase-ETag": "true" },
  });
  if (r.status === 412) throw new Error("PUT refused (412): the live rules changed since they were read — re-run");
  if (!r.ok) throw new Error(`PUT failed: ${r.status} ${await r.text()}`);
  return r.headers.get("etag");
}

const t = await token();
const { rules: live, etag: liveEtag } = await getRules(t);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(os.tmpdir(), `rtdb-rules-backup-${stamp}.json`);
fs.writeFileSync(backup, JSON.stringify(live, null, 2));
console.log(`backup: ${backup}`);
console.log(`etag from server: ${liveEtag === null ? "none (endpoint does not issue one)" : liveEtag}`);

const node = live.rules?.shopify_publish;
if (!node) throw new Error("live rules have no shopify_publish node — refusing to guess");
const cur = node[".indexOn"];
console.log("current .indexOn:", JSON.stringify(cur));
console.log("new     .indexOn:", JSON.stringify(NEXT));

if (JSON.stringify(cur) === JSON.stringify(NEXT)) { console.log("already applied — nothing to do"); process.exit(0); }
if (JSON.stringify(cur) !== JSON.stringify(EXPECTED) && !FORCE) {
  console.error(
    `\nREFUSING: the live .indexOn is not the one this script expects to extend.\n` +
    `  expected: ${JSON.stringify(EXPECTED)}\n` +
    `  found:    ${JSON.stringify(cur)}\n` +
    `Someone changed this. Read it, decide, and re-run with --force if you still mean to overwrite it.`,
  );
  process.exit(2);
}
// Sanity: /shopify_sync must be locked before AND after. If it is not locked
// now, something already regressed and this is not the script to be running.
const syncBefore = JSON.stringify(live.rules?.shopify_sync);
if (syncBefore !== JSON.stringify({ ".read": false, ".write": false })) {
  console.error(`REFUSING: /shopify_sync is not the expected read/write lock: ${syncBefore}`);
  process.exit(2);
}
if (!APPLY) { console.log("dry run — re-run with --apply to write"); process.exit(0); }

// Close the race the missing ETag leaves open: prove the document is still
// exactly what we patched before we push the patch.
const { rules: recheck } = await getRules(t);
if (JSON.stringify(recheck) !== JSON.stringify(live)) {
  console.error("REFUSING: the live rules changed between the read and the write — re-run");
  process.exit(3);
}

const next = JSON.parse(JSON.stringify(live));
next.rules.shopify_publish[".indexOn"] = NEXT;
const newEtag = await putRules(t, next, liveEtag);
const { rules: after } = await getRules(t);

// Verify: the array landed verbatim and NOTHING else changed.
const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.rules.shopify_publish[".indexOn"]; return c; };
const landed = JSON.stringify(after.rules?.shopify_publish?.[".indexOn"]) === JSON.stringify(NEXT);
const untouched = JSON.stringify(strip(after)) === JSON.stringify(strip(live));
const syncStillLocked = JSON.stringify(after.rules?.shopify_sync) === syncBefore;
if (!landed || !untouched || !syncStillLocked) {
  console.error("VERIFY FAILED — restoring backup", { landed, untouched, syncStillLocked });
  try { await putRules(t, live, newEtag); console.error("restored the backup"); }
  catch (e) { console.error("RESTORE FAILED — apply the backup by hand:", backup, e.message); }
  process.exit(1);
}
console.log("applied and verified.");
console.log("  .indexOn      :", JSON.stringify(after.rules.shopify_publish[".indexOn"]));
console.log("  shopify_sync  :", JSON.stringify(after.rules.shopify_sync));
console.log("  every other byte of the rules document is identical to the backup.");

// ── SECRETS FOR THE SOCIAL PUBLISHER ─────────────────────────────────────────
// Every platform credential this program uses is read from Google Secret
// Manager at run time. Nothing is in the bundle, nothing is in the repo,
// nothing is written to disk, and NOTHING IS EVER PRINTED — the only things
// these functions will put in a log are a secret's NAME and whether it was
// found.
//
// ── WHY SECRET MANAGER AND NOT THE .env FILE ─────────────────────────────────
// The Shopify scripts read their credentials from a git-ignored .env at the
// repo root, and that was the right call for them: they were built to be run
// by hand on Junid's laptop. This program runs UNATTENDED on the Mac mini,
// three times a week, forever, and it holds a token that can post to the
// shop's public Instagram. A file on a machine nobody logs into is a worse
// place for that than a service that logs every access, rotates cleanly, and
// can have a token revoked from a browser.
//
// The Mac mini already authenticates to Google: the reconciler's launchd agent
// points GOOGLE_APPLICATION_CREDENTIALS at a service-account key, and
// firebase-admin uses it. The SAME credentials are used here, via the Secret
// Manager REST API and google-auth-library — deliberately no new dependency,
// because a dependency added for one call is a dependency somebody has to keep
// patched forever.
//
// ── THE ESCAPE HATCH, AND WHY IT IS SAFE ─────────────────────────────────────
// If an environment variable of the same name is already set, it wins and
// Secret Manager is not called. That is how a first-time setup is tested
// before the secret exists, and how the whole thing can be run on a laptop in
// an emergency. It is not a hole: an attacker who can set environment
// variables in this process can already read the secret the other way.
//
// ── WHAT THE PUBLISHER NEEDS ─────────────────────────────────────────────────
//   meta-page-access-token   a NEVER-EXPIRING Facebook Page access token
//   meta-page-id             the Facebook Page's numeric id (not a secret, but
//                            it lives beside its token so one setup step
//                            produces one place to look)
//   meta-ig-user-id          the Instagram Business account's id
// Mint all three with: node scripts/social/meta-token.mjs
import { createRequire } from "module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));

const PROJECT = "marathon-club";
const cache = new Map();

// Never widen this. A secret this program does not need is a secret it must
// not be able to read, and an allow-list is the difference between a bug that
// fetches the wrong name and a bug that exfiltrates the WhatsApp token.
export const SOCIAL_SECRETS = new Set([
  "meta-page-access-token",
  "meta-page-id",
  "meta-ig-user-id",
  "tiktok-access-token",
]);

let clientPromise = null;
function authClient() {
  if (!clientPromise) {
    const { GoogleAuth } = require("google-auth-library");
    clientPromise = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    }).getClient();
  }
  return clientPromise;
}

/**
 * Read one secret's latest version.
 * Returns the value, or null when the secret does not exist — a MISSING
 * secret is a normal state ("Junid has not connected TikTok yet") and the
 * caller decides what it means. Any other failure throws, because a Secret
 * Manager that is refusing us is not a state to carry on posting through.
 *
 * The value is cached for the life of the process. A publish run is seconds
 * long, so this is a handful of API calls saved, not a staleness risk.
 */
export async function readSecret(name) {
  if (!SOCIAL_SECRETS.has(name)) {
    throw new Error(`refusing to read secret "${name}" — not on this program's allow-list`);
  }
  if (process.env[name.toUpperCase().replace(/-/g, "_")]) {
    return process.env[name.toUpperCase().replace(/-/g, "_")];
  }
  if (cache.has(name)) return cache.get(name);

  const client = await authClient();
  const url = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${encodeURIComponent(name)}/versions/latest:access`;
  let res;
  try {
    res = await client.request({ url });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) { cache.set(name, null); return null; }
    // The message from the API can quote request context; the VALUE is never
    // in it, but the name is enough to say what failed without repeating
    // anything the API said back.
    throw new Error(`Secret Manager refused "${name}" (HTTP ${status ?? "?"}). Check the service account has roles/secretmanager.secretAccessor.`);
  }
  const b64 = res?.data?.payload?.data;
  if (!b64) { cache.set(name, null); return null; }
  const value = Buffer.from(b64, "base64").toString("utf8").trim();
  cache.set(name, value);
  return value;
}

/**
 * Create or update a secret. Used ONLY by the one-time setup script
 * (meta-token.mjs) — the publisher never writes a secret.
 */
export async function writeSecret(name, value) {
  if (!SOCIAL_SECRETS.has(name)) {
    throw new Error(`refusing to write secret "${name}" — not on this program's allow-list`);
  }
  const client = await authClient();
  // Create the container first; an existing one is fine and is the normal case
  // on a re-run (a token being replaced).
  try {
    await client.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${encodeURIComponent(name)}`,
      method: "POST",
      data: { replication: { automatic: {} } },
    });
  } catch (err) {
    if (err?.response?.status !== 409) {
      throw new Error(`could not create secret "${name}" (HTTP ${err?.response?.status ?? "?"}).`);
    }
  }
  // ── THE ERROR MUST NOT CARRY THE PAYLOAD ─────────────────────────────────
  // This is the one call in the program that puts a secret in a REQUEST BODY,
  // and a gaxios error keeps that body on the error object as an enumerable
  // own property — twice, in `config.data` and `response.config.data`. Node's
  // uncaught-rejection printer inspects the whole object, so an unhandled 403
  // here prints the base64 of the Page token straight into the terminal, or
  // into logs/social-launchd.err.log where it stays.
  //
  // So the raw error NEVER escapes. Only the status and the secret NAME do.
  try {
    await client.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${encodeURIComponent(name)}:addVersion`,
      method: "POST",
      data: { payload: { data: Buffer.from(String(value), "utf8").toString("base64") } },
    });
  } catch (err) {
    throw new Error(
      `could not add a version to secret "${name}" (HTTP ${err?.response?.status ?? "?"}). ` +
      `Check the service account has roles/secretmanager.secretVersionAdder or secretmanager.admin.`
    );
  }
  cache.delete(name);
  // The RETURN VALUE is deliberately a count, not the value. A caller that
  // wants to confirm the write gets "ok", never an echo.
  return { ok: true, name };
}

/**
 * Which credentials are present, WITHOUT revealing any of them. This is what
 * the publisher logs at the top of a run and what the setup script prints —
 * "meta: ready, tiktok: not connected" is everything an operator needs and
 * nothing an attacker can use.
 */
export async function credentialStatus() {
  const out = {};
  for (const name of SOCIAL_SECRETS) {
    try {
      const v = await readSecret(name);
      out[name] = v ? "present" : "missing";
    } catch (err) {
      out[name] = `unreadable (${String(err.message).slice(0, 80)})`;
    }
  }
  return out;
}

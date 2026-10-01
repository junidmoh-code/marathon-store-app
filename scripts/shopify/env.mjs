// ── Env loading for the Shopify scripts ──────────────────────────────────────
// Credentials come from process.env, optionally topped up from a git-ignored
// .env file at the repo root (KEY=VALUE lines). Real environment variables
// always win over the file. Values are NEVER logged — error messages name the
// missing variable only.
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue; // real env wins
    const quoted = raw.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    if (quoted) {
      process.env[key] = quoted[2];
    } else if (/^["']/.test(raw)) {
      // A leading quote that never closes would silently ship the quote char
      // inside the credential and fail later as an opaque HTTP error.
      console.warn(`.env: ignoring ${key} — unterminated quote`);
    } else {
      // Unquoted values may carry an inline comment ("KEY=value  # note").
      process.env[key] = raw.replace(/\s+#.*$/, "").trim();
    }
  }
}

// ── A MISSING CREDENTIAL MUST BE CATCHABLE ───────────────────────────────────
// These functions used to call process.exit(2) directly, and that made them
// unusable from a library. On 2026-09-04 the social publisher proved why: it
// posts to Instagram and Facebook, then refreshes the Shop the Feed collection
// in a try/catch documented as "IT MUST NEVER FAIL THE RUN". The mini's
// publisher checkout had no .env, so requireEnv fired inside that block —
// process.exit is not throwable, so the catch never ran:
//
//   18:01:37  → posted
//   18:01:38  Missing required env var SHOPIFY_SHOP...
//   18:01:38  ✗✗ RUN FAILED (exit 2)
//
// The posts were already live. Every successful run was bannered FAILED and
// counted toward the consecutive-failure alarm — an alarm that cries wolf on
// every run is worse than no alarm.
//
// So these THROW now. The message is unchanged, and every CLI in this
// directory already ends in a .catch that prints err.message and exits
// non-zero, so a person running one by hand sees exactly what they saw before.
// A library caller can finally catch it.
export class MissingEnvError extends Error {
  constructor(message, varName) {
    super(message);
    this.name = "MissingEnvError";
    this.varName = varName;
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new MissingEnvError(
      `Missing required env var ${name}. Set it in the environment or in a ` +
        `git-ignored .env at the repo root. See scripts/shopify/README.md.`,
      name
    );
  }
  return v;
}

// The credentials any Shopify call needs before it can do anything at all.
export const SHOPIFY_CREDENTIAL_VARS = Object.freeze([
  "SHOPIFY_SHOP",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
]);

/**
 * Which of them are absent, [] when all present. NEVER throws and never exits —
 * this is the shape a caller needs when "not configured here" is a legitimate
 * state to carry on through rather than an error.
 */
export function missingShopifyCredentials(env = process.env) {
  return SHOPIFY_CREDENTIAL_VARS.filter((name) => !env[name]);
}

// The ONE store this program talks to. SHOPIFY_SHOP is pinned to it: the token
// grant posts CLIENT_SECRET to https://{shop}/… and the GraphQL client sends
// the access token there — an unnoticed .env edit pointing at another host
// would hand both to that host. Everything URL-building goes through here.
const EXPECTED_SHOP = "nu3ei8-0p.myshopify.com";

export function requireShop() {
  const shop = requireEnv("SHOPIFY_SHOP");
  if (shop !== EXPECTED_SHOP) {
    // Throws rather than exits for the same reason as requireEnv above. The
    // REFUSAL is unchanged and is what matters: a mismatched host never
    // receives the credentials either way.
    throw new Error(
      `SHOPIFY_SHOP is "${shop}" but this program only talks to ${EXPECTED_SHOP}. ` +
        `Refusing to send credentials anywhere else; update EXPECTED_SHOP in ` +
        `scripts/shopify/env.mjs if the store itself has genuinely changed.`
    );
  }
  return shop;
}

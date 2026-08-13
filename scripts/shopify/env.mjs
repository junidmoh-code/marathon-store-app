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

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing required env var ${name}. Set it in the environment or in a ` +
        `git-ignored .env at the repo root. See scripts/shopify/README.md.`
    );
    process.exit(2);
  }
  return v;
}

// The ONE store this program talks to. SHOPIFY_SHOP is pinned to it: the token
// grant posts CLIENT_SECRET to https://{shop}/… and the GraphQL client sends
// the access token there — an unnoticed .env edit pointing at another host
// would hand both to that host. Everything URL-building goes through here.
const EXPECTED_SHOP = "nu3ei8-0p.myshopify.com";

export function requireShop() {
  const shop = requireEnv("SHOPIFY_SHOP");
  if (shop !== EXPECTED_SHOP) {
    console.error(
      `SHOPIFY_SHOP is "${shop}" but this program only talks to ${EXPECTED_SHOP}. ` +
        `Refusing to send credentials anywhere else; update EXPECTED_SHOP in ` +
        `scripts/shopify/env.mjs if the store itself has genuinely changed.`
    );
    process.exit(2);
  }
  return shop;
}

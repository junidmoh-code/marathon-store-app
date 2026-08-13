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

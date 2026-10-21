// ── Env loading for the Courier Guy scripts ──────────────────────────────────
// The API key comes from process.env, topped up from (in order, first wins):
//   1. the git-ignored .env at the repo root        (Junid's MacBook)
//   2. ~/.config/marathon/courier.env, chmod 600     (the Mac mini)
// Real environment variables always win over both files. The key is NEVER
// logged or printed — error messages name the missing variable only, and the
// client redacts it from every log line (courier-client.mjs).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_FILES = Object.freeze([
  fileURLToPath(new URL("../../.env", import.meta.url)),
  join(homedir(), ".config", "marathon", "courier.env"),
]);

export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (env[key] !== undefined) continue; // real env (or an earlier file) wins
    const quoted = raw.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    env[key] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "").trim();
  }
}

for (const f of ENV_FILES) loadEnvFile(f);

export class MissingEnvError extends Error {
  constructor(name) {
    super(
      `Missing required env var ${name}. Set it in the environment, in the git-ignored ` +
        `.env at the repo root, or in ~/.config/marathon/courier.env. See docs/COURIER-GUY.md.`
    );
    this.name = "MissingEnvError";
    this.varName = name;
  }
}

export function courierApiKey(env = process.env) {
  const v = env.COURIER_GUY_API_KEY;
  if (!v) throw new MissingEnvError("COURIER_GUY_API_KEY");
  return v;
}

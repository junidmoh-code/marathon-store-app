import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Build identity for the auto-update checker: the git sha names the code, the
// timestamp distinguishes rebuilds of the same sha. The SAME value is baked
// into the bundle (__BUILD_VERSION__) and emitted as /version.json — a running
// tab polls the json and compares it against its baked-in copy
// (src/update/updateChecker.js). Mirrors the marathon-pos-app setup.
function gitSha() {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "nogit"; }
}
const buildVersion = `${gitSha()}.${Date.now()}`;

function emitVersionJson() {
  return {
    name: "emit-version-json",
    apply: "build",
    writeBundle(options) {
      writeFileSync(
        resolve(options.dir ?? "dist", "version.json"),
        JSON.stringify({ version: buildVersion, builtAt: new Date().toISOString() }),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), emitVersionJson()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    // Shopify Publishing photo cleanup (geminiClean.js). Baked at BUILD time
    // from the build machine's env: absent ⇒ empty string ⇒ the action ships
    // DISABLED with a plain message (no stub, no fallback provider). NOTE the
    // key lands in the public bundle and is extractable — referrer
    // restrictions are advisory (Referer is forgeable), so use a dedicated
    // key with a hard quota cap in the Google console, never a shared one.
    __GEMINI_API_KEY__: JSON.stringify(process.env.GEMINI_API_KEY ?? ""),
  },
  build: {
    outDir: "dist",
  },
  test: {
    // The Cloud Functions suite (functions/) uses node:test and runs via
    // `node --test` from functions/ — exclude it from vitest, which can't run it.
    exclude: [...configDefaults.exclude, "functions/**"],
  },
});

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
    // NO API KEY IS BAKED INTO THIS BUNDLE, and none may be added. The photo
    // cleanup action used to define __GEMINI_API_KEY__ here from the build
    // machine's env, which put a spendable Google key in front of anyone who
    // viewed the site's JavaScript. Every paid image call now lives in a Cloud
    // Function (generateProductPhotos in functions/index.js) holding the key as
    // a Cloud Functions secret the build never sees. A `define` is a public
    // string — treat every entry here as published.
    // Pinned by src/noBakedKeys.test.js.
  },
  // ── THE MINIFIER KEEPS FUNCTION AND CLASS NAMES ────────────────────────────
  // Without this, the production stack for the Social outage read
  // "null is not an object (evaluating 's.some')" — `s` being a minified local
  // inside a component minified to a single letter. Locating the line meant
  // downloading the deployed bundle and pattern-matching against it by hand.
  // keepNames tells esbuild to preserve the `name` of every function and class,
  // so a component stack in AppErrorBoundary names PostRow and Queue instead of
  // a column of letters. Local VARIABLES are still mangled — that is not what
  // this buys — but the frames become readable, which is what a stack is for.
  //
  // The cost is a `__name(...)` wrapper per function. Measured on this bundle:
  // 2,494,486 -> 2,591,158 bytes raw, +96,672 (+3.88%). Gzipped — which is what
  // a phone actually downloads — it is 680,049 -> 717,856, +37,807 (+5.56%).
  // Well under the 10% ceiling this change was allowed under, and recorded in
  // the PR body. Deliberately
  // NOT sourcemaps: those would publish the whole source next to a bundle
  // served to the public.
  esbuild: {
    keepNames: true,
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

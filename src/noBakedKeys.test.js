// ─── NO SPENDABLE KEY MAY BE BAKED INTO THE BUNDLE ───────────────────────────
// This guard used to live at the bottom of geminiClean.test.js, because that
// is the file whose subject had once carried `__GEMINI_API_KEY__` baked in by
// vite at build time — readable by anyone who opened the site's JavaScript,
// with a quota cap as the only containment.
//
// geminiClean.js and its test are gone (2026-08-20, with the clean-background
// action they belonged to). Half of what that test file protected went with
// them and should have: the subject-preservation gate has no caller left. But
// THIS half was never about geminiClean at all. It is about the build, and the
// build is still here. Deleting a file should not quietly retire a guard on a
// different file, so it moves out on its own rather than dying with its host.
//
// The rule it enforces: Firebase Hosting is static and serves the bundle to
// anyone. Nothing in the build may put a spendable credential in it. Paid
// calls belong in Cloud Functions, where the key is a Secret Manager secret
// the build never sees.
//
// The public Firebase Web API key in src/firebase.js is deliberately NOT in
// scope: it is not a secret, it identifies the project rather than authorising
// spend, and every Firebase web app ships one. What is in scope is anything
// vite would INJECT — a `define` reading a secret-shaped environment variable.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// Comments explain history and legitimately mention the names; only code counts.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the build bakes no spendable key into the bundle", () => {
  const cfg = stripComments(readFileSync(new URL("../vite.config.js", import.meta.url), "utf8"));

  it("defines no Gemini key placeholder", () => {
    expect(cfg).not.toMatch(/__GEMINI_API_KEY__/);
    expect(cfg).not.toMatch(/API_KEY/);
  });

  it("reads no secret-shaped environment variable into the build", () => {
    // `define` substitutes at build time, so a KEY/SECRET/TOKEN env var read
    // here lands verbatim in the served JavaScript. Dotted access is the
    // obvious spelling; bracketed access and import.meta.env are the two that
    // would slip past a dotted-only check (CodeRabbit, PR #393).
    expect(cfg).not.toMatch(/process\.env\.[A-Za-z_]*(KEY|SECRET|TOKEN)/i);
    expect(cfg).not.toMatch(/process\.env\s*\[/);
    expect(cfg).not.toMatch(/import\.meta\.env/);
    expect(cfg).not.toMatch(/loadEnv/);
    // envPrefix widens which env vars vite exposes to the browser wholesale.
    expect(cfg).not.toMatch(/envPrefix/);
  });

  it("defines nothing whose NAME sounds like a credential, however it is spelled", () => {
    // The value is what leaks, but the name is what a reviewer scans for. Any
    // __X_KEY__-shaped define is refused outright rather than judged.
    const defines = cfg.match(/__[A-Z0-9_]+__/g) || [];
    for (const d of defines) {
      expect(d).not.toMatch(/(KEY|SECRET|TOKEN|PASS|CREDENTIAL)/);
    }
  });
});

describe("no source file talks to a paid AI provider directly from the browser", () => {
  // The browser may call our OWN Cloud Functions (httpsCallable). It may not
  // call an AI provider, because doing so requires a key in the bundle.
  const files = [
    "components/shopify/aiStudioCore.js",
    "components/shopify/AiStudioCard.jsx",
    "components/shopify/ShopifyProductPage.jsx",
  ];

  for (const rel of files) {
    it(`${rel} reaches the model only through a Cloud Function`, () => {
      const code = stripComments(readFileSync(new URL(`./${rel}`, import.meta.url), "utf8"));
      expect(code).not.toMatch(/generativelanguage\.googleapis\.com/);
      expect(code).not.toMatch(/api\.openai\.com/);
      expect(code).not.toMatch(/x-goog-api-key/);
      expect(code).not.toMatch(/Authorization:\s*[`"']Bearer/);
    });
  }

  it("NO file under src/ names a paid provider's endpoint", () => {
    // The per-file list above is the close reading; this is the sweep, so a
    // NEW file cannot quietly reintroduce a direct provider call (CodeRabbit,
    // PR #393). Comments are stripped — this very file names the hosts.
    const root = fileURLToPath(new URL(".", import.meta.url));
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|jsx|ts|tsx|mjs)$/.test(entry.name)) continue;
        if (entry.name === "noBakedKeys.test.js") continue;
        const code = stripComments(readFileSync(full, "utf8"));
        if (/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|x-goog-api-key/.test(code)) {
          offenders.push(full.slice(root.length));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("the AI Studio card's only paid call is the generateProductPhotos callable", () => {
    const code = stripComments(
      readFileSync(new URL("./components/shopify/AiStudioCard.jsx", import.meta.url), "utf8"),
    );
    expect(code).toMatch(/httpsCallable\(functions,\s*"generateProductPhotos"\)/);
    // The one other fetch in the file reads the finished image back out of
    // Firebase Storage so it can be copied into the publishing folder. That is
    // our own bucket and it costs nothing.
    const fetches = code.match(/\bfetch\(/g) || [];
    expect(fetches.length).toBe(1);
    // …and that one fetch is gated on the app's own Storage bucket, so a
    // server response cannot send the browser to an arbitrary host and have
    // the bytes laundered into the publishing set.
    expect(code).toMatch(/startsWith\(APP_STORAGE_PREFIX\)/);
  });
});

// ─── GUARD: nothing writes the Shopify primary photo around the one write ────
// The primary photo lives in /shopify_publish/{pid}/media (and its `photos`
// projection). Every writer of those fields must make the app photo follow
// through primaryPhotoCore.setShopifyPrimaryPhoto (Junid, 26 Sep / 19 Oct
// 2026). This test reads every source file in the repo and fails when:
//   • the store's list writers (setPublishMedia / appendPublishMedia /
//     setPublishPhotos) are called anywhere but publishMediaCommit.js;
//   • the list mutators (photosMutator / mediaMutator / appendMediaMutator)
//     are used anywhere but the store and the New Arrivals chain;
//   • a file writes a shopify_publish …/photos or …/media path directly;
//   • an allowed writer does not call setShopifyPrimaryPhoto.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../..");
const DIRS = ["src", "scripts", "functions"];
const SKIP_DIR = new Set(["node_modules", "dist", "fixtures", "__tests__"]);
const isTest = (f) => /\.test\.|\.testutil\./.test(f);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs|cjs)$/.test(name) && !isTest(name)) out.push(p);
  }
  return out;
}
const FILES = DIRS.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, "utf8") }));
// Comments may name anything; only code counts.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const STORE = "src/components/shopify/shopifyPublishStore.js";
const MUTATORS = "src/components/shopify/publishMutators.js";
const COMMIT = "src/components/shopify/publishMediaCommit.js";
const CHAIN = "scripts/newArrivals/chainCore.mjs";

// db.ref(`shopify_publish/${pid}/media`).set(…) — the admin SDK form …
const Q = "[\"'\\x60]", NQ = "[^\"'\\x60\\s]";
const PATH = `${Q}shopify_publish\\/${NQ}*\\/(photos|media)(\\/${NQ}*)?${Q}`;
const ADMIN_WRITE = new RegExp(`ref\\(\\s*${PATH}\\s*\\)\\s*\\.(set|update|transaction|push|remove)\\b`);
// … and set(ref(database, `shopify_publish/${pid}/photos`), …) — the browser SDK form.
const CLIENT_WRITE = new RegExp(`\\b(set|update|runTransaction|push|remove)\\(\\s*ref\\(\\s*\\w+\\s*,\\s*${PATH}`);
// … and a multi-path update keyed by the path: update({ [`shopify_publish/${pid}/media`]: … }).
const MULTI_PATH_WRITE = new RegExp(`\\[\\s*${PATH}\\s*\\]\\s*:|${Q}shopify_publish\\/${NQ}*\\/(photos|media)(\\/${NQ}*)?${Q}\\s*:`);
const offenders = (re, allowed) => FILES.filter((f) => !allowed.includes(f.rel) && re.test(code(f.src))).map((f) => f.rel);

describe("the Shopify primary photo has ONE write path", () => {
  it("the store's list writers are called only by commitPublishMedia", () => {
    expect(offenders(/\b(setPublishMedia|appendPublishMedia|setPublishPhotos)\s*\(/, [STORE, COMMIT])).toEqual([]);
  });
  it("the list mutators are used only by the store and the New Arrivals chain", () => {
    expect(offenders(/\b(photosMutator|mediaMutator|appendMediaMutator)\b/, [STORE, MUTATORS, CHAIN])).toEqual([]);
  });
  it("no file writes a shopify_publish photos/media path directly", () => {
    expect(offenders(ADMIN_WRITE, [])).toEqual([]);
    expect(offenders(CLIENT_WRITE, [])).toEqual([]);
    expect(offenders(MULTI_PATH_WRITE, [])).toEqual([]);
    expect(offenders(/\.child\(\s*["'`](photos|media)["'`]\s*\)\s*\.(set|update|transaction|push|remove)\b/, [])).toEqual([]);
  });
  it("every allowed writer calls setShopifyPrimaryPhoto", () => {
    for (const rel of [COMMIT, CHAIN]) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f, rel).toBeTruthy();
      expect(code(f.src), rel).toMatch(/\bsetShopifyPrimaryPhoto\s*\(/);
    }
  });
  it("the scan really reads the repo (a guard that sees nothing proves nothing)", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.rel === "src/components/shopify/MediaStrip.jsx")).toBe(true);
    // and the patterns do match a violation
    expect(/\b(setPublishMedia|appendPublishMedia|setPublishPhotos)\s*\(/.test("await setPublishMedia(pid, node, x)")).toBe(true);
    expect(ADMIN_WRITE.test("db.ref(`shopify_publish/${pid}/media`).set(x)")).toBe(true);
    expect(ADMIN_WRITE.test("db.ref(`shopify_publish/${pid}/photos/0`).update(x)")).toBe(true);
    expect(CLIENT_WRITE.test("await set(ref(database, `shopify_publish/${pid}/photos`), x)")).toBe(true);
    expect(ADMIN_WRITE.test("db.ref(`shopify_publish/${pid}/media`).once(\"value\")")).toBe(false);
    expect(MULTI_PATH_WRITE.test("update(ref(db), { [`shopify_publish/${pid}/media`]: list })")).toBe(true);
    expect(MULTI_PATH_WRITE.test("db.ref().update({ \"shopify_publish/p1/photos\": [] })")).toBe(true);
    expect(ADMIN_WRITE.test("db.ref(`shopify_publish/${pid}/mediaShopify/${id}`).set(x)")).toBe(false);
  });
});

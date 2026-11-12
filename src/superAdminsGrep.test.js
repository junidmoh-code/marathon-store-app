// No gate may compare against a literal super-admin email any more. The ONLY
// files allowed to name Junid's address are the two super-admin modules:
//   src/config/superAdmins.js       (client)
//   functions/lib/super-admins.cjs  (Cloud Functions)
// Everything in src/ and functions/ (tests excepted) must ask isSuperAdmin /
// isSuperAdminToken. A leftover "gunidmoh" or an `=== ADMIN_EMAIL`-style
// comparison anywhere else fails here.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["src/config/superAdmins.js", "functions/lib/super-admins.cjs"]);
const SKIP_DIRS = new Set(["node_modules", "__tests__", "test", "tests", "dist", ".git"]);
const CODE = /\.(js|jsx|cjs|mjs|ts|tsx)$/;
const isTest = (f) => /\.test\.|\.spec\./.test(f);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (CODE.test(e.name) && !isTest(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
  return out;
}

const FILES = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "functions"))];

describe("one super-admin list, no literal email checks", () => {
  it("walks a real tree (guards against a vacuous pass)", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain("src/config/superAdmins.js");
    expect(FILES).toContain("functions/lib/super-admins.cjs");
    expect(FILES).toContain("functions/index.js");
  });

  it('"gunidmoh" appears nowhere outside the two super-admin modules', () => {
    const offenders = FILES.filter((f) => !ALLOWED.has(f) && /gunidmoh/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no gate compares an email against ADMIN_EMAIL / OWNER_EMAIL / a literal address", () => {
    const BAD = [
      /(===|!==|==|!=)\s*(ADMIN_EMAIL|OWNER_EMAIL|MANUAL_EMAIL|DECLARED_TOTAL_EMAIL|JUNID_EMAIL|JAFER_EMAIL)\b/,
      /\b(ADMIN_EMAIL|OWNER_EMAIL|MANUAL_EMAIL|DECLARED_TOTAL_EMAIL|JUNID_EMAIL|JAFER_EMAIL)\s*(===|!==|==|!=)/,
      /\bemail\s*(===|!==|==|!=)\s*["'`][^"'`]+@gmail\.com["'`]/i,
      /jafermohammed340/i,
    ];
    const offenders = [];
    for (const f of FILES) {
      if (ALLOWED.has(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => { if (BAD.some((re) => re.test(l))) offenders.push(`${f}:${i + 1}: ${l.trim()}`); });
    }
    expect(offenders).toEqual([]);
  });
});

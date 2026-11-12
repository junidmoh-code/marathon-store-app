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
      /\bemail\s*(===|!==|==|!=)\s*["'`][^"'`]+@[^"'`]+["'`]/i,
      // A one-address list is a literal check in disguise: [JUNID_EMAIL].includes(x)
      /\[\s*[A-Za-z_$.]*EMAIL[A-Za-z_$]*\s*\]\s*\.includes\(/,
      /\[\s*["'`][^"'`\],]+@[^"'`\],]+["'`]\s*\]\s*\.includes\(/,
      /jafermohammed340/i,
    ];
    const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const offenders = [];
    for (const f of FILES) {
      if (ALLOWED.has(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => { if (!isComment(l) && BAD.some((re) => re.test(l))) offenders.push(`${f}:${i + 1}: ${l.trim()}`); });
    }
    expect(offenders).toEqual([]);
  });

  // JUNID_EMAIL / JAFER_EMAIL name ONE person each. A gate built on either one
  // (however it is spelled) would pass every other test, so outside the two
  // list modules they may appear only where a single person is genuinely meant:
  // the digest's mail recipient and the assistant's memory path.
  it("JUNID_EMAIL / JAFER_EMAIL appear only on the allow-listed lines", () => {
    const ALLOW_LINE = {
      "functions/lib/writeoff-digest.cjs": [/^const MAIL_TO = require\(".\/super-admins\.cjs"\)\.JUNID_EMAIL;/],
      "functions/index.js": [
        /^const \{ JUNID_EMAIL, SUPER_ADMIN_EMAILS, isSuperAdmin \} = require\(".\/lib\/super-admins\.cjs"\);$/,
        /db\.ref\(`aiAssistant\/memory\/\$\{JUNID_EMAIL\.split\("@"\)\[0\]\}\/businessContext`\)/,
      ],
    };
    const offenders = [];
    for (const f of FILES) {
      if (ALLOWED.has(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/\b(JUNID_EMAIL|JAFER_EMAIL)\b/.test(l)) return;
        const t = l.trim();
        if ((ALLOW_LINE[f] || []).some((re) => re.test(t))) return;
        offenders.push(`${f}:${i + 1}: ${t}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ─── EVERY RULES-VALIDATED TIMESTAMP USES THE SERVER-CORRECTED CLOCK ─────────
// This is not a style rule. The live RTDB rules validate timestamps against the
// SERVER clock — `fetchedAt <= now + 86400000` and equivalents — so a tablet
// running fast produces a write that is SILENTLY REJECTED. The operator sees a
// save that appears to succeed and a field that never lands, with no error
// anywhere. This shop has already lost a day of order numbers to a till with a
// wrong clock, which is why src/utils/serverTime.js exists at all.
//
// The audit, recorded as an executable check so a future timestamp cannot be
// added on the device clock without this failing:
//
//   FIELD                  WRITTEN BY                         CLOCK
//   styleCodeFetchedAt     StyleCodeGate.jsx (client)         serverNowMs()  ✅ fixed here
//   claimedAt              styleCodeClaim.js ← App.jsx        serverNowMs()  ✅
//   capturedAt             styleCodeCapture.js ← DisplayChecks serverNowMs() ✅
//   fetchedAt              style-code-providers.cjs (server)  server Date.now() ✅
//   detectedAt             resolveStyleCode.js (server)       server Date.now() ✅
//   claimedAt (backfill)   processCapture.js (server)         server Date.now() ✅
//
// Server-side `Date.now()` IS the server clock and is correct by definition.
// Only CLIENT code must go through the anchor.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

// Client files that write a timestamp into a rules-validated field.
const CLIENT_TIMESTAMP_WRITERS = [
  "components/admin/StyleCodeGate.jsx",
  "utils/styleCodeClaim.js",
  "utils/styleCodeCapture.js",
  "pages/DisplayChecks/StyleCodeCapture.jsx",
];

const TIMESTAMP_FIELDS = /(styleCodeFetchedAt|claimedAt|capturedAt|detectedAt|fetchedAt)\s*:/;

describe("rules-validated timestamps never come from the device clock", () => {
  it.each(CLIENT_TIMESTAMP_WRITERS)("%s uses serverNowMs(), never Date.now()", (file) => {
    const src = read(file);
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line])
      // Ignore comments — the audit table above mentions Date.now() on purpose.
      .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(([, line]) => /Date\.now\(\)/.test(line));
    expect(offenders).toEqual([]);
  });

  it("StyleCodeGate stamps styleCodeFetchedAt from the anchor", () => {
    const src = read("components/admin/StyleCodeGate.jsx");
    expect(src).toMatch(/styleCodeFetchedAt:\s*serverNowMs\(\)/);
    expect(src).toMatch(/from "\.\.\/\.\.\/utils\/serverTime"/);
  });

  it("every client timestamp write site is covered by this audit", () => {
    // Guard against a NEW client file writing one of these fields without being
    // added to the list above — the audit would otherwise silently stop
    // covering the feature as it grows.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
    const styleCodeFiles = walk(SRC).filter((f) => {
      const s = fs.readFileSync(f, "utf8");
      return TIMESTAMP_FIELDS.test(s) && /styleCode/i.test(s);
    });
    const covered = CLIENT_TIMESTAMP_WRITERS.map((f) => path.join(SRC, f));
    const uncovered = styleCodeFiles.filter((f) => !covered.includes(f));
    expect(uncovered).toEqual([]);
  });
});

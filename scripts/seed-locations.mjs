#!/usr/bin/env node
// ─── SEED /locations ──────────────────────────────────────────────────────────
// Writes the canonical stock-location registry to RTDB /locations. This is the
// FIRST live cutover step, run BEFORE the rules deploy: the /stock_movements
// from/to validation (root.child('locations').child(<id>).exists()) and the app's
// useLocations() both read this node — until it's seeded every stock write is
// rejected and the location pickers fall back to the bundled defaults.
//
// SOURCE OF TRUTH: imports DEFAULT_LOCATIONS from the app itself, so the seed can
// never drift from what Set Qty / transfers / Locator reference.
//
// AUTH: uses a Google OAuth access token (gcloud), which authenticates as a project
// admin and BYPASSES security rules — so it works before the rules deploy and
// regardless of the /locations write rule (stockRole==admin). Set GOOGLE_ACCESS_TOKEN
// to override, else it shells out to `gcloud auth print-access-token`.
//
// SAFE BY DEFAULT: dry-run unless --commit. Uses PATCH (merge), so it only sets
// these location keys and never clobbers anything else already under /locations.
//
//   node scripts/seed-locations.mjs            # DRY RUN — prints what it would write
//   node scripts/seed-locations.mjs --commit   # actually writes /locations

import { execSync } from "node:child_process";
import { DEFAULT_LOCATIONS } from "../src/components/stock/locations.js";

const RTDB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const COMMIT = process.argv.includes("--commit");

// Keyed by id — exactly the shape useLocations() reads, and enough for the
// /stock_movements from/to existence check.
const payload = Object.fromEntries(
  DEFAULT_LOCATIONS.map((l) => [
    l.id,
    { id: l.id, label: l.label, kind: l.kind, sellable: l.sellable, active: l.active },
  ])
);

function token() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN.trim();
  try {
    return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  } catch {
    console.error("No access token: set GOOGLE_ACCESS_TOKEN or run `gcloud auth login`.");
    process.exit(1);
  }
}

console.log(`/locations seed — ${DEFAULT_LOCATIONS.length} locations:`);
for (const l of DEFAULT_LOCATIONS) {
  console.log(`  ${l.id.padEnd(14)} ${l.kind.padEnd(10)} ${l.sellable ? "sellable" : "        "}  "${l.label}"`);
}
console.log("\nPayload:\n" + JSON.stringify(payload, null, 2));

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Would PATCH (merge) → ${RTDB}/locations.json`);
  console.log("Re-run with --commit to write.");
  process.exit(0);
}

const res = await fetch(`${RTDB}/locations.json?access_token=${token()}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
if (!res.ok) {
  console.error(`PATCH failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  process.exit(1);
}
console.log(`\n✓ Wrote ${Object.keys(payload).length} locations to /locations.`);

const check = await fetch(`${RTDB}/locations.json?shallow=true&access_token=${token()}`);
console.log("Live /locations keys now:", Object.keys((await check.json()) || {}).join(", "));

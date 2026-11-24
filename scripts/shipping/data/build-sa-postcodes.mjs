#!/usr/bin/env node
// ── Rebuilds the two South African postal-code tables addressCheck.mjs reads ──
//
//   node scripts/shipping/data/build-sa-postcodes.mjs
//
// SOURCES (both public, fetched as-is; nothing is edited by hand):
//   sa-postcodes.tsv        The South African Post Office's own domestic postal-code list,
//                           https://www.postoffice.co.za/questions/postalcodes.txt (linked from
//                           https://www.postoffice.co.za/questions/postalcode.html). One row per suburb/place:
//                           place  box code  street code  town  place (Afrikaans)  town (Afrikaans).
//   sa-postcode-points.tsv  GeoNames' postal-code export for South Africa, https://download.geonames.org/export/zip/ZA.zip
//                           (© GeoNames, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/): code  name  lat  lng.
//                           It gives each code a map point (and a few more place names, e.g. "Cape Town" for 7441).
//
// Fetched 24 Nov 2026 for the address safety gate (Junid: "No Courier Guy booking unless the waybill's suburb, town and
// postal code match the customer's address").
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAPO_URL = "https://www.postoffice.co.za/questions/postalcodes.txt";
const GEONAMES_URL = "https://download.geonames.org/export/zip/ZA.zip";

/** One CSV line of the SAPO file ("a","b",…) → fields. Pure. */
export function csvFields(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();
const code4 = (s) => (/^\d{1,4}$/.test(clean(s)) ? clean(s).padStart(4, "0") : "");

async function main() {
  const sapo = await (await fetch(SAPO_URL)).text();
  const lines = sapo.split(/\r?\n/).filter(Boolean);
  const head = csvFields(lines[0]);
  const at = (name) => head.indexOf(name);
  const [iPlace, iBox, iStr, iTown, iLapP, iLapT] = ["PlaceName", "BoxCode", "StrCode", "Town", "LAPLace", "LAPTown"].map(at);
  if ([iPlace, iBox, iStr, iTown].some((i) => i < 0)) throw new Error(`unexpected SAPO header: ${lines[0].slice(0, 200)}`);
  const rows = new Set();
  for (const line of lines.slice(1)) {
    const f = csvFields(line);
    const row = [clean(f[iPlace]), code4(f[iBox]), code4(f[iStr]), clean(f[iTown]), clean(f[iLapP]), clean(f[iLapT])];
    if (!row[0] || (!row[1] && !row[2])) continue;
    rows.add(row.join("\t"));
  }
  const sapoOut = ["# SA Post Office domestic postal codes, " + SAPO_URL + " (fetched " + new Date().toISOString().slice(0, 10) + ")", "# place\tbox\tstreet\ttown\tplace_af\ttown_af", ...[...rows].sort()].join("\n") + "\n";
  writeFileSync(join(HERE, "sa-postcodes.tsv"), sapoOut);

  const dir = mkdtempSync(join(tmpdir(), "geonames-za-"));
  const zip = join(dir, "ZA.zip");
  writeFileSync(zip, Buffer.from(await (await fetch(GEONAMES_URL)).arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip, "ZA.txt", "-d", dir]);
  const pts = new Set();
  for (const line of readFileSync(join(dir, "ZA.txt"), "utf8").split(/\r?\n/)) {
    const f = line.split("\t");
    const code = code4(f[1]);
    const lat = Number(f[9]), lng = Number(f[10]);
    if (!code || !clean(f[2]) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    pts.add([code, clean(f[2]), lat.toFixed(4), lng.toFixed(4)].join("\t"));
  }
  const geoOut = ["# GeoNames postal codes for South Africa, " + GEONAMES_URL + " (CC BY 4.0, (c) GeoNames; fetched " + new Date().toISOString().slice(0, 10) + ")", "# code\tname\tlat\tlng", ...[...pts].sort()].join("\n") + "\n";
  writeFileSync(join(HERE, "sa-postcode-points.tsv"), geoOut);
  console.log(`sa-postcodes.tsv: ${rows.size} rows; sa-postcode-points.tsv: ${pts.size} rows`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

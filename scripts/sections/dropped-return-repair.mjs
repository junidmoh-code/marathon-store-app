#!/usr/bin/env node
// ─── DROPPED RETURN REPAIR — RUNNER ──────────────────────────────────────────
//
//   node scripts/sections/dropped-return-repair.mjs --list FILE           DRY RUN
//   node scripts/sections/dropped-return-repair.mjs --list FILE --apply   restock
//
// FILE is the JSON list written by dropped-returns.mjs (--json), kept OUTSIDE
// this public repo because it names real products and POS records. The report
// is written beside it.
//
// READS: single keys only — each product's `mergedInto` and one shallow
// existence check, the one cell each restock touches, and the small repair log.
//
// WRITES (--apply only): per restock, ONE multi-path update — the cell, a NEW
// `return` movement (reason "sections-dropped-return-repair", linked to the
// original POS record) and the repair-log entry. No original record is edited
// or deleted. Idempotent: the movement id and log key derive from the record,
// product and size, and a logged line is never planned again.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDroppedRepair, buildRestockUpdate, unitsByLocation, LOG_ROOT, REPAIR_REASON } from "./dropped-return-repair-core.mjs";

const require = createRequire(import.meta.url);
const reg = require("../../functions/lib/network-registry.cjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes("--apply");
const LIST = opt("--list", null);
if (!LIST) { console.error("--list FILE is required (from dropped-returns.mjs --json)"); process.exit(2); }
const OUT = opt("--out", join(dirname(LIST), "dropped-return-repair.md"));
if (OUT.startsWith(ROOT) || LIST.startsWith(ROOT)) throw new Error("the list and the report name real products and records — keep them outside this (public) repo");
const ACTOR = REPAIR_REASON;

function accessToken() {
  const cfg = JSON.parse(readFileSync(join(process.env.HOME, ".config/configstore/firebase-tools.json"), "utf8"));
  const out = execFileSync("curl", ["-s", "https://oauth2.googleapis.com/token",
    "-d", "grant_type=refresh_token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  const tok = JSON.parse(out).access_token;
  if (!tok) throw new Error("could not get an access token from the Firebase CLI login");
  return tok;
}
const auth = ["-H", `Authorization: Bearer ${accessToken()}`];
function getJson(path, params = []) {
  const args = ["-s", "-G", `${DB}/${path}.json`, ...auth];
  for (const [k, v] of params) args.push("--data-urlencode", `${k}=${v}`);
  const j = JSON.parse(execFileSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  if (j && typeof j === "object" && j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
function patchRoot(updates) {
  const out = execFileSync("curl", ["-s", "-X", "PATCH", `${DB}/.json`, ...auth, "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { encoding: "utf8", input: JSON.stringify(updates) });
  const j = JSON.parse(out);
  if (j && j.error) throw new Error(`write refused: ${j.error}`);
}

const { dropped } = JSON.parse(readFileSync(LIST, "utf8"));
const registry = reg.normalizeNetwork(getJson("network"));
const products = {};
for (const pid of new Set(dropped.map((d) => d.productId))) {
  const mergedInto = getJson(`products/${pid}/mergedInto`);
  if (typeof mergedInto === "string" && mergedInto) {
    // follow the pointer once more in case the survivor was itself merged
    const next = getJson(`products/${mergedInto}/mergedInto`);
    products[pid] = { survivor: typeof next === "string" && next ? next : mergedInto };
    continue;
  }
  const shallow = getJson(`products/${pid}`, [["shallow", "true"]]);
  products[pid] = shallow && typeof shallow === "object" && Object.keys(shallow).length ? true : null;
}
const log = getJson(LOG_ROOT) || {};
const plan = planDroppedRepair({ dropped, products, log, registry });

const applied = [];
const failed = [];
if (APPLY) {
  for (const r of plan.restocks) {
    if (getJson(`${LOG_ROOT}/${r.logKey}/status`) === "done") continue;                       // re-checked live
    if (getJson(`stock_movements/${r.movementId}/qty`) != null) continue;                     // the movement already exists
    const path = `stock/${r.to}/${r.productId}/${r.sizeKey}`;
    const cell = getJson(path);
    const before = Number(cell?.qty) || 0;
    try {
      patchRoot(buildRestockUpdate(r, { cell, nowIso: new Date().toISOString(), actor: ACTOR }));
      const after = Number(getJson(`${path}/qty`)) || 0;
      applied.push({ ...r, before, after });
    } catch (e) {
      failed.push({ ...r, why: String(e.message || e) });
    }
  }
}

const name = (loc) => reg.locationName(registry, loc);
const day = (ms) => (ms ? new Date(Number(ms) + 2 * 3600e3).toISOString().slice(0, 10) : "?");
const shopName = (s) => name(s);
const list = APPLY ? applied : plan.restocks;
const md = [
  "# Dropped return repair",
  "",
  `${APPLY ? "APPLIED" : "DRY RUN — nothing was written to the database"}. Generated ${new Date().toISOString()} by \`scripts/sections/dropped-return-repair.mjs\`.`,
  "",
  "| | lines | units |",
  "|---|---|---|",
  `| Dropped lines in the list | ${dropped.length} | ${dropped.reduce((t, d) => t + (Number(d.qty) || 0), 0)} |`,
  `| ${APPLY ? "Restocked" : "To restock"} | ${list.length} | ${list.reduce((t, r) => t + r.qty, 0)} |`,
  `| Set aside (not restocked) | ${plan.setAside.length} | ${plan.setAside.reduce((t, r) => t + r.qty, 0)} |`,
  `| Already repaired on an earlier run | ${plan.alreadyRepaired.length} | |`,
  ...(APPLY ? [`| Failed at write | ${failed.length} | |`] : []),
  "",
  `## Units ${APPLY ? "restocked" : "to restock"} per location`,
  "",
  "| location | units |",
  "|---|---|",
  ...Object.entries(unitsByLocation(list)).map(([loc, n]) => `| ${name(loc)} | ${n} |`),
  "",
  `## ${APPLY ? "Restocked" : "To restock"}`,
  "",
  `| product | size | units | date | taken at | kind | restocked to | rule |${APPLY ? " cell before → after |" : ""} POS record |`,
  `|---|---|---|---|---|---|---|---|${APPLY ? "---|" : ""}---|`,
  ...list.map((r) => `| ${r.name}${r.bookedUnder ? " (booked under its merge survivor)" : ""} | ${r.size ?? "one size"} | ${r.qty} | ${day(r.at)} | ${shopName(r.storeId)} | ${r.kind} | ${name(r.to)} | ${r.rule} |${APPLY ? ` ${r.before} → ${r.after} |` : ""} \`${r.recordId}\` |`),
  "",
  "## Set aside",
  "",
  plan.setAside.length ? ["| product | size | units | date | taken at | kind | why | POS record |", "|---|---|---|---|---|---|---|---|",
    ...plan.setAside.map((r) => `| ${r.name} | ${r.size ?? "one size"} | ${r.qty} | ${day(r.at)} | ${shopName(r.storeId)} | ${r.kind} | ${r.why} | \`${r.recordId}\` |`)].join("\n") : "None.",
  "",
  ...(failed.length ? ["## Failed at write", "", ...failed.map((r) => `- ${r.name} ${r.size}: ${r.why}`), ""] : []),
].join("\n");
writeFileSync(OUT, md);
console.log(JSON.stringify({ apply: APPLY, dropped: dropped.length, toRestock: plan.restocks.length, applied: applied.length, failed: failed.length, setAside: plan.setAside.map((s) => s.why), alreadyRepaired: plan.alreadyRepaired.length, perLocation: unitsByLocation(list), report: OUT }, null, 1));
if (APPLY && failed.length) process.exit(1);

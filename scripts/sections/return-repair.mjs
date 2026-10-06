#!/usr/bin/env node
// ─── SECTIONS RETURN REPAIR — RUNNER ─────────────────────────────────────────
//
//   node scripts/sections/return-repair.mjs            DRY RUN. Writes nothing
//                                                      to the database; writes
//                                                      the report (see --out).
//
// THE REPORT NAMES REAL PRODUCTS AND POS RECORDS, and this repo is public: it
// is written OUTSIDE the repo, to ~/Documents/sections-private/ unless --out
// says otherwise. Never commit it.
//   node scripts/sections/return-repair.mjs --apply    applies the plan, then
//                                                      verifies totals.
//   --weeks N      window (default 8)      --today YYYY-MM-DD   end of window
//
// READS, all bounded — no whole-node read:
//   /stock_movements   by the `ts` index, ONE DAY per request, across the window
//   /pos/sales/{id}    only the records behind a Section 1 return
//   /stock_movements/sold:{sale}:{loc}:{pid}:{size}   single keys, to find the
//                      cell the original sale deducted
//   /stock/{loc}/{pid}/{size}   only the cells a move would touch
//   /network, /sections_repair/returns   two small nodes
//
// WRITES (--apply only): per move, ONE multi-path update — both stock cells, a
// NEW movement (reason "sections-return-repair", linking the original return)
// and the repair-log entry. The original return movement and the POS record
// are never edited or deleted. Idempotent: the movement id and the log key are
// functions of the return movement, and a logged return is never planned again.
//
// Talks to RTDB over REST through curl with the Firebase CLI's own login: on
// this Mac node cannot reach Google and curl can.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planRepair, buildMoveUpdate, cellKey, soldKey, originalSaleIdsFor, unitsByProductSizeHub, LOG_ROOT, REPAIR_REASON } from "./return-repair-core.mjs";

const require = createRequire(import.meta.url);
const reg = require("../../functions/lib/network-registry.cjs");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes("--apply");
const WEEKS = Number(opt("--weeks", 8));
const TODAY = opt("--today", new Date().toISOString().slice(0, 10));
const ACTOR = "sections-return-repair";

function accessToken() {
  const cfg = JSON.parse(readFileSync(join(process.env.HOME, ".config/configstore/firebase-tools.json"), "utf8"));
  // The Firebase CLI's public OAuth client (embedded in firebase-tools).
  const out = execFileSync("curl", ["-s", "https://oauth2.googleapis.com/token",
    "-d", "grant_type=refresh_token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  const tok = JSON.parse(out).access_token;
  if (!tok) throw new Error("could not get an access token from the Firebase CLI login");
  return tok;
}
const TOKEN = accessToken();
const auth = ["-H", `Authorization: Bearer ${TOKEN}`];

function getJson(path, params = []) {
  const args = ["-s", "-G", `${DB}/${path}.json`, ...auth];
  for (const [k, v] of params) args.push("--data-urlencode", `${k}=${v}`);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (j && typeof j === "object" && j.error) throw new Error(`${path}: ${j.error}`);
  return j;
}
function patchRoot(updates) {
  const out = execFileSync("curl", ["-s", "-X", "PATCH", `${DB}/.json`, ...auth, "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { encoding: "utf8", input: JSON.stringify(updates) });
  const j = JSON.parse(out);
  if (j && j.error) throw new Error(`write refused: ${j.error}`);
}
const enc = (s) => String(s).replace(/\./g, "_");

// ── gather ───────────────────────────────────────────────────────────────────
const registry = reg.normalizeNetwork(getJson("network"));
const endMs = Date.parse(`${TODAY}T00:00:00.000Z`) + 864e5;
const startMs = endMs - WEEKS * 7 * 864e5;
const returns = [];
let scanned = 0;
for (let t = startMs; t < endMs; t += 864e5) {
  const a = new Date(t).toISOString(), b = new Date(t + 864e5).toISOString();
  const day = getJson("stock_movements", [["orderBy", '"ts"'], ["startAt", `"${a}"`], ["endAt", `"${b}"`]]) || {};
  for (const [mvId, m] of Object.entries(day)) {
    scanned++;
    if (!m || m.type !== "return" || m.reason === REPAIR_REASON) continue;
    if (m.ts >= b) continue;                                   // endAt is inclusive; the next day owns it
    if (reg.sectionOf(registry, m.to) !== 1) continue;
    returns.push({ mvId, recordId: m.link?.saleId ?? mvId.split(":")[1], productId: m.productId, size: m.size, qty: m.qty, to: m.to, ts: m.ts });
  }
}
const records = {};
for (const id of new Set(returns.map((r) => r.recordId))) records[id] = getJson(`pos/sales/${id}`);

const probeLocs = reg.listLocations(registry, {}).map((l) => l.id);
const soldCells = {};
const cells = {};
for (const r of returns) {
  cells[cellKey(r.to, r.productId, r.size)] = Number(getJson(`stock/${r.to}/${r.productId}/${enc(r.size)}/qty`)) || 0;
  for (const saleId of originalSaleIdsFor(r, records[r.recordId])) {
    const k = soldKey(saleId, r.productId, r.size);
    if (k in soldCells) continue;
    const hits = probeLocs.filter((loc) => getJson(`stock_movements/sold:${saleId}:${loc}:${r.productId}:${enc(r.size)}/qty`) != null);
    soldCells[k] = hits.length === 1 ? hits[0] : hits.length ? hits.join(", ") : null;
  }
}
const log = getJson(LOG_ROOT) || {};
const plan = planRepair({ returns, records, soldCells, cells, log, registry });

// ── apply ────────────────────────────────────────────────────────────────────
const applied = [];
const refusedAtWrite = [];
if (APPLY) {
  for (const move of plan.moves) {
    const sk = enc(move.size);
    if (getJson(`${LOG_ROOT}/${move.logKey}/status`) === "done") continue;       // re-checked live
    const fromCell = getJson(`stock/${move.from}/${move.productId}/${sk}`);
    const toCell = getJson(`stock/${move.toHub}/${move.productId}/${sk}`);
    const before = (Number(fromCell?.qty) || 0) + (Number(toCell?.qty) || 0);
    const update = buildMoveUpdate(move, { fromCell, toCell, nowIso: new Date().toISOString(), actor: ACTOR });
    if (!update) { refusedAtWrite.push({ ...move, why: "the source cell changed before the write" }); continue; }
    patchRoot(update);
    const a = Number(getJson(`stock/${move.from}/${move.productId}/${sk}/qty`)) || 0;
    const b = Number(getJson(`stock/${move.toHub}/${move.productId}/${sk}/qty`)) || 0;
    applied.push({ ...move, totalBefore: before, totalAfter: a + b, fromAfter: a, toAfter: b });
  }
}
const totalsOk = applied.every((m) => m.totalBefore === m.totalAfter);
const noNegative = applied.every((m) => m.fromAfter >= 0 && m.toAfter >= 0);

// ── report ───────────────────────────────────────────────────────────────────
const name = (loc) => reg.locationName(registry, loc);
const pname = {};
const productName = (pid) => (pname[pid] ??= getJson(`products/${pid}/name`) || pid);
const row = (m, extra = "") => `| ${productName(m.productId)} | ${m.size} | ${m.qty} | ${name(m.takenAt || "—")} | ${name(m.bookedTo)} | ${String(m.ts).slice(0, 10)} | \`${m.returnRecordId}\` | ${extra} |`;
const head = (last) => `| product | size | units | return taken at | booked to | date | return record | ${last} |\n|---|---|---|---|---|---|---|---|`;
const section = (title, list, last, f) => [`## ${title}`, "", list.length ? [head(last), ...list.map((m) => row(m, f(m)))].join("\n") : "None.", ""];
const perHub = Object.entries(unitsByProductSizeHub(plan.moves));
const md = [
  "# Sections return repair",
  "",
  `${APPLY ? "APPLIED" : "DRY RUN — nothing was written to the database"}. Generated ${new Date().toISOString()} by \`scripts/sections/return-repair.mjs\`.`,
  "",
  `Window: ${new Date(startMs).toISOString().slice(0, 10)} to ${TODAY} (${WEEKS} weeks). Stock movements scanned by date index: ${scanned}.`,
  "",
  "| | count |",
  "|---|---|",
  `| Return-type restocks booked to a Section 1 location in the window | ${returns.length} |`,
  `| …taken at a Section 1 store (correct, left alone) | ${plan.notSection2.length} |`,
  `| …taken at Marathon PE or Trophy | ${returns.length - plan.notSection2.length} |`,
  `| Moves ${APPLY ? "applied" : "proposed"} | ${APPLY ? applied.length : plan.moves.length} |`,
  `| Set aside (a): Section 1 on-hand too low to move | ${plan.shortAtSource.length} |`,
  `| Set aside (b): original sale or its Section 2 hub not determined | ${plan.undetermined.length} |`,
  `| Already repaired on an earlier run | ${plan.alreadyRepaired.length} |`,
  "",
  ...section(`Moves ${APPLY ? "applied" : "proposed"}`, APPLY ? applied : plan.moves, "to hub", (m) => name(m.toHub)),
  "## Units moved per product, size and hub", "",
  perHub.length ? ["| product | size | hub | units |", "|---|---|---|---|", ...perHub.map(([k, n]) => { const [pid, size, hub] = k.split("|"); return `| ${productName(pid)} | ${size} | ${name(hub)} | ${n} |`; })].join("\n") : "None.", "",
  ...section("Set aside (a): the Section 1 cell no longer holds the unit", plan.shortAtSource, "on hand now / would go to", (m) => `${m.onHand} / ${name(m.toHub)}`),
  ...section("Set aside (b): original sale or deduction hub not determined (no fallback applied)", plan.undetermined, "why", (m) => m.why),
  ...section("Left alone: taken at a Section 1 store", plan.notSection2, "note", () => "return and destination are both Section 1"),
  ...(APPLY ? ["## Verification", "", `- Totals across the moved cells unchanged: ${totalsOk ? "yes" : "NO"}`, `- No cell negative: ${noNegative ? "yes" : "NO"}`, `- Refused at write time (cell changed): ${refusedAtWrite.length}`, ""] : []),
].join("\n");
const OUT = opt("--out", join(process.env.HOME, "Documents/sections-private/sections-return-repair.md"));
if (OUT.startsWith(ROOT)) throw new Error("the report names real products and records — write it outside this (public) repo");
writeFileSync(OUT, md);
console.log(JSON.stringify({ apply: APPLY, scanned, section1Returns: returns.length, takenInSection1: plan.notSection2.length, moves: plan.moves.length, applied: applied.length, shortAtSource: plan.shortAtSource.length, undetermined: plan.undetermined.length, alreadyRepaired: plan.alreadyRepaired.length, totalsOk, noNegative }, null, 1));
if (APPLY && !(totalsOk && noNegative)) process.exit(1);

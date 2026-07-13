// ─── POST-MIGRATION AUDIT — the Live-Mode baseline report ─────────────────────
// (owner request 2026-07-13) Read-only. Run any time; intended right after the
// "Introduce Existing Products" migration completes, to record the baseline
// before switching to Live Mode:
//
//   node scripts/targets/post-migration-audit.mjs
//
// Prints: products managed by the engine · remaining Decision Queue items
// (new / numeric / assortment) · remaining unintroduced products · excess at
// Hub 2 / Marathon PE / Trophy · compliant (no-action) products · total active
// refill requests · outstanding backlog the engine still wants to create.
// Uses the same pure engine (lib/refill-engine.cjs) the scan runs — the
// numbers ARE what the next scan will see.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../functions/lib/refill-engine.cjs");

const PROJECT = "marathon-club";
const tmp = mkdtempSync(path.join(os.tmpdir(), "audit-"));
// -o file, not stdout: the CLI truncates large payloads on a pipe.
const fetch = (p) => {
  const f = path.join(tmp, "fetch.json");
  execFileSync("firebase", ["database:get", p, "--project", PROJECT, "-o", f], { stdio: ["ignore", "ignore", "inherit"] });
  const val = JSON.parse(readFileSync(f, "utf8"));
  rmSync(f, { force: true });
  return val || {};
};

console.error("Fetching live snapshot …");
const [config, targets, stock, products, refillRequests, openIndex, orders] = [
  "/config/refillEngine", "/stock_targets", "/stock", "/products",
  "/refill_requests", "/refill_engine/open", "/orders",
].map(fetch);

const plan = engine.computeRefillPlan({
  nowMs: Date.now(), config, targets, stock, products,
  openIndex, refillRequests, orders, movements: [], targetDecisions: fetch("/stock_targets_decisions"),
});

const dests = Object.keys(config.routes || {});
const managed = new Set();
for (const loc of dests) for (const pid of Object.keys(targets[loc] || {})) managed.add(pid);

const nt = plan.exceptions.noTarget.items;
const excessBy = (loc) => plan.exceptions.excess.items.filter((e) => e.loc === loc)
  .reduce((a, e) => ({ cells: a.cells + 1, units: a.units + e.excess }), { cells: 0, units: 0 });

const intentPids = new Set(plan.intents.map((i) => i.productId));
const missPids = new Set(plan.exceptions.missingSizes.items.map((m) => m.pid));
let compliant = 0;
for (const pid of managed) if (!intentPids.has(pid) && !missPids.has(pid)) compliant++;

const activeRequests = Object.values(refillRequests).filter((r) => r?.status === "open" && !r.shadow).length;
let openLocks = 0;
for (const byPid of Object.values(openIndex || {})) for (const bySize of Object.values(byPid || {})) openLocks += Object.keys(bySize || {}).length;

const line = (k, v) => console.log(`  ${k.padEnd(46, "·")} ${v}`);
console.log("\n═══ POST-MIGRATION BASELINE " + new Date().toISOString().slice(0, 16) + " ═══");
line("Products managed by the engine", managed.size);
line("Remaining Decision Queue items", nt.length);
line("  · brand-new supplier products", nt.filter((c) => c.isNew).length);
line("  · numeric-size manual decisions", nt.filter((c) => c.noStandard).length);
line("  · assortment leftovers (targets elsewhere)", nt.filter((c) => !c.isNew && !c.noStandard).length);
line("Remaining unintroduced (awaiting migration)", plan.exceptions.unintroduced.count);
line("Products requiring no action (compliant)", compliant);
line("Hub 2 excess (cells / units)", `${excessBy("hub2").cells} / ${excessBy("hub2").units}`);
line("Marathon PE excess (cells / units)", `${excessBy("marathon-pe").cells} / ${excessBy("marathon-pe").units}`);
line("Trophy excess (cells / units)", `${excessBy("trophy").cells} / ${excessBy("trophy").units}`);
line("Active refill requests (open, non-shadow)", activeRequests);
line("Engine open-intent locks", openLocks);
line("Backlog the next scans will still create", plan.intents.length + (plan.errors.find((e) => e.includes("circuit breaker")) ? " (breaker-paced)" : ""));
line("Below-target cells / missing-size reorders", `${plan.exceptions.belowTarget.count} / ${plan.exceptions.missingSizes.count}`);
console.log("═".repeat(58));

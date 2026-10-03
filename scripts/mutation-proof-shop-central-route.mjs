// ─── SHOP ← CENTRAL RULE — mutation proof of every guard ─────────────────────
// Each mutation breaks ONE guard of the owner rule "a shop never refills from
// Central once its hub has held the product" (functions/lib/shop-source-rule.cjs
// and where the engine, the scan, the trigger and the repair apply it) and
// expects the suite to go RED. A mutation that stays GREEN is a guard no test
// protects. Run from the repo root on a CLEAN, COMMITTED tree:
//   node scripts/mutation-proof-shop-central-route.mjs
// Restores every file from the bytes it captured, never from git.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const RULE = "functions/lib/shop-source-rule.cjs";
const ENGINE = "functions/lib/refill-engine.cjs";
const SCAN = "functions/refill-scan.cjs";
const TRIGGER = "functions/lib/first-batch.cjs";
const REPAIR = "scripts/repair/shop-central-route-repair.mjs";
const RULE_TESTS = ["test/shop-source-rule.test.cjs"];
const FB_TESTS = ["test/first-batch-categories.test.cjs", "test/first-batch.test.cjs", "test/first-batch-guard.test.cjs"];
const REPAIR_TESTS = ["scripts/repair/shop-central-route-repair.test.mjs"];

const MUTATIONS = [
  // ── the rule itself ───────────────────────────────────────────────────────
  { id: "M-SHOP-REGISTRY", guard: "the registry's kind 'store' makes a shop (even over a broken route)", file: RULE,
    from: `SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;`, to: `false) return true;`, nodeTests: RULE_TESTS },
  { id: "M-SHOP-KIND-FOLD", guard: "a mis-typed kind ('Store ', 'shop') still reads as a shop", file: RULE,
    from: `SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;`, to: `reg.kind === "store") return true;`, nodeTests: RULE_TESTS },
  { id: "M-SHOP-OR-SHAPE", guard: "registry OR shape — a registry 'warehouse' never hides a routed shop", file: RULE,
    from: `SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;`, to: `SHOP_KINDS.has(reg.kind.trim().toLowerCase())) return true;\n  if (reg && typeof reg === "object" && typeof reg.kind === "string") return false;`, nodeTests: RULE_TESTS },
  { id: "M-NO-CREATEDAT", guard: "a request with no createdAt is never judged", file: RULE,
    from: `  if (!rr.createdAt || !Number.isFinite(Date.parse(rr.createdAt))) return null;`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SHOP-SHAPE", guard: "without a registry, shop → hub → central is a shop", file: RULE,
    from: `return !!hub && hub !== CENTRAL && routes[hub] != null;`, to: `return false;`, nodeTests: RULE_TESTS },
  { id: "M-HUB-OWN", guard: "the shop's OWN hub, never any hub", file: RULE,
    from: `  const hub = (ctx.routes || {})[loc];\n  return hub && hub !== CENTRAL ? hub : null;`, to: `  return "hub2";`, nodeTests: RULE_TESTS },
  { id: "M-FORBID", guard: "shop ← Central is forbidden", file: RULE,
    from: `return source === CENTRAL && isShopLoc(dest, { routes, locations });`, to: `return false;`, nodeTests: RULE_TESTS },
  { id: "M-PRES-CELL", guard: "any non-later-seed cell is presence (past stock included)", file: RULE,
    from: `if (cells.some((c) => !laterSeed(c))) signals.push("stock_cell");`, to: `if (cells.some((c) => (Number(c.qty) || 0) > 0)) signals.push("stock_cell");`, nodeTests: RULE_TESTS },
  { id: "M-PRES-LATER-SEED", guard: "the Solve's own later seed is NOT presence", file: RULE,
    from: `if (cells.some((c) => !laterSeed(c))) signals.push("stock_cell");`, to: `if (cells.length) signals.push("stock_cell");`, nodeTests: RULE_TESTS },
  { id: "M-PRES-LOCK", guard: "a prior hub lock is presence", file: RULE,
    from: `if (hubLocks && typeof hubLocks === "object" && Object.values(hubLocks).some(priorLock)) signals.push("engine_lock");`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-PRES-LOCK-LATER", guard: "a later hub lock (the engine's follow-up) is NOT presence", file: RULE,
    from: `const priorLock = (e) => !!e && typeof e === "object" && !atOrAfter(e.createdAt);`, to: `const priorLock = (e) => !!e && typeof e === "object";`, nodeTests: RULE_TESTS },
  { id: "M-PRES-OPENREQ", guard: "a prior open hub request is presence", file: RULE,
    from: `    signals.push("open_hub2_request");\n`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-PRES-HELD", guard: "units held in transit to the hub are presence", file: RULE,
    from: `if (lines.some((l) => l && typeof l === "object" && l.productId === pid)) signals.push("held_inbound");`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-UNTOUCHED-NUM", guard: "a sent tranche is touched", file: RULE,
    from: `return typeof rr.sentQty === "number" && !(rr.sentQty > 0);`, to: `return !(Number(rr.sentQty) > 0);`, nodeTests: RULE_TESTS },
  { id: "M-WD-UNTOUCHED", guard: "only an untouched open request is withdrawn", file: RULE,
    from: `if (rr.status !== "open" || !requestUntouched(rr) || inFlight) return null;`, to: `if (rr.status !== "open" || inFlight) return null;`, nodeTests: RULE_TESTS },
  { id: "M-WD-INFLIGHT", guard: "a mid-pick request is never withdrawn", file: RULE,
    from: `if (rr.status !== "open" || !requestUntouched(rr) || inFlight) return null;`, to: `if (rr.status !== "open" || !requestUntouched(rr)) return null;`, nodeTests: RULE_TESTS },
  // ── the engine ────────────────────────────────────────────────────────────
  { id: "M-ENG-RECONCILE", guard: "the reconcile withdraws a shop ← Central request the hub serves", file: ENGINE,
    from: `        if (hubServes) {\n          closes.push({`, to: `        if (false) {\n          closes.push({`, nodeTests: [...RULE_TESTS, ...FB_TESTS] },
  { id: "M-ENG-REQUIRE-UNTOUCHED", guard: "the withdrawal asks the apply to re-check untouched", file: ENGINE,
    from: `            requireUntouched: true, hub: hubServes.hub, signals: hubServes.signals,`, to: `            hub: hubServes.hub, signals: hubServes.signals,`, nodeTests: [...RULE_TESTS, ...FB_TESTS] },
  { id: "M-ENG-ROUTE", guard: "a shop routed to Central is a refused route", file: ENGINE,
    from: `    if (forbiddenShopSource({ dest, source: src, routes, locations })) {\n      errors.push(`, to: `    if (false) {\n      errors.push(`, nodeTests: RULE_TESTS },
  // M-ENG-BACKSTOP is not listed: since "a routed-to location is a hub" no
  // planning branch can emit shop ← Central (deficit legs are refused per
  // destination; pass-through legs target hubs), so the intent-exit filter is
  // unreachable defence in depth — a mutant there is equivalent by construction.
  { id: "M-ENG-LOCATIONS", guard: "the engine hands the registry to the rule", file: ENGINE,
    from: `          dest, pid, entry, rr, inFlight, routes, locations,`, to: `          dest, pid, entry, rr, inFlight, routes, locations: null,`, nodeTests: RULE_TESTS },
  { id: "M-ENG-MOVED", guard: "a movement linked to an untouched request is a pick in flight — for every close", file: ENGINE,
    from: `        const inFlight = inFlightPlanGen || inFlightLedger || inFlightMidWrite || inFlightPicking;`, to: `        const inFlight = inFlightPlanGen || inFlightLedger || inFlightPicking;`, nodeTests: RULE_TESTS },
  { id: "M-ENG-LOCKLESS-WD", guard: "a lock-less shop ← Central row is withdrawn when the hub held it", file: ENGINE,
    from: `        if (hubServes) {\n          satisfiedClosures.push({`, to: `        if (false) {\n          satisfiedClosures.push({`, nodeTests: RULE_TESTS },
  { id: "M-ENG-LOCKLESS-INBOUND", guard: "a lock-less shop ← Central row is inbound (nothing asks beside it)", file: ENGINE,
    from: `    bump(inbound, \`\${r.requestingLocation}|\${r.productId}|\${sk}\`, Math.max(num(r.qty) || 1, 1));`, to: ``, nodeTests: [...RULE_TESTS, ...FB_TESTS] },
  // ── the scan's apply ──────────────────────────────────────────────────────
  { id: "M-SCAN-TXN", guard: "the close transaction refuses a touched request", file: SCAN,
    from: `  if (c.requireUntouched && !requestUntouched(cur)) return;`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-KEEP-LOCK", guard: "a refused withdrawal keeps its lock", file: SCAN,
    from: `            if (c.requireUntouched && !(res && res.committed)) { if (res?.snapshot?.val()?.status === "open") refusedHubPresent.push(c); continue; }`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-REGISTRY", guard: "the scan passes /locations to the engine", file: SCAN,
    from: `retryState, heldLines, locations,\n    });`, to: `retryState, heldLines,\n    });`, nodeTests: RULE_TESTS },
  { id: "M-SCAN-SAT-UNTOUCHED", guard: "the lock-less apply refuses a touched request", file: SCAN,
    from: `        if (s.requireUntouched && !requestUntouched(cur)) return;   // a pick landed in the gap — it wins`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-DROP", guard: "a refused withdrawal drops the same pass's asks for that cell", file: SCAN,
    from: `    if (keys.has(\`\${i.dest}|\${i.productId}|\${i.sizeKey}\`)) return false;`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-DROP-FOR", guard: "…including a leg raised FOR that shop", file: SCAN,
    from: `    return !(Array.isArray(i.forDests) && i.forDests.some((d) => keys.has(\`\${d}|\${i.productId}|\${i.sizeKey}\`)));`, to: `    return true;`, nodeTests: RULE_TESTS },
  { id: "M-SHOP-ROUTED-TO", guard: "a routed-to location is a hub, never a shop", file: RULE,
    from: `  if (Object.values(routes || {}).includes(loc)) return false;`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-ENG-LOCKLESS-FALLTHROUGH", guard: "a never-held lock-less row can still be retired by stock", file: ENGINE,
    from: `            hubPresent: true, requireUntouched: true, hub: hubServes.hub, signals: hubServes.signals,\n          });\n          continue;\n        }`, to: `            hubPresent: true, requireUntouched: true, hub: hubServes.hub, signals: hubServes.signals,\n          });\n        }\n        continue;`, nodeTests: RULE_TESTS },
  { id: "M-ENG-LOCKLESS-AGE", guard: "a stale lock-less row stops holding the shop's need", file: ENGINE,
    from: `    if (!(nowMs - Date.parse(r.createdAt || 0) <= (num(config?.staleIntentHours) || 48) * 3600e3)) continue;`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-SAT-NOPROOF", guard: "a hub-present withdrawal reads no destination stock", file: SCAN,
    from: `    if (!s.deactivated && !s.hubPresent) {`, to: `    if (!s.deactivated) {`, nodeTests: RULE_TESTS },
  { id: "M-SCAN-SAT-REFUSED", guard: "a lock-less withdrawal a pick beat is reported", file: SCAN,
    from: `      else if (s.requireUntouched && res?.snapshot?.val()?.status === "open") refusedHubPresent.push(s);`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-SAT-DROP", guard: "…and the same pass's asks for it are dropped", file: SCAN,
    from: `        plan.intents = dropIntentsForRefused(plan.intents, r.refusedHubPresent);`, to: ``, nodeTests: RULE_TESTS },
  { id: "M-SCAN-OPEN-ONLY", guard: "a request resolved elsewhere is not a refusal", file: SCAN,
    from: `      else if (s.requireUntouched && res?.snapshot?.val()?.status === "open") refusedHubPresent.push(s);`, to: `      else if (s.requireUntouched) refusedHubPresent.push(s);`, nodeTests: RULE_TESTS },
  // ── the trigger ───────────────────────────────────────────────────────────
  { id: "M-TRIG-NO-LEG", guard: "the trigger raises no Hub 2 leg from a hub-present withdrawal", file: TRIGGER,
    from: `  if (resolved && rr.cancelReason === HUB2_PRESENT_REASON && !touched) {`, to: `  if (false) {`, nodeTests: FB_TESTS },
  { id: "M-TRIG-SHARED", guard: "the trigger's presence check is the shared rule", file: TRIGGER,
    from: `    hubNode: hub2Node, hubLocks: hub2Locks,`, to: `    hubNode: null, hubLocks: hub2Locks,`, nodeTests: [...FB_TESTS, ...RULE_TESTS] },
  // ── the repair ────────────────────────────────────────────────────────────
  { id: "M-REP-UNTOUCHED", guard: "the repair never withdraws a sent row", file: REPAIR,
    from: `  const withdraw = !!hub && untouched && !midPick && presence.length > 0;`, to: `  const withdraw = !!hub && presence.length > 0;`, tests: REPAIR_TESTS },
  { id: "M-REP-CAS", guard: "the repair's CAS refuses a row picked in the gap", file: REPAIR,
    from: `      if (cur.status !== "open" || !rule.requestUntouched(cur) || cur.cancelReason) return undefined;`, to: `      if (cur.status !== "open") return undefined;`, tests: REPAIR_TESTS },
  { id: "M-REP-NO-RECREATE", guard: "a deleted row is never re-created from the plan", file: REPAIR,
    from: `      if (cur === null || cur === undefined) return null;`, to: `      if (cur === null || cur === undefined) cur = p.row;`, tests: REPAIR_TESTS },
  { id: "M-REP-ORDER", guard: "a row carrying an order is left to the engine", file: REPAIR,
    from: `  const midPick = !!(order || row.createdFrom?.orderId || row.orderId);`, to: `  const midPick = !!(order && order.clothingPlanGen != null);`, tests: REPAIR_TESTS },
  { id: "M-REP-LOCK-OWN", guard: "the repair releases only the lock naming its row", file: REPAIR,
    from: `      return cur && cur.refillId === p.id ? null : undefined;`, to: `      return null;`, tests: REPAIR_TESTS },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}
function runNodeTests(files) {
  try {
    execFileSync("node", ["--test", "--test-reporter=tap", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 140)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}
function runAll(m) {
  const verdicts = [];
  if (m.tests?.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests?.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  return verdicts.includes("FAIL") ? "FAIL" : "PASS";
}

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(24)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* keep going */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
  } finally {
    restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  restored = readFileSync(m.file, "utf8") === original ? (runAll(m) === "PASS" ? "PASS" : "FAIL") : "RESTORE-MISMATCH";
  const verdict = mutated === "FAIL" && restored === "PASS" ? "PROVEN" : mutated === "PASS" ? "UNCAUGHT" : "INCONCLUSIVE";
  results.push({ ...m, mutated, restored, verdict });
  console.log(`${m.id.padEnd(24)} mutated=${String(mutated).padEnd(6)} restored=${String(restored).padEnd(6)} → ${verdict}   ${m.guard}`);
}

const proven = results.filter((r) => r.verdict === "PROVEN").length;
console.log(`\n${proven}/${results.length} guards proven.`);
if (proven !== results.length) process.exit(1);

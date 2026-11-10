// ─── MUTATION PROOF — Concrete division refill fixes (Junid, 10 Nov 2026) ────
// For each guard: reintroduce the hole, prove the suite FAILS, restore the file,
// prove it PASSES. ERROR is not FAIL; anchors must be unique; files must be
// clean before anything is touched; restore is signal-safe. Run it in a
// SEPARATE worktree (functions tests must never reach the live database: the
// emulator host is pinned to a dead port below).
//
//   node scripts/mutation-proof-concrete-division-refill.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CD = "functions/lib/concrete-division.cjs";
const ENG = "functions/lib/refill-engine.cjs";
const SSR = "functions/lib/shop-source-rule.cjs";
const SCAN = "functions/refill-scan.cjs";
const HEALTH = "src/components/stock/HealthView.jsx";
const APP = "src/App.jsx";
const TWIN = "src/components/stock/concreteDivision.js";   // shared-body twin: mutated alongside, so the parity test is not what fails
const T = (f) => `functions/test/${f}`;
const SHELF = [T("concrete-division-seated-shelf.test.cjs")];
const SEATS = [T("concrete-division-seats-history.test.cjs"), T("concrete-division.test.cjs")];
const OFF = [T("concrete-division-hub3-off.test.cjs"), T("concrete-division.test.cjs"), T("division-keeps.test.cjs")];
const AUDIT = [T("concrete-division-policy-audit.test.cjs")];
const PIN = [T("marathon-unchanged.pin.test.cjs")];

const MUTATIONS = [
  { id: "M-SEAT-ARMS", twin: true, guard: "a seat arms a shop keep past the trust mask", file: CD,
    from: "  if (isSeatedAtShop(division, dest, pid)) return true;\n", to: "", node: SHELF },
  { id: "M-RAW-SHELF", guard: "a seated shop product reads its whole (uncounted) shelf", file: ENG,
    from: "        if (rawStock[shop]?.[pid]) view[pid] = rawStock[shop][pid]; else delete view[pid];", to: "", node: SHELF },
  { id: "M-TRUST-LIFT", guard: "the deficit loop's trust check lets a seated shop cell through", file: ENG,
    from: "isSeatedHub3(loc, pid) || isSeatedShop(loc, pid) || maskTrustedCell", to: "isSeatedHub3(loc, pid) || maskTrustedCell", node: SHELF },
  { id: "M-SCAN-WRITE", guard: "the scan's write-time check exempts a seated shop intent", file: CD,
    from: "  return intent.seatedShop === true && DIVISION_SHOPS.includes(dest);", to: "  return false;", node: SHELF },
  { id: "M-SCAN-CALL", guard: "the scan asks the shared predicate at the write", file: SCAN,
    from: "!cellOk && !concreteDivision.seatedIntentTrusted(intent, dest)", to: "!cellOk", node: SHELF },
  { id: "M-ZERO-SEATS", guard: "a cell at zero seats a product", file: CD,
    from: "      if (!units && !hasCell(node[pid]) && !activity) continue;", to: "      if (!units && !activity) continue;", node: SEATS },
  { id: "M-HISTORY-SEATS", guard: "a sale/arrival since 30 Oct seats a product with no cell", file: CD,
    from: "    for (const k of lastSeating.keys()) if (k.startsWith(`${loc}|`)) candidates.add(k.slice(loc.length + 1));\n", to: "", node: SEATS },
  { id: "M-SINCE", guard: "a movement before 30 Oct seats nothing", file: CD,
    from: "  if (!m || String(m.ts) < SEAT_HISTORY_SINCE) return false;", to: "  if (!m) return false;", node: SEATS },
  { id: "M-MOVED-OUT", guard: "a product moved out is not re-seated off its zero cells", file: CD,
    from: "        if (movedOut(loc, pid, node[pid])) continue;\n", to: "", node: SEATS },
  { id: "M-TOMBSTONE", guard: "a release tombstone holds after the move ages out", file: CD,
    from: "        if (divisionIsObj(tomb) && !(activity && activity > String(tomb.at || \"\"))) continue;\n", to: "", node: SEATS },
  { id: "M-KEEP-ON", twin: true, guard: "keep ON: Hub 3 serves every size", file: CD,
    from: "  if (division.policy?.hub3Keep?.on) return true;\n", to: "", node: OFF },
  { id: "M-PER-SIZE", twin: true, guard: "keep OFF: Hub 3 serves only a size it holds", file: CD,
    from: "  return hub3HoldsSize(division, pid, size);\n}", to: "  return true;\n}", node: OFF },
  { id: "M-INBOUND", twin: true, guard: "a size on its way into Hub 3 waits for it", file: CD,
    from: "  if (division?.hub3Inbound && typeof division.hub3Inbound.has === \"function\" && division.hub3Inbound.has(`${pid}|${enc}`)) return true;\n", to: "", node: OFF },
  { id: "M-MEMO", guard: "the route memo keeps product-level and one-size apart", file: ENG,
    from: "size === undefined ? \"\\u0000\" : `=${size}`", to: "size === undefined ? \"\" : String(size)", node: OFF },
  { id: "M-WITHDRAW", guard: "a Central line for a size Hub 3 lacks is not withdrawn", file: SSR,
    from: "ctx.routing.sourceFor(loc, ctx.product, ctx.pid, ctx.size)", to: "ctx.routing.sourceFor(loc, ctx.product, ctx.pid)", node: OFF },
  { id: "M-AUDIT-NUMBER", guard: "the audit flags a keep armed with the wrong numbers", file: CD,
    from: "  if (eff.target !== expected.target || rpE !== rpA) return { ok: false, reason: \"wrong_number\" };", to: "", node: AUDIT },
  { id: "M-AUDIT-OFF", guard: "a Seating switch-off counts as correct", file: CD,
    from: "  if (explicitZero) return { ok: true, reason: \"switched_off\" };", to: "", node: AUDIT },
  { id: "M-MARATHON-FIRST", guard: "Marathon is dealt the run's cap before the division", file: ENG,
    from: "    const first = dealFairly(list.filter((i) => !isSolvedDest(i)), cap);\n    return [...first, ...dealFairly(list.filter(isSolvedDest), Math.max(0, cap - first.length))];",
    to: "    return dealFairly(list, cap);", node: PIN },
  // ── review fixes (PR #884) ──
  { id: "M-SHOP-GATE", guard: "a division shop is not dropped on its product-level route", file: ENG,
    from: "      if (!srcAny && !(division && DIVISION_SHOPS.includes(dest))) continue;", to: "      if (!srcAny) continue;", node: OFF },
  { id: "M-TOMB-LEDGER", guard: "a product moved out before tombstones existed gets one", file: CD,
    from: "          if (!divisionIsObj(gone[pid])) releaseWrites[`${loc}/${pid}`] = { at: nowIso, moveTs: out ? String(out.ts) : null };\n", to: "", node: SEATS },
  { id: "M-CELL-STAMP", guard: "a cell stamped by a transfer out (ledger aged out) is not re-seated", file: CD,
    from: "        const stamped = !out && !activity && cellsSayMovedOut(node[pid]);", to: "        const stamped = false;", node: SEATS },
  { id: "M-COUNTED-HUB3", guard: "Hub 3 'holds' a size only in its counted view", file: ENG,
    from: "refillRequests: snapshot.refillRequests, hub3View: stock[DIVISION_HUB], nowMs });", to: "refillRequests: snapshot.refillRequests, nowMs });", node: OFF },
  { id: "M-STALE-INBOUND", guard: "a box into Hub 3 older than the stale window stops holding the size", file: CD, twin: true,
    from: "  const fresh = (iso) => nowMs == null || (Number.isFinite(Date.parse(iso)) && nowMs - Date.parse(iso) <= maxAgeMs);", to: "  const fresh = () => true;", node: OFF },
  { id: "M-JUNID-NUMBERS", guard: "the audit's expected keeps are Junid's, not the key's", file: CD,
    from: "  shopOnly: Object.freeze({ perSize: 2, oneSize: 5, askAt: null }),", to: "  shopOnly: Object.freeze({ perSize: 3, oneSize: 5, askAt: null }),", node: AUDIT },
  { id: "M-UNROUTED", guard: "an unrouted keep is a mismatch, not 'kept'", file: ENG,
    from: "          const unrouted = loc !== DIVISION_HUB && !!expected && !explicitZero && !srcOf(loc, pid, size);", to: "          const unrouted = false;", node: AUDIT },
  { id: "M-EXPLICIT-VERDICT", guard: "an explicit row is always named explicit_row", file: CD,
    from: 'reason: eff.source === "explicit" ? "explicit_row" : "wrong_number" };', to: 'reason: "wrong_number" };', node: AUDIT },
  { id: "M-HEALTH-CARD", guard: "Health draws the division audit the scan writes", file: HEALTH,
    from: "      case \"divisionPolicy\": {", to: "      case \"divisionPolicyX\": {", vitest: ["src/components/stock/healthDivisionPolicy.test.js"] },
  { id: "M-HUB3-SCREEN", guard: "Source → Hub 3 mounts the hub refill screen", file: APP,
    from: ": sectionTabLoc[tab] === \"hub3\"\n            ? hubTabContent(\"hub3\")", to: ": false\n            ? hubTabContent(\"hub3\")", vitest: ["src/hub3RefillScreen.pin.test.js"] },
];

function runNode(files) {
  try {
    execFileSync("node", ["--test", ...files], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9" } });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 140)})`;
  }
}
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
const run = (m) => (m.vitest ? runVitest(m.vitest) : runNode(m.node));

{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", TWIN, ...new Set(MUTATIONS.map((m) => m.file))]).toString().trim();
  if (dirty) { console.error("Working tree is not clean for the files this harness mutates:\n" + dirty); process.exit(2); }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ id: m.id, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(17)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better */ } };
  const twinOriginal = m.twin ? readFileSync(TWIN, "utf8") : null;
  if (m.twin && twinOriginal.split(m.from).length - 1 !== 1) { console.log(`${m.id.padEnd(17)} TWIN ANCHOR not unique`); results.push({ id: m.id, mutated: "TWIN-ANCHOR", restored: "-" }); continue; }
  const restoreTwin = () => { if (m.twin) try { writeFileSync(TWIN, twinOriginal); } catch { /* nothing better */ } };
  const onSignal = () => { restore(); restoreTwin(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    if (m.twin) writeFileSync(TWIN, twinOriginal.replace(m.from, m.to));
    mutated = run(m);
  } finally {
    restore();
    restoreTwin();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const restored = run(m);
  results.push({ id: m.id, mutated, restored });
  const ok = mutated === "FAIL" && restored === "PASS";
  console.log(`${m.id.padEnd(17)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${ok ? "✓ guard proven" : "✗ NOT PROVEN"} — ${m.guard}`);
}
const bad = results.filter((r) => !(r.mutated === "FAIL" && r.restored === "PASS"));
if (bad.length) { console.error(`\n${bad.length} guard(s) NOT proven: ${bad.map((r) => r.id).join(", ")}`); process.exit(1); }
console.log(`\nAll ${results.length} guards proven: every mutation fails the suite, every restore passes it.`);

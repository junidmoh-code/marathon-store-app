// ─── MUTATION PROOF — Concrete division refill (Junid, 10 Nov 2026; 12 Nov model) ─
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
const CC = [T("concrete-division-central-clothing.test.cjs"), T("concrete-division.test.cjs"), T("division-keeps.test.cjs")];
const XFER = ["scripts/lib/hub3ClothingTransfer.test.mjs"];
const WRITE = "functions/lib/category-policy-write.cjs";
const XLIB = "scripts/lib/hub3ClothingTransfer.mjs";
const RP = [T("concrete-division-release-perfume.test.cjs")];
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
    from: "        const out = movedOut(loc, pid, node[pid]);", to: "        const out = null;", node: SEATS },
  { id: "M-TOMBSTONE", guard: "a release tombstone holds after the move ages out", file: CD,
    from: "        if (divisionIsObj(tomb) && !(activity && activity > String(tomb.at || \"\"))) continue;\n", to: "", node: SEATS },
  { id: "M-AUDIT-NUMBER", guard: "the audit flags a keep armed with the wrong numbers", file: CD,
    from: "  const differs = eff.target !== expected.target || rpE !== rpA;", to: "  const differs = false;", node: AUDIT },
  { id: "M-AUDIT-OFF", guard: "a Seating switch-off counts as correct", file: CD,
    from: "  if (explicitZero) return { ok: true, reason: \"switched_off\" };", to: "", node: AUDIT },
  { id: "M-MARATHON-FIRST", guard: "Marathon is dealt the run's cap before the division", file: ENG,
    from: "    const first = dealFairly(list.filter((i) => !isSolvedDest(i)), cap);\n    return [...first, ...dealFairly(list.filter(isSolvedDest), Math.max(0, cap - first.length))];",
    to: "    return dealFairly(list, cap);", node: PIN },
  // ── review fixes (PR #884) ──
  { id: "M-TOMB-LEDGER", guard: "a product moved out before tombstones existed gets one", file: CD,
    from: "          if (!divisionIsObj(gone[pid])) releaseWrites[`${loc}/${pid}`] = { at: nowIso, moveTs: out ? String(out.ts) : null };\n", to: "", node: SEATS },
  { id: "M-CELL-STAMP", guard: "a cell stamped by a transfer out (ledger aged out) is not re-seated", file: CD,
    from: "        const stamped = !out && !activity && cellsSayMovedOut(node[pid]);", to: "        const stamped = false;", node: SEATS },
  { id: "M-JUNID-NUMBERS", guard: "the audit's expected keeps are Junid's, not the key's", file: CD,
    from: "  shopOnly: Object.freeze({ perSize: 2, oneSize: 5, askAt: null }),", to: "  shopOnly: Object.freeze({ perSize: 3, oneSize: 5, askAt: null }),", node: AUDIT },
  { id: "M-UNROUTED", guard: "an unrouted keep is a mismatch, not 'kept'", file: ENG,
    from: "          const unrouted = loc !== DIVISION_HUB && !!expected && !explicitZero && !srcOf(loc, pid, size);", to: "          const unrouted = false;", node: AUDIT },
  { id: "M-EXPLICIT-VERDICT", guard: "an explicit row is always named explicit_row", file: CD,
    from: 'reason: eff.source === "explicit" ? "explicit_row" : "wrong_number" };', to: 'reason: "wrong_number" };', node: AUDIT },
  // ── full release + perfume (10 Nov follow-up) ──
  { id: "M-DIVISION-CAP", guard: "division non-sneakers are released past the 75 lever", file: ENG,
    from: "  const plannedClothing = divisionSet.size\n", to: "  const plannedClothing = false\n", node: [T("concrete-division-release-perfume.test.cjs")] },
  { id: "M-DIVISION-CEILING", guard: "past 500 the division is paced", file: ENG,
    from: "const plannedDivisionClothing = divisionSet.size ? dealFairly(divisionClothing, maxDivisionIntents) : [];", to: "const plannedDivisionClothing = divisionSet.size ? divisionClothing : [];", node: [T("concrete-division-release-perfume.test.cjs")] },
  { id: "M-NEVER-KEEPS", guard: "Concrete resolves no perfume target from any branch", file: ENG,
    from: "  if (divisionNeverKeeps(dest, products?.[pid]) || (division && hub3Refuses(dest, products?.[pid]))) return null;\n", to: "  if (division && hub3Refuses(dest, products?.[pid])) return null;\n", node: RP },
  { id: "M-NEVER-SEAT", guard: "Concrete never seats perfume, and unseats it", file: CD,
    from: "      if (products && products[pid] && divisionRefuses(loc, products[pid])) {", to: "      if (products && products[pid] && hub3Refuses(loc, products[pid])) {", node: RP },
  { id: "M-SEAT-ONLY", guard: "with seats handed in, an unseated counted cell arms nothing", file: CD, twin: true,
    from: "  if (division && divisionIsObj(division.seats?.[dest])) return false;\n", to: "", node: [T("concrete-division-release-perfume.test.cjs")] },
  { id: "M-SCOPE", guard: "the division-only run applies no Marathon work", file: SCAN,
    from: "  for (const k of PLAN_WORK_LISTS) if (Array.isArray(plan[k])) plan[k] = plan[k].filter(mine);", to: "", node: [T("concrete-division-release-perfume.test.cjs")] },
  { id: "M-LOCKLESS-NEVER", guard: "a lock-less open Concrete perfume row is withdrawn", file: ENG,
    from: "      if (divisionNeverKeeps(dest, products?.[r.productId]) || (division && hub3Refuses(dest, products?.[r.productId]))) {", to: "      if (division && hub3Refuses(dest, products?.[r.productId])) {", node: RP },
  { id: "M-APPLY-ORDER", guard: "every Marathon line is applied before the division's release", file: ENG,
    from: "  const plannedIntents = [...plannedClothing, ...plannedFootwear, ...plannedDivisionClothing];", to: "  const plannedIntents = [...plannedClothing, ...plannedDivisionClothing, ...plannedFootwear];", node: [T("concrete-division-release-perfume.test.cjs")] },
  { id: "M-SEAT-REFUSE", guard: "a hand-made Seat for a perfume at Concrete is refused", file: CD,
    from: "  if (divisionRefuses(location, product)) {\n    throw", to: "  if (hub3Refuses(location, product)) {\n    throw", node: RP },
  { id: "M-HEALTH-CARD", guard: "Health draws the division audit the scan writes", file: HEALTH,
    from: "      case \"divisionPolicy\": {", to: "      case \"divisionPolicyX\": {", vitest: ["src/components/stock/healthDivisionPolicy.test.js"] },
  { id: "M-HUB3-SCREEN", guard: "Source → Hub 3 mounts the hub refill screen", file: APP,
    from: ": sectionTabLoc[tab] === \"hub3\"\n            ? hubTabContent(\"hub3\")", to: ": false\n            ? hubTabContent(\"hub3\")", vitest: ["src/hub3RefillScreen.pin.test.js"] },
  // ── the 12 Nov 2026 model: Pine/Concrete non-footwear from Central, Hub 3 sneakers only ──
  { id: "M-HUB3-REFUSES", twin: true, guard: "Hub 3 refuses every non-footwear item", file: CD,
    from: "  return loc === DIVISION_HUB && !!product && !isDivisionFootwear(product);", to: "  return false;", node: CC },
  { id: "M-HUB3-ABOVE-ROW", guard: "Hub 3 non-footwear resolves nothing even under an explicit row", file: ENG,
    from: "  if (divisionNeverKeeps(dest, products?.[pid]) || (division && hub3Refuses(dest, products?.[pid]))) return null;", to: "  if (divisionNeverKeeps(dest, products?.[pid])) return null;", node: [T("concrete-division.test.cjs")] },
  { id: "M-HUB3-KEY-GATE", guard: "with the division key off, Hub 3's older routes come back whole", file: ENG,
    from: "  if (divisionNeverKeeps(dest, products?.[pid]) || (division && hub3Refuses(dest, products?.[pid]))) return null;", to: "  if (divisionNeverKeeps(dest, products?.[pid]) || hub3Refuses(dest, products?.[pid])) return null;", node: [T("sections-policy-template.test.cjs"), T("first-batch-sections.test.cjs")] },
  { id: "M-HUB3-SEAT", guard: "Hub 3 is never seated with a non-footwear item", file: CD,
    from: "      if (products && divisionRefuses(loc, products[pid])) continue;", to: "      if (products && divisionNeverKeeps(loc, products[pid])) continue;", node: [T("concrete-division.test.cjs")] },
  { id: "M-HUB3-UNSEAT", guard: "an old Hub 3 non-footwear seat comes off", file: CD,
    from: "      if (products && products[pid] && divisionRefuses(loc, products[pid])) {", to: "      if (products && products[pid] && divisionNeverKeeps(loc, products[pid])) {", node: [T("concrete-division.test.cjs")] },
  { id: "M-HUB3-SOLVE", guard: "seatDivisionSolve refuses a non-footwear item at Hub 3", file: CD,
    from: "  if (divisionRefuses(location, product)) {\n    throw", to: "  if (divisionNeverKeeps(location, product)) {\n    throw", node: [T("concrete-division.test.cjs")] },
  { id: "M-NO-OWNER", guard: "a seat has no owning shop", file: CD,
    from: "  if (owner !== undefined && owner !== null) {\n    throw", to: "  if (false) {\n    throw", node: [T("concrete-division.test.cjs")] },
  { id: "M-SOURCE-CENTRAL", twin: true, guard: "a shop's non-footwear source is Central", file: CD,
    from: "  if (!division || !DIVISION_SHOPS.includes(dest) || !product || isDivisionFootwear(product)) return undefined;\n  return central;", to: "  if (!division || !DIVISION_SHOPS.includes(dest) || !product || isDivisionFootwear(product)) return undefined;\n  return DIVISION_HUB;", node: CC },
  { id: "M-SHOP-KEEP", twin: true, guard: "the shop keep is 2 per size / 5 per design", file: CD,
    from: "  return divisionTargetShape(isDivisionOneSize(product) ? policy.shopOnly.oneSize : policy.shopOnly.perSize);", to: "  return divisionTargetShape(isDivisionOneSize(product) ? policy.shopOnly.oneSize : 1);", node: CC },
  { id: "M-LOCKLESS-HUB3", guard: "a lock-less Hub 3 non-footwear row is withdrawn as never kept there", file: ENG,
    from: "      if (divisionNeverKeeps(dest, products?.[r.productId]) || (division && hub3Refuses(dest, products?.[r.productId]))) {", to: "      if (divisionNeverKeeps(dest, products?.[r.productId])) {", node: [T("concrete-division.test.cjs")] },
  { id: "M-AUDIT-HUB3-NF", guard: "the audit expects nothing of Hub 3 non-footwear", file: CD,
    from: "  if (loc === DIVISION_HUB) return footwear ? { ...HUB3_SNEAKER_KEEP } : null;", to: "  if (loc === DIVISION_HUB) return { ...HUB3_SNEAKER_KEEP };", node: AUDIT },
  { id: "M-AUDIT-HUB3-TWO", guard: "the audit expects Hub 3 sneakers at 2, ask at 1", file: CD,
    from: "const HUB3_SNEAKER_KEEP = Object.freeze({ target: 2, reorderPoint: 1 });", to: "const HUB3_SNEAKER_KEEP = Object.freeze({ target: 3, reorderPoint: 1 });", node: AUDIT },
  { id: "M-WRITE-SHOP-ONLY", guard: "setConcreteDivision refuses the old Hub 3 fields", file: WRITE,
    from: "      if (!n || !onlyShop) {", to: "      if (!n) {", node: [T("concrete-division-central-clothing.test.cjs")] },
  { id: "M-T-FOOTWEAR", guard: "the transfer never touches footwear", file: XLIB,
    from: "    if (isFootwear(product)) { footwearKept.push(pid); continue; }", to: "    if (false) { footwearKept.push(pid); continue; }", vitest: XFER },
  { id: "M-T-PERFUME", guard: "a perfume moves but is never seated at Concrete", file: XLIB,
    from: "        if (product && dv.divisionRefuses(DEST, product)) perfumes.add(pid); else if (product) seatOn.add(pid);", to: "        if (product) seatOn.add(pid);", vitest: XFER },
  { id: "M-T-FULL-QTY", guard: "a positive cell moves in full", file: XLIB,
    from: "        transfers.push({ ...base, qty: q, movementId: transferIdFor(runId, pid, sizeKey) });", to: "        transfers.push({ ...base, qty: Math.max(1, q - 1), movementId: transferIdFor(runId, pid, sizeKey) });", vitest: XFER },
  { id: "M-T-RACE", guard: "a cell that moved since the read is re-planned at its new qty", file: XLIB,
    from: "    if (r.reason !== \"insufficient_stock\") return { ...c, moved: 0, refused: r.reason, r };", to: "    return { ...c, moved: 0, refused: r.reason, r };", vitest: XFER },
  { id: "M-T-VERIFY", guard: "verify moves an arrival in the gap and still ends footwear-only", file: XLIB,
    from: "      if (l.qty > 0) {\n        const r = await moveCell(", to: "      if (false) {\n        const r = await moveCell(", vitest: XFER },
  { id: "M-T-UNTOUCHED", guard: "a picked request is never withdrawn", file: XLIB,
    from: "    if (!requestUntouched(cur, Date.parse(nowIso))) { outcome = \"touched\"; return undefined; }", to: "", vitest: XFER },
  { id: "M-T-ROW-SHAPE", guard: "only the retired from-Hub 3 rows are edited", file: XLIB,
    from: "        const retired = r.reorderPoint === RETIRED_FROM_HUB3.askAt && r.target === (one ? RETIRED_FROM_HUB3.oneSize : RETIRED_FROM_HUB3.perSize);", to: "        const retired = r.target > 0;", vitest: XFER },
  { id: "M-T-RELEASE-SCOPE", guard: "the one-off release never touches a Marathon line", file: XLIB,
    from: "!r.earlyRelease && dv.DIVISION_LOCATIONS.includes(r.requestingLocation) && String", to: "!r.earlyRelease && String", vitest: XFER },
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

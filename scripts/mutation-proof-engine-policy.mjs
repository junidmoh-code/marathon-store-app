// ─── MUTATION PROOF — the Engine Policy gates and guards ─────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the
// file, prove it PASSES. A test that cannot fail proves nothing, so this runs
// the whole cycle and refuses to report a pass it did not watch break first.
//
// THE BRIEF ASKED FOR THIS EXPLICITLY: "Mutation-prove each of the three gates
// separately: deleting any one of them fails tests." Three gates, three
// mutations, and each one is deleted with the OTHER TWO LEFT INTACT — which is
// the only way "three independent gates" means anything. If deleting the tile
// were only caught because the route also refuses, there would be one gate
// wearing three hats.
//
//   M-TILE       delete the home tile's gate               (App.jsx)
//   M-ROUTE      delete the route's gate                   (App.jsx)
//   M-COMPONENT  delete the component's own gate           (EnginePolicyCard.jsx)
//   M-SERVER     delete the server-side owner check        (category-policy-write.cjs)
//   M-SERVER-2   delete the CALL to it, leaving it defined (the subtler deletion)
//   M-DRIFT      delete the pre-mutation drift check       (category-policy-write.cjs)
//   M-DRIFT-2    delete the fail-fast drift check          (category-policy-write.cjs)
//   M-HISTORY    write the audit entry AFTER the mutation  (the rollback ordering)
//   M-PREVIEW    let Save fire without a matching preview  (enginePolicyCore.js)
//   M-CARRIAGE   let an uncarried location be edited       (enginePolicyCore.js)
//   M-BLANK      turn a blank "Ask at" into 0              (enginePolicyCore.js)
//   M-SOURCE     drop the model's source-availability gate (category-policy.cjs)
//   M-ARMED-ROW  drop an armed non-destination's editor row (enginePolicyCore.js)
//
// The last two are not access gates and earn their place anyway. Without
// M-SOURCE the model reported 293 day-one requests where the real engine
// creates 0 — the difference between shipping a change and abandoning it.
// M-ARMED-ROW guards a DATA-LOSS path: a save writes the whole entry with
// .set(), so a location the editor never rendered is deleted by it, and the
// drift check cannot notice because live still matches what was rendered.
//
// Same discipline as scripts/mutation-proof-hold-notify.mjs — ERROR is not
// FAIL, anchors must be unique, restore is signal-safe, and the tree must be
// clean before anything is touched.
//
// Run: node scripts/mutation-proof-engine-policy.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "src/App.jsx";
const CARD = "src/components/stock/EnginePolicyCard.jsx";
const CORE = "src/components/stock/enginePolicyCore.js";
const MODEL = "functions/lib/category-policy.cjs";
const WRITE = "functions/lib/category-policy-write.cjs";
const FUNCTIONS = "functions/index.js";
const ACTIONS = "src/components/stock/SeatingActions.jsx";

const GATE_TESTS = ["src/components/stock/enginePolicyGates.test.jsx"];
const SEAT_TESTS = ["src/components/stock/seatingWriteGate.test.jsx"];
const CORE_TESTS = ["src/components/stock/enginePolicyCore.test.js"];
const SERVER_TESTS = ["test/category-policy-write.test.cjs"];

const MUTATIONS = [
  // ── GATE 1: the home tile ─────────────────────────────────────────────────
  {
    id: "M-TILE",
    guard: "GATE 1 — the home tile does not render for anyone but the owner",
    file: APP,
    from: `      enginePolicyVisibleForViewer(enginePolicyViewer) && { key:"engine_policy"`,
    to: `      true && { key:"engine_policy"`,
    tests: GATE_TESTS,
  },
  {
    id: "M-TILE-2",
    guard: "GATE 1 — the tile reads the flag MIRROR, not the permissions array the server cannot see",
    file: APP,
    from: `  const enginePolicyViewer = { email: homeUser?.email, permFlags: homePerm?.permFlags };`,
    to: `  const enginePolicyViewer = { email: homeUser?.email, permissions: homePerm?.permissions };`,
    tests: GATE_TESTS,
  },
  // ── GATE 2: the route ─────────────────────────────────────────────────────
  {
    id: "M-ROUTE",
    guard: "GATE 2 — the route refuses to mount the card for anyone but the owner",
    file: APP,
    from: `  else if (role === ROLES.ENGINE_POLICY) view = enginePolicyVisibleForViewer({ email: authUser?.email, permFlags: permRecord?.permFlags })
    ? <EnginePolicyCard viewer={{ email: authUser?.email, permFlags: permRecord?.permFlags, stockRole: permRecord?.stockRole }} products={products} onExit={() => setRole(null)} />
    : <AdminSignInScreen onCancel={() => setRole(null)} />;`,
    to: `  else if (role === ROLES.ENGINE_POLICY) view = <EnginePolicyCard viewer={{ email: authUser?.email, permFlags: permRecord?.permFlags, stockRole: permRecord?.stockRole }} products={products} onExit={() => setRole(null)} />;`,
    tests: GATE_TESTS,
  },
  // ── GATE 2b: the component's own check ────────────────────────────────────
  // Deleted with the route gate LEFT INTACT: this is the test that the two are
  // genuinely independent rather than one gate reported twice.
  {
    id: "M-COMPONENT",
    guard: "GATE 2b — the component refuses on its own, opening no listener and firing no callable",
    file: CARD,
    from: `  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;`,
    to: ``,
    tests: GATE_TESTS,
  },
  {
    id: "M-HOOKS",
    guard: "GATE 2b — the gate holds ZERO hooks, so a refused viewer starts nothing",
    file: CARD,
    from: `export default function EnginePolicyCard({ viewer, products, onExit }) {
  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;`,
    to: `export default function EnginePolicyCard({ viewer, products, onExit }) {
  const [x] = useState(0);   // MUTATION: a hook above the gate
  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;`,
    tests: GATE_TESTS,
  },
  // ── GATE 3a: the callable WRAPPER ─────────────────────────────────────────
  // Deleted with the write module's own check LEFT INTACT — the test that the
  // two server checks are genuinely independent rather than one reported twice.
  // Until PR #469 nothing proved this side at all, and the comment beside it
  // claimed the gate "survives a refactor of either side". (Sonnet review.)
  {
    id: "M-WRAPPER",
    guard: "GATE 3a — the callable's own check is CALLED, not just the module's",
    file: FUNCTIONS,
    from: `    await assertEnginePolicy(request);`,
    to: ``,
    tests: GATE_TESTS,
  },
  {
    id: "M-WRAPPER-AWAIT",
    guard: "GATE 3a — …and it is AWAITED, not left as a floating promise",
    file: FUNCTIONS,
    from: `    await assertEnginePolicy(request);`,
    to: `    assertEnginePolicy(request);`,
    tests: GATE_TESTS,
  },
  {
    id: "M-WRAPPER-FLAG",
    guard: "GATE 3a — the callable reads the same scalar the client does, and fails closed on a read error",
    file: FUNCTIONS,
    from: `    granted = snap.val() === true;
  } catch (err) {
    console.error("assertEnginePolicy: permission read failed:", err.message);
    throw new HttpsError("unavailable", "Could not check permissions. Try again.");`,
    to: `    granted = snap.val() === true;
  } catch (err) {
    console.error("assertEnginePolicy: permission read failed:", err.message);
    granted = true;`,
    tests: GATE_TESTS,
  },
  // ── THE SEATING TAB'S OWN WRITES ──────────────────────────────────────────
  // Not a gate on the screen — a gate on three buttons that write RTDB directly
  // and would otherwise fail at the database for a grantee with no stockRole.
  {
    id: "M-SEATING",
    guard: "The seating buttons ask what the RULES ask before offering the write",
    file: ACTIONS,
    from: `  const canWrite = enginePolicySeatingWritable(viewer);
  if (!canWrite) {`,
    to: `  const canWrite = enginePolicySeatingWritable(viewer);
  if (false) {`,
    tests: SEAT_TESTS,
  },
  {
    id: "M-SEATING-ROLE",
    guard: "…and it is stockRole 'admin', not merely HAVING a stockRole (/stock_targets asks for admin)",
    file: "src/config/enginePolicy.js",
    from: `  return viewer.stockRole === "admin";`,
    to: `  return !!viewer.stockRole;`,
    tests: SEAT_TESTS,
  },
  // ── GATE 3: the server ────────────────────────────────────────────────────
  {
    id: "M-SERVER",
    guard: "GATE 3 — an account WITHOUT the engine_policy flag is refused",
    file: WRITE,
    from: `  if (!granted) throw httpsError("permission-denied", "Engine Policy permission required.");`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-SERVER-FLAG",
    guard: "GATE 3 — the grant is the boolean true, not anything truthy that lands in the field",
    file: WRITE,
    from: `    granted = snap.val() === true;`,
    to: `    granted = !!snap.val();`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-SERVER-OWNER",
    guard: "GATE 3 — the owner clause is an EQUALITY on the owner's email, not \"any caller who has one\"",
    file: WRITE,
    from: `  if (typeof callerEmail === "string" && callerEmail === adminEmail) return;`,
    to: `  if (typeof callerEmail === "string" && callerEmail) return;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-SERVER-2",
    guard: "GATE 3 — the check is CALLED, not merely defined (the deletion that looks like a refactor)",
    file: WRITE,
    from: `  await assertEnginePolicyCaller({ db, callerEmail, callerUid, adminEmail });

  const d = data && typeof data === "object" ? data : {};`,
    to: `  const d = data && typeof data === "object" ? data : {};`,
    nodeTests: SERVER_TESTS,
  },
  // ── THE DRIFT CHECKS ──────────────────────────────────────────────────────
  {
    id: "M-DRIFT",
    guard: "A change landing mid-save aborts the write — the check immediately before the mutation",
    file: WRITE,
    // The preceding read is part of the anchor. The bare `if` line stopped
    // being unique the moment the GROUP write path gained the same
    // check — its four-space-indented copy CONTAINS the two-space text, so the
    // harness reported ANCHOR-AMBIGUOUS and credited nothing. Reported, not
    // silently skipped, which is the only reason it was caught. (PR #401.)
    from: `  const liveNow = await val(db, \`\${POLICY_PATH}/\${categoryKey}\`);
  if (!sameValue(liveNow ?? null, before)) {`,
    to: `  const liveNow = await val(db, \`\${POLICY_PATH}/\${categoryKey}\`);
  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M-DRIFT-2",
    guard: "A stale editor is refused before anything is written at all",
    file: WRITE,
    from: `  if (!dryRun && d.expectedBefore !== undefined && !sameValue(before, d.expectedBefore === null ? null : d.expectedBefore)) {`,
    to: `  if (false) {`,
    nodeTests: SERVER_TESTS,
  },
  // ── THE ROLLBACK SNAPSHOT'S ORDERING ──────────────────────────────────────
  // A snapshot written after the mutation is one you do not have when the
  // mutation is what went wrong.
  {
    id: "M-HISTORY",
    guard: "The rollback snapshot is written BEFORE the policy is mutated",
    file: WRITE,
    from: `  const historyRef = db.ref(HISTORY_PATH).push();
  await historyRef.set({`,
    to: `  const historyRef = db.ref(HISTORY_PATH).push();
  await db.ref(\`\${POLICY_PATH}/\${categoryKey}\`).set(policyAfter);   // MUTATION: mutate first
  await historyRef.set({`,
    nodeTests: SERVER_TESTS,
  },
  // ── THE PREVIEW GATE ──────────────────────────────────────────────────────
  {
    id: "M-PREVIEW",
    guard: "Save stays off until a preview has run against the values currently on screen",
    file: CORE,
    from: `  if (!preview || preview.key !== previewKeyNow) return false;`,
    to: `  if (!preview) return false;`,
    tests: CORE_TESTS,
  },
  // ── CARRIAGE ──────────────────────────────────────────────────────────────
  {
    id: "M-CARRIAGE",
    guard: "A location that does not carry the category cannot be edited — arming it invents demand",
    file: CORE,
    from: `      editable: c.carries === true || armed.has(loc),`,
    to: `      editable: true,`,
    tests: CORE_TESTS,
  },
  // ── THE DATA-LOSS PATH ────────────────────────────────────────────────────
  // A save .set()s the whole entry, so anything missing from the editor is
  // DELETED. An armed location absent from config.mode used to get no row —
  // and editing any other location silently un-armed it, invisibly to the
  // drift check, because live still matched what had been rendered.
  {
    id: "M-ARMED-ROW",
    guard: "An armed location outside config.mode still gets an editor row, so a save cannot delete it",
    file: CORE,
    from: `  const locs = [...new Set([...(destinations || []), ...armed])];
  return locs.map((loc) => {`,
    to: `  return (destinations || []).map((loc) => {`,
    tests: CORE_TESTS,
  },
  // ── ABSENT vs ZERO ────────────────────────────────────────────────────────
  {
    id: "M-BLANK",
    guard: 'A blank "Ask at" stays ABSENT — turning it into 0 silently changes every location it touches',
    file: CORE,
    // policyFromDraft's body moved into entryFromStrings when the per-size
    // shape landed — same code, one indent level out. (PR #401.)
    from: `  const rp = numOrNull(row?.reorderPoint);
  if (rp !== null) entry.reorderPoint = rp;`,
    to: `  entry.reorderPoint = numOrNull(row?.reorderPoint) ?? 0;`,
    tests: CORE_TESTS,
  },
  // ── THE MODEL'S SOURCE GATE ───────────────────────────────────────────────
  // Not an access gate, but the difference between a preview the owner can act
  // on and one that reports 293 requests where the engine creates 0.
  {
    id: "M-SOURCE",
    guard: "The model honours the engine's actionable-only rule — no request the source cannot fill",
    file: MODEL,
    from: `        if (srcAvail <= 0) { parkedNoSource += 1; continue; }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard.
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
    // TAP is PINNED, not left to the default reporter: node 24 prints "ℹ fail 1"
    // where node 22 prints "# fail 1", and the parser below would read a real
    // failure as ERROR — silently crediting no guard at all.
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
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests && m.nodeTests.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  if (verdicts.includes("FAIL")) return "FAIL";
  return "PASS";
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    console.error("Commit first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits === 0 ? "ANCHOR-MISSING" : "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id.padEnd(12)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
    continue;
  }
  let mutated = "?", restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(12)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}

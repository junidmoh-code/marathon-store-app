// ─── MUTATION PROOF — the Seating tab's guards ────────────────────────────────
//
// For each guard: reintroduce the hole, prove the suite FAILS, restore the file,
// prove it PASSES. A green test proves nothing on its own — only a test that
// goes red when the property is broken is evidence — so this runs the whole
// cycle and refuses to report a pass it did not watch break first.
//
// THE MUTATION SHAPE IS VARIED ON PURPOSE. Deleting a line and inverting a
// condition are not the same experiment, and a guard that only survives the
// deletion is half-proved. Where a guard has more than one way to fail, it gets
// more than one mutation.
//
//   M-UNITS        let a switch-off fire over stock                (seatingStore)
//   M-UNITS-NEG    let it fire over a NEGATIVE cell                (seatingStore)
//   M-SIZES        cover only stocked sizes, as Exclude does       (seatingCore)
//   M-ATTRIB-WHO   drop the actor from the row                     (seatingStore)
//   M-ATTRIB-WHEN  swap serverNowMs() for Date.now()               (seatingStore)
//   M-ATTRIB-AUTH  write while nobody is signed in                 (seatingStore)
//   M-RESEAT-ANY   let Re-seat remove a row it did not write        (seatingStore)
//   M-RESEAT-GUESS let it guess a row whose record is missing      (seatingStore)
//   M-PREV-NULL    record "no previous row" as a null, not a flag  (seatingStore)
//   M-PRECEDENCE   drop the explicit row from the top of the order (seatingCore)
//   M-PRECEDENCE-2 evaluate footwear AFTER the clothing kill switch(seatingCore)
//   M-PRECEDENCE-3 treat a policy-level 0 as an exclusion          (seatingCore)
//   M-CARRIES      make cell existence answer quantity, not existence
//   M-DEFAULT-TICK un-tick "switch off the source" by default      (SeatingActions)
//   M-MOVE-SIGN    move a negative as if it were positive          (seatingStore)
//   M-MOVE-REREAD  switch off against the STALE plan               (seatingStore)
//   M-MOVE-WRITER  bypass applyMovement for a stock write          (seatingStore)
//   M-TRANSIT      take a Transit lane in one hop                  (seatingStore)
//   M-GATE-TAB     delete the tab's own super-admin gate           (EnginePolicyCard)
//   M-GATE-ROUTE   delete the route gate that carries products in  (App.jsx)
//   M-GATE-CARD    delete the card's own gate                      (EnginePolicyCard)
//
// ── REVIEW FIXES (PR #429) — every one of these was a real shipped bug ───────
//   M-NEST         let a second switch-off nest its own row as prevRow
//   M-OFF-REREAD   decide the units refusal on the STALE seat
//   M-OFF-VERIFY   let an unverifiable location list through
//   M-MOVE-ID      derive the movement id from the clock again
//   M-MOVE-CATCH   let a post-move throw swallow the fact stock moved
//   M-CONTEXT      feed the mirror only the seatable locations  (SeatingTab)
//   M-STABLE-LISTS key the location lists on the registry object (SeatingTab)
//   M-RESELECT     blank the screen when the same product is re-picked
//   M-STATE-FALLBACK  hash a v-less cell to one constant for ever
//   M-RESEAT-REREAD   let Re-seat trust the render-time snapshot
//
// The three gate mutations each delete ONE gate with the others left intact,
// which is the only way "independent gates" means anything.
//
// Run: node scripts/mutation-proof-seating.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "src/App.jsx";
const CARD = "src/components/stock/EnginePolicyCard.jsx";
const CORE = "src/components/stock/seatingCore.js";
const STORE = "src/components/stock/seatingStore.js";
const ACTIONS = "src/components/stock/SeatingActions.jsx";
const TAB = "src/components/stock/SeatingTab.jsx";

const CORE_TESTS = ["src/components/stock/seatingCore.test.js"];
const STORE_TESTS = ["src/components/stock/seatingStore.test.js"];
const MOVE_TESTS = ["src/components/stock/seatingMove.test.js"];
const TAB_TESTS = ["src/components/stock/seatingTab.render.test.jsx"];
const ALL_TESTS = [...CORE_TESTS, ...STORE_TESTS, ...MOVE_TESTS, ...TAB_TESTS];

const MUTATIONS = [
  // ── THE UNITS-HELD REFUSAL ────────────────────────────────────────────────
  {
    id: "M-UNITS",
    guard: "switching off refuses while the cell holds units",
    file: STORE,
    from: `  const held = seat.sizes.filter((s) => s.qty !== 0);
  if (!held.length) return null;`,
    to: `  const held = [];
  if (!held.length) return null;`,
    tests: [...STORE_TESTS, ...MOVE_TESTS],
  },
  {
    id: "M-UNITS-NEG",
    guard: "a NEGATIVE cell blocks it too — a count error is not stranded",
    file: STORE,
    from: `  const held = seat.sizes.filter((s) => s.qty !== 0);`,
    to: `  const held = seat.sizes.filter((s) => s.qty > 0);`,
    tests: STORE_TESTS,
  },
  // ── COVERAGE ──────────────────────────────────────────────────────────────
  {
    id: "M-SIZES",
    guard: "the switch-off covers every DECLARED size, not only the stocked ones",
    file: CORE,
    from: `  for (const s of productSizes(products, pid)) out.add(engineSizeKey(s));`,
    to: ``,
    tests: [...CORE_TESTS, ...STORE_TESTS],
  },
  // ── ATTRIBUTION ───────────────────────────────────────────────────────────
  {
    id: "M-ATTRIB-WHO",
    guard: "every row carries the actor uid",
    file: STORE,
    from: `    offBy: actor.uid,`,
    to: ``,
    tests: STORE_TESTS,
  },
  {
    id: "M-ATTRIB-WHEN",
    guard: "the stamp is serverNowMs(), never the browser clock",
    file: STORE,
    from: `  const at = serverNowMs();                       // never Date.now() — the tills`,
    to: `  const at = Date.now();                          // never Date.now() — the tills`,
    tests: [...STORE_TESTS, ...MOVE_TESTS],
  },
  {
    id: "M-ATTRIB-AUTH",
    guard: "an unsigned-in writer is refused outright",
    file: STORE,
    from: `  if (!uid) throw new Error("Not signed in.");`,
    to: `  if (!uid) return { uid: "unknown", email: null };`,
    tests: STORE_TESTS,
  },
  // ── REVERSIBILITY ─────────────────────────────────────────────────────────
  {
    id: "M-RESEAT-ANY",
    guard: "Re-seat never removes a row this screen did not write",
    file: STORE,
    from: `    if (r?.source !== SEATING_OFF_SOURCE) continue;`,
    to: ``,
    tests: STORE_TESTS,
  },
  {
    id: "M-RESEAT-GUESS",
    guard: "a row with no record to restore is reported, never guessed at",
    file: STORE,
    from: `    if (!r.prevRow || typeof r.prevRow !== "object") { stuck.push(sizeKey); continue; }`,
    to: `    if (!r.prevRow || typeof r.prevRow !== "object") { restore.push({ sizeKey, to: null }); continue; }`,
    tests: STORE_TESTS,
  },
  {
    id: "M-PREV-NULL",
    guard: "\"there was no row\" is a flag — RTDB deletes a key written null",
    file: STORE,
    from: `  } else row.prevRow = prev;
  } else row.prevAbsent = true;`,
    to: `  } else row.prevRow = prev;
  } else row.prevRow = null;`,
    tests: STORE_TESTS,
  },
  // ── THE PRECEDENCE ORDER ──────────────────────────────────────────────────
  {
    id: "M-PRECEDENCE",
    guard: "an explicit row is the FIRST branch and outranks everything below",
    file: CORE,
    from: `  const explicit = targets?.[dest]?.[pid]?.[engineSizeKey(size)];
  if (explicit && typeof explicit.target === "number") {`,
    to: `  const explicit = targets?.[dest]?.[pid]?.[engineSizeKey(size)];
  if (explicit && typeof explicit.target === "number" && explicit.target > 0) {`,
    tests: [...CORE_TESTS, ...STORE_TESTS],
  },
  {
    id: "M-PRECEDENCE-2",
    guard: "footwear is evaluated BEFORE the clothing kill switch — the two switches stay uncoupled",
    file: CORE,
    from: `  if (footwearTargetsEnabled(config, dest) && isFootwear(fp) && storeCarries(stock, dest, pid)) {`,
    to: `  if (false && footwearTargetsEnabled(config, dest) && isFootwear(fp) && storeCarries(stock, dest, pid)) {`,
    tests: CORE_TESTS,
  },
  {
    id: "M-PRECEDENCE-3",
    guard: "a policy-level 0 is a typo, not an exclusion (only a human's row excludes)",
    file: CORE,
    from: `  return positiveTarget(t) ? t : null;`,
    to: `  return typeof t === "number" && Number.isFinite(t) ? t : null;`,
    tests: CORE_TESTS,
  },
  {
    id: "M-CARRIES",
    guard: "carriage is cell EXISTENCE — a sold-out shelf is still a seat",
    file: CORE,
    from: `  return !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;`,
    to: `  return Object.values(stock?.[loc]?.[pid] || {}).some((c) => (c?.qty || 0) > 0);`,
    tests: [...CORE_TESTS, ...STORE_TESTS],
  },
  // ── THE DEFAULT TICK ──────────────────────────────────────────────────────
  {
    id: "M-DEFAULT-TICK",
    guard: "\"switch off the source\" is ticked by default",
    file: ACTIONS,
    from: `  const [alsoOff, setAlsoOff] = useState(true);`,
    to: `  const [alsoOff, setAlsoOff] = useState(false);`,
    tests: TAB_TESTS,
  },
  // ── THE MOVE ──────────────────────────────────────────────────────────────
  {
    id: "M-MOVE-SIGN",
    guard: "a negative is moved the other way, keeping its sign",
    file: STORE,
    from: `        from: negative ? dest : seat.loc,
        to: negative ? seat.loc : dest,`,
    to: `        from: seat.loc,
        to: dest,`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-MOVE-REREAD",
    guard: "the switch-off re-reads — a sale landing mid-move is not buried",
    file: STORE,
    from: `  const fresh = await readSeatingContext(locations, seat.pid);
  liveCtx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  liveSeat = seatingAt(liveCtx, seat.loc, seat.pid);
  seat = liveSeat; ctx = liveCtx;`,
    to: ``,
    tests: [...MOVE_TESTS, ...STORE_TESTS],
  },
  {
    id: "M-MOVE-WRITER",
    guard: "every stock write goes through applyMovement",
    file: STORE,
    from: `      res = await applyMovement({`,
    to: `      res = await (async (m) => { await update(ref(database), { [\`stock/\${m.to}/\${m.productId}/\${line.sizeKey}/qty\`]: m.qty }); return { ok: true }; })({`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-TRANSIT",
    guard: "a Transit lane is declined rather than taken in one hop",
    file: STORE,
    from: `  if (isTransitLane(from, to)) return "That lane goes through Transit — use the Transfer screen.";`,
    to: ``,
    tests: MOVE_TESTS,
  },
  // ── THE GATES — one deleted at a time, the others left intact ─────────────
  {
    id: "M-GATE-TAB",
    guard: "GATE 2c — the tab has its own super-admin check",
    file: CARD,
    from: `          enginePolicyVisibleForViewer(viewer) ? (`,
    to: `          true ? (`,
    tests: TAB_TESTS,
  },
  {
    id: "M-GATE-CARD",
    guard: "GATE 2b — the card refuses before any hook runs",
    file: CARD,
    from: `  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;`,
    to: ``,
    tests: [...TAB_TESTS, "src/components/stock/enginePolicyGates.test.jsx"],
  },
  {
    id: "M-GATE-ROUTE",
    guard: "GATE 2 — the route refuses to mount the card, products and all",
    file: APP,
    from: `  else if (role === ROLES.ENGINE_POLICY) view = enginePolicyVisibleForViewer({ email: authUser?.email })
    ? <EnginePolicyCard viewer={{ email: authUser?.email }} products={products} onExit={() => setRole(null)} />
    : <AdminSignInScreen onCancel={() => setRole(null)} />;`,
    to: `  else if (role === ROLES.ENGINE_POLICY) view = <EnginePolicyCard viewer={{ email: authUser?.email }} products={products} onExit={() => setRole(null)} />;`,
    tests: ["src/components/stock/enginePolicyGates.test.jsx"],
  },
  // ── REVIEW FIXES, PR #429 ─────────────────────────────────────────────────
  {
    id: "M-NEST",
    guard: "a second switch-off does not nest its own row — Re-seat still reaches the original",
    file: STORE,
    from: `    if (prev.source === SEATING_OFF_SOURCE) {
      if (prev.prevRow && typeof prev.prevRow === "object") row.prevRow = prev.prevRow;
      else row.prevAbsent = true;
    } else row.prevRow = prev;`,
    to: `    row.prevRow = prev;`,
    tests: STORE_TESTS,
  },
  {
    id: "M-OFF-REREAD",
    guard: "the units refusal is decided against LIVE data on the button path too",
    file: STORE,
    from: `  const fresh = await readSeatingContext(locations, seat.pid);
  liveCtx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  liveSeat = seatingAt(liveCtx, seat.loc, seat.pid);
  seat = liveSeat; ctx = liveCtx;`,
    to: ``,
    tests: STORE_TESTS,
  },
  {
    id: "M-OFF-VERIFY",
    guard: "an unverifiable location list is refused, not treated as an empty shelf",
    file: STORE,
    from: `  if (!Array.isArray(locations) || !locations.includes(seat.loc)) {
    return { ok: false, reason: "unverified" };
  }`,
    to: `  locations = Array.isArray(locations) ? locations : [];`,
    tests: STORE_TESTS,
  },
  {
    id: "M-MOVE-ID",
    guard: "the movement id is stable across presses — a double tap sends once",
    file: STORE,
    from: `  const batchId = moveBatchId(seat.pid, seat.loc, dest, lines);`,
    to: `  const batchId = \`seatmove_\${serverNowMs().toString(36)}\`;`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-MOVE-CATCH",
    guard: "a throw after the stock moved still reports that it moved",
    file: STORE,
    from: `  } catch (e) {
    return { ok: true, moved, replayed, failed, batchId, switchedOff: false,
      offReason: "error", offError: e?.message || String(e) };
  }`,
    to: `  } catch (e) {
    throw e;
  }`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-CONTEXT",
    guard: "the carriage context covers every location that can hold a cell, not only the seatable ones",
    file: TAB,
    from: `    const ctxIds = new Set(rows);
    for (const l of allLocationIds(registry)) ctxIds.add(l);`,
    to: `    const ctxIds = new Set(rows);`,
    tests: TAB_TESTS,
  },
  // ── ADVERSARIAL REVIEW FIXES, PR #429 ─────────────────────────────────────
  {
    id: "M-ONESIZE-COVER",
    guard: "a one-size category policy's \"_\" cell is covered by the switch-off",
    file: CORE,
    from: `  const cat = categoryPolicyEntry(config, products, pid, loc);
  if (cat && !cat.sizes && !cat.perSize) out.add("_");`,
    to: ``,
    tests: CORE_TESTS,
  },
  {
    id: "M-ONESIZE-MOVE",
    guard: "the no-size cell reaches applyMovement as \"_\", not a falsy \"\"",
    file: STORE,
    from: `                   v: s.v, mv: s.mv, updatedAt: s.updatedAt }));`,
    to: `                   v: s.v, mv: s.mv, updatedAt: s.updatedAt })).map((l) => ({ ...l, size: l.size === "_" ? "" : l.size }));`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-MOVE-ID-VERSION",
    guard: "the cell version is in the idempotency key — a restocked repeat still travels",
    file: STORE,
    from: `...lines.map((l) => \`\${l.sizeKey}:\${l.qty}:\${state(l)}\`)`,
    to: `...lines.map((l) => \`\${l.sizeKey}:\${l.qty}\`)`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-REPLAY",
    guard: "an idempotent replay is not counted as units moved",
    file: STORE,
    from: `    if (res.ok && res.idempotent) replayed += qty;
    else if (res.ok) moved += qty;`,
    to: `    if (res.ok) moved += qty;
    else if (false) replayed += qty;`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-NEG-LANE",
    guard: "the negative leg's REAL direction is checked against Transit",
    file: STORE,
    from: `    if (isTransitLane(to, from)) return "The negative would come back through Transit — use the Transfer screen.";`,
    to: ``,
    tests: MOVE_TESTS,
  },
  {
    id: "M-NEG-SEATS",
    guard: "a debt may not be the thing that seats a location",
    file: STORE,
    from: `    if (destSeat && !destSeat.hasCell) {
      return "That location does not carry this line — a negative cannot be the thing that seats it.";
    }`,
    to: ``,
    tests: MOVE_TESTS,
  },
  {
    id: "M-RESEAT-SHAPE",
    guard: "one unwritable prevRow does not block the whole undo",
    file: STORE,
    from: `    if (!writableRow(r.prevRow)) { stuck.push(sizeKey); continue; }`,
    to: ``,
    tests: STORE_TESTS,
  },
  {
    id: "M-STABLE-LISTS",
    guard: "the location lists are keyed on a signature — a re-render is not a re-read",
    file: TAB,
    from: `  }, [locSig]);`,
    to: `  }, [registry]);`,
    tests: TAB_TESTS,
  },
  {
    id: "M-STATE-FALLBACK",
    guard: "a cell with no version falls back to mv/updatedAt, not to one constant",
    file: STORE,
    from: `  const state = (l) => (l.v ?? l.mv ?? l.updatedAt ?? "x");`,
    to: `  const state = (l) => (l.v ?? "x");`,
    tests: MOVE_TESTS,
  },
  {
    id: "M-RESEAT-REREAD",
    guard: "Re-seat restores the row that is live now, not the one the screen rendered",
    file: STORE,
    from: `  if (Array.isArray(locations) && locations.includes(seat.loc)) {
    const fresh = await readSeatingContext(locations, seat.pid);
    ctx = { ...ctx, stock: fresh.stock, targets: fresh.targets };
  }`,
    to: ``,
    tests: MOVE_TESTS,
  },
  {
    id: "M-RESELECT",
    guard: "re-selecting the product already on screen does not blank it",
    file: TAB,
    from: `    if (nextPid && nextPid === pid) { load(nextPid); return; }`,
    to: ``,
    tests: TAB_TESTS,
  },
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

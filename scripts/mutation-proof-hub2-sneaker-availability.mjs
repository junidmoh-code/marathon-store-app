// ─── MUTATION PROOF HARNESS — Hub 2 sneaker availability ─────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-order-tomorrow.mjs — ERROR ≠ FAIL,
// unique anchors, signal-safe restore, clean-tree preflight.
//
// Three things are at stake, and two of them pull against the third.
//   HUB 2 MUST BE GATED. A Hub 2 sneaker size the hub cannot supply was
//   orderable into nothing, and a Hub 2 customer could be promised a pair
//   Central does not hold. G1 and G2 are the guards that would let either
//   silently come back.
//   NOTHING ELSE MAY MOVE. Hub 3, the shops, Hub C, Hub 2 clothing and the
//   Hub 1 display-pair lane were all correct before this change and must be
//   character-for-character correct after it: G3, G4, G5, G6, G7, G11, G12,
//   G14, G16, G18 and G19 watch one fence each.
//   AND THE DEFINITION MUST HOLD. G8, G9, G10, G13, G15 and G17 keep the
//   second hub riding the shared resolver, on its own data, with the answer
//   the staff-facing note actually renders.
//
// Run:  node scripts/mutation-proof-hub2-sneaker-availability.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CORE = "src/components/stock/availabilityCore.js";
const GATE = "src/components/stock/tomorrowGate.js";
const APP  = "src/App.jsx";

const SUITE = [
  "src/components/stock/hub2SneakerAvailability.test.js",
  "src/components/stock/hubIsolation.test.js",
  "src/components/stock/availabilityCore.test.js",
  "src/components/stock/displayPairCore.test.js",
  "src/utils/deactivation.test.js",
];

const MUTATIONS = [
  // ── "Hub 2 is gated at all" — the gap this whole change exists to close ────
  {
    id: "G1",
    guard: "The grid gate covers HUB 2 — dropping it is the bug this change fixes",
    file: CORE,
    from: `export const GATED_SNEAKER_HUBS = ["hub1", "hub2"];`,
    to: `export const GATED_SNEAKER_HUBS = ["hub1"];`,
  },
  {
    id: "G2",
    guard: "The Tomorrow gate covers HUB 2 — a promise Central cannot keep",
    file: GATE,
    from: `export const CENTRAL_FED_HUBS = ["hub1", "hub2"];`,
    to: `export const CENTRAL_FED_HUBS = ["hub1"];`,
  },

  // ── "nothing else moved" — Hub 3, the shops, Hub C ────────────────────────
  {
    id: "G3",
    guard: "HUB 3 (Pine) is NOT gated — its grid has never been and must not start",
    file: CORE,
    from: `export const GATED_SNEAKER_HUBS = ["hub1", "hub2"];`,
    to: `export const GATED_SNEAKER_HUBS = ["hub1", "hub2", "hub3"];`,
  },
  {
    id: "G4",
    guard: "A SHOP can never arm the gate — a shop is a destination, not a supplying hub",
    file: CORE,
    from: `  return GATED_SNEAKER_HUBS.includes(routedHub) ? routedHub : null;`,
    to: `  return routedHub || null;`,
  },
  {
    id: "G5",
    guard: "hub3 rows are NOT probed for Central — a hub Central may never stock would read a false Out of stock",
    file: GATE,
    from: `  if (order?.placedAtHub === "hub3" || order?.placedAtHub === "hubC") return false;`,
    to: `  if (order?.placedAtHub === "hubC") return false;`,
  },
  {
    id: "G6",
    guard: "hubC (customer clothing) rows are NOT probed either",
    file: GATE,
    from: `  if (order?.placedAtHub === "hub3" || order?.placedAtHub === "hubC") return false;`,
    to: `  if (order?.placedAtHub === "hub3") return false;`,
  },
  {
    id: "G6b",
    guard: "HUB 2 CLOTHING is NOT probed — a live, correct lane a bare hub2 disjunct swept in (caught in review)",
    file: GATE,
    from: `  return isFootwearProduct(product);                                // hub2: the seven categories, only`,
    to: `  return true;`,
  },
  {
    id: "G6c",
    guard: "HUB 2 PERFUME is not probed — the gate asks the CATEGORY, not the order's stamped type",
    file: GATE,
    // The round-2 catch: a perfume order takes the sneaker checkout branch and
    // is stamped productType "sneaker", so a type-based test swept it in.
    from: `  return isFootwearProduct(product);                                // hub2: the seven categories, only`,
    to: `  return (order?.productType || "sneaker") !== "clothing";`,
  },
  {
    id: "G6e",
    guard: "An UNKNOWN product is not probed — fail-open, because a false Out of stock messages a customer",
    file: GATE,
    from: `  return isFootwearProduct(product);                                // hub2: the seven categories, only`,
    to: `  return !product || isFootwearProduct(product);`,
  },
  {
    id: "G6d",
    guard: "HUB 1 keeps NO type test — its 2026-08-25 rule is verbatim, clothing row or not",
    file: GATE,
    from: `  if (hub === "hub1") return true;                                  // 2026-08-25, verbatim`,
    to: `  if (hub === "hub1") return (order?.productType || "sneaker") !== "clothing";`,
  },
  {
    id: "G7",
    guard: "The hub-less legacy order still defaults to hub1, never to nothing",
    file: GATE,
    from: `  const hub = order?.hub || "hub1";`,
    to: `  const hub = order?.hub;`,
  },

  // ── "the definition of available" ─────────────────────────────────────────
  {
    id: "G8",
    guard: "A NEGATIVE cell reports booked ZERO in the why-split — the ✕ note must never read \"All -2 of size 5\"",
    file: CORE,
    // The outer floor in availableUnits already makes a negative cell
    // unavailable, so mutating the clamp THERE proves nothing (it did not, and
    // this harness said so rather than crediting it). The clamp that carries
    // real weight is cellBlockInfo's: `booked` is rendered verbatim in the
    // staff-facing note, and 22 Hub 2 sneaker cells are negative right now.
    from: `  const booked = Math.max(Number(qty) || 0, 0);`,
    to: `  const booked = Number(qty) || 0;`,
  },
  {
    id: "G9",
    guard: "An OVER-promised cell floors at zero, never reports a negative",
    file: CORE,
    from: `  return Math.max(booked - spoken, 0);`,
    to: `  return booked - spoken;`,
  },
  {
    id: "G10",
    guard: "Ready promises are actually SUBTRACTED — the last pair reserved for an uncollected order is not available",
    file: CORE,
    from: `  return Math.max(booked - spoken, 0);`,
    to: `  return Math.max(booked, 0);`,
  },
  {
    id: "G11",
    guard: "Non-footwear keeps yesterday's behaviour — perfumes and bags are not modelled here (PR #446)",
    file: CORE,
    from: `  if (!isFootwearProduct(product)) return null;`,
    to: ``,
  },
  {
    id: "G12",
    guard: "Clothing never enters the sneaker gate",
    file: CORE,
    from: `  if ((product?.productType || "sneaker") === "clothing") return null;`,
    to: ``,
  },

  // ── "one path, and the fences hold" — the App wiring ──────────────────────
  {
    id: "G13",
    guard: "Hub 2 reads HUB 2's cells — pointing it at hub1's is a silent wrong answer",
    file: APP,
    from: `  const sneakerCellsState = (hub) => (hub === "hub2" ? hub2CellsState : hub1CellsState);`,
    to: `  const sneakerCellsState = () => hub1CellsState;`,
  },
  {
    id: "G14",
    guard: "Hub 2 nets READY ORDERS ONLY — a Hub 1 display-pull claim must never ✕ a Hub 2 cell",
    file: APP,
    from: `  const sneakerPromisedMap = (hub) => (hub === "hub2" ? hub2ReadyPromised : hub1Promised);`,
    to: `  const sneakerPromisedMap = () => hub1Promised;`,
  },
  {
    id: "G15",
    guard: "The gate never opens before THAT hub's subtree has settled — an unsettled map would ✕ every size",
    file: APP,
    from: `    return !!hub && st.settled && !st.error;`,
    to: `    return !!hub;`,
  },
  {
    id: "G16",
    guard: "The display-pair lane stays HUB 1's — its slots and register are hub1-scoped",
    file: APP,
    from: `  const sneakerServedByHub1 = (p) => sneakerHubOf(p) === "hub1";`,
    to: `  const sneakerServedByHub1 = (p) => !!sneakerHubOf(p);`,
  },
  {
    id: "G17",
    guard: "The ✕ note names the hub that refused — a Hub 2 shoe blamed on Hub 1 sends staff to the wrong building",
    file: APP,
    from: `    hubLabel: HUB_LABELS[hub] || hub,`,
    to: `    hubLabel: "Hub 1",`,
  },
  {
    id: "G18",
    guard: "The CLOTHING cell lookup was left alone — merging it with the sneaker key space changes live Hub 2 clothing",
    file: APP,
    from: `  const hubQty = (pid, size) => availableUnits(servingHubCells?.[pid]?.[size]?.qty);`,
    to: `  const hubQty = (pid, size) => cellAvailability({ cells: servingHubCells, promised: {}, productId: pid, size });`,
  },
  {
    id: "G19",
    guard: "An ungated row short-circuits with NO read — hub3 must not pay for a probe it can never use",
    file: APP,
    from: `    if (!gatedRow) return undefined;`,
    to: `    if (false) return undefined;`,
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
    // THE FAIL CHECK COMES FIRST, deliberately. A failing source-pin assertion
    // prints the whole of App.jsx as its diff, and App.jsx contains the words a
    // load-crash pattern looks for ("SyntaxError", "Cannot find module", …) in
    // its own error handling. Testing for the crash first read every one of
    // those source pins as ERROR and silently credited no guard at all — the
    // exact "a reworded summary must never pass for proof" failure this harness
    // exists to avoid, in reverse. Only a run that produced NO summary line at
    // all (a real load crash) can now report ERROR.
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|Failed to (load|parse)/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
{
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...new Set(MUTATIONS.map((m) => m.file))])
    .toString().trim();
  if (dirty) {
    console.error("Working tree is not clean for the files this harness mutates:\n" + dirty);
    console.error("Commit or stash first — a dirty file would be captured as the baseline.");
    process.exit(2);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits === 0) {
    results.push({ ...m, mutated: "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR NOT FOUND in ${m.file}`);
    continue;
  }
  if (hits > 1) {
    results.push({ ...m, mutated: "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id}  ANCHOR FOUND ${hits}× in ${m.file} — widen it`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  // An uncaught throw outside the try would otherwise leave the MUTATED file on
  // disk: the next run fails its clean-tree preflight, and a careless commit
  // ships the bug.
  const onCrash = (e) => { restore(); console.error("restored after crash:", e); process.exit(3); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runVitest(SUITE);
    restore();
    restored = runVitest(SUITE);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("uncaughtException", onCrash);
    process.removeListener("unhandledRejection", onCrash);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}

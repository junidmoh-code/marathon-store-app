// ─── MUTATION PROOF — the cart in the sourcing question, and the display pair ─
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same driver as mutation-proof-hub2-sneaker-availability.mjs and
// mutation-proof-alternatives.mjs: ERROR ≠ FAIL, unique anchors, signal-safe
// restore, clean-tree preflight, behavioural guards counted apart from source
// pins.
//
// ANCHOR ON THE SHORTEST UNIQUE FRAGMENT. Three guards in the previous harness
// went stale behind refactors of the very code they mutate, each time because
// the anchor carried a whole line including a comment somebody later edited.
// And RE-RUN THIS after touching any file it mutates — the test suite passing
// proves nothing here; a guard whose anchor has moved silently no-ops.
//
// TWO THINGS ARE AT STAKE.
//
//   1. A CART MUST NOT HIDE STOCK AT THE OTHER HUB. The routing answer and the
//      availability answer were computed separately from different inputs, so
//      they disagreed exactly when the cart exhausted the tagged hub. 14 live
//      cells at cart depth 1. G1-G8.
//
//   2. A DISPLAY PAIR IS AN IDENTIFIED PHYSICAL UNIT AT A NAMED HUB. Its hub is
//      a fact, and routing it is how an order to pull a Hub 1 display reaches a
//      hub with no display register. G9-G12.
//
// AND NOTHING #568 DID MAY MOVE: G13-G16 hold its rule byte-for-byte at cart
// depth 0, which is where it already worked.
//
// Run:  node scripts/mutation-proof-sourcing.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CORE = "src/components/stock/availabilityCore.js";
const APP = "src/App.jsx";

const SUITE = [
  "src/components/stock/sourcingCart.test.js",
  "src/components/stock/sourcingWiring.test.js",
  "src/components/stock/sourcingHub.test.js",
  "src/components/stock/hubIsolation.test.js",
  "src/components/stock/hub2SneakerAvailability.test.js",
  "src/components/stock/availabilityCore.test.js",
];

const MUTATIONS = [
  // ── 1. THE CART IS PART OF THE QUESTION ──────────────────────────────────
  {
    id: "G1",
    guard: "The cart is SUBTRACTED from the tagged hub — without it the tag wins on stock it has already promised to this device",
    file: CORE,
    kind: "behavioural",
    from: `  const taggedLeft = Math.max(taggedRaw - used, 0);`,
    to: `  const taggedLeft = taggedRaw;`,
  },
  {
    id: "G2",
    guard: "…and an exhausted tag actually falls through to the alternate rather than answering itself",
    file: CORE,
    kind: "behavioural",
    from: `  if (taggedLeft > 0) return { hub: taggedHub, available: taggedLeft };`,
    to: `  return { hub: taggedHub, available: taggedLeft };`,
  },
  {
    id: "G3",
    guard: "The cart drains the TAG first and only the excess spills — subtracting it from both hubs double-counts and refuses a pair that exists",
    file: CORE,
    kind: "behavioural",
    from: `  const altLeft = Math.max(altRaw - Math.max(used - taggedRaw, 0), 0);`,
    to: `  const altLeft = Math.max(altRaw - used, 0);`,
  },
  // G4 WAS HERE, AND IS GONE ON PURPOSE. It mutated the inner clamp on the
  // spill (`Math.max(used - taggedRaw, 0)`), and could not be killed: that line
  // is only reached once taggedLeft is 0, which means used >= taggedRaw, so the
  // clamp is unreachable by construction. It stays in the source as a belt
  // against a future reordering; it does NOT stay here, because a guard nothing
  // can kill is a green tick standing in for evidence — exactly what this
  // harness exists to refuse.
  {
    id: "G5",
    guard: "A junk cart count is treated as none, never as a negative credit",
    file: CORE,
    kind: "behavioural",
    from: `  const used = Math.max(Number(consumed) || 0, 0);`,
    to: `  const used = Number(consumed) || 0;`,
  },
  {
    id: "G6",
    guard: "`available` is NULL when the rule does not answer — zero would read as \"out of stock\" for every clothing line and every Pine shoe",
    file: CORE,
    kind: "behavioural",
    from: `  const NO_ANSWER = { hub: taggedHub, available: null };`,
    to: `  const NO_ANSWER = { hub: taggedHub, available: 0 };`,
  },
  {
    id: "G7",
    guard: "Silence is still not zero — an unread tagged hub answers NOTHING, whatever the cart holds",
    file: CORE,
    kind: "behavioural",
    from: `  if (!tagged?.ready) return NO_ANSWER;`,
    to: ``,
  },
  {
    id: "G8",
    guard: "An unread ALTERNATE cannot be chosen — it is silence, not stock",
    file: CORE,
    kind: "behavioural",
    from: `  if (!alt?.ready) return { hub: taggedHub, available: 0 };`,
    to: ``,
  },

  // ── 2. A DISPLAY PAIR CANNOT BE REROUTED ─────────────────────────────────
  {
    id: "G9",
    guard: "The display-pair hub is hub1 — the lane's slots and register are hub1-scoped and no other hub can act on the instruction",
    file: CORE,
    kind: "behavioural",
    from: `export const DISPLAY_PAIR_HUB = "hub1";`,
    to: `export const DISPLAY_PAIR_HUB = "hub2";`,
  },
  {
    id: "G10",
    guard: "Placement PINS a display-pair line's hub instead of resolving it",
    file: APP,
    kind: "source-pin",
    from: `          const hub = item.displayPairRequest === true
            ? DISPLAY_PAIR_HUB`,
    to: `          const hub = false
            ? DISPLAY_PAIR_HUB`,
  },
  {
    id: "G11",
    guard: "…and the pre-flight REFUSES a claim that no longer stands, rather than letting it place",
    file: APP,
    kind: "source-pin",
    from: `        && sneakerAvail(item.product.id, item.size, DISPLAY_PAIR_HUB) <= 0);`,
    to: `        && false);`,
  },
  {
    id: "G12",
    guard: "…and it returns BEFORE the checkout starts — never a half-placed order",
    file: APP,
    kind: "source-pin",
    // MUTATE THE RETURN, NOT THE MESSAGE. The first version changed a word in
    // the alert, which the test caught only because it pinned that word — it
    // proved the wording existed, not the ordering the guard claims
    // (CodeRabbit). Deleting the return is the mutation that actually lets a
    // refused checkout carry on and place.
    from: `        return;
      }
    }
    setSubmitting(true);`,
    to: `      }
    }
    setSubmitting(true);`,
  },

  {
    id: "G11b",
    guard: "The pre-flight fails CLOSED — unverifiable display data is refused, never waved through",
    file: APP,
    kind: "source-pin",
    from: `        if (!displayLaneReady || !ordersSettled) return true;      // cannot verify`,
    to: `        if (!displayLaneReady || !ordersSettled) return false;`,
  },
  {
    id: "G11c",
    guard: "…and the CLAIMED STORE must still hold one — a fresh ordinary pair must not vouch for a display that has gone",
    file: APP,
    kind: "source-pin",
    from: `        if (item.displayPairStore && !(d.stores || []).includes(item.displayPairStore)) return true;`,
    to: ``,
  },
  {
    id: "G19",
    guard: "The CHECKOUT allocates line by line — handing it the tile's whole-cart question sends a whole order to an empty hub",
    file: APP,
    kind: "source-pin",
    from: `size: item.size, hubData: sneakerHubData(), consumed: already,`,
    to: `size: item.size, hubData: sneakerHubData(), consumed: 0,`,
  },
  {
    id: "G20",
    guard: "…and each line's allocation is actually USED, rather than the hub being re-derived at write time",
    file: APP,
    kind: "source-pin",
    from: `          : (allocatedHub.get(placedIndex) || computeHubForItem(item));`,
    to: `          : computeHubForItem(item);`,
  },
  {
    id: "G21",
    guard: "sneakerDisplayOnly reads the resolver's remaining count — recomputing one subtracts the whole cart from Hub 1 for units that were never Hub 1's",
    file: APP,
    kind: "source-pin",
    from: `    if (hub !== DISPLAY_PAIR_HUB || !Number.isFinite(available)) return null;`,
    to: `    if (!Number.isFinite(available)) return null;`,
  },
  {
    id: "G22",
    guard: "The quantity clamp reads it too — recomputing double-counts the cart and silently short-fills an add",
    file: APP,
    kind: "source-pin",
    from: `      reps = Math.min(reps, Math.max(1, clampLeft));`,
    to: `      reps = Math.min(reps, Math.max(1, sneakerAvail(selected.id, pendingSize, clampHub) - sneakerInCart(selected.id, pendingSize)));`,
  },

  // ── 3. NOTHING #568 DID MAY MOVE ─────────────────────────────────────────
  {
    id: "G13",
    guard: "The TAG still wins whenever it can supply — this is not a \"pick the fuller hub\" balancer and must never become one",
    file: CORE,
    kind: "behavioural",
    from: `  if (taggedLeft > 0) return { hub: taggedHub, available: taggedLeft };`,
    to: `  if (taggedLeft > 0 && taggedLeft >= 99) return { hub: taggedHub, available: taggedLeft };`,
  },
  {
    id: "G14",
    guard: "Both hubs empty → the TAGGED hub, so the ✕ names the shelf staff should actually check",
    file: CORE,
    kind: "behavioural",
    from: `  return { hub: taggedHub, available: 0 };
}`,
    to: `  return { hub: GATED_SNEAKER_HUBS.find((h) => h !== taggedHub), available: 0 };
}`,
  },
  {
    id: "G15",
    guard: "Only a GATED sneaker is rerouted — clothing, perfume, bags and Pine keep the raw tag",
    file: CORE,
    kind: "behavioural",
    from: `  if (!gatedSneakerHub(product, taggedHub)) return NO_ANSWER;`,
    to: ``,
  },
  {
    id: "G16",
    guard: "resolveSneakerSourcingHub is still the same function — every existing caller reads the hub from the merged one",
    file: CORE,
    kind: "behavioural",
    from: `  return resolveSneakerSourcing(args).hub;`,
    to: `  return args.taggedHub;`,
  },

  // ── 4. THE SCREEN READS THE ANSWER RATHER THAN RECOMPUTING ONE ───────────
  {
    id: "G17",
    guard: "The cart goes INTO the resolver — applying it afterwards is exactly how the two answers came to disagree",
    file: APP,
    kind: "source-pin",
    from: `    consumed: p?.id ? sneakerInCart(p.id, s) : 0,`,
    to: `    consumed: 0,`,
  },
  {
    id: "G18",
    guard: "sneakerOut tests the null answer for FINITENESS — `null <= 0` is true in JavaScript",
    file: APP,
    kind: "source-pin",
    from: `Number.isFinite(available) && available <= 0;`,
    to: `available <= 0;`,
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. The FAIL
// check comes first because a failing source pin prints the whole of App.jsx as
// its diff, and App.jsx contains the words a load-crash pattern looks for in
// its own error handling.
function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
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
  const tag = m.kind === "behavioural" ? "behavioural" : "source-pin";
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  [${tag}]  — ${m.guard}`);
}

const bad = results.filter((r) => !r.proven);
const beh = results.filter((r) => r.kind === "behavioural");
const pin = results.filter((r) => r.kind === "source-pin");
console.log(`\n${results.length - bad.length}/${results.length} guards proven — ` +
  `${beh.filter((r) => r.proven).length} BEHAVIOURAL (a unit test ran the mutated code and got a wrong answer) ` +
  `+ ${pin.filter((r) => r.proven).length} SOURCE PINS (the mutation edits a pinned line, so it fails its own pin — ` +
  `this proves the wiring has not moved, NOT that the screen behaves).`);
if (bad.length) {
  console.log("NOT PROVEN:");
  for (const r of bad) console.log(`  ${r.id}  mutated:${r.mutated}  restored:${r.restored}  — ${r.guard}`);
  process.exit(1);
}

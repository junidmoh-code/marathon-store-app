// ─── MUTATION PROOF — product attributes, neighbours, and the ✕ sheet ────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-hub2-sneaker-availability.mjs, and
// the driver below is that file's, deliberately unchanged: ERROR ≠ FAIL, unique
// anchors, signal-safe restore, clean-tree preflight, and behavioural guards
// counted apart from source pins.
//
// FOUR THINGS ARE AT STAKE.
//
//   1. NOTHING UNSELLABLE REACHES A CUSTOMER. This is the whole risk of the
//      feature. An assistant who reads out a suggestion that turns out not to
//      exist has spent the customer's patience twice and learned not to trust
//      the screen — worse than the bare refusal this replaces. G1-G6.
//
//   2. THE VOCABULARY IS CLOSED AND NOTHING IS COERCED. A value corrected to
//      the nearest legal one is a wrong value that looks right, and there is no
//      manual lane to catch it. G7-G11.
//
//   3. A HUMAN CORRECTION SURVIVES EVERY RE-RUN, and a crashed run costs
//      nothing to resume. G12-G14.
//
//   4. BRAND IS A WEIGHT AND NOT A FILTER, and the silhouette wall holds.
//      The owner decision most likely to be quietly reversed, and the one
//      exclusion that keeps the list from being random. G15-G19.
//
//   5. THE CHIP STILL READS AS UNAVAILABLE WITHOUT THE ✕. G20-G22 — one per
//      axis of the container difference that replaced the glyph.
//
// AND ONE THING MUST NOT MOVE: the refusal itself. G23-G25 watch the fences
// around the X gate — tapping an unavailable size still cannot raise a refill
// request, and the reason text is unchanged.
//
// Run:  node scripts/mutation-proof-alternatives.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ATTR = "src/utils/productAttributes.js";
const NEIGH = "src/utils/productNeighbours.js";
const ALT = "src/components/stock/alternativesCore.js";
const CHIP = "src/components/stock/sizeChipTheme.js";
const APP = "src/App.jsx";

const SUITE = [
  "src/utils/productAttributes.test.js",
  "src/utils/productNeighbours.test.js",
  "src/components/stock/alternativesCore.test.js",
  "src/components/stock/sizeChipTheme.test.js",
];

const MUTATIONS = [
  // ── 1. NOTHING UNSELLABLE REACHES A CUSTOMER ─────────────────────────────
  {
    id: "G1",
    guard: "A candidate this screen cannot answer for is DROPPED — sneakerOut's false means \"no gate\", never \"in stock\"",
    file: ALT,
    kind: "behavioural",
    from: `    if (!availabilityKnown(product)) continue;`,
    to: ``,
  },
  {
    id: "G2",
    guard: "A deactivated / priceless / photoless line is never offered",
    file: ALT,
    kind: "behavioural",
    from: `    if (!isSellable(product)) continue;`,
    to: ``,
  },
  {
    id: "G3",
    guard: "Only the sizes that are ACTUALLY available are listed",
    file: ALT,
    kind: "behavioural",
    from: `    const sizes = (sizesOf(product) || []).filter((s) => sizeAvailable(product, s));`,
    to: `    const sizes = (sizesOf(product) || []);`,
  },
  {
    id: "G4",
    guard: "A product with no available size is not an alternative at all",
    file: ALT,
    kind: "behavioural",
    from: `    if (!sizes.length) continue;`,
    to: ``,
  },
  {
    id: "G5",
    guard: "A merged pair is shown ONCE — two stored pids can now be one shoe",
    file: ALT,
    kind: "behavioural",
    from: `    if (!product || seen.has(product.id)) continue;`,
    to: `    if (!product) continue;`,
  },
  {
    id: "G6",
    guard: "A malformed stored entry is dropped, never rendered as a broken row",
    file: NEIGH,
    kind: "behavioural",
    from: `    if (!pid || !code) continue;`,
    to: ``,
  },

  // ── 2. THE VOCABULARY IS CLOSED, AND NOTHING IS COERCED ──────────────────
  {
    id: "G7",
    guard: "An out-of-vocabulary value is REFUSED, never accepted",
    file: ATTR,
    kind: "behavioural",
    from: `  return spec.vocab.includes(s);`,
    to: `  return true;`,
  },
  {
    id: "G8",
    guard: "An illegal vision value is DROPPED from the record rather than stored",
    file: ATTR,
    kind: "behavioural",
    from: `    if (!isLegalAttribute(k, v)) continue;`,
    to: ``,
  },
  {
    id: "G9",
    guard: "A required field missing makes the product UNUSABLE — half-enriched is never suggestible",
    file: ATTR,
    kind: "behavioural",
    from: `    if (ATTRIBUTE_FIELDS[k].required && !(r[k] && String(r[k]).length)) return null;`,
    to: ``,
  },
  {
    id: "G10",
    guard: "priceBand is DERIVED from the price, never invented for a priceless product",
    file: ATTR,
    kind: "behavioural",
    from: `  if (!Number.isFinite(r) || r <= 0) return "";`,
    to: `  if (!Number.isFinite(r)) return "";`,
  },
  {
    id: "G11",
    guard: "No word the namer can emit is a compliance trigger — the suede lesson, held at import time",
    file: ATTR,
    kind: "behavioural",
    // Re-introducing "off-white" is the exact regression: it is a LABEL, the
    // publish path refuses it, and every name that used it would be blocked.
    from: `  white: "white", cream: "white", bone: "white", eggshell: "white",`,
    to: `  white: "white", "off-white": "white", cream: "white", bone: "white",`,
  },

  // ── 3. HUMAN CORRECTIONS SURVIVE; RESUMING IS FREE ───────────────────────
  {
    id: "G12",
    guard: "A CONFIRMED value beats the machine one, field by field",
    file: ATTR,
    kind: "behavioural",
    from: `  const human = node?.confirmed || {};
  const out = {};`,
    to: `  const human = {};
  const out = {};`,
  },
  {
    id: "G13",
    guard: "An EMPTY confirmed value does not mask a good machine one",
    file: ATTR,
    kind: "behavioural",
    from: `    const pick = (spec.list ? Array.isArray(h) && h.length : h !== undefined && h !== null && h !== "")
      ? h : m;`,
    to: `    const pick = h !== undefined ? h : m;`,
  },
  {
    id: "G14",
    guard: "A DIFFERENT extractor version is not current — that is the whole point of the stamp",
    file: ATTR,
    kind: "behavioural",
    from: `  return Number(node?.v) === Number(version) && !!node?.a;`,
    to: `  return !!node?.a;`,
  },

  {
    id: "G14b",
    guard: "An RTDB server sentinel survives the record builder — Number() of it is NaN, and `|| 0` wrote at:0 onto 205 live records",
    file: ATTR,
    kind: "behavioural",
    from: `  if (at && typeof at === "object") return at;      // {".sv":"timestamp"}`,
    to: ``,
  },

  // ── 4. BRAND IS A WEIGHT, AND THE WALL HOLDS ─────────────────────────────
  {
    id: "G15",
    guard: "BRAND IS NOT A FILTER — an owner decision, and the one most likely to be quietly reversed",
    file: NEIGH,
    kind: "behavioural",
    from: `  terms.brand = W.brand * eq(a.brand, b.brand);`,
    to: `  if (a.brand !== b.brand) return { score: 0, terms };
  terms.brand = W.brand * eq(a.brand, b.brand);`,
  },
  {
    id: "G16",
    guard: "…and brand can never OUTRANK a shoe that is actually more alike",
    file: NEIGH,
    kind: "behavioural",
    from: `  brand: 15,`,
    to: `  brand: 150,`,
  },
  {
    id: "G17",
    guard: "The silhouette GROUP is a wall — a slide is never an alternative to a runner",
    file: NEIGH,
    kind: "behavioural",
    from: `  if (a.group !== b.group) return { score: 0, terms };   // the wall`,
    to: ``,
  },
  {
    id: "G18",
    guard: "A zero-score neighbour is never stored — an empty list is a real answer",
    file: NEIGH,
    kind: "behavioural",
    from: `    if (score <= 0) continue;`,
    to: ``,
  },
  {
    id: "G19",
    guard: "Ties break on pid, so a re-run produces the identical list and a diff shows only what moved",
    file: NEIGH,
    kind: "behavioural",
    from: `  scored.sort((x, y) => (y.score - x.score) || x.pid.localeCompare(y.pid));`,
    to: `  scored.sort((x, y) => y.score - x.score);`,
  },

  // ── 5. THE CHIP STILL READS AS UNAVAILABLE WITHOUT THE ✕ ─────────────────
  {
    id: "G20",
    guard: "The container carries the signal on EVERY axis — converging any one of them is a grid nobody can read",
    file: CHIP,
    kind: "behavioural",
    // The phone chip's copy — the quick-view carries the identical line, so
    // the anchor takes the comment above it to stay unique.
    from: `      // 3. A FAINT FILL where an available chip is transparent.
      background: "rgba(255,255,255,.045)",`,
    to: `      background: "transparent",`,
  },
  {
    id: "G21",
    guard: "…and the outline SHAPE differs, which is what reads at arm's length",
    file: CHIP,
    kind: "behavioural",
    from: `      // 1. DASHED, not solid — the shape of the outline itself differs.
      borderStyle: "dashed",`,
    to: `      borderStyle: "solid",`,
  },
  {
    id: "G22",
    guard: "The unavailable chip stays TAPPABLE — not-allowed would put the sheet out of reach entirely",
    file: CHIP,
    kind: "behavioural",
    from: `      // Still tappable: the tap is what opens the sheet.
      cursor: "pointer",`,
    to: `      cursor: "not-allowed",`,
  },

  // ── 6. THE REFUSAL ITSELF DOES NOT MOVE ──────────────────────────────────
  // Source pins, and counted as such: the behaviour lives inside AssistantView
  // and is unreachable without mounting. They prove the wiring has not moved,
  // NOT that the screen behaves.
  {
    id: "G23",
    guard: "Tapping an unavailable size still cannot SELECT it — the refill-request path stays blocked exactly as before",
    file: APP,
    kind: "source-pin",
    from: `                      if (out) { setNaNote(clothing || deadForOrder(selected) ? { size: s, left: 0 } : { size: s, left: 0, snk: true }); return; }`,
    to: `                      if (out) { setNaNote({ size: s, left: 0, snk: true }); setPendingSize(s); return; }`,
  },
  {
    id: "G24",
    guard: "The strip is joined to the SHARED resolver, never to a second availability test",
    file: APP,
    kind: "source-pin",
    from: `      sizeAvailable: (p, sz) => !sneakerOut(p, sz),`,
    to: `      sizeAvailable: () => true,`,
  },
  {
    id: "G25",
    guard: "The gated hub must be known AND settled before a neighbour can be offered",
    file: APP,
    kind: "source-pin",
    from: `        const hub = sneakerHubOf(p);
        return !!hub && sneakerGateReady(hub);`,
    to: `        return true;`,
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard. The FAIL check comes first because a failing
// source-pin assertion prints the whole of App.jsx as its diff, and App.jsx
// contains the words a load-crash pattern looks for in its own error handling.
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

// ── SOURCE PINS NEED A TEST THAT READS THE SOURCE ────────────────────────────
// A mutation to App.jsx cannot be caught by a unit test of a pure module, so
// the App-file guards are pinned by appWiring.test.js reading the file. That is
// circular by construction and is COUNTED SEPARATELY below rather than being
// passed off as behavioural coverage.
const APP_PIN_TEST = "src/components/stock/altSheetWiring.test.js";
if (MUTATIONS.some((m) => m.file === APP)) SUITE.push(APP_PIN_TEST);

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

// ─── MUTATION PROOF — "Not on the wall" and the replacing send ──────────────
// Each guard is broken on purpose, one at a time; the test that pins it must go
// RED, and GREEN again once the bytes are restored. Refuses a dirty tree
// (commit first) and restores from the bytes it read, never git checkout.
//
// Run: node scripts/mutation-proof-not-on-wall.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const STORE = "src/components/stock/displayRequestStore.js";
const CORE = "src/components/stock/displayRequestCore.js";
const ROWCORE = "src/components/stock/displayRowCore.js";
const ROWSTORE = "src/components/stock/displayRowStore.js";
const VIEW = "src/components/stock/DisplayRegistrationView.jsx";
const APP = "src/App.jsx";
const T = ["src/components/stock/notOnWallRequest.test.js"];
const R = ["src/components/stock/DisplayRegistrationView.render.test.jsx"];
const PIN = ["src/components/stock/displayAutoRefillUnchanged.test.js"];

const MUTATIONS = [
  // ── idempotency ──
  { id: "M-OPEN-GUARD", guard: "an open request (either path) blocks a second", file: STORE,
    from: "    if (blocker) {", to: "    if (false) {", tests: T },
  { id: "M-LOCK-TXN", guard: "the transaction fence refuses a claim inside the window", file: STORE,
    from: "      (lockHeld(cur, claimAt) ? undefined : { claimAt, by, orderId: null, orderCreatedAt: null }));",
    to: "      ({ claimAt, by, orderId: null, orderCreatedAt: null }));", tests: T },
  { id: "M-LOCK-HELD", guard: "a fresh claim is held", file: CORE,
    from: "  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < REQUEST_LOCK_MS;", to: "  return false;", tests: T },
  { id: "M-LOCK-ORDER", guard: "an expired claim whose order is still open still blocks", file: STORE,
    from: "    if (prior?.orderId) {", to: "    if (false) {", tests: T },
  // ── stock / source hub ──
  { id: "M-NO-STOCK", guard: "no stock anywhere raises nothing", file: CORE,
    from: "    if (units > 0) return { hub, units, tagged: hub === tag };", to: "    return { hub, units, tagged: hub === tag };", tests: T },
  { id: "M-TAG-FIRST", guard: "the product's own hub is asked first", file: CORE,
    from: "  const order = hubs.includes(tag) ? [tag, ...hubs.filter((h) => h !== tag)] : [...hubs];", to: "  const order = [...hubs].reverse();", tests: T },
  { id: "M-PROMISED", guard: "ready-promised units are not stock", file: CORE,
    from: "    n += availableUnits(qty, promised?.[promisedKey(productId, size)]);", to: "    n += availableUnits(qty, 0);", tests: T },
  // ── the card shape ──
  { id: "M-SCHEDULED", guard: "the request is born scheduled (lands on the Display Refill card)", file: CORE,
    from: "    displayRefillScheduledAt: nowIso,", to: "    displayRefillScheduledAt: null,", tests: [...T, ...PIN] },
  // ── clearing the record ──
  { id: "M-CLEAR-ROWS", guard: "open rows are closed before requesting", file: STORE,
    from: "  for (const row of open) {\n    // eslint-disable-next-line no-await-in-loop\n    const res = await closeDisplayRow({ rows: fresh.rows, row, reason: \"corrected\"",
    to: "  for (const row of []) {\n    // eslint-disable-next-line no-await-in-loop\n    const res = await closeDisplayRow({ rows: fresh.rows, row, reason: \"corrected\"", tests: T },
  { id: "M-CLEAR-SLOT", guard: "an orphan slot is cleared", file: STORE,
    from: "  const slot = await clearDisplaySlot({ store, productId, source: \"manual\" });", to: "  const slot = null;", tests: T },
  // ── replace, never add ──
  { id: "M-SEND-CLOSES", guard: "the send closes every open row", file: ROWCORE,
    from: "  for (const open of openRowsFor(rows, store, productId)) {\n    const fields = closeFields(open, {",
    to: "  for (const open of []) {\n    const fields = closeFields(open, {", tests: T },
  { id: "M-SETTLE", guard: "racing sends settle to one row", file: ROWSTORE,
    from: "    const settled = await settleToOne(store, productId);\n\n    // The mirror",
    to: "    const settled = { closed: [] };\n\n    // The mirror", tests: T },
  { id: "M-SETTLE-WINNER", guard: "every racer keeps the SAME survivor", file: ROWCORE,
    from: "  return { keep: open.length ? open[open.length - 1] : null, close: open.slice(0, -1) };",
    to: "  return { keep: open[0] || null, close: open.slice(1) };", tests: T },
  // ── the screen ──
  { id: "M-TODO-EXCLUDE", guard: "a requested shoe leaves the to-do list", file: VIEW,
    from: "    () => filterCandidates(candidates, { q }).filter((c) => !requestedIds.has(c.productId)),",
    to: "    () => filterCandidates(candidates, { q }),", tests: R },
  // ── the 15-minute path is pinned ──
  { id: "M-AUTO-DELAY", guard: "the 15-minute delay is byte-pinned", file: APP,
    from: "  const DISPLAY_REFILL_DELAY_MS = 15 * 60 * 1000;", to: "  const DISPLAY_REFILL_DELAY_MS = 14 * 60 * 1000;", tests: PIN },
  { id: "M-AUTO-SEND", guard: "the refill send (setDisplayRefillStatus) is byte-pinned", file: APP,
    from: "      displayRefilledBy:   selectedHub,\n      updatedAt:           now,\n    };", to: "      displayRefilledBy:   selectedHub,\n      updatedAt:           now,\n      x: 1,\n    };", tests: PIN },
  { id: "M-AUTO-CARD", guard: "the card's only change is gated on wallWalk", file: APP,
    from: "                    {order.wallWalk === true && (", to: "                    {true && (", tests: PIN },
  { id: "M-AUTO-TRIGGER", guard: "the READY trigger is byte-pinned", file: APP,
    from: "          patch.displayRefillScheduledAt     = now;", to: "          patch.displayRefillScheduledAt     = now ;", tests: PIN },
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
function runAll(m) {
  const verdicts = [];
  if (m.tests?.length) verdicts.push(runVitest(m.tests));
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
    console.log(`${m.id.padEnd(19)} ANCHOR ${hits === 0 ? "NOT FOUND" : `FOUND ${hits}×`} in ${m.file}`);
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
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id.padEnd(19)} mutated:${String(mutated).padEnd(6)} restored:${String(restored).padEnd(6)} ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}
const bad = results.filter((r) => !r.proven);
console.log(`\n${results.length - bad.length}/${results.length} guards proven.`);
process.exit(bad.length ? 1 : 0);

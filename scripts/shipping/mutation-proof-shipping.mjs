// ─── MUTATION PROOF HARNESS — Courier Guy shipping ───────────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. Same discipline as scripts/mutation-proof-push-notify.mjs:
// ERROR is not FAIL, unique anchors, signal-safe restore from captured bytes,
// clean-tree preflight.
//
// The guard Junid named: with /config/shipping/live false, NO code path may
// reach a shipment call (L1–L6). The rest pin the estimator's arithmetic and
// the rate choice, because a wrong parcel is a wrong price on every order.
//
// SAFETY (2026-10-07: a test run once reached the LIVE database). The child
// test runs get FIREBASE_DATABASE_EMULATOR_HOST pinned to a dead port and a
// dummy COURIER_GUY_API_KEY, and the suite stubs fetch to throw — a mutation
// that bypassed the injected fakes would fail loudly, never touch prod.
// Run it from a separate worktree, never beside uncommitted work.
//
// Run:  node scripts/shipping/mutation-proof-shipping.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "../lib/mutationPreflight.mjs";

const BOOK = "scripts/shipping/bookShipment.mjs";
const CLIENT = "scripts/shipping/courier-client.mjs";
const EST = "src/shipping/estimateParcel.js";
const CHOOSE = "src/shipping/chooseService.js";
const CARD = "src/components/admin/ShippingCard.jsx";
const ORDER = "src/shipping/orderShipment.js";
const TESTS = ["src/shipping", "scripts/shipping", "src/components/admin/ShippingCard.gate.test.jsx"];

const CHILD_ENV = {
  ...process.env,
  FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9",
  COURIER_GUY_API_KEY: "mutation-harness-dummy-key",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
};

const MUTATIONS = [
  // ── THE LIVE-FLAG GUARD ──────────────────────────────────────────────────
  { id: "L1", file: BOOK, guard: "only the BOOLEAN true is live — a truthy string/number is a dry run",
    from: "return snap.exists() && snap.val() === true;", to: "return snap.exists() && !!snap.val();" },
  { id: "L2", file: BOOK, guard: "live is READ, never assumed",
    from: "return snap.exists() && snap.val() === true;", to: "return true;" },
  { id: "L3", file: BOOK, guard: "bookShipment returns the dry run when live is off",
    from: "  const live = await readLive(db);\n  if (!live) {\n    log(`bookShipment", to: "  const live = await readLive(db);\n  if (false) {\n    log(`bookShipment" },
  { id: "L4", file: BOOK, guard: "cancelShipment returns the dry run when live is off",
    from: "  const live = await readLive(db);\n  if (!live) {\n    log(`cancelShipment", to: "  const live = await readLive(db);\n  if (false) {\n    log(`cancelShipment" },
  { id: "L5", file: BOOK, guard: "an order already carrying a shipmentId is never booked again",
    from: "if (order?.shipping?.shipmentId) {", to: "if (false) {" },
  { id: "L6", file: BOOK, guard: "a held booking claim blocks a second booking",
    from: "(cur && cur.state !== \"failed\" ? undefined :", to: "(false ? undefined :" },
  { id: "L7", file: BOOK, guard: "a 5xx/timeout leaves the claim UNKNOWN (TCG may have booked it)",
    from: "const ambiguous = !(err?.status >= 400 && err?.status < 500);", to: "const ambiguous = false;" },
  { id: "L8", file: BOOK, guard: "live refuses without a collection contact / with no box",
    from: "  if (plan.liveBlockers.length) {", to: "  if (false) {" },
  { id: "L9", file: ORDER, guard: "the WEB- ref is never used as the /online_orders key",
    from: "return first(order?.key, order?.id, gidTail);", to: "return first(order?.key, order?.id, gidTail, order?.ref);" },
  { id: "L10", file: BOOK, guard: "live is re-read AFTER the claim — a switch-off mid-quote stops the booking",
    from: "  if (!(await readLive(db))) {\n    await claimRef.set(", to: "  if (false) {\n    await claimRef.set(" },
  { id: "L11", file: BOOK, guard: "the spend ceiling blocks a live booking quoted above it",
    from: "chosen.rate.rate > ceiling)", to: "chosen.rate.rate > ceiling * 1000)" },
  { id: "L12", file: BOOK, guard: "booking never mints an order node — the order must exist at its key",
    from: "if (!(await db.ref(`online_orders/${key}/ref`).get()).exists()) {", to: "if (false) {" },
  { id: "C1", file: CLIENT, guard: "a create is NEVER retried on 5xx (a retry could book twice)",
    from: "createShipment: (body) => call(\"POST\", \"/shipments\", { body, retry5xx: false }),", to: "createShipment: (body) => call(\"POST\", \"/shipments\", { body, retry5xx: true })," },
  { id: "C2", file: CLIENT, guard: "the API key is redacted from every log line",
    from: "  if (key) s = s.split(key).join(\"[REDACTED]\");\n", to: "\n" },
  { id: "C3", file: CLIENT, guard: "a 4xx is not retried",
    from: "if (res.status >= 500 && attempt < attempts) {", to: "if (res.status >= 400 && attempt < attempts) {" },

  // ── THE ESTIMATOR ────────────────────────────────────────────────────────
  { id: "E1", file: EST, guard: "chargeable = max(actual, volumetric)",
    from: "const chargeableKg = Math.max(actualKg, volumetricKg);", to: "const chargeableKg = actualKg;" },
  { id: "E2", file: EST, guard: "a size band includes its upper edge",
    from: "bands.find((b) => n <= b.upToSize)", to: "bands.find((b) => n < b.upToSize)" },
  { id: "E3", file: EST, guard: "fit is tested in any orientation",
    from: "const a = sortDesc(inner), b = sortDesc(outer);", to: "const a = inner, b = outer;" },
  { id: "E4", file: EST, guard: "a locker takes a parcel AT its weight threshold",
    from: "actualKg <= Number(lk.maxKg)", to: "actualKg < Number(lk.maxKg)" },
  { id: "E5", file: EST, guard: "the SMALLEST fitting box wins across layouts",
    from: "if (!best || v < best.v) best = { box, block, v };", to: "if (!best || v > best.v) best = { box, block, v };" },
  { id: "E6", file: EST, guard: "EU kids sizes are kids shoes",
    from: "return n >= 16 && n <= 35;", to: "return false;" },
  { id: "E7", file: EST, guard: "items in a column STACK (heights add)",
    from: "    c.h += it.h;", to: "    c.h = Math.max(c.h, it.h);" },
  { id: "E8", file: EST, guard: "the box's own weight is counted",
    from: "items.reduce((s, it) => s + it.kg, 0) + tare)", to: "items.reduce((s, it) => s + it.kg, 0))" },
  { id: "E9", file: EST, guard: "volumetric uses the configured divisor",
    from: "const volumetricKg = round2((lengthCm * widthCm * heightCm) / divisor);", to: "const volumetricKg = round2((lengthCm * widthCm * heightCm) / 5000);" },
  { id: "E10", file: EST, guard: "a disabled drop box means door, always",
    from: "  if (!dropBox?.enabled) return null;\n", to: "\n" },
  { id: "E11", file: EST, guard: "each unit is its own item (qty expands)",
    from: "for (let i = 0; i < qty; i++) items.push(", to: "for (let i = 0; i < Math.min(qty, 1); i++) items.push(" },

  // ── THE RATE CHOICE ──────────────────────────────────────────────────────
  { id: "R1", file: CHOOSE, guard: "an excluded service (SDX) is never chosen",
    from: "const door = (quoted?.door ?? []).filter((r) => !exclude.has(r.code));", to: "const door = (quoted?.door ?? []);" },
  { id: "R2", file: CHOOSE, guard: "a locker is chosen ONLY for a drop-box-eligible parcel",
    from: "if (parcel?.dropBoxEligible && locker.length)", to: "if (locker.length)" },
  { id: "R3", file: CHOOSE, guard: "the CHEAPEST rate is chosen",
    from: "(!best || r.rate < best.rate ? r : best)", to: "(!best || r.rate > best.rate ? r : best)" },

  // ── THE CARD ─────────────────────────────────────────────────────────────
  { id: "K1", file: CARD, guard: "Save never writes /config/shipping/live",
    from: "for (const k of EDITABLE_KEYS) out[k] = cfg[k];", to: "for (const k of EDITABLE_KEYS) out[k] = cfg[k]; out.live = live;" },
  { id: "K2", file: CARD, guard: "the live switch is disabled",
    from: "checked={live} disabled readOnly", to: "checked={live} readOnly" },
  { id: "K3", file: CARD, guard: "an order ref is validated before any read",
    from: "try { seg = assertSafeSegment(refInput.trim(), \"order ref\"); }", to: "try { seg = refInput.trim(); }" },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", env: CHILD_ENV, maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+ failed/.test(out) || /Test Files\s+\d+ failed/.test(out)) {
      if (/SyntaxError|Failed to load|Cannot find module/.test(out) && !/Tests\s+\d+ failed/.test(out)) return "ERROR(load crash)";
      return "FAIL";
    }
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits ? "ANCHOR-AMBIGUOUS" : "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR ${hits ? `FOUND ${hits}×` : "NOT FOUND"} in ${m.file}`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runVitest(TESTS);
    restore();
    restored = runVitest(TESTS);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}

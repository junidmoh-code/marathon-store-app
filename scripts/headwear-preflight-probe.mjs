// ─── HEADWEAR ONE-SIZE COLLAPSE — COMMIT 2: BARCODE WRITE-BACK PROBE ──────────
//
// The migration's load-bearing step rewrites every /barcodes/{code}/size to "_"
// inside ONE atomic multi-path update. The live rule at /barcodes/$code is
// CREATE-ONLY under client auth (".write" requires !data.exists()), so that step
// is IMPOSSIBLE from a client — it runs on the Admin SDK via Application Default
// Credentials, which bypass rules. This probe PROVES that permission before any
// stock moves, the same way the balaclava collapse did (PR #284):
//
//   for EVERY barcode of EVERY in-scope beanie AND CAP —
//     1. read /barcodes/{code}, assert it exists with the right productId
//     2. write its EXISTING size value back verbatim (a real write, zero
//        content change — the identical rule path the migration will take)
//     3. re-read and assert the value is unchanged
//
// ALL codes, never a sample: the migration batches index rewrites per product,
// and a single unwritable record takes its whole atomic batch down. On
// PERMISSION_DENIED this aborts with an explicit statement that the credential
// is a client credential rather than the Admin SDK. The credential type is
// asserted and LOGGED up front so a future run under different credentials is
// visible in the output, not just in its failure mode.
//
// ── WHY THE CAP HALF MAKES THIS BIGGER, NOT JUST LONGER ──────────────────────
// Every beanie carried exactly ONE barcode, so a beanie product's atomic Step 2
// touched one index record and a failure could only ever cost that one product.
// 87 caps carry two or more — one carries SEVEN — and Step 2 rewrites ALL of a
// product's records in a single update. One unwritable record therefore takes
// down its whole product, including the codes that were perfectly fine. That is
// the reason this probes ALL codes and never a sample: a sample that misses the
// one bad record tells you the batch will succeed when it will not.
//
// Scope rule is the ONE shared predicate (scripts/lib/headwearCollapseCore.mjs),
// imported rather than restated so the probe cannot certify a set of codes that
// differs from the set the migration will write. Codes come from BOTH directions
// — the product's barcodes map AND a reverse sweep of /barcodes by productId —
// so a code the map forgot still gets probed.
//
// Usage: node scripts/headwear-preflight-probe.mjs
// Exit 0 = every code probed clean. Exit 1 = abort (nothing further may move).

import { createRequire } from "module";
import { isInScope, headwearKind, emptyKindCount } from "./lib/headwearCollapseCore.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
const g = (p) => db.ref(p).once("value").then((s) => s.val());

// A privileged (Admin SDK) credential can mint its own access tokens — that is
// precisely what lets it bypass the /barcodes create-only rule. Same assertion
// as the balaclava collapse: fail EARLY and legibly under the wrong auth; the
// write-back probe below stays the empirical proof.
export function hasPrivilegedCredential(app) {
  const c = app && app.options && app.options.credential;
  return !!c && typeof c.getAccessToken === "function";
}

(async () => {
  console.log(`\n${"═".repeat(78)}\n  HEADWEAR PRE-FLIGHT — barcode index write-back probe (ALL codes)\n${"═".repeat(78)}`);

  const cred = admin.app().options.credential;
  const credOk = hasPrivilegedCredential(admin.app());
  console.log(`  credential: ${cred ? cred.constructor.name : "(none)"} — ${credOk ? "PRIVILEGED Admin SDK (rules bypassed)" : "NOT privileged"}`);
  if (!credOk) {
    console.error("\nABORT: this credential is a CLIENT credential, not the Admin SDK.");
    console.error("The atomic Step 2 (rewriting existing /barcodes/{code}/size records) would");
    console.error("fail under it — /barcodes/$code is create-only under client auth. Configure");
    console.error("Application Default Credentials and re-run.");
    process.exit(1);
  }

  const [products, barcodesIdx] = await Promise.all([g("products"), g("barcodes")]).then((r) => r.map((v) => v || {}));

  const inScope = Object.entries(products).filter(([, p]) => isInScope(p));
  const pidSet = new Set(inScope.map(([pid]) => pid));
  // code → expected pid, from both directions
  const codes = new Map();
  for (const [pid, p] of inScope) for (const code of Object.values(p.barcodes || {})) codes.set(String(code), pid);
  for (const [code, rec] of Object.entries(barcodesIdx)) if (rec && pidSet.has(rec.productId)) if (!codes.has(code)) codes.set(code, rec.productId);

  const kinds = emptyKindCount();
  for (const [, p] of inScope) kinds[headwearKind(p)]++;
  const perProduct = new Map();
  for (const pid of codes.values()) perProduct.set(pid, (perProduct.get(pid) || 0) + 1);
  const worst = [...perProduct.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`  scope: ${inScope.length} products (${kinds.beanie} beanies, ${kinds.cap} caps, ${kinds.bucket} bucket hats), ${codes.size} barcode index records to probe`);
  console.log(`  largest single atomic batch: ${worst ? `${worst[1]} index record(s) on ${worst[0]}` : "n/a"} — all of them must be writable or that product cannot collapse\n`);

  let pass = 0; const failures = []; const addsSize = [];
  for (const [code, pid] of codes) {
    try {
      const rec = await g(`barcodes/${code}`);
      if (!rec) { failures.push(`${code}: NO index record (expected productId ${pid})`); continue; }
      if (rec.productId !== pid) { failures.push(`${code}: productId ${rec.productId} ≠ expected ${pid}`); continue; }
      // Fresh read immediately before the set — write back the CURRENT value,
      // never a snapshot, so the probe writes what is actually there.
      //
      // HONEST LIMIT (CodeRabbit, PR #343): read-then-set is not atomic, and
      // /barcodes records carry no version field to condition a write on. A
      // change landing between the read and the set would be overwritten, and
      // the read-back would report "unchanged" because it compares against the
      // value this probe itself wrote. There is no exclusive barcode-write gate
      // in this system to take, and /receiving_session/active is not one — it
      // stands the refill engine down, nothing else.
      //
      // What is done instead: re-read immediately before the write and confirm
      // the value has not moved since the first read, which shrinks the window
      // to the microseconds between two adjacent reads, and a second read-back
      // after the write. What remains is operational: run this probe inside the
      // same quiet window as the migration itself, when nobody is creating or
      // editing products. A barcode index record only changes when a product is
      // created or its codes are edited, so the quiet window is the real
      // control here and the runbook says so.
      // ── WHICH LEAF TO WRITE BACK ─────────────────────────────────────────
      // Normally `size`. But a genuinely UNSIZED index record OMITS the field
      // entirely — that is deliberate and canonical (barcode.js
      // barcodeIndexRecord: "UNSIZED items OMIT the size field entirely — NOT
      // null and NOT '' — so the POS resolver reads a missing size as unsized").
      //
      // Every beanie code was a per-size code, so this never came up and the
      // probe simply assumed `size` was a non-empty string. Caps break that:
      // 21 are already one-size and their "_"-slot codes were minted by the
      // unsized path, so they have no `size` at all. On live data the probe
      // called two such records "nothing safe to write back" and ABORTED THE
      // WHOLE MIGRATION over two perfectly healthy records — a false negative
      // on the gate that everything else waits behind.
      //
      // There is no verbatim write-back available for a field that does not
      // exist (writing "_" would be a real change, which is exactly what a
      // probe must not do). So it writes back a different leaf that is
      // guaranteed to exist: `productId`, which the live rule REQUIRES
      // (`newData.hasChildren(['productId'])`). It sits under the same
      // /barcodes/$code node and therefore takes the same create-only .write
      // rule, so it proves the identical permission the migration needs.
      //
      // These records are reported, not silently passed: Step 2 will ADD `size`
      // to them rather than rewrite it, which is a shape change worth seeing.
      const rawSize = await g(`barcodes/${code}/size`);
      const usesSize = typeof rawSize === "string" && rawSize !== "";
      const leaf = usesSize ? "size" : "productId";
      if (!usesSize) {
        if (rawSize != null) { failures.push(`${code}: size is ${JSON.stringify(rawSize)} — neither a usable string nor absent; check it by hand`); continue; }
        addsSize.push(code);
      }
      const before = await g(`barcodes/${code}/${leaf}`);
      if (typeof before !== "string" || before === "") { failures.push(`${code}: ${leaf} is ${JSON.stringify(before)} — nothing safe to write back`); continue; }
      const stillBefore = await g(`barcodes/${code}/${leaf}`);
      if (stillBefore !== before) { failures.push(`${code}: CHANGING UNDER THE PROBE (${before} → ${stillBefore}) — someone is editing this product; re-run in a quiet window`); continue; }
      await db.ref(`barcodes/${code}/${leaf}`).set(before);
      const after = await g(`barcodes/${code}/${leaf}`);
      if (after !== before) { failures.push(`${code}: CHANGED ${before} → ${after}`); continue; }
      pass++;
    } catch (e) {
      const denied = /PERMISSION_DENIED/i.test(String(e.code || e.message));
      failures.push(`${code}: ${denied ? "PERMISSION_DENIED" : e.message}`);
      if (denied) {
        console.error(`\nABORT at ${code}: PERMISSION_DENIED — the credential in use is a CLIENT`);
        console.error("credential rather than the Admin SDK, and the migration's atomic Step 2");
        console.error("(rewriting existing /barcodes/{code}/size) WOULD FAIL. Nothing has been");
        console.error(`changed (${pass} verbatim write-backs so far, all verified unchanged).`);
        process.exit(1);
      }
    }
  }

  console.log(`  probed ${codes.size} codes: ${pass} ok, ${failures.length} failed`);
  if (addsSize.length) {
    console.log(`\n  ${addsSize.length} record(s) carry NO size field — the canonical shape for a one-size`);
    console.log(`  slot (barcodeIndexRecord omits it). Step 2 will ADD size "_" to these rather than`);
    console.log(`  rewrite it. That is legal under the live rule (size must be a non-empty string when`);
    console.log(`  present) and matches the 131 live one-size records that already carry "_".`);
    console.log(`  ${addsSize.join(", ")}`);
  }
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length) {
    console.error("\nABORT: the atomic Step 2 batch would fail on the records above. Nothing moves.");
    process.exit(1);
  }
  console.log("\n  ALL CODES WRITABLE — the migration's index rewrite is proven possible under");
  console.log("  this credential. (Every write was the existing value, verified unchanged.)");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// ─── THE /customers RULE, PROVEN ON THE RTDB EMULATOR ────────────────────────
//
// WHY THIS FILE EXISTS AT ALL. On 2026-09-05 a hand-applied, unproven rule took
// every till down: a `.validate` on refundedQty used `data.parent()` on a
// create-only path, so the field it compared against did not exist yet and
// EVERY SALE WAS DENIED. Reading a rule and believing it is not a test. This
// runs the real rules engine — the emulator jar, the same one the CLI ships —
// against the ACTUAL live rules document with the patch applied, and refuses to
// let the applier run until every case below passes.
//
// The suite drives the emulator over REST with unsigned JWTs in ?auth=, which
// is how the emulator is told "you are this user". It does NOT use a bearer
// token: an Authorization: Bearer header on the emulator is the ADMIN bypass,
// and a suite that used one would pass every case while proving nothing.
//
// Run:  node scripts/rules/customers-rules.test.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchCustomersRules, patchOrdersIndex, OWNER_EMAIL } from "./customersOwnerOnly.mjs";

const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9099);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR ||
  join(process.env.HOME, ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || "/opt/homebrew/opt/openjdk/bin/java";

// ── The identities ───────────────────────────────────────────────────────────
// An unsigned JWT — header {"alg":"none"} — is what the emulator accepts as a
// user. The claims are exactly the ones the rules read: uid, email, and the
// sign_in_provider that every rule in this document gates on.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
const asUser = (uid, email, provider = "password") =>
  jwt({ iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, uid, email,
        auth_time: 1, iat: 1, exp: 9999999999,
        firebase: { sign_in_provider: provider, identities: {} } });

const OWNER = asUser("owner-uid", OWNER_EMAIL);
const TILL  = asUser("till-uid", "till1@marathon.internal");
const ANON  = asUser("anon-uid", null, "anonymous");
const SCOPED_TILL = asUser("scoped-uid", "pe@marathon.internal");

// ── REST helpers ─────────────────────────────────────────────────────────────
// SEEDING AND RULE-LOADING USE `Authorization: Bearer owner`. That header is the
// emulator's ADMIN BYPASS — which is exactly why no assertion may ever carry it.
// A suite that seeded and asserted through the same credential would pass every
// case while proving nothing about the rules. (Verified against this emulator:
// with no auth at all a locked path answers 401, and the bearer answers 200.)
const OWNER_HDR = { Authorization: "Bearer owner" };
// The query string goes AFTER `.json`, not inside the path — `orders?x=1` as a
// path produces `orders?x=1.json`, which the server answers 400 and which would
// read as "the index does not work".
const url = (path, auth, qs = "") =>
  `${HOST}/${path}.json?ns=${NS}${qs ? `&${qs}` : ""}${auth ? `&auth=${auth}` : ""}`;
const admin = {
  put: (p, v) => fetch(url(p), { method: "PUT", headers: OWNER_HDR, body: JSON.stringify(v) }),
};
async function as(auth, method, path, value, qs) {
  const r = await fetch(url(path, auth, qs), {
    method,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { ok: r.ok, status: r.status };
}

// ── The assertions ───────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function expectAllowed(label, p) {
  const r = await p;
  if (r.ok) { passed++; console.log(`  \u2713 ${label}`); }
  else { failures.push(`${label} — expected ALLOWED, got ${r.status}`); console.log(`  \u2717 ${label} (${r.status})`); }
}
async function expectDenied(label, p) {
  const r = await p;
  if (r.status === 401 || r.status === 403) { passed++; console.log(`  \u2713 ${label}`); }
  else { failures.push(`${label} — expected DENIED, got ${r.status}`); console.log(`  \u2717 ${label} (got ${r.status})`); }
}

// ── Boot the emulator against the LIVE rules, patched ────────────────────────
// The emulator jar has no --rules flag: rules are PUT to /.settings/rules.json
// after it is listening, which is what the CLI does too.
const liveDoc = JSON.parse(readFileSync(process.env.LIVE_RULES ||
  join(process.env.HOME, "live-rules-for-emulator.json"), "utf8"));
const candidate = patchOrdersIndex(patchCustomersRules(liveDoc));
const dir = mkdtempSync(join(tmpdir(), "rtdb-rules-"));
const rulesFile = join(dir, "rules.json");
writeFileSync(rulesFile, JSON.stringify(candidate, null, 2));
console.log(`candidate rules: ${rulesFile}`);

const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"],
  { stdio: ["ignore", "pipe", "pipe"] });
let emuLog = "";
emu.stdout.on("data", (d) => { emuLog += d; });
emu.stderr.on("data", (d) => { emuLog += d; });
const stop = () => { try { emu.kill("SIGKILL"); } catch { /* already gone */ } };
process.on("exit", stop);

// Wait for it to answer rather than sleeping a guessed number of seconds.
for (let i = 0; ; i++) {
  try { await fetch(`${HOST}/.json?ns=${NS}`, { headers: OWNER_HDR }); break; } catch {
    if (i > 150) { console.error("emulator did not start:\n" + emuLog); process.exit(2); }
    await new Promise((r) => setTimeout(r, 200));
  }
}
// ── PHASE 0: PROVE THE GAP IS REAL, ON THE UNPATCHED LIVE RULES ─────────────
// A suite that only shows the patched rules denying things cannot tell the
// difference between "this patch closed the hole" and "there was never a hole
// and the patch does nothing". So the LIVE document is loaded first, unmodified,
// and the same cashier is shown deleting and archiving a customer. Every line
// below is the current production behaviour, reproduced.
const loadRules = async (doc) => {
  const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, {
    method: "PUT", headers: OWNER_HDR, body: JSON.stringify(doc),
  });
  if (!r.ok) { console.error(`could not load rules: ${r.status} ${await r.text()}`); stop(); process.exit(2); }
};
await loadRules(liveDoc);
await admin.put("customers/0820000001", { name: "Gap A", phone: "0820000001" });
await admin.put("customers/0820000002", { name: "Gap B", phone: "0820000002", archivedAt: 1, archivedBy: OWNER_EMAIL });
console.log("── THE GAP, on today's live rules (these SHOULD all succeed) ──");
await expectAllowed("TODAY: an ordinary till deletes a customer outright",
  as(TILL, "DELETE", "customers/0820000001"));
await expectAllowed("TODAY: an ordinary till archives a customer",
  as(TILL, "PATCH", "customers/0820000002", { archivedAt: 2, archivedBy: "till1@marathon.internal" }));
await expectAllowed("TODAY: an ordinary till unarchives a customer",
  as(TILL, "PATCH", "customers/0820000002", { archivedAt: null }));
console.log("");

{
  const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, {
    method: "PUT", headers: OWNER_HDR, body: JSON.stringify(candidate),
  });
  if (!r.ok) { console.error(`could not load the candidate rules: ${r.status} ${await r.text()}`); stop(); process.exit(2); }
}
// PROVE THE RULES ARE ACTUALLY ON before asserting anything. An emulator with no
// rules loaded allows everything, and every "must be denied" case would then
// fail loudly — but every "must be allowed" case would PASS for the wrong
// reason. This is the control: a path the live document locks outright.
{
  const control = await as(TILL, "GET", "shopify_sync/anything");
  if (control.status !== 401 && control.status !== 403) {
    console.error(`CONTROL FAILED: /shopify_sync is .read:false in the live rules but answered ${control.status}. ` +
      `The rules are not being enforced — every result below would be meaningless.`);
    stop(); process.exit(2);
  }
}
console.log(`emulator up on ${PORT}, candidate rules loaded and enforced\n`);

// ── Seed ─────────────────────────────────────────────────────────────────────
// `users/{uid}` exists for both identities because the /customers .read rule
// asks for it, and a read that fails for the wrong reason is a false negative.
await admin.put("users/owner-uid", { role: "admin" });
await admin.put("users/till-uid", { role: "cashier" });
await admin.put("users/scoped-uid", { role: "cashier", destShop: "pe" });
await admin.put("customers/0821112222", { name: "Plain Customer", phone: "0821112222", code: "C-1001" });
await admin.put("customers/0823334444", { name: "Archived Customer", phone: "0823334444", archivedAt: 1788500000000, archivedBy: OWNER_EMAIL });
await admin.put("customers/0825556666", { name: "Rekey Candidate", phone: "0825556666" });

console.log("── what an ordinary till must STILL be able to do ──");
// This is the half that matters most. The outage this suite exists to prevent
// was not an over-permissive rule; it was an over-restrictive one.
await expectAllowed("a normal sale writes its order",
  as(TILL, "PUT", "orders/order-1", { customerId: "0821112222", status: "ready", total: 100, destShop: "pe" }));
await expectAllowed("a normal sale writes an insights_log row",
  as(TILL, "PUT", "insights_log/2026-09-05/o1", { total: 100 }));
await expectAllowed("a customer is CREATED at order time",
  as(TILL, "PUT", "customers/0829998888", { name: "New Customer", phone: "0829998888" }));
await expectAllowed("the order-time upsert patches an existing customer",
  as(TILL, "PATCH", "customers/0821112222", { name: "Plain Customer", orderCount: 4 }));
await expectAllowed("the C-number transaction claims a code",
  as(TILL, "PUT", "customers/0829998888/code", "C-1099"));
await expectAllowed("store credit is written",
  as(TILL, "PUT", "customers/0821112222/storeCredit/cr1", { remainingAmount: 500 }));
await expectAllowed("store credit is SPENT DOWN (the validate still allows a decrease)",
  as(TILL, "PUT", "customers/0821112222/storeCredit/cr1/remainingAmount", 200));
await expectAllowed("a lay-by holding is added",
  as(TILL, "PUT", "customers/0821112222/laybyHoldings/sale-9", { qty: 1 }));
await expectAllowed("a lay-by holding is CLEARED (a null child is not a record delete)",
  as(TILL, "DELETE", "customers/0821112222/laybyHoldings/sale-9"));
await expectAllowed("a name edit",
  as(TILL, "PUT", "customers/0821112222/name", "Renamed"));
await expectAllowed("a merge tombstone is repointed",
  as(TILL, "PUT", "customers/0821112222/mergedInto", "0829998888"));
await expectAllowed("the till can still READ customers",
  as(TILL, "GET", "customers/0821112222"));

// ── A MULTI-PATH ROOT UPDATE IS SPLIT AND EVALUATED PER PATH ────────────────
// Both apps write customer fields inside a root update() alongside an audit
// entry. If the rules engine judged such a write at the ROOT — where nothing
// grants — every one of them would break. It does not: each path is evaluated
// at its own location. Asserted because the whole change depends on it.
await expectAllowed("a multi-path root update carrying a name edit and an audit row",
  as(TILL, "PATCH", "", {
    "customers/0821112222/name": "Multi Path",
    "pos/audit/audit-1": { action: "customer_edited", actingUserUid: "till-uid", timestamp: 1788600000000 },
  }));

console.log("\n── what an ordinary till must NOT be able to do ──");
await expectDenied("delete a whole customer record",
  as(TILL, "DELETE", "customers/0821112222"));
await expectDenied("delete a customer by PUTting null over it",
  as(TILL, "PUT", "customers/0821112222", null));
await expectDenied("ARCHIVE a customer",
  as(TILL, "PATCH", "customers/0821112222", { archivedAt: 1788600000000, archivedBy: "till1@marathon.internal" }));
await expectDenied("archive by writing the leaf directly",
  as(TILL, "PUT", "customers/0821112222/archivedAt", 1788600000000));
await expectDenied("UNARCHIVE a customer (the validate-shaped hole)",
  as(TILL, "PATCH", "customers/0823334444", { archivedAt: null, archivedBy: null }));
await expectDenied("unarchive by deleting the leaf",
  as(TILL, "DELETE", "customers/0823334444/archivedAt"));
await expectDenied("forge archivedBy as somebody else while editing a name",
  as(TILL, "PATCH", "customers/0821112222", { name: "X", archivedBy: OWNER_EMAIL }));
await expectDenied("rewrite the whole customer book in one call",
  as(TILL, "PATCH", "customers", { "0821112222": null }));

// ── THE EDGE THE RULE DELIBERATELY REFUSES ──────────────────────────────────
// "The record must still exist after the write" means emptying a record is a
// delete, whatever path it was written through. No till flow does this — every
// customer carries a name and a phone, and clearing one field leaves the rest —
// but it is the shape most likely to be reached for by someone trying to get
// round the rule, so it is pinned.
await admin.put("customers/0827778888", { laybyHoldings: { s1: { qty: 1 } } });
await expectDenied("empty a record out one field at a time until nothing is left",
  as(TILL, "DELETE", "customers/0827778888/laybyHoldings"));

// ── THE MULTI-PATH ROUTE ROUND THE RULE ─────────────────────────────────────
// Both apps write customer fields inside a ROOT update() next to a /pos/audit
// row, so that is the shape anyone bypassing this rule would reach for first.
// It is split and evaluated per path, so it is refused for the same reasons —
// but that is a claim about the rules engine, and claims about engines belong
// in a test.
await admin.put("customers/0826660001", { name: "MP A", phone: "0826660001" });
await admin.put("customers/0826660002", { name: "MP B", phone: "0826660002" });
await expectDenied("archive inside a multi-path root update",
  as(TILL, "PATCH", "", { "customers/0826660001/archivedAt": 9,
    "pos/audit/mp-1": { action: "x", actingUserUid: "till-uid", timestamp: 1788600000000 } }));
await expectDenied("delete inside a multi-path root update",
  as(TILL, "PATCH", "", { "customers/0826660002": null }));
await expectDenied("anonymous delete inside a multi-path root update",
  as(ANON, "PATCH", "", { "customers/0826660002": null }));

// ── TYPE CONFUSION AROUND THE .val() COMPARISON ─────────────────────────────
// The rule compares archivedAt/archivedBy by .val(). A child written as an
// OBJECT returns the object from .val(), and two object values are never ===
// in the rules language — so this is refused, not accidentally equal. Pinned
// because "compare two values" is exactly where a rule quietly stops meaning
// what it reads as.
await expectDenied("archivedAt written as an object rather than a timestamp",
  as(TILL, "PUT", "customers/0826660001/archivedAt", { t: 1 }));

// ── AND WHAT AN ARCHIVED RECORD STILL ACCEPTS ───────────────────────────────
// Archived is not frozen. Store credit and lay-bys on an archived customer must
// still be writable — the money outlives the visibility flag — and a whole-record
// PUT is fine as long as it carries the archive fields through unchanged.
await expectAllowed("a whole-record PUT that KEEPS archivedAt",
  as(TILL, "PUT", "customers/0823334444",
    { name: "Archived Customer", phone: "0823334444", archivedAt: 1788500000000, archivedBy: OWNER_EMAIL }));
await expectAllowed("store credit still moves on an archived customer",
  as(TILL, "PUT", "customers/0823334444/storeCredit/cr9/remainingAmount", 100));
await expectDenied("but a whole-record PUT that DROPS archivedAt is an unarchive",
  as(TILL, "PUT", "customers/0823334444", { name: "Archived Customer", phone: "0823334444" }));

console.log("\n── what the OWNER must be able to do ──");
await expectAllowed("owner archives a customer",
  as(OWNER, "PATCH", "customers/0821112222", { archivedAt: 1788600000000, archivedBy: OWNER_EMAIL }));
await expectAllowed("owner unarchives a customer",
  as(OWNER, "PATCH", "customers/0823334444", { archivedAt: null, archivedBy: null }));
await expectAllowed("owner deletes a customer outright",
  as(OWNER, "DELETE", "customers/0821112222"));

console.log("\n── anonymous is still nowhere near it ──");
await expectDenied("anonymous cannot write a customer",
  as(ANON, "PUT", "customers/0827770000", { name: "Nope" }));
await expectDenied("anonymous cannot read a customer",
  as(ANON, "GET", "customers/0823334444"));

console.log("\n── the consequence this rule accepts, stated out loud ──");
// marathon-pos-app's phone re-key finishes by DELETING the old key. Under this
// rule a till cannot do that. The POS gates a phone change on the owner in the
// same breath (see customersOwnerOnly.mjs); this case is asserted so the
// coupling is a test failure if anyone ever loosens one without the other.
await expectDenied("a till's phone re-key cannot delete the old key",
  as(TILL, "DELETE", "customers/0825556666"));
await expectAllowed("the owner's phone re-key can",
  as(OWNER, "DELETE", "customers/0825556666"));

console.log("\n── the /orders index is a hint, not a gate ──");
// The point of the index: the server answers this from an index instead of
// streaming /orders. An UNINDEXED orderByChild still answers 200 with a
// server warning, so this case proves the query is legal, not that it is fast
// — the speed claim is measured live, after the apply, not asserted here.
const CUSTOMER_QS = `orderBy=${encodeURIComponent('"customerId"')}&equalTo=${encodeURIComponent('"0821112222"')}`;
await expectAllowed("an unscoped user's customerId query is answered",
  as(TILL, "GET", "orders", undefined, CUSTOMER_QS));
await expectAllowed("the owner's customerId query is answered — this is the removal check",
  as(OWNER, "GET", "orders", undefined, CUSTOMER_QS));
// ── A SHOP-SCOPED TILL STILL CANNOT ASK IT, AND THAT IS THE EXISTING RULE ────
// /orders' live .read confines a user who HAS a destShop to querying by
// destShop. The index does not change that and must not: the removal check is
// owner-only in the UI, and the owner carries no destShop. Asserted so that a
// future reader does not mistake the index for a widening of read access.
await expectDenied("a shop-scoped till cannot query /orders by customerId",
  as(SCOPED_TILL, "GET", "orders", undefined, CUSTOMER_QS));
await expectAllowed("writes to /orders still work with the extra index",
  as(TILL, "PUT", "orders/order-2", { customerId: "0829998888", status: "new", destShop: "pe" }));

stop();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log("PROVEN — the candidate rules may be applied.");

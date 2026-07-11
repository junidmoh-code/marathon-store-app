// Sale-forgery lock — emulator rules battery.
// Proves: (1) a non-staff token (self-signup attacker, no /users record) CANNOT
// forge sales or payment events; (2) real provisioned staff still can; (3) bad
// field values are rejected even for staff; (4) super-admin works.
// Run under: firebase emulators:exec --only database "node test.mjs"
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import { ref, set, update, get } from "firebase/database";
import { readFileSync } from "fs";

const STAFF_UID = "staff_pos_1";       // seeded into /users → isStaff true
const ATTACKER_UID = "attacker_selfsignup"; // NO /users record → isStaff false
const ADMIN_EMAIL = "gunidmoh@gmail.com";
const EXIST_SALE = "-ExistingSale123";

const results = [];
const rec = (name, pass) => { results.push({ name, pass }); console.log(`  ${pass ? "PASS ✓" : "FAIL ✗"}  ${name}`); };

const validSale = { saleId: "x", total: 75000, type: "sale", status: "completed", storeId: "pe", tillId: "till-1", cashierUid: STAFF_UID };
const validEvent = { at: 1783700000000, amount: 75000, method: "card", kind: "sale", saleId: "x", storeId: "pe", tillId: "till-1", cashierUid: STAFF_UID };
const validPayment = { paymentId: "p1", method: "cash", amount: 75000 };

const testEnv = await initializeTestEnvironment({
  projectId: "demo-forgery",
  database: { rules: readFileSync(new URL("../database.rules.json", import.meta.url), "utf8"), host: "127.0.0.1", port: 9010 },
});

// Seed baseline data with rules DISABLED (bypass): one staff /users record + one existing sale.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.database();
  await set(ref(db, `users/${STAFF_UID}`), { role: "store_assistant", stockRole: "pos", displayName: "Test Cashier" });
  await set(ref(db, `pos/sales/${EXIST_SALE}`), { saleId: EXIST_SALE, total: 50000, type: "sale", status: "completed", storeId: "pe", tillId: "till-1", payments: { pOld: { paymentId: "pOld", method: "cash", amount: 50000 } }, lineItems: { l1: { productId: "prod1", qty: 1, refundedQty: 0 } } });
});

const attacker = testEnv.authenticatedContext(ATTACKER_UID).database();   // no /users record
const staff = testEnv.authenticatedContext(STAFF_UID).database();          // has /users record
const admin = testEnv.authenticatedContext("superadmin_uid", { email: ADMIN_EMAIL }).database();

async function expectDeny(name, p) { try { await assertFails(p); rec(name, true); } catch { rec(name, false); } }
async function expectAllow(name, p) { try { await assertSucceeds(p); rec(name, true); } catch (e) { rec(name, false); } }

console.log("\n== A. ATTACKER (self-signup, no /users record) — must be DENIED ==");
await expectDeny("attacker forge NEW /pos/sales", set(ref(attacker, "pos/sales/-forged1"), validSale));
await expectDeny("attacker forge /pos/paymentEvents", set(ref(attacker, "pos/paymentEvents/-forgedEv1"), validEvent));
await expectDeny("attacker mutate existing sale status", set(ref(attacker, `pos/sales/${EXIST_SALE}/status`), "voided"));
await expectDeny("attacker add payment to existing sale", set(ref(attacker, `pos/sales/${EXIST_SALE}/payments/pHack`), validPayment));

console.log("\n== B. REAL STAFF (has /users record) — must be ALLOWED (trading keeps working) ==");
await expectAllow("staff create real sale", set(ref(staff, "pos/sales/-realSale1"), validSale));
await expectAllow("staff write real payment event", set(ref(staff, "pos/paymentEvents/-realEv1"), validEvent));
await expectAllow("staff update existing sale status", set(ref(staff, `pos/sales/${EXIST_SALE}/status`), "voided"));
await expectAllow("staff add payment to existing sale (layby instalment)", set(ref(staff, `pos/sales/${EXIST_SALE}/payments/pNew`), validPayment));
await expectAllow("staff bump refundedQty on existing line", set(ref(staff, `pos/sales/${EXIST_SALE}/lineItems/l1/refundedQty`), 1));

console.log("\n== C. STAFF but BAD DATA — validation must REJECT ==");
await expectDeny("sale with bogus type 'hacked'", set(ref(staff, "pos/sales/-bad1"), { ...validSale, type: "hacked" }));
await expectDeny("sale with non-numeric total", set(ref(staff, "pos/sales/-bad2"), { ...validSale, total: "lots" }));
await expectDeny("payment event with bogus method 'bitcoin'", set(ref(staff, "pos/paymentEvents/-bad3"), { ...validEvent, method: "bitcoin" }));
await expectDeny("payment event with non-numeric amount", set(ref(staff, "pos/paymentEvents/-bad4"), { ...validEvent, amount: "free" }));
await expectDeny("payment with bogus method 'crypto'", set(ref(staff, `pos/sales/${EXIST_SALE}/payments/pBad`), { ...validPayment, method: "crypto" }));

console.log("\n== D. SUPER-ADMIN (email) — must be ALLOWED ==");
await expectAllow("super-admin create sale", set(ref(admin, "pos/sales/-adminSale1"), validSale));

console.log("\n== E. REAL-SHAPE regression — a full multi-tender layby + refund event still validate ==");
await expectAllow("layby sale (type layby, negative-free)", set(ref(staff, "pos/sales/-layby1"), { ...validSale, type: "layby", total: 70000 }));
await expectAllow("refund sale (negative total)", set(ref(staff, "pos/sales/-refund1"), { ...validSale, type: "refund", total: -70000 }));
await expectAllow("refund payment event (negative amount, method storeCredit)", set(ref(staff, "pos/paymentEvents/-refundEv1"), { ...validEvent, kind: "refund", amount: -70000, method: "storeCredit" }));
await expectAllow("eft payment event", set(ref(staff, "pos/paymentEvents/-eftEv1"), { ...validEvent, method: "eft", kind: "on_account_payment" }));

await testEnv.cleanup();

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n==== RESULT: ${passed}/${results.length} passed ====`);
if (failed.length) { console.log("FAILURES:"); failed.forEach((f) => console.log("  ✗ " + f.name)); process.exit(1); }
console.log("ALL GREEN — forged writes blocked, real staff writes allowed, bad data rejected.");
process.exit(0);

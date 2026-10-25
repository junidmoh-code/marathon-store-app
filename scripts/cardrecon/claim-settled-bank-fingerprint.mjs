// ─── MARK A HAND-SETTLED BANK REFUSAL'S TRANSACTION ID AS SPENT ──────────────
// Junid, 25 Oct 2026. A bank notification REFUSED before refusals claimed
// their transaction id (eftCore refusalFingerprint), and then settled by Junid
// by hand through a manual entry, leaves the bank's id unclaimed: a resent
// copy of the same PDF could land as fresh money. This claims that id as
// SPENT by the manual record, so the copy is held at ingest and refused at
// the settle.
//
//   node scripts/cardrecon/claim-settled-bank-fingerprint.mjs <refusedPoolKey> <usedPoolKey> [--execute]
//
// Without --execute it only reads and says what it would write. It writes ONE
// node, /eft_pool_fingerprints/{fp}, create-or-add-spender, never replacing a
// spender already there. NEITHER POOL RECORD IS EVER WRITTEN. The whole
// judgement is settledFingerprintPlan (eftCore.mjs), pure and tested.
import { createRequire } from "node:module";
import { EFT_POOL_PATH, EFT_FINGERPRINT_PATH, settledFingerprintPlan, settledClaimStep } from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const [refusedKey, spenderKey] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
if (!refusedKey || !spenderKey) {
  console.error("usage: claim-settled-bank-fingerprint.mjs <refusedPoolKey> <usedPoolKey> [--execute]");
  process.exit(2);
}

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();
try {
  const [refused, spender] = await Promise.all([
    db.ref(`${EFT_POOL_PATH}/${refusedKey}`).once("value").then((s) => s.val()),
    db.ref(`${EFT_POOL_PATH}/${spenderKey}`).once("value").then((s) => s.val()),
  ]);
  const plan = settledFingerprintPlan({ refusedKey, refused, spenderKey, spender });
  if (!plan.ok) { console.error(`✗ ${plan.why}`); process.exitCode = 1; }
  else {
    const path = `${EFT_FINGERPRINT_PATH}/${plan.fingerprint}`;
    const before = (await db.ref(path).once("value")).val();
    console.log(`· ${refusedKey} (${refused.outcome}, ${refused.reader}) and ${spenderKey} (used) are the same ${refused.amountCents}c payment`);
    console.log(`· ${path} now: ${JSON.stringify(before)}`);
    if (!EXECUTE) console.log("· dry run — re-run with --execute to mark the bank id spent by the used record");
    else {
      // The server's clock, not this machine's (serverNowMs, as in the poller).
      const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
      const res = await db.ref(path).transaction(settledClaimStep({ spenderKey, refusedKey, at: Date.now() + offset }));
      console.log(`${res.committed ? "✓ marked spent" : "· unchanged (a spender is already recorded)"}: ${JSON.stringify(res.snapshot.val())}`);
    }
  }
} finally {
  await admin.app().delete();
}

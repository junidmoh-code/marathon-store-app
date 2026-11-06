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
// Without --execute it only reads and says what it would write. It writes
// /eft_pool_fingerprints/{fp}, create-or-add-spender, never replacing a
// spender already there — and, since 6 Nov 2026, stamps the REFUSED notice
// itself `settledByHand: {spentBy, at}` (added once, never overwritten), so
// the EFT tab shows it handled and retry-eft-message.mjs refuses to re-run it
// (eftRetryPlan). The manual entry is NEVER written. The whole judgement is
// settledFingerprintPlan (eftCore.mjs), pure and tested. Run it once per
// refused copy: the second copy's claim is already spent (unchanged) and only
// its stamp is added.
import { createRequire } from "node:module";
import { EFT_POOL_PATH, EFT_FINGERPRINT_PATH, settledFingerprintPlan, settledClaimStep, settledByHandStep } from "./eftCore.mjs";

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
    console.log(`· ${refusedKey} (${refused.outcome}, ${refused.reader}) and ${spenderKey} (manual entry, ${spender.status}) are the same ${refused.amountCents}c payment`);
    console.log(`· ${path} now: ${JSON.stringify(before)}`);
    if (!EXECUTE) console.log("· dry run — re-run with --execute to mark the bank id spent by the manual entry");
    else {
      // The server's clock, not this machine's (serverNowMs, as in the poller).
      const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
      const at = Date.now() + offset;
      const res = await db.ref(path).transaction(settledClaimStep({ spenderKey, refusedKey, at }));
      console.log(`${res.committed ? "✓ marked spent" : "· unchanged (a spender is already recorded)"}: ${JSON.stringify(res.snapshot.val())}`);
      const stamp = await db.ref(`${EFT_POOL_PATH}/${refusedKey}`).transaction(settledByHandStep({ spenderKey, at }));
      console.log(`${stamp.committed ? "✓ refusal stamped" : "· refusal unchanged (already stamped, or gone)"}: settledByHand ${JSON.stringify(stamp.snapshot.val()?.settledByHand ?? null)}`);
    }
  }
} finally {
  await admin.app().delete();
}

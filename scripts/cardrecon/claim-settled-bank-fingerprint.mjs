// ─── MARK A HAND-SETTLED BANK REFUSAL'S TRANSACTION ID AS SPENT ──────────────
// Junid, 25 Oct 2026. A bank notification REFUSED before refusals claimed
// their transaction id (eftCore refusalFingerprint), and then settled by Junid
// by hand through a manual entry, leaves the bank's id unclaimed: a resent
// copy of the same PDF could land as fresh money. This claims that id as
// SPENT by the manual record, so the copy is held at ingest and refused at
// the settle.
//
//   node scripts/cardrecon/claim-settled-bank-fingerprint.mjs <refusedPoolKey> <usedPoolKey> [--execute]
//        [--notice-reference=<as printed>] [--reference-differs-ok]
//        [--absa-payer=<as printed> --absa-date=YYYY-MM-DD]
//
// 25 Nov 2026 (the R5,900 Absa "STD S.A." payment Junid floated by hand):
//   --notice-reference   the reference the notice prints, for a refusal that
//                        stored none (account refusals before 25 Nov 2026)
//   --reference-differs-ok  Junid typed his entry with another spelling and
//                        has said it is the same money: allowed on the same
//                        amount; the difference is written on claim and stamp
//   --absa-payer/--absa-date  ALSO spend the payment's Absa blank-number
//                        identity (settledSyntheticPlan), so a copy that
//                        leaves the transaction number blank is held too
//
// Without --execute it only reads and says what it would write. It writes
// /eft_pool_fingerprints/{fp}, create-or-add-spender, never replacing a
// spender already there — and, since 6 Nov 2026, stamps the REFUSED notice
// itself `settledByHand: {spentBy, at}` (added once, never overwritten), so
// retry-eft-message.mjs refuses to re-run it (eftRetryPlan) — an audit mark
// on the record; the owner's EFT tab does not display it yet. The manual entry is NEVER written. The whole judgement is
// settledFingerprintPlan (eftCore.mjs), pure and tested. Run it once per
// refused copy: the second copy's claim is already spent (unchanged) and only
// its stamp is added. A manual entry floated but not yet used counts as the
// spender; if Junid later reverses it, the bank id STAYS spent — the money is
// blocked, never doubled (fails safe; a person decides).
import { createRequire } from "node:module";
import { EFT_POOL_PATH, EFT_FINGERPRINT_PATH, settledFingerprintPlan, settledSyntheticPlan, settledClaimStep, settledByHandStep } from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

const [refusedKey, spenderKey] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const EXECUTE = process.argv.includes("--execute");
const flag = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const noticeReference = flag("notice-reference");
const referenceDiffersOk = process.argv.includes("--reference-differs-ok");
const absaPayer = flag("absa-payer");
const absaDate = flag("absa-date");
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
  const plan = settledFingerprintPlan({ refusedKey, refused, spenderKey, spender, noticeReference, referenceDiffersOk });
  const synthetic = plan.ok && (absaPayer || absaDate)
    ? settledSyntheticPlan({ refused, payer: absaPayer, paymentDate: absaDate, reference: noticeReference })
    : null;
  if (synthetic && !synthetic.ok) { console.error(`✗ ${synthetic.why}`); process.exitCode = 1; }
  else if (!plan.ok) { console.error(`✗ ${plan.why}`); process.exitCode = 1; }
  else {
    const referenceDiffers = plan.referenceDiffers ?? null;
    if (referenceDiffers) console.log(`· the references differ — notice "${referenceDiffers.notice}", entry "${referenceDiffers.entry}" — linked on Junid's word (--reference-differs-ok); written on the claim and the stamp`);
    const path = `${EFT_FINGERPRINT_PATH}/${plan.fingerprint}`;
    const before = (await db.ref(path).once("value")).val();
    console.log(`· ${refusedKey} (${refused.outcome}, ${refused.reader}) and ${spenderKey} (manual entry, ${spender.status}) are the same ${refused.amountCents}c payment`);
    console.log(`· ${path} now: ${JSON.stringify(before)}`);
    if (synthetic?.ok) console.log(`· also: Absa blank-number identity ${synthetic.syntheticRef} → ${EFT_FINGERPRINT_PATH}/${synthetic.fingerprint} now: ${JSON.stringify((await db.ref(`${EFT_FINGERPRINT_PATH}/${synthetic.fingerprint}`).once("value")).val())}`);
    if (!EXECUTE) console.log("· dry run — re-run with --execute to mark the bank id spent by the manual entry");
    else {
      // The server's clock, not this machine's (serverNowMs, as in the poller).
      const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
      const at = Date.now() + offset;
      const res = await db.ref(path).transaction(settledClaimStep({ spenderKey, refusedKey, at, referenceDiffers }));
      console.log(`${res.committed ? "✓ marked spent" : "· unchanged (a spender is already recorded)"}: ${JSON.stringify(res.snapshot.val())}`);
      // The notice is stamped with whoever the claim says spent the money —
      // only when that is THIS manual entry. A claim already spent by another
      // record is not this entry's to describe. (Sonnet architect review.)
      const claimSpentBy = res.snapshot.val()?.spentBy ?? null;
      if (claimSpentBy !== spenderKey) {
        console.error(`✗ the claim is spent by ${claimSpentBy ?? "nobody"}, not ${spenderKey} — the refused notice is NOT stamped`);
        process.exitCode = 1;
      } else {
        const stamp = await db.ref(`${EFT_POOL_PATH}/${refusedKey}`).transaction(settledByHandStep({ spenderKey, at, referenceDiffers }));
        const mark = stamp.snapshot.val()?.settledByHand ?? null;
        if (stamp.committed && mark?.spentBy === spenderKey && mark.at === at) console.log(`✓ refusal stamped: settledByHand ${JSON.stringify(mark)}`);
        else if (mark) console.log(`· refusal unchanged (already stamped): settledByHand ${JSON.stringify(mark)}`);
        else { console.error(`✗ ${refusedKey} could not be stamped (gone, recorded or held)`); process.exitCode = 1; }
      }
      // Only when THIS entry holds the bank id: never give one payment's two
      // identities to two different spenders. (CodeRabbit, #998.)
      if (synthetic?.ok && claimSpentBy === spenderKey) {
        const spath = `${EFT_FINGERPRINT_PATH}/${synthetic.fingerprint}`;
        const sres = await db.ref(spath).transaction(settledClaimStep({ spenderKey, refusedKey, at, referenceDiffers }));
        const sBy = sres.snapshot.val()?.spentBy ?? null;
        if (sBy === spenderKey) console.log(`✓ Absa blank-number identity ${synthetic.syntheticRef} spent too: ${JSON.stringify(sres.snapshot.val())}`);
        else { console.error(`✗ the Absa blank-number identity ${spath} is spent by ${sBy ?? "nobody"}, not ${spenderKey} — check it`); process.exitCode = 1; }
      } else if (synthetic?.ok) console.error("✗ the Absa blank-number identity is NOT claimed: the bank id is not spent by this entry");
    }
  }
} finally {
  await admin.app().delete();
}

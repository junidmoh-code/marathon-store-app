// ─── REPAIR: THE TWO REMAINDERS HELD ONLY BECAUSE THE SALE WAS STILL QUEUED ──
// 21 Oct 2026. Both EFT remainders on the owner's unallocated list were held
// for the same reason — the till's outbox had not landed the sale when the
// attach read it back ("the sale was not on the server when the payment was
// attached") — and the later sale check verified both sales but never turned
// the hold into credit (fixed in functions/lib/eft-settle.cjs, this PR).
//
//   78a7321f… D MOODLEY R1,150 → R150 sale S-46291 (PE till-2), customer Deran
//     27785056874. Junid ISSUED THE R1,000 BY HAND at 09:11:55 (manual credit
//     -P4SIKbsY4LFM8pN5TMQ), spent at Trophy at 09:12:19 (S-45738). This
//     marks the hold resolvedByHand with that credit id and takes it off the
//     list, so it can never be allocated or promoted a second time.
//   0ce50318… "Suhana Abdul" R390 → R350 sale S-45729 (Trophy till-1),
//     customer Daud 0655953203. Nobody issued the R40. This re-queues the sale
//     check, so the DEPLOYED eftRemainderScan promotes it through the one mint
//     (no money is written by this script) — but only if Daud's ledger shows
//     no R40 credit since the sale.
//
// Every read is one record or one customer's ledger, never a node.
//   node scripts/eft/repair-held-remainders-20261021.mjs            # dry run
//   node scripts/eft/repair-held-remainders-20261021.mjs --execute
import { adminRequire } from "../adminRequire.mjs";

const require = adminRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const EXECUTE = process.argv.includes("--execute");

const HAND = { key: "78a7321f06c0b50667c396a73b11088f134dc57b", customerId: "27785056874", creditId: "-P4SIKbsY4LFM8pN5TMQ", cents: 100000 };
const PROMOTE = { key: "0ce5031807e8bf5765368bab4c554c36aa8d8316", customerId: "0655953203", cents: 4000 };

async function resolveByHand() {
  const [rec, credit] = await Promise.all([
    db.ref(`eft_pool/${HAND.key}`).once("value").then((s) => s.val()),
    db.ref(`pos/storeCredits/${HAND.creditId}`).once("value").then((s) => s.val()),
  ]);
  const r = rec?.used?.remainder;
  if (!r || r.disposition !== "unallocated" || r.status !== "held" || r.cents !== HAND.cents || rec.used.customerId !== HAND.customerId) {
    console.log(`${HAND.key}: not the expected held R1,000 — left alone`, JSON.stringify(r)); return;
  }
  if (r.resolvedByHand) {
    // A run that crashed between the mark and the removal: finish the removal.
    console.log(`${HAND.key}: already resolvedByHand — removing any eft_unallocated entry left behind`);
    if (EXECUTE) await db.ref(`eft_unallocated/${HAND.key}`).remove();
    return;
  }
  if (credit?.customerId !== HAND.customerId || credit?.issuedAmount !== HAND.cents) {
    console.log(`${HAND.key}: hand credit ${HAND.creditId} does not match — left alone`, JSON.stringify(credit)); return;
  }
  console.log(`${HAND.key}: mark resolvedByHand by Junid with ${HAND.creditId}, remove eft_unallocated/${HAND.key}`);
  if (!EXECUTE) return;
  const at = Date.now();
  const res = await db.ref(`eft_pool/${HAND.key}/used/remainder`).transaction((cur) => {
    if (cur === null) return null; // cold cache: CAS against the server
    if (cur.disposition !== "unallocated" || cur.resolvedByHand) return undefined;
    return { ...cur, resolvedByHand: { creditId: HAND.creditId, by: "Junid", at, note: "issued by hand as manual credit; held because the sale was still queued at attach" } };
  });
  console.log(`  committed=${res.committed}`);
  if (res.committed) await db.ref(`eft_unallocated/${HAND.key}`).remove();
}

async function requeuePromotion() {
  const rec = (await db.ref(`eft_pool/${PROMOTE.key}`).once("value")).val();
  const r = rec?.used?.remainder;
  if (!r || r.disposition !== "unallocated" || r.status !== "held" || r.cents !== PROMOTE.cents || rec.used.customerId !== PROMOTE.customerId || r.resolvedByHand) {
    console.log(`${PROMOTE.key}: not the expected held R40 — left alone`, JSON.stringify(r)); return;
  }
  const since = rec.used.at;
  const txns = (await db.ref(`pos/creditLedger/${PROMOTE.customerId}/txns`).orderByChild("at").startAt(since).once("value")).val() || {};
  // Any positive R40 since the sale, whatever its kind/source — a hand credit
  // must never be doubled.
  const handIssued = Object.values(txns).filter((t) => t?.amount === PROMOTE.cents);
  if (handIssued.length) { console.log(`${PROMOTE.key}: a R40 credit already exists since the sale — left alone`, JSON.stringify(handIssued)); return; }
  console.log(`${PROMOTE.key}: re-queue the sale check for ${rec.used.sale?.saleId} — the scan promotes R40 to ${PROMOTE.customerId}`);
  if (!EXECUTE) return;
  await db.ref(`eft_pending_sale_checks/${PROMOTE.key}`).set({ at: Date.now(), saleId: rec.used.sale.saleId });
}

await resolveByHand();
await requeuePromotion();
console.log(EXECUTE ? "done" : "dry run — pass --execute to write");
process.exit(0);

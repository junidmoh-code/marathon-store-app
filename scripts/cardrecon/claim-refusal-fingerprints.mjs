// ─── ONE-OFF: CLAIM THE BANK ID OF EVERY REFUSAL WRITTEN BEFORE THEY CLAIMED ─
// Junid, 25 Oct 2026. Since #796 every DKIM-verified refusal claims its bank
// transaction id as it is written. Refusals written BEFORE that claimed
// nothing, so a copy resent once the refusal reason stops applying (a reader
// learns a marker, the cutoff moves, an account is allowlisted) would land as
// fresh money. This walks /eft_pool IN PAGES (key order, the way the remainder
// scan's spent backfill does — never one whole-node read) and claims each
// such refusal's id, create-only, naming the refusal.
//
//   node scripts/cardrecon/claim-refusal-fingerprints.mjs [--execute]
//
// Without --execute it only reads and counts. An id already claimed is never
// touched; when its holder is a DIFFERENT record that is still spendable
// (recorded / unmatched), that is a copy of refused money already floating —
// it is LISTED for Junid, and nothing is changed for it here. Writes only
// /eft_pool_fingerprints; never a pool record.
import { createRequire } from "node:module";
import { EFT_POOL_PATH, EFT_FINGERPRINT_PATH, fingerprintClaimStep, sweepRefusalClaim } from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PAGE = 200;
const EXECUTE = process.argv.includes("--execute");

admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: DATABASE_URL });
const db = admin.database();
const counts = { scanned: 0, refusals: 0, claimed: 0, alreadyTheirs: 0, heldElsewhere: 0 };
const floating = [];
try {
  const offset = (await db.ref(".info/serverTimeOffset").once("value")).val() || 0;
  let cursor = null;
  for (;;) {
    let q = db.ref(EFT_POOL_PATH).orderByKey();
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.limitToFirst(PAGE).once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });
    if (!keys.length) break;
    const page = snap.val() || {};
    for (const key of keys) {
      counts.scanned++;
      const need = sweepRefusalClaim(page[key]);
      if (!need) continue;
      counts.refusals++;
      const path = `${EFT_FINGERPRINT_PATH}/${need.fingerprint}`;
      const existing = (await db.ref(path).once("value")).val();
      if (existing?.poolKey === key) { counts.alreadyTheirs++; continue; }
      if (existing) {
        counts.heldElsewhere++;
        const holder = (await db.ref(`${EFT_POOL_PATH}/${existing.poolKey}`).once("value")).val();
        if (holder?.outcome === "recorded" && holder.status === "unmatched" && !existing.spentBy) {
          floating.push({ refused: key, spendableCopy: existing.poolKey, amountCents: holder.amountCents, reference: holder.reference });
        }
        continue;
      }
      if (EXECUTE) {
        const res = await db.ref(path).transaction(fingerprintClaimStep(key, Date.now() + offset));
        if (res.committed && res.snapshot.val()?.poolKey === key) counts.claimed++;
        else counts.heldElsewhere++;
      } else counts.claimed++;
    }
    cursor = keys[keys.length - 1];
  }
  console.log(`${EXECUTE ? "✓ swept" : "· dry run"}: ${JSON.stringify(counts)}${EXECUTE ? "" : " (claimed = would claim)"}`);
  if (floating.length) {
    console.log("⚠ A SPENDABLE copy already holds a refused payment's bank id — check each against the bank statement:");
    for (const f of floating) console.log(`   refused ${f.refused} · spendable ${f.spendableCopy} · ${f.amountCents}c · ${f.reference ?? "—"}`);
  }
} finally {
  await admin.app().delete();
}

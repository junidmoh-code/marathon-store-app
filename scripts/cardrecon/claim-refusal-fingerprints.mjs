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
// touched; when its holder is a DIFFERENT record that was ADMITTED (outcome
// recorded, whatever its status — unmatched, attached, used) or has vanished,
// that is a copy of refused money that got in — it is LISTED for Junid with
// its status, and nothing is changed for it here. An ACCOUNT refusal written
// before refusals stored the bank id has nothing to claim: it is LISTED too
// (CodeRabbit), to be checked against the statement — its resend, after the
// account is allowlisted, would not be held. Writes only
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
const counts = { scanned: 0, refusals: 0, claimed: 0, alreadyTheirs: 0, heldElsewhere: 0, legacyAccountNoBankRef: 0 };
const floating = [];
const legacy = [];
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
      if (!need) {
        const r = page[key];
        if (r?.outcome === "refused-account" && r.auth?.verdict === "pass" && !r.bankRef) {
          counts.legacyAccountNoBankRef++;
          legacy.push({ key, reader: r.reader, amountCents: r.amountCents, receivedAt: r.receivedAt });
        }
        continue;
      }
      counts.refusals++;
      const path = `${EFT_FINGERPRINT_PATH}/${need.fingerprint}`;
      const existing = (await db.ref(path).once("value")).val();
      if (existing?.poolKey === key) { counts.alreadyTheirs++; continue; }
      if (existing) {
        counts.heldElsewhere++;
        const holderKey = typeof existing.poolKey === "string" ? existing.poolKey : null;
        const holder = holderKey ? (await db.ref(`${EFT_POOL_PATH}/${holderKey}`).once("value")).val() : null;
        if (!holder || holder.outcome === "recorded") {
          floating.push({
            refused: key, copy: holderKey ?? "(corrupt claim)",
            state: holder ? `${holder.reader ?? "?"} ${holder.status ?? "?"}${existing.spentBy ? `, spent by ${existing.spentBy}` : ""}` : "holder record missing",
            amountCents: holder?.amountCents ?? null, reference: holder?.reference ?? null,
          });
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
  if (legacy.length) {
    console.log("⚠ ACCOUNT refusals from before the bank id was stored — nothing to claim; check each on the statement before allowlisting its account:");
    for (const l of legacy) console.log(`   ${l.key} · ${l.reader ?? "?"} · ${l.amountCents ?? "?"}c · arrived ${Number.isInteger(l.receivedAt) ? new Date(l.receivedAt + 7200000).toISOString().slice(0, 16) + " SAST" : "?"}`);
  }
  if (floating.length) {
    console.log("⚠ An ADMITTED copy (or a missing record) holds a refused payment's bank id — check each against the bank statement:");
    for (const f of floating) console.log(`   refused ${f.refused} · copy ${f.copy} (${f.state}) · ${f.amountCents ?? "?"}c · ${f.reference ?? "—"}`);
  }
} finally {
  await admin.app().delete();
}

// ─── 2 NOV 2026 — MARATHON PE TILL 2 AND TROPHY TILL 2 ARE STANDARD BANK ─────
// Both machines print MID 000000004977890 — Standard Bank's "THE MARATHON"
// merchant (SimplyBLU portal, 2 Nov 2026) — but their registry rows were
// written before `bank` existed, and ABSENT IS FNB (lib/card-terminals.cjs).
// From 3 Nov 2026 the SimplyBLU portal is the record for Standard Bank tills
// (lib/card-portal.cjs), and that is decided by `bank: "standard-bank"` on the
// row — so without this the two tills would keep waiting for a slip.
//
// Writes ONLY `bank` on the two rows, each in its own transaction that refuses
// a row not where it is expected, leaves a row that already says Standard Bank
// alone, and is audited in /card_terminal_audit like a settings-sheet edit.
//
//   node scripts/cardrecon/apply-terminal-bank-sb-20261102.mjs            # dry run
//   node scripts/cardrecon/apply-terminal-bank-sb-20261102.mjs --execute  # write + read back

import { createRequire } from "node:module";
import { adminRequire } from "../adminRequire.mjs";

// This worktree's functions install first, then the shared helper's fallbacks
// (CodeRabbit, #837: the helper resolves from scripts/, not scripts/cardrecon/).
let admin;
try { admin = createRequire(new URL("../../functions/package.json", import.meta.url))("firebase-admin"); }
catch { admin = adminRequire(new URL("../x.mjs", import.meta.url).href)("firebase-admin"); }
const EXECUTE = process.argv.includes("--execute");
const ROWS = [
  { tid: "0000HP1X", storeId: "pe", tillId: "till-2", mid: "000000004977890" },
  { tid: "0000Z4M6", storeId: "trophy", tillId: "till-2", mid: "000000004977890" },
];

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "marathon-club",
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();
let bad = 0;
for (const r of ROWS) {
  const ref = db.ref(`config/cardTerminals/${r.tid}`);
  const cur = (await ref.once("value")).val();
  if (!cur) { console.error(`✗ ${r.tid} is not registered`); bad++; continue; }
  if (cur.storeId !== r.storeId || cur.tillId !== r.tillId || cur.mid !== r.mid) {
    console.error(`✗ ${r.tid} is ${cur.storeId}/${cur.tillId} MID ${cur.mid} — not the row this expects; not touched`); bad++; continue;
  }
  if (cur.bank === "standard-bank") { console.log(`${r.tid}: already Standard Bank — nothing to do`); continue; }
  console.log(`${r.tid} (${cur.label}): ${EXECUTE ? "SET" : "would set"} bank = "standard-bank" (was ${cur.bank ?? "absent = FNB"})`);
  if (!EXECUTE) continue;
  const res = await ref.transaction((row) => {
    if (row === null || row.storeId !== r.storeId || row.tillId !== r.tillId || row.mid !== r.mid) return undefined;
    return { ...row, bank: "standard-bank" };
  });
  if (!res.committed) { console.error(`✗ ${r.tid}: the row changed while this ran — not written`); bad++; continue; }
  await db.ref("card_terminal_audit").push({
    at: admin.database.ServerValue.TIMESTAMP, by: "script:apply-terminal-bank-sb-20261102", action: "edit",
    tid: r.tid, before: { bank: cur.bank ?? null }, after: { bank: "standard-bank" },
    note: "MID 000000004977890 is Standard Bank (SimplyBLU 'THE MARATHON'); the portal is the record from 3 Nov 2026",
  });
  const back = (await ref.child("bank").once("value")).val();
  console.log(`  ${back === "standard-bank" ? "✓" : "✗"} read back: ${back}`);
  if (back !== "standard-bank") bad++;
}
if (!EXECUTE) console.log("\nDry run — nothing written. Re-run with --execute.");
process.exit(bad ? 1 : 0);

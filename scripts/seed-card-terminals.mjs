// ─── SEED /config/cardTerminals — map one FNB terminal (TID) to its till ─────
// The card-recon capture rejects any slip whose printed TID is not registered
// here. One row per physical terminal; run once per machine (and again only if
// a machine moves tills or is replaced).
//
//   node scripts/seed-card-terminals.mjs \
//     --tid 0000HP1X --mid 000000004977890 --store pe --till till-1 \
//     --label "PE Till 1" --execute
//
// Without --execute it prints what it WOULD write. Store ids are the POS ids
// (pe / pine / trophy) and till ids the POS till ids (till-1 / till-2) —
// exactly what /pos/paymentEvents rows carry, because the expected-card
// calculator joins on them verbatim.

import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};
const EXECUTE = process.argv.includes("--execute");

const tid = (arg("tid") || "").trim().toUpperCase();
const mid = (arg("mid") || "").trim();
const storeId = (arg("store") || "").trim();
const tillId = (arg("till") || "").trim();
const label = (arg("label") || "").trim();

if (!/^[A-Z0-9]{4,16}$/.test(tid)) { console.error("--tid must be 4-16 alphanumerics (as printed on the slip)"); process.exit(1); }
if (!["pe", "pine", "trophy"].includes(storeId)) { console.error("--store must be pe | pine | trophy (the POS store ids)"); process.exit(1); }
if (!/^till-\d$/.test(tillId)) { console.error("--till must be a POS till id, e.g. till-1"); process.exit(1); }
if (!label) { console.error("--label is required, e.g. \"PE Till 1\""); process.exit(1); }

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const row = { mid: mid || null, storeId, tillId, label };
const path = `config/cardTerminals/${tid}`;

const existing = (await db.ref(path).get()).val();
if (existing) console.log("EXISTING row:", JSON.stringify(existing));
console.log(`${EXECUTE ? "WRITING" : "WOULD write"} /${path}:`, JSON.stringify(row));
if (EXECUTE) {
  await db.ref(path).set(row);
  console.log("done — verify:", JSON.stringify((await db.ref(path).get()).val()));
}
process.exit(0);

#!/usr/bin/env node
// ALL NEW ARRIVALS ARE POSTED (Junid, 21 Nov 2026) — by hand (bfNaAutoApprove does it every 10 minutes).
//   node scripts/blackFriday/naApproveAll.cjs            dry run: counts and reasons, nothing written
//   node scripts/blackFriday/naApproveAll.cjs --apply    approve
"use strict";
const path = require("node:path");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const bf = require(path.join(__dirname, "../../functions/blackFriday/blackFriday.js"))._internals;
const naAuto = require(path.join(__dirname, "../../functions/blackFriday/naAuto.cjs"));

naAuto.run(admin.database(), { apply: process.argv.includes("--apply"), list: bf.list, many: bf.many, detail: true })
  .then((out) => { console.log(JSON.stringify(out, null, 1)); process.exit(0); }, (e) => { console.error(e); process.exit(1); });

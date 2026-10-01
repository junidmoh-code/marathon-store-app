// ─── THE CONSOLE RULES DEVICE ENROLMENT NEEDS — PRINTS THEM, PASTES NOTHING ──
//
// database.rules.json in this repo is STALE and console-managed; deploying it
// would regress the live rules. This reads a copy of the LIVE document, applies
// patchDeviceEnrolmentRules (deviceEnrolmentRules.mjs — what it changes and
// why is at the top of that file), and writes the complete document to paste.
// No deploy, no write to the database.
//
// Get the live document first (node on Junid's Mac cannot reach Google; curl
// can — reference_local_node_cannot_reach_google):
//   curl -s "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app/.settings/rules.json" \
//        -H "Authorization: Bearer $ACCESS_TOKEN" > live-rules.json
// Then:
//   node scripts/device-enrolment/prove-device-enrolment-rules.mjs live-rules.json   # prove first
//   node scripts/device-enrolment/print-device-enrolment-rules.mjs live-rules.json out.json
// and paste out.json whole into Firebase console → Realtime Database → Rules.
import { readFileSync, writeFileSync } from "node:fs";
import { patchDeviceEnrolmentRules, DEVICE_OK, DEVICE_ENROLMENT_NODE } from "./deviceEnrolmentRules.mjs";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error("usage: node print-device-enrolment-rules.mjs <live-rules.json> <out.json>");
  process.exit(2);
}
const live = JSON.parse(readFileSync(inFile, "utf8"));
const { doc, wrapped, readsWrapped } = patchDeviceEnrolmentRules(live);
const text = JSON.stringify(doc, null, 2);
writeFileSync(outFile, text + "\n");

console.log("════════ DEVICE ENROLMENT — RULES TO PASTE (whole document) ════════");
console.log(`written to ${outFile} (${text.length.toLocaleString()} characters; the console limit is 256 KB)`);
console.log(`\n1. ${wrapped.length} ".write" rules and ${readsWrapped.length} ".read" rules (all but /users and /mirror_switch) gain this condition (ANDed on; nothing else in them changes):\n`);
console.log(`   ${DEVICE_OK}\n`);
console.log("2. One new node:\n");
console.log(`"device_enrolment": ${JSON.stringify(DEVICE_ENROLMENT_NODE, null, 2)}`);
console.log(`\nPaths whose .write changed:\n  ${wrapped.join("\n  ")}`);

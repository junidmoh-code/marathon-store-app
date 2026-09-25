// ─── THE CONSOLE RULES DEVICE QUARANTINE NEEDS — PRINTS THEM, PASTES NOTHING ─
//
// database.rules.json in this repo is STALE and console-managed; deploying it
// would regress the live rules. This reads a copy of the LIVE document and
// writes the complete document to paste: the device quarantine patch
// (deviceQuarantineRules.mjs — what and why at the top of that file) and THEN
// the device enrolment patch (#647), so ONE paste carries both. Pasting them as
// two separate whole documents would make the second erase the first. If #647
// has already been pasted, its patch is a no-op here. No deploy, no write.
//
// Get the live document first (node on Junid's Mac cannot reach Google; curl
// can — reference_local_node_cannot_reach_google):
//   curl -s "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app/.settings/rules.json" \
//        -H "Authorization: Bearer $ACCESS_TOKEN" > live-rules.json
// Then:
//   node scripts/device-quarantine/prove-device-quarantine-rules.mjs live-rules.json   # prove first
//   node scripts/device-quarantine/print-device-quarantine-rules.mjs live-rules.json out.json
// and paste out.json whole into Firebase console → Realtime Database → Rules.
import { readFileSync, writeFileSync } from "node:fs";
import { patchDeviceQuarantineRules, STAMP_OK, DEVICE_REJECTS_NODE } from "./deviceQuarantineRules.mjs";
import { patchDeviceEnrolmentRules } from "../device-enrolment/deviceEnrolmentRules.mjs";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error("usage: node print-device-quarantine-rules.mjs <live-rules.json> <out.json>");
  process.exit(2);
}
const live = JSON.parse(readFileSync(inFile, "utf8"));
const { doc: quarantined, added } = patchDeviceQuarantineRules(live);
const { doc, wrapped } = patchDeviceEnrolmentRules(quarantined);
const text = JSON.stringify(doc, null, 2);
writeFileSync(outFile, text + "\n");

console.log("════════ DEVICE QUARANTINE (+ DEVICE ENROLMENT #647) — RULES TO PASTE (whole document) ════════");
console.log(`written to ${outFile} (${text.length.toLocaleString()} characters; the console limit is 256 KB)`);
console.log(`\n1. Added by the quarantine patch: ${added.length ? added.join(", ") : "nothing (already present)"}`);
console.log(`\n   orders/$id/stamps/$stamp and refill_requests/$refillId/stamps/$stamp → ".validate":\n   ${STAMP_OK}`);
console.log(`\n   "device_rejects": ${JSON.stringify(DEVICE_REJECTS_NODE, null, 2)}`);
console.log(`\n2. The device enrolment patch (#647) on top: ${wrapped.length} ".write" rules carry its condition.`);

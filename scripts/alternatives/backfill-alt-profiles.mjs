// ── BACKFILL THROUGH THE TRIGGER'S OWN PATH — every sneaker missing attributes or a profile
//
// Owner rule: automated or not at all. This script runs, for each sneaker that
// needs it, EXACTLY the function the alternativesProfile trigger runs —
// refreshAltProfile from functions/lib/alt-enrich.mjs: the same vision
// decision, claim, daily cap, failure record and profile write. Nothing here
// enriches or ranks by its own rules.
//
// Why not stamp a field and let the trigger fire (the first version)? That is
// TWO /products writes per product — the stamp and the profile — and every
// /products write is a mirror change every device downloads; it also left the
// stamp on the hot node for good (Fable spec review). Calling the core is one
// write per product and nothing left behind.
//
//   node scripts/alternatives/backfill-alt-profiles.mjs            DRY RUN — counts only
//   node scripts/alternatives/backfill-alt-profiles.mjs --apply    run them, 4 at a time
//   ... --all   every in-scope sneaker (after a change to the family rules: a
//               stored family is frozen until something re-runs it)
//
// The Gemini key: GEMINI_API_KEY from the environment, else the GEMINI_API_KEY
// secret read from Secret Manager with the same credential (never printed).
// Reads /products and /product_attributes once, paged — an admin one-off,
// never a per-tap read.
import { createRequire } from "module";
import { readMapPaged } from "../lib/rtdbPaged.mjs";
import { ATTRIBUTES_PATH, isCurrentExtraction } from "../../src/utils/productAttributes.js";
import { ALT_PROFILE_FIELD, decodeAltProfile } from "../../src/utils/altProfile.js";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";
import { refreshAltProfile, makeVisionCall, inAlternativesScope } from "../../functions/lib/alt-enrich.mjs";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

const products = await readMapPaged(db, "products", { pageSize: 500 });
const attrs = await readMapPaged(db, ATTRIBUTES_PATH, { pageSize: 500 });

const todo = [];
let scope = 0, noAttrs = 0, noProfile = 0;
for (const [pid, p] of Object.entries(products)) {
  if (!inAlternativesScope(p)) continue;
  scope += 1;
  const missingAttrs = !!String(p.photoUrl || "").trim() && !isCurrentExtraction(attrs[pid]);
  const missingProfile = !decodeAltProfile(p[ALT_PROFILE_FIELD]);
  if (missingAttrs) noAttrs += 1;
  if (missingProfile) noProfile += 1;
  if (ALL || missingAttrs || missingProfile) todo.push(pid);
}
console.log(`footwear in scope: ${scope} · missing attributes (vision will run): ${noAttrs} · missing profile: ${noProfile}`);
console.log(`to run: ${todo.length}`);
if (!APPLY) { console.log("DRY RUN — nothing written. Re-run with --apply."); process.exit(0); }

async function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const { access_token: token } = await admin.app().options.credential.getAccessToken();
  const res = await fetch("https://secretmanager.googleapis.com/v1/projects/marathon-club/secrets/GEMINI_API_KEY/versions/latest:access",
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`could not read the GEMINI_API_KEY secret: HTTP ${res.status}`);
  return Buffer.from((await res.json()).payload.data, "base64").toString("utf8").trim();
}
const key = noAttrs ? await geminiKey() : "";
const deps = {
  db, now: () => Date.now(), serverTimestamp: admin.database.ServerValue.TIMESTAMP,
  vision: key ? makeVisionCall({ apiKey: key }) : null, log: (m) => console.warn(m),
};

const tally = {};
const CONCURRENCY = 4;
let next = 0, done = 0;
async function worker() {
  while (next < todo.length) {
    const pid = todo[next++];
    assertSafeSegment(pid, "productId");
    try {
      const r = await refreshAltProfile(deps, pid);
      const k = `${r.status}/${r.vision}`;
      tally[k] = (tally[k] || 0) + 1;
    } catch (e) {
      tally.error = (tally.error || 0) + 1;
      console.warn(`${pid}: ${String(e?.message || e)}`);
    }
    if (++done % 50 === 0 || done === todo.length) console.log(`  … ${done}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log("outcomes (status/vision):", JSON.stringify(tally));
process.exit(0);

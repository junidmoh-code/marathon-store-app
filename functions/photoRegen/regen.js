// ─── THE CLOTHING-PHOTO REGENERATION QUEUE (Junid, 22 Nov 2026) ──────────────
// photoRegenRun   One request = one product's photo made again, IN THE CLOUD,
//                 by the very function its card calls:
//                   card "bf" → blackFriday/generate.js  _internals.bfGenerate
//                   card "na" → newArrivals/studio.js    _internals.studioGenerate
//                 always with `hold: true` — the photo the card shows stays in
//                 place unless the new one PASSED the garment gate.
//
// Why a queue and not a script: a 4K photo is ~25 MB each way; from the shop's
// line one took 500 s (in the cloud ~35 s) and the gate's retry ran out of time.
// scripts/photos/regenClothing.mjs writes the requests and reads the results.
//
// /photo_regen is SERVER-ONLY: it has no rule in database.rules.json, so no
// client can read or write it. Only the Admin SDK (the script) queues a request.
//   /photo_regen/requests/{id} = { pid, card: "bf" | "na", at, by }
//   /photo_regen/results/{id}  = { pid, card, started } while it runs, then { pid, card, ok, genId, before, after, passed, flagged, held, drift, costZar, secs, error? }
// Nothing here generates on its own: no schedule, no retry. The New Arrivals
// generation pause switch stops it like any other Generate.
// Deploy BY NAME: firebase deploy --only functions:photoRegenRun --project=marathon-club
"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const ROOT = "photo_regen";
const PID_RE = /^p\d{6,20}$/;
const CARDS = Object.freeze(["bf", "na"]);
const val = async (db, path) => (await db.ref(path).once("value")).val();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The photo a card shows now, before the run. */
async function shownNow(db, card, pid) {
  if (card === "na") return (await val(db, `new_arrivals/items/${pid}/generatedUrl`)) || null;
  const p = (await val(db, `bf_campaign_2026/photos/${pid}`)) || {};
  return p.use === "generated" && p.gens && p.gens[p.genId] ? p.gens[p.genId].url || null : null;
}

/**
 * One request. deps (injectable for tests): { bucket, apiKey, now?, bfGenerate?, studioGenerate?, naRow? }
 * → the result row (also written to /photo_regen/results/{id}).
 */
async function run(db, id, reqData, deps) {
  const now = deps.now || (() => Date.now());
  const t0 = now();
  const d = reqData || {};
  const pid = String(d.pid || ""), card = String(d.card || "");
  const row = { pid, card, at: t0, by: d.by || null };
  // ONE RUN PER REQUEST: a database event can be delivered twice; the second delivery finds the claim and stops
  // (a paid photo is never made twice). The claim row also says "started" if the run is cut off at the time limit.
  const claim = await db.ref(`${ROOT}/results/${id}`).transaction((cur) => (cur ? undefined : { pid, card, started: t0 })).catch(() => null);
  if (!claim || !claim.committed) return { pid, card, skipped: "already run" };
  try {
    if (!PID_RE.test(pid) || !CARDS.includes(card)) throw new Error("not a regeneration request (pid, card bf|na)");
    row.before = await shownNow(db, card, pid);
    const uid = `photo-regen:${String(d.by || "script").slice(0, 60)}`;
    const base = { bucket: deps.bucket, apiKey: deps.apiKey, kit: true };
    if (card === "bf") {
      const bfGenerate = deps.bfGenerate || require("../blackFriday/generate.js")._internals.bfGenerate;
      const naRow = deps.naRow || ((p) => require("../blackFriday/na.cjs").campaignRowOfNa(db, p, Date.now(), require("../newArrivals/newArrivals.js")));
      const r = await bfGenerate(db, { pid, hold: true }, uid, { ...base, naRow });
      Object.assign(row, { ok: true, genId: r.genId, after: r.url || null, passed: !!r.passed, flagged: !!r.flagged, held: !!r.held, keptApproved: !!r.keptApproved,
        drift: r.drift || null, costZar: r2((Number(r.costZar) || 0) + (Number(r.wastedZar) || 0)) });
    } else {
      const studioGenerate = deps.studioGenerate || require("../newArrivals/studio.js")._internals.studioGenerate;
      const r = await studioGenerate(db, { pid, hold: true }, uid, { ...base, openaiKey: null });
      const g = (await val(db, `new_arrivals/items/${pid}/generations/${r.genId}`)) || {};
      Object.assign(row, { ok: true, genId: r.genId, after: g.url || null, passed: !!r.passed, flagged: !!r.flagged, held: !!r.held,
        drift: r.drift || null, costZar: r2(r.costZar) });
    }
  } catch (e) {
    Object.assign(row, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
  row.secs = Math.round((now() - t0) / 1000);
  for (const [k, v] of Object.entries(row)) if (v === null || v === undefined) delete row[k];
  await db.ref(`${ROOT}/results/${id}`).set(row).catch((e) => console.error(`photoRegenRun: ${id} result not saved — ${e.message}`));
  return row;
}

const photoRegenRun = onValueCreated(
  // One product per instance at a time: a 4K photo, its steam pass and the matte model share 2 GiB.
  { ref: `/${ROOT}/requests/{id}`, instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 1, maxInstances: 3, retry: false, secrets: [geminiApiKey] },
  async (event) => {
    const e = require("../newArrivals/studio.js").engine;
    const row = await run(admin.database(), event.params.id, event.data.val(), { bucket: admin.storage().bucket(e.BUCKET), apiKey: geminiApiKey.value() });
    if (row.skipped) return console.log(`photoRegenRun: ${event.params.id} — ${row.skipped}`);
    console.log(`photoRegenRun: ${event.params.id} ${row.card} ${row.pid} — ${row.ok ? (row.passed ? "passed" : row.flagged ? "flagged" : "held") : `failed (${row.error})`}`);
  },
);

module.exports = { photoRegenRun, _internals: { run, shownNow, ROOT, PID_RE, CARDS } };

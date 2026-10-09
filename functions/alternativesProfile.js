// ─── ALTERNATIVES: automatic enrichment and indexing ─────────────────────────
// Three functions over one core (lib/alt-enrich.mjs, node-tested):
//
//   alternativesProfile                 /products/{pid} written → enrich if
//                                       needed, then write the altProfile.
//   alternativesProfileFromAttributes   /product_attributes/{pid} written (a
//                                       human correction, a script run) →
//                                       re-derive the profile. Never calls
//                                       vision, so it cannot loop.
//   alternativesEnrichSweep             daily 03:30 SAST: retry the products
//                                       whose vision read failed (credits out,
//                                       Gemini 503) — reads only the small
//                                       /alt_enrich/failures node.
//
// retry: false on the triggers. A missed refresh is repaired by the next edit
// of that product and by the sweep; a retry storm on /products is not.
//
// Deploy BY NAME (shared project):
//   firebase deploy --only functions:alternativesProfile,functions:alternativesProfileFromAttributes,functions:alternativesEnrichSweep
const admin = require("firebase-admin");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const BASE = { instance: "marathon-club-default-rtdb", region: "europe-west1", memory: "256MiB", retry: false };

let coreP = null;
const core = () => (coreP ||= import("./lib/alt-enrich.mjs").catch((e) => { coreP = null; throw e; }));

function deps(c, withVision) {
  const key = withVision ? String(geminiApiKey.value() || "").trim() : "";
  return {
    db: admin.database(),
    now: () => Date.now(),
    serverTimestamp: admin.database.ServerValue.TIMESTAMP,
    vision: key ? c.makeVisionCall({ apiKey: key }) : null,
    log: (m) => console.warn(m),
  };
}

exports.alternativesProfile = onValueWritten(
  { ...BASE, ref: "/products/{pid}", timeoutSeconds: 180, secrets: [geminiApiKey] },
  async (event) => {
    try {
      const c = await core();
      const before = event.data.before.val();
      const after = event.data.after.val();
      // Own write, a neighbour list, a flag: nothing the profile reads changed.
      if (!c.profileInputsChanged(before, after) && after?.altProfile) return;
      if (!c.inAlternativesScope(after)) return;
      const r = await c.refreshAltProfile(deps(c, true), event.params.pid);
      if (r.vision !== "not-needed") console.log(`alternativesProfile ${event.params.pid}: ${r.status}, vision ${r.vision}`);
    } catch (e) {
      console.error(`alternativesProfile ${event.params.pid}: ${String(e?.message || e)}`);
    }
  }
);

exports.alternativesProfileFromAttributes = onValueWritten(
  { ...BASE, ref: "/product_attributes/{pid}", timeoutSeconds: 60 },
  async (event) => {
    try {
      const c = await core();
      const b = event.data.before.val() || {}, a = event.data.after.val() || {};
      if (JSON.stringify([b.a, b.confirmed]) === JSON.stringify([a.a, a.confirmed])) return;
      await c.refreshAltProfile(deps(c, false), event.params.pid, { allowVision: false });
    } catch (e) {
      console.error(`alternativesProfileFromAttributes ${event.params.pid}: ${String(e?.message || e)}`);
    }
  }
);

exports.alternativesEnrichSweep = onSchedule(
  { schedule: "30 3 * * *", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "256MiB",
    timeoutSeconds: 540, secrets: [geminiApiKey] },
  async () => {
    const c = await core();
    const db = admin.database();
    const started = Date.now();
    // The failures node is bounded by the catalogue and small; read it whole
    // and take the OLDEST retryable entries, so a permanently bad photo (n at
    // the cap) can never hold the head of the queue.
    const failures = (await db.ref(`${c.ENRICH_ROOT}/failures`).get()).val() || {};
    const queue = Object.entries(failures)
      .filter(([, f]) => (Number(f?.n) || 1) < c.MAX_ATTEMPTS)
      .sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0))
      .slice(0, 60).map(([pid]) => pid);
    const d = deps(c, true);
    let done = 0;
    for (const pid of queue) {
      // Leave room inside the 540 s limit: a vision read can take ~2 minutes.
      if (Date.now() - started > 360 * 1000) break;
      try {
        const r = await c.refreshAltProfile(d, pid);
        if (r.status === "gone" || r.status === "out-of-scope") await db.ref(`${c.ENRICH_ROOT}/failures/${pid}`).remove();
        done += 1;
      } catch (e) {
        console.error(`alternativesEnrichSweep ${pid}: ${String(e?.message || e)}`);
      }
    }
    // Housekeeping: claims older than a day, budget days older than a week.
    const claims = (await db.ref(`${c.ENRICH_ROOT}/claims`).get()).val() || {};
    const prune = {};
    for (const [pid, cl] of Object.entries(claims)) if (Number(cl?.at) < started - 86400000) prune[`claims/${pid}`] = null;
    const weekAgo = c.sastDay(started - 7 * 86400000);
    const budget = (await db.ref(`${c.ENRICH_ROOT}/budget`).get()).val() || {};
    for (const day of Object.keys(budget)) if (day < weekAgo) prune[`budget/${day}`] = null;
    if (Object.keys(prune).length) await db.ref(c.ENRICH_ROOT).update(prune);
    console.log(`alternativesEnrichSweep: retried ${done} of ${queue.length} (${Object.keys(failures).length} recorded)`);
  }
);

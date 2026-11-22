#!/usr/bin/env node
// ─── REGENERATE THE CLOTHING PHOTOS THROUGH THE GARMENT GATE (Junid, 22 Nov 2026) ─
// Junid: the clothing photos on the New Arrivals card and the Black Friday tab
// look creased and squashed. This run makes each one again with the fixed shared
// generator (studio.generate: garment finish → quality gate → steam-and-press
// pass) by calling the SAME two functions the cards call —
//   Black Friday  functions/blackFriday/generate.js   _internals.bfGenerate
//   New Arrivals  functions/newArrivals/studio.js     _internals.studioGenerate
// — with `hold: true`: THE PHOTO A CARD SHOWS STAYS IN PLACE UNTIL THE NEW ONE
// PASSES THE GATE. A flagged or unchecked photo is only added beside it.
//
// WHAT IT TOUCHES
//   Black Friday: every product whose card shows an AI photo of kind clothing.
//     An APPROVED product keeps posting its approved photo (the new one waits
//     beside it until Junid picks it) — bfGenerate's own rule, unchanged.
//   New Arrivals: clothing items on the New tab (new / ready / rejected) that
//     already have an AI photo. Items Junid has APPROVED (approved / chaining /
//     done) are NOT touched: Approve is final, and their photo is already on
//     Shopify. They are listed by --plan so he can decide.
// Shoes are never touched.
//
//   node scripts/photos/regenClothing.mjs --plan
//   node scripts/photos/regenClothing.mjs --only p123,p456 --out run.jsonl
//   node scripts/photos/regenClothing.mjs --all --out run.jsonl [--concurrency 3] [--limit 20] [--cards bf,na]
// The photos are made IN THE CLOUD: this script only queues one request per product at
// /photo_regen/requests (server-only) for photoRegenRun (functions/photoRegen/regen.js) and waits for its result.
// Resumable: a product whose newest photo was already made by this gate (its
// record carries a crease score) is skipped unless --force.
// Credentials: Application Default Credentials. The generation pause switch stops it like any Generate.
import fs from "node:fs";
import { adminRequire } from "../adminRequire.mjs";

// (adminRequire resolves ../functions from the URL it is given: hand it scripts/, not scripts/photos/.)
const req = adminRequire(new URL("../x.mjs", import.meta.url).href);
const admin = req("firebase-admin");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const UID = "regen-clothing-2026-11-22";

/** Was this generation made by the 22 Nov gate (a garment check that carries a crease score, or a flag)? Pure. */
export const gated = (g) => !!g && ((g.drift && g.drift.check === "garment" && Number.isFinite(g.drift.crease)) || g.flagged === true);

/** The Black Friday products to regenerate: the card shows an AI clothing photo. Pure. → [{ pid, approved, gated }] */
export function bfTargets(photos, picks) {
  const out = [];
  for (const [pid, p] of Object.entries(photos || {})) {
    const g = p && p.use === "generated" && p.gens && p.gens[p.genId];
    if (!g || g.kind !== "clothing" || g.src) continue; // g.src: his own photo (upload / web), not an AI generation
    const ids = Object.keys(p.gens).filter((id) => p.gens[id] && p.gens[id].url && !p.gens[id].src).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const pick = (picks || {})[pid];
    out.push({ pid, card: "bf", approved: !!pick && pick.state === "approved", gated: gated(p.gens[ids[ids.length - 1]]), before: g.url });
  }
  return out;
}

/** The New Arrivals items: clothing with an AI photo. `lane` says whether this run may touch it. Pure. */
export function naTargets(items, isGarment, selectLanes) {
  const out = [];
  for (const [pid, i] of Object.entries(items || {})) {
    if (!i || !i.currentGen || !isGarment({ categoryKey: i.categoryKey })) continue;
    const gens = i.generations || {};
    const ids = Object.keys(gens).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    out.push({ pid, card: "na", name: i.name || pid, status: i.status, open: selectLanes.includes(i.status), gated: gated(gens[ids[ids.length - 1]]), before: i.generatedUrl || null });
  }
  return out;
}

async function main() {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app", storageBucket: "marathon-club.firebasestorage.app" });
  const db = admin.database();
  const val = async (p) => (await db.ref(p).once("value")).val();
  const naCore = req("./newArrivals/core.cjs");
  const cat = await import(new URL("../../functions/lib/style-kit-catalogue.mjs", import.meta.url));

  const [photos, picks, items] = await Promise.all([val("bf_campaign_2026/photos"), val("bf_campaign_2026/picks"), val("new_arrivals/items")]);
  const B = bfTargets(photos, picks), N = naTargets(items, cat.isGarment, naCore.SELECT_LANES);
  const only = opt("only") ? new Set(opt("only").split(",").map((s) => s.trim())) : null;
  const cards = opt("cards", "bf,na").split(",");
  let todo = [...(cards.includes("bf") ? B : []), ...(cards.includes("na") ? N.filter((t) => t.open) : [])];
  if (only) todo = todo.filter((t) => only.has(t.pid));
  if (!flag("force")) todo = todo.filter((t) => !t.gated);
  if (opt("limit")) todo = todo.slice(0, Number(opt("limit")));

  console.log(`Black Friday clothing photos: ${B.length} (${B.filter((t) => t.approved).length} approved — the new photo waits beside the approved one)`);
  console.log(`New Arrivals clothing photos: ${N.length} — on the New tab ${N.filter((t) => t.open).length}; approved, NOT touched ${N.filter((t) => !t.open).length}`);
  console.log(`Already made by the gate: ${[...B, ...N].filter((t) => t.gated).length}.  To do now: ${todo.length}`);
  if (flag("plan") || (!flag("all") && !only)) { for (const t of todo) console.log(`  ${t.card} ${t.pid} ${t.approved ? "approved " : ""}${t.status || ""} ${t.name || ""}`); return; }

  // QUEUED, NOT RUN HERE: each product becomes one /photo_regen/requests row and the cloud function
  // photoRegenRun (functions/photoRegen/regen.js) makes the photo — a 4K photo is too heavy for the shop's line.
  const out = opt("out", `regen-clothing-${Date.now()}.jsonl`);
  const run = opt("run", `r${Date.now()}`);
  const WAIT_MS = 11 * 60_000; // the function's own limit is 540 s
  const one = async (t) => {
    const id = `${run}_${t.card}_${t.pid}`;
    const t0 = Date.now();
    await db.ref(`photo_regen/requests/${id}`).set({ pid: t.pid, card: t.card, at: t0, by: UID });
    let row = null;
    while (!row && Date.now() - t0 < WAIT_MS) { await new Promise((r) => setTimeout(r, 6000)); const r = await val(`photo_regen/results/${id}`).catch(() => null); if (r && typeof r.ok === "boolean") row = r; }
    row = row || { pid: t.pid, card: t.card, ok: false, error: "no answer from photoRegenRun within 11 minutes (it may have been cut off at its time limit — check the card)" };
    row = { ...row, name: t.name || null, approved: !!t.approved };
    fs.appendFileSync(out, JSON.stringify(row) + "\n");
    console.log(`${row.ok ? (row.passed ? "PASS " : row.flagged ? "FLAG " : "HELD ") : "FAIL "} ${t.card} ${t.pid} ${row.secs ?? "?"}s R${row.costZar ?? 0} ${row.ok ? JSON.stringify(row.drift) : row.error}`);
  };
  const n = Math.max(1, Math.min(3, Number(opt("concurrency", 3))));
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < todo.length) await one(todo[i++]); }));
  console.log(`Done — ledger: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
// ─── Meta-ready test: before/after for N live products (nothing written) ─────
//
//   node scripts/photos/meta-ready-sample.mjs --out <dir> [--n 20] [--pids a,b]
//
// Picks N products that are live on the website, spread across categories
// (round-robin by categoryKey), runs the SAME maker the trigger runs
// (functions/lib/meta-ready.cjs) on each primary photo, and writes
// <pid>-before.jpg / <pid>-after.jpg + index.json to <dir> for a person to
// look at. READ-ONLY against RTDB and Storage: no upload, no pointer.
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const sharp = require("sharp");
const { makeMetaReady } = require("./lib/meta-ready.cjs")   // relative to functions/package.json;

admin.initializeApp({ credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app", storageBucket: "marathon-club.firebasestorage.app" });
const db = admin.database();
const bucket = admin.storage().bucket();
const flags = process.argv.slice(2);
const arg = (k) => (flags.includes(k) ? flags[flags.indexOf(k) + 1] : null);
const OUT = arg("--out");
const N = Number(arg("--n") || 20);
if (!OUT) { console.error("--out <dir> is required"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const objectPath = (url) => { try { const m = /\/o\/([^?]+)/.exec(new URL(url).pathname); return m ? decodeURIComponent(m[1]) : null; } catch { return null; } };
async function download(url) {
  const p = objectPath(url);
  if (p && url.includes("/b/marathon-club.firebasestorage.app/o/")) return (await bucket.file(p).download())[0];
  const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer());
}

let pids = arg("--pids") ? arg("--pids").split(",") : null;
if (!pids) {
  // The website's live set, by its indexed `state` (the reconciler's own query).
  const live = (await db.ref("shopify_publish").orderByChild("state").equalTo("live").get()).val() || {};
  const on = Object.entries(live).filter(([, n]) => n?.liveState === "on").map(([p]) => p).sort();
  const byCat = new Map();
  for (const pid of on) {
    const cat = (await db.ref(`products/${pid}/categoryKey`).get()).val() || "other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(pid);
    if ([...byCat.values()].reduce((a, l) => a + l.length, 0) > 600) break;
  }
  const lists = [...byCat.values()];
  pids = [];
  for (let i = 0; pids.length < N && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && pids.length < N) pids.push(l[i]);
}

const rows = [];
for (const pid of pids) {
  const [photoUrl, name, categoryKey] = await Promise.all(["photoUrl", "name", "categoryKey"].map((k) => db.ref(`products/${pid}/${k}`).get().then((s) => s.val())));
  if (!photoUrl) { rows.push({ pid, name, skipped: "no photo" }); continue; }
  try {
    const src = await download(photoUrl);
    const t0 = Date.now();
    const { buffer, info } = await makeMetaReady(sharp, src);
    const ms = Date.now() - t0;
    const meta = await sharp(src).metadata();
    writeFileSync(join(OUT, `${pid}-before.jpg`), await sharp(src).rotate().resize(480, 480, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer());
    writeFileSync(join(OUT, `${pid}-after.jpg`), await sharp(buffer).resize(480, 480).jpeg({ quality: 82 }).toBuffer());
    rows.push({ pid, name, categoryKey, before: { width: meta.width, height: meta.height }, after: info, ms });
    console.log(`${pid}  ${String(name).slice(0, 40).padEnd(40)} ${meta.width}×${meta.height} → 1080² · ${info.fill} · frame ${JSON.stringify(info.frameCut)} · ${ms} ms`);
  } catch (e) {
    rows.push({ pid, name, error: String(e?.message || e) });
    console.log(`${pid}  FAILED ${e?.message || e}`);
  }
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(rows, null, 1));
console.log(`\n${rows.filter((r) => r.after).length}/${rows.length} made → ${OUT}`);
process.exit(0);

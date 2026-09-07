// ─── CENSUS — where the display marker's two sources actually stand ──────────
// READ ONLY. Zero writes, ever. This script computes EVERY figure quoted in
// docs/display-marker-findings.md, and writes its own output next to it as
// docs/display-marker-census.txt, so the doc's numbers are reproducible rather
// than asserted.
//
//   node scripts/census-display-marker-sources.mjs [outfile]
//
// NO WHOLE-NODE READS beyond the three nodes that ARE the subject (all small,
// sizes reported below). In particular /products is NEVER pulled: product
// names are read one child at a time — `products/{pid}/name` — for the ~25
// products the report actually names. Pulling several megabytes to label
// twenty-odd rows is exactly the read this codebase refuses.
import { createRequire } from "module";
import { writeFileSync } from "fs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const out = [];
const say = (...a) => { const l = a.join(" "); out.push(l); console.log(l); };

const AUG6 = "2026-08-06T00:00:00.000Z";
const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const [legacy, slots, register] = await Promise.all([
  db.ref("settings/displayRegister").once("value").then((s) => s.val()),
  db.ref("settings/displaySlots").once("value").then((s) => s.val() || {}),
  db.ref("settings/hubSneakerCount/register/hub1").once("value").then((s) => s.val() || {}),
]);

// One product name, by child path. Never the node.
const nameCache = new Map();
const nameOf = async (pid) => {
  if (nameCache.has(pid)) return nameCache.get(pid);
  const n = (await db.ref(`products/${pid}/name`).once("value")).val() || "(name not on file)";
  nameCache.set(pid, n);
  return n;
};

say("# Display-marker census —", new Date().toISOString());
say("Read-only. Node sizes as fetched:");
say(`  /settings/displayRegister                    ${kb(bytes(legacy))}`);
say(`  /settings/displaySlots                       ${kb(bytes(slots))}`);
say(`  /settings/hubSneakerCount/register/hub1      ${kb(bytes(register))}`);

// ── 1. THE LEGACY NODE PR #324 ORPHANED ──────────────────────────────────────
say("");
say("## /settings/displayRegister — the node PR #324 orphaned");
if (!legacy) {
  say("absent — nothing to delete");
} else {
  let total = 0, newest = null;
  const perStore = [];
  for (const [store, byKey] of Object.entries(legacy)) {
    const n = Object.keys(byKey || {}).length;
    total += n;
    perStore.push(`${store} ${n}`);
    for (const r of Object.values(byKey || {})) {
      const t = r?.registeredAt || r?.at || null;
      if (typeof t === "string" && (!newest || t > newest)) newest = t;
    }
  }
  say("entries:", total, "—", perStore.join(", "));
  say("newest entry:", newest);
  const sample = Object.entries(Object.values(legacy)[0] || {})[0];
  say("shape:", JSON.stringify(sample));
}

// ── 2. THE REGISTER ──────────────────────────────────────────────────────────
const regRows = Object.entries(register);
const tsFields = new Set();
const tsOf = (r) => {
  const c = [];
  for (const [k, v] of Object.entries(r || {})) {
    if (!/at$|^ts$/i.test(k)) continue;
    tsFields.add(k);
    if (typeof v === "string" && v) c.push(v);
  }
  return c.length ? c.sort().at(-1) : null;
};
let regNewest = null, regNewestRow = null, regAfterAug6 = 0;
const regByPid = new Map();
for (const [k, r] of regRows) {
  const t = tsOf(r);
  if (t) {
    if (!regNewest || t > regNewest) { regNewest = t; regNewestRow = [k, r]; }
    if (t > AUG6) regAfterAug6++;
  }
  const i = k.lastIndexOf("__");
  if (i <= 0) continue;
  const pid = k.slice(0, i), sizeKey = k.slice(i + 2);
  if (!sizeKey || sizeKey === "_") continue;
  if ((Number(r?.qty) || 0) <= 0) continue;
  if (!regByPid.has(pid)) regByPid.set(pid, []);
  regByPid.get(pid).push({ key: k, sizeKey, row: r, at: t });
}
say("");
say("## /settings/hubSneakerCount/register/hub1 — the write-only-upward history");
say("rows:", regRows.length, "— with qty > 0:", [...regByPid.values()].reduce((a, v) => a + v.length, 0));
say("timestamp fields present:", [...tsFields].join(", ") || "(none)");
say("NEWEST timestamp:", regNewest, regNewest && regNewest > AUG6 ? "— AFTER 2026-08-06: still being written" : "");
say("newest row:", JSON.stringify(regNewestRow));
say("rows timestamped after 2026-08-06:", regAfterAug6, "of", regRows.length);
say("products with 2+ register rows (qty > 0):", [...regByPid.values()].filter((v) => v.length > 1).length, "of", regByPid.size);

// ── 3. THE SLOTS ─────────────────────────────────────────────────────────────
const liveByStorePid = [];
const slotByPid = new Map();
const byHub = {};
let tombstoned = 0, slotNewest = null;
const slotSources = {};
for (const [store, byPid] of Object.entries(slots)) {
  for (const [pid, s] of Object.entries(byPid || {})) {
    const live = !!s && typeof s.sizeKey === "string" && s.sizeKey && s.sizeKey !== "_";
    slotSources[`${s?.source}/${live ? "live" : "cleared"}`] = (slotSources[`${s?.source}/${live ? "live" : "cleared"}`] || 0) + 1;
    if (typeof s?.at === "string" && (!slotNewest || s.at > slotNewest)) slotNewest = s.at;
    if (!live) { tombstoned++; continue; }
    byHub[s.bookedHub] = (byHub[s.bookedHub] || 0) + 1;
    liveByStorePid.push({ store, pid, s });
    if (s.bookedHub !== "hub1") continue;
    if (!slotByPid.has(pid)) slotByPid.set(pid, []);
    slotByPid.get(pid).push({ store, ...s });
  }
}
say("");
say("## /settings/displaySlots — one record per product per store");
say("live slots:", liveByStorePid.length, "— by bookedHub:", JSON.stringify(byHub));
say("tombstoned (sold / cleared) slots:", tombstoned);
say("newest slot .at:", slotNewest);
say("sources:", JSON.stringify(slotSources));

// ── 4. THE REGISTER AGAINST THE SLOTS ────────────────────────────────────────
let noSlot = 0, sameSize = 0, ghost = 0;
const ghostRows = [];
for (const [pid, rows] of regByPid) {
  const live = new Set((slotByPid.get(pid) || []).map((x) => x.sizeKey));
  for (const r of rows) {
    if (!live.size) noSlot++;
    else if (live.has(r.sizeKey)) sameSize++;
    else { ghost++; ghostRows.push({ pid, r, live: [...live] }); }
  }
}
say("");
say("## the register row against the live slot for the same product");
say("register rows whose product has NO live hub1 slot :", noSlot);
say("register rows whose live slot is the SAME size    :", sameSize, "(redundant)");
say("register rows whose live slot is a DIFFERENT size :", ghost, "(GHOST — the duplicate marker)");

// ── 5. THE MARKER, BEFORE AND AFTER ──────────────────────────────────────────
const cellsBoth = new Map();
for (const [pid, arr] of slotByPid) for (const s of arr) {
  const k = `${pid}::${s.sizeKey}`;
  const c = cellsBoth.get(k) || { units: 0, stores: 0 };
  c.units++; c.stores++; cellsBoth.set(k, c);
}
for (const [pid, rows] of regByPid) for (const r of rows) {
  const k = `${pid}::${r.sizeKey}`;
  const c = cellsBoth.get(k) || { units: 0, stores: 0 };
  c.units += Math.max(0, (Number(r.row.qty) || 0) - c.stores);
  cellsBoth.set(k, c);
}
const markersBoth = new Map();
for (const [k, c] of cellsBoth) {
  if (c.units <= 0) continue;
  const pid = k.slice(0, k.lastIndexOf("::"));
  markersBoth.set(pid, (markersBoth.get(pid) || 0) + 1);
}
const cellsSlots = new Map();
const markersSlots = new Map();
for (const [pid, arr] of slotByPid) {
  const sizes = new Set(arr.map((s) => s.sizeKey));
  for (const sk of sizes) cellsSlots.set(`${pid}::${sk}`, 1);
  markersSlots.set(pid, sizes.size);
}
const multiBoth = [...markersBoth.entries()].filter(([, n]) => n > 1);
say("");
say("## THE MARKER");
say("BOTH SOURCES (what the grid drew): marked cells", cellsBoth.size, "— products with 2+ markers", multiBoth.length, "of", markersBoth.size);
say("SLOTS ONLY   (what it draws now) : marked cells", cellsSlots.size, "— products with 2+ markers",
  [...markersSlots.values()].filter((n) => n > 1).length, "of", markersSlots.size);

// ── 6. THE PAYLOADS — the reported product, then twenty more ─────────────────
const dump = async (pid, why) => {
  say("");
  say(`--- ${pid} — ${await nameOf(pid)}  [${why}; markers under both sources: ${markersBoth.get(pid) || 0}]`);
  for (const s of (slotByPid.get(pid) || [])) say("    SLOT", JSON.stringify(s));
  for (const r of (regByPid.get(pid) || [])) say("    REG ", r.key, JSON.stringify(r.row));
};

say("");
say("## PAYLOADS");
// The product on the owner's screenshot, found by name among the ghosts only —
// no catalogue scan.
const named = [];
for (const { pid } of ghostRows) {
  const n = await nameOf(pid);
  if (/diesel/i.test(n) && /big d/i.test(n)) named.push(pid);
}
for (const pid of named) await dump(pid, "the reported product");
let n = 0;
for (const [pid] of multiBoth) {
  if (named.includes(pid)) continue;
  if (n++ >= 20) break;
  await dump(pid, "carries 2+ markers");
}
say("");
say(`(${named.length} reported + ${n} further products dumped in full)`);

const file = process.argv[2] || new URL("../docs/display-marker-census.txt", import.meta.url).pathname;
writeFileSync(file, out.join("\n") + "\n");
console.log("\nwritten to", file);
process.exit(0);

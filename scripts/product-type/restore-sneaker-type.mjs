// ─── PUT A SNEAKER SWITCHED TO CLOTHING BACK ─────────────────────────────────
//
//   ACCESS_TOKEN=… node scripts/product-type/restore-sneaker-type.mjs <pid> [<pid>…] [--seat-hub2] [--apply]
//
// Dry run by default: prints the plan (sneakerRestoreCore.planSneakerRestore)
// and writes nothing. --apply writes, per product, ONE multi-path update: the
// product patch, any Hub 2 seats (qty-0 seed cells — no stock moves), and an
// audit entry under products/{pid}/typeLog. Re-reads and prints the result.
//
// Reads are per path and bounded: the product, its cell at each location, and
// the insights rollup one day at a time (cached under --cache <dir>). Uses curl
// because node on Junid's Mac cannot reach Google (reference note); an owner
// OAuth token in ACCESS_TOKEN.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planSneakerRestore, typeLogEntry } from "./sneakerRestoreCore.mjs";
import { expandDay } from "../../src/insights/rollupCodec.js";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SEAT = argv.includes("--seat-hub2");
const cacheIdx = argv.indexOf("--cache");
const CACHE = cacheIdx >= 0 ? argv[cacheIdx + 1] : null;
const reasonIdx = argv.indexOf("--reason");
const REASON = reasonIdx >= 0 ? argv[reasonIdx + 1] : "switched to Clothing by mistake — restored from stock and order history";
const pids = argv.filter((a, i) => /^p\d+$/.test(a) && argv[i - 1] !== "--cache");
const TOKEN = process.env.ACCESS_TOKEN;
if (!TOKEN) { console.error("ACCESS_TOKEN is required"); process.exit(2); }
if (!pids.length) { console.error("usage: restore-sneaker-type.mjs <pid>… [--seat-hub2] [--apply] [--cache dir]"); process.exit(2); }

export function rest(path, { method = "GET", body, qs = "" } = {}) {
  const args = ["-s", "-X", method, `${DB}/${path}.json${qs ? `?${qs}` : ""}`, "-H", `Authorization: Bearer ${TOKEN}`];
  if (body !== undefined) args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  const out = execFileSync("curl", args, { maxBuffer: 256e6 }).toString();
  const j = JSON.parse(out || "null");
  if (j && typeof j === "object" && j.error) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
}

export function orderHistory(pidSet, cacheDir) {
  const days = Object.keys(rest("insights_rollup/days", { qs: "shallow=true" }) || {}).sort();
  const out = {};
  for (const d of days) {
    const f = cacheDir ? join(cacheDir, `${d}.json`) : null;
    let day;
    if (f && existsSync(f)) day = JSON.parse(readFileSync(f, "utf8"));
    else { day = rest(`insights_rollup/days/${d}`); if (f) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(f, JSON.stringify(day)); } }
    for (const r of Object.values(expandDay(day))) {
      if (!pidSet.has(r.productId)) continue;
      const h = (out[r.productId] ||= { sizes: {}, hubs: {}, types: {}, firstMs: null, lastMs: null });
      if (r.size != null) h.sizes[r.size] = (h.sizes[r.size] || 0) + 1;
      if (r.placedAtHub) h.hubs[r.placedAtHub] = (h.hubs[r.placedAtHub] || 0) + 1;
      if (r.productType) {
        const t = (h.types[r.productType] ||= { n: 0, firstDay: d, lastDay: d });
        t.n += 1; t.lastDay = d;
      }
    }
  }
  return out;
}

export function cellsOf(pid, locs) {
  const out = {};
  for (const l of locs) {
    const v = rest(`stock/${l}/${pid}`);
    if (v && typeof v === "object") out[l] = Array.isArray(v) ? Object.fromEntries(v.map((c, i) => [String(i), c]).filter(([, c]) => c)) : v;
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const locs = [...Object.keys(rest("locations", { qs: "shallow=true" }) || {}), "in_transit"].filter((v, i, a) => a.indexOf(v) === i);
  const history = orderHistory(new Set(pids), CACHE);
  const nowMs = Date.now();
  const by = { personName: "Claude (restore, for Junid)", deviceId: null, uid: null };
  for (const pid of pids) {
    const p = rest(`products/${pid}`);
    if (!p) { console.log(`${pid}: not found`); continue; }
    const cells = cellsOf(pid, locs);
    const plan = planSneakerRestore({ ...p, id: pid }, cells, history[pid] || {}, { seatHub2: SEAT, nowMs, by });
    console.log(`\n${pid} — ${p.name} (${p.styleCode || "no style code"})`);
    if (!plan.ok) { console.log(`  NOT RESTORED: ${plan.reason}`); continue; }
    console.log("  before:", JSON.stringify(plan.before));
    console.log("  after: ", JSON.stringify(plan.after));
    for (const n of plan.notes) console.log("  ·", n);
    if (!APPLY) continue;
    const key = `${nowMs}_restore`;
    const update = {
      ...Object.fromEntries(Object.entries(plan.patch).map(([k, v]) => [`products/${pid}/${k}`, v])),
      ...plan.seeds,
      [`products/${pid}/typeLog/${key}`]: typeLogEntry({ from: p.productType ?? null, to: "sneaker", atMs: nowMs, by, reason: REASON, before: plan.before, after: plan.after }),
    };
    rest("", { method: "PATCH", body: update });
    const back = rest(`products/${pid}`);
    console.log(`  APPLIED → type ${back.productType}, hubs ${JSON.stringify(back.hubs)}, sizes ${JSON.stringify(back.sizes)}`);
  }
}

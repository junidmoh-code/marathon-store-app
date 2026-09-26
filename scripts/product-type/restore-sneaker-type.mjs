// ─── PUT A SNEAKER SWITCHED TO CLOTHING BACK ─────────────────────────────────
//
//   ACCESS_TOKEN=… node scripts/product-type/restore-sneaker-type.mjs <pid> [<pid>…] [--seat-hub2] [--keep-sizes] [--apply]
//
// Dry run by default: prints the plan (sneakerRestoreCore.planSneakerRestore)
// and writes nothing. --apply writes, per product, ONE multi-path update: the
// product patch, any Hub 2 seats (qty-0 seed cells — no stock moves), and an
// audit entry under product_type_log/{pid} (server time, the operator named
// from the token). Re-reads and prints the result.
//
// Reads are per path and bounded: the product, its cell at each location, and
// the insights rollup one day at a time (cached under --cache <dir>). Uses curl
// because node on Junid's Mac cannot reach Google (reference note); an owner
// OAuth token in ACCESS_TOKEN.
import { planSneakerRestore, typeLogEntry } from "./sneakerRestoreCore.mjs";
import { execFileSync } from "node:child_process";
import { cellsOf, orderHistory, rest } from "./productTypeData.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SEAT = argv.includes("--seat-hub2");
const KEEP = argv.includes("--keep-sizes");
const cacheIdx = argv.indexOf("--cache");
const CACHE = cacheIdx >= 0 ? argv[cacheIdx + 1] : null;
const reasonIdx = argv.indexOf("--reason");
const REASON = reasonIdx >= 0 ? argv[reasonIdx + 1] : "switched to Clothing by mistake — restored from stock and order history";
const pids = argv.filter((a, i) => /^p\d+$/.test(a) && argv[i - 1] !== "--cache");
const TOKEN = process.env.ACCESS_TOKEN;
if (!TOKEN) { console.error("ACCESS_TOKEN is required"); process.exit(2); }
if (!pids.length) { console.error("usage: restore-sneaker-type.mjs <pid>… [--seat-hub2] [--apply] [--cache dir]"); process.exit(2); }

{
  const locs = [...Object.keys(rest("locations", { qs: "shallow=true" }) || {}), "in_transit"].filter((v, i, a) => a.indexOf(v) === i);
  const history = orderHistory(new Set(pids), CACHE);
  const nowMs = Date.now();
  // WHO RAN IT: the account behind ACCESS_TOKEN, asked of Google — never a
  // hard-coded name. (CodeRabbit, PR #651.)
  const info = JSON.parse(execFileSync("curl", ["-s", `https://oauth2.googleapis.com/tokeninfo?access_token=${process.env.ACCESS_TOKEN}`]).toString() || "{}");
  if (!info.email) { console.error("could not identify the operator from ACCESS_TOKEN"); process.exit(2); }
  const by = { personName: `${info.email} (restore script)`, deviceId: null, uid: null };
  for (const pid of pids) {
    const p = rest(`products/${pid}`);
    if (!p) { console.log(`${pid}: not found`); continue; }
    const cells = cellsOf(pid, locs);
    const plan = planSneakerRestore({ ...p, id: pid }, cells, history[pid] || {}, { seatHub2: SEAT, keepSizes: KEEP, nowMs, by });
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
      // The server's clock, not this machine's. (CodeRabbit, PR #651.)
      [`products/${pid}/typeChangedAt`]: { ".sv": "timestamp" },
      // The same server-only log setProductType writes (no client rule).
      [`product_type_log/${pid}/${key}`]: typeLogEntry({ from: p.productType ?? null, to: "sneaker", atMs: { ".sv": "timestamp" }, by, reason: REASON, before: plan.before, after: plan.after }),
    };
    rest("", { method: "PATCH", body: update });
    const back = rest(`products/${pid}`);
    console.log(`  APPLIED → type ${back.productType}, hubs ${JSON.stringify(back.hubs)}, sizes ${JSON.stringify(back.sizes)}`);
  }
}

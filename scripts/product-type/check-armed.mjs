// Does the refill engine arm this product at Hub 1 / Hub 2, and is it seated
// (orderable) there? Runs the engine's own resolveTarget on the live config,
// explicit rows and stock cells — per-path reads only.
//   ACCESS_TOKEN=… node scripts/product-type/check-armed.mjs <pid>
import { createRequire } from "node:module";
import { rest } from "./productTypeData.mjs";
const require = createRequire(import.meta.url);
const E = require("../../functions/lib/refill-engine.cjs");

const pid = process.argv[2];
if (!/^p\d+$/.test(pid || "")) { console.error("usage: check-armed.mjs <pid>"); process.exit(2); }
const LOCS = ["hub1", "hub2", "central", "hub3"];
const product = rest(`products/${pid}`);
const stock = {}; const targets = {};
for (const l of LOCS) {
  const c = rest(`stock/${l}/${pid}`); if (c) stock[l] = { [pid]: c };
  const t = rest(`stock_targets/${l}/${pid}`); if (t) targets[l] = { [pid]: t };
}
const ctx = { config: rest("config/refillEngine"), products: { [pid]: product }, stock, targets };
console.log(`${pid} — ${product?.name} · type ${product?.productType} · hubs ${JSON.stringify(product?.hubs)}`);
for (const dest of ["hub1", "hub2"]) {
  const row = (product?.sizes || []).map((s) => { const t = E.resolveTarget(ctx, dest, pid, s); return `${s}:${t ? t.target : "—"}`; });
  const seats = Object.keys(stock[dest]?.[pid] || {}).length;
  console.log(`  ${dest}: targets ${row.join(" ")} · seated in ${seats} size${seats === 1 ? "" : "s"}${seats ? " (orderable)" : " (NOT orderable)"}`);
}

// READ-ONLY trace of named sneaker records (Junid, 22 Nov 2026): why does the
// Missing list say "nothing left to raise"? Narrow reads only — one product
// record, its cells at Central and the hubs, its target rows, its engine
// locks, and the footwear policy nodes.
//   node scripts/diag/trace-sneaker-pids.mjs <pid> [<pid>…]
import { restGet } from "./rest-read.mjs";
const pids = process.argv.slice(2);
const run = await restGet("config/refillEngine/footwearRunByLocation");
const group = await restGet("config/refillEngine/policyGroups/footwear-all");
console.log("footwearRunByLocation:", JSON.stringify(run));
console.log("policyGroups/footwear-all:", JSON.stringify(group));
for (const pid of pids) {
  const p = await restGet(`products/${pid}`);
  console.log(`\n=== ${pid} — ${p?.name} | category ${p?.category} | key ${p?.categoryKey} | type ${p?.productType} | sizes ${JSON.stringify(p?.sizes)} | deactivated ${!!p?.deactivated}`);
  console.log("categoryPolicy for key:", JSON.stringify(await restGet(`config/refillEngine/categoryPolicy/${p?.categoryKey}`)));
  for (const loc of ["central", "hub1", "hub2", "hub3"]) {
    const cells = await restGet(`stock/${loc}/${pid}`);
    console.log(`stock/${loc}:`, cells ? Object.entries(cells).map(([k, c]) => `${k}=${c?.qty}`).join(" ") : "none");
  }
  for (const loc of ["hub1", "hub2", "hub3"]) {
    console.log(`stock_targets/${loc}:`, JSON.stringify(await restGet(`stock_targets/${loc}/${pid}`)));
    console.log(`refill_engine/open/${loc}:`, JSON.stringify(await restGet(`refill_engine/open/${loc}/${pid}`)));
  }
  console.log("hidden:", JSON.stringify(await restGet(`settings/missingProductsHidden/${pid}`)));
}

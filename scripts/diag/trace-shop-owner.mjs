// READ-ONLY: for named products, where each is carried, seated or queued at
// the Concrete division's shops (and Central), and the config that decides
// what a Solve to each shop would send. Narrow reads only.
//   node scripts/diag/trace-shop-owner.mjs <pid> [<pid>…]
import { restGet } from "./rest-read.mjs";
const cfg = await restGet("config/refillEngine");
console.log("centralFedClothing:", JSON.stringify(cfg?.centralFedClothing), "concreteDivision:", JSON.stringify(cfg?.concreteDivision), "pausedLocations:", JSON.stringify(cfg?.pausedLocations), "policyFollow:", JSON.stringify(cfg?.policyFollow));
for (const pid of process.argv.slice(2)) {
  const p = await restGet(`products/${pid}`);
  console.log(`\n=== ${pid} — ${p?.name} | ${p?.categoryKey} | ${p?.productType} | sizes ${JSON.stringify(p?.sizes)} | concreteProduct ${!!p?.concreteProduct}`);
  for (const loc of ["central", "hub3", "marathon-pine", "concrete"]) {
    const cells = await restGet(`stock/${loc}/${pid}`);
    console.log(`  stock/${loc}:`, cells ? Object.entries(cells).map(([k, c]) => `${k}=${c?.qty}${c?.trust ? "(trusted)" : ""}${c?.mv === "seed" ? "(seed)" : ""}`).join(" ") : "none");
  }
  for (const loc of ["marathon-pine", "concrete", "hub3"]) {
    console.log(`  seats/${loc}:`, JSON.stringify(await restGet(`refill_engine/seats/${loc}/${pid}`)));
    console.log(`  open/${loc}:`, JSON.stringify(await restGet(`refill_engine/open/${loc}/${pid}`)));
    console.log(`  targets/${loc}:`, JSON.stringify(await restGet(`stock_targets/${loc}/${pid}`)));
  }
}

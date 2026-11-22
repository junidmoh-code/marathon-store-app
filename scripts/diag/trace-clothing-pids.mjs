// READ-ONLY trace of named clothing records at the Concrete division (Junid,
// 22 Nov 2026): does any source hold the sizes the shop is short of?
//   node scripts/diag/trace-clothing-pids.mjs <pid> [<pid>…]
import { restGet } from "./rest-read.mjs";
for (const pid of process.argv.slice(2)) {
  const p = await restGet(`products/${pid}`);
  console.log(`\n=== ${pid} — ${p?.name} | key ${p?.categoryKey} | type ${p?.productType} | sizes ${JSON.stringify(p?.sizes)} | concreteProduct ${!!p?.concreteProduct}`);
  for (const loc of ["central", "hub1", "hub2", "hub3", "concrete", "marathon-pine", "marathon-pe", "trophy", "in_transit"]) {
    const cells = await restGet(`stock/${loc}/${pid}`);
    console.log(`stock/${loc}:`, cells ? Object.entries(cells).map(([k, c]) => `${k}=${c?.qty}${c?.trust || c?.trusted ? "(t)" : ""}`).join(" ") : "none");
  }
  for (const loc of ["concrete", "marathon-pine"]) {
    const t = await restGet(`stock_targets/${loc}/${pid}`);
    console.log(`stock_targets/${loc}:`, t ? Object.entries(t).map(([k, r]) => `${k}:${r?.target}`).join(" ") : "none");
    console.log(`refill_engine/open/${loc}:`, JSON.stringify(await restGet(`refill_engine/open/${loc}/${pid}`)));
  }
}

// READ-ONLY: a snapshot of exactly the nodes the Missing Products screen
// subscribes to, for the census and the layout-shift harness. /stock and
// /stock_targets are read one location at a time.
//   node scripts/diag/snapshot-missing-screen.mjs <out.json>
import { writeFileSync } from "fs";
import { restGet } from "./rest-read.mjs";
const out = process.argv[2];
const locs = ["central", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete", "in_transit"];
const snap = { readAt: new Date().toISOString(), stock: {}, targets: {} };
for (const l of locs) { snap.stock[l] = (await restGet(`stock/${l}`)) || {}; snap.targets[l] = (await restGet(`stock_targets/${l}`)) || {}; }
snap.products = (await restGet("products")) || {};
snap.recentRequests = (await restGet("refill_requests")) || {};
snap.config = (await restGet("config/refillEngine")) || {};
snap.network = await restGet("network");
snap.held = (await restGet("settings/stockHold/held")) || {};
snap.hidden = await restGet("settings/missingProductsHidden");
// The two one-or-the-other shops' seats (the screen reads exactly these).
snap.seats = {};
for (const shop of ["marathon-pine", "concrete"]) snap.seats[shop] = (await restGet(`refill_engine/seats/${shop}`)) || {};
writeFileSync(out, JSON.stringify(snap));
console.log(out, Object.keys(snap.products).length, "products", Object.keys(snap.recentRequests).length, "requests");

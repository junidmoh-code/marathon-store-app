// READ-ONLY. Before/after website units & sizes for Junid's 12 Nov listing change, and Central-only products.
import { createRequire } from "module";
import { networkTotals } from "./inventory.mjs";
import { isOn } from "../../src/components/shopify/publishState.js";
import { readMapPaged, shallowKeys } from "../lib/rtdbPaged.mjs";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const app = admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const BEFORE = new Set(["in_transit", "concrete-stockroom", "hub3", "marathon-pine", "concrete"]);
const AFTER = new Set(["in_transit", "concrete-stockroom"]);
const NO_CENTRAL = new Set([...AFTER, "central"]);
const PICKABLE = ["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine"];
const sizesOf = (p) => (Array.isArray(p?.sizes) ? p.sizes : p?.sizes && typeof p.sizes === "object" ? Object.values(p.sizes) : []);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const pos = (o) => Object.values(o).filter((q) => q > 0).length;
const nodes = await readMapPaged(db, "shopify_publish", { pageSize: 400 });
const live = Object.entries(nodes).filter(([, n]) => isOn(n)).map(([p]) => p);
const locations = await shallowKeys(app, "locations");
const t = { bu: 0, bs: 0, au: 0, as: 0, liveBefore0: 0, liveAfterPos: 0 };
const centralOnly = []; let centralOnlySizes = 0, sizesTotalAfter = 0;
const newlyBuyable = [];
const B = 12;
for (let i = 0; i < live.length; i += B) {
  await Promise.all(live.slice(i, i + B).map(async (pid) => {
    const p = (await db.ref(`products/${pid}`).get()).val();
    const sizes = sizesOf(p); if (!p || !sizes.length) return;
    const per = await Promise.all(locations.map((l) => db.ref(`stock/${l}/${pid}`).get().then((s) => [l, s.val()])));
    const tree = {}; for (const [l, c] of per) if (c) tree[l] = { [pid]: c };
    const b = networkTotals(tree, pid, sizes, BEFORE), a = networkTotals(tree, pid, sizes, AFTER), nc = networkTotals(tree, pid, sizes, NO_CENTRAL);
    t.bu += sum(b); t.bs += pos(b); t.au += sum(a); t.as += pos(a);
    if (sum(b) === 0 && sum(a) > 0) newlyBuyable.push(`${pid} ${p.cleanName || p.name} (${sum(a)}u)`);
    // sizes buyable only because of Central (no shop/hub has that size)
    let co = 0; for (const k of Object.keys(a)) if (a[k] > 0 && nc[k] === 0) co++;
    centralOnlySizes += co;
    if (sum(a) > 0 && sum(nc) === 0) centralOnly.push({ pid, name: p.cleanName || p.name, units: sum(a), sizes: pos(a) });
  }));
  if ((i / B) % 20 === 0) process.stderr.write(`  ${i}/${live.length}\r`);
}
console.log(`live products: ${live.length}`);
console.log(`BEFORE (Hub 3/Pine/Concrete excluded): ${t.bu} units, ${t.bs} buyable sizes`);
console.log(`AFTER  (only In Transit excluded):     ${t.au} units, ${t.as} buyable sizes`);
console.log(`live products going from 0 to buyable: ${newlyBuyable.length}`); newlyBuyable.slice(0, 10).forEach((x) => console.log("   " + x));
console.log(`products with stock ONLY at Central (no shop or hub holds any listed size): ${centralOnly.length}  (${centralOnly.reduce((n, x) => n + x.units, 0)} units)`);
centralOnly.sort((a, b) => b.units - a.units).slice(0, 15).forEach((x) => console.log(`   ${x.pid}  ${x.units}u / ${x.sizes} sizes  ${x.name}`));
console.log(`sizes buyable only because of Central (product has other sizes in shops/hubs or not): ${centralOnlySizes}`);
process.exit(0);

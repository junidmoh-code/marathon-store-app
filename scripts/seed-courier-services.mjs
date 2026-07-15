// Idempotently creates the seven permanent courier catalog products.
// Dry-run by default. Run with --apply only after the normal release checks;
// it never touches /stock, barcodes, targets, or existing product records.
import { createRequire } from "module";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

const TIERS = [130, 200, 250, 300, 350, 400, 500];
const records = Object.fromEntries(TIERS.map((price, i) => {
  const tier = i + 1;
  const id = `courier-tier-${tier}`;
  return [id, { id, name: `Courier Tier ${tier}`, productType: "courier_service", active: true,
    category: "Courier Services", sizes: [], hubs: [], hasShoeBoxOption: false,
    stockPrice: price, retailPrice: price }];
}));
const apply = process.argv.includes("--apply");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const existing = await db.ref("products").once("value").then((s) => s.val() || {});
const missing = Object.fromEntries(Object.entries(records).filter(([id]) => !existing[id]));
console.log(`Courier tiers: ${Object.keys(existing).filter((id) => id.startsWith("courier-tier-")).length} present; ${Object.keys(missing).length} missing.`);
if (!apply) { console.log("DRY RUN — run with --apply to create missing records."); process.exit(0); }
if (Object.keys(missing).length) await db.ref("products").update(missing);
console.log("Courier catalog seed complete.");

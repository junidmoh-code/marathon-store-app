// ── Courier Guy rates smoke ──────────────────────────────────────────────────
// Two POST /rates calls — books nothing, charges nothing — from the default
// collection address to a Durban and a Cape Town address, for the reference
// parcel (1.5 kg, 35×25×13 cm). Prints every service and price returned, once
// for door collection and once for a locker drop-off ("Any locker", CG0000).
//
//   node scripts/shipping/smoke-rates.mjs            print only
//   node scripts/shipping/smoke-rates.mjs --record   also rewrite fixtures/
//
// --record writes the responses the bookShipment tests replay. The fixtures
// are in a PUBLIC repo, so before writing: every account id is zeroed and
// every money field is replaced by a placeholder that keeps the ORDER of the
// real prices (cheapest stays cheapest), which is all the tests need. The real
// prices live in docs/COURIER-GUY.md.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCourierClient } from "./courier-client.mjs";
import { COLLECTION_ADDRESS, DROP_BOX_PICKUP_POINT } from "../../src/shipping/shippingConfig.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

export const SMOKE_PARCEL = Object.freeze({
  submitted_length_cm: 35, submitted_width_cm: 25, submitted_height_cm: 13, submitted_weight_kg: 1.5,
});

// Public, non-customer addresses (a mall and a main road), used only to price.
export const SMOKE_DESTINATIONS = Object.freeze({
  durban: { type: "business", company: "", street_address: "81 West Road", local_area: "Overport", city: "Durban", zone: "KZN", country: "ZA", code: "4067" },
  capetown: { type: "business", company: "", street_address: "5 Esplanade Road", local_area: "Century City", city: "Cape Town", zone: "WC", country: "ZA", code: "7441" },
});

// Matched by NAME, so a field TCG adds later that carries money in a known
// shape (…rate…, …charge…, …amount…, vat) is caught without a code change.
const isMoneyKey = (k) => /rate|charge|amount|^vat$|price|cost/i.test(k) && !/vat_percentage|rate_formula|rate_types|weight/i.test(k);
const isAccountKey = (k) => k === "id" || /(_|^)id$/.test(k);

/** Zero ids, replace money by rank-preserving placeholders. Pure. */
export function redactRatesResponse(res) {
  const copy = JSON.parse(JSON.stringify(res));
  const rates = Array.isArray(copy?.rates) ? copy.rates : [];
  const order = rates.map((r, i) => [Number(r.rate) || 0, i]).sort((a, b) => a[0] - b[0]);
  const rank = new Map(order.map(([, i], pos) => [i, pos]));
  const scrub = (node, placeholder) => {
    if (Array.isArray(node)) return node.forEach((n) => scrub(n, placeholder));
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (isMoneyKey(k) && typeof v === "number") node[k] = placeholder;
      else if (isMoneyKey(k) && Array.isArray(v) && v.every((x) => typeof x === "number")) node[k] = v.map(() => placeholder);
      else if (isAccountKey(k) && typeof v === "number") node[k] = 0;
      else scrub(v, placeholder);
    }
  };
  rates.forEach((r, i) => scrub(r, 100 + 10 * rank.get(i)));
  copy._redacted = "account ids zeroed; prices replaced by rank-preserving placeholders (100, 110, …)";
  return copy;
}

async function main() {
  const record = process.argv.includes("--record");
  const client = createCourierClient();
  const collection = COLLECTION_ADDRESS;
  const dropBox = { collection_pickup_point_id: DROP_BOX_PICKUP_POINT.id, collection_pickup_point_provider: DROP_BOX_PICKUP_POINT.provider };
  if (record) mkdirSync(FIXTURES, { recursive: true });

  for (const [city, delivery] of Object.entries(SMOKE_DESTINATIONS)) {
    for (const [mode, extra] of [["door", {}], ["locker", dropBox]]) {
      const res = await client.getRates({ collection_address: collection, ...extra, delivery_address: delivery, parcels: [SMOKE_PARCEL] });
      console.log(`\n${collection.company} → ${delivery.city} (${mode}) — 1.5 kg 35×25×13`);
      for (const r of res?.rates ?? []) {
        console.log(`  ${String(r.service_level?.code).padEnd(12)} ${String(r.service_level?.name).padEnd(28)} R ${Number(r.rate).toFixed(2).padStart(8)}  charged ${r.charged_weight} kg`);
      }
      if (!res?.rates?.length) console.log("  (no rates)");
      if (record) writeFileSync(`${FIXTURES}rates-${mode}-${city}.json`, JSON.stringify(redactRatesResponse(res), null, 2) + "\n");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

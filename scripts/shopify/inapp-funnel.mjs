// ── THE BEFORE-AND-AFTER FOR THE IN-APP BROWSER NUDGE ────────────────────────
// The nudge stamps every cart with a `browser` attribute and an `escaped`
// attribute. Those attributes survive into the ORDER and into the ABANDONED
// CHECKOUT record, so this script can split the bottom of the funnel by the
// browser the shopper was actually in — which no Shopify or Meta report does.
//
//   node scripts/shopify/inapp-funnel.mjs [--since 2026-09-04] [--json]
//
// WHAT IT MEASURES, AND WHAT IT CANNOT
// It measures carts that reached checkout (an abandoned checkout is created
// once contact details are entered) and carts that became orders. It does NOT
// measure sessions or add-to-carts, because Shopify does not expose those
// without an analytics app — so this is a CHECKOUT-ENTRY→PURCHASE rate, which
// is precisely the step that was losing 79–88% of people.
//
// The honest caveat, stated here so nobody has to rediscover it: rows created
// BEFORE the nudge shipped carry no attribute at all. They show as `unstamped`
// and are the "before" baseline only in the sense that they predate the
// instrument. A clean comparison is in-app vs standard AFTER the ship date,
// and escaped vs not-escaped within the in-app group.
import { rest } from "./adminRest.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const sinceIdx = args.indexOf("--since");
const SINCE = sinceIdx !== -1 ? args[sinceIdx + 1] : "2026-09-04";

const attrOf = (row, key) => {
  const list = row?.note_attributes || [];
  const hit = list.find((a) => a?.name === key);
  return hit?.value ?? null;
};

const bucket = (browser) => {
  if (!browser) return "unstamped";
  if (browser === "standard") return "standard";
  return "in-app";
};

async function pageAll(path, key) {
  const out = [];
  let url = path;
  for (let i = 0; i < 20; i++) {
    const { body, next } = await rest(url);
    out.push(...(body[key] || []));
    if (!next) break;
    url = next;
  }
  return out;
}

const orders = await pageAll(
  `orders.json?limit=250&status=any&created_at_min=${SINCE}T00:00:00Z` +
    `&fields=id,name,created_at,note_attributes,total_price`,
  "orders"
);
const abandoned = await pageAll(
  `checkouts.json?limit=250&created_at_min=${SINCE}T00:00:00Z`,
  "checkouts"
);

const rows = {};
const put = (b, field) => {
  rows[b] = rows[b] || { reachedCheckout: 0, purchased: 0, revenue: 0 };
  rows[b][field] += 1;
};

for (const o of orders) {
  const b = bucket(attrOf(o, "browser"));
  put(b, "purchased");
  put(b, "reachedCheckout"); // an order also reached checkout
  rows[b].revenue += Number(o.total_price || 0);
}
for (const c of abandoned) {
  if (c.completed_at) continue; // became an order; already counted above
  put(bucket(attrOf(c, "browser")), "reachedCheckout");
}

// escaped-vs-not, within the in-app group
const escaped = { tapped: 0, copied: 0, arrived: 0, no: 0 };
for (const row of [...orders, ...abandoned]) {
  const e = attrOf(row, "escaped");
  if (!e) continue;
  if (e.startsWith("arrived-from")) escaped.arrived += 1;
  else if (e === "tapped-android-chrome") escaped.tapped += 1;
  else if (e === "copied-link") escaped.copied += 1;
  else escaped.no += 1;
}

const report = {
  since: SINCE,
  orders: orders.length,
  abandonedCheckouts: abandoned.length,
  byBrowser: Object.fromEntries(
    Object.entries(rows).map(([k, v]) => [
      k,
      {
        ...v,
        revenue: Number(v.revenue.toFixed(2)),
        checkoutToPurchasePct:
          v.reachedCheckout > 0
            ? Number(((100 * v.purchased) / v.reachedCheckout).toFixed(1))
            : null,
      },
    ])
  ),
  escapeActions: escaped,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nIn-app funnel since ${SINCE}`);
  console.log(`  orders: ${report.orders}   abandoned checkouts: ${report.abandonedCheckouts}\n`);
  console.log(
    "  bucket".padEnd(14) +
      "reached checkout".padStart(18) +
      "purchased".padStart(12) +
      "→ purchase".padStart(12) +
      "revenue".padStart(12)
  );
  for (const [k, v] of Object.entries(report.byBrowser)) {
    console.log(
      `  ${k}`.padEnd(14) +
        String(v.reachedCheckout).padStart(18) +
        String(v.purchased).padStart(12) +
        (v.checkoutToPurchasePct === null ? "—" : v.checkoutToPurchasePct + "%").padStart(12) +
        ("R" + v.revenue).padStart(12)
    );
  }
  console.log("\n  escape actions recorded:", JSON.stringify(escaped));
  console.log(
    "\n  note: rows created before the nudge shipped carry no attribute and\n" +
      "  appear as `unstamped`. Compare in-app vs standard AFTER the ship date,\n" +
      "  and escaped vs not within the in-app group.\n"
  );
}

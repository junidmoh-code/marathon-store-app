// ── The main-menu plan — printed, because the API will not build it ──────────
// WHY THIS IS PRINTED AND NOT APPLIED. The GraphQL Admin API on the pinned
// version (2026-07) DOES expose menuCreate / menuUpdate / menuDelete and the
// `menus` query — but this app cannot call them. Probed against the live shop
// on 2026-08-15:
//
//   query  menus       → ACCESS_DENIED, "Required access: `read_online_store_navigation`"
//   mutation menuCreate → ACCESS_DENIED, "Required access: `write_online_store_navigation`"
//
// (The mutation probe used an empty input: an access denial comes back BEFORE
// argument validation, so nothing could have been created by it.)
//
// The app "Marathon Catalogue Sync" is granted: write_files, write_inventory,
// read_inventory, read_locations, read_products, write_products,
// read_publications, write_publications, read_files. No navigation scope. So
// the menu is Junid's to build in the admin — half-doing it here would leave a
// menu that looked built and was not.
//
// This script prints the exact tree, the exact link target for every row, and
// the direct admin link. It reads the collection ids from RTDB and re-runs the
// brand-trigger validator over every menu LABEL, because a menu label is a
// catalogue field like any other.
//
//   node scripts/shopify/print-menu-plan.mjs
//
// Reads only. Touches nothing, on Shopify or in RTDB.
import { createRequire } from "module";
import { graphql } from "./client.mjs";
import { COLLECTIONS, validateCollectionPayload } from "./collectionMap.mjs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";
import { readCollectionIds } from "./collections.mjs";

const SHOP_ADMIN = "https://admin.shopify.com/store/nu3ei8-0p";
const STOREFRONT = "https://marathonclub.co.za";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
admin.initializeApp({
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const recorded = await readCollectionIds(admin.database());

// ── The compliance gate on menu labels ───────────────────────────────────────
// The labels ARE the collection titles, so this is the same pin the collections
// already pass — asserted again here so a hand-edited label can never be
// printed as "safe" without being checked.
const dirty = COLLECTIONS
  .map((c) => ({ key: c.key, label: c.title, hits: triggersInText(c.title) }))
  .filter((r) => r.hits.length);
if (dirty.length) {
  console.error("🛑 STOP — menu labels carry brand triggers and must be renamed before any menu is built:");
  for (const d of dirty) console.error(`   ${d.key}: "${d.label}" → ${d.hits.join(", ")}`);
  process.exit(1);
}
const bad = COLLECTIONS.map((c) => ({ key: c.key, ...validateCollectionPayload(c) })).filter((v) => !v.ok);
if (bad.length) {
  console.error("🛑 STOP — collections fail compliance: " + bad.map((b) => b.key).join(", "));
  process.exit(1);
}
console.log(`✓ all ${COLLECTIONS.length} menu labels pass the brand-trigger validator — nothing refused\n`);

// ── The tree ─────────────────────────────────────────────────────────────────
// Top-level order is the agreed taxonomy's order, then the cross-cutting
// collections. Children hang under Clothing. Every row is a "Collections" link
// in Shopify's menu editor, addressed by handle.
const tops = COLLECTIONS.filter((c) => c.parent === null && c.kind === "manual");
const smart = COLLECTIONS.filter((c) => c.kind === "smart");
const childrenOf = (key) => COLLECTIONS.filter((c) => c.parent === key);

// How many products each collection actually holds right now. A row that is
// empty today is a dead end for a shopper, so the plan SAYS SO rather than
// letting Junid build a menu item that leads nowhere — best-effort, because a
// missing count must not stop the plan from printing.
const counts = {};
try {
  const d = await graphql(`query { collections(first: 100) { nodes { handle productsCount { count } } } }`);
  for (const n of d.collections.nodes) counts[n.handle] = n.productsCount?.count ?? null;
} catch (e) {
  console.error(`  ⚠ could not read collection counts (${String(e?.message || e)}) — the plan below omits them\n`);
}

const rowFor = (c, depth) => {
  const id = recorded[c.key]?.shopifyCollectionId;
  const indent = depth ? "    └─ " : "";
  const head = `${indent}${c.title.padEnd(24 - indent.length)} → Collections › ${c.handle.padEnd(15)}`;
  if (!id) return `${head}  ⚠ NOT CREATED YET — run ensure-collections.mjs --commit`;
  const n = counts[c.handle];
  if (n == null) return head;
  return `${head}  ${n === 0 ? "— EMPTY today, add this row later" : `${n} product${n === 1 ? "" : "s"}`}`;
};

console.log("══ MAIN MENU — build this in the Shopify admin ══\n");
// New In leads: it is the only collection that holds everything, so it is the
// row that guarantees a path to any product, mapped or not.
// New In leads WHEN IT EXISTS — the map is a supported data edit, so the key
// may be renamed or dropped without anyone touching this script; guard rather
// than throw a TypeError over a menu listing.
const newIn = smart.find((c) => c.key === "new-in");
if (newIn) console.log(rowFor(newIn, 0));
for (const t of tops) {
  console.log(rowFor(t, 0));
  for (const kid of childrenOf(t.key)) console.log(rowFor(kid, 1));
}
for (const s of smart.filter((c) => c !== newIn)) console.log(rowFor(s, 0));

console.log(`\n══ EXACT STEPS ══

1. Open ${SHOP_ADMIN}/menus
2. Click the menu named "Main menu" (handle: main-menu). It currently holds two
   items — "Home" and "Soccer Balls" (which points at /search, not a
   collection). Leave "Home" first; the rest of this list goes after it.
3. For EVERY row above, in the order printed:
     • Add menu item
     • Name  = the label on the left, typed exactly (they are the collection
               titles, and they are what the compliance check above passed)
     • Link  = Collections › pick the collection whose handle is on the right
     • Save
4. The six rows shown indented under "Clothing" are NESTED items: add them
   first as ordinary items, then DRAG each one onto "Clothing" so it becomes a
   dropdown child. Shopify has no nesting control other than the drag handle.
5. Save the menu.

The theme reads "Main menu" for the header, so nothing else needs changing and
no theme code is touched.

══ IF YOU WANT THIS BUILT BY THE API INSTEAD ══

Grant the app the navigation scopes and this script can be replaced with one
that applies the menu directly:
  1. Shopify Dev Dashboard → app "Marathon Catalogue Sync" → Configuration
  2. Add access scopes: read_online_store_navigation, write_online_store_navigation
  3. Release the new version, then reinstall/re-authorise on the store
  4. Re-mint the token (it is minted per run, so just re-run the script)
menuCreate / menuUpdate already exist on API ${"2026-07"}; only the grant is missing.

══ VERIFY AFTERWARDS ══
`);
for (const c of COLLECTIONS) {
  console.log(`  ${STOREFRONT}/collections/${c.handle}`);
}
console.log(`
Each must return 200 and list the products the map sends there. Today, before
any menu work: Sneakers 7 · Caps & Hats 4 · New In 11 · Under R500 4 · the rest
empty (nothing else is published yet).`);
process.exit(0);

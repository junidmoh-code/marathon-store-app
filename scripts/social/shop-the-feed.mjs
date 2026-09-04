// ── SHOP THE FEED — THE LINK-IN-BIO LANDING PAGE ─────────────────────────────
// Instagram does not let a feed caption carry a tappable link, and the story
// link sticker cannot be published through the API. So the ONE link Instagram
// does honour — the bio link — has to do the work of all of them, and it has
// to point somewhere that always shows what was just posted.
//
// This program keeps that somewhere in sync. It reads what the social
// publisher has actually posted, takes the product behind each post, and
// mirrors that list into a Shopify collection:
//
//   https://marathonclub.co.za/collections/shop-the-feed
//
// That URL goes in the Instagram bio ONCE and never changes again. A shopper
// taps it and sees the same products they just scrolled past, newest first,
// each one a real product page with a real Add to Cart.
//
//   node scripts/social/shop-the-feed.mjs             say what it WOULD do
//   node scripts/social/shop-the-feed.mjs --commit    apply it
//
// ── WHY A COLLECTION AND NOT A PAGE ──────────────────────────────────────────
// A hand-built link-tree page was the obvious answer and it is the wrong one
// here, for a reason that is not aesthetic: the Shopify app this repo owns
// ("Marathon Catalogue Sync") does NOT hold write_content, so it cannot create
// or edit an online-store Page at all. Verified against the live shop —
// granted scopes are read/write products, publications, files, themes and
// navigation, and no content scope among them.
//
// A COLLECTION needs none of that. write_products already covers it, the URL
// exists the moment the collection does, and it renders inside the live theme
// with the shop's own branding, search, filters and cart. No new scope, no DNS
// record, no hosting site, no theme push, and nothing for anyone to click in
// an admin. That last part is the whole point: automated or not at all.
//
// ── WHY THIS CANNOT FIGHT THE CATEGORY RECONCILER ────────────────────────────
// scripts/shopify/collections.mjs runs a sweep that moves products between the
// managed CATEGORY collections. It cannot touch this one. planCollectionMembership
// filters every `leave` through `managedGids`, which is built from
// COLLECTION_BY_KEY — the fixed category map. "shop-the-feed" is not in that
// map and never will be, so the sweep treats it exactly as it treats a
// merchandising collection built by hand in the admin: it leaves it alone.
// The reverse holds too — this program only ever adds and removes inside its
// own collection, and reads every other one not at all.
//
// ── WHAT IS DELIBERATELY EXCLUDED ────────────────────────────────────────────
// A post can outlive the thing it was selling. Three filters, all of them
// checked against the live shop rather than against our own record of it:
//
//   not published    onlineStoreUrl null — the product is not on the storefront,
//                    so its link would 404 the moment somebody tapped it.
//   sold out         totalInventory <= 0. A bio page whose top tile is a
//                    sold-out shoe is worse than no bio page. This is not
//                    hypothetical: of the six handles sampled while building
//                    this, one was already at zero.
//   not found        the handle no longer resolves. Logged, never fatal.
//
// A post is never edited or marked in any way by this program. It reads
// social_posts and writes only to Shopify.
import { createRequire } from "module";
import { graphql } from "../shopify/client.mjs";
import { requireOnlineStorePublication, publishToOnlineStore } from "../shopify/collections.mjs";
import { missingShopifyCredentials } from "../shopify/env.mjs";

// firebase-admin is loaded inside main(), not here. The two exported decisions
// below are pure and are imported by the test; a module-level require would
// make running that test depend on a database driver being installed.
const require = createRequire(new URL("../../functions/package.json", import.meta.url));

const flags = process.argv.slice(2);
const COMMIT = flags.includes("--commit");

// ── THE COLLECTION ───────────────────────────────────────────────────────────
// The handle is the bio link and must never change; changing it silently
// breaks the one URL that is printed on a profile we cannot edit in bulk.
export const FEED_HANDLE = "shop-the-feed";
export const FEED_TITLE = "Shop the Feed";
export const FEED_DESCRIPTION =
  "<p>Everything from our latest posts, newest first. Delivered anywhere in South Africa.</p>";

// How many products the bio page carries. Deep enough that a shopper who saw a
// post last week still finds it, shallow enough that the page stays a feed
// rather than a second catalogue.
export const FEED_MAX = 24;

// How many posted items to scan. A post yields at most a handful of products
// and many repeat, so this is comfortably more than FEED_MAX needs.
const SCAN_POSTS = 200;

const log = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

// ── WHICH PRODUCTS, IN WHICH ORDER ───────────────────────────────────────────
// Newest post first, and a product appears once no matter how many posts it
// featured in. A story and its feed twin are the same product on the same day;
// showing it twice would waste a tile and make the page look padded.
//
// Ordering is by postedAt and falls back to scheduledAt — a record written
// before postedAt existed still sorts sensibly instead of sinking to the
// bottom. Exported for the test: this ordering IS the product, so it is not
// left to be re-derived at the call site.
export function feedHandlesFrom(posts, { max = FEED_MAX } = {}) {
  const rows = (posts || [])
    .filter((p) => p && p.status === "posted")
    .sort((a, b) => (b.postedAt || b.scheduledAt || 0) - (a.postedAt || a.scheduledAt || 0));

  const seen = new Set();
  const out = [];
  for (const post of rows) {
    for (const prod of Array.isArray(post.products) ? post.products : []) {
      const handle = String((prod && prod.handle) || "").trim();
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      out.push({ handle, displayName: (prod && prod.displayName) || handle, postId: post.id });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Resolve handles to live, sellable products, preserving feed order.
 * Aliased into batches so one round trip covers many handles — a per-handle
 * query would be 24 round trips against a cost-metered API for no gain.
 */
async function resolveProducts(entries) {
  const kept = [];
  const dropped = [];
  const BATCH = 12;

  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const parts = slice.map(
      (e, n) =>
        `p${n}: productByIdentifier(identifier:{handle:$h${n}}){ id title handle status onlineStoreUrl totalInventory }`
    );
    const argDefs = slice.map((_, n) => `$h${n}: String!`).join(", ");
    const vars = Object.fromEntries(slice.map((e, n) => [`h${n}`, e.handle]));
    const data = await graphql(`query (${argDefs}) { ${parts.join("\n")} }`, vars);

    slice.forEach((entry, n) => {
      const p = data[`p${n}`];
      if (!p) return dropped.push({ ...entry, why: "no such product" });
      if (p.status !== "ACTIVE") return dropped.push({ ...entry, why: `status ${p.status}` });
      if (!p.onlineStoreUrl) return dropped.push({ ...entry, why: "not on the storefront" });
      if (!(Number(p.totalInventory) > 0)) return dropped.push({ ...entry, why: "sold out" });
      kept.push({ ...entry, gid: p.id, title: p.title });
    });
  }
  return { kept, dropped };
}

/** The collection, created on first run. Idempotent. */
async function ensureFeedCollection({ commit }) {
  const found = await graphql(
    `query ($h: String!) { collectionByIdentifier(identifier:{handle:$h}) { id handle title sortOrder } }`,
    { h: FEED_HANDLE }
  );
  if (found.collectionByIdentifier) return found.collectionByIdentifier;

  if (!commit) {
    log(`  would CREATE collection "${FEED_TITLE}" (/${FEED_HANDLE}), manual sort`);
    return null;
  }
  const res = await graphql(
    `mutation ($input: CollectionInput!) {
       collectionCreate(input: $input) {
         collection { id handle title sortOrder }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title: FEED_TITLE,
        handle: FEED_HANDLE,
        descriptionHtml: FEED_DESCRIPTION,
        // MANUAL is load-bearing: it is the only sort order that lets the
        // collection show newest-posted first. Any other and Shopify re-sorts
        // the page out from under the feed.
        sortOrder: "MANUAL",
      },
    },
    { mutation: true }
  );
  const errs = res.collectionCreate.userErrors;
  if (errs?.length) throw new Error(`collectionCreate userErrors: ${JSON.stringify(errs)}`);
  log(`  CREATED collection ${res.collectionCreate.collection.id}`);
  return res.collectionCreate.collection;
}

/** Current members, newest-first as Shopify holds them. */
async function currentMembers(gid) {
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await graphql(
      `query ($id: ID!, $after: String) {
         collection(id: $id) {
           products(first: 100, after: $after) {
             nodes { id handle }
             pageInfo { hasNextPage endCursor }
           }
         }
       }`,
      { id: gid, after: cursor }
    );
    const page = d.collection.products;
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return out;
    cursor = page.pageInfo.endCursor;
  }
}

/**
 * What to add and what to drop. Exported and pure so the decision can be
 * tested without a shop: a membership diff that is only ever exercised against
 * live Shopify is a diff nobody has actually checked.
 */
export function planFeedMembership(currentGids, desiredGids) {
  const current = new Set(currentGids || []);
  const desired = new Set(desiredGids || []);
  return {
    add: (desiredGids || []).filter((g) => !current.has(g)),
    remove: (currentGids || []).filter((g) => !desired.has(g)),
  };
}

/**
 * Bring the collection in line with what has been posted.
 *
 * Takes an ALREADY-OPEN database handle so the publisher can call this at the
 * end of its own run without initialising firebase-admin a second time — a
 * second initializeApp in one process throws.
 */
export async function refreshShopTheFeed(db, { commit = false } = {}) {
  const COMMIT = commit;

  // ── NOT CONFIGURED HERE IS A LEGITIMATE STATE ──────────────────────────────
  // The publisher calls this at the end of a run that has ALREADY posted, and
  // its checkout may have no Shopify credentials at all — that was true of the
  // Mac mini until 2026-09-04. Checking up front, and throwing a plain Error,
  // means the publisher's catch turns this into a warning instead of the run
  // dying. It also stops us spending an RTDB query before finding out.
  const missing = missingShopifyCredentials();
  if (missing.length) {
    throw new Error(
      `Shop the Feed needs the Shopify credentials and this checkout has none ` +
        `(${missing.join(", ")}). The posts are unaffected; add a .env at the ` +
        `repo root to let the bio collection refresh.`
    );
  }

  log(`\nShop the Feed — ${COMMIT ? "COMMIT" : "DRY RUN (pass --commit to apply)"}\n`);

  // One bounded indexed query. Never the whole node.
  const snap = await db
    .ref("social_posts")
    .orderByChild("status")
    .equalTo("posted")
    .limitToLast(SCAN_POSTS)
    .once("value");
  const posts = Object.entries(snap.val() || {}).map(([id, body]) => ({ id, ...body }));
  log(`posted items scanned: ${posts.length}`);

  const entries = feedHandlesFrom(posts);
  log(`distinct products behind them: ${entries.length}`);
  if (!entries.length) {
    warn("nothing posted carries a product — leaving the collection untouched");
    return;
  }

  const { kept, dropped } = await resolveProducts(entries);
  for (const d of dropped) log(`  skipped ${d.handle} — ${d.why}`);
  log(`sellable right now: ${kept.length}`);
  if (!kept.length) {
    // Emptying the bio page because every recent post sold out would be a
    // strictly worse page than a slightly stale one. Refuse instead.
    warn("every candidate was filtered out — refusing to empty the collection");
    return;
  }

  const collection = await ensureFeedCollection({ commit: COMMIT });
  if (!collection) {
    log("\n(dry run: the collection does not exist yet, so there is no membership to diff)");
    log(`would seed it with ${kept.length} products:`);
    kept.forEach((k, i) => log(`  ${String(i + 1).padStart(2)}. ${k.title}`));
    return;
  }

  const desiredGids = kept.map((k) => k.gid);
  const members = await currentMembers(collection.id);
  const plan = planFeedMembership(members.map((m) => m.id), desiredGids);

  log(`\ncurrently in the collection: ${members.length}`);
  log(`  add:    ${plan.add.length}`);
  log(`  remove: ${plan.remove.length}`);
  log(`  order:  newest posted first`);

  if (!COMMIT) {
    log("\nthe feed would read:");
    kept.forEach((k, i) => log(`  ${String(i + 1).padStart(2)}. ${k.title}`));
    log("\n(dry run — nothing was written)");
    return;
  }

  if (plan.add.length) {
    const r = await graphql(
      `mutation ($id: ID!, $ids: [ID!]!) {
         collectionAddProducts(id: $id, productIds: $ids) { userErrors { field message } }
       }`,
      { id: collection.id, ids: plan.add },
      { mutation: true }
    );
    const e = r.collectionAddProducts.userErrors;
    if (e?.length) throw new Error(`collectionAddProducts userErrors: ${JSON.stringify(e)}`);
    log(`added ${plan.add.length}`);
  }

  if (plan.remove.length) {
    const r = await graphql(
      `mutation ($id: ID!, $ids: [ID!]!) {
         collectionRemoveProducts(id: $id, productIds: $ids) { job { id } userErrors { field message } }
       }`,
      { id: collection.id, ids: plan.remove },
      { mutation: true }
    );
    const e = r.collectionRemoveProducts.userErrors;
    if (e?.length) throw new Error(`collectionRemoveProducts userErrors: ${JSON.stringify(e)}`);
    log(`removed ${plan.remove.length}`);
  }

  // Reorder every time, not just when membership changed: the whole point is
  // that the newest post is the first tile, and yesterday's order is wrong the
  // moment anything is posted.
  const moves = desiredGids.map((id, i) => ({ id, newPosition: String(i) }));
  const r = await graphql(
    `mutation ($id: ID!, $moves: [MoveInput!]!) {
       collectionReorderProducts(id: $id, moves: $moves) { job { id } userErrors { field message } }
     }`,
    { id: collection.id, moves },
    { mutation: true }
  );
  const e = r.collectionReorderProducts.userErrors;
  if (e?.length) throw new Error(`collectionReorderProducts userErrors: ${JSON.stringify(e)}`);
  log(`reordered ${moves.length}`);

  // A collection that is not published to the Online Store 404s on its own URL,
  // which for THIS collection means the bio link is dead. Idempotent, so it is
  // re-asserted on every run rather than only at creation.
  const pub = await requireOnlineStorePublication(graphql, { strict: true });
  await publishToOnlineStore(graphql, collection.id, pub);
  log("published to the Online Store");

  log(`\n✓ https://marathonclub.co.za/collections/${FEED_HANDLE}`);
}

async function main() {
  const admin = require("firebase-admin");
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
  await refreshShopTheFeed(admin.database(), { commit: COMMIT });
}

// Only run when executed directly — the exports above are imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      warn(`\n✗ ${err.message}\n`);
      process.exit(1);
    });
}

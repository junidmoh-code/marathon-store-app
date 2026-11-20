// ─── IS IT ON THE WEBSITE? — asked of Shopify itself (Junid, 20 Nov 2026) ─────
// The app's own record (/shopify_publish state live + liveState on) is the
// reconciler's last confirmation; this asks Shopify directly, for the products
// about to be posted: the product the ID map names is ACTIVE and published on
// the Online Store channel. Read-only — one GraphQL call per 50 products.
// Used by the Black Friday backfill and by the poster's album gate.
import { isOn } from "../../src/components/shopify/publishState.js";

const val = async (db, p) => (await db.ref(p).once("value")).val();

/**
 * deps: { db, graphql, publicationId } → { [pid]: { live: boolean, why } }
 * why: "on the website" | "never published" | "deleted from Shopify" | "a draft on Shopify" | "not on the Online Store"
 */
export async function liveOnShopify({ db, graphql, publicationId }, pids) {
  const out = {};
  const gids = {};
  await Promise.all(pids.map(async (pid) => { gids[pid] = await val(db, `shopify_sync/${pid}/shopifyProductId`); }));
  const mapped = pids.filter((pid) => typeof gids[pid] === "string" && gids[pid].startsWith("gid://shopify/Product/"));
  for (const pid of pids) if (!mapped.includes(pid)) out[pid] = { live: false, why: "never published" };
  for (let i = 0; i < mapped.length; i += 50) {
    const chunk = mapped.slice(i, i + 50);
    const q = await graphql(
      `query ($ids: [ID!]!, $pub: ID!) { nodes(ids: $ids) { ... on Product { id status onStore: publishedOnPublication(publicationId: $pub) } } }`,
      { ids: chunk.map((pid) => gids[pid]), pub: publicationId },
    );
    const byId = new Map((q?.nodes || []).filter(Boolean).map((n) => [n.id, n]));
    for (const pid of chunk) {
      const n = byId.get(gids[pid]);
      if (!n) out[pid] = { live: false, why: "deleted from Shopify" };
      else if (n.status !== "ACTIVE") out[pid] = { live: false, why: `a ${String(n.status || "draft").toLowerCase()} on Shopify` };
      else if (!n.onStore) out[pid] = { live: false, why: "not on the Online Store" };
      else out[pid] = { live: true, why: "on the website" };
    }
  }
  return out;
}

/**
 * The app's record only (no Shopify call) — the fallback when Shopify cannot be asked.
 * → { [pid]: { live, why } }
 */
export async function liveInApp(db, pids) {
  const out = {};
  await Promise.all(pids.map(async (pid) => {
    const node = await val(db, `shopify_publish/${pid}`);
    out[pid] = isOn(node) ? { live: true, why: "on the website (app record)" } : { live: false, why: "not on the website yet" };
  }));
  return out;
}

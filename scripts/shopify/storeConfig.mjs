// ── WHICH SHOPIFY STORE THIS PROCESS TALKS TO ────────────────────────────────
// Since 2026-11-15 there are two: Marathon (nu3ei8-0p, marathonclub.co.za)
// and Concrete World (g2m9cm-9q, concreteworld.co.za). A product Junid marks
// listOnConcrete is listed on BOTH, from the one stock pool.
//
// ONE STORE PER PROCESS. The token cache, the GraphQL client and every RTDB
// node name below are bound to the store chosen when the process starts:
//
//   SHOPIFY_STORE unset / "marathon"  → Marathon, byte-for-byte today's values
//   SHOPIFY_STORE=concrete             → Concrete
//
// reconcile-runner.mjs runs reconcile.mjs once per store, in separate
// processes, so a Concrete failure (or missing credentials) can never touch
// Marathon's run. Nothing here reads a credential VALUE; only names.
export const STORES = Object.freeze({
  marathon: Object.freeze({
    key: "marathon",
    label: "Marathon",
    shop: "nu3ei8-0p.myshopify.com",
    shopVar: "SHOPIFY_SHOP",           // Marathon's host is read AND pinned (env.mjs)
    idVar: "SHOPIFY_CLIENT_ID",
    secretVar: "SHOPIFY_CLIENT_SECRET",
    publishPath: "shopify_publish",
    syncPath: "shopify_sync",
    suffix: "",
    vendor: "Marathon Club",
  }),
  concrete: Object.freeze({
    key: "concrete",
    label: "Concrete",
    shop: "g2m9cm-9q.myshopify.com",
    shopVar: null,                     // fixed host, never read from the environment
    idVar: "CONCRETE_SHOPIFY_CLIENT_ID",
    secretVar: "CONCRETE_SHOPIFY_CLIENT_SECRET",
    publishPath: "shopify_publish_concrete",
    syncPath: "shopify_sync_concrete",
    suffix: "_concrete",
    vendor: "Concrete",
  }),
});

export function storeFor(key) {
  const k = key || "marathon";
  const s = STORES[k];
  if (!s) throw new Error(`SHOPIFY_STORE="${k}" is not a store this program knows (${Object.keys(STORES).join(", ")})`);
  return s;
}

export const STORE = storeFor(typeof process !== "undefined" ? process.env.SHOPIFY_STORE : undefined);
export const IS_MARATHON = STORE.key === "marathon";
export const PUBLISH_PATH = STORE.publishPath;
export const SYNC_PATH = STORE.syncPath;
/** A per-store sibling of a Marathon node: "shopify_inventory_dirty" → "…_concrete". */
export const storeNode = (base, store = STORE) => `${base}${store.suffix}`;
/** Credential variable names a store needs; [] missing = configured. */
export const credentialVars = (store = STORE) => [store.shopVar, store.idVar, store.secretVar].filter(Boolean);
export const missingCredentials = (store = STORE, env = process.env) => credentialVars(store).filter((n) => !env[n]);
/** Admin link for a product gid on this store. */
export const adminProductUrl = (numericId, store = STORE) =>
  `https://admin.shopify.com/store/${store.shop.split(".")[0]}/products/${numericId}`;

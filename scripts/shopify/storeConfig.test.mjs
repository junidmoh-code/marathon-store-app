import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const probe = (store) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
  const c = await import("./storeConfig.mjs");
  const e = await import("./env.mjs");
  const comp = await import("./compliance.mjs");
  const inv = await import("./inventorySync.mjs");
  const poll = await import("./onlineOrders/poll.mjs");
  const coll = await import("./collectionMap.mjs");
  console.log(JSON.stringify({ key: c.STORE.key, pub: c.PUBLISH_PATH, sync: c.SYNC_PATH, shop: c.STORE.key === "concrete" ? e.requireShop() : null,
    vendor: comp.VENDOR, dirty: inv.DIRTY_PATH, meta: poll.META_PATH, seo: coll.COLLECTIONS[0].seoTitle,
    missing: e.missingShopifyCredentials({}) }));`],
  { cwd: HERE, env: { ...process.env, SHOPIFY_STORE: store ?? "", SHOPIFY_SHOP: "", SHOPIFY_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "", CONCRETE_SHOPIFY_CLIENT_ID: "", CONCRETE_SHOPIFY_CLIENT_SECRET: "" } }).toString());

describe("store config", () => {
  it("unset = Marathon, every name exactly as before", () => {
    const m = probe(undefined);
    expect(m).toMatchObject({ key: "marathon", pub: "shopify_publish", sync: "shopify_sync", vendor: "Marathon Club",
      dirty: "shopify_inventory_dirty", meta: "online_orders_meta", seo: "Sneakers | Marathon Club" });
    expect(m.missing).toEqual(["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]);
  });
  it("concrete binds its own fixed host, credentials and nodes", () => {
    const c = probe("concrete");
    expect(c).toMatchObject({ key: "concrete", pub: "shopify_publish_concrete", sync: "shopify_sync_concrete",
      shop: "g2m9cm-9q.myshopify.com", vendor: "Concrete", dirty: "shopify_inventory_dirty_concrete",
      meta: "online_orders_meta_concrete", seo: "Sneakers | Concrete" });
    expect(c.missing).toEqual(["CONCRETE_SHOPIFY_CLIENT_ID", "CONCRETE_SHOPIFY_CLIENT_SECRET"]);
  }, 20000);
});

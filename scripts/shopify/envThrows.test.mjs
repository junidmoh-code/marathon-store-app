// ── A MISSING CREDENTIAL MUST NOT BE ABLE TO KILL A RUN ──────────────────────
// The bug this guards against is not hypothetical. On 2026-09-04 the social
// publisher posted to Instagram and Facebook, then refreshed the Shop the Feed
// collection inside a try/catch whose comment reads "IT MUST NEVER FAIL THE
// RUN". The mini's checkout had no .env, requireEnv called process.exit(2),
// and process.exit is not throwable — so the catch never ran and a run whose
// posts had ALL SUCCEEDED was bannered "✗✗ RUN FAILED (exit 2)" and counted
// toward the consecutive-failure alarm.
//
// The distinction these tests protect is exactly the one that failed: a
// credential problem must be CATCHABLE, because the caller is the only thing
// that knows whether it is fatal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  requireEnv,
  requireShop,
  missingShopifyCredentials,
  MissingEnvError,
  SHOPIFY_CREDENTIAL_VARS,
} from "./env.mjs";

const SAVED = {};
const KEYS = ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"];

beforeEach(() => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("requireEnv", () => {
  it("THROWS on a missing var — it must never call process.exit", () => {
    expect(() => requireEnv("SHOPIFY_SHOP")).toThrow(MissingEnvError);
  });

  it("is catchable, which is the whole point", () => {
    let caught = null;
    try {
      requireEnv("SHOPIFY_CLIENT_SECRET");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingEnvError);
    expect(caught.varName).toBe("SHOPIFY_CLIENT_SECRET");
  });

  it("keeps the message a person running a script by hand relies on", () => {
    expect(() => requireEnv("SHOPIFY_SHOP")).toThrow(/Missing required env var SHOPIFY_SHOP/);
    expect(() => requireEnv("SHOPIFY_SHOP")).toThrow(/git-ignored \.env at the repo root/);
  });

  it("returns the value when it is set", () => {
    process.env.SHOPIFY_SHOP = "nu3ei8-0p.myshopify.com";
    expect(requireEnv("SHOPIFY_SHOP")).toBe("nu3ei8-0p.myshopify.com");
  });
});

describe("requireShop", () => {
  it("still REFUSES a host that is not the pinned store — and throws, not exits", () => {
    process.env.SHOPIFY_SHOP = "someone-elses-store.myshopify.com";
    expect(() => requireShop()).toThrow(/only talks to nu3ei8-0p\.myshopify\.com/);
  });

  it("accepts the pinned store", () => {
    process.env.SHOPIFY_SHOP = "nu3ei8-0p.myshopify.com";
    expect(requireShop()).toBe("nu3ei8-0p.myshopify.com");
  });
});

describe("missingShopifyCredentials", () => {
  it("names every absent credential and never throws", () => {
    expect(missingShopifyCredentials({})).toEqual([...SHOPIFY_CREDENTIAL_VARS]);
  });

  it("is empty when all three are present", () => {
    expect(
      missingShopifyCredentials({
        SHOPIFY_SHOP: "s",
        SHOPIFY_CLIENT_ID: "i",
        SHOPIFY_CLIENT_SECRET: "x",
      })
    ).toEqual([]);
  });

  it("reports only what is actually missing", () => {
    expect(missingShopifyCredentials({ SHOPIFY_SHOP: "s" })).toEqual([
      "SHOPIFY_CLIENT_ID",
      "SHOPIFY_CLIENT_SECRET",
    ]);
  });

  it("reads process.env by default", () => {
    process.env.SHOPIFY_SHOP = "s";
    expect(missingShopifyCredentials()).toEqual([
      "SHOPIFY_CLIENT_ID",
      "SHOPIFY_CLIENT_SECRET",
    ]);
  });
});

// ── THE REGRESSION ITSELF ────────────────────────────────────────────────────
// This calls the REAL refreshShopTheFeed — the function that actually died in
// production. An earlier version of this block defined a local stand-in that
// threw its own Error, and an adversarial review proved it was theatre by
// restoring the process.exit(2) bug and watching it still pass. A guard that
// passes with the bug present is worse than no guard, because it argues
// against looking any further.
//
// The real function is safe to call with a null database handle: it checks the
// credentials BEFORE it touches `db`, so nothing is dereferenced, and
// shop-the-feed.mjs keeps its main() behind an `import.meta.url` guard, so
// importing the module starts nothing.
describe("the publisher's shape — against the real function", () => {
  it("refreshShopTheFeed REJECTS rather than exiting when the checkout has no credentials", async () => {
    // Under the old code this line called process.exit(2) and took the vitest
    // worker down with it — the whole file would fail. That is the guard.
    const { refreshShopTheFeed } = await import("../social/shop-the-feed.mjs");
    await expect(refreshShopTheFeed(null, { commit: true })).rejects.toThrow(
      /Shop the Feed needs the Shopify credentials/
    );
  });

  it("names every missing credential, so the log says what to fix", async () => {
    const { refreshShopTheFeed } = await import("../social/shop-the-feed.mjs");
    await expect(refreshShopTheFeed(null, { commit: true })).rejects.toThrow(
      /SHOPIFY_SHOP.*SHOPIFY_CLIENT_ID.*SHOPIFY_CLIENT_SECRET/
    );
  });

  it("the publisher's own try/catch turns that rejection into a warning", async () => {
    // publish.mjs's exact shape, with the REAL refresh inside it.
    const { refreshShopTheFeed } = await import("../social/shop-the-feed.mjs");
    const warnings = [];
    let failed = 0;
    const posted = 1;

    if (posted > 0) {
      try {
        await refreshShopTheFeed(null, { commit: true });
      } catch (err) {
        warnings.push(err.message);
      }
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Shop the Feed needs the Shopify credentials/);
    expect(failed).toBe(0); // a run whose posts all succeeded is a SUCCESS
  });
});

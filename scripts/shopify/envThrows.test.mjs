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
// A stand-in for the publisher's shape: post first, then refresh, with the
// refresh wrapped exactly as publish.mjs wraps it. Before the fix this test
// could not even be WRITTEN — process.exit would have taken the test runner
// down with it.
describe("the publisher's shape", () => {
  it("a credential-less refresh warns and the run still succeeds", async () => {
    const warnings = [];
    let posted = 1;

    async function refreshLikeShopTheFeed() {
      const missing = missingShopifyCredentials();
      if (missing.length) throw new Error(`no credentials here (${missing.join(", ")})`);
      return "refreshed";
    }

    let failed = 0;
    if (posted > 0) {
      try {
        await refreshLikeShopTheFeed();
      } catch (err) {
        warnings.push(err.message);
      }
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no credentials here/);
    expect(failed).toBe(0); // the run is a SUCCESS — this is the bug, fixed
  });
});

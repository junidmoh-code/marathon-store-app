// ── GraphQL client retry-matrix tests (stubbed fetch, no network) ────────────
// The client's retry/refresh accounting is where a silent bug double-creates a
// product or eats the actionable error, so each branch is pinned:
//   • 401 → re-mint once, does NOT consume a retry attempt
//   • second 401 → surfaces as an error (no refresh loop)
//   • mutation + 5xx → throws IMMEDIATELY (may have applied server-side)
//   • query + 5xx → retries
//   • THROTTLED mixed with a real error → throws immediately, no retry burn
// Modules are re-imported per test (vi.resetModules) because token.mjs caches
// the minted token in module state.
import { describe, it, expect, beforeEach, vi } from "vitest";

const TOKEN_URL = /\/admin\/oauth\/access_token$/;
const okToken = () =>
  new Response(JSON.stringify({ access_token: "tok", expires_in: 86399, scope: "s" }), {
    status: 200,
  });
const gqlOk = (data = { ok: true }) =>
  new Response(JSON.stringify({ data }), { status: 200 });

// Queue of responses for graphql.json calls; token mints are counted separately.
function stubFetch(gqlResponses) {
  let mints = 0;
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (TOKEN_URL.test(String(url))) {
        mints += 1;
        return okToken();
      }
      calls.push(url);
      const next = gqlResponses.shift();
      if (!next) throw new Error("stub exhausted");
      return next();
    })
  );
  return { gqlCalls: calls, mintCount: () => mints };
}

async function freshClient() {
  vi.resetModules();
  process.env.SHOPIFY_SHOP = "stub-shop.myshopify.com";
  process.env.SHOPIFY_CLIENT_ID = "stub-id";
  process.env.SHOPIFY_CLIENT_SECRET = "stub-secret";
  return import("./client.mjs");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("graphql client — retry matrix", () => {
  it("401 re-mints once without consuming a retry attempt, then succeeds", async () => {
    const { gqlCalls, mintCount } = stubFetch([
      () => new Response("unauthorized", { status: 401 }),
      () => gqlOk({ fine: 1 }),
    ]);
    const { graphql } = await freshClient();
    await expect(graphql("query { x }")).resolves.toEqual({ fine: 1 });
    expect(gqlCalls.length).toBe(2);
    expect(mintCount()).toBe(2); // initial mint + the re-mint after 401
  });

  it("a second 401 is a hard error, not a refresh loop", async () => {
    stubFetch([
      () => new Response("unauthorized", { status: 401 }),
      () => new Response("unauthorized", { status: 401 }),
    ]);
    const { graphql } = await freshClient();
    await expect(graphql("query { x }")).rejects.toThrow(/HTTP 401/);
  });

  it("a 5xx on a MUTATION throws immediately — it may have applied server-side", async () => {
    const { gqlCalls } = stubFetch([() => new Response("boom", { status: 502 })]);
    const { graphql } = await freshClient();
    await expect(graphql("mutation { y }", {}, { mutation: true })).rejects.toThrow(
      /MUTATION — not retrying/
    );
    expect(gqlCalls.length).toBe(1); // exactly one send, no blind retry
  });

  it("THROTTLED mixed with a real error throws immediately instead of retrying", async () => {
    const { gqlCalls } = stubFetch([
      () =>
        new Response(
          JSON.stringify({
            errors: [
              { message: "Throttled", extensions: { code: "THROTTLED" } },
              { message: "Field 'nope' doesn't exist", extensions: { code: "undefinedField" } },
            ],
          }),
          { status: 200 }
        ),
    ]);
    const { graphql } = await freshClient();
    await expect(graphql("query { nope }")).rejects.toThrow(/GraphQL errors/);
    expect(gqlCalls.length).toBe(1);
  });

  it("a 5xx on a QUERY retries and succeeds (Retry-After honoured)", async () => {
    const { gqlCalls } = stubFetch([
      () => new Response("flaky", { status: 503, headers: { "Retry-After": "1" } }),
      () => gqlOk({ recovered: true }),
    ]);
    const { graphql } = await freshClient();
    await expect(graphql("query { x }")).resolves.toEqual({ recovered: true });
    expect(gqlCalls.length).toBe(2);
  }, 10000);

  it("plain GraphQL errors throw with the error payload", async () => {
    stubFetch([
      () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
    ]);
    const { graphql } = await freshClient();
    await expect(graphql("query { z }")).rejects.toThrow(/bad/);
  });
});

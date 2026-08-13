// ── Shopify access-token minter — client credentials grant ───────────────────
// The "Marathon Catalogue Sync" app is a Dev Dashboard app with NO static
// access token. Tokens are minted on demand:
//
//   POST https://{shop}/admin/oauth/access_token
//   form body: grant_type=client_credentials, client_id, client_secret
//   → { access_token, expires_in: 86399 (24 h), scope }
//
// (https://shopify.dev/docs/apps/build/authentication-authorization/
//  access-tokens/client-credentials-grant)
//
// The token is cached IN MEMORY ONLY and re-minted 5 minutes before expiry.
// It is never written to disk and never logged; only expires_in / scope are
// safe to print.
import { requireEnv } from "./env.mjs";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cache = null; // { token, refreshAt, expiresIn, scope } — process memory only
let minting = null; // single-flight: concurrent callers share one in-flight mint

export async function getAccessToken() {
  if (cache && Date.now() < cache.refreshAt) return cache.token;
  if (!minting) {
    minting = mint().finally(() => {
      minting = null;
    });
  }
  return minting;
}

async function mint() {
  const shop = requireEnv("SHOPIFY_SHOP");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requireEnv("SHOPIFY_CLIENT_ID"),
    client_secret: requireEnv("SHOPIFY_CLIENT_SECRET"),
  });

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // shop_not_permitted = the app and the store are not in the same Shopify
    // organisation. That is an org/dashboard problem, not fixable in code.
    if (text.includes("shop_not_permitted")) {
      throw new Error(
        "Token request refused: shop_not_permitted — the app and the store " +
          "are not in the same Shopify organisation. Fix in the Dev " +
          "Dashboard / store admin, not in code."
      );
    }
    throw new Error(`Token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("Token response carried no access_token.");
  cache = {
    token: json.access_token,
    refreshAt: Date.now() + Math.max(0, (json.expires_in ?? 0) * 1000 - REFRESH_MARGIN_MS),
    expiresIn: json.expires_in ?? null,
    scope: json.scope ?? null,
  };
  return cache.token;
}

// Forget the cached token (e.g. after a 401) so the next call re-mints.
export function invalidateToken() {
  cache = null;
}

// Safe-to-print metadata about the current token. Never exposes the token.
export function tokenInfo() {
  if (!cache) return null;
  return { expiresIn: cache.expiresIn, scope: cache.scope };
}

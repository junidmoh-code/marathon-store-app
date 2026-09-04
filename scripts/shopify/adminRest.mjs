// ── A THIN REST READER, FOR THE THINGS GRAPHQL DOES NOT EXPOSE ───────────────
// GraphQL is the right default and client.mjs stays the main road. But two
// things this repo needs are REST-only:
//
//   * abandoned checkouts carry `note_attributes`, `landing_site` and
//     `referring_site`; the GraphQL AbandonedCheckout type carries none of
//     them (verified by introspection, 2026-09-04).
//   * `Link:` header paging, which the checkouts endpoint uses.
//
// It shares token.mjs, so it mints and refreshes on the same 24-hour cycle as
// the GraphQL client and nothing new holds a credential.
import { getAccessToken, invalidateToken } from "./token.mjs";
import { requireShop } from "./env.mjs";

export const REST_VERSION = "2025-01";

/** Parse the `Link: <url>; rel="next"` header Shopify pages with. */
export function nextFromLink(link) {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

/**
 * GET one REST path (or a full absolute URL, as returned by nextFromLink).
 * Returns { body, next }.
 */
export async function rest(pathOrUrl) {
  const shop = requireShop();
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${shop}/admin/api/${REST_VERSION}/${pathOrUrl}`;

  let refreshed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": await getAccessToken() },
    });

    if (res.status === 401 && !refreshed) {
      invalidateToken();
      refreshed = true;
      attempt -= 1; // the request never ran; a refresh must not eat an attempt
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`REST ${res.status} on ${url.replace(/\?.*$/, "")}`);
    }
    return { body: await res.json(), next: nextFromLink(res.headers.get("Link")) };
  }
  throw new Error(`REST gave up after 5 attempts on ${url.replace(/\?.*$/, "")}`);
}

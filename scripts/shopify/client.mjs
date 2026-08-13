// ── Thin Shopify GraphQL Admin client ────────────────────────────────────────
// GraphQL only — the REST product endpoints are legacy. The API version is
// pinned HERE and nowhere else; bump it in one place after reading the release
// notes. 2026-07 is the latest stable offered by the Dev Dashboard for this
// app (verified 2026-08-13).
//
// Shopify throttles with a cost-based leaky bucket: every response carries
// extensions.cost.throttleStatus { maximumAvailable, currentlyAvailable,
// restoreRate }. On a THROTTLED error this client waits long enough for the
// bucket to refill the requested cost, then retries. HTTP 429/5xx retry with
// backoff; a 401 re-mints the token once (they expire after 24 h).
import { getAccessToken, invalidateToken } from "./token.mjs";
import { requireEnv } from "./env.mjs";

export const API_VERSION = "2026-07";

const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function graphql(query, variables = {}) {
  const shop = requireEnv("SHOPIFY_SHOP");
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  let attempt = 0;
  let refreshed = false;
  for (;;) {
    attempt += 1;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getAccessToken(),
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 && !refreshed) {
      invalidateToken();
      refreshed = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const json = await res.json();
    const throttled = (json.errors || []).some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < MAX_ATTEMPTS) {
      const cost = json.extensions?.cost;
      const need = cost?.requestedQueryCost ?? 50;
      const have = cost?.throttleStatus?.currentlyAvailable ?? 0;
      const rate = cost?.throttleStatus?.restoreRate ?? 50;
      const waitS = Math.max((need - have) / rate, 1);
      await sleep(waitS * 1000);
      continue;
    }
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
    }
    return json.data;
  }
}

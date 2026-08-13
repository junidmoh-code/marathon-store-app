// ── Product photos for the Shopify push ──────────────────────────────────────
// Photos come from the record's own fields: photoUrl (the hero) plus gallery
// (extra angles, AI photo studio) — public HTTPS Firebase Storage URLs, no
// signing. Alt text is the CLEANED name (the original may carry triggers and
// alt text is a pushed field). A product with no usable photo, or with any
// URL that does not answer 2xx, FAILS LOUDLY before any Shopify write — an
// imageless product never ships.
//
// buildMediaPlan is pure (unit-tested); preflightPhotoUrls and attachMedia do
// the I/O. productCreateMedia is asynchronous on Shopify's side, so
// attachMedia polls the read-back until every file is READY (or fails loudly
// on FAILED) — "created" alone does not prove the image landed.

// → [{ originalSource, alt, mediaContentType: "IMAGE" }] — hero first, then
// gallery angles, de-duplicated. Throws when the record has no photoUrl.
export function buildMediaPlan(product, cleanTitle) {
  const urls = [];
  const push = (u) => {
    if (typeof u === "string" && u.trim() !== "" && !urls.includes(u)) urls.push(u);
  };
  push(product?.photoUrl);
  for (const u of Array.isArray(product?.gallery) ? product.gallery : []) push(u);
  if (urls.length === 0) {
    throw new Error("product has no photoUrl — an imageless product is never pushed");
  }
  for (const u of urls) {
    if (!/^https:\/\//.test(u)) {
      throw new Error(`photo URL is not public HTTPS: ${u.slice(0, 80)}`);
    }
  }
  const alt = String(cleanTitle ?? "").trim();
  if (!alt) throw new Error("media alt text requires the cleaned title");
  return urls.map((originalSource) => ({ originalSource, alt, mediaContentType: "IMAGE" }));
}

// Every URL must answer 2xx BEFORE the product is created — a 404 photo must
// fail the push, not produce an imageless draft. HEAD first; some CDNs
// mishandle HEAD, so a failing HEAD gets one ranged-GET confirmation.
export async function preflightPhotoUrls(urls) {
  const failures = [];
  for (const url of urls) {
    let ok = false;
    try {
      const head = await fetch(url, { method: "HEAD" });
      ok = head.ok;
      if (!ok) {
        const get = await fetch(url, { headers: { Range: "bytes=0-0" } });
        ok = get.ok;
        if (get.body) await get.body.cancel();
      }
    } catch (e) {
      failures.push(`${url.slice(0, 100)} — ${String(e?.message || e)}`);
      continue;
    }
    if (!ok) failures.push(url.slice(0, 100));
  }
  if (failures.length) {
    throw new Error(`photo preflight failed (${failures.length}):\n  ${failures.join("\n  ")}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach media to an existing product and wait for READY. graphql = the
// throttling client from client.mjs. Throws on userErrors, on any FAILED
// file, and on a poll timeout — the caller reports the product as incomplete.
export async function attachMedia(graphql, shopifyProductId, mediaPlan) {
  const created = await graphql(
    `mutation ($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id }
        mediaUserErrors { field message }
      }
    }`,
    { productId: shopifyProductId, media: mediaPlan },
    { mutation: true }
  );
  const errs = created.productCreateMedia.mediaUserErrors;
  if (errs?.length) {
    throw new Error(`productCreateMedia userErrors: ${JSON.stringify(errs)}`);
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    const back = await graphql(
      `query ($id: ID!) {
        product(id: $id) {
          media(first: 50) { nodes { id status: fileStatus alt } }
        }
      }`,
      { id: shopifyProductId }
    );
    const nodes = back.product?.media?.nodes ?? [];
    const failed = nodes.filter((n) => n.status === "FAILED");
    if (failed.length) {
      throw new Error(
        `media processing FAILED for ${failed.length} file(s) on ${shopifyProductId} — ` +
          `the product must not ship imageless; fix the photo and re-run.`
      );
    }
    const ready = nodes.filter((n) => n.status === "READY").length;
    if (nodes.length >= mediaPlan.length && ready >= mediaPlan.length) {
      return { count: ready };
    }
    await sleep(2000);
  }
  throw new Error(`media on ${shopifyProductId} not READY after polling — verify in admin before re-running`);
}

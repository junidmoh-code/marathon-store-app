// ─── STYLE CODE RESOLUTION — THE THREE-TIER PROVIDER CHAIN ───────────────────
// One function signature — resolveStyleCode(code) — backed by an ordered list of
// interchangeable providers. Callers never learn which tier answered, so a tier
// can be added, reordered or swapped without touching a single call site.
//
//   TIER 1  cache        /sneaker_models/{NORMALISED}      free, instant, permanent
//   TIER 2  kicksdb      KicksDB unified catalog API       costs a request
//   TIER 3  web-search   STUB — always not-found (future)  reserved
//
// THE PROVIDER CONTRACT
//   { name, tier, resolve(ctx) -> Promise<model|null> }
//   ctx = { normalised, raw, candidates }
//   • return a model object  → resolution stops here, this is the answer
//   • return null            → this tier has nothing, try the next
//   • throw                  → this tier is BROKEN (network/auth/quota). The
//                              chain records the error and still tries the next
//                              tier, so one dead vendor cannot take intake down.
// A thrown error and a null are deliberately different: "we could not ask" must
// never be reported to staff as "this shoe does not exist".
//
// ── THE ANTI-COLLAPSE GUARD ──────────────────────────────────────────────────
// External catalogs do fuzzy matching. Ask for CT8527-016 and a catalog may
// happily hand back CT8527-700 — same silhouette, different colorway, WRONG
// SHOE. verifyStyleCodeMatch() is the hard fence: a vendor record is accepted
// only if its own SKU normalises to the byte-identical key we asked for. No
// prefix match, no similarity score, no "close enough". This is the single most
// important line in the file.

"use strict";

const {
  normaliseStyleCode,
  styleCodeQueryCandidates,
  formatStyleCodeForDisplay,
} = require("./style-code.cjs");

// ── THE /sneaker_models WRITE CONTRACT (enforced by the LIVE RTDB rules) ──────
// The rules validate this node strictly. A field name or an enum value that does
// not match is REJECTED at write time and surfaces in the UI as a silent no-op,
// so these constants are the contract, not a preference:
//   required   styleCode, source, fetchedAt (number)
//   source     one of SOURCE_VALUES below — NOT the vendor's brand name
//   imageUrl   must begin with https://
//   create-once; only an admin may correct an existing row.
// `source` is the KIND of resolution, not who did it. KicksDB is an external
// catalog API, so it writes "api" — writing "kicksdb" fails validation.
const SOURCE_API = "api";
const SOURCE_WEBSEARCH = "websearch";
const SOURCE_MANUAL = "manual";
const SOURCE_VALUES = [SOURCE_API, SOURCE_WEBSEARCH, SOURCE_MANUAL];

// imageUrl must be https:// or the write is rejected. A vendor that hands back
// a protocol-relative or http:// URL loses its image rather than taking the
// whole cache write down with it — a model without a photo is still useful.
function httpsImageOrNull(url) {
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The cached model shape (also the /sneaker_models/{NORMALISED} record).
// ─────────────────────────────────────────────────────────────────────────────
// `raw` is stored as a JSON STRING, never as an object. Vendor payloads carry
// price maps keyed by size ("10.5") and other free-text keys; a "." in an RTDB
// key is ILLEGAL and throws at write time, taking the whole resolve down. We
// have been burned by exactly this before (an ISO timestamp used as a key
// crashed the refill scan intermittently). A string cannot contain an illegal
// key, so the hazard is designed out rather than validated around.
const RAW_MAX_CHARS = 20000; // audit blob, not a mirror — keeps one record small

function packRaw(value) {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== "string") return null;
    return s.length > RAW_MAX_CHARS ? s.slice(0, RAW_MAX_CHARS) : s;
  } catch {
    return null; // circular / unserialisable — the model is still valid without it
  }
}

// RTDB drops undefined and rejects it inside objects; every field is written
// explicitly as a value or null so a record's shape never varies by provider.
function buildModel({ styleCode, brand, model, name, colorwayName, productType, imageUrl, gtin, source, fetchedAt, raw }) {
  return {
    styleCode: styleCode || "",
    brand: brand || null,
    model: model || null,
    // The vendor's own FULL display name ("Jordan 4 Retro Red Thunder"). This is
    // what the confirm screen shows, because on the StockX route `model` already
    // contains the brand — composing "brand + model" reads "Jordan Jordan 4
    // Retro". Null on cached rows from the old unified endpoint, which had no
    // equivalent field; readers fall back to the composed form.
    name: name || null,
    colorwayName: colorwayName || null,
    productType: productType || null,
    imageUrl: httpsImageOrNull(imageUrl),
    // Variant GTIN/EAN when the catalog returns one. Sneakers arrive without
    // boxes so we cannot scan it today, but a box-barcode lane later is free if
    // we keep the number now, and worthless if we throw it away.
    gtin: typeof gtin === "string" && gtin.trim() ? gtin.trim() : null,
    source: SOURCE_VALUES.includes(source) ? source : null,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    raw: typeof raw === "string" ? raw : packRaw(raw),
  };
}

/**
 * THE ANTI-COLLAPSE GUARD. True only when the vendor's own SKU normalises to
 * the exact key we asked for. Anything else — including a code that merely
 * shares the first six characters — is a different product and is rejected.
 */
function verifyStyleCodeMatch(vendorSku, normalised) {
  const got = normaliseStyleCode(vendorSku);
  return !!got && !!normalised && got === normalised;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1 — the permanent cache. Resolve a code once, never pay for it again.
// ─────────────────────────────────────────────────────────────────────────────
const SNEAKER_MODELS_PATH = "sneaker_models";

function makeCacheProvider(db) {
  return {
    name: "cache",
    tier: 1,
    async resolve({ normalised }) {
      const snap = await db.ref(`${SNEAKER_MODELS_PATH}/${normalised}`).get();
      const val = snap && snap.val();
      if (!val) return null;
      // A cached record still has to pass the guard: a bad historical write must
      // not be trusted forever just because it is ours.
      if (!verifyStyleCodeMatch(val.styleCode, normalised)) return null;
      return val;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 — KicksDB StockX catalog.
// ─────────────────────────────────────────────────────────────────────────────
// GET https://api.kicks.dev/v3/stockx/products?sku={code}
//   Authorization: Bearer <KICKSDB_API_KEY>
//   → { data: [ { sku, title, brand, model, image, gallery[], product_type,
//                 category, secondary_category, slug, ... }, ... ] }
//
// ── WHY NOT THE UNIFIED ENDPOINT ─────────────────────────────────────────────
// /v3/unified/products/{id} is what this originally called, and it returns
//   403 "This route requires a subscription"
// on our plan — every code, every time, which left staff unable to add products
// at all. Smoke-tested against the live vendor: the StockX route answers on the
// SAME key and resolved Jordan, adidas and Puma codes cleanly, so the "free tier
// is thin outside Jordan/Dunk" worry was unfounded. The key was never the
// problem; the route was.
//
// THE SHAPES DIFFER, and the differences are the interesting part:
//   • the code is a QUERY param (?sku=), not a path segment
//   • `title` carries the full name ("Jordan 4 Retro Red Thunder"); `model` is
//     the silhouette only ("Jordan 4 Retro") and ALREADY INCLUDES THE BRAND —
//     so "brand + model" would read "Jordan Jordan 4 Retro"
//   • there is NO metadata.colorway; the colourway lives inside `title`
//   • `image` is a single URL, pre-sized to a 140x100 THUMBNAIL
//   • no barcode/ean/upc on this route, so gtin is always null
//
// Catalogs store the SKU the way the brand prints it and staff type it both
// ways, so we still ask with each spelling of THE SAME code in turn
// (styleCodeQueryCandidates) and stop at the first EXACT normalised SKU match.
//
// The API key NEVER reaches the client. It is a Firebase secret read inside the
// Cloud Function; the browser only ever calls the callable.
const KICKSDB_BASE_URL = "https://api.kicks.dev";
const KICKSDB_TIMEOUT_MS = 12000;

function pickKicksDbRecord(payload, normalised) {
  const rows = payload && Array.isArray(payload.data) ? payload.data
    : payload && payload.data && typeof payload.data === "object" ? [payload.data]
    : [];
  // EXACT normalised-SKU matches only (the anti-collapse guard), then prefer the
  // one that actually carries an image — a record with no photo is close to
  // useless on the confirm screen.
  const exact = rows.filter((r) => r && verifyStyleCodeMatch(r.sku, normalised));
  if (!exact.length) return null;
  return exact.find((r) => firstImage(r)) || exact[0];
}

// StockX serves `image` pre-sized to a 140x100 THUMBNAIL via imgix-style query
// params. That is far too small for the confirm screen, whose entire job is to
// show the shoe big enough that a human can catch a wrong match. The size is in
// the URL, so we ask for a larger render — and if the URL is not the shape we
// expect, we hand back exactly what we were given rather than corrupting it.
const IMAGE_TARGET_PX = 1000;

function upscaleVendorImage(url) {
  if (typeof url !== "string") return url;
  try {
    const u = new URL(url);
    // Only touch URLs that already declare a size. Adding w/h to an arbitrary
    // image host could break it.
    if (!u.searchParams.has("w") && !u.searchParams.has("h")) return url;
    if (u.searchParams.has("w")) u.searchParams.set("w", String(IMAGE_TARGET_PX));
    if (u.searchParams.has("h")) u.searchParams.set("h", String(IMAGE_TARGET_PX));
    return u.toString();
  } catch {
    return url; // unparseable — the original is still a valid image URL
  }
}

// The colourway, which this route does not hand us as a field. `title` is the
// full name and `model` is its prefix, so the remainder IS the colourway:
//   "Jordan 4 Retro Red Thunder" minus "Jordan 4 Retro" = "Red Thunder"
// Returns null rather than a guess when the title does not start with the model.
function colorwayFromTitle(title, model) {
  if (typeof title !== "string" || typeof model !== "string") return null;
  const t = title.trim(), m = model.trim();
  if (!t || !m) return null;
  if (!t.toLowerCase().startsWith(m.toLowerCase())) return null;
  return t.slice(m.length).trim() || null;
}

function firstImage(rec) {
  if (!rec) return null;
  const direct = httpsImageOrNull(rec.image);
  if (direct) return upscaleVendorImage(direct);
  // `gallery` is the StockX field; `images` was the unified one. Accept both so
  // a cached row from either era still resolves an image.
  for (const list of [rec.gallery, rec.images]) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((u) => httpsImageOrNull(u));
    if (hit) return upscaleVendorImage(hit);
  }
  return null;
}

// The variant barcode, wherever this vendor happens to put it.
function firstGtin(rec) {
  if (!rec) return null;
  for (const v of [rec.gtin, rec.ean, rec.upc]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (Array.isArray(rec.barcodes)) {
    const hit = rec.barcodes.find((b) => typeof b === "string" && b.trim());
    if (hit) return hit.trim();
  }
  return null;
}

// ── GOAT, the second free route ──────────────────────────────────────────────
// Same key, different catalogue, and it fills gaps StockX has. Its shape differs
// again, and mostly for the better: `nickname` is the colourway as a clean
// field, so nothing has to be derived from a title.
//
// ONE HAZARD, and it is the big one: this route is a fuzzy ?query= search that
// returns 20 rows. Ask for CT8527-016 and the results include CT8527 700,
// CT8527 400 and CT8527 100 — the SIBLING COLOURWAYS, the exact wrong-shoe
// failure this feature exists to prevent. verifyStyleCodeMatch is what makes
// the route safe to use at all. It also writes SKUs space-separated
// ("CT8527 016"), which normalises to the same key as the hyphenated form.
function goatToModel(rec, normalised, nowMs) {
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : null;
  return buildModel({
    styleCode: typeof rec.sku === "string" && rec.sku ? rec.sku : formatStyleCodeForDisplay(normalised),
    brand: rec.brand,
    model: rec.model || name,
    name,
    // A real field here, unlike StockX where it has to come out of the title.
    colorwayName: rec.nickname || rec.colorway || null,
    productType: rec.product_type || null,
    imageUrl: firstImage({ image: rec.image_url, gallery: rec.images }),
    gtin: firstGtin(rec),
    source: SOURCE_API,
    fetchedAt: nowMs,
    raw: packRaw(rec),
  });
}

// The routes this plan can actually call, in preference order. StockX first: it
// answers by exact ?sku= rather than a fuzzy search, so it is both cheaper and
// less likely to need the guard. GOAT is the fallback for what StockX lacks.
//
// NOT AVAILABLE on our plan — both return 403 "This route requires a
// subscription", verified against the live API:
//   /v3/unified/products/{id}     (what this adapter originally called)
//   /v3/shopify/products
const KICKSDB_ROUTES = [
  { name: "stockx", path: (c) => `/v3/stockx/products?sku=${encodeURIComponent(c)}`, toModel: kicksDbToModel },
  { name: "goat", path: (c) => `/v3/goat/products?query=${encodeURIComponent(c)}`, toModel: goatToModel },
];

function kicksDbToModel(rec, normalised, nowMs) {
  const meta = (rec && rec.metadata) || {};
  const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : null;
  const model = rec.model || rec.name || title;
  return buildModel({
    // The vendor's own spelling of the SKU is the display form we keep; the
    // NORMALISED code stays the key and is never overwritten by vendor text.
    styleCode: typeof rec.sku === "string" && rec.sku ? rec.sku : formatStyleCodeForDisplay(normalised),
    brand: rec.brand,
    model,
    name: title,
    // No metadata.colorway on this route — derive it from the title instead.
    colorwayName: meta.colorway || rec.colorway || colorwayFromTitle(title, model),
    // Reported by the vendor, INFORMATIONAL ONLY. Category is set from the
    // intake entry point, never inferred from a code or a vendor string —
    // Nike apparel uses the same style-code format as Nike footwear.
    productType: rec.product_type || rec.productType || null,
    imageUrl: firstImage(rec),
    gtin: firstGtin(rec),
    // The RULES enum, not the vendor's name: "api" is the KIND of resolution.
    // Which vendor answered is recorded on the resolve response and in the
    // miss log, not smuggled into a validated enum field.
    source: SOURCE_API,
    fetchedAt: nowMs,
    raw: packRaw(rec),
  });
}

/**
 * @param {object} opts
 *   apiKey     — read from the KICKSDB_API_KEY Firebase secret by the caller
 *   fetchImpl  — injectable for tests (defaults to global fetch)
 *   baseUrl    — injectable for tests
 *   nowMs      — injectable clock
 */
function makeKicksDbProvider({ apiKey, fetchImpl, baseUrl, nowMs } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const root = baseUrl || KICKSDB_BASE_URL;
  return {
    name: "kicksdb",
    tier: 2,
    async resolve({ normalised, candidates }) {
      if (!apiKey) {
        // No secret bound → the tier is unavailable, which is NOT "not found".
        throw new Error("KICKSDB_API_KEY is not configured");
      }
      let lastError = null;
      // Every spelling against every route we can call. Ordered so the exact-SKU
      // route is exhausted before the fuzzy one.
      const attempts = [];
      for (const route of KICKSDB_ROUTES) for (const c of candidates) attempts.push({ route, candidate: c });
      for (const { route, candidate } of attempts) {
        const url = `${root}${route.path(candidate)}`;
        let res;
        try {
          res = await doFetch(url, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
            signal: AbortSignal.timeout(KICKSDB_TIMEOUT_MS),
          });
        } catch (err) {
          lastError = new Error(`kicksdb request failed: ${(err && err.message) || err}`);
          continue; // transport blip on one spelling — try the next spelling
        }
        // 404 = this spelling is unknown to the catalog. Not an error; keep going.
        if (res.status === 404) continue;
        if (!res.ok) {
          // 401/403/429/5xx are BROKEN-tier signals, not "no such shoe".
          lastError = new Error(`kicksdb HTTP ${res.status}`);
          continue;
        }
        let payload;
        try {
          payload = await res.json();
        } catch (err) {
          lastError = new Error(`kicksdb returned unparseable JSON: ${(err && err.message) || err}`);
          continue;
        }
        const rec = pickKicksDbRecord(payload, normalised);
        if (rec) return route.toModel(rec, normalised, Number.isFinite(nowMs) ? nowMs : Date.now());
        // Responded fine but held no EXACT match — a genuine miss for this
        // spelling (or a fuzzy near-match we correctly refused). Try the next.
      }
      // Every spelling was asked. If the only reason we have nothing is that the
      // tier kept failing, say so — do not report a broken vendor as "no match".
      if (lastError) throw lastError;
      return null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3 — web-search fallback. STUB.
// ─────────────────────────────────────────────────────────────────────────────
// Reserved for a future "search the open web for this style code" resolver. It
// exists NOW, wired and ordered, so adding that capability later is a change to
// this one function and nothing else — no caller, no orchestrator, no UI moves.
// Today it always reports not-found, which is the honest answer.
function makeWebSearchProvider() {
  return {
    name: "web-search",
    tier: 3,
    async resolve() {
      return null; // not implemented yet — deliberately not an error
    },
  };
}

/**
 * Walk the chain in order and return the first model any tier produces.
 *
 * A tier that THROWS is recorded and skipped, never fatal — a dead vendor must
 * not take sneaker intake offline while the cache and the other tiers still work.
 *
 * @returns {{ model: object|null, provider: string|null, tier: number|null,
 *             fromCache: boolean, errors: Array<{provider:string,message:string}> }}
 */
async function resolveThroughProviders(providers, ctx) {
  const errors = [];
  for (const provider of providers) {
    let model = null;
    try {
      model = await provider.resolve(ctx);
    } catch (err) {
      errors.push({ provider: provider.name, message: (err && err.message) || String(err) });
      continue;
    }
    if (model) {
      return { model, provider: provider.name, tier: provider.tier, fromCache: provider.tier === 1, errors };
    }
  }
  return { model: null, provider: null, tier: null, fromCache: false, errors };
}

/** Build the standard chain. Order IS the tier order. */
function defaultProviders({ db, apiKey, fetchImpl, baseUrl, nowMs } = {}) {
  return [
    makeCacheProvider(db),
    makeKicksDbProvider({ apiKey, fetchImpl, baseUrl, nowMs }),
    makeWebSearchProvider(),
  ];
}

module.exports = {
  SNEAKER_MODELS_PATH,
  RAW_MAX_CHARS,
  SOURCE_API,
  SOURCE_WEBSEARCH,
  SOURCE_MANUAL,
  SOURCE_VALUES,
  httpsImageOrNull,
  upscaleVendorImage,
  colorwayFromTitle,
  IMAGE_TARGET_PX,
  packRaw,
  buildModel,
  verifyStyleCodeMatch,
  firstImage,
  firstGtin,
  pickKicksDbRecord,
  kicksDbToModel,
  goatToModel,
  KICKSDB_ROUTES,
  makeCacheProvider,
  makeKicksDbProvider,
  makeWebSearchProvider,
  resolveThroughProviders,
  defaultProviders,
  // re-exported so callers need one require for the whole resolution surface
  normaliseStyleCode,
  styleCodeQueryCandidates,
};

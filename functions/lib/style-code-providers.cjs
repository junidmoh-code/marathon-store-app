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
function buildModel({ styleCode, brand, model, colorwayName, productType, imageUrl, gtin, source, fetchedAt, raw }) {
  return {
    styleCode: styleCode || "",
    brand: brand || null,
    model: model || null,
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
// TIER 2 — KicksDB unified catalog.
// ─────────────────────────────────────────────────────────────────────────────
// GET https://api.kicks.dev/v3/unified/products/{identifier}
//   Authorization: Bearer <KICKSDB_API_KEY>
//   → { data: [ { name, brand, model, images[], sku, product_type,
//                 metadata: { colorway, ... } }, ... ] }
// The identifier may be a SKU, a product id or a slug. Catalogs store the SKU
// the way the brand prints it, and staff type it both ways, so we ask with each
// spelling of THE SAME code in turn (styleCodeQueryCandidates) and stop at the
// first response containing an EXACT normalised SKU match.
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

function firstImage(rec) {
  if (!rec) return null;
  const https = httpsImageOrNull(rec.image);
  if (https) return https;
  if (Array.isArray(rec.images)) {
    const hit = rec.images.find((u) => httpsImageOrNull(u));
    if (hit) return hit;
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

function kicksDbToModel(rec, normalised, nowMs) {
  const meta = (rec && rec.metadata) || {};
  return buildModel({
    // The vendor's own spelling of the SKU is the display form we keep; the
    // NORMALISED code stays the key and is never overwritten by vendor text.
    styleCode: typeof rec.sku === "string" && rec.sku ? rec.sku : formatStyleCodeForDisplay(normalised),
    brand: rec.brand,
    model: rec.model || rec.name || rec.title,
    colorwayName: meta.colorway || rec.colorway || null,
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
      for (const candidate of candidates) {
        const url = `${root}/v3/unified/products/${encodeURIComponent(candidate)}`;
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
        if (rec) return kicksDbToModel(rec, normalised, Number.isFinite(nowMs) ? nowMs : Date.now());
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
  packRaw,
  buildModel,
  verifyStyleCodeMatch,
  firstImage,
  firstGtin,
  pickKicksDbRecord,
  kicksDbToModel,
  makeCacheProvider,
  makeKicksDbProvider,
  makeWebSearchProvider,
  resolveThroughProviders,
  defaultProviders,
  // re-exported so callers need one require for the whole resolution surface
  normaliseStyleCode,
  styleCodeQueryCandidates,
};

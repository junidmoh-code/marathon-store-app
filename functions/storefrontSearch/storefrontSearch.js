// ─── storefrontSearch — the public, read-only search endpoint ────────────────
// The storefront's search box calls THIS, not Shopify's. It has to, because
// every brand, sub-label and silhouette term is stripped before a product is
// pushed: the words a shopper types are exactly the words the Shopify catalogue
// does not contain. Searching "gripshot" or "samba" on the shop returns
// nothing. This matches on the app's TRUE data and answers with the Shopify
// handle — the brand is used to FIND the product and never travels back out.
//
//   GET  /?q=samba&limit=12        →  { results: [ … ] }
//
// ── ASSUME EVERY RESPONSE IS PUBLIC ──────────────────────────────────────────
// It is: no auth, any origin on the allow-list, and the storefront calls it
// from the browser. The response is built by `publicResult`, an ALLOW-LIST that
// constructs each field by name — never a stored document with fields deleted
// from it, because a delete-list silently leaks whatever gets added later.
// Never leaves here: the TRUE brand-carrying name, stockPrice, cost, supplier,
// SKU, barcode, the internal product id, or any per-location quantity.
//
// The query is NOT echoed back. The results page must not print the search term
// on screen (owner spec), and the cheapest way to guarantee that is to give the
// page nothing to print.
//
// ── COST IS A DESIGN CONSTRAINT ──────────────────────────────────────────────
// This project has had a Firebase bandwidth spike from unbounded reads, so:
//
//   • The index is loaded into INSTANCE MEMORY and reused. A warm instance
//     serving a query does ZERO RTDB reads.
//   • Freshness is a tiny `meta/version` read, at most once per
//     META_TTL_MS (60s) per instance — a handful of bytes, not the corpus.
//     The documents are re-read only when that version actually changed.
//   • A cold start reads the documents once: ~130 documents at ~300 bytes is
//     ~40 KB. That is the whole per-instance cost.
//   • Responses carry Cache-Control, so a repeated query from the same shopper
//     never reaches the function at all.
//   • Per-IP rate limiting, a hard result cap, and a query-length cap bound
//     what a single caller can do.
//
// ── DEPLOY (scoped, by name — NEVER a bare deploy) ───────────────────────────
//   firebase deploy --only functions:storefrontSearch
"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { searchContext, search, publicResult } = require("../lib/storefront-search.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const INDEX_PATH = "search_index";

// The storefront and its preview themes. A shop's preview runs on the same
// origin, so one entry covers the live theme and every duplicate of it.
const ALLOWED_ORIGINS = new Set([
  "https://marathonclub.co.za",
  "https://www.marathonclub.co.za",
  "https://nu3ei8-0p.myshopify.com",
]);

const MAX_QUERY_CHARS = 64;   // longer is not a shopper, it is a probe
const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;
const MIN_QUERY_CHARS = 2;    // a single letter matches most of the catalogue
const META_TTL_MS = 60_000;
const CACHE_SECONDS = 60;

// ── Rate limit ───────────────────────────────────────────────────────────────
// A token bucket per client IP, held in instance memory. This is deliberately
// NOT a distributed limiter: a shared one would need a store, and a read per
// request is exactly the cost this endpoint exists to avoid. Per-instance is
// enough for what it defends against — one script hammering one warm instance —
// and the real backstop is that a query costs no reads anyway, so the worst a
// flood buys is CPU, which Cloud Run's own concurrency and max-instance caps
// already bound.
const RATE_CAPACITY = 30;         // burst
const RATE_REFILL_PER_SEC = 1;    // sustained
const buckets = new Map();
const MAX_BUCKETS = 5000;         // the limiter must not become the leak

function rateLimited(ip, now) {
  let b = buckets.get(ip);
  if (!b) {
    // Bounded map. When full, drop the oldest half rather than growing without
    // limit — a limiter that leaks memory is worse than no limiter.
    if (buckets.size >= MAX_BUCKETS) {
      let n = 0;
      for (const k of buckets.keys()) { buckets.delete(k); if (++n >= MAX_BUCKETS / 2) break; }
    }
    b = { tokens: RATE_CAPACITY, at: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.at) / 1000) * RATE_REFILL_PER_SEC);
  b.at = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

// ── The in-memory index ──────────────────────────────────────────────────────
let cache = { version: null, docs: [], checkedAt: 0 };

async function loadIndex(now) {
  if (cache.version !== null && now - cache.checkedAt < META_TTL_MS) return cache.docs;
  const db = admin.database();
  const meta = (await db.ref(`${INDEX_PATH}/meta`).get()).val();
  cache.checkedAt = now;
  const version = meta?.version ?? null;
  if (version !== null && version === cache.version) return cache.docs; // unchanged
  const raw = (await db.ref(`${INDEX_PATH}/docs`).get()).val() || {};
  // The search contexts are computed ONCE here, not per query. The pid is the
  // KEY, and it is deliberately not copied onto the document — nothing that
  // reaches publicResult should be able to carry it.
  cache.docs = Object.values(raw).map((d) => ({
    ...d,
    ctx: {
      name: searchContext(d.name),
      title: searchContext(d.title),
      colour: searchContext(d.colour),
      category: searchContext(d.category),
      extras: searchContext(d.extras),
      aliases: searchContext(d.aliases),
    },
  }));
  cache.version = version;
  console.log(`[storefrontSearch] index loaded: ${cache.docs.length} docs, version ${version}`);
  return cache.docs;
}

exports.storefrontSearch = onRequest(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 20,
    // The index is small and identical for everyone, so one warm instance
    // serves a lot. maxInstances caps what a flood can cost.
    maxInstances: 5,
    concurrency: 40,
  },
  async (req, res) => {
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    }
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }
    // READ-ONLY. Anything that is not a GET is refused before it can be
    // mistaken for a way in.
    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

    const now = Date.now();
    const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "unknown";
    if (rateLimited(ip, now)) {
      res.set("Retry-After", "5");
      return res.status(429).json({ error: "too many requests" });
    }

    const q = String(req.query.q ?? "").slice(0, MAX_QUERY_CHARS);
    // A short query would match most of the catalogue and is almost always a
    // shopper mid-keystroke; answering it costs the same as a real search and
    // teaches the page nothing. Empty results, cheaply.
    if (q.trim().length < MIN_QUERY_CHARS) {
      res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      return res.json({ results: [] });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
      : DEFAULT_LIMIT;

    let docs;
    try {
      docs = await loadIndex(now);
    } catch (e) {
      console.error("[storefrontSearch] index read failed:", e?.message || e);
      // Never leak an internal error message to a public caller.
      return res.status(503).json({ error: "search is unavailable" });
    }

    const hits = search(docs, q, { limit });
    // Cache-Control is the cheapest tier of all: the same query from the same
    // shopper never reaches this function again inside the window.
    res.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    // The query is deliberately NOT echoed. The results page must not print the
    // term back on screen, and the surest way is to hand it nothing to print.
    return res.json({ results: hits.map(publicResult) });
  }
);

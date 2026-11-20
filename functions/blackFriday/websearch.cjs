// ─── BLACK FRIDAY 2026 — "FIND ONLINE": photos of THIS product on the web ────
// Junid, 20 Nov 2026: on his tap only, search the web for the exact product
// (name + brand + colour, and its style code when it has one) and show up to 6
// candidate photos with the site each came from. NOTHING is used until he taps
// one; that one is then fetched again, stored in the app's own Storage at full
// resolution and becomes the product's source photo on the card.
//
// THE SEARCH: Gemini with Grounding with Google Search (the GEMINI_API_KEY the
// generator already uses — no new account, no new key). Gemini only finds the
// product PAGES (official store / big retailers); the photos are the pages'
// own declared product images (og:image, twitter:image, JSON-LD Product
// image), never an address the model wrote. Cost: Google's per-search grounding
// price (≈ US$0.014 per search query, a tap runs a few) plus a few hundred tokens.
// Google requires the "Google Search" suggestions it returns to be shown with
// grounded results: the card shows them (searchEntryPoint) under the photos.
//
// SAFETY: only https, only public addresses (no private, loopback, link-local
// or metadata hosts — the name is resolved and checked before every fetch and
// on every redirect), a size
// ceiling and a timeout on every fetch, images only.
"use strict";

const dns = require("node:dns");
const net = require("node:net");

const SEARCH_MODEL = "gemini-3.7-flash";
const MAX_CANDIDATES = 6;
const MAX_PAGES = 8;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MIN_SIDE = 300;          // a thumbnail or an icon is not a product photo
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// ── what to search for ───────────────────────────────────────────────────────
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
/** The words that name the product: brand, name, colour, style code — each once. Pure. */
function queryOf(p) {
  const name = clean(p && p.name);
  const brand = clean(p && p.brand);
  const colour = clean((p && (p.labelColorway || p.colour || p.color || p.colorwayName)) || "");
  const code = clean(p && p.styleCode);
  const lower = name.toLowerCase();
  const parts = [];
  if (brand && !lower.includes(brand.toLowerCase())) parts.push(brand);
  if (name) parts.push(name);
  if (colour && !lower.includes(colour.toLowerCase())) parts.push(colour);
  if (code && !lower.includes(code.toLowerCase())) parts.push(code);
  return parts.join(" ").slice(0, 200);
}
/** The instruction Gemini searches with. Pure. */
function searchPrompt(query) {
  return [
    `Find web pages that show this EXACT product with clear product photos: ${query}.`,
    "Prefer the brand's official store and large retailers' product pages for this exact item and colour, from at least 8 DIFFERENT websites (South African shops welcome).",
    "Never a different colour, model or a lookalike. List every page you found.",
  ].join(" ");
}

// ── public addresses only ────────────────────────────────────────────────────
/** An IPv6 address as 8 numbers (any spelling: "::", embedded dotted IPv4, hex), or null. Pure. */
function v6Groups(ip) {
  let x = String(ip).toLowerCase().split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (dotted) {
    const b = dotted[1].split(".").map(Number);
    if (b.some((n) => n > 255)) return null;
    x = x.slice(0, -dotted[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = x.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const g = [...head, ...Array(fill).fill("0"), ...tail].map((h) => parseInt(h, 16));
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
/** Is this IP address a private, loopback, link-local, CGNAT, multicast or reserved one — in ANY spelling? Pure. */
function isPrivateIp(ip) {
  const v = net.isIP(String(ip).split("%")[0]);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const g = v6Groups(ip);
    if (!g) return true;
    // An IPv4 address inside IPv6 (::a.b.c.d, ::ffff:a.b.c.d in any spelling, 6to4 2002::/16, NAT64 64:ff9b::/96): judged as that IPv4.
    if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0 || g[5] === 0xffff)) return g[6] === 0 && g[7] <= 1 && g[5] === 0 ? true : isPrivateIp(v4Of(g[6], g[7]));
    if (g[0] === 0x2002) return isPrivateIp(v4Of(g[1], g[2]));
    if (g[0] === 0x64 && g[1] === 0xff9b) return true;
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true; // unique-local, link-local, multicast
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
    return false;
  }
  return true;
}
const BLOCKED_HOSTS = /(^|\.)(localhost|internal|local|metadata\.google\.internal|goog)$/i;
/** Refuse anything but https to a public host name. Pure. → URL */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error("not a web address"); }
  if (u.protocol !== "https:") throw new Error("only https addresses are fetched");
  if (u.username || u.password) throw new Error("no credentials in addresses");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.test(host)) throw new Error("that host is not fetched");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("that address is not public");
  if (u.port && u.port !== "443") throw new Error("only the standard https port is fetched");
  return u;
}
/** Resolve the host and refuse it unless every address is public. */
async function checkHost(host, lookup = dns.promises.lookup) {
  const h = host.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new Error("that address is not public"); return; }
  const addrs = await lookup(h, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("that host is not public");
}

/**
 * Fetch a public https address: redirects followed by hand (each one checked), a timeout and a size
 * ceiling. deps: { fetchImpl, lookup }. → { buffer, type, url }
 */
async function safeFetch(raw, { maxBytes, timeoutMs = 8000, accept = "*/*", fetchImpl = fetch, lookup, redirects = 3 } = {}) {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= redirects; hop++) {
    await checkHost(url.hostname, lookup);
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect ${res.status} with nowhere to go`);
      url = checkUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    if (Number(res.headers.get("content-length")) > maxBytes) throw new Error("too large");
    const chunks = [];
    let n = 0;
    for await (const c of res.body) {
      n += c.length;
      if (n > maxBytes) throw new Error("too large");
      chunks.push(Buffer.from(c));
    }
    return { buffer: Buffer.concat(chunks), type: String(res.headers.get("content-type") || ""), url: url.toString() };
  }
  throw new Error("too many redirects");
}

// ── the pages' own product photos ────────────────────────────────────────────
const decode = (s) => String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/gi, "/").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The product photos a page declares (og:image, twitter:image, image_src, JSON-LD Product image), absolute https, best first. Pure. */
function imagesFromHtml(html, baseUrl) {
  const h = String(html || "");
  const out = [];
  const add = (u) => {
    if (!u || typeof u !== "string") return;
    try {
      const abs = new URL(decode(u.trim()), baseUrl);
      if (abs.protocol === "http:") abs.protocol = "https:";
      if (abs.protocol !== "https:") return;
      const s = abs.toString();
      if (!out.includes(s)) out.push(s);
    } catch { /* not an address */ }
  };
  const metas = h.match(/<meta\b[^>]*>/gi) || [];
  const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m ? (m[2] ?? m[3]) : null; };
  const want = ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"];
  for (const key of want) for (const tag of metas) if (String(attr(tag, "property") || attr(tag, "name") || "").toLowerCase() === key) add(attr(tag, "content"));
  for (const m of h.matchAll(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*>/gi)) add(attr(m[0], "href"));
  // JSON-LD: the Product's image(s).
  for (const m of h.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let j;
    try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (x, depth = 0) => {
      if (!x || depth > 6) return;
      if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
      if (typeof x !== "object") return;
      const t = [].concat(x["@type"] || []).map(String);
      if (t.includes("Product") || t.includes("ProductGroup")) {
        for (const im of [].concat(x.image || [])) add(typeof im === "string" ? im : im && (im.url || im.contentUrl));
      }
      if (x["@graph"]) walk(x["@graph"], depth + 1);
      if (x.hasVariant) walk(x.hasVariant, depth + 1);
    };
    walk(j);
  }
  return out.slice(0, 4);
}
/** The site's short name for the card ("nike.com"). Pure. */
function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ── Gemini with Google Search ────────────────────────────────────────────────
/** The pages Gemini's search grounded on: [{ uri, title }], and the search suggestions to show. */
async function groundedPages(query, { apiKey, fetchImpl = fetch, model = SEARCH_MODEL, timeoutMs = 60_000 } = {}) {
  if (!apiKey) throw new Error("no Gemini key");
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: searchPrompt(query) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((body.error && body.error.message) || `search ${res.status}`); e.status = res.status; throw e; }
  const c = (body.candidates || [])[0] || {};
  const g = c.groundingMetadata || {};
  const pages = [];
  for (const ch of g.groundingChunks || []) {
    const w = ch && ch.web;
    if (w && w.uri && !pages.some((p) => p.uri === w.uri)) pages.push({ uri: w.uri, title: clean(w.title) });
  }
  return { pages, entryPoint: (g.searchEntryPoint && g.searchEntryPoint.renderedContent) || null, queries: g.webSearchQueries || [] };
}
/** A grounding link is a Google redirect: the real page address, without fetching the page. */
async function realPageUrl(uri, { fetchImpl = fetch } = {}) {
  const u = new URL(uri);
  if (u.hostname !== "vertexaisearch.cloud.google.com") return uri;
  const res = await fetchImpl(u, { redirect: "manual", signal: AbortSignal.timeout(8000) });
  const loc = res.headers.get("location");
  if (!loc) throw new Error("no page behind the search link");
  return new URL(loc, u).toString();
}

/** The same picture (16×16 greyscale, mean difference under 8)? Pure. */
function samePrint(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let t = 0;
  for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
  return t / a.length < 8;
}

/**
 * Up to 6 candidate photos of the product: [{ imageUrl, pageUrl, site, title, thumb, width, height }].
 * deps: { apiKey, fetchImpl, lookup, sharp }.
 */
async function findCandidates(product, deps = {}) {
  const sharp = deps.sharp || require("sharp");
  const query = queryOf(product);
  if (!query) throw new Error("the product has no name to search for");
  const g = await groundedPages(query, deps);
  const pages = (await Promise.all(g.pages.slice(0, MAX_PAGES).map(async (p) => {
    try { return { ...p, url: await realPageUrl(p.uri, deps) }; } catch { return null; }
  }))).filter(Boolean);
  const perPage = await Promise.all(pages.map(async (p) => {
    try {
      const page = await safeFetch(p.url, { maxBytes: PAGE_MAX_BYTES, accept: "text/html", fetchImpl: deps.fetchImpl, lookup: deps.lookup });
      return imagesFromHtml(page.buffer.toString("utf8"), page.url).map((imageUrl) => ({ imageUrl, pageUrl: page.url, site: siteOf(page.url) || p.title, title: p.title }));
    } catch { return []; }
  }));
  // One from each site first, then the rest, so six photos are not all from one shop.
  const order = [];
  for (let i = 0; i < 4; i++) for (const list of perPage) if (list[i]) order.push(list[i]);
  const seen = new Set();
  const out = [];
  // Fetched a few at a time; the same picture at another size is shown once (the larger one).
  const todo = order.filter((c) => (seen.has(c.imageUrl) ? false : (seen.add(c.imageUrl), true))).slice(0, MAX_CANDIDATES * 3);
  const got = await Promise.all(todo.map(async (c) => {
    try {
      const img = await safeFetch(c.imageUrl, { maxBytes: IMAGE_MAX_BYTES, accept: "image/*", fetchImpl: deps.fetchImpl, lookup: deps.lookup });
      const m = await sharp(img.buffer).metadata();
      if (!m.width || !m.height || Math.min(m.width, m.height) < MIN_SIDE) return null;
      const thumb = await sharp(img.buffer).rotate().resize(360, 360, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
      const print = await sharp(img.buffer).rotate().resize(16, 16, { fit: "fill" }).greyscale().raw().toBuffer();
      return { ...c, width: m.width, height: m.height, thumb: `data:image/jpeg;base64,${thumb.toString("base64")}`, print };
    } catch { return null; /* not a readable image: skipped */ }
  }));
  for (const c of got) {
    if (!c) continue;
    const twin = out.findIndex((o) => samePrint(o.print, c.print));
    if (twin >= 0) { if (c.width * c.height > out[twin].width * out[twin].height) out[twin] = c; continue; }
    if (out.length < MAX_CANDIDATES) out.push(c);
  }
  return { query, candidates: out.map(({ print, ...c }) => c), entryPoint: g.entryPoint, searched: g.queries }; // eslint-disable-line no-unused-vars
}

module.exports = { v6Groups, samePrint, SEARCH_MODEL, MAX_CANDIDATES, IMAGE_MAX_BYTES, queryOf, searchPrompt, isPrivateIp, checkUrl, checkHost, safeFetch, imagesFromHtml, siteOf, groundedPages, realPageUrl, findCandidates };

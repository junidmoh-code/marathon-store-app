// ─── BLACK FRIDAY 2026 — JUNID'S OWN PHOTO FOR A PRODUCT (20 Nov 2026) ───────
// bfPhotoSource, Junid only, ONLY on his tap:
//   upload  "Replace photo": a photo from his iPhone (gallery, Files, one saved
//           from the internet), stored at FULL resolution.
//   search  "Find online": up to 6 candidate photos of this exact product from
//           the web (websearch.cjs). Nothing is stored or used.
//   pick    the candidate he tapped: fetched again, stored at full resolution.
// An upload or a pick becomes the product's SOURCE photo on the card
// (photos/{pid}/srcId) and is kept in photos/{pid}/gens as { src: "upload" |
// "web", … }, so it is approved, pinned and posted exactly like a generated
// photo — through the same Approve / Reject / Undo. Generate then starts from
// it (generate.js). The app's own product photo is never touched: it stays on
// the card ("App photo") and comes back with "Use app photo". Nothing is ever
// deleted. An approved product keeps its approved photo until he picks the new one.
//
// Writes only /bf_campaign_2026/photos/{pid} and decisions; files go to
// products/{pid}/black_friday/src_*.  Deploy BY NAME: firebase deploy --only functions:bfPhotoSource
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const web = require("./websearch.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const KEEP_AS_IS = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const val = async (db, path) => (await db.ref(path).once("value")).val();

/**
 * The bytes to store: the photo exactly as given when it is a JPEG, PNG or WebP the right way up;
 * otherwise (another format, or turned by its EXIF orientation) the same pixels as a JPEG q95 — never
 * made smaller. → { buffer, mime, width, height }
 */
async function storable(buffer, sharp) {
  let m;
  try { m = await sharp(buffer).metadata(); } catch { throw new HttpsError("invalid-argument", "That file is not a photo the card can read — choose a JPEG or PNG."); }
  if (!m.width || !m.height) throw new HttpsError("invalid-argument", "That file is not a photo the card can read — choose a JPEG or PNG.");
  if (Math.min(m.width, m.height) < 200) throw new HttpsError("invalid-argument", "That photo is too small to use.");
  const turned = Number(m.orientation) > 1;
  if (KEEP_AS_IS[m.format] && !turned) return { buffer, mime: KEEP_AS_IS[m.format], width: m.width, height: m.height };
  const out = await sharp(buffer, { failOn: "none" }).rotate().jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const o = await sharp(out).metadata();
  return { buffer: out, mime: "image/jpeg", width: o.width, height: o.height };
}

/** The product must be one the card shows (in the build, or a New Arrival). */
async function assertOnCard(db, pid, deps) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Which product?");
  for (const s of core.SECTIONS) if (await val(db, `${core.ROOT}/items/${s}/${pid}`)) return;
  if (deps.naRow && await deps.naRow(pid).catch(() => null)) return;
  throw new HttpsError("not-found", "That product is not on the Black Friday card.");
}

/** Store his photo and make it the product's source on the card. → { ok, pid, id, url, kept } */
async function keep(db, pid, { buffer, entry }, uid, deps) {
  const sharp = deps.sharp || require("sharp");
  const now = deps.now || (() => Date.now());
  const at = now();
  const id = `g${at}`;
  const s = await storable(buffer, sharp);
  const stored = await deps.upload(`products/${pid}/black_friday/src_${at}.${EXT[s.mime]}`, s.buffer, s.mime);
  const full = { ...entry, url: stored.url, path: stored.path, at, by: uid || null, width: s.width, height: s.height, mime: s.mime, bytes: s.buffer.length };
  for (const [k, v] of Object.entries(full)) if (v === null || v === undefined || v === "") delete full[k];
  // An approved product keeps posting its approved photo until he picks this one.
  const [pick, photo] = await Promise.all([val(db, `${core.ROOT}/picks/${pid}`), val(db, `${core.ROOT}/photos/${pid}`)]);
  const keepChoice = !!pick && pick.state === "approved" && (pick.src === "na" || core.isApproved(pick, photo));
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  const out = {};
  const res = await ref.transaction((cur) => {
    const base = cur === null ? pre : cur;
    const next = core.addSourceMutator({ id, entry: full, keepChoice }, out)(base);
    return next === undefined ? undefined : core.withRev(next, base);
  });
  if (!res || !res.committed) throw new HttpsError("aborted", "The photo was stored but not put on the card — try again.");
  await db.ref(`${core.ROOT}/decisions`).push().set({ at, by: uid || null, action: entry.src === "web" ? "photoFromWeb" : "photoUpload", pid, genId: id, ...(entry.site ? { site: entry.site } : {}) }).catch(() => {});
  return { ok: true, pid, id, url: stored.url, kept: keepChoice };
}

async function upload(db, { pid, imageBase64 }, uid, deps) {
  await assertOnCard(db, pid, deps);
  if (typeof imageBase64 !== "string" || !imageBase64.length) throw new HttpsError("invalid-argument", "No photo was sent.");
  const b64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
  if (b64.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4) throw new HttpsError("invalid-argument", "That photo is larger than 20 MB.");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) throw new HttpsError("invalid-argument", "No photo was sent.");
  return keep(db, pid, { buffer, entry: { src: "upload" } }, uid, deps);
}

/** The product facts the search uses — keyed fields, never the whole record. */
async function productFacts(db, pid) {
  const f = ["name", "brand", "styleCode", "labelColorway", "colour", "color", "colorwayName"];
  const vals = await Promise.all(f.map((k) => val(db, `products/${pid}/${k}`).catch(() => null)));
  return Object.fromEntries(f.map((k, i) => [k, typeof vals[i] === "string" ? vals[i] : null]));
}

async function search(db, { pid }, deps) {
  await assertOnCard(db, pid, deps);
  const facts = await productFacts(db, pid);
  try {
    const r = await (deps.find || web.findCandidates)(facts, { apiKey: deps.apiKey, fetchImpl: deps.fetchImpl, lookup: deps.lookup, sharp: deps.sharp });
    return { ok: true, pid, query: r.query, candidates: r.candidates, entryPoint: r.entryPoint || null };
  } catch (e) {
    console.error(`bfPhotoSource: search for ${pid} failed — ${e.message}`);
    const why = Number(e.status) === 402 ? "the Gemini prepaid credit has run out — top it up in Google AI Studio"
      : Number(e.status) === 429 || Number(e.status) === 503 ? "the search is busy — tap Find online again" : "the search did not answer — tap Find online again";
    throw new HttpsError(Number(e.status) === 402 ? "resource-exhausted" : "unavailable", `No results — ${why}.`);
  }
}

async function pick(db, { pid, imageUrl, pageUrl, site }, uid, deps) {
  await assertOnCard(db, pid, deps);
  let img;
  try { img = await web.safeFetch(imageUrl, { maxBytes: web.IMAGE_MAX_BYTES, accept: "image/*", fetchImpl: deps.fetchImpl, lookup: deps.lookup, timeoutMs: 20_000 }); }
  catch (e) { throw new HttpsError("failed-precondition", `That photo could not be fetched (${String(e.message).slice(0, 60)}) — pick another.`); }
  let page = null;
  try { page = pageUrl ? web.checkUrl(pageUrl).toString() : null; } catch { page = null; }
  const entry = { src: "web", site: String(site || web.siteOf(page || img.url)).slice(0, 80), pageUrl: page ? page.slice(0, 500) : null, imageUrl: String(img.url).slice(0, 1000) };
  return keep(db, pid, { buffer: img.buffer, entry }, uid, deps);
}

// A New Arrival not in the build counts as on the card (lazy: New Arrivals' module only when needed).
const naRow = (db, pid) => require("./na.cjs").campaignRowOfNa(db, pid, Date.now(), require("../newArrivals/newArrivals.js"));

const bfPhotoSource = onCall(
  // invoker "public": a callable's Cloud Run service must allow allUsers to invoke (auth is checked in code).
  { region: "europe-west1", memory: "1GiB", cpu: 1, timeoutSeconds: 180, concurrency: 4, maxInstances: 3, secrets: [geminiApiKey], invoker: "public" },
  async (request) => {
    if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
    const d = request.data || {};
    const db = admin.database();
    const { uploadImmutable, BUCKET } = require("../newArrivals/studio.js").engine;
    const bucket = admin.storage().bucket(BUCKET);
    const deps = { apiKey: geminiApiKey.value(), upload: (p, buf, mime) => uploadImmutable(bucket, p, buf, mime), naRow: (pid) => naRow(db, pid) };
    const uid = request.auth.uid;
    if (d.action === "upload") return upload(db, d, uid, deps);
    if (d.action === "search") return search(db, d, deps);
    if (d.action === "pick") return pick(db, d, uid, deps);
    throw new HttpsError("invalid-argument", "upload, search or pick.");
  },
);

module.exports = { bfPhotoSource, _internals: { upload, search, pick, keep, storable, productFacts, assertOnCard } };

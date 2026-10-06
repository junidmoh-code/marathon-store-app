// ─── NEW ARRIVALS — THE PHOTO STUDIO (one streaming callable) ────────────────
// newArrivalsStudio   Junid taps Generate / Regenerate on ONE item. This calls
//                     Gemini directly and answers on the same connection: the
//                     thought summary and the interim drafts while it works,
//                     then the finished photo. No request queue, no Mac mini.
//
// TWO ENGINES, one interface: Gemini (the default) or OpenAI's gpt-image-1,
// picked per item on the card. Same prompt, same process; never blended.
//
// EVERYTHING IS MANUAL (Junid, 4 Oct): an image model is called here and only here,
// once per tap. No checker, no verdict, no retry, no automatic anything.
//
// The generation code is studio/*.mjs (ES modules, loaded on first use). The
// plates and references are Junid's own photos, read from Storage
// (new_arrivals/assets/plates) and verified against studio/config/plates.lock.json;
// the brand box library is read from new_arrivals/assets/boxes by its index.
//
// Deploy BY NAME, never a bare --only functions:
//   firebase deploy --only functions:newArrivalsStudio --project=marathon-club
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const na = require("./newArrivals.js");
const { CONDITION_CLAUSE } = require("../lib/photo-prompt.cjs");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
// The second provider (gpt-image-1): the same secret the older AI Studio already uses.
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const BUCKET = "marathon-club.firebasestorage.app";
const ASSETS = "new_arrivals/assets";

const generation = require("./studio/config/generation.json");
const spec = require("./studio/config/layout-spec.json");
const prices = require("./studio/config/prices.json");
const platesLock = require("./studio/config/plates.lock.json");
const examplesLock = require("./studio/config/examples.lock.json");

// The ES modules, loaded once per instance.
let modsP = null;
const mods = () => (modsP ||= Promise.all([
  import("./studio/studio.mjs"), import("./studio/gemini-stream.mjs"), import("./studio/record.mjs"), import("./studio/compose.mjs"), import("./studio/split.mjs"), import("./studio/openai-image.mjs"),
]).then(([studio, gemini, record, compose, split, openai]) => ({ studio, gemini, record, compose, split, openai }))
  .catch((e) => { modsP = null; throw e; }));

const val = async (db, path) => (await db.ref(path).once("value")).val();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── storage ──────────────────────────────────────────────────────────────────
const downloadUrl = (bucketName, objectPath, token) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;

/** Upload bytes with a Firebase download token; never overwrites. → { path, url } */
async function uploadImmutable(bucket, objectPath, buffer, contentType) {
  const token = crypto.randomUUID();
  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType, cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
  });
  return { path: objectPath, url: downloadUrl(bucket.name, objectPath, token) };
}

// A product's photo lives in the app's own Storage. Only those hosts are
// fetched, over https, with no redirect followed and a size ceiling — a photo
// URL on a product record can never make this function call anything else.
const PHOTO_HOSTS = new Set(["firebasestorage.googleapis.com", "storage.googleapis.com"]);
const PHOTO_MAX_BYTES = 40 * 1024 * 1024;
async function fetchBytes(url, { timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error("the photo's address is not a web address"); }
  if (u.protocol !== "https:" || !PHOTO_HOSTS.has(u.hostname)) throw new Error("the photo is not stored in the app's own storage");
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!res.ok) throw new Error(`fetch ${res.status} for the photo`);
  if (Number(res.headers.get("content-length")) > PHOTO_MAX_BYTES) throw new Error("the photo is too large");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > PHOTO_MAX_BYTES) throw new Error("the photo is too large");
  return { buffer };
}

// Junid's plates and references: read once per instance, verified against the
// lock (a changed file is refused, never used), their model-sized copy kept.
const assetCache = new Map();
function loadRoleFile(bucket, file, forModel) {
  if (!assetCache.has(file)) {
    assetCache.set(file, (async () => {
      const entry = platesLock[file];
      if (!entry) throw new Error(`${file} is not one of Junid's locked plates`);
      const [buffer] = await bucket.file(`${ASSETS}/plates/${file}`).download();
      if (sha256(buffer) !== entry.sha256) throw new Error(`${file} in Storage is not the locked plate — refusing to use it`);
      return { buffer, width: entry.width, height: entry.height, file, sha256: entry.sha256, forModel: await forModel(buffer) };
    })().catch((e) => { assetCache.delete(file); throw e; }));
  }
  return assetCache.get(file);
}

// Junid's own finished photos, shown as more examples of the footwear
// composition (examples.lock.json, in its order), sha-verified.
const EXAMPLES_SENT = 2;
/** Which examples a product is shown: the first two in the lock's order that are NOT its own brand (so their box can never be mistaken for its box). Pure. */
function exampleFiles(brand) {
  return Object.entries(examplesLock).filter(([, e]) => !brand || e.brand !== brand).map(([f]) => f).slice(0, EXAMPLES_SENT);
}
function loadExamples(bucket, forModel, brand = null) {
  const files = exampleFiles(brand);
  return Promise.all(files.map((file) => {
    const k = `example:${file}`;
    if (!assetCache.has(k)) {
      assetCache.set(k, (async () => {
        const [buffer] = await bucket.file(`${ASSETS}/plates/examples/${file}`).download();
        if (sha256(buffer) !== examplesLock[file].sha256) throw new Error(`${file} in Storage is not the locked example — refusing to use it`);
        return { file, forModel: await forModel(buffer) };
      })().catch((e) => { assetCache.delete(k); throw e; }));
    }
    return assetCache.get(k);
  }));
}

// The brand box library: sources.json names each brand's box file.
let boxIndexP = null;
async function libraryBox(bucket, key) {
  if (!key) return null;
  boxIndexP ||= bucket.file(`${ASSETS}/boxes/sources.json`).download().then(([b]) => JSON.parse(b.toString("utf8"))).catch((e) => { boxIndexP = null; throw e; });
  let index;
  try { index = await boxIndexP; } catch { return null; } // unreadable index: no box, never a wrong one
  const e = index[key];
  if (!e) return null;
  const file = e.file || `${key}.png`;
  const k = `box:${file}`;
  if (!assetCache.has(k)) {
    assetCache.set(k, bucket.file(`${ASSETS}/boxes/${file}`).download().then(([buffer]) => ({ buffer, kind: e.kind || "library" })).catch(() => { assetCache.delete(k); return null; }));
  }
  return assetCache.get(k);
}

// ── the day's USD/ZAR rate ───────────────────────────────────────────────────
// One lookup a day (ECB reference rates, frankfurter.app — public, no key),
// kept at new_arrivals/fx/{day}. A failed lookup uses the configured rate and
// is NOT kept, so the next generation tries again.
async function usdZarToday(db, nowMs, fetchImpl = fetch) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const ref = db.ref(`${core.ROOT}/fx/${day}`);
  const cached = (await ref.once("value")).val();
  if (cached && Number(cached.rate) > 0) return cached;
  try {
    const r = await fetchImpl("https://api.frankfurter.app/latest?from=USD&to=ZAR", { signal: AbortSignal.timeout(8_000) });
    const j = await r.json();
    const rate = Number(j?.rates?.ZAR);
    if (!(rate > 5 && rate < 50)) throw new Error(`implausible rate ${rate}`);
    const out = { rate, day, source: `ECB via frankfurter.app (${j.date})` };
    await ref.set(out);
    return out;
  } catch (e) {
    return { rate: prices.usdToZar, day, source: `configured fallback (rate lookup failed: ${String(e.message).slice(0, 60)})`, fallback: true };
  }
}

// ── the claim ────────────────────────────────────────────────────────────────
// Marks the item "a photo is being made" (generateRequest, stamped studio) so
// Approve, Skip and Use-this-one wait and a second tap is refused. NOTHING
// else on the item changes until a photo has actually landed: a failed
// generation leaves the item exactly as it was.
async function claim(db, pid, uid, nowMs) {
  const out = {};
  let prev = null;
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
    // Cold-cache null: commit nothing; the server's compare-and-retry supplies the item.
    if (!cur) { out.refusal = "it is not in the New Arrivals queue"; return null; }
    if (!core.SELECT_LANES.includes(cur.status)) { out.refusal = `it is ${cur.status}, not on the New tab`; return undefined; }
    // Only the studio's own live claim blocks. A request left for the retired
    // Mac mini queue is served by nobody: this tap takes it over.
    if (cur.generateRequest && cur.generateRequest.studio === true && core.requestPending(cur, nowMs)) { out.refusal = "a photo is already being made for it"; return undefined; }
    out.refusal = null;
    prev = cur;
    const fresh = cur.status === "new" && !cur.currentGen;
    // Nothing else: no photo is pinned on the item (the product's current photo is read at every use).
    return { ...cur, generateRequest: { at: nowMs, by: uid || "unknown", studio: true, ...(fresh ? {} : { regenerate: true }) } };
  });
  const item = res && res.committed && res.snapshot && res.snapshot.val();
  if (!item || out.refusal || !item.generateRequest || item.generateRequest.at !== nowMs) {
    throw new HttpsError("failed-precondition", `Can't generate — ${out.refusal || "not saved"}.`);
  }
  return { item, prev };
}

/** Give the item back: this run's request cleared, a plain note left. Never throws. */
async function release(db, pid, claimAt, nowMs, reason) {
  try {
    await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
      if (!cur) return null;
      if (!cur.generateRequest || cur.generateRequest.at !== claimAt) return undefined;
      const next = { ...cur, lastAttempt: { at: nowMs, failed: true, reason } };
      delete next.generateRequest;
      return next;
    });
  } catch (e) { console.error(`newArrivalsStudio: ${pid} not released — ${e.message}`); }
}

/**
 * The item after a finished photo. Pure.
 * THE CLAIM DECIDES: only while the item still carries THIS run's request, on
 * the New tab, does the photo become its main photo (and start a new lap: the
 * old approval, chain and names are cleared — the new photo needs its own
 * Approve). Otherwise — Junid skipped it, or the run outlived its claim and he
 * has moved on — the photo is only ADDED to the item's generations: the main
 * photo, the lane, an approval and anyone else's request are left alone.
 * → { next, mine }
 */
function landed(cur, { genId, gen, res, at, claimAt }) {
  const generations = { ...(cur.generations || {}), [genId]: gen };
  const mine = !!cur.generateRequest && cur.generateRequest.at === claimAt && core.SELECT_LANES.includes(cur.status);
  if (!mine) return { next: { ...cur, generations }, mine: false };
  const n = (Number(cur.attempts) || 0) + 1;
  const next = {
    ...cur, ...na._internals.NEW_LAP,
    generations,
    currentGen: genId,
    generatedUrl: res.generated.url, generatedPath: res.generated.path || null,
    plateId: `junid-${res.kind}`,
    boxInOriginal: res.box ? res.box.mode === "own" : false,
    boxUsed: res.box ? { mode: res.box.mode, source: res.box.source || null, brand: res.box.brand || null } : null,
    verdict: null, framingFlag: null, layoutCheck: null, colourCheck: null,
    lastRejection: cur.rejection || cur.lastRejection || null,
    // The name suggester runs after Approve (the mini's naming job reads this).
    naming: { status: "pending", since: at, tries: 0, overloads: 0 },
    attempts: n, attemptsSinceRetry: 0, infraErrors: null, busyAnswers: null,
    lastAttempt: { at, n, generatedUrl: res.generated.url },
    generateRequest: null,
    status: "ready", statusAt: at,
  };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
  return { next, mine: true };
}

/** Add to the spend counters. Never throws; never writes a non-number. */
async function addSpend(db, zar, { estimated = false } = {}) {
  if (!(Number.isFinite(zar) && zar > 0)) return;
  const paths = { "stats/totalSpentZar": admin.database.ServerValue.increment(zar) };
  if (estimated) paths["stats/estimatedPartZar"] = admin.database.ServerValue.increment(zar);
  try { await db.ref(core.ROOT).update(paths); } catch (e) { console.error(`newArrivalsStudio: spend of R${zar} not counted — ${e.message}`); }
}

// ── one generation ───────────────────────────────────────────────────────────
/**
 * deps (all injectable for tests): { bucket, apiKey (Gemini), openaiKey, now(), fetchBytes?, image?, fx?, assets?, correct?, generation? }
 * emit(ev): progress chunks for the card.
 * → { ok, pid, genId, code, seconds, item (as the card shows it) }
 */
async function studioGenerate(db, { pid, method, provider }, uid, deps, emit = () => {}) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (method !== undefined && method !== null && !core.METHODS.includes(method)) throw new HttpsError("invalid-argument", "Method is full or split.");
  if (provider !== undefined && provider !== null && !core.PROVIDERS.includes(provider)) throw new HttpsError("invalid-argument", "Provider is gemini or openai.");
  pid = String(pid);
  const { studio, gemini, record, compose, split, openai } = await mods();
  const now = deps.now || (() => Date.now());
  const t0 = now();
  const product = await val(db, `products/${pid}`);
  if (!product) throw new HttpsError("failed-precondition", "Can't generate — the product record no longer exists.");
  const { item, prev } = await claim(db, pid, uid, t0);
  const genId = `g${t0}`;
  const how = studio.methodFor(item, { asked: method || null, defaultMethod: generation.defaultMethod });
  // THE ENGINE: Gemini (the default) or OpenAI's gpt-image-1 — the tap's choice, else the item's.
  // One photo, one engine: the same prompt and process go to whichever was picked.
  const engine = studio.providerFor(item, { asked: provider || null, defaultProvider: generation.defaultProvider });
  const model = engine === "openai" ? generation.openaiModel : generation.imageModel;
  const who = core.PROVIDER_LABEL[engine];
  const bucket = deps.bucket;
  const fxOf = (at) => (deps.fx ? deps.fx(at) : usdZarToday(db, at)).catch(() => ({ rate: prices.usdToZar, fallback: true }));
  let res;
  try {
    res = await studio.generateOne({
      item: { ...item, pid }, product, genId, method: how, provider: engine, emit,
      deps: {
        fetchBytes: deps.fetchBytes || fetchBytes,
        loadPlate: (kind) => loadRoleFile(bucket, compose.ROLES[kind].plate, compose.forModel),
        loadReference: (kind) => (compose.ROLES[kind].reference ? loadRoleFile(bucket, compose.ROLES[kind].reference, compose.forModel) : null),
        libraryBox: (key) => libraryBox(bucket, key),
        loadExamples: (kind, { brand = null } = {}) => loadExamples(bucket, compose.forModel, brand),
        ...(deps.assets || {}),
        spec, generation: deps.generation || generation, conditionClause: CONDITION_CLAUSE,
        // The footwear correction (studio/correct.mjs unless a test supplies its own).
        ...(deps.correct ? { correct: deps.correct } : {}),
        // The ONE interface both engines sit behind: (model, parts, imageConfig, { onEvent }) → { buffer, usage, … }.
        image: deps.image || (engine === "openai"
          ? (m, parts, imageConfig, opts) => openai.openaiImage(m, parts, imageConfig, { ...opts, apiKey: deps.openaiKey })
          : (m, parts, imageConfig, opts) => gemini.streamImage(m, parts, imageConfig, { ...opts, apiKey: deps.apiKey })),
        upload: (p, buf, mime) => uploadImmutable(bucket, p, buf, mime),
        now,
        log: (m) => console.warn(`newArrivalsStudio: ${pid} — ${m}`),
        // The split method: Gemini makes the product only; code places it on the plate.
        split: split.splitGenerate,
        ...(deps.matte ? { matte: deps.matte } : {}),
      },
    });
  } catch (e) {
    // What Junid is told is one of a few fixed sentences; the detail goes to the log only.
    const status = Number(e.status) || 0;
    const reason = e.paid ? "the photo was made but could not be stored — it was charged; tap Generate to make another"
      : e.studioRefusal ? e.message
      : e.refusal ? `${who} declined to make this photo`
      : status === 402 || (engine === "openai" && status === 429 && /quota|billing/i.test(String(e.message))) ? `the ${who}${engine === "openai" ? "" : " prepaid"} credit has run out — top it up${engine === "openai" ? " on the OpenAI platform" : " in Google AI Studio"}, then tap Generate again`
      : engine === "openai" && status === 401 ? "the OpenAI key was refused — it needs replacing in Secret Manager"
      : status === 429 || status === 503 ? "the photo service is busy — tap Generate again"
      : status === 504 ? `${who} took too long and the connection was closed — it may still have been charged; tap Generate to try again`
      : "the photo could not be made — tap Generate again";
    await release(db, pid, t0, now(), reason);
    console.error(`newArrivalsStudio: ${pid} failed${e.paid ? " AFTER the image was made" : ""} — ${e.message}`);
    // What the call cost is counted in the spend even though no photo landed:
    // the whole image when it was made and lost (paid), else its prompt tokens.
    if (e.paid || e.usage) {
      const fx = await fxOf(now());
      const lost = e.paid ? record.generationCost({ model, usage: e.usage, prices, fx }) : null;
      await addSpend(db, lost ? lost.zar : record.failedCallZar({ model, usage: e.usage, prices, fx }), { estimated: !!lost?.estimated });
    }
    throw new HttpsError(e.studioRefusal ? "failed-precondition" : status === 402 ? "resource-exhausted" : status === 429 || status === 503 ? "unavailable" : "internal", `No photo — ${reason}.`);
  }

  // The photo exists, is stored and is paid for: from here every step is retried.
  const at = now();
  const cost = record.generationCost({ model, usage: res.usage, prices, fx: await fxOf(at) });
  let code = null;
  try {
    const seq = await studio.withRetries(() => db.ref(record.GENSEQ).transaction((cur) => (Number(cur) || 0) + 1));
    if (seq && seq.committed) code = record.formatCode(Number(seq.snapshot.val()));
  } catch (e) { console.error(`newArrivalsStudio: ${pid} has no code — ${e.message}`); }
  const reason = item.generateRequest.regenerate ? "regenerate" : "requested";
  const gen = record.generationEntry(res, { at, cost, model, reason, code, draftCount: res.draftFiles.length });

  // `from` is the lane the item was claimed in: a retried landing (the first
  // try committed but its answer was lost) must still move the index from there.
  const out = { from: item.status };
  let final = null;
  try {
    const done = await studio.withRetries(() => db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
      if (!cur) return null;
      // Already landed by an earlier try: nothing more to write. (It was this
      // run's photo if it is still the card's — a second Generate cannot have
      // started in the few hundred ms between tries: the claim was still held.)
      if (cur.generations && cur.generations[genId]) { out.mine = cur.currentGen === genId; return cur; }
      const l = landed(cur, { genId, gen, res, at, claimAt: t0 });
      out.mine = l.mine;
      if (!l.mine) out.from = cur.status;
      return l.next;
    }));
    final = done && done.committed && done.snapshot && done.snapshot.val();
  } catch (e) { console.error(`newArrivalsStudio: ${pid} landing failed — ${e.message}`); }
  if (!final || !final.generations || !final.generations[genId]) {
    // Stored but not on the item: a rescue row names the file, and the item is given back.
    console.error(`newArrivalsStudio: ${pid} photo ${res.generated.path} made but not saved on the item`);
    await db.ref(`${core.ROOT}/rescue/${pid}/${genId}`).set({ gen, at }).catch(() => {});
    await addSpend(db, cost.zar, { estimated: cost.estimated });
    await release(db, pid, t0, now(), "the photo was made but could not be put on the card — it is kept; tap Generate to make another");
    throw new HttpsError("internal", "No photo — the photo was made but could not be put on the card. It is kept and was charged; tap Generate to make another.");
  }

  // ONE multi-path write: the lane index, Junid's ledger row, the learning log, the spend.
  const full = record.genlogRecord({ code, pid, genId, gen, trace: res.trace, totalMs: at - t0 });
  const paths = {
    ...core.indexMove(pid, out.from, final.status, final.enqueuedAt),
    // Junid's ledger row — only for a photo that became the card's photo (a late one is in the log, not a decision).
    ...(out.mine ? await na._internals.decisionPaths(db, pid, { at: t0, uid, item: prev, action: prev.status === "new" && !prev.currentGen ? "generate" : "regenerate" }) : {}),
    // With no code (the counter could not be read) the record is still kept, under its item and generation.
    [`genlog/${code || `${pid}_${genId}`}`]: record.rtdbGenlog(full),
    "stats/generations": admin.database.ServerValue.increment(1),
    "stats/updatedAt": at,
  };
  if (Number.isFinite(cost.zar) && cost.zar > 0) {
    paths["stats/totalSpentZar"] = admin.database.ServerValue.increment(cost.zar);
    if (cost.estimated) paths["stats/estimatedPartZar"] = admin.database.ServerValue.increment(cost.zar);
  }
  try { await studio.withRetries(() => db.ref(core.ROOT).update(paths)); }
  catch (e) { console.error(`newArrivalsStudio: ${pid} bookkeeping write failed (lane index, ledger row, learning log, spend) — ${e.message}`); }
  // The FULL record, prompt text included, kept beside the photo (never read by the card).
  try {
    await studio.withRetries(() => bucket.file(`products/${pid}/new_arrivals/${genId}.genlog.json`).save(Buffer.from(JSON.stringify(full, null, 1)), { resumable: false, metadata: { contentType: "application/json" } }));
  } catch (e) { console.error(`newArrivalsStudio: ${pid} full record not stored — ${e.message}`); }

  // The product's photo as it is NOW (it may have been replaced while the photo was being made).
  const liveProduct = await val(db, `products/${pid}`).catch(() => product) || product;
  return {
    ok: true, pid, genId, code, seconds: Math.round((now() - t0) / 100) / 10, costZar: cost.zar, costEstimated: cost.estimated,
    // Not this run's item any more (skipped, or Junid moved on): the photo was added to it, nothing else changed.
    ...(out.mine ? {} : { addedOnly: true }),
    item: { ...core.cardItem(final), ...core.sourceFields(pid, final, liveProduct) },
  };
}

const newArrivalsStudio = onCall(
  // 2 vCPU for sharp; one generation holds ~200 MB of images. Not retried, not scheduled.
  { region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 3, maxInstances: 4, secrets: [geminiApiKey, openaiApiKey] },
  async (request, response) => {
    await na._internals.assertNewArrivalsAccess(request);
    const emit = request.acceptsStreaming && response ? (ev) => { response.sendChunk(ev); } : () => {};
    const d = request.data || {};
    return studioGenerate(admin.database(), { pid: d.pid, method: d.method, provider: d.provider }, request.auth?.uid,
      { bucket: admin.storage().bucket(BUCKET), apiKey: geminiApiKey.value(), openaiKey: openaiApiKey.value() }, emit);
  },
);

module.exports = {
  newArrivalsStudio,
  // for tests
  _internals: { exampleFiles, studioGenerate, claim, release, landed, usdZarToday, uploadImmutable, fetchBytes, mods },
};

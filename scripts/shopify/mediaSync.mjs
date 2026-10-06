// ── Product media → Shopify: photos AND videos, in Junid's order ─────────────
// The publishing media list (/shopify_publish/{pid}/media, ordered, first = the
// primary photo — see publishShared.js) is pushed to the product's Shopify media
// here, per item, so that:
//
//   • the whole ordered set lands, primary first;
//   • each item's Shopify media id and processing status is tracked
//     (/shopify_sync/{pid}/media — server-only — plus a small status
//     projection at /shopify_publish/{pid}/mediaShopify for the page);
//   • a video's bytes go to Shopify EXACTLY ONCE: once a staged upload has been
//     accepted its resourceUrl is recorded and the bytes are never sent again —
//     later ticks only attach (with that same resourceUrl) and poll. A FAILED
//     video is never re-sent; Junid removes it and adds it again;
//   • VIDEO BYTES NEVER MOVE INSIDE THE RECONCILE TICK. The transfer is done by
//     its own launchd job (media-video-runner.mjs, one video at a time, its own
//     lock), so a 1 GB upload can never hold up the 25-product publish batch,
//     the inventory push or the next tick — the tick only attaches what the
//     runner has already sent;
//   • only media THIS SYSTEM created is ever removed from Shopify: items the
//     list no longer holds, and the photo set the reconciler attached before
//     per-item tracking existed (proven ours by the mediaFingerprint it
//     stamped, and SNAPSHOTTED into the record the first time, so a later tick
//     never re-guesses). Anything else on the product is left where it is;
//   • on a LIVE product nothing is removed until every photo in the list is
//     READY on Shopify — the storefront never shows the product without its
//     photos while new ones process;
//   • re-running with nothing changed makes ZERO Shopify writes, ZERO Storage
//     downloads and ZERO database writes (the live path does not even read
//     Shopify: it compares the node's mediaSyncedSig with its list first).
//
// Videos Shopify cannot take (over 1 GB, over 10 minutes, over 4K, or a format
// it does not accept — publishShared.shopifyVideoProblem) are kept in Storage
// and in the list, and simply never pushed. Nothing here re-encodes anything:
// the bytes streamed to Shopify are the Storage object's bytes, SHA-256-checked
// in flight against the hash recorded when Junid picked the file.
//
// ALT TEXT. Every image and video carries the product's validated listing name
// — the same title the ON path validates (cleanName while trigger-free, else
// the lexicon title) — and nothing else; a rename re-labels every item. No
// filename or item metadata reaches Shopify: a staged upload is video_<id>.<ext>.
//
// RECORD WRITES ARE FIELD-LEVEL. The tick and the video runner both write
// /shopify_sync/{pid}/media/items; each writes only the fields it changed, so
// neither can overwrite the other's (above all, never the runner's resourceUrl).
import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import {
  resolveMediaList, normalizeMediaItems, shopifyVideoProblem, mediaPushSig, APP_STORAGE_PREFIX,
} from "../../src/components/shopify/publishShared.js";

export const MEDIA_PRODUCTS_PER_TICK = 25;
export const MAX_ATTEMPTS = 3;
export const MEDIA_PENDING_PATH = "shopify_sync/_mediaPending";
const MEDIA_PAGE = 250; // Shopify's per-product media cap AND its largest page

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does this node carry the new media list? (Older nodes keep the old photo path.) */
export function hasMediaModel(node) {
  return !!normalizeMediaItems(node?.media);
}

/** The items Shopify should hold, in order: every photo, and every video Shopify can take. */
export function desiredPushItems(node, product) {
  return resolveMediaList(node, product).items
    .filter((m) => m.type === "photo" || !shopifyVideoProblem(m))
    .filter((m) => typeof m.url === "string" && m.url.startsWith(APP_STORAGE_PREFIX));
}

/**
 * The sig the live path compares — what the reconciler last FINISHED applying:
 * the pushed items AND the listing name (a rename re-labels every alt text).
 */
export function pushSigFor(node, product) {
  return `${mediaPushSig(desiredPushItems(node, product))}|${JSON.stringify(node?.cleanName ?? null)}`;
}

const copy = (o) => JSON.parse(JSON.stringify(o ?? {}));

// ─── THE PLAN (pure) ─────────────────────────────────────────────────────────
/**
 * desired  — items in order (desiredPushItems)
 * record   — /shopify_sync/{pid}/media/items  { [key]: entry }
 * inflight — /shopify_sync/{pid}/media/inflight: a create whose answer was
 *            never recorded ({ before: [shopify ids], items: [itemIds], kind })
 * shopify  — the product's media as read now, in Shopify's order:
 *            [{ id, status, mediaContentType, alt, mediaErrors? }]
 * legacyFingerprint — /shopify_sync/{pid}/mediaFingerprint
 *
 * → { createPhotos, attachVideos, failedIds, foreignIds, record }
 *   (record entries carrying `remove: true` are ours and due to come off)
 */
export function planMediaSync({ desired, record = {}, inflight = null, shopify = [], legacyFingerprint = null, legacyCount = null }) {
  const shopById = new Map(shopify.map((n) => [n.id, n]));
  const next = copy(record);
  const desiredIds = new Set(desired.map((m) => m.id));
  const out = { createPhotos: [], attachVideos: [], failedIds: [], foreignIds: [], record: next };
  const ownedNow = () => new Set(Object.values(next).map((r) => r.shopifyMediaId).filter(Boolean));

  // A create whose response was lost (a crash, a timeout): the media it made
  // are the ids that appeared since, of the right type, in order. Adopted only
  // when the count matches exactly; otherwise they stay unknown and are left
  // alone (never deleted on a guess).
  if (inflight?.items?.length) {
    const owned = ownedNow();
    const before = new Set(inflight.before || []);
    const fresh = shopify.filter((n) => !before.has(n.id) && !owned.has(n.id) &&
      n.mediaContentType === (inflight.kind === "video" ? "VIDEO" : "IMAGE"));
    if (fresh.length === inflight.items.length) {
      inflight.items.forEach((itemId, k) => {
        const r = next[itemId] || (next[itemId] = {});
        r.shopifyMediaId = fresh[k].id;
      });
    }
  }

  // FIRST CONTACT: snapshot the set the old path attached. Only when the
  // record is empty AND the old path's fingerprint proves it attached the
  // product's media — and only IMAGES (the old path never attached anything
  // else), and only when their count is the count it attached (mediaCount,
  // stamped beside the fingerprint since 6 Oct; older stamps carry none). From
  // then on these are ordinary records, marked for removal, never re-guessed.
  // Anything that fails the proof is somebody else's and is left alone.
  if (Object.keys(record || {}).length === 0 && !inflight && legacyFingerprint) {
    const images = shopify.filter((n) => n.mediaContentType === "IMAGE");
    if (legacyCount == null || images.length === Number(legacyCount)) {
      for (const n of images) {
        next[`L${String(n.id).split("/").pop()}`] = { legacy: true, remove: true, shopifyMediaId: n.id, type: "photo" };
      }
    }
  }

  for (const m of desired) {
    const r = next[m.id] || (next[m.id] = {});
    r.type = m.type;
    r.url = m.url;
    delete r.remove;
    const sm = r.shopifyMediaId ? shopById.get(r.shopifyMediaId) : null;
    if (r.shopifyMediaId && !sm) delete r.shopifyMediaId; // gone (deleted in the admin)
    if (sm) {
      if (sm.status === "READY") { r.status = "ready"; delete r.note; delete r.terminal; }
      else if (sm.status === "FAILED") {
        const why = (sm.mediaErrors || []).map((e) => e?.message || e?.code).filter(Boolean).join("; ");
        out.failedIds.push(sm.id);   // ours, not shown anyway — taken off Shopify
        delete r.shopifyMediaId;
        r.note = why ? `Shopify said: ${why}` : "Shopify could not process this file";
        if (m.type === "photo" && (r.createAttempts || 0) < MAX_ATTEMPTS) {
          // A photo is re-fetched by Shopify from Storage: a transient fetch
          // failure must not lose it for good. Retried, up to MAX_ATTEMPTS.
          out.createPhotos.push(m);
          r.status = "processing";
        } else {
          // A video's bytes are never sent twice; a photo that failed every try stops.
          r.status = "failed";
          r.terminal = true;
        }
      } else r.status = "processing";
    } else if (r.terminal) {
      r.status = "failed";
    } else if (m.type === "photo") {
      out.createPhotos.push(m);
      r.status = "processing";
    } else if (r.resourceUrl) {
      out.attachVideos.push(m);
      r.status = "processing";
    } else if (r.status !== "uploading") {
      r.status = "queued"; // the video runner sends it
    }
  }

  // Ours, but no longer in the list → marked; removed when it is safe.
  for (const [key, r] of Object.entries(next)) {
    if (desiredIds.has(key)) continue;
    if (r.shopifyMediaId && shopById.has(r.shopifyMediaId)) r.remove = true;
    else delete next[key];
  }

  const owned = ownedNow();
  for (const n of shopify) if (!owned.has(n.id) && !out.failedIds.includes(n.id)) out.foreignIds.push(n.id);
  return out;
}

/**
 * The productReorderMedia moves that turn `current` (ids in Shopify's order)
 * into `targetFront` first, everything else after in its current relative
 * order. Simulated exactly as Shopify applies them (sequentially). [] when
 * already in order.
 */
export function reorderMoves(current, targetFront) {
  const front = targetFront.filter((id) => current.includes(id));
  const rest = current.filter((id) => !front.includes(id));
  const target = [...front, ...rest];
  const list = [...current];
  const moves = [];
  for (let k = 0; k < target.length; k++) {
    if (list[k] === target[k]) continue;
    const from = list.indexOf(target[k]);
    list.splice(from, 1);
    list.splice(k, 0, target[k]);
    moves.push({ id: target[k], newPosition: String(k) });
  }
  return moves;
}

/**
 * The /shopify_sync/{pid}/media update that turns `before` into `after`,
 * field by field — null for a removed entry or field. {} when nothing changed.
 */
export function recordPatch(before, after) {
  const patch = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    if (a === undefined) { patch[`items/${k}`] = null; continue; }
    // Field by field even for a NEW entry, so a field another writer set in
    // between (the video sender's resourceUrl) is never overwritten.
    for (const f of new Set([...Object.keys(b || {}), ...Object.keys(a)])) {
      if (b === undefined && a[f] === undefined) continue;
      if (JSON.stringify(b?.[f]) !== JSON.stringify(a[f])) patch[`items/${k}/${f}`] = a[f] === undefined ? null : a[f];
    }
  }
  return patch;
}

// ─── SHOPIFY I/O ─────────────────────────────────────────────────────────────
export async function readProductMedia(graphql, gid) {
  const d = await graphql(
    `query ($id: ID!) { product(id: $id) { id media(first: ${MEDIA_PAGE}) {
        pageInfo { hasNextPage }
        nodes { id status mediaContentType alt mediaErrors { code message } } } } }`,
    { id: gid });
  if (!d.product) return null;
  if (d.product.media.pageInfo?.hasNextPage) throw new Error(`more than ${MEDIA_PAGE} media on ${gid} — cannot verify the set`);
  return d.product.media.nodes;
}

async function createMedia(graphql, gid, inputs) {
  const d = await graphql(
    `mutation ($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { id status mediaContentType }
        mediaUserErrors { field message } } }`,
    { productId: gid, media: inputs }, { mutation: true });
  const errs = d.productCreateMedia.mediaUserErrors;
  if (errs?.length) throw new Error(`productCreateMedia userErrors: ${JSON.stringify(errs)}`);
  const media = d.productCreateMedia.media || [];
  if (media.length !== inputs.length) throw new Error(`productCreateMedia returned ${media.length} media for ${inputs.length} inputs`);
  return media;
}

async function deleteMedia(graphql, gid, ids) {
  if (!ids.length) return;
  const d = await graphql(
    `mutation ($mediaIds: [ID!]!, $productId: ID!) {
      productDeleteMedia(mediaIds: $mediaIds, productId: $productId) { deletedMediaIds mediaUserErrors { field message } } }`,
    { mediaIds: ids, productId: gid }, { mutation: true });
  const errs = d.productDeleteMedia.mediaUserErrors;
  if (errs?.length) throw new Error(`productDeleteMedia userErrors: ${JSON.stringify(errs)}`);
}

async function reorderMedia(graphql, gid, moves) {
  if (!moves.length) return;
  const d = await graphql(
    `mutation ($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) { job { id done } mediaUserErrors { field message } } }`,
    { id: gid, moves }, { mutation: true });
  const errs = d.productReorderMedia.mediaUserErrors;
  if (errs?.length) throw new Error(`productReorderMedia userErrors: ${JSON.stringify(errs)}`);
}

// Alt text on READY media (fileUpdate needs the file READY).
async function setAlt(graphql, files) {
  if (!files.length) return;
  const d = await graphql(
    `mutation ($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message } } }`,
    { files }, { mutation: true });
  const errs = d.fileUpdate.userErrors;
  if (errs?.length) throw new Error(`fileUpdate userErrors: ${JSON.stringify(errs)}`);
}

const EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

/**
 * Stream one video's Storage bytes to a Shopify staged upload, exactly as
 * stored. → resourceUrl. Throws on any failure, before anything is recorded.
 * Hash-checked in flight: a mismatch aborts before the closing boundary, so
 * the wrong bytes never complete an upload.
 */
export async function uploadVideoToShopify(graphql, item, { fetchImpl = fetch, request = https.request } = {}) {
  const mime = String(item.mime || "video/mp4").toLowerCase();
  const filename = `video_${item.id}.${EXT[mime] || "mp4"}`;
  if (!(Number(item.bytes) > 0)) throw new Error("the video's size is not recorded — refusing to send it blind");
  const staged = await graphql(
    `mutation ($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message } } }`,
    { input: [{ resource: "VIDEO", filename, mimeType: mime, fileSize: String(item.bytes), httpMethod: "POST" }] },
    { mutation: true });
  const sErrs = staged.stagedUploadsCreate.userErrors;
  if (sErrs?.length) throw new Error(`stagedUploadsCreate userErrors: ${JSON.stringify(sErrs)}`);
  const target = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) throw new Error("stagedUploadsCreate returned no target");

  const abort = new AbortController();
  const src = await fetchImpl(item.url, { signal: AbortSignal.any ? AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60 * 1000)]) : abort.signal });
  if (!src.ok || !src.body) throw new Error(`could not read the video from Storage (HTTP ${src.status})`);
  const len = Number(src.headers.get("content-length"));
  if (len && len !== Number(item.bytes)) throw new Error(`Storage holds ${len} bytes, the list recorded ${item.bytes} — refusing`);

  const boundary = `----marathon${randomBytes(12).toString("hex")}`;
  const pre = Buffer.concat([
    ...target.parameters.map((p) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
  ]);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const hash = createHash("sha256");
  let sent = 0;
  try {
    await new Promise((resolve, reject) => {
      const req = request(target.url, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`,
                   "Content-Length": pre.length + Number(item.bytes) + post.length },
      }, (res) => {
        let body = "";
        res.on("data", (c) => { if (body.length < 2000) body += c; });
        res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300
          ? resolve()
          : reject(new Error(`staged upload HTTP ${res.statusCode}: ${body.slice(0, 300)}`))));
      });
      req.on("error", reject);
      req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error("staged upload stalled for 10 minutes")));
      // Back-pressure that cannot hang: a request that errors or closes while
      // the writer waits for "drain" releases the wait too.
      const writeAll = (buf) => (req.write(buf) ? Promise.resolve() : new Promise((r) => {
        const done = () => { req.off("drain", done); req.off("close", done); req.off("error", done); r(); };
        req.once("drain", done); req.once("close", done); req.once("error", done);
      }));
      (async () => {
        try {
          await writeAll(pre);
          for await (const chunk of src.body) {
            if (req.destroyed) throw new Error("the upload connection closed");
            const buf = Buffer.from(chunk);
            sent += buf.length;
            if (sent > Number(item.bytes)) throw new Error("Storage sent more bytes than recorded");
            hash.update(buf);
            await writeAll(buf);
          }
          if (sent !== Number(item.bytes)) throw new Error(`Storage sent ${sent} bytes, expected ${item.bytes}`);
          const hex = hash.digest("hex");
          if (item.sha256 && hex !== item.sha256) {
            throw new Error(`the bytes in Storage do not match the file Junid picked (sha256 ${hex.slice(0, 12)}… ≠ ${item.sha256.slice(0, 12)}…)`);
          }
          req.end(post);
        } catch (e) { req.destroy(e); reject(e); }
      })();
    });
  } finally {
    abort.abort(); // never leave the Storage download open
  }
  return target.resourceUrl;
}

// ─── THE VIDEO RUNNER'S ONE STEP ─────────────────────────────────────────────
/**
 * Send ONE queued video for this product to Shopify (media-video-runner.mjs
 * calls it, under its own lock). → { sent, itemId?, error? }.
 * Exactly once: a video with a recorded resourceUrl is never picked; the
 * resourceUrl is written the moment Shopify accepts the bytes. A run killed
 * mid-transfer recorded nothing and costs no attempt — the bytes never landed.
 */
export async function sendNextQueuedVideo({ graphql, db, pid, node, product = null, upload = uploadVideoToShopify, log = () => {} }) {
  const items = desiredPushItems(node, product).filter((m) => m.type === "video");
  if (!items.length) return { sent: false };
  const recRef = db.ref(`shopify_sync/${pid}/media/items`);
  const record = (await recRef.get()).val() || {};
  const m = items.find((v) => {
    const r = record[v.id] || {};
    return !r.resourceUrl && !r.shopifyMediaId && !r.terminal && (r.uploadAttempts || 0) < MAX_ATTEMPTS;
  });
  if (!m) return { sent: false };
  const itemRef = recRef.child(m.id);
  const projRef = db.ref(`shopify_publish/${pid}/mediaShopify/${m.id}`);
  await itemRef.update({ type: "video", url: m.url, status: "uploading" });
  await projRef.set({ status: "uploading" });
  log(`  media: sending video ${m.id} of ${pid} (${Math.round(Number(m.bytes) / 1e6)} MB) to Shopify…`);
  try {
    const resourceUrl = await upload(graphql, m);
    await itemRef.update({ resourceUrl, uploadedAt: Date.now(), status: "processing", note: null });
    await projRef.set({ status: "processing" });
    return { sent: true, itemId: m.id };
  } catch (e) {
    const attempts = ((record[m.id] || {}).uploadAttempts || 0) + 1;
    const note = String(e?.message || e).slice(0, 300);
    const terminal = attempts >= MAX_ATTEMPTS;
    await itemRef.update({ uploadAttempts: attempts, note, status: terminal ? "failed" : "queued", ...(terminal ? { terminal: true } : {}) });
    await projRef.set({ status: terminal ? "failed" : "queued", note });
    return { sent: false, itemId: m.id, error: note };
  }
}

// ─── ONE PRODUCT ─────────────────────────────────────────────────────────────
/**
 * Bring one product's Shopify media in line with its list.
 *   mode "on"   — the product is OFF the channel (the publish path): removal
 *                 is free, and every photo must be READY before this returns ok.
 *   mode "live" — the product is on the shop: create, reorder, re-label; remove
 *                 only once every photo in the list is READY. Never waits.
 * Videos are only ATTACHED here (their bytes are sent by the video runner).
 * → { ok, error?, retryable, pending, notes[], writes }
 */
export async function syncProductMedia({ graphql, db, pid, gid, node, product, title, mode = "live",
                                         log = () => {}, pollMs = 2000, pollTries = 15 }) {
  const alt = String(title ?? "").trim();
  if (!alt) return { ok: false, retryable: false, error: "media alt text requires the validated listing name", pending: false, notes: [], writes: 0 };
  const listed = resolveMediaList(node, product).items;
  const desired = desiredPushItems(node, product);
  if (!desired.length || desired[0].type !== "photo" || desired[0].id !== listed[0]?.id) {
    return { ok: false, retryable: false, error: "the list's first photo cannot be pushed (no photo first, or not this app's own Storage file) — an imageless or wrong-primary product is never pushed", pending: false, notes: [], writes: 0 };
  }
  const mediaRef = db.ref(`shopify_sync/${pid}/media`);
  const stored = (await mediaRef.get()).val() || {};
  const fingerprint = (await db.ref(`shopify_sync/${pid}/mediaFingerprint`).get()).val();
  const legacyCount = fingerprint ? (await db.ref(`shopify_sync/${pid}/mediaCount`).get()).val() : null;
  let shopify = await readProductMedia(graphql, gid);
  if (!shopify) return { ok: false, retryable: true, error: `${gid} not found on Shopify`, pending: true, notes: [], writes: 0 };

  const plan = planMediaSync({ desired, record: stored.items || {}, inflight: stored.inflight || null, shopify, legacyFingerprint: fingerprint || null, legacyCount });
  const rec = plan.record;
  let saved = copy(stored.items || {});
  const notes = [];
  let writes = 0;
  const save = async (extra = {}) => {
    const patch = { ...recordPatch(saved, rec), ...extra };
    if (!Object.keys(patch).length) return;
    await mediaRef.update(patch);
    saved = copy(rec);
  };
  // A lost create resolved by adoption (or not): the inflight note goes.
  if (stored.inflight) await save({ inflight: null });

  const create = async (items, kind, inputs) => {
    await save({ inflight: { before: shopify.map((n) => n.id), items: items.map((m) => m.id), kind } });
    const made = await createMedia(graphql, gid, inputs);
    writes += 1;
    items.forEach((m, k) => { rec[m.id].shopifyMediaId = made[k].id; });
    await save({ inflight: null });
    return made;
  };

  try {
    // 0. Shopify's FAILED copies of our media off the product (never shown anyway).
    if (plan.failedIds.length) { await deleteMedia(graphql, gid, plan.failedIds); writes += 1; shopify = shopify.filter((n) => !plan.failedIds.includes(n.id)); }
    // 1. New photos — one call, ids back in input order.
    if (plan.createPhotos.length) {
      for (const m of plan.createPhotos) rec[m.id].createAttempts = (rec[m.id].createAttempts || 0) + 1;
      const made = await create(plan.createPhotos, "photo",
        plan.createPhotos.map((m) => ({ originalSource: m.url, alt, mediaContentType: "IMAGE" })));
      log(`  media: +${made.length} photo(s)`);
    }
    // 2. Videos whose bytes Shopify already holds (sent once, by the runner).
    if (plan.attachVideos.length) {
      try {
        for (const m of plan.attachVideos) rec[m.id].attachAttempts = (rec[m.id].attachAttempts || 0) + 1;
        const made = await create(plan.attachVideos, "video",
          plan.attachVideos.map((m) => ({ originalSource: rec[m.id].resourceUrl, alt, mediaContentType: "VIDEO" })));
        log(`  media: +${made.length} video(s) attached`);
      } catch (e) {
        for (const m of plan.attachVideos) {
          const r = rec[m.id];
          r.note = String(e?.message || e).slice(0, 300);
          if (r.attachAttempts >= MAX_ATTEMPTS) { r.status = "failed"; r.terminal = true; }
        }
        await save({ inflight: null });
        notes.push(`video attach: ${String(e?.message || e)}`);
      }
    }
    if (writes) shopify = await readProductMedia(graphql, gid);
    // 3. The publish path waits for its photos BEFORE ordering them: Shopify
    //    refuses to reorder media that is still processing.
    if (mode === "on") {
      const want = desired.filter((m) => m.type === "photo").map((m) => rec[m.id]?.shopifyMediaId);
      if (want.some((id) => !id)) {
        return { ok: false, retryable: true, error: "a photo failed on Shopify every time it was sent — remove it and add it again, then publish", pending: true, notes, writes };
      }
      let ready = false;
      for (let t = 0; t < pollTries; t++) {
        const now = await readProductMedia(graphql, gid);
        const mine = now.filter((n) => want.includes(n.id));
        if (mine.some((n) => n.status === "FAILED")) {
          return { ok: false, retryable: true, error: "a photo FAILED processing on Shopify — the product must not ship without it; publishing again retries it", pending: true, notes, writes };
        }
        if (mine.length === want.length && mine.every((n) => n.status === "READY")) { ready = true; shopify = now; break; }
        await sleep(pollMs);
      }
      if (!ready) return { ok: false, retryable: true, error: "the photos were not READY on Shopify after polling — publishing again resumes", pending: true, notes, writes };
    }
    // 4. Order: ours that are READY, in list order, first; everything else
    //    after, untouched. Items still processing join on a later tick.
    let byId = new Map(shopify.map((n) => [n.id, n]));
    const readyOurs = desired.map((m) => rec[m.id]?.shopifyMediaId).filter((id) => byId.get(id)?.status === "READY");
    const moves = reorderMoves(shopify.map((n) => n.id), readyOurs);
    if (moves.length) {
      try {
        await reorderMedia(graphql, gid, moves);
        writes += 1;
        log(`  media: reordered (${moves.length} move(s))`);
      } catch (e) {
        if (!/NON_READY|not ready|processing/i.test(String(e?.message || e))) throw e;
        notes.push("reorder waits for Shopify to finish processing — next tick");
      }
    }
    for (const m of desired) {
      const st = byId.get(rec[m.id]?.shopifyMediaId)?.status;
      if (st === "READY") rec[m.id].status = "ready";
    }
    // 5. Alt text = the validated listing name, on every READY item of ours.
    const relabel = desired.map((m) => byId.get(rec[m.id]?.shopifyMediaId))
      .filter((n) => n && n.status === "READY" && n.alt !== alt).map((n) => ({ id: n.id, alt }));
    if (relabel.length) { await setAlt(graphql, relabel); writes += 1; log(`  media: alt text set on ${relabel.length}`); }
    // 6. Removal — LAST, and on a live product only once every photo in the
    //    list is READY there, so the shop never shows it without its photos.
    // A photo that failed for good (terminal) cannot block removals for ever;
    // the PRIMARY must be READY, and every other photo still being tried too.
    const livePhotos = desired.filter((m) => m.type === "photo" && !rec[m.id]?.terminal);
    const photosReady = desired[0] && !rec[desired[0].id]?.terminal &&
      livePhotos.every((m) => byId.get(rec[m.id]?.shopifyMediaId)?.status === "READY");
    const toRemove = Object.entries(rec).filter(([, r]) => r.remove && r.shopifyMediaId && byId.has(r.shopifyMediaId));
    if (toRemove.length && (mode === "on" || photosReady)) {
      await deleteMedia(graphql, gid, toRemove.map(([, r]) => r.shopifyMediaId));
      writes += 1;
      for (const [k] of toRemove) delete rec[k];
      await save();
      log(`  media: removed ${toRemove.length} (ours, no longer in the list)`);
    }
    if (plan.foreignIds.length) notes.push(`${plan.foreignIds.length} media on Shopify were not added by this app and were left alone`);
  } finally {
    await save();
  }

  // The page's projection + the carry-forward marker + the finished sig.
  const statusMap = {};
  for (const m of desired) {
    const r = rec[m.id] || {};
    statusMap[m.id] = r.note && r.status !== "ready" ? { status: r.status || "queued", note: r.note } : { status: r.status || "queued" };
  }
  const removalsLeft = Object.values(rec).some((r) => r.remove);
  const pending = removalsLeft || desired.some((m) => !["ready", "failed"].includes(statusMap[m.id].status));
  const pubRef = db.ref(`shopify_publish/${pid}`);
  if (JSON.stringify(node?.mediaShopify || null) !== JSON.stringify(statusMap)) {
    await pubRef.child("mediaShopify").set(statusMap);
  }
  const sig = pushSigFor(node, product);
  if (!pending && node?.mediaSyncedSig !== sig) await pubRef.child("mediaSyncedSig").set(sig);
  // The marker is written only when it changes — an idle re-run writes nothing.
  const markerRef = db.ref(`${MEDIA_PENDING_PATH}/${pid}`);
  const marked = (await markerRef.get()).val() != null;
  if (pending && !marked) await markerRef.set(true);
  else if (!pending && marked) await markerRef.remove();
  return { ok: true, pending, notes, writes };
}

/**
 * Should the live media phase look at this product at all? Without a Shopify
 * call: only a confirmed-live, intent-on node with a media list whose sig
 * differs from what was last finished — or one carried forward as pending.
 */
export function needsLiveMediaSync(node, product, { pending = false } = {}) {
  if (!(node?.state === "live" && node?.liveState === "on" && node?.desiredState === "on")) return false;
  if (!hasMediaModel(node)) return false;
  if (pending) return true;
  return node.mediaSyncedSig !== pushSigFor(node, product);
}

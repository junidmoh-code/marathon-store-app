// ── Product media → Shopify: photos AND videos, in Junid's order ─────────────
// The publishing media list (/shopify_publish/{pid}/media, ordered, first = the
// primary photo — see publishShared.js) is pushed to the product's Shopify media
// here, per item, so that:
//
//   • the whole ordered set lands, primary first;
//   • each item's Shopify media id and processing status is tracked
//     (/shopify_sync/{pid}/media — server-only — plus a small status
//     projection at /shopify_publish/{pid}/mediaShopify for the page);
//   • a video's bytes go to Shopify EXACTLY ONCE: once the staged upload has
//     been accepted its resourceUrl is recorded and the upload is never made
//     again — later ticks only attach (with that same resourceUrl) and poll;
//   • only media THIS SYSTEM created is ever removed from Shopify — items the
//     list no longer holds, and the photo set the reconciler attached before
//     per-item tracking existed (proven ours by the mediaFingerprint it
//     stamped). Anything else on the product is left exactly where it is;
//   • re-running with nothing changed makes ZERO Shopify writes and ZERO
//     Storage downloads (the live path does not even read Shopify: it compares
//     the node's mediaSyncedSig with the list first);
//   • video transfers are capped per tick (VIDEO_UPLOADS_PER_TICK) and run
//     AFTER the intent batch, so a 1 GB upload never holds up the 25 products
//     waiting to go live — the rest carry forward on /shopify_sync/_mediaPending.
//
// Videos Shopify cannot take (over 1 GB, over 10 minutes, over 4K, or a format
// it does not accept — publishShared.shopifyVideoProblem) are kept in Storage
// and in the list, and simply never pushed. Nothing here re-encodes anything:
// the bytes streamed to Shopify are the Storage object's bytes, SHA-256-checked
// in flight against the hash recorded when Junid picked the file.
//
// ALT TEXT. Every image and video carries the product's validated listing name
// — the same title the ON path validates (cleanName while trigger-free, else
// the lexicon title) — and nothing else. No filename, no item metadata ever
// reaches Shopify: the staged upload is named video_<id>.<ext>.
import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import {
  resolveMediaList, normalizeMediaItems, shopifyVideoProblem, mediaPushSig, APP_STORAGE_PREFIX,
} from "../../src/components/shopify/publishShared.js";

export const VIDEO_UPLOADS_PER_TICK = 1;
export const MEDIA_PRODUCTS_PER_TICK = 25;
export const MAX_UPLOAD_ATTEMPTS = 3;
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

/** The sig the live path compares — what the reconciler last FINISHED applying. */
export function pushSigFor(node, product) {
  return mediaPushSig(desiredPushItems(node, product));
}

// ─── THE PLAN (pure) ─────────────────────────────────────────────────────────
/**
 * desired  — items in order (desiredPushItems)
 * record   — /shopify_sync/{pid}/media/items  { [itemId]: entry }
 * shopify  — the product's media as read now, in Shopify's order:
 *            [{ id, status, mediaContentType, mediaErrors? }]
 * legacyFingerprint — /shopify_sync/{pid}/mediaFingerprint (the old photo
 *            path's proof that it attached the product's current set)
 * videoBudget — how many video uploads this call may start
 *
 * → {
 *   createPhotos: [item]            photos with no live Shopify media
 *   uploadVideos: [item]            videos whose bytes have never been accepted (within budget)
 *   queuedVideos: [item]            ditto, past the budget — next tick
 *   attachVideos: [item]            bytes accepted (resourceUrl recorded), not attached
 *   removeIds:    [shopifyMediaId]  ours, no longer in the list (incl. our FAILED ones)
 *   legacyIds:    [shopifyMediaId]  the pre-tracking photo set — removed once ours are in
 *   foreignIds:   [shopifyMediaId]  not ours — never touched
 *   status:       { [itemId]: { status, note? } }   the projection as known before I/O
 *   record:       the next record (ids of vanished media cleared; failures noted)
 * }
 */
export function planMediaSync({ desired, record = {}, shopify = [], legacyFingerprint = null, videoBudget = 0 }) {
  const shopById = new Map(shopify.map((n) => [n.id, n]));
  const next = {};
  for (const [k, v] of Object.entries(record || {})) next[k] = { ...v };
  const desiredIds = new Set(desired.map((m) => m.id));
  const ownedIds = new Set(Object.values(next).map((r) => r.shopifyMediaId).filter(Boolean));
  const out = { createPhotos: [], uploadVideos: [], queuedVideos: [], attachVideos: [],
                removeIds: [], legacyIds: [], foreignIds: [], status: {}, record: next };
  let budget = videoBudget;

  for (const m of desired) {
    const r = next[m.id] || (next[m.id] = { type: m.type });
    r.type = m.type;
    r.url = m.url;
    const sm = r.shopifyMediaId ? shopById.get(r.shopifyMediaId) : null;
    if (r.shopifyMediaId && !sm) {
      // Gone from Shopify (deleted in the admin, or our own FAILED removal).
      delete r.shopifyMediaId;
    }
    if (sm) {
      if (sm.status === "READY") { r.status = "ready"; delete r.note; }
      else if (sm.status === "FAILED") {
        // Shopify could not process it. Ours, so it is taken off the product;
        // a video is NOT re-uploaded (exactly once) — Junid removes and re-adds.
        const why = (sm.mediaErrors || []).map((e) => e?.message || e?.code).filter(Boolean).join("; ");
        r.status = "failed";
        r.terminal = true;
        r.note = why ? `Shopify said: ${why}` : "Shopify could not process this file";
        out.removeIds.push(sm.id);
        delete r.shopifyMediaId;
      } else r.status = "processing";
    } else if (r.terminal) {
      // A failure already recorded stays failed until the item leaves the list.
    } else if (m.type === "photo") {
      out.createPhotos.push(m);
      r.status = "processing";
    } else if (r.resourceUrl) {
      out.attachVideos.push(m);
      r.status = "processing";
    } else if ((r.uploadAttempts || 0) >= MAX_UPLOAD_ATTEMPTS) {
      r.status = "failed";
      r.terminal = true;
      r.note = r.note || `could not be sent to Shopify after ${MAX_UPLOAD_ATTEMPTS} tries`;
    } else if (budget > 0) {
      budget -= 1;
      out.uploadVideos.push(m);
      r.status = "uploading";
    } else {
      out.queuedVideos.push(m);
      r.status = "queued";
    }
    out.status[m.id] = r.note ? { status: r.status, note: r.note } : { status: r.status };
  }

  // Ours, but no longer in the list → off Shopify, and out of the record.
  for (const [itemId, r] of Object.entries(next)) {
    if (desiredIds.has(itemId)) continue;
    if (r.shopifyMediaId && shopById.has(r.shopifyMediaId)) out.removeIds.push(r.shopifyMediaId);
    delete next[itemId];
  }

  // Everything on Shopify that no record names: the pre-tracking set (ours, if
  // the old path's fingerprint proves it attached the product's media) or
  // somebody else's (left alone).
  const recordWasEmpty = Object.keys(record || {}).length === 0;
  for (const n of shopify) {
    if (ownedIds.has(n.id)) continue;
    if (recordWasEmpty && legacyFingerprint) out.legacyIds.push(n.id);
    else out.foreignIds.push(n.id);
  }
  return out;
}

/**
 * The productReorderMedia moves that turn `current` (ids in Shopify's order)
 * into `target` (ours in list order first, then everything else in its
 * current relative order). Simulated exactly as Shopify applies them —
 * sequentially — so the result is checkable. [] when already in order.
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

const EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

/**
 * Stream one video's Storage bytes to a Shopify staged upload, exactly as
 * stored. → resourceUrl. Throws (before anything is recorded) on any failure;
 * the caller counts the attempt. Hash-checked in flight.
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

  const src = await fetchImpl(item.url, { signal: AbortSignal.timeout(60 * 60 * 1000) });
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
    (async () => {
      try {
        if (!req.write(pre)) await new Promise((r) => req.once("drain", r));
        for await (const chunk of src.body) {
          const buf = Buffer.from(chunk);
          sent += buf.length;
          if (sent > Number(item.bytes)) throw new Error("Storage sent more bytes than recorded");
          hash.update(buf);
          if (!req.write(buf)) await new Promise((r) => req.once("drain", r));
        }
        if (sent !== Number(item.bytes)) throw new Error(`Storage sent ${sent} bytes, expected ${item.bytes}`);
        req.end(post);
      } catch (e) { req.destroy(e); reject(e); }
    })();
  });
  const hex = hash.digest("hex");
  if (item.sha256 && hex !== item.sha256) {
    throw new Error(`the bytes in Storage do not match the file Junid picked (sha256 ${hex.slice(0, 12)}… ≠ ${item.sha256.slice(0, 12)}…)`);
  }
  return target.resourceUrl;
}

// ─── ONE PRODUCT ─────────────────────────────────────────────────────────────
/**
 * Bring one product's Shopify media in line with its list.
 *   mode "on"   — the product is OFF the channel (the publish path): photos
 *                 must all be READY before this returns ok (customers never see
 *                 a product without its photos); videos are only QUEUED here —
 *                 the media phase at the end of the tick uploads them.
 *   mode "live" — the product is on the shop: create, reorder, then remove;
 *                 never waits for processing (the next tick polls).
 * → { ok, error?, pending, notes[], writes }
 */
export async function syncProductMedia({ graphql, db, pid, gid, node, product, title, mode = "live",
                                         videoBudget = 0, log = () => {}, uploadVideo = uploadVideoToShopify,
                                         pollMs = 2000, pollTries = 15 }) {
  const alt = String(title ?? "").trim();
  if (!alt) return { ok: false, error: "media alt text requires the validated listing name", pending: true, notes: [], writes: 0 };
  const desired = desiredPushItems(node, product);
  if (!desired.length || desired[0].type !== "photo") {
    return { ok: false, error: "the media list has no photo first — an imageless product is never pushed", pending: false, notes: [], writes: 0 };
  }
  const syncRef = db.ref(`shopify_sync/${pid}`);
  const mapNode = (await syncRef.get()).val() || {};
  const record = mapNode.media?.items || {};
  let shopify = await readProductMedia(graphql, gid);
  if (!shopify) return { ok: false, error: `${gid} not found on Shopify`, pending: true, notes: [], writes: 0 };

  const plan = planMediaSync({ desired, record, shopify, legacyFingerprint: mapNode.mediaFingerprint || null,
                               videoBudget: mode === "on" ? 0 : videoBudget });
  const rec = plan.record;
  const notes = [];
  let writes = 0;
  let uploadsStarted = 0;
  // Written only when it changed — an idle re-run writes nothing anywhere.
  let savedJson = JSON.stringify(record);
  const saveRecord = async () => {
    const json = JSON.stringify(rec);
    if (json === savedJson) return;
    await syncRef.child("media").set(Object.keys(rec).length ? { items: rec } : null);
    savedJson = json;
  };

  try {
    // 1. New photos — one call, ids back in input order.
    if (plan.createPhotos.length) {
      const made = await createMedia(graphql, gid, plan.createPhotos.map((m) =>
        ({ originalSource: m.url, alt, mediaContentType: "IMAGE" })));
      writes += 1;
      plan.createPhotos.forEach((m, k) => { rec[m.id].shopifyMediaId = made[k].id; rec[m.id].createdAt = Date.now(); });
      await saveRecord();
      log(`  media: +${made.length} photo(s)`);
    }
    // 2. Video bytes — exactly once each. The resourceUrl is recorded the
    //    moment Shopify accepts the bytes, BEFORE anything else can fail.
    for (const m of plan.uploadVideos) {
      const r = rec[m.id];
      uploadsStarted += 1;
      // The page says "sending to Shopify" while the bytes are in flight.
      await db.ref(`shopify_publish/${pid}/mediaShopify/${m.id}`).set({ status: "uploading" });
      r.uploadAttempts = (r.uploadAttempts || 0) + 1;
      await saveRecord(); // an attempt is counted even if the process dies mid-transfer
      try {
        log(`  media: sending video ${m.id} (${Math.round(Number(m.bytes) / 1e6)} MB) to Shopify…`);
        r.resourceUrl = await uploadVideo(graphql, m);
        r.uploadedAt = Date.now();
        delete r.note;
        await saveRecord();
        writes += 1;
        plan.attachVideos.push(m);
      } catch (e) {
        r.status = (r.uploadAttempts >= MAX_UPLOAD_ATTEMPTS) ? "failed" : "queued";
        if (r.status === "failed") r.terminal = true;
        r.note = String(e?.message || e).slice(0, 300);
        await saveRecord();
        notes.push(`video ${m.id}: ${r.note}`);
      }
    }
    // 3. Attach videos whose bytes Shopify already holds (never re-sent).
    if (plan.attachVideos.length) {
      try {
        const made = await createMedia(graphql, gid, plan.attachVideos.map((m) =>
          ({ originalSource: rec[m.id].resourceUrl, alt, mediaContentType: "VIDEO" })));
        writes += 1;
        plan.attachVideos.forEach((m, k) => { rec[m.id].shopifyMediaId = made[k].id; rec[m.id].status = "processing"; });
        await saveRecord();
        log(`  media: +${made.length} video(s) attached`);
      } catch (e) {
        for (const m of plan.attachVideos) {
          const r = rec[m.id];
          r.attachAttempts = (r.attachAttempts || 0) + 1;
          r.note = String(e?.message || e).slice(0, 300);
          if (r.attachAttempts >= MAX_UPLOAD_ATTEMPTS) { r.status = "failed"; r.terminal = true; }
        }
        await saveRecord();
        notes.push(`video attach: ${String(e?.message || e)}`);
      }
    }
    // 4. Order: ours in list order first; everything else after, untouched.
    if (writes || plan.removeIds.length || plan.legacyIds.length) shopify = await readProductMedia(graphql, gid);
    const ours = desired.map((m) => rec[m.id]?.shopifyMediaId).filter(Boolean);
    const moves = reorderMoves(shopify.map((n) => n.id), ours);
    if (moves.length) { await reorderMedia(graphql, gid, moves); writes += 1; log(`  media: reordered (${moves.length} move(s))`); }
    // 5. Remove what is ours and no longer wanted — LAST, so a live product is
    //    never without its photos in between. Legacy (pre-tracking) photos go
    //    only once at least the list's photos are attached.
    const legacyNow = plan.legacyIds.filter((id) => shopify.some((n) => n.id === id));
    const photosIn = desired.filter((m) => m.type === "photo").every((m) => rec[m.id]?.shopifyMediaId);
    const removeNow = [...plan.removeIds, ...(photosIn ? legacyNow : [])];
    if (removeNow.length) {
      await deleteMedia(graphql, gid, removeNow);
      writes += 1;
      log(`  media: removed ${removeNow.length} (ours, no longer in the list${photosIn && legacyNow.length ? `, incl. ${legacyNow.length} from before per-item tracking` : ""})`);
    }
    if (plan.foreignIds.length) notes.push(`${plan.foreignIds.length} media on Shopify were not added by this app and were left alone`);

    // 6. The publish path waits for its photos.
    if (mode === "on") {
      const want = new Set(desired.filter((m) => m.type === "photo").map((m) => rec[m.id]?.shopifyMediaId));
      let ready = false;
      for (let t = 0; t < pollTries; t++) {
        const now = await readProductMedia(graphql, gid);
        const mine = now.filter((n) => want.has(n.id));
        if (mine.some((n) => n.status === "FAILED")) {
          return { ok: false, error: "a photo FAILED processing on Shopify — the product must not ship without it", pending: true, notes, writes };
        }
        if (mine.length === want.size && mine.every((n) => n.status === "READY")) {
          ready = true;
          for (const m of desired) if (m.type === "photo") rec[m.id].status = "ready";
          break;
        }
        await sleep(pollMs);
      }
      if (!ready) return { ok: false, error: "the photos were not READY on Shopify after polling — the next run resumes", pending: true, notes, writes };
    }
  } finally {
    await saveRecord();
  }

  // The page's projection + the carry-forward marker + the finished sig.
  const statusMap = {};
  for (const m of desired) {
    const r = rec[m.id] || {};
    statusMap[m.id] = r.note ? { status: r.status || "queued", note: r.note } : { status: r.status || "queued" };
  }
  const pending = desired.some((m) => !["ready", "failed"].includes(statusMap[m.id].status));
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
  return { ok: true, pending, notes, writes, uploadsStarted };
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

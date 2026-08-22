// ─── SOCIAL — CLIENT DATA LAYER ──────────────────────────────────────────────
// Every browser read and write of /social_posts and /social_style_refs, in one
// file. Modelled directly on shopifyPublishStore.js, and for the same reasons:
// bounded partial reads only, merge-only writes, and a refused write comes back
// as a plain sentence rather than a swallowed exception.
//
// ── THE READ RULE ────────────────────────────────────────────────────────────
// Nothing whole-node, nothing eager.
//   · Posts are read per STATUS through the published `status` index, bounded
//     by limitToLast. At three posts a week the node is small — this is not
//     because it is big today, it is because the read shape must not become a
//     whole-node read when it is big in three years.
//   · Style references are read newest-first through the `addedAt` index, one
//     bounded page at a time, with a real cursor (startAt/endAt on the value
//     plus a key) — NOT equalTo, which pins both ends to one key and walks a
//     range of exactly one row. That bug cost the Shopify names lane a
//     thousand unreviewed rows; it is not repeated here.
//   · The grid renders <img loading="lazy"> thumbnails. A VIDEO reference
//     renders its poster image, never a <video> element with a src — a grid of
//     forty videos that each start fetching a body is the whole reason the
//     poster is captured at upload time.
//
// ── THE WRITE RULE ───────────────────────────────────────────────────────────
// update(), never set(), on both nodes. The publisher on the Mac mini writes
// `results` and `status` on the same records this file writes `caption` and
// `scheduledAt` to; a set() here would erase a send result that had just
// landed, and a set() there would erase an edit Junid had just made.
//
// ── RULES ────────────────────────────────────────────────────────────────────
// Both nodes are NEW top-level paths and the live database has no root rule,
// so until the console rules are pasted every read and write here is refused.
// That is not a bug to code around — it is the same door /shopify_publish came
// through. `node scripts/social/print-social-rules.mjs` prints exactly what to
// paste, and writeError() below explains the refusal in a sentence instead of
// a stack trace.
import {
  ref, get, query, orderByChild, equalTo, startAt, endAt, limitToLast, update, push, remove,
} from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { STATUSES, CAPTION_MAX, CAPTION_MIN, PLATFORM_KEYS, MAX_MEDIA } from "./socialCore";

export const POSTS_PATH = "social_posts";
export const REFS_PATH = "social_style_refs";
// Style-reference media and generated post media both live under the Storage
// prefix the AI Studio Style Kit already owns. That is deliberate and it is
// the reason no Storage rule is owed for this feature: `aiStudio/{allPaths=**}`
// is already public-read / super-admin-write in storage.rules, which is
// exactly the access these files need. Writing to a new top-level `social/`
// prefix would have been tidier to look at and dead on arrival.
export const REF_STORAGE_PREFIX = "aiStudio/social/style-refs";
export const POST_STORAGE_PREFIX = "aiStudio/social/posts";

// One page of style references. Sized to fill a grid twice over on a laptop
// without asking for a hundred thumbnails nobody scrolls to.
export const REF_PAGE_SIZE = 24;
// The most posts one status query returns. A status with more than this is a
// backlog, and the queue says so rather than silently showing a slice.
export const POSTS_PER_STATUS = 200;

const safeSeg = (s) => {
  const seg = String(s ?? "");
  if (seg === "" || /[.#$/[\]\s]/.test(seg)) throw new Error(`illegal key: "${seg}"`);
  return seg;
};

const stamp = () => ({ updatedAt: serverNowMs(), updatedBy: auth.currentUser ? auth.currentUser.uid : null });

// RTDB reports the identity gate, a MISSING rule, and a .validate rejection
// all as PERMISSION_DENIED. The copy therefore covers all three without
// claiming which — and names the one that is most likely on a brand-new node.
export function writeError(err) {
  const msg = String(err?.message || err);
  if (/permission[_ ]denied/i.test(msg)) {
    return {
      ok: false,
      message:
        "Not saved — the database refused this write. The social nodes need their " +
        "console rules pasted (run scripts/social/print-social-rules.mjs), and writes " +
        "are limited to Junid or a stock admin. If the rules are already in, check " +
        "you are still signed in and try again.",
    };
  }
  return { ok: false, message: msg };
}

// ── POSTS: READ ──────────────────────────────────────────────────────────────

/**
 * One status' worth of posts, newest first, bounded.
 * Returns { posts: [{ id, ...body }], truncated } — `truncated` is true when
 * the page came back full, so the caller can SAY there may be more instead of
 * quietly implying it has everything.
 */
export async function loadPostsByStatus(status) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const snap = await get(
    query(ref(database, POSTS_PATH), orderByChild("status"), equalTo(status), limitToLast(POSTS_PER_STATUS))
  );
  const val = snap.val() || {};
  const posts = Object.entries(val)
    .map(([id, body]) => ({ id, ...body }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { posts, truncated: posts.length >= POSTS_PER_STATUS };
}

/** Counts per status, for the filter chips. One bounded query each. */
export async function loadStatusCounts() {
  const entries = await Promise.all(
    STATUSES.map(async (s) => {
      const { posts, truncated } = await loadPostsByStatus(s);
      return [s, { count: posts.length, truncated }];
    })
  );
  return Object.fromEntries(entries);
}

// ── POSTS: WRITE ─────────────────────────────────────────────────────────────
// Each of these writes the SMALLEST field set that expresses the decision.
// None of them writes `results` — that belongs to the publisher.

/** Approve. The only transition that lets the publisher touch this item. */
export async function approvePost(postId) {
  return writePost(postId, {
    status: "approved",
    approvedAt: serverNowMs(),
    approvedBy: auth.currentUser ? auth.currentUser.uid : null,
  });
}

/**
 * Send an approved item back to the queue. Used when Junid changes his mind
 * after approving but before the run. Deliberately clears approvedAt: a record
 * that says "approved at 4pm" while sitting in draft is a lie a later reader
 * will trip over.
 */
export async function unapprovePost(postId) {
  return writePost(postId, { status: "draft", approvedAt: null, approvedBy: null });
}

export async function discardPost(postId) {
  return writePost(postId, { status: "discarded", discardedAt: serverNowMs() });
}

/**
 * Put a failed item back in the queue for another look. The per-platform
 * attempt counters are cleared with it — otherwise an item that exhausted its
 * retries would be approved again and refused on the first tick, which reads
 * as the retry being broken.
 */
export async function retryPost(postId) {
  return writePost(postId, { status: "draft", results: null });
}

export async function editCaption(postId, caption) {
  const text = String(caption ?? "").trim();
  if (text.length < CAPTION_MIN) return { ok: false, message: `The caption is too short (minimum ${CAPTION_MIN} characters).` };
  if (text.length > CAPTION_MAX) return { ok: false, message: `The caption is too long (${text.length}; the limit is ${CAPTION_MAX}).` };
  return writePost(postId, { caption: text });
}

export async function reschedulePost(postId, scheduledAt) {
  const at = Number(scheduledAt);
  if (!Number.isFinite(at) || at <= 0) return { ok: false, message: "That is not a valid date and time." };
  return writePost(postId, { scheduledAt: at });
}

export async function setPlatforms(postId, platforms) {
  const next = {};
  for (const k of PLATFORM_KEYS) next[k] = platforms?.[k] === true;
  if (!PLATFORM_KEYS.some((k) => next[k])) {
    return { ok: false, message: "Pick at least one platform." };
  }
  return writePost(postId, { platforms: next });
}

/** Drop one media item from a post (a generated frame Junid does not want). */
export async function setMedia(postId, media) {
  const clean = (Array.isArray(media) ? media : [])
    .filter((m) => m && typeof m.url === "string" && m.url.trim())
    .slice(0, MAX_MEDIA);
  if (!clean.length) return { ok: false, message: "A post needs at least one image or video." };
  return writePost(postId, { media: clean });
}

async function writePost(postId, fields) {
  try {
    await update(ref(database, `${POSTS_PATH}/${safeSeg(postId)}`), { ...fields, ...stamp() });
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
}

// ── STYLE REFERENCE LIBRARY ──────────────────────────────────────────────────

/**
 * One page of references, NEWEST FIRST.
 *
 * The cursor is `before` — the `addedAt` of the oldest row the caller already
 * holds — applied as endAt(before - 1) so the next page starts strictly older.
 * Using the value alone (not equalTo, not a value+key pair) is correct here
 * because addedAt is a millisecond stamp from serverNowMs: two uploads in the
 * same millisecond would share a boundary, so the caller de-duplicates by id
 * (mergeRefPage below) rather than trusting the range to be exclusive.
 *
 * Returns { refs, done }.
 */
export async function loadRefPage({ before = null, pageSize = REF_PAGE_SIZE } = {}) {
  let q = query(ref(database, REFS_PATH), orderByChild("addedAt"), limitToLast(pageSize));
  if (Number.isFinite(before)) {
    q = query(ref(database, REFS_PATH), orderByChild("addedAt"), startAt(0), endAt(before - 1), limitToLast(pageSize));
  }
  const snap = await get(q);
  const val = snap.val() || {};
  const refs = Object.entries(val)
    .map(([id, body]) => ({ id, ...body }))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return { refs, done: refs.length < pageSize };
}

/** Merge a fetched page into the held list, newest first, de-duplicated by id. */
export function mergeRefPage(held, page) {
  const byId = new Map((held || []).map((r) => [r.id, r]));
  for (const r of page || []) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export const REF_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const REF_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const REF_NOTE_MAX = 400;
export const REF_TAG_MAX = 24;
export const REF_TAGS_MAX = 8;

// Same allow-list as broadcastStorage.js, and for the same reason: files
// dragged from Drive or iCloud arrive with an empty MIME, so the extension is
// a real fallback rather than a nicety.
const EXT_BY_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp",
};
const EXT_ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "heic", "mp4", "mov", "webm", "3gp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "3gp"]);
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp",
};

export function resolveRefExt(file) {
  if (file?.type && EXT_BY_MIME[file.type]) return EXT_BY_MIME[file.type];
  const m = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m && EXT_ALLOWED.has(m[1])) return m[1] === "jpeg" ? "jpg" : m[1];
  return null;
}

/** Free-text tags: comma or space separated, lowercased, bounded, de-duplicated. */
export function parseTags(raw) {
  const out = [];
  for (const piece of String(raw || "").split(/[,\n]+/)) {
    const t = piece.trim().toLowerCase().replace(/\s+/g, " ").slice(0, REF_TAG_MAX);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= REF_TAGS_MAX) break;
  }
  return out;
}

/**
 * Upload one style reference and index it.
 *
 * `thumbBlob` is REQUIRED for a video and optional for an image (an image is
 * its own thumbnail if none is given, though the caller should downscale). The
 * caller captures the video poster frame — see StyleLibraryCard — because that
 * is the one moment the video body is already in the browser. The grid must
 * never be the thing that decodes a video.
 */
export async function addStyleRef(file, { note = "", tags = [], thumbBlob = null } = {}) {
  const ext = resolveRefExt(file);
  if (!ext) return { ok: false, message: `Unsupported file: ${file?.type || file?.name || "unknown"}. Allowed: JPG, PNG, WEBP, HEIC, MP4, MOV, WEBM, 3GP.` };
  const isVideo = VIDEO_EXTS.has(ext);
  const cap = isVideo ? REF_VIDEO_MAX_BYTES : REF_IMAGE_MAX_BYTES;
  if (file.size > cap) {
    return { ok: false, message: `${isVideo ? "Video" : "Photo"} too large: ${(file.size / 1048576).toFixed(1)} MB. Max ${Math.round(cap / 1048576)} MB.` };
  }
  if (isVideo && !thumbBlob) {
    // Refusing is better than indexing a video the grid would have to decode
    // to show. If the browser could not read a frame, say so.
    return { ok: false, message: "Couldn't read a still frame from that video — try a different file or format." };
  }

  const refId = `r${serverNowMs()}_${Math.random().toString(36).slice(2, 7)}`;
  const mediaPath = `${REF_STORAGE_PREFIX}/${refId}.${ext}`;
  const thumbPath = `${REF_STORAGE_PREFIX}/${refId}_thumb.jpg`;
  const contentType = file.type || MIME_BY_EXT[ext] || "application/octet-stream";
  // Immutable: every upload writes a unique path, so a cached copy can never
  // go stale. Same treatment the Style Kit refs and product photos get.
  const meta = { cacheControl: "public, max-age=31536000, immutable" };

  try {
    const mRef = storageRef(storage, mediaPath);
    await uploadBytes(mRef, file, { contentType, ...meta });
    const url = await getDownloadURL(mRef);

    let thumbUrl = url;
    if (thumbBlob) {
      const tRef = storageRef(storage, thumbPath);
      await uploadBytes(tRef, thumbBlob, { contentType: "image/jpeg", ...meta });
      thumbUrl = await getDownloadURL(tRef);
    }

    await update(ref(database, `${REFS_PATH}/${refId}`), {
      url,
      path: mediaPath,
      thumbUrl,
      thumbPath: thumbBlob ? thumbPath : null,
      type: isVideo ? "video" : "image",
      note: String(note || "").trim().slice(0, REF_NOTE_MAX),
      tags: parseTags(Array.isArray(tags) ? tags.join(",") : tags),
      enabled: true,
      addedAt: serverNowMs(),
      by: auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null,
    });
    return { ok: true, refId };
  } catch (err) {
    return writeError(err);
  }
}

export async function editStyleRef(refId, { note, tags, enabled } = {}) {
  const fields = {};
  if (note !== undefined) fields.note = String(note || "").trim().slice(0, REF_NOTE_MAX);
  if (tags !== undefined) fields.tags = parseTags(Array.isArray(tags) ? tags.join(",") : tags);
  if (enabled !== undefined) fields.enabled = enabled === true;
  if (!Object.keys(fields).length) return { ok: true };
  try {
    await update(ref(database, `${REFS_PATH}/${safeSeg(refId)}`), fields);
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
}

/**
 * Remove a reference. The RTDB entry is the source of truth, so it goes first;
 * the Storage objects are best-effort behind it. An orphaned object costs a
 * few cents of storage — an index entry pointing at a deleted object is a
 * broken thumbnail in the grid and a failed fetch in the generator.
 */
export async function deleteStyleRef(entry) {
  try {
    // remove() on the CHILD, not an update({id: null}) at the parent: the
    // console rule puts .write on $refId, and a write addressed at the parent
    // node is the shape most likely to be read as "writing /social_style_refs
    // itself", which no rule allows.
    await remove(ref(database, `${REFS_PATH}/${safeSeg(entry.id)}`));
  } catch (err) {
    return writeError(err);
  }
  for (const p of [entry.path, entry.thumbPath]) {
    if (p) deleteObject(storageRef(storage, p)).catch(() => {});
  }
  return { ok: true };
}

// ── A HAND-MADE POST ─────────────────────────────────────────────────────────
// The generator is the normal way in, but Junid must be able to put something
// in the queue himself — a photo he took on the floor, a video he shot. It
// lands as a DRAFT like everything else: this function cannot create an
// approved post, and that is the point.
export async function createManualPost({ media, caption, link = "", platforms, scheduledAt, kind = "single" }) {
  const clean = (Array.isArray(media) ? media : []).filter((m) => m && m.url).slice(0, MAX_MEDIA);
  if (!clean.length) return { ok: false, message: "Attach at least one image or video." };
  const sel = {};
  for (const k of PLATFORM_KEYS) sel[k] = platforms?.[k] === true;
  if (!PLATFORM_KEYS.some((k) => sel[k])) return { ok: false, message: "Pick at least one platform." };
  const text = String(caption || "").trim();
  if (text.length < CAPTION_MIN) return { ok: false, message: `The caption is too short (minimum ${CAPTION_MIN} characters).` };
  try {
    const node = push(ref(database, POSTS_PATH));
    await update(node, {
      status: "draft",
      kind,
      media: clean,
      caption: text.slice(0, CAPTION_MAX),
      link: String(link || ""),
      platforms: sel,
      scheduledAt: Number(scheduledAt) || null,
      products: [],
      generatedBy: "manual",
      createdAt: serverNowMs(),
      ...stamp(),
    });
    return { ok: true, postId: node.key };
  } catch (err) {
    return writeError(err);
  }
}

/** Upload a photo/video Junid attaches to a hand-made post. */
export async function uploadPostMedia(file) {
  const ext = resolveRefExt(file);
  if (!ext) return { ok: false, message: `Unsupported file: ${file?.type || file?.name || "unknown"}.` };
  const isVideo = VIDEO_EXTS.has(ext);
  const cap = isVideo ? REF_VIDEO_MAX_BYTES : REF_IMAGE_MAX_BYTES;
  if (file.size > cap) return { ok: false, message: `Too large: ${(file.size / 1048576).toFixed(1)} MB.` };
  const id = `m${serverNowMs()}_${Math.random().toString(36).slice(2, 7)}`;
  const path = `${POST_STORAGE_PREFIX}/manual/${id}.${ext}`;
  try {
    const r = storageRef(storage, path);
    await uploadBytes(r, file, {
      contentType: file.type || MIME_BY_EXT[ext] || "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
    return { ok: true, media: { url: await getDownloadURL(r), path, type: isVideo ? "video" : "image" } };
  } catch (err) {
    return writeError(err);
  }
}

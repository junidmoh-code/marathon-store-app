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
// ── THE EMPTY-LIST RULE ──────────────────────────────────────────────────────
// RTDB cannot store an empty array: writing `[]` deletes the key, and so does
// removing a list's last child. So every list field here goes IN through
// storedList() — which turns empty into an explicit null, written down in the
// source instead of silently dropped — and comes OUT through asList() in the
// read functions below, so nothing this file returns ever has a null where the
// screen expects an array. utils/rtdbList.js carries the full reasoning,
// including why a sentinel row would be worse than an absent key.
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
import { asList, storedList } from "../../utils/rtdbList";
import { STATUSES, CAPTION_MAX, CAPTION_MIN, PLATFORM_KEYS, MAX_MEDIA } from "./socialCore";

// ── THE BOUNDARY ─────────────────────────────────────────────────────────────
// Every post and every style reference leaves this file through one of these,
// and nothing downstream ever sees a null where an array belongs. Normalising
// HERE, once, is the whole point: guarding the fiftieth `.map` on the screen is
// how the forty-ninth gets missed, and the forty-ninth is what took the card
// down. `id` is stamped in the same pass so a row can always name itself in an
// error, a delete affordance, or a React key.
const POST_LISTS = ["media", "products", "refsUsed"];
const REF_LISTS = ["tags"];

// ── rowKey: DID THIS RECORD ACTUALLY CHANGE? ─────────────────────────────────
// A row's error boundary clears itself when this value moves, so it has to move
// whenever the record does. `updatedAt` alone does NOT: the Mac mini publisher
// writes results through `${POSTS}/${id}/results/${platform}` (markSending and
// recordResult in publish.mjs) and never touches updatedAt — only setStatus
// does. So the field most likely to have been the malformed one is precisely
// the field updatedAt is blind to, and a row broken by a bad `results` entry
// would have stayed latched after the publisher fixed it.
//
// Style references are worse: `addedAt` is written once at creation and never
// again, so editStyleRef — the very thing used to repair a bad `tags` — could
// never have cleared the row.
//
// So the key is built from what each record's row actually reads. Cheap:
// a short string over fields already in memory, no hashing, no serialising of
// media bodies.
const postRowKey = (b) => [
  b.updatedAt || 0, b.status || "", b.kind || "", b.scheduledAt || 0,
  asList(b.media).length, (b.caption || "").length,
  Object.entries(b.results && typeof b.results === "object" ? b.results : {})
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, r]) => `${k}:${(r && r.state) || "?"}:${(r && r.attempts) || 0}`)
    .join(","),
].join("|");

const refRowKey = (b) => [
  b.addedAt || 0, b.enabled === true ? 1 : 0, (b.note || "").length,
  asList(b.tags).join(","), b.thumbUrl || b.url || "",
].join("|");

function normaliseRecord(id, body, listFields, rowKeyOf) {
  const rec = { ...(body && typeof body === "object" ? body : {}), id };
  for (const f of listFields) rec[f] = asList(rec[f]);
  rec.rowKey = rowKeyOf(rec);
  return rec;
}

export const normalisePost = (id, body) => normaliseRecord(id, body, POST_LISTS, postRowKey);
export const normaliseRef = (id, body) => normaliseRecord(id, body, REF_LISTS, refRowKey);

export const POSTS_PATH = "social_posts";
export const REFS_PATH = "social_style_refs";
// The daily-rhythm policy: how many reels/photos/stories a day and at what
// SAST times. Read by the browser's Policy tab and by socialDailyAutopilot
// (functions/index.js) — the ONE thing that actually acts on it. A missing
// node means the function's own built-in defaults, not a broken feature; see
// DEFAULT_POLICY_TIMES below, which mirrors functions/index.js's own default.
export const POLICY_PATH = "social_policy";
// Style-reference media and generated post media both live under the Storage
// prefix the AI Studio Style Kit already owns. That is deliberate and it is
// the reason no Storage rule is owed for this feature: `aiStudio/{allPaths=**}`
// is already public-read / super-admin-write in storage.rules, which is
// exactly the access these files need. Writing to a new top-level `social/`
// prefix would have been tidier to look at and dead on arrival.
export const ALBUM_PATH = "social_library";
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
    .map(([id, body]) => normalisePost(id, body))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { posts, truncated: posts.length >= POSTS_PER_STATUS };
}

/**
 * A queue TAB's worth of posts — one or more statuses folded into one list,
 * newest first, bounded per status the same way loadPostsByStatus is. A tab
 * like "Approved" (statuses: ["approved", "posting"]) runs one indexed query
 * per status and merges, rather than one unindexed scan; RTDB has no "status
 * in [...]" query, so this is the bounded shape that stays possible.
 */
export async function loadPostsByStatuses(statuses) {
  const pages = await Promise.all(asList(statuses).map((s) => loadPostsByStatus(s)));
  const posts = pages.flatMap((p) => p.posts).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { posts, truncated: pages.some((p) => p.truncated) };
}

// ── THE DAILY-RHYTHM POLICY ──────────────────────────────────────────────────
// One small node, one reader that matters: functions/index.js's
// socialDailyAutopilot reads this every morning to decide how many reels,
// photos and stories to make and at what SAST times. Mirrored here — NOT the
// same values enforced by any test, unlike the schedule-slot constants — so a
// drift between this pre-fill and the function's own fallback is cosmetic
// (a slightly wrong suggestion on first load) rather than load-bearing. The
// number that actually governs anything is whatever is SAVED in RTDB.
export const DEFAULT_POLICY_TIMES = {
  reels: ["08:00"],
  photos: ["11:00"],
  stories: ["09:00", "13:00", "17:00"],
};

/**
 * Read the policy. `saved` says whether /social_policy has ever been WRITTEN
 * — not whether any of the three lists is non-empty, which is a different
 * question. An intentional "0 reels, 0 photos, 0 stories" is a real saved
 * policy (all-off), and it looks identical to a policy that was never saved
 * at all UNLESS the caller can tell the two apart: both come back as three
 * empty arrays otherwise. `updatedAt` exists on the record the moment it is
 * saved for the first time, all-off included, so its presence is the signal.
 */
export async function loadSocialPolicy() {
  const snap = await get(ref(database, POLICY_PATH));
  const v = snap.val();
  return {
    reels: asList(v?.reels?.times),
    photos: asList(v?.photos?.times),
    stories: asList(v?.stories?.times),
    saved: !!v?.updatedAt,
  };
}

/**
 * Save the whole policy in one write. `times` fields go through storedList()
 * so a format with zero posts a day (an empty list) is written down as an
 * explicit "none" rather than silently vanishing — see the file header's
 * empty-list rule.
 */
export async function saveSocialPolicy({ reels, photos, stories }) {
  try {
    await update(ref(database, POLICY_PATH), {
      reels: { times: storedList(reels) },
      photos: { times: storedList(photos) },
      stories: { times: storedList(stories) },
      ...stamp(),
    });
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
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
/**
 * Publish an approved item at the next tick instead of waiting for its slot.
 *
 * ── WHY THIS ONLY MOVES A DATE ───────────────────────────────────────────────
 * It would be wrong for the browser to publish. The Meta credentials live in
 * Secret Manager and are read by the Mac mini; a browser path to them is a
 * browser path to the shop's Instagram. And a second publisher would be a
 * second copy of the send logic, the claim transaction and the retry rules —
 * two implementations that must agree forever about what has already gone out.
 *
 * So "post now" says the one thing that actually matters: this is due NOW. The
 * publisher on the mini, which is the only thing that has ever posted, picks it
 * up on its next tick and applies every existing gate — postBlocker, the claim
 * transaction, the per-platform attempt limits. Nothing is bypassed and nothing
 * is duplicated.
 *
 * The status is deliberately NOT touched. It is already "approved"; changing it
 * would lose the record of when Junid approved it.
 */
export async function postNow(postId) {
  return writePost(postId, { scheduledAt: serverNowMs(), postNowAt: serverNowMs() });
}

export async function unapprovePost(postId) {
  return writePost(postId, { status: "draft", approvedAt: null, approvedBy: null });
}

export async function discardPost(postId) {
  return writePost(postId, { status: "discarded", discardedAt: serverNowMs() });
}

/**
 * Put a failed item back in the queue for another look.
 *
 * ── WHAT IT CLEARS, AND WHAT IT MUST NOT ────────────────────────────────────
 * The obvious version writes `results: null`, and that is a double-post
 * waiting to happen. It deletes the WHOLE results subtree — including every
 * platform recorded "ok", and including the "sending" marker that is the only
 * thing standing between an unconfirmed send and a second live post. A post
 * that reached Instagram and stalled on Facebook would, after one tap of this
 * button, be re-sent to BOTH.
 *
 * So it clears only what is safe to clear: errored platforms, and only their
 * attempt counters. An "ok" result is a fact about the world and is kept
 * forever. A "sending" result is an open question and is kept until a person
 * answers it — see resolveSending.
 *
 * ── AND IT NO LONGER TRUSTS THE SCREEN'S COPY OF `results` ──────────────────
 * The version that took `post` and rebuilt the whole `results` object from it
 * did not actually hold the guarantee two paragraphs up. update() REPLACES the
 * child it is given: writing `results: {...}` swaps the entire subtree for
 * whatever the browser last loaded. The queue is not polled continuously — it
 * polls only while something is due and unclaimed — so the tab's copy of a post
 * goes stale the moment the Mac mini writes a result.
 *
 * That is a duplicate public post, by this exact route: Junid loads the queue
 * with instagram and facebook both "sending"; the publisher confirms both in
 * the database; Junid, still looking at the old screen, taps Retry. The stale
 * copy said "sending", so "sending" is what gets written back over two "ok"s,
 * and the next run sees two platforms that were never sent and sends them
 * again — to live accounts, permanently.
 *
 * So two things changed. It re-reads `results` from the DATABASE rather than
 * taking the caller's word for it, and it writes ONE PATH PER PLATFORM
 * (`results/instagram`) instead of the parent. A per-platform write cannot
 * replace a sibling it never named, so even a result that lands between the
 * read and the write survives. `post` is still accepted and ignored, so no
 * caller breaks.
 */
export async function retryPost(postId, post = null) {   // eslint-disable-line no-unused-vars
  // The WHOLE body is inside the try, not just the read. safeSeg throws on a
  // key it will not touch, and the old shape had it inside writePost's try —
  // hoisting it out would have turned a refusal sentence into an unhandled
  // rejection escaping the row's click handler.
  try {
    const id = safeSeg(postId);
    // A refused or failed read must NOT fall back to the caller's copy or to
    // {} — either would clear results this function cannot see. The catch
    // below refuses the whole operation instead.
    const snap = await get(ref(database, `${POSTS_PATH}/${id}/results`));
    const results = snap.val() || {};
    const fields = { status: "draft", needsCheck: null };
    for (const [key, r] of Object.entries(results)) {
      if (!r || typeof r !== "object") continue;
      if (r.state === "ok" || r.state === "sending") continue;   // a fact, or an open question
      // Deleting the platform's whole record takes its `attempts` counter with
      // it, which is what lets an exhausted platform try again — the same
      // clearing the previous version did, by the same means.
      fields[`results/${safeSeg(key)}`] = null;
    }
    return writePost(id, fields);
  } catch (err) {
    return writeError(err);
  }
}

/**
 * Answer the one question the publisher cannot: did this actually post?
 *
 * A "sending" record means we asked a platform to publish and never learned the
 * answer. The publisher will not guess — guessing wrong posts twice — so it
 * holds the item and asks. This is the control that lets the answer be given.
 *
 * `didPost: true`  → recorded as posted. Nothing is ever sent for it again.
 * `didPost: false` → recorded as an error, so the ordinary retry path applies.
 *
 * Without this the held state was a dead end: the only button on a failed post
 * wiped the results, which re-sent everything.
 */
export async function resolveSending(postId, platformKey, didPost) {
  if (!PLATFORM_KEYS.includes(platformKey)) return { ok: false, message: `Unknown platform "${platformKey}".` };
  try {
    await update(ref(database, `${POSTS_PATH}/${safeSeg(postId)}/results/${safeSeg(platformKey)}`), {
      state: didPost ? "ok" : "error",
      error: didPost ? null : "an earlier send was never confirmed; marked as not posted by hand",
      resolvedByHand: true,
      at: serverNowMs(),
    });
    return { ok: true };
  } catch (err) {
    return writeError(err);
  }
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
  const clean = asList(media)
    .filter((m) => m && typeof m.url === "string" && m.url.trim())
    .slice(0, MAX_MEDIA);
  if (!clean.length) return { ok: false, message: "A post needs at least one image or video." };
  return writePost(postId, { media: storedList(clean) });
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
 * ── THE CURSOR IS INCLUSIVE, AND THAT IS THE POINT ──────────────────────────
 * `before` is the `addedAt` of the oldest row the caller already holds, applied
 * as endAt(before) — INCLUSIVE, deliberately.
 *
 * The exclusive version, endAt(before - 1), silently loses rows. limitToLast on
 * a value index breaks ties by KEY, so when a page boundary falls inside a
 * group of references sharing one `addedAt` — two files selected in the same
 * upload, which is the normal way this library is filled — the page returns
 * some of that group and `before` becomes their shared timestamp. Asking for
 * `< before` then skips the rest of the group PERMANENTLY: they appear in no
 * page, and "Load more" walks straight past them.
 *
 * Inclusive re-fetches the boundary rows instead, and mergeRefPage keys by id,
 * so a re-fetched row is merged rather than duplicated. The cost is up to
 * pageSize wasted rows in the pathological case; the alternative loses data.
 *
 * `done` is judged on page LENGTH. A full page carrying nothing new is not the
 * end of the list — it is a tie group at least a page wide — so that case steps
 * the cursor past the tie and walks on. Judging `done` on freshness alone would
 * stop dead there and make every older reference unreachable, which is the same
 * data loss as the exclusive cursor, arrived at from the other direction.
 *
 * Returns { refs, done }.
 */
export async function loadRefPage({ before = null, pageSize = REF_PAGE_SIZE, held = null, _stepped = false } = {}) {
  let q = query(ref(database, REFS_PATH), orderByChild("addedAt"), limitToLast(pageSize));
  if (Number.isFinite(before)) {
    q = query(ref(database, REFS_PATH), orderByChild("addedAt"), startAt(0), endAt(before), limitToLast(pageSize));
  }
  const snap = await get(q);
  const val = snap.val() || {};
  const refs = Object.entries(val)
    .map(([id, body]) => normaliseRef(id, body))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const heldIds = held instanceof Set ? held : new Set((held || []).map((r) => r && r.id));
  const fresh = refs.filter((r) => !heldIds.has(r.id));

  // A FULL page with nothing new means the boundary timestamp is shared by at
  // least a whole page of references. Step past it rather than stopping — one
  // extra query, and only in a case that needs `pageSize` uploads inside the
  // same millisecond. `_stepped` bounds it to a single retry so no input can
  // make this recurse.
  if (before !== null && refs.length >= pageSize && fresh.length === 0 && !_stepped) {
    return loadRefPage({ before: before - 1, pageSize, held, _stepped: true });
  }

  return { refs, done: refs.length < pageSize };
}

/** Merge a fetched page into the held list, newest first, de-duplicated by id. */
export function mergeRefPage(held, page) {
  const byId = new Map(asList(held).filter((r) => r && r.id).map((r) => [r.id, r]));
  for (const r of asList(page)) if (r && r.id) byId.set(r.id, r);
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
      // storedList, not the bare array: no tags is an EXPLICIT null here
      // rather than an `[]` the database silently drops. See utils/rtdbList.js.
      tags: storedList(parseTags(Array.isArray(tags) ? tags.join(",") : tags)),
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
  if (tags !== undefined) fields.tags = storedList(parseTags(Array.isArray(tags) ? tags.join(",") : tags));
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
  const clean = asList(media).filter((m) => m && m.url).slice(0, MAX_MEDIA);
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
      media: storedList(clean),
      caption: text.slice(0, CAPTION_MAX),
      link: String(link || ""),
      platforms: sel,
      scheduledAt: Number(scheduledAt) || null,
      // A hand-made post has no products. That is an absent key, written down.
      products: storedList([]),
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


// ── READING THE PERMANENT ALBUM ──────────────────────────────────────────────
// /social_library is append-only: the generator writes an entry as it writes
// the post, and nothing in this app ever deletes one. So this is a plain read
// with no subscription — the album does not change while you are looking at
// it, and a live listener on a node that only ever grows is a bill, not a
// feature.
export async function loadAlbum() {
  try {
    const snap = await get(ref(database, ALBUM_PATH));
    return { ok: true, raw: snap.val() || {} };
  } catch (err) {
    return { ...writeError(err), raw: {} };
  }
}

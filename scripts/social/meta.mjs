// ── INSTAGRAM + FACEBOOK PUBLISHING (Meta Graph API) ─────────────────────────
// Everything this program knows about posting to Instagram and to a Facebook
// Page. The I/O is at the bottom; the URL and payload shaping at the top is
// pure and node-tested, because a payload built wrong fails as an opaque HTTP
// 400 from a service we cannot single-step.
//
// ── HOW INSTAGRAM PUBLISHING ACTUALLY WORKS ──────────────────────────────────
// It is two calls, and a third for a carousel. You never upload bytes to Meta:
// you give it a PUBLIC URL and it fetches the image itself.
//
//   1. POST /{ig-user-id}/media  { image_url, caption }      → creation_id
//   2. POST /{ig-user-id}/media_publish { creation_id }      → the post
//
// For a carousel each child is step 1 with is_carousel_item=true and NO
// caption, then a parent container with media_type=CAROUSEL, children=[…] and
// the caption, then step 2 on the parent.
//
// For a reel it is media_type=REELS with video_url, and the container is NOT
// ready immediately — Meta transcodes, and publishing before it finishes
// fails. So a video container is POLLED on status_code until FINISHED. This is
// the part that most often goes wrong in the wild and the reason
// waitForContainer exists rather than a fixed sleep.
//
// Our images are Firebase Storage download URLs. They are public
// (storage.rules allows read on aiStudio/** and products/**), which is exactly
// what Meta's fetcher needs, and they carry a random token, which means the
// URL is unguessable but not private. Nothing here makes anything MORE public
// than the storefront already does.
//
// ── FACEBOOK PAGE POSTING ────────────────────────────────────────────────────
// Simpler and older: POST /{page-id}/photos with url + caption for one image;
// for several, upload each with published=false to get media_fbids and attach
// them to a POST /{page-id}/feed. Videos go to /{page-id}/videos.
//
// ── THE TOKEN ────────────────────────────────────────────────────────────────
// One never-expiring Page access token does BOTH: Instagram publishing is
// authorised by the token of the Page the Instagram account is connected to.
// See scripts/social/meta-token.mjs for how it is minted and why it does not
// expire.
//
// ── RATE ────────────────────────────────────────────────────────────────────
// Instagram allows 100 API-published posts per rolling 24 hours (a carousel
// counts as one). At three posts a week this is not a limit we can reach by
// accident, and there is deliberately no client-side throttle pretending to
// enforce it — a limiter for a ceiling 200x above our volume is code that is
// never exercised and therefore never correct.

// The Graph API version this program is written against. PINNED on purpose:
// Meta deprecates versions on a schedule and an unpinned "latest" turns a
// working publisher into a silent failure on a date nobody chose. Bumping this
// is a deliberate act with a re-test behind it.
export const GRAPH_VERSION = "v21.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// How long to wait for Meta to finish ingesting a video container before
// giving up. Meta's own guidance is that a reel container is usually ready in
// under a minute; five is generous and still bounded, so a stuck container
// fails the run loudly instead of holding the launchd job open forever.
export const CONTAINER_POLL_MS = 5000;
// Hard ceiling on any single HTTP call to Meta.
export const REQUEST_TIMEOUT_MS = 60000;
export const CONTAINER_MAX_WAIT_MS = 5 * 60 * 1000;

/** Is this a video? Decided from the record's own type, never from the URL. */
export const isVideo = (m) => m && m.type === "video";

/**
 * The container payload for one Instagram media item.
 * `carouselChild` suppresses the caption: Meta rejects a caption on a child,
 * and the parent carries it.
 */
export function igContainerPayload(item, { caption = null, carouselChild = false, format = "feed" } = {}) {
  const payload = {};
  // ── STORIES ARE THEIR OWN media_type, FOR EITHER MEDIUM ────────────────────
  // A story can be a photo or a video and is media_type=STORIES either way —
  // it is NOT "a feed post that happens to be 9:16". Verified against the live
  // account: a STORIES container with an image_url was accepted.
  //
  // A story also takes NO CAPTION. Meta ignores the field, and passing it makes
  // a caption that was written, reviewed and approved silently vanish — which
  // is why the caption is dropped here explicitly rather than left to be
  // ignored. Everything a story has to say is composited onto the artwork,
  // including the address, because the API cannot attach a link sticker.
  if (format === "story") {
    payload.media_type = "STORIES";
    if (isVideo(item)) payload.video_url = item.url;
    else payload.image_url = item.url;
    return payload;
  }
  if (isVideo(item)) {
    payload.media_type = "REELS";
    payload.video_url = item.url;
  } else {
    payload.image_url = item.url;
  }
  if (carouselChild) payload.is_carousel_item = "true";
  else if (caption != null) payload.caption = caption;
  return payload;
}

/**
 * Facebook's story endpoints, which are NOT the Page feed.
 *
 * A photo story is two calls: upload the photo UNPUBLISHED to /photos to get an
 * id, then POST that id to /photo_stories. A video story goes to /video_stories.
 * Neither takes a message — same as Instagram, everything is on the artwork.
 */
export function fbStoryEndpoint(item) {
  return isVideo(item) ? "video_stories" : "photo_stories";
}

/**
 * A Facebook story succeeded if Meta said so — and it says so in a shape
 * NOTHING ELSE in this API uses.
 *
 * /photos, /videos and /feed all answer with `{ id }`. The story endpoints
 * answer with `{ success: true, post_id: "…" }` — no `id` key at all.
 * Verified against the live Page on 2026-08-27:
 *
 *   POST /{page}/photos?published=false  → {"id":"1062362476170688"}
 *   POST /{page}/photo_stories           → {"success":true,"post_id":"3024988904507445"}
 *
 * Reading `id` off that response yields undefined, which would be stored as
 * the post's Facebook id and make a successful story indistinguishable from a
 * broken one forever after. Hence one function, tested, rather than a `.id`
 * at each call site.
 */
export function fbStoryResultId(res) {
  const id = res && (res.post_id ?? res.id);
  if (!id) throw new Error(`Facebook accepted the story but returned no post id: ${JSON.stringify(res)}`);
  return String(id);
}

/** The parent payload for a carousel of already-created children. */
export function igCarouselPayload(childIds, caption) {
  if (!Array.isArray(childIds) || childIds.length < 2) {
    throw new Error(`a carousel needs at least 2 children, got ${childIds?.length ?? 0}`);
  }
  if (childIds.length > 10) {
    throw new Error(`Instagram takes at most 10 carousel items, got ${childIds.length}`);
  }
  return { media_type: "CAROUSEL", children: childIds.join(","), caption };
}

/**
 * Turn Meta's error body into one readable sentence.
 *
 * This matters more than it looks. Meta returns HTTP 400 for everything from
 * "your token expired" to "that image is 2 pixels too tall", and a publisher
 * that logs `HTTP 400` has told the operator nothing. The message, the
 * subcode and the user-facing title are the three fields that actually say
 * what happened.
 */
export function metaError(status, body) {
  let e = null;
  try { e = typeof body === "string" ? JSON.parse(body).error : body?.error; } catch { /* not json */ }
  if (!e) return `HTTP ${status}: ${String(body).slice(0, 200)}`;
  const bits = [e.message];
  if (e.error_user_title && e.error_user_title !== e.message) bits.push(e.error_user_title);
  if (e.error_user_msg) bits.push(e.error_user_msg);
  const codes = [e.code, e.error_subcode].filter(Boolean).join("/");
  return `${bits.filter(Boolean).join(" — ")}${codes ? ` [${codes}]` : ""}`;
}

/**
 * Is this failure worth retrying on the next scheduled run?
 *
 * A transient failure (rate limit, Meta 5xx, a network blip) should come back
 * on Wednesday. A permanent one (the token was revoked, the image is the wrong
 * aspect ratio) will fail identically forever, and retrying it three more
 * times only buries the real message under three more copies of itself. Both
 * end up visible; only the transient one is tried again.
 */
// Meta's throttling codes. They arrive as HTTP 400, not 429 — checking only
// the status code meant a throttled Monday evening permanently parked the
// week's post after one attempt.
//   4   Application request limit reached
//   17  User request limit reached
//   32  Page request limit reached
//   613 Calls to this api have exceeded the rate limit
//   1   / 2  transient "unknown"/"service" errors Meta tells you to retry
const RETRYABLE_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
// 190 = token problems (expired, revoked, invalidated). A retry cannot fix any
// of them; only re-minting the token can, so retrying is four identical lines
// in a log and four wasted attempts.
const PERMANENT_META_CODES = new Set([190, 200, 10, 803]);

export function isRetryable(status, message, code = null) {
  if (code != null) {
    if (PERMANENT_META_CODES.has(Number(code))) return false;
    if (RETRYABLE_META_CODES.has(Number(code))) return true;
  }
  if (status >= 500) return true;
  if (status === 429) return true;
  const m = String(message || "");
  if (/\[190/.test(m)) return false;
  if (/rate limit|too many|temporar|try again|timeout|unknown error|please reduce|reduce the amount/i.test(m)) return true;
  return false;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

async function graph(path, { method = "GET", token, params = {} } = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (method === "GET") url.searchParams.set(k, String(v));
    else body.set(k, String(v));
  }
  // The token goes in the Authorization header, never the query string: a URL
  // ends up in access logs, in error messages and in stack traces, and this
  // program's whole discipline is that the token appears in none of those.
  // ── A NETWORK FAILURE IS THE MOST RETRYABLE THING THERE IS ───────────────
  // fetch() REJECTS on DNS failure, a dropped connection, a reset socket — it
  // does not return a status. Those errors escaped with no `.retryable`, the
  // publisher read that as permanent, and one flaky moment on the mini's Wi-Fi
  // parked the week's post in Failed after a single attempt. There is also a
  // hard timeout: without one a hung socket holds the launchd job open for
  // undici's default five minutes on top of every other wait.
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      ...(method === "GET" ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `the request to Meta timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `could not reach Meta: ${String(err?.message || err)}`
    );
    e.status = 0;
    e.retryable = true;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    let code = null;
    try { code = (typeof text === "string" ? JSON.parse(text) : text)?.error?.code ?? null; } catch { /* not json */ }
    const err = new Error(metaError(res.status, text));
    err.status = res.status;
    err.code = code;
    err.retryable = isRetryable(res.status, err.message, code);
    throw err;
  }
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Wait for a media container to finish ingesting.
 * Images are ready immediately; videos are transcoded and are NOT. Publishing
 * an unfinished container is the single most common way this API fails in
 * production, so every video container goes through here.
 */
export async function waitForContainer(containerId, token, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + CONTAINER_MAX_WAIT_MS;
  for (;;) {
    const { status_code: code, status } = await graph(containerId, { token, params: { fields: "status_code,status" } });
    if (code === "FINISHED") return true;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Meta could not ingest the media (${code})${status ? `: ${status}` : ""}`);
    }
    if (Date.now() >= deadline) {
      const e = new Error(`Meta was still processing the media after ${CONTAINER_MAX_WAIT_MS / 60000} minutes (last state: ${code || "unknown"})`);
      e.retryable = true;   // it may well finish before the next run
      throw e;
    }
    await sleep(CONTAINER_POLL_MS);
  }
}

/**
 * Publish one post to Instagram.
 * @returns { id, permalink }
 */
export async function publishInstagram({ igUserId, token, media, caption, sleep, format = "feed" }) {
  const items = (media || []).filter((m) => m && m.url);
  if (!items.length) throw new Error("no media to publish");
  if (items.length > 10) throw new Error(`Instagram takes at most 10 items, got ${items.length}`);

  // ── A STORY IS ONE ITEM ────────────────────────────────────────────────────
  // There is no such thing as a story carousel on this API. Refused here rather
  // than sent, because Meta's failure for it is an opaque 400 and the post
  // would be parked as "failed" with nothing readable to act on.
  if (format === "story" && items.length > 1) {
    throw new Error(`a story takes one item, got ${items.length}`);
  }

  let containerId;
  if (items.length === 1) {
    const { id } = await graph(`${igUserId}/media`, {
      method: "POST", token, params: igContainerPayload(items[0], { caption, format }),
    });
    containerId = id;
    if (isVideo(items[0])) await waitForContainer(containerId, token, { sleep });
  } else {
    const childIds = [];
    for (const item of items) {
      const { id } = await graph(`${igUserId}/media`, {
        method: "POST", token, params: igContainerPayload(item, { carouselChild: true }),
      });
      if (isVideo(item)) await waitForContainer(id, token, { sleep });
      childIds.push(id);
    }
    const { id } = await graph(`${igUserId}/media`, {
      method: "POST", token, params: igCarouselPayload(childIds, caption),
    });
    containerId = id;
  }

  const { id: postId } = await graph(`${igUserId}/media_publish`, {
    method: "POST", token, params: { creation_id: containerId },
  });
  // Best-effort permalink: the post exists whether or not we can read this
  // back, so a failure here must not turn a successful publish into a failure.
  let permalink = null;
  try { ({ permalink } = await graph(postId, { token, params: { fields: "permalink" } })); } catch { /* not fatal */ }
  return { id: postId, permalink };
}

/**
 * Publish one post to a Facebook Page.
 *
 * One photo goes straight to /photos. Several are uploaded UNPUBLISHED first —
 * that is the only way to get a multi-photo Page post, and it is why a partial
 * failure here can leave orphaned unpublished photos in the Page's library.
 * That is Meta's model, not a bug in this code; the alternative (posting the
 * first photo alone) would be worse.
 */
export async function publishFacebook({ pageId, token, media, caption, sleep }) {
  const items = (media || []).filter((m) => m && m.url);
  if (!items.length) throw new Error("no media to publish");

  const videos = items.filter(isVideo);
  if (videos.length) {
    if (items.length > 1) throw new Error("a Facebook post takes either one video or several photos, not both");
    const { id } = await graph(`${pageId}/videos`, {
      method: "POST", token, params: { file_url: videos[0].url, description: caption },
    });
    return { id, permalink: `https://facebook.com/${id}` };
  }

  if (items.length === 1) {
    const { post_id: postId, id } = await graph(`${pageId}/photos`, {
      method: "POST", token, params: { url: items[0].url, caption },
    });
    const ref = postId || id;
    return { id: ref, permalink: `https://facebook.com/${ref}` };
  }

  const fbids = [];
  for (const item of items) {
    const { id } = await graph(`${pageId}/photos`, {
      method: "POST", token, params: { url: item.url, published: "false" },
    });
    fbids.push(id);
  }
  const params = { message: caption };
  fbids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const { id: postId } = await graph(`${pageId}/feed`, { method: "POST", token, params });
  return { id: postId, permalink: `https://facebook.com/${postId}` };
}

/**
 * Publish one STORY to a Facebook Page.
 *
 * This is a different API from the Page feed, not a variant of it, which is
 * why it is its own function rather than a flag on publishFacebook. Confirmed
 * against the live Page on 2026-08-27 — see fbStoryResultId for the exact
 * request/response pair.
 *
 * A PHOTO story is two calls:
 *   1. POST /{page}/photos  { url, published: false }   → { id }
 *   2. POST /{page}/photo_stories { photo_id }          → { success, post_id }
 * Step 1 is the same unpublished upload the multi-photo feed post already
 * uses; only step 2 is new. The photo is never visible as a Page post.
 *
 * A VIDEO story is a three-phase resumable upload, because /video_stories does
 * NOT accept a file_url the way /videos does — Meta fetches nothing here, we
 * push the bytes:
 *   1. POST /{page}/video_stories { upload_phase: "start" } → { video_id, upload_url }
 *   2. POST upload_url with the raw bytes
 *   3. POST /{page}/video_stories { upload_phase: "finish", video_id } → { success, post_id }
 *
 * NO CAPTION, on either medium. Meta's story endpoints take no message field
 * at all — everything a story says is composited onto the artwork, exactly as
 * on Instagram. The caption is therefore not passed rather than passed and
 * ignored, so one place decides and there is nothing to silently drop.
 *
 * The PERMALINK is best-effort and deliberately so. A story's URL is not in
 * the publish response; it has to be read back from GET /{page}/stories, whose
 * `url` field is the shareable link. If that read fails the story still
 * exists, so a failure there must never turn a successful publish into a
 * failed one — the same rule publishInstagram already follows.
 */
export async function publishFacebookStory({ pageId, token, media, sleep }) {
  const items = (media || []).filter((m) => m && m.url);
  if (!items.length) throw new Error("no media to publish");
  // A story is one item on Facebook for the same reason it is on Instagram:
  // there is no story carousel in this API. Refused here rather than sent,
  // because Meta's failure for it is an opaque 400.
  if (items.length > 1) throw new Error(`a story takes one item, got ${items.length}`);
  const item = items[0];

  let res;
  if (isVideo(item)) {
    const start = await graph(`${pageId}/video_stories`, {
      method: "POST", token, params: { upload_phase: "start" },
    });
    if (!start?.video_id || !start?.upload_url) {
      throw new Error(`Facebook did not open a video-story upload session: ${JSON.stringify(start)}`);
    }
    await uploadStoryVideoBytes(start.upload_url, item.url, token);
    res = await graph(`${pageId}/video_stories`, {
      method: "POST", token,
      params: { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED" },
    });
  } else {
    // published:false — the photo must exist as an asset without ever
    // appearing on the Page's timeline. This is the same call the multi-photo
    // feed path makes; only what we do with the id differs.
    const { id: photoId } = await graph(`${pageId}/photos`, {
      method: "POST", token, params: { url: item.url, published: "false" },
    });
    if (!photoId) throw new Error("Facebook returned no photo id for the story upload");
    res = await graph(`${pageId}/photo_stories`, {
      method: "POST", token, params: { photo_id: photoId },
    });
  }

  const id = fbStoryResultId(res);
  let permalink = null;
  try { permalink = await fbStoryPermalink({ pageId, token, postId: id, sleep }); } catch { /* not fatal */ }
  return { id, permalink };
}

/**
 * Push the video bytes to the session URL Meta handed back.
 *
 * Deliberately streams from OUR public URL into memory once rather than
 * chunking: a story video is seconds long and a few megabytes, and a resumable
 * multi-chunk uploader is a lot of untested machinery for a file that fits in
 * one request. `offset: 0` + the full `file_size` is the single-chunk form of
 * the same protocol.
 *
 * The upload host is rupload.facebook.com, not graph.facebook.com, and it
 * wants `Authorization: OAuth <token>` — NOT `Bearer`. That difference is the
 * whole reason this does not go through graph().
 */
async function uploadStoryVideoBytes(uploadUrl, sourceUrl, token) {
  let bytes;
  try {
    const src = await fetch(sourceUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!src.ok) throw new Error(`HTTP ${src.status}`);
    bytes = Buffer.from(await src.arrayBuffer());
  } catch (err) {
    const e = new Error(`could not read the story video from storage: ${String(err?.message || err)}`);
    e.retryable = true;
    throw e;
  }
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(bytes.length),
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`could not reach Meta's upload host: ${String(err?.message || err)}`);
    e.status = 0;
    e.retryable = true;
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(metaError(res.status, text));
    err.status = res.status;
    err.retryable = isRetryable(res.status, err.message);
    throw err;
  }
}

/**
 * The shareable URL of a story we just posted, or null.
 *
 * GET /{page}/stories lists the Page's live stories with a `url` — matched on
 * post_id rather than assumed to be first, because a story posted seconds
 * earlier by anything else would otherwise hand back the wrong link.
 *
 * IT IS RETRIED, because the list lags the publish. Measured against the live
 * Page on 2026-08-27: a PHOTO story appeared in this list immediately, and a
 * VIDEO story published at the same moment did not — its first read returned
 * nothing and a read moments later returned the url. A single attempt would
 * therefore have recorded every video story with a null permalink, which reads
 * exactly like a story that did not publish.
 *
 * Still best-effort, and deliberately so: the story EXISTS whether or not we
 * can read its link back, so exhausting the attempts returns null rather than
 * throwing. Turning a successful publish into a failure over a cosmetic field
 * would be the worse bug — the same rule publishInstagram follows.
 */
export const STORY_PERMALINK_ATTEMPTS = 4;
export const STORY_PERMALINK_GAP_MS = 2000;

export async function fbStoryPermalink({ pageId, token, postId, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  for (let attempt = 0; attempt < STORY_PERMALINK_ATTEMPTS; attempt++) {
    if (attempt) await sleep(STORY_PERMALINK_GAP_MS);
    const res = await graph(`${pageId}/stories`, { token, params: { fields: "post_id,url,status" } });
    const row = (res?.data || []).find((r) => String(r.post_id) === String(postId));
    if (row?.url) return row.url;
  }
  return null;
}

/** Read-only preflight: does this token still work, and on what? Never prints it. */
export async function metaPreflight({ token, pageId, igUserId }) {
  const out = { page: null, instagram: null };
  const page = await graph(pageId, { token, params: { fields: "name,instagram_business_account" } });
  out.page = page.name || pageId;
  out.instagram = page.instagram_business_account?.id || null;
  if (igUserId && out.instagram && out.instagram !== String(igUserId)) {
    throw new Error(
      `the stored Instagram id (${igUserId}) is not the account connected to this Page (${out.instagram}) — ` +
      `re-run scripts/social/meta-token.mjs`
    );
  }
  return out;
}

export { graph as _graph };

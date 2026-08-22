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
export function igContainerPayload(item, { caption = null, carouselChild = false } = {}) {
  const payload = {};
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
export async function publishInstagram({ igUserId, token, media, caption, sleep }) {
  const items = (media || []).filter((m) => m && m.url);
  if (!items.length) throw new Error("no media to publish");
  if (items.length > 10) throw new Error(`Instagram takes at most 10 items, got ${items.length}`);

  let containerId;
  if (items.length === 1) {
    const { id } = await graph(`${igUserId}/media`, {
      method: "POST", token, params: igContainerPayload(items[0], { caption }),
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

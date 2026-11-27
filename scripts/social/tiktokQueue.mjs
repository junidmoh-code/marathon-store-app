// ── TIKTOK QUEUE — THE PURE PARTS ────────────────────────────────────────────
// What goes to TikTok, in what order, with what caption. No I/O here; the
// runner is tiktok-poster.mjs and the tests are tiktokQueue.test.mjs.
//
// THE QUEUE is every social_posts record that really went out on Instagram or
// Facebook (results.{instagram|facebook}.state === "ok"). A failed, discarded,
// draft or sample record never qualifies, and inside a family only the members
// that posted OK are used as sources.
//
// A FAMILY is one piece of content that went out in more than one shape: a
// feed post is the 4:5 twin of a story (twinOf), a story can be a reel's twin
// (videoFrom). TikTok gets each family ONCE, keyed by its root id, so the
// ledger can never post the same design twice.
//
//   · any member with a video → one VIDEO post (the reel's mp4);
//   · otherwise → one PHOTO post, preferring the 9:16 story render (it fills a
//     TikTok screen), then the story's own media, then the feed media.
//
// ORDER: oldest first, so the backlog drains before newer posts, and each new
// day's output joins the end of the queue by itself. Photos and videos
// alternate while both remain.

export const SLOTS = ["08:30", "18:30"];        // SAST
export const PER_SLOT = 3;
export const GAP_MIN_MS = 15 * 60000;
export const GAP_MAX_MS = 20 * 60000;
export const MAX_ATTEMPTS = 3;                  // refusals where TikTok created nothing
export const PHOTO_TITLE_MAX = 90;
export const PHOTO_DESC_MAX = 4000;
export const VIDEO_CAPTION_MAX = 2200;
export const VIDEO_MIN_S = 3;
export const VIDEO_MAX_S = 600;
export const PHOTO_MAX_W = 1080;
export const PHOTO_MAX_H = 1920;

export const familyKey = (p) => (typeof p?.videoFrom === "string" && p.videoFrom) || (typeof p?.twinOf === "string" && p.twinOf) || p.id;

export const postedOk = (p) =>
  !!p && p.status === "posted" && ["instagram", "facebook"].some((k) => p.results?.[k]?.state === "ok");

const formatOf = (p) => p?.format || "feed";
const images = (p) => (Array.isArray(p?.media) ? p.media : []).filter((m) => m && m.type === "image" && typeof m.url === "string" && m.url);
const videos = (p) => (Array.isArray(p?.media) ? p.media : []).filter((m) => m && m.type === "video" && typeof m.url === "string" && m.url);

/** One TikTok candidate per family, oldest first. `posts` is [{ id, ...record }]. */
export function buildQueue(posts) {
  // Resolve chains (a feed twin of a reel's story twin) to the one root, over every record, posted or not.
  const byId = new Map(posts.map((p) => [p.id, p]));
  const root = (p) => { let k = p.id, cur = p; for (let i = 0; i < 5; i++) { const up = familyKey(cur); if (up === k || !byId.has(up)) return up; k = up; cur = byId.get(up); } return k; };
  const fams = new Map();
  for (const p of posts) {
    if (!postedOk(p)) continue;
    const k = root(p);
    if (!fams.has(k)) fams.set(k, []);
    fams.get(k).push(p);
  }
  const out = [];
  for (const [key, members] of fams) {
    const at = Math.min(...members.map((m) => m.postedAt || m.scheduledAt || m.createdAt || Infinity));
    const caption = members.map((m) => String(m.caption || "")).sort((a, b) => b.length - a.length)[0] || "";
    const kind = members.find((m) => m.kind)?.kind || "single";
    const isAigc = !/arrival/i.test(kind);
    const withVideo = members.find((m) => videos(m).length);
    if (withVideo) {
      out.push({ key, media: "VIDEO", urls: [videos(withVideo)[0].url], caption, kind, isAigc, at, ids: members.map((m) => m.id) });
      continue;
    }
    const story = members.find((m) => formatOf(m) === "story");
    const art = members.map((m) => m.artwork?.story?.url).find((u) => typeof u === "string" && u);
    let urls = art ? [art] : story && images(story).length ? images(story).map((m) => m.url) : [];
    if (!urls.length) { const any = members.find((m) => images(m).length); urls = any ? images(any).map((m) => m.url) : []; }
    if (!urls.length) continue;
    out.push({ key, media: "PHOTO", urls: urls.slice(0, 35), caption, kind, isAigc, at, ids: members.map((m) => m.id) });
  }
  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
}

/** May this family still be posted? Anything that reached TikTok, or may have, never goes again. */
export function eligible(entry) {
  if (!entry) return true;
  if (entry.state === "refused") return (entry.attempts || 0) < MAX_ATTEMPTS;
  return false; // sending, sent, live, failed, unknown
}

/** The next family: the oldest eligible one, switching type from the last post when the other type is available. */
export function pickNext(queue, ledger, lastMedia, skip = new Set()) {
  const open = queue.filter((c) => !skip.has(c.key) && eligible(ledger?.families?.[c.key]));
  if (!open.length) return null;
  if (lastMedia && open[0].media === lastMedia) return open.find((c) => c.media !== lastMedia) || open[0];
  return open[0];
}

export function counts(queue, ledger) {
  const f = ledger?.families || {};
  const n = { total: queue.length, photos: 0, videos: 0, posted: 0, pending: 0, failed: 0, waiting: 0 };
  for (const c of queue) {
    n[c.media === "VIDEO" ? "videos" : "photos"]++;
    const e = f[c.key];
    if (!e || eligible(e)) n.waiting++;
    else if (e.state === "live") n.posted++;
    else if (e.state === "sent" || e.state === "sending") n.pending++;
    else n.failed++;
  }
  return n;
}

const HOUSE_SKIP = /^#(marathonclub|sneakersa|shoponline|southafrica|fyp|foryou|foryoupage|tiktok|sneakertok|ootd)$/i;
/** Caption body without its hashtags, plus 3 to 5 tags: up to 2 of the post's own, then the house ones. */
export function captionParts(caption, kind) {
  const text = String(caption || "");
  const seen = new Set();
  const own = (text.match(/#[\p{L}\p{N}_]+/gu) || []).filter((t) => !HOUSE_SKIP.test(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 2);
  const body = text.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  const style = kind === "outfit" || kind === "lookbook" || kind === "flatlay" ? "#OOTD" : "#SneakerTok";
  const tags = [...new Set([...own, "#MarathonClub", style, "#SouthAfrica"])].slice(0, 5);
  return { body, tags };
}

/** Cut at a word boundary, never mid-word, with an ellipsis only when something was cut. */
export function cutWords(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  let room = t.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(room)) room = room.slice(0, -1); // never half an emoji
  const at = room.lastIndexOf(" ");
  return `${(at > max * 0.6 ? room.slice(0, at) : room).replace(/[\s,.;:!-]+$/, "")}…`;
}

/** { title, description } within TikTok's limits for the media type. */
export function tiktokText(c) {
  const { body, tags } = captionParts(c.caption, c.kind);
  const tagLine = tags.join(" ");
  if (c.media === "VIDEO") {
    return { title: "", description: `${cutWords(body, VIDEO_CAPTION_MAX - tagLine.length - 2)}\n\n${tagLine}`.trim() };
  }
  const first = body.split(/(?<=[.!?])\s|\n/)[0] || body;
  return { title: cutWords(first, PHOTO_TITLE_MAX), description: `${cutWords(body, PHOTO_DESC_MAX - tagLine.length - 2)}\n\n${tagLine}`.trim() };
}

/** Retry delays for calls that created nothing (ms). */
export const backoff = (attempt) => Math.min(60000, 2000 * 2 ** attempt);

/** A random gap inside the slot spacing. */
export const slotGap = (rand = Math.random) => GAP_MIN_MS + Math.floor(rand() * (GAP_MAX_MS - GAP_MIN_MS));

/**
 * What a reply from Signal Studio's POST /tiktok/post means for the ledger (see social/local.ts).
 *   state:   sent | failed (may be live: never again) | refused (created nothing) | null (leave the entry as it was)
 *   attempt: counts toward MAX_ATTEMPTS (only problems with this item)
 *   abort:   stop the run (the account or service is the problem, not the item)
 */
export function classifyPost(status, json) {
  const kind = json?.kind;
  if (status === 200 && json?.publishId) return { state: "sent", attempt: false, abort: false };
  if (status === 0) return { state: "failed", attempt: false, abort: true };              // no answer at all
  if (kind === "unknown") return { state: "failed", attempt: false, abort: false };
  if (status === 409 && /already sent/.test(String(json?.error))) return { state: "failed", attempt: false, abort: false };
  if (status === 401 || status === 409) return { state: null, attempt: false, abort: true };
  if (status === 502) {
    if (["wait", "limit", "auth", "transient", "unaudited"].includes(kind)) return { state: null, attempt: false, abort: true };
    return { state: "refused", attempt: true, abort: false };                              // permanent: this item
  }
  if (status === 400) return { state: "refused", attempt: true, abort: false };
  return { state: "failed", attempt: false, abort: true };                                 // 500 or odd: may have posted
}

/** A sent post whose status never settled is given up on (never re-posted) after a day. */
export const STUCK_MS = 24 * 3600000;

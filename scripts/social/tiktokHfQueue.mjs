// ── TIKTOK HANDOFF QUEUE (Higgsfield), THE PURE PARTS ────────────────────────
// Until TikTok passes Signal Studio's Direct Post audit (submitted 28 Nov 2026,
// ref 20261128074550), Marathon Club's TikTok posts go out through Higgsfield,
// approved by Junid in his Claude chat. This queue is what that chat pulls from:
// twice a day a batch of 3 posts, published as JSON with direct media URLs.
//
// No I/O here. The builder is tiktok-queue-build.mjs, the public server is
// tiktok-queue-server.mjs, the tests are tiktokHfQueue.test.mjs, and the
// how-to is docs/tiktok-queue.md.
//
// SOURCE: the same family queue the Signal Studio poster uses
// (tiktokQueue.buildQueue): everything that really went out on Instagram or
// Facebook, one entry per family, photo posts first, oldest first (Junid,
// 28 Nov 2026). A post_id IS the family key, so the poster and this queue
// agree on what "the same post" means.
//
// NEVER A REPEAT: a family is left out when
//   · Junid's chat marked it posted (posted.json, written by the server), or
//   · the poster's ledger says it reached TikTok, or may have (not eligible), or
//   · Junid skipped it, or the builder found its media unusable (rejects).
import { captionParts, eligible } from "./tiktokQueue.mjs";

export const PER_BATCH = 3;
export const SLOT_NAMES = ["morning", "evening"];
export const SLOT_BUILD = { morning: "09:00", evening: "17:30" };   // SAST, launchd
export const SLOT_READY = { morning: "09:15", evening: "17:45" };   // what Junid's chat can count on
export const CAPTION_MAX = 150;
export const TAGS_MIN = 3;
export const TAGS_MAX = 5;
export const EMOJI_MAX = 2;
export const PHOTO_W = 1080;
export const PHOTO_H = 1920;
export const PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_MAX_ITEMS = 10;
export const VIDEO_MIN_S = 3;
export const VIDEO_MAX_S = 600;
export const VIDEO_MIN_FPS = 23;
export const VIDEO_MAX_FPS = 60;
export const VIDEO_MIN_SIDE = 360;
export const POST_ID_RE = /^[-A-Za-z0-9_]{1,64}$/;
export const BATCH_ID_RE = /^\d{4}-\d{2}-\d{2}-(morning|evening)$/;

const SAST_MS = 2 * 3600000; // South Africa has no daylight saving

/** { date: "YYYY-MM-DD", hhmm } in Africa/Johannesburg. */
export function sast(now = Date.now()) {
  const iso = new Date(now + SAST_MS).toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

/** Which slot a run at `now` builds: before 13:00 SAST the morning batch, after it the evening one. */
export function slotFor(now = Date.now()) {
  return sast(now).hhmm < "13:00" ? "morning" : "evening";
}

export const batchId = (date, slot) => `${date}-${slot}`;

/** Batch ids in time order (lexical order would put "evening" before "morning"). */
export function batchOrder(a, b) {
  const [da, sa] = [a.slice(0, 10), a.slice(11)];
  const [db, sb] = [b.slice(0, 10), b.slice(11)];
  return da < db ? -1 : da > db ? 1 : SLOT_NAMES.indexOf(sa) - SLOT_NAMES.indexOf(sb);
}

// ── CAPTIONS ─────────────────────────────────────────────────────────────────
// The Instagram caption, cut down to TikTok's handoff rules: at most 150
// characters, at most 2 emoji, no shop address, no phone numbers, no links, no
// emails. Only the first two paragraphs are ever used: later ones are the CTA
// tail and, on some older posts, an internal styling note that leaked into the
// caption ("Monochrome, a second accent in the details ...").

const EMOJI_RE = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}️?)*/gu;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const URL_RE = /\b(https?:\/\/\S+|www\.\S+|\S+\.(co\.za|com|africa|shop|store)\b\S*)/i;
const EMAIL_RE = /\S+@\S+\.\S+/;
const ADDRESS_RE = /\b(\d+\s+\w+(\s+\w+)?\s+(st|street|rd|road|ave|avenue|drive|dr|lane|ln|blvd|boulevard|crescent|cres)\b|shop\s*(no\.?\s*)?\d+|unit\s+\d+|\d+(st|nd|rd|th)\s+floor|(visit|find|pop in to see|come see)\s+us\b|our\s+(shop|store)\s+(at|in|on)\b|corner\s+of)/i;
const CONTACT_RE = /\b(whats\s?app|call|phone|sms|dm)\s+(us|me)\b|\bcontact\s+us\b/i;
const NO_BIO_LINK_RE = /\blink\s+in\s+(bio|profile)\b/i; // the TikTok profile has no shop link to point at

/** Keep the first `max` emoji, drop the rest. */
export function capEmoji(s, max = EMOJI_MAX) {
  let n = 0;
  return String(s || "").replace(EMOJI_RE, (m) => (++n <= max ? m : "")).replace(/[ \t]{2,}/g, " ").trim();
}

/** A sentence that must not reach TikTok from here. */
export function unsafeSentence(s) {
  return PHONE_RE.test(s) || URL_RE.test(s) || EMAIL_RE.test(s) || ADDRESS_RE.test(s) || CONTACT_RE.test(s) || NO_BIO_LINK_RE.test(s);
}

const sentences = (para) => para.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Cut at a word boundary, ellipsis only when something was cut. */
export function cutAt(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max - 1);
  const at = room.lastIndexOf(" ");
  return `${(at > max * 0.5 ? room.slice(0, at) : room).replace(/[\s,.;:!—–-]+$/u, "")}…`;
}

/** { caption, hashtags } for one queue entry (tiktokQueue.buildQueue item). */
export function tiktokCaption(c) {
  const { body, tags } = captionParts(c.caption, c.kind);
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 2);
  const keep = paras.flatMap(sentences).filter((s) => !unsafeSentence(s)).map((s) => capEmoji(s, EMOJI_MAX));
  let caption = "";
  for (const s of keep) {
    const next = caption ? `${caption} ${s}` : s;
    if (next.length <= CAPTION_MAX) { caption = next; continue; }
    if (!caption) caption = cutAt(s, CAPTION_MAX);
    break;
  }
  caption = capEmoji(caption, EMOJI_MAX) || "Fresh at Marathon Club.";
  const hashtags = [...new Set(tags)].slice(0, TAGS_MAX);
  for (const t of ["#MarathonClub", "#SneakerTok", "#SouthAfrica"]) if (hashtags.length < TAGS_MIN && !hashtags.includes(t)) hashtags.push(t);
  return { caption, hashtags };
}

// ── MEDIA RULES ──────────────────────────────────────────────────────────────

/**
 * What to do with a video, from ffprobe's JSON:
 *   { ok: true }                      use the file as it is
 *   { ok: true, transcode: reason }   re-encode to H.264/AAC MP4 at 30 fps first
 *   { ok: false, reason }             cannot be made to fit; the post is rejected
 */
export function videoPlan(probe) {
  const v = (probe?.streams || []).find((s) => s.codec_type === "video");
  if (!v) return { ok: false, reason: "no video stream" };
  const dur = Number(probe?.format?.duration ?? v.duration);
  if (!(dur >= VIDEO_MIN_S && dur <= VIDEO_MAX_S)) return { ok: false, reason: `duration ${dur}s outside ${VIDEO_MIN_S}-${VIDEO_MAX_S}s` };
  const w = Number(v.width), h = Number(v.height);
  if (!(Math.min(w, h) >= VIDEO_MIN_SIDE)) return { ok: false, reason: `${w}x${h} is under ${VIDEO_MIN_SIDE} px on a side` };
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  const why = [];
  if (!/mp4/.test(probe?.format?.format_name || "")) why.push(`container ${probe?.format?.format_name}`);
  if (v.codec_name !== "h264") why.push(`codec ${v.codec_name}`);
  if (!(fps >= VIDEO_MIN_FPS && fps <= VIDEO_MAX_FPS)) why.push(`${fps ? fps.toFixed(2) : "unknown"} fps`);
  if (v.pix_fmt && v.pix_fmt !== "yuv420p") why.push(`pixel format ${v.pix_fmt}`);
  return why.length ? { ok: true, transcode: why.join(", ") } : { ok: true };
}

/** "30000/1001" → 29.97 */
export function rate(r) {
  const [n, d] = String(r || "").split("/").map(Number);
  const x = d ? n / d : n;
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Is this image already a vertical 9:16 (within 2%)? Otherwise it is set on a 1080x1920 canvas. */
export const isVertical = (w, h) => w > 0 && h > 0 && Math.abs(w / h - 9 / 16) <= 0.02 * (9 / 16);

// ── PICKING A BATCH ──────────────────────────────────────────────────────────

/** Families that must never be offered again. */
export function blocked(key, { posted = {}, skipped = {}, rejects = {}, ledger = null }) {
  return !!(posted[key] || skipped[key] || rejects[key] || (ledger?.families?.[key] && !eligible(ledger.families[key])));
}

/**
 * ROLLOVER: a post of the previous batch that Junid's chat did not confirm comes
 * back first in the next batch, same post_id, same files. A post offered
 * MAX_OFFERS times without a confirmation goes back to the end of the queue
 * (never-offered families come first), so one unwanted post cannot block the
 * queue for good. POST /mark-skipped drops a post at once.
 */
export const MAX_OFFERS = 4;

/** Queue entries of `prev` (the previous batch) still owed a posting, in their batch order. */
export function carryOver(prev, queue, state) {
  const offered = state.offered || {};
  const byKey = new Map(queue.map((c) => [c.key, c]));
  return (prev?.posts || [])
    .map((p) => byKey.get(p.post_id))
    .filter((c) => c && !blocked(c.key, state) && (offered[c.key] || 0) < MAX_OFFERS);
}

/**
 * The candidates for one batch, best first (the builder takes the first `n`
 * whose media it can prepare):
 *   1. `carry`: the previous batch's unconfirmed posts (carryOver)
 *   2. never-offered families, photos first, oldest first
 *   3. families offered before and never confirmed, least-offered first
 *   queue  tiktokQueue.buildQueue output
 *   state  { posted, skipped, rejects, ledger, offered: { [post_id]: earlier offers } }
 */
export function pickBatch(queue, state, n = PER_BATCH, carry = []) {
  const offered = state.offered || {};
  const carried = new Set(carry.map((c) => c.key));
  const open = queue.filter((c) => !carried.has(c.key) && !blocked(c.key, state));
  const fresh = open.filter((c) => !offered[c.key]);
  const again = open.filter((c) => offered[c.key]).sort((a, b) => offered[a.key] - offered[b.key]);
  const order = (list) => [...list.filter((c) => c.media === "PHOTO"), ...list.filter((c) => c.media !== "PHOTO")];
  return [...carry, ...order(fresh), ...order(again)].slice(0, n);
}

// ── MARKING (server side) ────────────────────────────────────────────────────

/**
 * Record one post as posted (or skipped) in its map. Idempotent: a second call
 * keeps the first record. Returns { map, already, error }.
 */
export function applyMark(map, postId, info, known) {
  if (typeof postId !== "string" || !POST_ID_RE.test(postId)) return { map, error: "post_id missing or malformed" };
  if (!known(postId)) return { map, error: "post_id is not in any batch" };
  if (map[postId]) return { map, already: true };
  const rec = { at: info.at || new Date().toISOString() };
  if (typeof info.tiktok_url === "string" && /^https:\/\/(www\.|vm\.|vt\.)?tiktok\.com\/\S{1,300}$/.test(info.tiktok_url)) rec.tiktok_url = info.tiktok_url;
  if (typeof info.note === "string" && info.note.trim()) rec.note = info.note.trim().slice(0, 200);
  return { map: { ...map, [postId]: rec }, already: false };
}

// ─── SOCIAL CONTENT ENGINE — THE SHARED VOCABULARY ───────────────────────────
// Everything the approval queue, the generator and the Mac-mini publisher must
// agree about, in one dependency-free module. The browser imports it through
// Vite; scripts/social/*.mjs imports it under plain Node ESM; the Cloud
// Function reads its twin constants from functions/lib/social-select.cjs and
// is pinned equal by test. No React, no Firebase, no I/O — so every rule here
// is unit-testable and neither surface can drift from the other.
//
// ── THE ONE RULE THIS MODULE IS BUILT AROUND ─────────────────────────────────
// NOTHING is ever posted that Junid has not approved. That is not a UI
// convention that a future caller might forget — it is `postBlocker()`, which
// the publisher calls on every item immediately before it talks to a platform,
// and which refuses anything whose status is not "approved". A generator that
// wrote status:"approved" directly, a hand-edited RTDB node, a replayed old
// record: all of them still have to pass this function, on the machine that
// does the posting, at the moment of posting.
//
// ── THE COMPLIANCE VALIDATOR DOES NOT LIVE HERE, DELIBERATELY ────────────────
// scripts/shopify/compliance.mjs refuses any payload containing a brand word,
// because the payment gateway keyword-scans the SHOPIFY CATALOGUE. Social
// captions are not the Shopify catalogue: they are read by people, and a
// caption that may not name the product it is selling is a caption nobody can
// understand. Owner ruling, restated in the 2026-08-22 brief: captions name
// products normally. So there is no import of shopifyTriggers.js in this file
// or anywhere under src/components/social — and socialCore.test.js pins that
// absence, because the plausible "tidy-up" here is for somebody to notice the
// asymmetry and "fix" it by wiring the validator in.
//
// The Shopify side is untouched: every path that reaches the storefront still
// goes through validatePayload().

// ── PLATFORMS ────────────────────────────────────────────────────────────────
// captionMax is each platform's own published ceiling. The queue stores ONE
// caption; each platform gets it trimmed to its own limit at send time
// (captionFor below) rather than the shortest common denominator, so Instagram
// is not shortened to fit TikTok's title field.
export const PLATFORMS = [
  {
    key: "instagram",
    label: "Instagram",
    // IG caption limit is 2,200 characters. Feed posts accept 1–10 media in a
    // carousel; a single image is just a carousel of one.
    captionMax: 2200,
    mediaMax: 10,
    video: true,
  },
  {
    key: "facebook",
    label: "Facebook",
    // Page post message. The documented ceiling is far higher; 5,000 is a
    // sane working cap and well past anything this generator writes.
    captionMax: 5000,
    mediaMax: 10,
    video: true,
  },
  {
    key: "tiktok",
    label: "TikTok",
    // TikTok splits caption into a 150-char title and a 4,000-char
    // description. captionMax is the DESCRIPTION; titleMax is the title, and
    // captionFor("tiktok") returns both.
    captionMax: 4000,
    titleMax: 150,
    mediaMax: 35,
    video: true,
  },
];

export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);
const PLATFORM_BY_KEY = new Map(PLATFORMS.map((p) => [p.key, p]));
export const platform = (key) => PLATFORM_BY_KEY.get(key) || null;

// ── POST KINDS ───────────────────────────────────────────────────────────────
// `products` is how many catalogue records the kind draws on, and `generates`
// says whether a paid image generation happens. costUSD is the per-post figure
// the generator will actually be billed — NBPRO_FLAT_IMAGE_USD (0.134) for one
// Nano Banana Pro scene, plus a caption call that rounds to nothing at this
// scale. KEEP IN SYNC with functions/lib/social-select.cjs POST_KINDS; the
// node test pins the two equal.
export const POST_KINDS = [
  {
    key: "single",
    label: "Single product",
    hint: "One product, one house-style photograph",
    minProducts: 1,
    maxProducts: 1,
    generates: true,
    costUSD: 0.134,
  },
  {
    key: "flatlay",
    label: "Flat-lay",
    hint: "Three to five products arranged in one shot",
    minProducts: 3,
    maxProducts: 5,
    generates: true,
    costUSD: 0.134,
  },
  {
    key: "pairing",
    label: "Pairing",
    hint: "Two or three pieces that go together — never framed as a full look",
    minProducts: 2,
    maxProducts: 3,
    generates: true,
    costUSD: 0.134,
  },
  {
    key: "new_arrivals",
    label: "New arrivals",
    hint: "A carousel of what just went live — existing photos, nothing generated",
    minProducts: 2,
    maxProducts: 10,
    generates: false,
    costUSD: 0.0004,
  },
  {
    key: "outfit",
    label: "Full outfit",
    hint: "A complete look — top, bottom and shoes, plus finishing pieces",
    // A look needs top, bottom and shoes. The old minimum of 2 accepted a
    // t-shirt and a pair of trainers, which is not something a person wears.
    minProducts: 3,
    maxProducts: 5,
    generates: true,
    costUSD: 0.134,
  },
];
export const KIND_KEYS = POST_KINDS.map((k) => k.key);
const KIND_BY_KEY = new Map(POST_KINDS.map((k) => [k.key, k]));
export const postKind = (key) => KIND_BY_KEY.get(key) || null;

// ── STATUS ───────────────────────────────────────────────────────────────────
// draft      — generated, waiting for Junid. The ONLY status the generator writes.
// approved   — Junid said yes. The only status the publisher will act on.
// posting    — the publisher has claimed it (see claim, below).
// posted     — at least one platform accepted it and none is still outstanding.
// failed     — every attempt failed; retried until MAX_ATTEMPTS, then held here
//              LOUDLY rather than dropped.
// discarded  — thrown away. Kept as a record so the generator does not
//              re-propose the same product the next day.
// ── FORMAT: WHERE A POST GOES, NOT WHAT IS IN IT ─────────────────────────────
// `kind` says what the post is ABOUT — an outfit, a pairing, a single product.
// `format` says WHERE it lands, which decides its canvas, its media type and
// whether it needs a video at all:
//
// ── EVERY STORY IS ALSO A FEED POST ──────────────────────────────────────────
// A MIRROR of STORY_ALSO_POSTS_TO_FEED in functions/index.js, which is where
// the decision is actually made — the browser never creates a twin, it only
// describes what the backend will do. Mirrored rather than read because the
// backend's copy is a build-time flag with no representation in the database,
// and a screen guessing at it would be worse than one that is pinned to it.
//
// socialFormat.test.js asserts the two literals agree. If you change one,
// that test fails until you change the other — the same drift guard the
// Mon/Wed/Sat plist and SLOT_DAYS already live under.
export const STORY_ALSO_POSTS_TO_FEED = true;

//   feed   1080x1350, a still, media_type from the media
//   story  1080x1920, a still, media_type=STORIES, no caption, 24h
//   reel   1080x1920, a VIDEO, media_type=REELS
//
// Only the reel needs a video. A feed post and a story both accept a still, and
// encoding one for them would spend CPU and bandwidth on a slideshow of a
// single frame. An absent format means "feed" so every post written before this
// existed still reads correctly.
export const FORMATS = ["feed", "story", "reel"];
export const DEFAULT_FORMAT = "feed";
export const formatOf = (post) => (FORMATS.includes(post?.format) ? post.format : DEFAULT_FORMAT);
/** Only a reel needs a video; the others are stills. */
export const needsVideo = (post) => formatOf(post) === "reel";

export const STATUSES = ["draft", "approved", "posting", "posted", "failed", "discarded"];

// What the QUEUE shows, in tab order. "All" is deliberately absent — a list
// with no state is a list nobody reads. Four tabs, not six: "posting" and
// "failed" used to be their own pills, which is correct in principle (every
// status a post can hold needs somewhere it can be SEEN — see the test this
// file is pinned against) but read as clutter for two states that are both,
// in practice, brief or rare. So each folds into the tab it belongs beside
// instead of disappearing:
//
//   posting  → folds into Approved. It is an approved post the publisher has
//              claimed for a few seconds; the row's own status chip still
//              says "posting…" so nothing is hidden, and a claim the
//              publisher never finishes reclaims itself back to "approved"
//              (publish.mjs reclaimStaleClaims) — it was never a state that
//              needed permanent parking, only visibility, and it still has
//              that inside the tab it now shares.
//   failed   → folds into Discarded, which is already "not currently active,
//              needs a look" — exactly what a failed post is. "Put back in
//              the queue" still works from inside that tab.
export const QUEUE_FILTERS = [
  { key: "draft", label: "Drafts", statuses: ["draft"] },
  { key: "approved", label: "Approved", statuses: ["approved", "posting"] },
  { key: "posted", label: "Posted", statuses: ["posted"] },
  { key: "discarded", label: "Discarded", statuses: ["discarded", "failed"] },
];

// How long a claim may stand before the next run treats it as abandoned and
// takes it back. Sized well above the slowest realistic run: a ten-item
// carousel of videos is ten container ingests at up to five minutes each.
export const STALE_CLAIM_MS = 90 * 60 * 1000;

export const CAPTION_MAX = 2200;   // the queue's own edit cap — the tightest platform
export const CAPTION_MIN = 12;
export const MAX_MEDIA = 10;
export const MAX_ATTEMPTS = 4;     // per platform, across scheduled runs

// ── THE PHYSICAL SHOPS ARE NEVER MENTIONED ───────────────────────────────────
// Owner rule, 2026-08-23, and a HARD one: the online business is separate from
// the shops, the shops are already busier than they can serve, and nothing we
// publish may send anyone to one. No "in store", no branch name, no address, no
// opening hours — in a caption, on an image, in alt text, in ad copy.
//
// It is enforced HERE, as a refusal, rather than only asked for in a prompt,
// for the same reason brand terms are refused for the Shopify catalogue: a
// prompt is a request and a gate is a guarantee. The caption prompt was in fact
// telling the model the shop has "Three physical stores", so it dutifully wrote
// "in-store and online" — a prompt-only rule would have been fighting the
// prompt above it.
//
// This lives in socialCore.js on purpose. It is the ONE file imported by both
// the browser queue and scripts/social/publish.mjs on the Mac mini, so a single
// implementation guards the edit box and the last moment before the first
// platform call. No mirror, so nothing to drift.
//
// ── ON FALSE POSITIVES ───────────────────────────────────────────────────────
// "Pine" and "Trophy" are branch names AND ordinary words that appear in real
// product names and colours. Refusing them bare would block honest captions, so
// a branch name is refused only in a LOCATIONAL frame ("at Pine", "Trophy
// branch"). The generic phrases below carry no such ambiguity and are refused
// outright.
const SHOP_PHRASES = [
  /\bin[-\s]?store\b/i, /\binstore\b/i, /\bin[-\s]?branch\b/i,
  /\bvisit (?:us|our|the (?:shop|store))\b/i, /\bcome (?:see us|through|visit|in)\b/i,
  /\bpop (?:in|by|round)\b/i, /\bswing by\b/i, /\bdrop (?:in|by)\b/i,
  /\bwalk[-\s]?in\b/i, /\bshowroom\b/i,
  /\bour (?:shop|store|stores|shops|branch|branches)\b/i,
  /\b(?:at|in) (?:the|our) (?:shop|store|branch)\b/i,
  /\bphysical (?:shop|store)s?\b/i,
  /\bopen(?:ing)? (?:hours|times)\b/i,
  /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-\u2013\u2014]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b.*\b\d{1,2}\s*(?:am|pm|h\d{2})\b/i,
  /\b\d{1,2}\s*(?:am|pm)\s*[-\u2013\u2014]\s*\d{1,2}\s*(?:am|pm)\b/i,
  // A street address: number + street word.
  /\b\d{1,5}[a-z]?\s+[A-Z][\w'-]*\s+(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|way|centre|center|mall|arcade)\b/i,
];
const BRANCH_NAMES = ["Marathon PE", "Pine", "Trophy"];
// A branch name only counts when framed as a place.
const BRANCH_FRAMES = (n) => [
  new RegExp(`\\b(?:at|in|from|to|near|visit)\\s+${n}\\b`, "i"),
  new RegExp(`\\b${n}\\s+(?:branch|store|shop|outlet)\\b`, "i"),
];

/**
 * Every physical-shop reference in a piece of text. Empty array means clean.
 * Exported so the queue can show Junid exactly which words are the problem
 * rather than a bare refusal he has to guess at.
 */
export function findShopMentions(text) {
  const s = String(text == null ? "" : text);
  const hits = [];
  for (const re of SHOP_PHRASES) {
    const m = s.match(re);
    if (m) hits.push(m[0].trim());
  }
  for (const n of BRANCH_NAMES) {
    for (const re of BRANCH_FRAMES(n)) {
      const m = s.match(re);
      if (m) { hits.push(m[0].trim()); break; }
    }
  }
  return [...new Set(hits)];
}

/** The refusal sentence, or null when the text is clean. */
export function shopMentionBlocker(text) {
  const hits = findShopMentions(text);
  if (!hits.length) return null;
  return `Mentions the shops (${hits.slice(0, 3).map((h) => `"${h}"`).join(", ")}) — online only, never the physical stores.`;
}

// ── IS THIS POST FIT TO SEND? ────────────────────────────────────────────────
// Everything about a post that makes it postable EXCEPT whether it has been
// approved and whether it is due. Split out because those two are the caller's
// business, not the content's.
//
// This split fixes a real outage. The Approve button was disabled on
// `postBlocker(post)`, whose FIRST branch refuses anything not already
// approved — so a draft reported "Not approved yet" as the reason it could not
// be approved, and the button was grey forever. Nothing could ever be approved
// through the app; the only posts that ever went out were approved by hand
// against the database. The gate that decides "may I approve this?" must not
// require it to already be approved.
export function postReadiness(post) {
  if (!post || typeof post !== "object") return "This item is empty.";
  const media = Array.isArray(post.media) ? post.media.filter((m) => m && m.url) : [];
  if (!media.length) return "No image or video attached.";
  if (media.length > MAX_MEDIA) return `Too many items attached (${media.length}; the limit is ${MAX_MEDIA}).`;
  const caption = typeof post.caption === "string" ? post.caption.trim() : "";
  if (caption.length < CAPTION_MIN) return "The caption is empty or too short.";
  // The shop rule is checked on the CAPTION and on any alt text, at the same
  // gate as everything else, so it cannot be approved past or published past.
  const shop = shopMentionBlocker([caption, post.altText, post.title].filter(Boolean).join("\n"));
  if (shop) return shop;
  const on = enabledPlatforms(post);
  if (!on.length) return "No platform is selected.";
  const videos = media.filter((m) => m.type === "video").length;
  if (videos && videos !== media.length) {
    return "A post is either video or photos — not both.";
  }
  for (const key of on) {
    const p = platform(key);
    if (!p) return `Unknown platform "${key}".`;
    if (videos && !p.video) return `${p.label} cannot take a video.`;
    if (videos > 1 && key === "facebook") return "Facebook takes one video per post.";
    if (media.length > p.mediaMax) return `${p.label} takes at most ${p.mediaMax} items; this post has ${media.length}.`;
  }
  return null;
}

// ── THE PUBLISHER'S GATE ─────────────────────────────────────────────────────
// Returns a plain-sentence reason the post must NOT be sent, or null when it
// may. Called by the queue (to grey the Approve button and say why) and again
// by scripts/social/publish.mjs immediately before the first platform call.
// The second call is the one that matters: it is the only check that runs on
// the machine that actually posts.
//
// `now` is passed in rather than read, so the schedule check is testable and
// so the Mac mini's clock is the one clock that decides "due" (the browser
// never posts).
export function postBlocker(post, { now = Date.now(), requireDue = false } = {}) {
  if (!post || typeof post !== "object") return "This item is empty.";
  if (post.status !== "approved") {
    return post.status === "draft"
      ? "Not approved yet — nothing is posted until you approve it."
      : `Not approved (status: ${post.status || "unknown"}).`;
  }
  // Everything about the CONTENT — media, caption, platforms, and the physical
  // shop rule — is one shared check, so the queue and the publisher can never
  // disagree about what is postable.
  const notReady = postReadiness(post);
  if (notReady) return notReady;
  if (requireDue && !isDue(post, now)) {
    return `Scheduled for ${formatSlot(post.scheduledAt)} — not due yet.`;
  }
  return null;
}

export function enabledPlatforms(post) {
  const sel = (post && post.platforms) || {};
  return PLATFORM_KEYS.filter((k) => sel[k] === true);
}

/**
 * Platforms still needing a send: enabled, and not already recorded "ok".
 *
 * "sending" is deliberately NOT excluded here — it is still outstanding as far
 * as the queue is concerned — but the publisher must never blind-retry one.
 * See needsVerification: a "sending" record means we asked a platform to post
 * and never learned the answer, and re-sending is how one post becomes two.
 */
export function outstandingPlatforms(post) {
  const results = (post && post.results) || {};
  return enabledPlatforms(post).filter((k) => (results[k] || {}).state !== "ok");
}

/**
 * Did we ask this platform to publish and never find out whether it worked?
 *
 * The window is real: the publish call succeeds on the platform, and the
 * response is lost — a 502 from Meta's edge, the process killed, the network
 * dropping between "posted" and "we heard about it". A retry from scratch
 * creates a SECOND post on a live public account, which cannot be undone by
 * anything this program does.
 *
 * So a "sending" record is never re-sent automatically. It is surfaced for a
 * human to look at the account and say. That is a worse experience than a
 * silent retry exactly once in a blue moon, and a far better one than the shop
 * posting the same picture twice.
 */
export function needsVerification(post, platformKey) {
  return (((post && post.results) || {})[platformKey] || {}).state === "sending";
}

/**
 * Has this platform run out of retries? A failed send is retried on the next
 * scheduled tick — never silently dropped — but not forever: after
 * MAX_ATTEMPTS the item is parked in "failed" where the queue shows it in red
 * with the last error, which is the loud outcome the brief asks for.
 */
export function attemptsExhausted(post, platformKey) {
  const r = ((post && post.results) || {})[platformKey] || {};
  return Number(r.attempts || 0) >= MAX_ATTEMPTS;
}

export function isDue(post, now = Date.now()) {
  const at = Number(post && post.scheduledAt);
  // An approved post with NO schedule is due immediately — "approve and it
  // goes out on the next run" is the behaviour a reviewer expects when they
  // never touched the date.
  if (!Number.isFinite(at) || at <= 0) return true;
  return at <= now;
}

// ── CAPTIONS ─────────────────────────────────────────────────────────────────
// ONE caption is stored and edited. Each platform receives it shaped to its own
// fields. The link is appended if it is not already somewhere in the text —
// re-appending on every edit is how a caption ends up with the same URL three
// times.
// ── IS THIS ON ITS WAY OUT? ──────────────────────────────────────────────────
// Approved AND due, but the publisher has not claimed it yet. That gap is up to
// one tick — about two minutes — and it used to be silent: the queue showed
// "APPROVED" exactly as before the button was pressed, so the only feedback
// that Post now had done anything was a toast that vanished. A person watching
// an unchanged row concludes the click missed and presses it again.
//
// It is derived, never stored. A stored "sending" flag would be a second
// opinion about state that the publisher's claim transaction already owns, and
// the two would disagree the first time a tick was missed.
export function isSendingSoon(post, now = Date.now()) {
  return !!post && post.status === "approved" && isDue(post, now);
}

export function captionWithLink(caption, link) {
  const body = String(caption || "").trim();
  const url = String(link || "").trim();
  if (!url) return body;
  if (body.includes(url)) return body;
  return body ? `${body}\n\n${url}` : url;
}

/**
 * What actually gets sent to one platform.
 *   instagram / facebook → { caption }
 *   tiktok               → { title, description }
 * Trimming is on a WORD boundary with an ellipsis, never mid-word, and the
 * link survives: on TikTok the title is a headline, and the link lives in the
 * description where there is room for it.
 */
export function captionFor(post, platformKey) {
  const p = platform(platformKey);
  if (!p) throw new Error(`unknown platform: ${platformKey}`);
  const full = captionWithLink(post && post.caption, post && post.link);
  if (platformKey === "tiktok") {
    return {
      title: truncateWords(String((post && post.caption) || "").trim(), p.titleMax),
      description: truncateWords(full, p.captionMax),
    };
  }
  return { caption: truncateWords(full, p.captionMax) };
}

export function truncateWords(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  // Reserve one char for the ellipsis, then cut back to the last whitespace so
  // a URL or a product name is never sliced in half.
  const hard = s.slice(0, Math.max(0, max - 1));
  const soft = hard.replace(/\s+\S*$/, "");
  return `${(soft.length > max * 0.5 ? soft : hard).trimEnd()}…`;
}

// ── THE SCHEDULE — ONE A DAY ─────────────────────────────────────────────────
// Owner spec, 2026-08-24: a feed post EVERY day at 11:00 SAST, replacing the
// Mon/Wed/Sat 18:00 cadence. Fixed slots rather than a computed interval, so
// the queue can SHOW them and they can be reasoned about.
//
// There is ONE daily fire. A 16:30 story slot existed briefly and was removed:
// nothing publishes a story (the publisher has no story path), so that fire ran
// the ordinary publisher and would have posted an approved, overdue item to the
// FEED at a time meant for stories. STORY_HOUR_SAST is gone rather than left
// declared, because a constant describing behaviour that does not exist is a
// claim the code cannot keep. It returns with the story work.
//
export const SLOT_DAYS = [0, 1, 2, 3, 4, 5, 6];   // every day — JS getUTCDay numbering
export const SLOT_HOUR_SAST = 11;                 // the feed post
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// The furthest ahead this will ever schedule. A bound is needed so a caller
// asking for a silly number cannot spin; a year is far past anything a
// three-a-week queue can consume, and a post scheduled beyond it is a bug in
// the caller rather than a slot worth returning.
export const MAX_HORIZON_DAYS = 366;

/**
 * The next `count` posting slots at or after `fromMs`, as epoch ms.
 *
 * THE HORIZON IS DERIVED FROM `count`, not fixed. An earlier version walked a
 * flat 28 days, which caps at twelve slots — so asking for twenty returned
 * twelve, silently. That mattered: assignSlots asks for count + taken + 4, and
 * a queue with a dozen scheduled posts pushes the request past twelve. The
 * missing slots came back undefined, the generator wrote `scheduledAt: null`,
 * and a null schedule means DUE IMMEDIATELY — so posts meant to be spread over
 * weeks would have gone out on the next run, together.
 *
 * Three slots a week means `count` slots need about count/3 weeks; the +2 weeks
 * covers the partial week at each end.
 */
export function nextSlots(fromMs = Date.now(), count = 3) {
  const out = [];
  const wanted = Math.max(0, Math.floor(count) || 0);
  const horizon = Math.min(
    MAX_HORIZON_DAYS,
    Math.ceil(wanted / SLOT_DAYS.length) * 7 + 14
  );
  const startDay = Math.floor((fromMs + SAST_OFFSET_MS) / 86400000);
  for (let d = 0; d < horizon && out.length < wanted; d++) {
    const dayIndex = startDay + d;
    // Midnight SAST of that day, expressed as epoch ms.
    const midnightUtc = dayIndex * 86400000 - SAST_OFFSET_MS;
    const dow = new Date(midnightUtc + SAST_OFFSET_MS).getUTCDay();
    if (!SLOT_DAYS.includes(dow)) continue;
    const slot = midnightUtc + SLOT_HOUR_SAST * 3600000;
    if (slot >= fromMs) out.push(slot);
  }
  return out;
}

/**
 * Slots for a batch of new drafts, skipping any already taken by a post that
 * is still going to be sent. Two generated posts must not land on the same
 * evening just because they were generated in the same run.
 */
export function assignSlots(existingPosts, count, fromMs = Date.now()) {
  const taken = new Set(
    (existingPosts || [])
      .filter((p) => p && (p.status === "draft" || p.status === "approved" || p.status === "posting"))
      .map((p) => Number(p.scheduledAt))
      .filter((n) => Number.isFinite(n))
  );
  const out = [];
  // Ask for generously more slots than needed so a run of taken evenings does
  // not return fewer than `count`. nextSlots sizes its own horizon from this
  // number, so asking for more genuinely reaches further ahead rather than
  // hitting a fixed wall.
  for (const slot of nextSlots(fromMs, count + taken.size + 4)) {
    if (taken.has(slot)) continue;
    out.push(slot);
    if (out.length === count) break;
  }
  return out;
}

/** "Sat 30 Aug, 18:00" — SAST, the clock Junid reads. */
export function formatSlot(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "not scheduled";
  const d = new Date(n + SAST_OFFSET_MS);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${d.getUTCDate()} ${month}, ${hh}:${mm}`;
}

/** epoch ms → the value a <input type="datetime-local"> wants, in SAST. */
export function toLocalInput(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n + SAST_OFFSET_MS).toISOString().slice(0, 16);
}

/** The inverse. Returns null for anything unparseable rather than NaN. */
export function fromLocalInput(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(utc)) return null;
  return utc - SAST_OFFSET_MS;
}

// ── THE STOREFRONT LINK ──────────────────────────────────────────────────────
// Built from the CLEAN Shopify handle, which is what the storefront actually
// serves. Never from the product's internal name: that name may carry a brand
// word, and — more to the point — it is not the URL.
export const STOREFRONT = "https://marathonclub.co.za";
export function productLink(handle) {
  const h = String(handle || "").trim();
  return h ? `${STOREFRONT}/products/${h}` : STOREFRONT;
}

// ── A POST'S OWN SUMMARY LINE ────────────────────────────────────────────────
// Used by the queue row and by the publisher's log, so the two describe the
// same item the same way.
export function describePost(post) {
  const kind = postKind(post && post.kind);
  const n = Array.isArray(post && post.media) ? post.media.length : 0;
  const on = enabledPlatforms(post).map((k) => platform(k).label).join(" · ") || "no platform";
  const fmt = formatOf(post);
  // Feed is the common case and stays implicit, same as it always has —
  // only STORY / REEL are called out, since those are the ones a queue
  // reader could otherwise mistake for a feed card.
  const tag = fmt === "feed" ? "" : ` [${fmt.toUpperCase()}]`;
  return `${kind ? kind.label : post?.kind || "post"}${tag} · ${n} item${n === 1 ? "" : "s"} · ${on}`;
}

/** Human summary of what a platform's last attempt did. */
export function resultLine(post, platformKey) {
  const r = ((post && post.results) || {})[platformKey];
  if (!r || !r.state) return "not sent yet";
  if (r.state === "ok") return `posted${r.at ? ` ${formatSlot(r.at)}` : ""}`;
  if (r.state === "skipped") return r.error ? `skipped — ${r.error}` : "skipped";
  if (r.state === "sending") {
    return "sent, but we never got confirmation — CHECK THE ACCOUNT before approving again";
  }
  const tries = Number(r.attempts || 0);
  return `failed${tries ? ` (${tries}/${MAX_ATTEMPTS})` : ""}${r.error ? ` — ${r.error}` : ""}`;
}

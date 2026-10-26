// ─── THE DAILY STILL: WHAT A LOOKBOOK POST AND A STILL DAY LOOK LIKE ON DISK ──
// Pure. socialStillAutopilot (functions/index.js) does the reading, the paying
// and the writing; this file decides the shape of what it writes, so the shape
// is tested without Firebase.
//
// A LOOKBOOK POST IS A STORY WITH A FEED RENDER, the same record shape as the
// current designed still (generateOnePost's story + artwork.feed). That is what
// lets it go out "once to feed and once to story" through the existing
// buildFeedTwin, the existing queue and the existing publisher, with no change
// to any of them.
"use strict";

const STILL_SLOT = "15:30";   // 3½ h before the day's one reel at 19:00

/**
 * The lookbook's story record (its feed twin is built from it by
 * social-twin.cjs buildFeedTwin).
 */
function buildLookbookRecord({
  rows, total, urls, scheduledAt, platforms, engine, costUSD, nowMs, link, storyCaption, updatedBy,
  masterSize, scene, look,
}) {
  return {
    status: "approved",
    kind: "lookbook",
    format: "story",
    media: [{ url: urls.story, type: "image" }],
    artwork: {
      story: { url: urls.story, width: 1080, height: 1920 },
      feed: { url: urls.feed, width: 1080, height: 1350 },
      // 1600x2400 since the owner review of 18 Oct (it was 1200x1800).
      master: { url: urls.master, width: (masterSize && masterSize.width) || 1200, height: (masterSize && masterSize.height) || 1800 },
    },
    caption: storyCaption,
    captionSource: "not-needed",
    link,
    platforms,
    scheduledAt: scheduledAt || null,
    ...(scheduledAt ? {} : { unscheduledReason: "no free posting slot was available" }),
    products: rows.map((r) => ({
      pid: r.pid, name: r.name || r.displayName, displayName: r.displayName,
      handle: r.handle || null, slot: r.slot, price: r.price,
    })),
    total: total.value,
    style: "lookbook",
    ...(scene ? { scene } : {}),
    // The stylist's look: what heads the panel and why it was chosen.
    ...(look && (look.key || look.note) ? { look: lookField(look) } : {}),
    engine: engine || "nbpro",
    costUSD: +Number(costUSD || 0).toFixed(6),
    refsUsed: rows.length,
    generatedBy: "generator",
    createdAt: nowMs,
    updatedAt: nowMs,
    updatedBy: updatedBy || "cron:socialStillAutopilot",
  };
}

/** The stylist's look as stored on a post or a log: no undefined, nothing long. Pure. */
function lookField(look) {
  return {
    key: look.key || null, name: look.name || null,
    note: look.note ? String(look.note).slice(0, 200) : null,
    score: Number.isFinite(Number(look.score)) ? Number(look.score) : null,
    source: look.source || null,
    // The opus critic's final scores and every round (lookbook/fit-agent
    // criticRecord): what Junid reads to see why a fit went out.
    ...(look.critic ? { critic: look.critic } : {}),
    ...(look.hero ? { hero: look.hero } : {}),
  };
}

/**
 * The feed caption with the stylist's note as its last paragraph, or the
 * caption unchanged when there is no note (or it is already there). Pure.
 */
function withStylingNote(caption, note) {
  const c = String(caption || "").trim();
  const n = String(note || "").trim();
  if (!n || c.includes(n)) return c;
  if (!c) return n;
  // Above a closing hashtag block, which is where a caption ends.
  const paras = c.split(/\n\s*\n/);
  const last = paras[paras.length - 1].trim();
  const tagsOnly = paras.length > 1 && /^(#[\p{L}\p{N}_]+\s*)+$/u.test(last);
  const out = tagsOnly ? [...paras.slice(0, -1), n, last].join("\n\n") : `${c}\n\n${n}`;
  // Instagram's caption ceiling is 2,200 characters: never pushed past it.
  return out.length <= 2200 ? out : c;
}

/**
 * The day's still record at social_still_log/{saDate}: which format was
 * planned, which posted, whether it fell back and why. What socialHealthScan
 * reads to report the still per day.
 *
 * Nulls are written explicitly for the absent fields. RTDB drops a null, and
 * update() leaves a key it is not given, so a reclaimed run that succeeds must
 * not keep the reason of the attempt before it.
 */
function stillLogEntry({ planned, posted, reason, costUSD, postId, twinId, scheduledAt, rows, total, nowMs, gate, scene, thumbCostUSD, look, stylistCostUSD }) {
  return {
    finishedAt: nowMs,
    planned: planned || null,
    posted: posted || null,
    // A lookbook day that did not post a lookbook fell back, including the day
    // the current style then failed too: that is the worst fallback, and the
    // two-days-running page must count it (architect review, S4).
    fallback: planned === "lookbook" && posted !== "lookbook",
    gate: gate || null,
    reason: reason ? String(reason).slice(0, 300) : null,
    costUSD: +Number(costUSD || 0).toFixed(4),
    postId: postId || null,
    twinId: twinId || null,
    scheduledAt: scheduledAt || null,
    rows: Number.isFinite(rows) ? rows : null,
    total: Number.isFinite(total) ? total : null,
    scene: scene || null,
    thumbCostUSD: Number.isFinite(thumbCostUSD) ? +thumbCostUSD.toFixed(4) : null,
    look: look && (look.key || look.note) ? lookField(look) : null,
    stylistCostUSD: Number.isFinite(stylistCostUSD) ? +stylistCostUSD.toFixed(5) : null,
  };
}

/**
 * ── ONE PRODUCT, ONE QUEUE ITEM ──────────────────────────────────────────────
 * Owner brief, 2026-10-18: a product must not be queued twice for the same
 * day. Every generator seeds its `used` set with this, so a product already
 * waiting in the queue (draft, approved or posting, on ANY day) is not picked
 * again until it has gone out. Stricter than "the same day", and it needs no
 * date arithmetic to be right. Pure.
 */
function queuedPids(posts) {
  const out = new Set();
  for (const p of posts || []) {
    if (!p || !["draft", "approved", "posting"].includes(p.status)) continue;
    for (const x of p.products || []) if (x && x.pid) out.add(x.pid);
  }
  return out;
}

module.exports = { STILL_SLOT, buildLookbookRecord, stillLogEntry, queuedPids, lookField, withStylingNote };

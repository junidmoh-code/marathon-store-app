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
}) {
  return {
    status: "approved",
    kind: "lookbook",
    format: "story",
    media: [{ url: urls.story, type: "image" }],
    artwork: {
      story: { url: urls.story, width: 1080, height: 1920 },
      feed: { url: urls.feed, width: 1080, height: 1350 },
      master: { url: urls.master, width: 1200, height: 1800 },
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
    engine: engine || "nbpro",
    costUSD: +Number(costUSD || 0).toFixed(6),
    refsUsed: rows.length,
    generatedBy: "generator",
    createdAt: nowMs,
    updatedAt: nowMs,
    updatedBy: updatedBy || "cron:socialStillAutopilot",
  };
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
function stillLogEntry({ planned, posted, reason, costUSD, postId, twinId, scheduledAt, rows, total, nowMs, gate }) {
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

module.exports = { STILL_SLOT, buildLookbookRecord, stillLogEntry, queuedPids };

// ─── THE FEED TWIN — ONE PICTURE, TWO SURFACES ───────────────────────────────
//
// Owner brief, 2026-08-27: "post all the stories on feeds as well, same picture
// should be posted both places". A story is gone in 24 hours; the picture that
// earned it is worth keeping on the feed.
//
// This module decides WHETHER a story gets a feed twin and WHAT that twin
// record looks like. It is pure — no RTDB, no network, no clock — so the two
// properties that actually matter can be tested rather than asserted in a
// comment:
//
//   1. The twin SHARES the picture and the slot. Same media array, same
//      scheduledAt, so "both places" means both on the same tick rather than
//      hours apart.
//   2. The twin does NOT share the caption. A story shows none — Meta drops it
//      on Instagram and Facebook's story endpoints have no message field at
//      all — and a feed post shows one. A record whose caption cannot be seen
//      must not claim to have one.
//
// WHY THE SAME IMAGE AND NOT A RE-RENDER. Instagram's feed used to refuse
// anything narrower than 4:5, which would have forced a crop of the 9:16 story
// artwork. Measured against the live account on 2026-08-27: a 9:16 feed
// container is accepted, and Instagram's own CDN serves the result back at
// 1072x1920 — not cropped. So there is nothing to re-render and no crop that
// could cut a product in half.
//
// The one real consequence: Instagram's GRID thumbnail is at most 4:5, so a
// 9:16 post is centre-cropped in the grid and whole when opened. That is
// inherent to putting a story-shaped picture on a feed.

"use strict";

// The twin is its own record rather than a second surface on the story's.
// The publisher, the queue, the retry budget and the per-platform results all
// key off "one record is one thing that goes to one place"; teaching them that
// a post can be two shapes at once would have touched every one of them. Two
// records that happen to share an image touch none of them.
const TWIN_ROLE = "feed-copy-of-story";

/**
 * Should this generation produce a feed twin?
 *
 * Only a story, only when the feature is on, and only when there is exactly
 * ONE image to share. The last condition is not hypothetical: a carousel kind
 * ("new arrivals") produces several media, and there is no such thing as a
 * story carousel — if such a post ever reached here, twinning it would build a
 * feed record out of media the story never had.
 */
function wantsFeedTwin(format, media, enabled) {
  return enabled === true
    && format === "story"
    && Array.isArray(media)
    && media.length === 1;
}

/**
 * The twin record, from the story record it copies.
 *
 * Everything the story carries is inherited EXCEPT the fields listed below,
 * which is deliberate: inheriting by default means a field added to a post
 * record in future is on the twin too, without anyone remembering to add it
 * here. The exceptions are the ones that are genuinely about the surface.
 *
 * @param story    the story record, exactly as it will be written
 * @param twinId   the twin's own push key
 * @param storyId  the story's push key — recorded for provenance both ways
 * @param caption  the model-written caption for the FEED (never the story's)
 */
function buildFeedTwin(story, { twinId, storyId, caption, captionSource, captionNote }) {
  if (!story || typeof story !== "object") throw new Error("buildFeedTwin: no story record");
  if (!twinId || !storyId) throw new Error("buildFeedTwin: both ids are required");

  const twin = {
    ...story,
    format: "feed",
    caption: caption == null ? null : caption,
    captionSource: captionSource || null,
    twinOf: storyId,
    twinRole: TWIN_ROLE,
  };
  // captionNote is present only when the caption model had something to say
  // about itself. Absent must mean ABSENT — writing `undefined` into RTDB
  // throws, and writing null would invent a note that does not exist.
  if (captionNote) twin.captionNote = captionNote;
  else delete twin.captionNote;
  // A twin is never itself twinned. Inheriting this from the story would point
  // the twin at itself the moment the story's own twinId is stamped on.
  delete twin.twinId;
  return twin;
}

/**
 * The multi-path update that writes a story and its twin TOGETHER.
 *
 * One atomic write, not two. Written separately, a crash between them leaves a
 * story whose twin never existed — silently half of what the day was meant to
 * post, with nothing to notice it. Returns the update map; the caller does the
 * writing, so this stays pure.
 */
function twinWriteUpdates(postsPath, storyId, story, twinId, twin) {
  const updates = { [`${postsPath}/${storyId}`]: story };
  if (twinId && twin) {
    updates[`${postsPath}/${twinId}`] = twin;
    updates[`${postsPath}/${storyId}/twinId`] = twinId;
  }
  return updates;
}

module.exports = { wantsFeedTwin, buildFeedTwin, twinWriteUpdates, TWIN_ROLE };

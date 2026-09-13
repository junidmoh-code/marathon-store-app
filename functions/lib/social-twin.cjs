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
// THE SAME DESIGN, ITS OWN FILE. On 2026-08-27 the twin shared the story's
// 1080x1920 file, because a 9:16 feed container was accepted and served back
// uncropped. But the feed SHOWS a 4:5 frame — 285 rows off the top and the
// bottom — and the wordmark lived in those rows: the 4 Sep NIKE NOCTA post went
// out with MARATHON sliced in half and the web address cropped away.
//
// So the generator now renders the story's layout a second time at a native
// 1080x1350 (social-render.cjs, `artwork.feed` on the story record), and the
// twin's media IS that file. A story with no feed render is not twinned at all
// (hasFeedArtwork) rather than falling back to the file that gets cropped.

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
/** The 1080x1350 render a story record carries for its feed twin, or null. */
function feedArtworkOf(record) {
  const feed = record && record.artwork && record.artwork.feed;
  return feed && typeof feed.url === "string" && feed.url ? feed : null;
}

/**
 * Does this record carry a feed render to twin with? The generator requires it
 * before writing a twin: without one the only picture available is the story's
 * 1080x1920 file, and the feed crops that through the wordmark.
 */
function hasFeedArtwork(record) {
  return feedArtworkOf(record) !== null;
}

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
  // The picture is the one thing about the surface that is NOT the story's:
  // the feed gets the 1080x1350 render of the same design. An older record with
  // no artwork keeps the inherited media, exactly as before.
  const feedArt = feedArtworkOf(story);
  if (feedArt) twin.media = [{ type: "image", url: feedArt.url }];
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
  // ── NO PATH MAY BE AN ANCESTOR OF ANOTHER ────────────────────────────────
  // RTDB REJECTS an update map containing both a path and a descendant of it.
  // The back-reference was originally its own key —
  // `social_posts/<id>/twinId` alongside `social_posts/<id>` — which is
  // exactly that shape, so every twinned generation would have THROWN at the
  // write: the picture already paid for cleaned up, the post lost, and the
  // day's story silently missing. It never reached production; it would have
  // failed on the first story the moment it did.
  //
  // twinId therefore goes INSIDE the story object, where it was always
  // logically part of the record anyway. The twin is built before this from
  // the story WITHOUT it, so the twin never inherits a pointer to itself.
  const hasTwin = Boolean(twinId && twin);
  return hasTwin
    ? {
        [`${postsPath}/${storyId}`]: { ...story, twinId },
        [`${postsPath}/${twinId}`]: twin,
      }
    : { [`${postsPath}/${storyId}`]: story };
}

/**
 * The caption fields for the PRIMARY record — three fields that describe one
 * caption, so they cannot come from two places.
 *
 * A story keeps the plain fallback line: nothing can display a story's caption
 * (Meta drops it, and Facebook's story endpoints have no message field), so a
 * model-written one there would be a lie in the queue. When the story is
 * twinned a caption IS written — for the FEED copy — and the trap is letting
 * only `caption` fall back to the plain line while `captionSource` and
 * `captionNote` keep describing the twin's. That produced a story record
 * reading `captionSource: "ai"` beside a caption the model never wrote, and,
 * when the model had failed, a note explaining a failure nothing to do with it.
 *
 * @returns { caption, captionSource, captionNote } — captionNote is null when
 *          there is none; the caller omits the key rather than writing null.
 */
function primaryCaptionFields(format, { fallback, caption, captionSource, captionNote }) {
  if (format === "story") {
    return { caption: fallback, captionSource: "not-needed", captionNote: null };
  }
  return {
    caption,
    captionSource: captionSource || null,
    captionNote: captionNote || null,
  };
}

module.exports = { wantsFeedTwin, buildFeedTwin, twinWriteUpdates, primaryCaptionFields, feedArtworkOf, hasFeedArtwork, TWIN_ROLE };

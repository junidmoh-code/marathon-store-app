// ─── TURNING A REEL'S STILL INTO A PUBLISHABLE VIDEO ─────────────────────────
// The encoder (reel.mjs) writes an mp4 to local disk. Meta cannot read local
// disk: a REELS container takes a `video_url` that Meta's own servers fetch. So
// between encoding and publishing the file has to become a public URL, and this
// is that step.
//
// ── WHY IT HAPPENS AT PUBLISH TIME, NOT AT GENERATION ────────────────────────
// The generator runs in Cloud Functions, which has no ffmpeg. The publisher
// runs on the Mac mini, which does. Encoding here also means a reel is only
// ever encoded if it is actually going out — a draft that is edited, discarded
// or never approved costs nothing.
//
// ── IDEMPOTENT ON PURPOSE ────────────────────────────────────────────────────
// A run can be interrupted between encoding and publishing, and the next tick
// will pick the same post up again. If the post already carries a video whose
// URL answers, that video is reused rather than re-encoded and re-uploaded —
// otherwise a post that fails to publish three times leaves three orphaned
// videos in Storage and pays the encode each time.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { encodeReel } from "./reel.mjs";

const STORAGE_BUCKET = "marathon-club.firebasestorage.app";

/** Is this media already a usable video? */
export function hasVideo(post) {
  return (post?.media || []).some((m) => m && m.type === "video" && typeof m.url === "string" && m.url);
}

/** The still a reel is built from — its first image. */
export function stillOf(post) {
  return (post?.media || []).find((m) => m && m.type === "image" && m.url) || null;
}

/**
 * Ensure a reel post has a video, encoding and uploading one if it does not.
 *
 * Returns { ok: true, media } with the media array the publisher should send,
 * or { ok: false, reason } — never throws. A reel that cannot be encoded must
 * not take the whole run down with it, and must not silently publish its still
 * to the feed instead: the caller decides, and today it fails the post loudly
 * rather than posting the wrong thing to the wrong place.
 */
export async function ensureReelVideo(post, { admin, fetchImage, log = () => {} } = {}) {
  if (hasVideo(post)) return { ok: true, media: post.media, reused: true };

  const still = stillOf(post);
  if (!still) return { ok: false, reason: "a reel needs a still to build from and this post has none" };

  const id = randomUUID();
  const inPath = join(tmpdir(), `reel-in-${id}.jpg`);
  const outPath = join(tmpdir(), `reel-out-${id}.mp4`);
  try {
    const buf = await fetchImage(still.url);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(inPath, buf);

    const enc = await encodeReel(inPath, outPath);
    if (!enc.ok) return { ok: false, reason: `encode failed — ${enc.reason}` };
    log(`   encoded reel: ${(enc.bytes / 1048576).toFixed(2)} MB`);

    // Same Storage prefix and the same download-token shape the generator uses
    // for post images, so a reel's video lives beside its still and is public
    // in exactly the way Meta needs to fetch it.
    const token = randomUUID();
    const path = `aiStudio/social/posts/${post.id}/reel_${token}.mp4`;
    await admin.storage().bucket(STORAGE_BUCKET).upload(outPath, {
      destination: path,
      resumable: false,
      metadata: {
        contentType: "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    log(`   uploaded reel video`);
    // The video REPLACES the still in what is sent. The still stays on the
    // record as media[0] so the queue still has something to show as a cover.
    return { ok: true, media: [{ type: "video", url, path, posterUrl: still.url }], encoded: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    for (const f of [inPath, outPath]) await unlink(f).catch(() => {});
  }
}

// ─── A REEL FROM A STILL — ffmpeg, LOCALLY, FREE ─────────────────────────────
// A finished post image becomes a short vertical video with a slow Ken Burns
// move. Nothing generative, no external service, no API key, no credits, no
// account. Owner's rule, restated because it is the kind of thing that drifts:
// if you find yourself reaching for an AI video service here, you have misread
// the requirement.
//
// ── WHY ONLY REELS GET VIDEO ─────────────────────────────────────────────────
// A feed post and a story both accept a still. Encoding one for them would
// spend CPU and upload bandwidth to deliver a slideshow of a single frame that
// Instagram will letterbox anyway. Video is produced ONLY where the format
// actually requires it, which today is the reel.
//
// ── WHY THIS RUNS ON THE MAC MINI ────────────────────────────────────────────
// The Cloud Functions runtime has no ffmpeg and cannot be given one without
// shipping a custom image. The mini already has Homebrew, already runs the
// publisher, and already holds the credentials — so the encode happens beside
// the thing that posts it, one tick, no extra moving parts.
//
// ── WHAT MAKES INSTAGRAM ACCEPT IT ───────────────────────────────────────────
// Constants below are Meta's documented reel envelope, and each one has been a
// rejection at some point for somebody:
//   · 1080x1920, exactly 9:16. A reel that is 4:5 is letterboxed or refused.
//   · H.264 high profile, yuv420p. Without the pixel format some players show
//     a green frame and Meta's transcoder is one of them.
//   · An AUDIO TRACK MUST EXIST. A silent reel is fine; a reel with no audio
//     stream at all is rejected. So a silent AAC track is muxed in.
//   · +faststart, so the moov atom is at the front and Meta can begin reading
//     without downloading the whole file.
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";

export const REEL_W = 1080;
export const REEL_H = 1920;
export const REEL_SECONDS = 6;
export const REEL_FPS = 30;
// The move. 8% over six seconds reads as a drift rather than a zoom; past
// about 15% it starts to feel like a slideshow effect, which is the look this
// is trying not to have.
export const REEL_ZOOM = 1.08;

/** Where ffmpeg is, or null. Checked rather than assumed. */
export async function findFfmpeg(candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
  for (const c of candidates) {
    try { await access(c); return c; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The filter chain, as a pure string, so it can be read and tested without
 * running anything.
 *
 * zoompan works on a per-FRAME counter, so the zoom is expressed over
 * seconds*fps frames rather than over time. It is also notoriously jittery on
 * a still: the input is first scaled UP by 4x so the sub-pixel steps land on
 * real pixels, and only then panned — without that the image visibly stutters.
 */
export function kenBurnsFilter({ w = REEL_W, h = REEL_H, seconds = REEL_SECONDS, fps = REEL_FPS, zoom = REEL_ZOOM } = {}) {
  const frames = Math.round(seconds * fps);
  const step = (zoom - 1) / frames;
  return [
    // Fit the still inside the reel frame without ever distorting it, then pad
    // the remainder. The owner's rule: fit and pad, never stretch.
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `scale=${w * 4}:${h * 4}`,
    `zoompan=z='min(zoom+${step.toFixed(6)},${zoom})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`,
    "setsar=1",
    // ── COLOUR RANGE, NOT JUST PIXEL FORMAT ────────────────────────────────
    // A JPEG still is FULL range, and ffprobe reported yuvj420p even with
    // -pix_fmt yuv420p and a format= filter: the "j" is a RANGE tag, and
    // neither of those touches range. Adding format=yuv420p alone produced a
    // byte-identical file, which is how it was caught.
    //
    // It has to be converted in the scale (in_range=full -> out_range=tv) and
    // tagged on the encoder. A player that assumes limited range renders full
    // range washed out and shifted — on a post whose entire point is that the
    // colour is the product's REAL colour, and where a wrong shade is a return.
    "format=yuv420p",
  ].join(",");
}

/** The full argument list. Pure, so the encode can be asserted without running it. */
export function ffmpegArgs(stillPath, outPath, opts = {}) {
  const { seconds = REEL_SECONDS, fps = REEL_FPS } = opts;
  return [
    "-y",
    "-loop", "1", "-i", stillPath,
    // The silent audio track Instagram requires to exist.
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf", kenBurnsFilter(opts),
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-r", String(fps), "-t", String(seconds),
    "-c:a", "aac", "-b:a", "128k", "-shortest",
    "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * Encode one still into a reel. Resolves { ok, path, bytes } or { ok: false,
 * reason } — never throws, because a failed encode must degrade to "post the
 * still" rather than lose a generation that has already been paid for.
 */
export async function encodeReel(stillPath, outPath, opts = {}) {
  const ffmpeg = opts.ffmpeg || await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: "ffmpeg is not installed on this machine" };

  const args = ffmpegArgs(stillPath, outPath, opts);
  const code = await new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString().slice(0, 2000); });
    p.on("error", () => resolve({ code: -1, err: "ffmpeg could not be started" }));
    p.on("close", (c) => resolve({ code: c, err }));
  });
  if (code.code !== 0) {
    return { ok: false, reason: `ffmpeg exited ${code.code}: ${String(code.err).trim().split("\n").pop()}` };
  }
  try {
    const s = await stat(outPath);
    if (!s.size) return { ok: false, reason: "ffmpeg produced an empty file" };
    return { ok: true, path: outPath, bytes: s.size };
  } catch {
    return { ok: false, reason: "ffmpeg reported success but wrote no file" };
  }
}

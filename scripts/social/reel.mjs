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
export const REEL_FPS = 30;

// ── HOW LONG, AND WHY NOT LONGER ─────────────────────────────────────────────
// Was 6 seconds. Six seconds is not a reel, it is a GIF: there is almost no
// watch time to accumulate, and watch time is the signal Instagram's discovery
// system actually reads.
//
// The published numbers do NOT point at one answer, and picking the headline
// one would have been wrong here. Socialinsider's 2026 study of ~140,000
// business-account reels found the 45–60s bracket took the highest engagement
// rate and about twice the median views of anything under 30s. Most other
// guidance puts the sweet spot at 15–30s. Both are describing videos with
// something happening in them — cuts, speech, a story.
//
// OURS IS ONE PHOTOGRAPH. There is no footage, no narration, nothing new
// arriving after the first frame. Copying the 45–60s finding onto a single
// still would produce a minute of slow pan that nobody finishes, and
// COMPLETION RATE is the underlying signal both studies are really measuring:
// a short clip most people finish outranks a long one most people abandon.
//
// So the number is chosen against what we can actually fill, not against the
// best bracket in someone else's data: FIFTEEN seconds, the floor of the
// 15–30s band and 2.5x what it was, with four distinct camera moves (below) so
// there is a reason to still be watching at the end.
//
// THIS IS A GUESS WITH A PLAN TO STOP GUESSING. Once instagram_manage_insights
// is on the token, reel retention is readable per post, and this constant
// should be set from our own completion numbers instead of someone else's
// median. It is deliberately one number in one place for exactly that reason.
export const REEL_SECONDS = 15;

// ── THE CAMERA MOVE, AS KEYFRAMES ────────────────────────────────────────────
// Four moves rather than one continuous creep. A single slow zoom is fine over
// six seconds and becomes wallpaper over fifteen — the eye stops registering a
// constant rate of change, which is precisely when someone scrolls.
//
// Written as KEYFRAMES, not as per-phase deltas, so continuity is structural:
// each phase runs from one keyframe to the next, so the end of one move IS the
// start of the next and a visible jump between phases cannot be expressed.
// (An earlier draft used per-phase offsets and could silently describe a cut.)
//
//   zoom  scale factor. 1.00 is the padded frame, edge to edge.
//   x, y  offset from centre as a FRACTION of the frame, so the numbers mean
//         the same thing regardless of resolution. Positive y is downward.
//
// The shape: push in on the product, drift across it, pull back to show the
// whole scene, then settle low where the price band sits.
// ── THE MOVE IS BOUNDED BY THE DESIGN'S OWN SAFE AREA ───────────────────────
// social-design.cjs reserves safeTop 250px and safeBottom 320px on a reel, and
// that is where the wordmark and the shop line are drawn. A zoom of Z crops
// h*(1-1/Z)/2 from each edge, and a y offset crops h*|y| more from one of
// them — so at the deepest point here, 1.14 with y -0.05, the bottom loses
// 118 + 96 = 214px. That is inside the 320px the design left empty, which is
// why the drift is UPWARD: the space below the shop line is the only place on
// this canvas with room to give.
//
// Anything more aggressive starts eating the wordmark, and a reel that crops
// its own branding is worse than a reel that moves less.
export const REEL_KEYFRAMES = [
  { at: 0.0,  zoom: 1.00, x: 0.000,  y: 0.000 },  // the whole frame
  { at: 4.5,  zoom: 1.14, x: 0.000,  y: 0.000 },  // push in on the product
  { at: 8.0,  zoom: 1.14, x: -0.020, y: -0.050 }, // hold and drift up
  { at: 11.5, zoom: 1.03, x: -0.010, y: 0.000 },  // pull back to the full scene
  { at: 15.0, zoom: 1.11, x: 0.000,  y: 0.025 },  // settle low, on the price
];

// The deepest the move ever goes. Kept as a named export because it is the one
// number that decides whether this reads as a drift or as a slideshow effect,
// and because a test asserts it stays sane.
export const REEL_ZOOM = Math.max(...REEL_KEYFRAMES.map((k) => k.zoom));

/** Where ffmpeg is, or null. Checked rather than assumed. */
export async function findFfmpeg(candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
  for (const c of candidates) {
    try { await access(c); return c; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The keyframes turned into PHASES — one per gap between consecutive
 * keyframes. Pure, and separated out so the continuity property can be
 * asserted on data rather than read out of a filter string.
 */
export function reelPhases({ keyframes = REEL_KEYFRAMES, fps = REEL_FPS } = {}) {
  const out = [];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    const frames = Math.round((b.at - a.at) * fps);
    if (frames < 1) throw new Error(`reel keyframes ${i} and ${i + 1} are too close together to render a frame`);
    out.push({ from: a, to: b, frames, seconds: b.at - a.at });
  }
  return out;
}

/** Total duration the keyframes describe. The single source for -t. */
export function reelDuration({ keyframes = REEL_KEYFRAMES } = {}) {
  return keyframes[keyframes.length - 1].at - keyframes[0].at;
}

/**
 * The filter graph, as a pure string, so it can be read and tested without
 * running anything.
 *
 * ── WHY A GRAPH AND NOT ONE zoompan ─────────────────────────────────────────
 * zoompan takes ONE expression per property, so four different moves in one
 * pass would mean nesting if(lt(on,…)) three deep in each of z, x and y —
 * unreadable, and untestable except by rendering it. Instead the padded still
 * is split into one branch per phase, each branch gets its own plain linear
 * zoompan, and the branches are concatenated. Each move is then a few
 * arithmetic terms that can be read at a glance.
 *
 * ── WHY THE MOTION IS DRIVEN BY `on`, NOT BY `zoom` ─────────────────────────
 * The old chain accumulated: z='min(zoom+step,max)', where `zoom` is the
 * PREVIOUS frame's value. That drifts with rounding and cannot be made to
 * arrive at an exact value on an exact frame — fine for one move, useless when
 * four of them have to meet. Every phase here is a straight line in the output
 * frame counter, so phase N ends exactly where phase N+1 begins.
 *
 * ── THE 4x UPSCALE STAYS ────────────────────────────────────────────────────
 * zoompan is notoriously jittery on a still: without scaling up first, the
 * sub-pixel steps land between real pixels and the image visibly stutters.
 * It is done ONCE, before the split, so four branches share the cost.
 */
export function motionFilterComplex({
  w = REEL_W, h = REEL_H, fps = REEL_FPS, keyframes = REEL_KEYFRAMES,
} = {}) {
  const phases = reelPhases({ keyframes, fps });
  const n = phases.length;

  // A linear ramp from `a` to `b` across this phase's frames. A single-frame
  // phase would divide by zero, so it is pinned to its end value instead.
  const ramp = (a, b, frames) => {
    if (a === b) return a.toFixed(5);
    if (frames < 2) return b.toFixed(5);
    return `${a.toFixed(5)}+(${(b - a).toFixed(5)})*on/${frames - 1}`;
  };

  const head = [
    // Fit the still inside the reel frame without ever distorting it, then pad
    // the remainder. The owner's rule: fit and pad, never stretch.
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:in_range=full:out_range=tv`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `scale=${w * 4}:${h * 4}`,
    `split=${n}`,
  ].join(",");

  const labels = phases.map((_, i) => `[p${i}]`).join("");
  const branches = phases.map((ph, i) => {
    const z = ramp(ph.from.zoom, ph.to.zoom, ph.frames);
    // Centre of the zoomed viewport, plus this phase's offset. The offset is a
    // fraction of the frame, so it reads the same at any resolution.
    const x = `iw/2-(iw/zoom/2)+iw*(${ramp(ph.from.x, ph.to.x, ph.frames)})`;
    const y = `ih/2-(ih/zoom/2)+ih*(${ramp(ph.from.y, ph.to.y, ph.frames)})`;
    return `[p${i}]zoompan=z='${z}':x='${x}':y='${y}':d=${ph.frames}:s=${w}x${h}:fps=${fps}[z${i}]`;
  });

  const tail = [
    `concat=n=${n}:v=1:a=0`,
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

  return [
    `[0:v]${head}${labels}`,
    ...branches,
    `${phases.map((_, i) => `[z${i}]`).join("")}${tail}[v]`,
  ].join(";");
}

/** The full argument list. Pure, so the encode can be asserted without running it. */
export function ffmpegArgs(stillPath, outPath, opts = {}) {
  const { fps = REEL_FPS, keyframes = REEL_KEYFRAMES } = opts;
  const seconds = opts.seconds ?? reelDuration({ keyframes });
  return [
    "-y",
    // ── NOT -loop 1 ──────────────────────────────────────────────────────────
    // The old chain looped the still into an endless stream and let -t cut it.
    // zoompan emits `d` frames PER INPUT FRAME, so with a looped input every
    // one of the four branches would try to emit its whole phase again for
    // every frame it was handed. Fed as a SINGLE image, each branch emits
    // exactly its own phase once, which is the shape zoompan is built for.
    "-i", stillPath,
    // The silent audio track Instagram requires to exist.
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex", motionFilterComplex({ ...opts, fps, keyframes }),
    "-map", "[v]", "-map", "1:a",
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

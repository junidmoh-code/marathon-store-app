// ── TIKTOK HANDOFF QUEUE: MEDIA CONVERSION ───────────────────────────────────
// Turns a social post's media into files TikTok (through Higgsfield) accepts.
// Used by tiktok-queue-build.mjs; tested in tiktokQueueMedia.test.mjs.
// An error with { gone: true } means the source can never be made to fit (the
// post is rejected); any other error is transient (the post stays queued).
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { adminRequire } from "../adminRequire.mjs";
import { PHOTO_H, PHOTO_MAX_BYTES, PHOTO_W, isVertical, videoPlan } from "./tiktokHfQueue.mjs";

const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FFPROBE = existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
const gone = (msg) => Object.assign(new Error(msg), { gone: true });

/** The tool ran and refused the file (non-zero exit): the media is bad. The tool could not start, timed out or was killed: retry later. */
const toolRefused = (e) => typeof e?.status === "number" && e.status !== 0 && !e.signal;
const lastLine = (e) => String(e?.stderr || e?.message || "").trim().split("\n").pop().slice(0, 200);

function probe(f) {
  try { return JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { stdio: ["ignore", "pipe", "pipe"] }).toString()); }
  catch (e) { if (toolRefused(e)) throw gone(`video unreadable: ${lastLine(e)}`); throw new Error(`ffprobe failed to run: ${lastLine(e)}`); }
}

/** JPEG, exactly 1080x1920, at most 20 MB. A non-vertical picture sits on a blurred, darkened fill of itself (the story look). */
export async function toPhoto(buf) {
  const sharp = adminRequire(import.meta.url)("sharp");
  let width = 0, height = 0;
  try {
    const m = await sharp(buf).metadata();
    [width, height] = (m.orientation || 1) >= 5 ? [m.height || 0, m.width || 0] : [m.width || 0, m.height || 0]; // EXIF 5-8 = quarter turn
    await sharp(buf).stats(); // decodes every pixel: a corrupt file fails here, not halfway through
  }
  catch (e) { throw gone(`image unreadable: ${String(e.message).slice(0, 200)}`); }
  let img;
  if (isVertical(width, height)) {
    img = sharp(buf).rotate().resize(PHOTO_W, PHOTO_H, { fit: "cover" }).flatten({ background: "#ffffff" });
  } else {
    const fill = await sharp(buf).rotate().resize(PHOTO_W, PHOTO_H, { fit: "cover" }).blur(40).modulate({ brightness: 0.55 }).flatten({ background: "#000000" }).toBuffer();
    const fg = await sharp(buf).rotate().resize(PHOTO_W, PHOTO_H, { fit: "inside" }).flatten({ background: "#ffffff" }).toBuffer();
    img = sharp(fill).composite([{ input: fg, gravity: "center" }]);
  }
  const base = await img.toBuffer();
  for (const q of [90, 82, 72, 60]) {
    const out = await sharp(base).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (out.length <= PHOTO_MAX_BYTES) return out;
  }
  throw gone("photo over 20 MB even at quality 60");
}

/** Writes an MP4 TikTok accepts to `out`, or throws { gone: true } when the source cannot be made to fit. */
export function toVideo(buf, out) {
  const raw = `${out}.src`;
  writeFileSync(raw, buf);
  try {
    const plan = videoPlan(probe(raw));
    if (!plan.ok) throw Object.assign(new Error(`video unusable: ${plan.reason}`), { gone: true });
    if (!plan.transcode) { renameSync(raw, out); return null; }
    try {
      execFileSync(FFMPEG, ["-y", "-v", "error", "-i", raw, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", out], { timeout: 15 * 60000, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      rmSync(out, { force: true });
      if (toolRefused(e)) throw gone(`video re-encode failed: ${lastLine(e)}`);
      throw new Error(`ffmpeg failed to run: ${lastLine(e)}`);
    }
    const after = videoPlan(probe(out));
    if (!after.ok || after.transcode) throw Object.assign(new Error(`video still unusable after re-encode: ${after.reason || after.transcode}`), { gone: true });
    return plan.transcode;
  } finally { rmSync(raw, { force: true }); }
}

// ── TIKTOK HANDOFF QUEUE — media conversion tests (tiktokQueueMedia.mjs) ────
// Real ffmpeg/sharp on tiny generated files: the re-encode path is the one that
// silently broke before (ffmpeg cannot pick a muxer for "1.mp4.part").
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminRequire } from "../adminRequire.mjs";
import { toPhoto, toVideo } from "./tiktokQueueMedia.mjs";

const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FFPROBE = existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
const hasFfmpeg = (() => { try { execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const dir = mkdtempSync(join(tmpdir(), "tiktok-media-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const clip = (name, args) => { const f = join(dir, name); execFileSync(FFMPEG, ["-y", "-v", "error", ...args, f]); return readFileSync(f); };
const info = (f) => JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f]).toString());

describe.skipIf(!hasFfmpeg)("toVideo", () => {
  it("re-encodes an off-spec clip (15 fps, mpeg4, mp3) into H.264/AAC 30 fps, even to a .part path", () => {
    const src = clip("bad.mkv", ["-f", "lavfi", "-i", "testsrc=s=360x640:r=15:d=4", "-f", "lavfi", "-i", "sine=d=4", "-c:v", "mpeg4", "-c:a", "libmp3lame", "-shortest"]);
    const out = join(dir, "1.mp4.part");
    const why = toVideo(src, out);
    expect(why).toMatch(/fps/);
    const j = info(out);
    const v = j.streams.find((s) => s.codec_type === "video");
    const a = j.streams.find((s) => s.codec_type === "audio");
    expect(v.codec_name).toBe("h264");
    expect(v.avg_frame_rate).toBe("30/1");
    expect(a.codec_name).toBe("aac");
    expect(j.format.format_name).toMatch(/mp4/);
  });
  it("keeps a compliant clip byte for byte", () => {
    const src = clip("good.mp4", ["-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const out = join(dir, "good-out.mp4");
    expect(toVideo(src, out)).toBeNull();
    expect(readFileSync(out).equals(src)).toBe(true);
  });
  it("rejects (gone) a clip too short or not a video at all", () => {
    const short = clip("short.mp4", ["-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    expect(() => toVideo(short, join(dir, "s.mp4"))).toThrow(expect.objectContaining({ gone: true }));
    expect(() => toVideo(Buffer.from("not a video"), join(dir, "n.mp4"))).toThrow(expect.objectContaining({ gone: true }));
  });
});

describe("toPhoto", () => {
  const sharp = adminRequire(import.meta.url)("sharp");
  it("turns a 4:5 PNG into a 1080x1920 JPEG", async () => {
    const png = await sharp({ create: { width: 800, height: 1000, channels: 4, background: "#c33" } }).png().toBuffer();
    const out = await toPhoto(png);
    const m = await sharp(out).metadata();
    expect([m.format, m.width, m.height]).toEqual(["jpeg", 1080, 1920]);
  });
  it("fills an oversized 9:16 picture down to 1080x1920", async () => {
    const big = await sharp({ create: { width: 2160, height: 3840, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const m = await sharp(await toPhoto(big)).metadata();
    expect([m.width, m.height]).toEqual([1080, 1920]);
  });
});

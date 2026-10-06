import { describe, it, expect } from "vitest";
import { parseMoov, probeIsoBmff } from "./videoProbe.js";

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type, payload) => [...u32(8 + payload.length), ...type.split("").map((c) => c.charCodeAt(0)), ...payload];
const mvhd = (timescale, duration) => box("mvhd", [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...new Array(80).fill(0)]);
const tkhd = (w, h, rotate = false) => {
  const matrix = rotate
    ? [...u32(0), ...u32(0x10000), ...u32(0), ...u32(0xffff0000), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)]
    : [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  return box("tkhd", [0, 0, 0, 3, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0, ...matrix, ...u32(w * 65536), ...u32(h * 65536)]);
};
const file = (moovChildren, { moovLast = false } = {}) => {
  const ftyp = box("ftyp", [..."isom".split("").map((c) => c.charCodeAt(0)), 0, 0, 2, 0]);
  const mdat = box("mdat", new Array(1000).fill(7));
  const moov = box("moov", moovChildren.flat());
  return new Uint8Array(moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
};
const reader = (bytes) => async (off, len) => bytes.slice(off, off + len);

describe("MP4/MOV header reader", () => {
  it("reads duration and picture size, with the audio track (0×0) ignored", async () => {
    const f = file([mvhd(600, 600 * 42), box("trak", tkhd(0, 0)), box("trak", tkhd(1920, 1080))]);
    expect(await probeIsoBmff(reader(f), f.length)).toEqual({ durationMs: 42000, width: 1920, height: 1080 });
  });
  it("finds a moov at the END of the file (how phones often write it) and honours a 90° rotation", async () => {
    const f = file([mvhd(1000, 12_345), box("trak", tkhd(1920, 1080, true))], { moovLast: true });
    expect(await probeIsoBmff(reader(f), f.length)).toEqual({ durationMs: 12345, width: 1080, height: 1920 });
  });
  it("answers null for something that is not an MP4, never throws", async () => {
    const junk = new Uint8Array(200).fill(255);
    expect(await probeIsoBmff(reader(junk), junk.length)).toBeNull();
    expect(parseMoov(new Uint8Array(3))).toEqual({ durationMs: null, width: null, height: null });
  });
});

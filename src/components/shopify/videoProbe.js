// ─── VIDEO HEADER READER (MP4 / MOV) ─────────────────────────────────────────
// Duration and picture size for a picked video, read straight out of the
// file's ISO-BMFF boxes. The <video> element is asked first (mediaUpload.js),
// because it accounts for rotation exactly as a player shows it; this is the
// fallback for a phone that cannot DECODE the file (an HEVC .mov on an
// Android browser) and would otherwise leave the item with no size or length
// — which is what decides whether Shopify can take it.
//
// Reads only box headers plus the `moov` box (a few hundred KB even for a
// long clip) through `readAt(offset, length) → Promise<Uint8Array>`, so a
// 1 GB file is never loaded. Pure apart from that reader; tested with
// hand-built boxes in videoProbe.test.js. Returns null on anything it does
// not understand — never throws.

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
const s32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// Child boxes of b[start, end) → [{ type, start (payload), end }]
function children(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = type4(b, o + 4);
    let header = 8;
    if (size === 1) { if (o + 16 > end) break; size = u64(b, o + 8); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}

function parseMvhd(b, s) {
  const v = b[s];
  const o = s + 4;
  if (v === 1) return { timescale: u32(b, o + 16), duration: u64(b, o + 20) };
  return { timescale: u32(b, o + 8), duration: u32(b, o + 12) };
}

function parseTkhd(b, s, e) {
  const v = b[s];
  // version/flags 4; v1: ctime 8, mtime 8, id 4, rsv 4, dur 8; v0: 4,4,4,4,4
  const afterDur = s + 4 + (v === 1 ? 32 : 20);
  const matrix = afterDur + 8 + 2 + 2 + 2 + 2;
  const wOff = matrix + 36;
  if (wOff + 8 > e) return null;
  const width = u32(b, wOff) / 65536;
  const height = u32(b, wOff + 4) / 65536;
  // A 90°/270° rotation matrix has a=d=0, b,c=±1: the picture shows rotated.
  const mb = s32(b, matrix + 4);
  return { width: Math.round(width), height: Math.round(height), rotated: mb !== 0 };
}

/** Parse a `moov` payload → { durationMs, width, height } (any may be null). */
export function parseMoov(b, start = 0, end = b.length) {
  let durationMs = null;
  let width = null;
  let height = null;
  for (const box of children(b, start, end)) {
    if (box.type === "mvhd") {
      const { timescale, duration } = parseMvhd(b, box.start);
      if (timescale > 0 && duration > 0 && duration < 0xffffffff) durationMs = Math.round((duration / timescale) * 1000);
    } else if (box.type === "trak" && width == null) {
      const tk = children(b, box.start, box.end).find((c) => c.type === "tkhd");
      const t = tk && parseTkhd(b, tk.start, tk.end);
      // Audio tracks carry 0×0; the first track with a picture is the video.
      if (t && t.width > 0 && t.height > 0) {
        width = t.rotated ? t.height : t.width;
        height = t.rotated ? t.width : t.height;
      }
    }
  }
  return { durationMs, width, height };
}

/**
 * Walk the top-level boxes of a file to its `moov` and parse it.
 * `readAt(offset, length)` → Promise<Uint8Array>; `size` = file length.
 */
export async function probeIsoBmff(readAt, size) {
  try {
    let o = 0;
    for (let guard = 0; guard < 64 && o + 8 <= size; guard++) {
      const h = await readAt(o, 16);
      if (h.length < 8) return null;
      let boxSize = u32(h, 0);
      const type = type4(h, 4);
      let header = 8;
      if (boxSize === 1) { boxSize = u64(h, 8); header = 16; }
      else if (boxSize === 0) boxSize = size - o;
      if (boxSize < header) return null;
      if (type === "moov") {
        const len = boxSize - header;
        if (len > MAX_MOOV_BYTES) return null;
        const body = await readAt(o + header, len);
        return parseMoov(body, 0, body.length);
      }
      o += boxSize;
    }
    return null;
  } catch {
    return null;
  }
}

/** probeIsoBmff over a File/Blob. */
export function probeVideoFile(file) {
  const readAt = async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer());
  return probeIsoBmff(readAt, file.size);
}

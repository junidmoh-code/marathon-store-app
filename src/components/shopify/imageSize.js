// ─── HOW BIG IS THIS PICTURE, BEFORE ANYTHING DECODES IT? ────────────────────
// The decoders in imageDecode.js want a resize hint, and a resize hint is only
// safe if we know the picture is BIGGER than the ceiling we are asking for.
// createImageBitmap's `resizeWidth` is a width, not a maximum: hand it 1600
// for a 900px graphic and the browser UPSCALES, and every later step then
// works on invented pixels.
//
// The old gate guessed from the FILE SIZE — "over 900 KB, therefore a phone
// photo". That is a proxy, and it is wrong in exactly the case that matters:
// a losslessly-compressed screenshot, a scan, or a PNG cutout can be several
// megabytes and only 1,200 pixels wide. Those were upscaled on every upload.
//
// So this file answers the real question instead. Every one of these formats
// prints its pixel dimensions in a header near the front of the file, so the
// answer costs ONE slice of the first 128 KB and no decode at all:
//
//   JPEG   the SOFn frame header          PNG   the IHDR chunk
//   GIF    the logical screen descriptor  BMP   the DIB header
//   WebP   VP8 / VP8L / VP8X              TIFF  IFD0 tags 0x0100 / 0x0101
//   HEIC / HEIF / AVIF   the ISO-BMFF `ispe` box
//
// PURE, and deliberately so: no Blob, no browser, no decoding. It takes bytes
// and returns numbers, which is what makes the awkward cases (a truncated
// header, a marker chain that runs off the end, a file claiming 0×0) testable
// as data rather than as photographs.
//
// WHAT IT DOES NOT DO IS GUESS. An unrecognised container returns null, and
// the caller decides what "I don't know" means. A wrong number here would be
// worse than none: it would silently resize every upload by the wrong factor.
//
// NEVER a regex lookbehind in this file (or any file in src/): a parse-time
// SyntaxError blanks the whole app on Safari below 16.4.

// The header we read. Generous for HEIC — an `ispe` box sits after the file
// type and metadata boxes — and still a single small read.
export const HEADER_BYTES = 128 * 1024;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** A dimension pair is only an answer if BOTH sides are real, positive pixels. */
function pair(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  // A dimension no image has. Anything this large is a misread header, and a
  // misread that reached the caller would be treated as a real picture.
  if (width > 1e6 || height > 1e6) return null;
  return { width, height };
}

// ── JPEG ─────────────────────────────────────────────────────────────────────
// Walk the marker chain. The frame header (SOFn) carries the dimensions; every
// other segment declares its own length, so the walk is bounded by the file and
// never by a search for bytes that happen to look like a marker — a JPEG's
// entropy-coded data is full of those.
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }          // padding between segments
    const marker = b[i + 1];
    if (marker === 0xFF) { i++; continue; }        // fill byte
    // Standalone markers: no length, no payload.
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) { i += 2; continue; }
    const len = u16be(b, i + 2);
    if (len < 2) return null;                      // corrupt chain
    // SOF0-3, 5-7, 9-11, 13-15 are frame headers. C4 (DHT), C8 (JPG), CC (DAC)
    // sit in the same numeric range and are NOT frames.
    const isSof = (marker >= 0xC0 && marker <= 0xCF)
      && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSof) return pair(u16be(b, i + 7), u16be(b, i + 5));
    if (marker === 0xDA) return null;              // scan data — no frame found
    i += 2 + len;
  }
  return null;
}

// ── WebP ─────────────────────────────────────────────────────────────────────
function webpSize(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Lossy. The key frame starts with a 3-byte frame tag then the sync code.
    if (b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) return null;
    return pair(u16le(b, 26) & 0x3FFF, u16le(b, 28) & 0x3FFF);
  }
  if (chunk === "VP8L") {
    // Lossless: 14 bits each, packed little-endian after the 0x2F signature.
    if (b[20] !== 0x2F) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return pair((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1);
  }
  if (chunk === "VP8X") {
    // Extended: canvas size as two 24-bit little-endian values, minus one.
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return pair(w + 1, h + 1);
  }
  return null;
}

// ── TIFF (and the DNG an iPhone's ProRAW produces) ───────────────────────────
function tiffSize(b) {
  const little = b[0] === 0x49;
  const u16 = (i) => (little ? u16le(b, i) : u16be(b, i));
  const u32 = (i) => (little ? u32le(b, i) : u32be(b, i));
  const ifd = u32(4);
  if (!(ifd > 0) || ifd + 2 > b.length) return null;
  const count = u16(ifd);
  let width = null, height = null;
  for (let n = 0; n < count && n < 512; n++) {
    const e = ifd + 2 + n * 12;
    if (e + 12 > b.length) break;
    const tag = u16(e);
    const type = u16(e + 2);
    // SHORT (3) or LONG (4); the value is inline for both at this size.
    const value = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : null;
    if (value === null) continue;
    if (tag === 0x0100) width = value;
    if (tag === 0x0101) height = value;
  }
  return pair(width, height);
}

// ── ISO-BMFF: HEIC, HEIF, AVIF ───────────────────────────────────────────────
// The dimensions live in an `ispe` (image spatial extents) box. A HEIC holds
// SEVERAL — the thumbnail and any auxiliary image have their own — so the
// LARGEST is taken: the hint must be sized against the picture that will
// actually be decoded, and choosing the thumbnail would skip the resize on
// exactly the 12-megapixel file the resize exists for.
function bmffSize(b) {
  let best = null;
  for (let i = 0; i + 12 <= b.length; i++) {
    if (b[i] !== 0x69 || b[i + 1] !== 0x73 || b[i + 2] !== 0x70 || b[i + 3] !== 0x65) continue; // "ispe"
    const found = pair(u32be(b, i + 8), u32be(b, i + 12));
    if (!found) continue;
    if (!best || found.width * found.height > best.width * best.height) best = found;
  }
  return best;
}

/**
 * Pixel dimensions read out of a file's own header.
 *
 * @param {Uint8Array} bytes  the first of the file (HEADER_BYTES is plenty)
 * @returns {{width:number,height:number}|null}  null means UNRECOGNISED, never
 *   "small" — the caller must not read a null as a size.
 */
export function pixelSizeFromHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : (bytes ? new Uint8Array(bytes) : null);
  if (!b || b.length < 16) return null;
  try {
    if (b[0] === 0xFF && b[1] === 0xD8) return jpegSize(b);
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return pair(u32be(b, 16), u32be(b, 20));
    if (ascii(b, 0, 3) === "GIF") return pair(u16le(b, 6), u16le(b, 8));
    if (b[0] === 0x42 && b[1] === 0x4D && b.length >= 26) {
      // Height is signed: a negative value means a top-down bitmap, same size.
      return pair(u32le(b, 18), Math.abs(u32le(b, 22) | 0));
    }
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP" && b.length >= 30) return webpSize(b);
    if ((ascii(b, 0, 2) === "II" && b[2] === 0x2A) || (ascii(b, 0, 2) === "MM" && b[3] === 0x2A)) return tiffSize(b);
    // ISO-BMFF is identified by its `ftyp` box, which is always first.
    if (ascii(b, 4, 4) === "ftyp") return bmffSize(b);
  } catch {
    // A truncated or hostile header must read as "unknown", never as a throw
    // in the middle of a photo upload.
    return null;
  }
  return null;
}

/**
 * The same answer for a real File/Blob: one slice of the front of the file.
 * Never throws — an unreadable file is "unknown", and the decode that follows
 * will produce the honest error.
 */
export async function readPixelSize(file) {
  if (!file || typeof file.slice !== "function") return null;
  try {
    const head = file.slice(0, HEADER_BYTES);
    const buf = typeof head.arrayBuffer === "function" ? await head.arrayBuffer() : null;
    if (!buf) return null;
    return pixelSizeFromHeader(new Uint8Array(buf));
  } catch {
    return null;
  }
}

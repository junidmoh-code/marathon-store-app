// Minimal, dependency-free Code 128 (subset B) → SVG encoder for the order slip's
// order-number barcode. Ported verbatim from the POS (marathon-pos-app
// src/print/code128.js) so both apps encode identically. Pure string output —
// the slip template stays synchronous (no DOM, no async).
//
// Algorithm (standard): Start-B (104) · data values (char − 32) · checksum
// (mod 103, position-weighted) · Stop (106). Each value maps to a 6-module
// bar/space pattern (Stop is 7), bars first.

const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];
const START_B = 104;
const STOP = 106;

export function encode128B(text) {
  const chars = String(text ?? "")
    .split("")
    .map((ch) => ch.charCodeAt(0))
    .filter((code) => code >= 32 && code <= 126)
    .map((code) => code - 32);
  let sum = START_B;
  chars.forEach((v, i) => { sum += v * (i + 1); });
  const checksum = sum % 103;
  return [START_B, ...chars, checksum, STOP];
}

// Build an SVG barcode for `text` sized to widthMm × heightMm. Bars black on
// transparent, with a ≥10-module quiet zone each side. Empty string for no input.
export function code128Svg(text, { widthMm = 60, heightMm = 18 } = {}) {
  const values = encode128B(text);
  if (values.length <= 3) return "";
  const segments = [];
  let x = 0;
  for (const v of values) {
    const pat = PATTERNS[v];
    for (let i = 0; i < pat.length; i++) {
      const w = Number(pat[i]);
      if (i % 2 === 0) segments.push({ x, w });
      x += w;
    }
  }
  const QUIET = 10;
  const totalModules = x + QUIET * 2;
  const rects = segments
    .map((s) => `<rect x="${s.x + QUIET}" y="0" width="${s.w}" height="100" fill="#000000" />`)
    .join("");
  return (
    `<svg class="barcode" width="${widthMm}mm" height="${heightMm}mm" ` +
    `viewBox="0 0 ${totalModules} 100" preserveAspectRatio="none" ` +
    `shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
  );
}

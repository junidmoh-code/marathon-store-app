// ─── LABEL BITMAP ─────────────────────────────────────────────────────────────
// Renders one label (Code 128 barcode + product/size + human-readable code, and an
// optional dispatch header line) to a 1-bit-per-pixel raster for the Phomemo head.
// Pure-ish: given a label, returns { width, height, bytesPerRow, mono } with mono a
// packed 1bpp buffer (bit=1 → black dot), MSB first, rows padded to whole bytes.
//
// LAYOUT CONTRACT:
//  • The raster is the FULL print-head width (widthDots, 384 dots). The printable
//    label is contentWidthDots wide and sits CENTRED under the head, so centring
//    content in the 384-dot raster lands it centred on the physical label (the old
//    320-wide raster printed from the head's left edge → left-bias).
//  • Everything is centred horizontally with an edge margin so nothing touches the
//    label edge.
//  • Vertical order: [optional header] → product NAME → SIZE → barcode → 8-digit code.
//  • SIZE is on its OWN bold, prominent line ("Size: 9") — separated from the name so
//    it is ALWAYS visible no matter how long the name is (size is the key pick-info).
//  • The product NAME auto-fits on ONE line: shrink the font, then truncate with "…"
//    so it can never overflow or steal the size's space.
//  • The barcode is MINIMISED (capped height) to make room for the size while keeping
//    Code 128 at a scannable module width.
//  • Height is exactly one label tall (caller sizes it), so the declared GS v 0
//    line-count matches the content — no oversized canvas, no spill.

import { code128Modules } from "../barcode";

const FONT = "monospace";
const setFont = (ctx, px, bold = true) => { ctx.font = `${bold ? "bold " : ""}${px}px ${FONT}`; };

// Fit text to maxWidth on ONE line by shrinking the font; truncate with "…" if it
// still won't fit at minPx.
function fitLine(ctx, text, maxWidth, maxPx, minPx, bold = true) {
  for (let px = maxPx; px >= minPx; px--) {
    setFont(ctx, px, bold);
    if (ctx.measureText(text).width <= maxWidth) return { px, lines: [text] };
  }
  setFont(ctx, minPx, bold);
  let t = String(text);
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return { px: minPx, lines: [t + "…"] };
}

function drawLabel(ctx, { code, productName, size, header }, widthDots, heightDots, moduleWidth, contentWidthDots) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const cx = Math.floor(widthDots / 2);
  const EDGE = 10;                                     // keep content off the label edge
  const maxW = (contentWidthDots || widthDots) - 2 * EDGE;
  let y = 4;

  // Optional dispatch header (order # · customer) — one fitted line.
  if (header) {
    const f = fitLine(ctx, String(header), maxW, 18, 11, true);
    setFont(ctx, f.px, true);
    ctx.fillText(f.lines[0], cx, y);
    y += f.px + 3;
  }

  // Product NAME — its own line, auto-fit (shrink → ellipsis); never merged with the
  // size, so a long name can't push the size off the label.
  if (productName) {
    const f = fitLine(ctx, String(productName), maxW, header ? 15 : 20, 11, true);
    setFont(ctx, f.px, true);
    ctx.fillText(f.lines[0], cx, y);
    y += f.px + 2;
  }

  // SIZE — its own bold, prominent line. Always shown when present, at a glance.
  const sizeStr = (size != null && String(size).trim() !== "") ? `Size: ${String(size).trim()}` : "";
  if (sizeStr) {
    const f = fitLine(ctx, sizeStr, maxW, header ? 17 : 24, 12, true);
    setFont(ctx, f.px, true);
    ctx.fillText(f.lines[0], cx, y);
    y += f.px + 4;
  } else {
    y += 2;
  }

  // Barcode — shrink module width until it fits the content width, then MINIMISE the
  // height (capped) so the size stays prominent. Module width stays ≥ a scannable
  // density; centred; the 8-digit code sits below.
  const modules = code128Modules(code);
  const totalModules = modules.reduce((s, m) => s + m.width, 0);
  let mw = moduleWidth;
  while (totalModules * mw > maxW && mw > 1) mw--;
  const barWidth = totalModules * mw;
  const CODE_PX = 16;
  const barTop = y;
  const avail = heightDots - (CODE_PX + 5) - barTop;
  const barHeight = Math.max(34, Math.min(avail, 60));  // minimised, still scannable
  let x = Math.round(cx - barWidth / 2);
  for (const m of modules) {
    if (m.bar) ctx.fillRect(x, barTop, m.width * mw, barHeight);
    x += m.width * mw;
  }

  // 8-digit human-readable code, centred under the bars.
  setFont(ctx, CODE_PX, false);
  ctx.fillText(code, cx, barTop + barHeight + 3);
}

export function renderLabelBitmap(label, { widthDots = 384, heightDots = 152, moduleWidth = 2, contentWidthDots } = {}) {
  if (typeof document === "undefined") throw new Error("Label rendering requires a browser (canvas).");
  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext("2d");
  drawLabel(ctx, label, widthDots, heightDots, moduleWidth, contentWidthDots || widthDots);

  const { data } = ctx.getImageData(0, 0, widthDots, heightDots);
  const bytesPerRow = Math.ceil(widthDots / 8);
  const mono = new Uint8Array(bytesPerRow * heightDots);
  for (let y = 0; y < heightDots; y++) {
    for (let xp = 0; xp < widthDots; xp++) {
      const idx = (y * widthDots + xp) * 4;
      // Luminance threshold → black dot. Alpha-aware (treat transparent as white).
      const a = data[idx + 3];
      const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (a > 128 && lum < 128) mono[y * bytesPerRow + (xp >> 3)] |= 0x80 >> (xp & 7);
    }
  }
  return { width: widthDots, height: heightDots, bytesPerRow, mono };
}

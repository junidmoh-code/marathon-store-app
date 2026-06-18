// ─── LABEL BITMAP ─────────────────────────────────────────────────────────────
// Renders a single label (Code 128 barcode from the SAME pure model used on screen
// + product/size + the human-readable code) to a 1-bit-per-pixel raster, for
// raster printers (Phomemo). Canvas-based; browser-only. Pure-ish: given a label,
// returns { width, height, bytesPerRow, mono } with mono a packed 1bpp buffer
// (bit=1 → black dot), MSB first, rows padded to whole bytes.

import { code128Modules } from "../barcode";

// Draw the barcode bars + text onto a canvas 2D context.
function drawLabel(ctx, { code, productName, size }, widthDots, heightDots, moduleWidth) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.fillStyle = "#000";

  // Top line: product name + size (truncated to fit).
  const title = `${productName || ""}${size ? "  ·  " + size : ""}`.trim();
  ctx.font = "bold 20px monospace";
  ctx.textBaseline = "top";
  ctx.fillText(title.slice(0, 28), 8, 6, widthDots - 16);

  // Barcode: center the bars horizontally with a quiet zone.
  const modules = code128Modules(code);
  const totalModules = modules.reduce((s, m) => s + m.width, 0);
  const barWidth = totalModules * moduleWidth;
  const startX = Math.max(8, Math.floor((widthDots - barWidth) / 2));
  const barTop = 34;
  const barHeight = heightDots - barTop - 26;
  let x = startX;
  for (const m of modules) {
    if (m.bar) ctx.fillRect(x, barTop, m.width * moduleWidth, barHeight);
    x += m.width * moduleWidth;
  }

  // Human-readable code under the bars.
  ctx.font = "18px monospace";
  ctx.fillText(code, startX, barTop + barHeight + 4);
}

export function renderLabelBitmap(label, { widthDots = 320, heightDots = 160, moduleWidth = 2 } = {}) {
  if (typeof document === "undefined") throw new Error("Label rendering requires a browser (canvas).");
  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext("2d");
  drawLabel(ctx, label, widthDots, heightDots, moduleWidth);

  const { data } = ctx.getImageData(0, 0, widthDots, heightDots);
  const bytesPerRow = Math.ceil(widthDots / 8);
  const mono = new Uint8Array(bytesPerRow * heightDots);
  for (let y = 0; y < heightDots; y++) {
    for (let xp = 0; xp < widthDots; xp++) {
      const idx = (y * widthDots + xp) * 4;
      // Luminance threshold → black dot. Alpha-aware (treat transparent as white).
      const a = data[idx + 3];
      const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const black = a > 128 && lum < 128;
      if (black) mono[y * bytesPerRow + (xp >> 3)] |= 0x80 >> (xp & 7);
    }
  }
  return { width: widthDots, height: heightDots, bytesPerRow, mono };
}

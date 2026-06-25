// ─── DEV-ONLY LABEL PREVIEW ───────────────────────────────────────────────────
// Renders the REAL Phomemo label bitmap (the same renderLabelBitmap the printer
// path uses) to on-screen canvases so the label layout can be checked without
// burning a roll. Loaded only by label-preview.html (not an app/build entry).

import { renderLabelBitmap } from "../components/stock/printers/labelBitmap.js";

// Same geometry the Phomemo transport uses (see printers/phomemo.js): full head
// width raster (384); the 40×30 roll feeds 30 mm across the head and 40 mm along
// the feed, so the printable content is 240 dots wide and the raster 320 dots tall.
const LABEL = { widthDots: 384, heightDots: 320, contentWidthDots: 240, moduleWidth: 2 };
const SCALE = 2.0;

const SAMPLES = [
  { title: "Short name · numeric size", label: { code: "12345678", productName: "Nike Air Max", size: "9" } },
  { title: "Long name (wraps, full)", label: { code: "23456789", productName: "Adidas Ultraboost Light Running Shoe Special Edition", size: "10.5" } },
  { title: "Very long name (wraps 3 lines, no cut)", label: { code: "78901234", productName: "Nike Air Jordan 1 Retro High OG Chicago Lost and Found Reimagined Special Box", size: "11" } },
  { title: "Letter size (clothing)", label: { code: "34567890", productName: "Marathon Performance Hoodie", size: "M" } },
  { title: "No size (falls back cleanly)", label: { code: "45678901", productName: "Generic Accessory", size: "" } },
  { title: "Dispatch label (with header)", label: { code: "56789012", productName: "Jordan 1 Retro High OG", size: "8", header: "Order #1042  ·  Jane M." } },
];

// Paint the 1-bpp mono buffer (bit=1 → black) into a scaled, pixelated canvas.
function paint(bmp) {
  const base = document.createElement("canvas");
  base.width = bmp.width; base.height = bmp.height;
  const bctx = base.getContext("2d");
  const img = bctx.createImageData(bmp.width, bmp.height);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const bit = (bmp.mono[y * bmp.bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 0 : 255;
      const i = (y * bmp.width + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  const out = document.createElement("canvas");
  out.width = Math.round(bmp.width * SCALE);
  out.height = Math.round(bmp.height * SCALE);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(base, 0, 0, out.width, out.height);
  return out;
}

const root = document.getElementById("app");
for (const { title, label } of SAMPLES) {
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = title;
  card.appendChild(h);
  try {
    card.appendChild(paint(renderLabelBitmap(label, LABEL)));
  } catch (e) {
    const err = document.createElement("div");
    err.style.color = "#f87171";
    err.textContent = String(e?.message || e);
    card.appendChild(err);
  }
  root.appendChild(card);
}

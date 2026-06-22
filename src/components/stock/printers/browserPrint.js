// ─── BROWSER / SYSTEM PRINT (Windows-friendly) ────────────────────────────────
// Prints labels through the OS print dialog instead of WebUSB. On Windows, WebUSB
// can't open a printer the OS print driver owns (`open()` → "Access denied"), so the
// Xprinter is unreachable over USB there. This transport sidesteps that entirely: it
// renders each label to the SAME bitmap the Phomemo path uses (renderLabelBitmap — one
// shared layout: wrapped name → Size → barcode → 8-digit code) and prints it via
// window.print() into a one-label-per-page document. The operator just picks the
// XP-350B (its normal Windows driver) in the print dialog — no driver surgery.
//
// Works on any OS (it's just window.print), so it's also a universal fallback.

import { renderLabelBitmap } from "./labelBitmap";

// Physical label + render geometry. 40×30 mm at 203 dpi = 320×240 dots; we render at
// native dot resolution and let the printer driver scale to its head, with the image
// pixelated so the Code 128 bars stay crisp/scannable.
const PAGE = { wMm: 40, hMm: 30 };
const RENDER = { widthDots: 320, heightDots: 240, contentWidthDots: 320, moduleWidth: 2 };

export function isBrowserPrintSupported() {
  return typeof window !== "undefined" && typeof window.print === "function" && typeof document !== "undefined";
}

// One label → a PNG data URL (paint the 1-bpp mono buffer onto a canvas; bit=1 → black).
function labelDataUrl(label) {
  const bmp = renderLabelBitmap(label, RENDER);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(bmp.width, bmp.height);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const bit = (bmp.mono[y * bmp.bytesPerRow + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 0 : 255;
      const i = (y * bmp.width + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// labels: [{ code, productName, size }] already expanded to one entry per copy.
// Builds a one-label-per-page document in a hidden iframe and opens the print dialog.
export async function printBrowser(labels) {
  if (!isBrowserPrintSupported()) return { ok: false, error: "Printing isn't available in this browser." };
  if (!labels || !labels.length) return { ok: false, error: "Nothing to print." };
  let iframe = null;
  try {
    const body = labels.map(l => `<div class="lbl"><img src="${labelDataUrl(l)}" /></div>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
      @page { size: ${PAGE.wMm}mm ${PAGE.hMm}mm; margin: 0; }
      html, body { margin: 0; padding: 0; }
      .lbl { width: ${PAGE.wMm}mm; height: ${PAGE.hMm}mm; overflow: hidden; page-break-after: always; }
      .lbl:last-child { page-break-after: auto; }
      .lbl img { width: ${PAGE.wMm}mm; height: ${PAGE.hMm}mm; display: block; image-rendering: pixelated; }
    </style></head><body>${body}</body></html>`;

    iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    // Wait for the label images to decode so the print render isn't blank.
    await new Promise((resolve) => {
      const imgs = Array.from(doc.images || []);
      let pending = imgs.length;
      if (!pending) return resolve();
      const done = () => { if (--pending <= 0) resolve(); };
      imgs.forEach(im => { if (im.complete) done(); else { im.onload = im.onerror = done; } });
      setTimeout(resolve, 2000); // safety net
    });

    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    // Leave the iframe long enough for the (modal) dialog to read it, then clean up.
    const stale = iframe;
    setTimeout(() => { try { document.body.removeChild(stale); } catch { /* already gone */ } }, 60000);
    return { ok: true, printed: labels.length, diag: "system print dialog" };
  } catch (err) {
    if (iframe) { try { document.body.removeChild(iframe); } catch { /* ignore */ } }
    return { ok: false, error: String(err?.message || err) };
  }
}

// ─── OS PRINT ROUTE (fallback) ────────────────────────────────────────────────
// When no USB device can be claimed — most often because the computer's own print
// system is holding the printer — the same label is laid out as an exact-size HTML
// page and handed to window.print(). Chrome started with --kiosk-printing (the
// deploy/mac launcher does this) sends it straight to the default printer with no
// dialog; without that flag the normal print dialog appears.
//
// The label is the SAME label: same size (LABEL_GEOMETRY, shared with the TSPL
// driver), same content order (name → "Size: …" → Code 128 → digits), same
// barcode symbology (Code 128) and the same data (the 8-digit code). The bars are
// drawn from code128Modules — the encoder the on-screen barcode already uses.

import { code128Modules } from "../barcode";
import { LABEL_GEOMETRY } from "./xprinter";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Copies exactly as the TSPL driver counts them: a bad or zero count prints one.
const copiesOf = (it) => { const n = Number(it?.count); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1; };

// Code 128 as an SVG whose bar widths are whole printer dots (narrow = 2 dots,
// dropping to 1 only if the code would not fit — the TSPL driver's rule).
export function barcodeSvg(code, { widthMm = LABEL_GEOMETRY.widthMm, dotsPerMm = LABEL_GEOMETRY.dotsPerMm, heightMm = 9 } = {}) {
  const modules = code128Modules(code);
  const total = modules.reduce((s, m) => s + m.width, 0);
  const maxDots = widthMm * dotsPerMm - 2 * LABEL_GEOMETRY.marginDots;
  let narrow = 2;
  while (total * narrow > maxDots && narrow > 1) narrow--;
  const wMm = (total * narrow) / dotsPerMm;
  let x = 0;
  const rects = [];
  for (const m of modules) {
    if (m.bar) rects.push(`<rect x="${x}" y="0" width="${m.width}" height="1"/>`);
    x += m.width;
  }
  return `<svg class="bars" data-symbology="code128" data-value="${esc(code)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 1" preserveAspectRatio="none" shape-rendering="crispEdges" style="width:${wMm}mm;height:${heightMm}mm">${rects.join("")}</svg>`;
}

function nameSizeMm(name) {
  const n = String(name || "").length;
  return n <= 18 ? 3.4 : n <= 36 ? 2.8 : 2.3;
}

function labelBody({ code, productName, size, price }) {
  const sizeStr = size != null && String(size).trim() !== "" ? `Size: ${String(size).trim()}` : "";
  const hero = sizeStr || (price != null && String(price).trim() !== "" ? String(price) : "");
  return `<section class="label">` +
    (productName ? `<div class="name" style="font-size:${nameSizeMm(productName)}mm">${esc(productName)}</div>` : "") +
    (hero ? `<div class="hero">${esc(hero)}</div>` : "") +
    barcodeSvg(code) +
    `<div class="digits">${esc(code)}</div>` +
    `</section>`;
}

// The whole print document: one page per physical label, page = label.
export function labelHtml(items) {
  const { widthMm: w, heightMm: h } = LABEL_GEOMETRY;
  const labels = [];
  for (const it of items || []) {
    if (!it || !it.code) continue;
    for (let i = 0; i < copiesOf(it); i++) labels.push(labelBody(it));
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
.label { width: ${w}mm; height: ${h - 0.2}mm; box-sizing: border-box; padding: 1.5mm 2mm; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 0.6mm;
  font-family: Arial, Helvetica, sans-serif; text-align: center; }
.label + .label { page-break-before: always; break-before: page; }
.name { font-weight: 700; line-height: 1.12; max-width: 100%; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-word; }
.hero { font-weight: 800; font-size: 3.6mm; line-height: 1.1; }
.bars { display: block; fill: #000; margin-top: auto; }
.digits { font-family: "Courier New", monospace; font-size: 2.8mm; letter-spacing: 0.3mm; }
</style></head><body>${labels.join("")}</body></html>`;
}

export function countLabels(items) {
  return (items || []).filter((it) => it && it.code).reduce((s, it) => s + copiesOf(it), 0);
}

// Print through the OS. Uses a hidden same-origin iframe so the app page itself is
// never re-laid-out for print. Resolves once print() returns. The browser never
// says whether a job was spooled: `dialogShown` is a best guess (print() blocks
// while Chrome's dialog is open and returns at once under --kiosk-printing), and
// when a dialog was shown the person may have pressed Cancel — callers must not
// treat that as printed.
export async function printViaOs(items, { doc = typeof document !== "undefined" ? document : null, now = () => Date.now() } = {}) {
  const printed = countLabels(items);
  if (!printed) return { ok: false, route: "os", error: "Nothing to print." };
  if (!doc) return { ok: false, route: "os", error: "System printing needs a browser window." };
  try {
    const frame = doc.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = () => reject(new Error("label page failed to load"));
      frame.srcdoc = labelHtml(items);
      doc.body.appendChild(frame);
    });
    const win = frame.contentWindow;
    const t0 = now();
    win.focus();
    win.print();
    const dialogShown = now() - t0 > 1500;
    // Leave the frame long enough for the spooler to take the document.
    setTimeout(() => { try { frame.remove(); } catch { /* gone */ } }, 60000);
    return { ok: true, route: "os", printed, dialogShown };
  } catch (err) {
    return { ok: false, route: "os", error: `System print failed — ${String(err?.message || err)}` };
  }
}

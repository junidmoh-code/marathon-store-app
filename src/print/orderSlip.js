// ─── ASSISTANT ORDER SLIP (80mm thermal) ──────────────────────────────────────
// Builds the customer order slip and prints it via the browser dialog (same path
// the POS uses). One slip per order (each order = one product+size, its own
// order number). A multi-item placement prints all slips in ONE job, separated
// by a tear line — the thermal driver auto-cuts only at the end, so staff tear
// the intermediate ones.
//
// Layout: MARATHON wordmark → ORDER NUMBER pill → huge number → item → playful
// "we're preparing your order" block; the wait time sits in the thank-you line
// (not shown as a prominent badge up top).

import { printHtmlInIframe } from "./printSlipService";

const DEFAULT_ETA_MIN = 15;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STORE_LABELS = { central: "Central", pine: "Pine" };
function storeLabel(order) {
  const key = order?.placedStore || order?.placedHub;
  const nice = STORE_LABELS[key] || (key ? key[0].toUpperCase() + key.slice(1) : "");
  return nice ? `Marathon · ${nice}` : "Marathon";
}

function sizeText(size) {
  if (size == null || size === "" || size === "_") return "One size";
  return `Size ${escapeHtml(size)}`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatWhen(ms) {
  const d = ms ? new Date(ms) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} · ${hh}:${mm}`;
}

// Thermal print density: a thermal head is 1-bit, so the driver DITHERS any grey
// into sparse dots and a regular-weight 6pt glyph is ~1 dot wide — that is why
// the old slip's small text came out faint while the 800-weight #000 number was
// solid. Everything here is pure #000, weight >= 600, rules >= 0.5mm, icon
// strokes >= 0.8mm effective. No greys, opacity, shadows or gradients.
const SLIP_CSS = `
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: 80mm; color: #000;
    font-family: "Segoe UI", "SF Pro Text", -apple-system, system-ui, Roboto, Arial, sans-serif;
    font-weight: 600;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    -webkit-font-smoothing: none; text-rendering: geometricPrecision;
  }
  * { color: #000; opacity: 1; text-shadow: none; box-shadow: none; filter: none; background-image: none; }
  svg, svg * { stroke: #000; }
  .slip { width: 72mm; margin: 0 auto; padding: 3mm 0 2.5mm; text-align: center; }

  .brand {
    font-family: Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif;
    font-weight: 900; font-size: 40pt; line-height: 0.92; letter-spacing: 0.01em;
    text-transform: uppercase; margin: 0;
  }
  .tagrow { display: flex; align-items: center; justify-content: center; gap: 2mm; margin-top: 1.2mm; }
  .tagrow svg { flex: none; }
  .tag { font-size: 7pt; font-weight: 700; letter-spacing: 0.28em; text-transform: uppercase; white-space: nowrap; }

  .pill {
    display: inline-block; margin: 4mm auto 1.5mm; padding: 1.2mm 6mm;
    border: 0.55mm solid #000; border-radius: 99px;
    font-size: 8.5pt; font-weight: 800; letter-spacing: 0.24em; text-transform: uppercase;
  }
  .number {
    font-family: "Arial Black", "Segoe UI Black", "SF Pro Display", -apple-system, sans-serif;
    font-weight: 900; font-size: 60pt; line-height: 1; margin: 0.5mm 0 1mm;
    font-variant-numeric: tabular-nums; letter-spacing: -0.01em; white-space: nowrap;
  }
  .number.long { font-size: 44pt; }
  .number.xlong { font-size: 32pt; }

  .item { border-top: 0.55mm solid #000; border-bottom: 0.55mm solid #000; padding: 1.8mm 0; margin: 1mm 0 3mm; }
  .item .pname { font-size: 10pt; font-weight: 800; line-height: 1.2; }
  .item .meta { font-size: 8.5pt; font-weight: 700; margin-top: 0.6mm; }

  .prep { margin-top: 1mm; }
  .hand {
    font-family: "Segoe Print", "Bradley Hand", "Marker Felt", "Comic Sans MS", cursive;
    font-weight: 700; font-size: 19pt; line-height: 1.05; margin: 0.5mm 0 0;
    -webkit-text-stroke: 0.35pt #000; paint-order: stroke fill;
    transform: rotate(-4deg);
  }
  .underline { display: block; margin: 1.6mm auto 0; }

  .thanksrow { display: flex; align-items: center; gap: 2.5mm; margin-top: 4mm; text-align: left; }
  .thanksrow svg { flex: none; }
  .thanks { font-size: 8.5pt; font-weight: 600; line-height: 1.35; }
  .thanks b { font-weight: 800; }

  .foot { border-top: 0.55mm dashed #000; margin-top: 3.5mm; padding-top: 1.5mm; }
  .foot .store { font-size: 8pt; font-weight: 800; }
  .foot .when { font-size: 7pt; font-weight: 600; margin-top: 0.3mm; }
  .tear { font-size: 7pt; font-weight: 700; letter-spacing: 0.3em; border-top: 0.55mm dashed #000; margin: 3mm 0 2.5mm; padding-top: 0.8mm; text-align: center; }

  @media print {
    * { color: #000 !important; opacity: 1 !important; text-shadow: none !important; box-shadow: none !important; }
  }
`;

// Hand-drawn marks — thick round strokes so the thermal head reproduces them.
const SWISH_L = `<svg width="9mm" height="3.2mm" viewBox="0 0 36 12" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9 Q10 5 18 4 L9 9 Q20 7 30 5"/></svg>`;
const SWISH_R = `<svg width="9mm" height="3.2mm" viewBox="0 0 36 12" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round"><path d="M4 5 Q18 2 34 3"/><path d="M7 10 Q20 7 32 8"/></svg>`;
const CHEF = `<svg width="30mm" height="15mm" viewBox="0 0 80 40" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 6 L14 16"/><path d="M4 18 L12 22"/><path d="M72 6 L66 16"/><path d="M76 18 L68 22"/>
  <path d="M31 38 L31 27 C24 28 20 22 23 17 C25 12 31 11 34 13 C35 7 45 6 47 12 C51 9 58 12 57 18 C60 22 56 28 50 27 L50 38 Z"/>
  <path d="M31 33 L50 33"/><path d="M37 25 L38 29"/><path d="M44 24 L43 29"/>
</svg>`;
const UNDERLINE = `<svg class="underline" width="26mm" height="2.4mm" viewBox="0 0 100 8" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"><path d="M4 5 Q50 1 96 3"/></svg>`;
const CLOCK = `<svg width="15mm" height="13mm" viewBox="0 0 60 52" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 14 L9 15"/><path d="M2 26 L9 25"/><path d="M5 40 L11 35"/>
  <circle cx="37" cy="26" r="19"/><path d="M37 14 L37 27 L45 33"/>
</svg>`;

function numberClass(num) {
  const len = String(num).length;
  return len >= 6 ? "number xlong" : len >= 4 ? "number long" : "number";
}

// One slip's inner markup.
function slipMarkup(order, { etaMinutes = DEFAULT_ETA_MIN } = {}) {
  const num = escapeHtml(order?.id ?? "—");
  const meta = [sizeText(order?.size), order?.customerName ? `For ${escapeHtml(order.customerName)}` : ""]
    .filter(Boolean).join(" &nbsp;·&nbsp; ");
  return `
    <div class="slip">
      <div class="brand">Marathon</div>
      <div class="tagrow">${SWISH_L}<span class="tag">Your Favorite Store</span>${SWISH_R}</div>
      <div class="pill">Order Number</div>
      <div class="${numberClass(order?.id ?? "—")}">${num}</div>
      <div class="item">
        <div class="pname">${escapeHtml(order?.productName || "Item")}</div>
        <div class="meta">${meta}</div>
      </div>
      <div class="prep">
        ${CHEF}
        <div class="hand">We're preparing<br/>your order!</div>
        ${UNDERLINE}
      </div>
      <div class="thanksrow">
        ${CLOCK}
        <div class="thanks">Thanks for allowing us to prepare your favorite pair. Please give us up to <b>${escapeHtml(etaMinutes)} minutes</b> and we'll call your number.</div>
      </div>
      <div class="foot">
        <div class="store">${escapeHtml(storeLabel(order))}</div>
        <div class="when">${escapeHtml(formatWhen(order?.createdAt))}</div>
      </div>
    </div>`;
}

// Full print document for one or more orders (one print job, tear line between).
export function buildOrderSlipsHtml(orders, opts = {}) {
  const list = (Array.isArray(orders) ? orders : [orders]).filter(Boolean);
  const body = list
    .map((o) => slipMarkup(o, opts))
    .join(`<div class="tear">✂ &nbsp; tear &nbsp; ✂</div>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Order Slip</title>`
    + `<style>${SLIP_CSS}</style></head><body>${body}</body></html>`;
}

// Print the slip(s). Returns the print promise; callers fire-and-forget. The
// build runs inside the promise chain so even a synchronous error while building
// the HTML surfaces as a rejection (never an exception into the caller's flow).
export function printOrderSlips(orders, opts = {}) {
  const list = (Array.isArray(orders) ? orders : [orders]).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return Promise.resolve().then(() => printHtmlInIframe(buildOrderSlipsHtml(list, opts)));
}

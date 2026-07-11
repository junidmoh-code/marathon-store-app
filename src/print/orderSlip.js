// ─── ASSISTANT ORDER SLIP (80mm thermal) ──────────────────────────────────────
// Builds the customer order slip and prints it via the browser dialog (same path
// the POS uses). One slip per order (each order = one product+size, its own
// order number). A multi-item placement prints all slips in ONE job, separated
// by a tear line — the thermal driver auto-cuts only at the end, so staff tear
// the intermediate ones.
//
// Compact layout: order number leads; the wait time is folded quietly into the
// thank-you line (not shown as a prominent badge up top).

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

const SLIP_CSS = `
  @page { size: 80mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: 80mm; color: #000;
    font-family: "SF Pro Text", -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .slip { width: 72mm; margin: 0 auto; padding: 3mm 0 2.5mm; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 1.6mm; margin-bottom: 0.4mm; }
  .brand .name { font-weight: 800; letter-spacing: 0.18em; font-size: 11pt; }
  .tag { text-align: center; font-size: 5.5pt; letter-spacing: 0.16em; text-transform: uppercase; color: #444; }
  .rule { border: 0; border-top: 0.35mm dashed #000; margin: 2mm 0; }
  .rule.solid { border-top: 0.45mm solid #000; }
  .number { text-align: center; font-weight: 800; font-size: 34pt; line-height: 0.95; margin: 0.6mm 0 0.3mm; font-variant-numeric: tabular-nums; }
  .numcap { text-align: center; font-size: 6pt; letter-spacing: 0.22em; text-transform: uppercase; color: #666; }
  .item { text-align: center; }
  .item .pname { font-size: 10pt; font-weight: 700; line-height: 1.25; }
  .item .meta { font-size: 8pt; color: #222; margin-top: 0.8mm; }
  .item .cust { font-size: 7.5pt; color: #333; margin-top: 1.2mm; }
  .item .cust b { color: #000; font-weight: 700; }
  .thanks { text-align: center; font-size: 7.5pt; line-height: 1.4; color: #444; }
  .foot { text-align: center; }
  .foot .store { font-size: 7pt; font-weight: 700; color: #111; }
  .foot .when { font-size: 6pt; color: #777; margin-top: 0.3mm; }
  .tear { text-align: center; color: #000; font-size: 6.5pt; letter-spacing: 0.3em; border-top: 0.35mm dashed #000; margin: 3mm 0 2.5mm; padding-top: 0.8mm; }
`;

const MOUNTAIN = `<svg width="4.4mm" height="4.4mm" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18 L9 8 L13 14 L17 6 L21 18 Z"/></svg>`;

// One slip's inner markup.
function slipMarkup(order, { etaMinutes = DEFAULT_ETA_MIN } = {}) {
  const num = escapeHtml(order?.id ?? "—");
  return `
    <div class="slip">
      <div class="brand">${MOUNTAIN}<span class="name">MARATHON</span></div>
      <div class="tag">Order Slip</div>
      <hr class="rule solid" />
      <div class="number">${num}</div>
      <div class="numcap">Order Number</div>
      <hr class="rule" />
      <div class="item">
        <div class="pname">${escapeHtml(order?.productName || "Item")}</div>
        <div class="meta">${sizeText(order?.size)}</div>
        ${order?.customerName ? `<div class="cust">For <b>${escapeHtml(order.customerName)}</b></div>` : ""}
      </div>
      <hr class="rule" />
      <div class="thanks">Thanks for your patience — we're picking &amp; packing your order right now. Grab a seat, we'll have you sorted in about ${etaMinutes} minutes.</div>
      <hr class="rule" />
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

// Print the slip(s). Returns the print promise; callers fire-and-forget.
export function printOrderSlips(orders, opts = {}) {
  const list = (Array.isArray(orders) ? orders : [orders]).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return printHtmlInIframe(buildOrderSlipsHtml(list, opts));
}

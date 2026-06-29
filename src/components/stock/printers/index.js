// ─── PRINTER TRANSPORT (facade) ───────────────────────────────────────────────
// Single entry point the print UI calls. Routes to a transport driver, isolates
// failures (drivers already return {ok,error}; this also guards against a throw),
// and expands per-size copy counts into one label entry per physical label.
//
// Transports (both render on-device, so orientation + one-label sizing are handled by
// the printer, NOT the browser/OS driver):
//   phomemo  — Phomemo M110 via Web Bluetooth (raster).
//   xprinter — Xprinter XP-350B via WebUSB + TSPL. WebUSB works in Chrome on BOTH macOS
//              and Windows, so this is the SAME direct path on every platform — no
//              window.print(), no OS print dialog, no driver page-setup, no headers.
// A failed transport blocks nothing else: the value model, storage, reverse index
// and on-screen barcode all work regardless of whether a printer is reachable.

import { printPhomemo, printPhomemoTest, connectPhomemo, isPhomemoSupported } from "./phomemo";
import { printXprinter, connectXprinter, isXprinterSupported, getXprinterDiag } from "./xprinter";

export { getXprinterDiag };

export const TRANSPORTS = [
  { id: "phomemo",  label: "Phomemo M110 (Bluetooth)", proven: true, supported: isPhomemoSupported },
  { id: "xprinter", label: "Xprinter XP-350B (USB)",   proven: true, supported: isXprinterSupported },
];

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /win/i.test(p);
}

// Initial transport: on Windows default to the Xprinter (direct WebUSB+TSPL — the bulk
// barcode-label printer there); elsewhere keep the first supported transport (Phomemo),
// unchanged. The Xprinter stays selectable on every platform.
export function defaultTransportId() {
  if (isWindowsPlatform() && isXprinterSupported()) return "xprinter";
  return TRANSPORTS.find(t => t.supported())?.id || TRANSPORTS[0].id;
}

// items: [{ code, productName, size, count, dispatch?, orderNo?, customerName? }]
// — count copies of each. (dispatch/orderNo/customerName drive the text-first
// dispatch label and must survive the expansion to reach the renderer.)
function expand(items) {
  const labels = [];
  for (const it of items || []) {
    const n = Math.max(0, Math.floor(Number(it.count) || 0));
    for (let i = 0; i < n; i++) labels.push({
      code: it.code, productName: it.productName, size: it.size, header: it.header,
      dispatch: it.dispatch, orderNo: it.orderNo, customerName: it.customerName,
    });
  }
  return labels;
}

// Open the printer connection. MUST be called inside the user gesture (the device
// picker needs transient activation) — then do any async work, then printLabels(conn).
export async function connectTransport(transport) {
  if (transport === "phomemo") return await connectPhomemo();
  if (transport === "xprinter") return await connectXprinter();
  throw new Error(`Unknown transport "${transport}".`);
}

export async function printLabels({ items, transport, conn = null }) {
  try {
    if (transport === "phomemo") {
      // Phomemo rasterises one bitmap per physical copy → expand counts to entries.
      const labels = expand(items);
      if (!labels.length) return { ok: false, error: "Nothing to print (all counts are 0)." };
      return await printPhomemo(labels, conn);
    }
    if (transport === "xprinter") {
      // Xprinter renders TSPL natively with PRINT n → pass items WITH their counts.
      const valid = (items || []).filter(it => it && it.code);
      if (!valid.length) return { ok: false, error: "Nothing to print." };
      return await printXprinter(valid, conn);
    }
    return { ok: false, error: `Unknown transport "${transport}".` };
  } catch (err) {
    // Belt-and-suspenders — drivers already catch, but never let the flow break.
    return { ok: false, error: String(err?.message || err) };
  }
}

// Diagnostic: print a canvas-free test pattern (solid + stripes) to prove the
// protocol + BLE delivery work independently of label content. Phomemo only.
export async function printTest({ transport, conn = null }) {
  if (transport === "phomemo") return await printPhomemoTest(conn);
  return { ok: false, error: `Test print not supported for "${transport}".` };
}

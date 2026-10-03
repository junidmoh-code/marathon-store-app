// ─── PRINTER TRANSPORT (facade) ───────────────────────────────────────────────
// Single entry point the print UI calls. Routes to a transport driver, isolates
// failures (drivers already return {ok,error}; this also guards against a throw),
// and expands per-size copy counts into one label entry per physical label.
//
// Transports (both render on-device, so orientation + one-label sizing are handled by
// the printer, NOT the browser/OS driver):
//   phomemo  — Phomemo M110 via Web Bluetooth (raster).
//   xprinter — any USB label printer (XP-350B, XP-360B, other TSPL / ESC/POS) via
//              WebUSB, direct to the device. When no USB device can be claimed (the
//              OS print system may hold it) the SAME label goes out as an exact-size
//              page through window.print() — silent under Chrome's --kiosk-printing.
//              The route that actually printed is returned and shown.
// A failed transport blocks nothing else: the value model, storage, reverse index
// and on-screen barcode all work regardless of whether a printer is reachable.

import { printPhomemo, printPhomemoTest, connectPhomemo, isPhomemoSupported } from "./phomemo";
import { printXprinter, connectXprinter, isXprinterSupported, getXprinterDiag, startUsbPrinterWatch, findUsbPrinter, chooseUsbPrinter } from "./xprinter";
import { printViaOs } from "./osPrint";
import { setPrinterStatus } from "./printerStatus";

export { getXprinterDiag, startUsbPrinterWatch, findUsbPrinter, chooseUsbPrinter };
export { getPrinterStatus, subscribePrinterStatus, printerStatusText } from "./printerStatus";

export const TRANSPORTS = [
  { id: "phomemo",  label: "Phomemo M110 (Bluetooth)", proven: true, supported: isPhomemoSupported },
  { id: "xprinter", label: "USB label printer (Xprinter)", proven: true, supported: isXprinterSupported },
];

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /win/i.test(p);
}

export function isMobilePlatform() {
  if (typeof navigator === "undefined") return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent || "");
}

// The transport a person last picked on this computer (Barcodes / print sheet).
const TRANSPORT_KEY = "marathon.labelPrinter.transport";
export function rememberTransport(id) {
  try { localStorage.setItem(TRANSPORT_KEY, id); } catch { /* storage blocked */ }
}
function rememberedTransport() {
  try {
    const id = localStorage.getItem(TRANSPORT_KEY);
    return TRANSPORTS.find(t => t.id === id && t.supported())?.id || null;
  } catch { return null; }
}

// Initial transport: whatever was last picked on this computer; else on a desktop
// (macOS, Windows, Linux — any Chrome with WebUSB that isn't a phone or tablet) the
// USB label printer, which falls back to the system printer by itself; else the
// first supported transport (Phomemo on the warehouse phones).
export function defaultTransportId() {
  const remembered = rememberedTransport();
  if (remembered) return remembered;
  if (!isMobilePlatform() && isXprinterSupported()) return "xprinter";
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
      price: it.price,
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
    if (transport === "xprinter") return await printUsbOrOs(items, conn);
    return { ok: false, error: `Unknown transport "${transport}".` };
  } catch (err) {
    // Belt-and-suspenders — drivers already catch, but never let the flow break.
    return { ok: false, error: String(err?.message || err) };
  }
}

// USB first; the OS print route when no USB device could be used. Falls back ONLY
// if not one byte reached the printer — a batch that died half-way is reported,
// never re-sent the other way (that would double-print the half that made it).
async function printUsbOrOs(items, conn) {
  // TSPL/ESC-POS take PRINT n → pass items WITH their counts.
  const valid = (items || []).filter(it => it && it.code);
  if (!valid.length) return { ok: false, error: "Nothing to print." };
  const usb = conn?.route === "usb" ? conn : conn?.route === "os" ? conn : await connectXprinter();
  let usbLines = usb?.lines || [];
  if (usb?.route === "usb") {
    const res = await printXprinter(valid, usb);
    if (res.ok) {
      setPrinterStatus({ printed: "usb" });
      return { ...res, route: "usb", routeLabel: `USB → ${res.name}` };
    }
    if (res.sentBytes > 0) return { ...res, route: "usb", error: `${res.error} — stopped part-way; check what printed before retrying.` };
    usbLines = res.lines || [res.error];
  }
  const os = await printViaOs(valid);
  if (!os.ok) return { ok: false, route: "os", error: [os.error, ...usbLines].join(" · "), lines: usbLines };
  // Keep the USB driver's reason (held / none permitted) unless the dialog showing
  // is the more useful thing to say.
  setPrinterStatus({ state: "os", route: "os", printed: "os", lines: usbLines,
    ...(os.dialogShown ? { detail: "print dialog shown — open the app with the Marathon Labels launcher to print silently" } : {}) });
  // With a dialog the person may have cancelled — say so rather than "printed".
  return { ok: true, route: "os", printed: os.printed, dialogShown: os.dialogShown, lines: usbLines,
    unconfirmed: !!os.dialogShown,
    routeLabel: os.dialogShown ? "the system print dialog (check the labels came out)" : "System print → default printer" };
}

// Diagnostic: print a canvas-free test pattern (solid + stripes) to prove the
// protocol + BLE delivery work independently of label content. Phomemo only.
export async function printTest({ transport, conn = null }) {
  if (transport === "phomemo") return await printPhomemoTest(conn);
  return { ok: false, error: `Test print not supported for "${transport}".` };
}

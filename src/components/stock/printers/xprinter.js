// ─── XPRINTER XP-350B — WebUSB (TSPL) ─────────────────────────────────────────
// Bulk barcode printing on a Mac (desktop Chrome). The XP-350B speaks TSPL, NOT the
// Phomemo's ESC/POS raster: we send high-level text commands and the PRINTER renders
// the Code 128 itself from the digits — no client-side bitmap. Self-contained:
// failures are returned ({ok,error}), never thrown into the print flow.
//
// CONNECTION (WebUSB): requestDevice filtered to the USB printer class (interface
// class 0x07) so the chooser shows the XP-350B → open → selectConfiguration(1) →
// claim the interface that has a bulk OUT endpoint → transferOut raw TSPL bytes.
// The device + endpoint are cached and reused across batches; on the next batch we
// reopen the SAME device (or a previously-permitted one via getDevices) WITHOUT the
// chooser. A USB disconnect clears the cache. claimInterface failures (common on
// macOS when the OS owns the printer) surface a clear message.
//
// This is a SEPARATE transport — the Phomemo M110 Bluetooth path is untouched.

import { code128Modules } from "../barcode";

const ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

// ── LABEL SIZE (XP-350B) — the only knobs to change for a different roll ──────
const DOTS_PER_MM     = 8;   // 203 dpi ≈ 8 dots/mm
const LABEL_WIDTH_MM  = 40;  // default; tune to the loaded roll
const LABEL_HEIGHT_MM = 30;
const GAP_MM          = 2;   // inter-label gap (printer auto-detects → one label each)
const LABEL_WIDTH_DOTS = LABEL_WIDTH_MM * DOTS_PER_MM; // 320

const PRINTER_CLASS = 0x07;  // USB printer class (bInterfaceClass) — the chooser filter
const TX_CHUNK = 8192;       // transferOut chunk so large batches don't choke

// Cached connection — reused across batches; silent reconnect (no chooser).
let cachedDevice = null, cachedIface = null, cachedEndpoint = null;
let disconnectWired = false;

export function isXprinterSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb;
}

function clearCache() { cachedDevice = null; cachedIface = null; cachedEndpoint = null; }
function wireDisconnect() {
  if (disconnectWired || typeof navigator === "undefined" || !navigator.usb) return;
  navigator.usb.addEventListener("disconnect", (e) => { if (e.device === cachedDevice) clearCache(); });
  disconnectWired = true;
}

// ── TSPL encoding ────────────────────────────────────────────────────────────
// TSPL internal bitmap fonts (id → approx char width in dots at scale 1) used to
// auto-fit / centre text without a canvas.
const TSPL_FONTS = [{ id: "3", w: 16 }, { id: "2", w: 12 }, { id: "1", w: 8 }];

// Auto-fit the name: pick the largest font whose rendered width fits, else use the
// smallest and hard-truncate so it can NEVER overflow the label width.
function fitText(name, maxWidthDots) {
  const clean = String(name || "").replace(/["\\\n\r]/g, " ").trim();
  for (const f of TSPL_FONTS) {
    if (clean.length * f.w <= maxWidthDots) return { font: f.id, w: f.w, text: clean };
  }
  const f = TSPL_FONTS[TSPL_FONTS.length - 1];
  const maxChars = Math.max(1, Math.floor(maxWidthDots / f.w));
  return { font: f.id, w: f.w, text: clean.slice(0, maxChars) };
}

// One label's TSPL. Centres the name and the barcode horizontally; the printer
// advances exactly one label via SIZE+GAP auto-detection.
function tsplLabel({ code, productName, size }, copies) {
  const margin = 16;                                   // ~2mm edge margin
  const maxW = LABEL_WIDTH_DOTS - margin * 2;
  const title = `${productName || ""}${size ? "  " + size : ""}`;
  const fit = fitText(title, maxW);
  const textW = fit.text.length * fit.w;
  const textX = Math.max(margin, Math.round((LABEL_WIDTH_DOTS - textW) / 2));

  // Code 128 width = total modules × narrow-bar dots; shrink narrow to fit if needed.
  const totalModules = code128Modules(code).reduce((s, m) => s + m.width, 0);
  let narrow = 2;
  while (totalModules * narrow > maxW && narrow > 1) narrow--;
  const barW = totalModules * narrow;
  const barX = Math.max(margin, Math.round((LABEL_WIDTH_DOTS - barW) / 2));

  const textY = 16;
  const barY = textY + Math.round(fit.w * 1.6) + 8;    // below the name
  // Bar height fills the label, leaving room for the human-readable digits (~30 dots).
  const barH = Math.max(40, LABEL_HEIGHT_MM * DOTS_PER_MM - barY - 30);

  return [
    `SIZE ${LABEL_WIDTH_MM} mm,${LABEL_HEIGHT_MM} mm`,
    `GAP ${GAP_MM} mm,0 mm`,
    "DIRECTION 1",
    "CLS",
    `TEXT ${textX},${textY},"${fit.font}",0,1,1,"${fit.text}"`,
    // BARCODE x,y,"128",height,human-readable(1=below),rotation,narrow,wide,"data"
    `BARCODE ${barX},${barY},"128",${barH},1,0,${narrow},${narrow},"${code}"`,
    `PRINT 1,${copies}`,
    "",
  ].join("\r\n");
}

// ── USB plumbing ─────────────────────────────────────────────────────────────
function isPrinterLike(device) {
  for (const cfg of device.configurations || []) {
    for (const intf of cfg.interfaces || []) {
      for (const alt of intf.alternates || []) {
        if (alt.interfaceClass === PRINTER_CLASS) return true;
      }
    }
  }
  return false;
}

// Open + claim the interface with a bulk OUT endpoint (prefer the printer-class one).
async function openDevice(device) {
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  let iface = null, endpointOut = null;
  for (const cfgIface of device.configuration.interfaces) {
    const alt = cfgIface.alternate;
    const out = alt.endpoints.find(e => e.direction === "out" && e.type === "bulk");
    if (!out) continue;
    iface = cfgIface.interfaceNumber; endpointOut = out.endpointNumber;
    if (alt.interfaceClass === PRINTER_CLASS) break;   // prefer the printer interface
  }
  if (iface === null) throw new Error("No bulk OUT endpoint found on the selected USB device — is this the label printer?");
  try {
    await device.claimInterface(iface);
  } catch (e) {
    throw new Error(`Couldn't claim the printer (${e?.message || e}). On macOS the system may own it — remove the XP-350B from System Settings ▸ Printers & Scanners (or quit apps using it), then retry.`);
  }
  cachedDevice = device; cachedIface = iface; cachedEndpoint = endpointOut;
  return { device, iface, endpointOut };
}

// Reuse the live connection; else reopen the cached/known device (no chooser); else
// prompt the chooser. Must run inside the user gesture the FIRST time (requestDevice).
async function getConnection() {
  wireDisconnect();
  if (cachedDevice && cachedDevice.opened && cachedEndpoint != null) {
    return { device: cachedDevice, iface: cachedIface, endpointOut: cachedEndpoint };
  }
  if (cachedDevice) return await openDevice(cachedDevice);          // reopen same device
  // Previously-permitted device → silent reconnect (getDevices needs no gesture and is
  // fast enough that requestDevice's transient activation, if needed, still holds).
  const known = (await navigator.usb.getDevices());
  const pick = known.find(isPrinterLike) || known[0];
  if (pick) return await openDevice(pick);
  const device = await navigator.usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
  return await openDevice(device);
}

// Connect handle for the connect-first flow — call inside the user gesture.
export async function connectXprinter() {
  if (!isXprinterSupported()) throw new Error("WebUSB not available — use desktop Chrome.");
  return await getConnection();
}

async function sendChunked(device, endpoint, bytes) {
  for (let i = 0; i < bytes.length; i += TX_CHUNK) {
    const res = await device.transferOut(endpoint, bytes.slice(i, i + TX_CHUNK));
    if (res.status !== "ok") throw new Error(`USB transfer ${res.status}`);
  }
}

// items: [{ code, productName, size, count }]. Emits one TSPL label per item with
// PRINT copies = count (never 0 → 1). Streams the whole batch over ONE connection;
// the device stays claimed afterwards for the next batch (silent reuse).
export async function printXprinter(items, conn = null) {
  if (!isXprinterSupported()) return { ok: false, error: "WebUSB not available — use desktop Chrome." };
  if (!ENCODER) return { ok: false, error: "TextEncoder unavailable." };
  try {
    const c = conn || await getConnection();
    let printed = 0;
    for (const it of items || []) {
      if (!it || !it.code) continue;
      const n = Number(it.count);
      const copies = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;   // never 0
      await sendChunked(c.device, c.endpointOut, ENCODER.encode(tsplLabel(it, copies)));
      printed += copies;
    }
    if (!printed) return { ok: false, error: "Nothing to print." };
    return { ok: true, printed };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  // NO release/close — keep the device claimed so the next batch reuses it (BUG-2 parity
  // with Phomemo). The cache is cleared by the USB 'disconnect' listener.
}

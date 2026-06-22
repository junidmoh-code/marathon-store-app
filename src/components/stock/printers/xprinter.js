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

// Last selected device's identity + interface/endpoint map. Captured BEFORE claim so
// we keep the VID/PID even if claimInterface fails. Surfaced to RTDB by the caller so
// we can set a precise filter later (the chooser currently lists ALL devices).
let lastXprinterDiag = null;
export function getXprinterDiag() { return lastXprinterDiag; }
const hex4 = (n) => (typeof n === "number" ? "0x" + n.toString(16).padStart(4, "0") : String(n));

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

// Greedy word-wrap into lines of at most maxChars characters.
function wrapByChars(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = []; let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (trial.length <= maxChars) cur = trial;
    else { if (cur) lines.push(cur); cur = w.length > maxChars ? w.slice(0, maxChars) : w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Auto-fit the name: pick the LARGEST font whose word-wrap fits within `maxLines`
// lines, so the FULL name shows across multiple lines — never truncated. Only when
// even the smallest font overflows maxLines is the tail dropped (pathological).
function fitNameLines(name, maxWidthDots, maxLines = 3) {
  const clean = String(name || "").replace(/["\\\n\r]/g, " ").trim();
  for (const f of TSPL_FONTS) {
    const maxChars = Math.max(1, Math.floor(maxWidthDots / f.w));
    const lines = wrapByChars(clean, maxChars);
    if (lines.length <= maxLines) return { font: f.id, w: f.w, lines };
  }
  const f = TSPL_FONTS[TSPL_FONTS.length - 1];
  const maxChars = Math.max(1, Math.floor(maxWidthDots / f.w));
  const all = wrapByChars(clean, maxChars);
  const kept = all.slice(0, maxLines);
  // Signal a forced cut rather than dropping the tail silently.
  if (all.length > maxLines && kept.length) {
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = (last.length >= maxChars ? last.slice(0, maxChars - 1) : last) + "…";
  }
  return { font: f.id, w: f.w, lines: kept };
}

// One label's TSPL. Vertical order: NAME → SIZE → barcode (with the 8-digit code the
// printer renders below the bars). NAME and SIZE are on SEPARATE lines so a long name
// can never push the size off the label. Everything centred; the printer advances
// exactly one label via SIZE+GAP auto-detection.
function tsplLabel({ code, productName, size }, copies) {
  const margin = 16;                                   // ~2mm edge margin
  const maxW = LABEL_WIDTH_DOTS - margin * 2;
  // Centre an element of width w within the label.
  const at = (w) => Math.max(margin, Math.round((LABEL_WIDTH_DOTS - w) / 2));

  // Product NAME — own block, auto-fit; wraps to TWO lines (full name) rather than
  // truncating. Each line is its own TEXT command.
  const nameFit = fitNameLines(productName, maxW);
  const nameY = 18;
  const nameLH = Math.round(nameFit.w * 1.6);
  const nameCmds = nameFit.lines.map((ln, i) =>
    `TEXT ${at(ln.length * nameFit.w)},${nameY + i * nameLH},"${nameFit.font}",0,1,1,"${ln}"`);

  // SIZE — own prominent line ("Size: 9"), the largest internal font so it's spotted
  // at a glance. Sanitised like the name (no quotes/newlines to break TSPL).
  const sizeStr = (size != null && String(size).trim() !== "") ? `Size: ${String(size).trim()}` : "";
  const sizeFont = TSPL_FONTS[0];                      // font "3" (largest)
  const sizeText = sizeStr.replace(/["\\\n\r]/g, " ");
  const sizeX = at(sizeText.length * sizeFont.w);
  const sizeY = nameY + nameFit.lines.length * nameLH + 6;
  const sizeLH = sizeStr ? Math.round(sizeFont.w * 1.6) : 0;

  // Code 128 width = total modules × narrow-bar dots; shrink narrow only if needed
  // (kept ≥ a scannable density). Height is MINIMISED (capped) to keep the size prominent.
  const totalModules = code128Modules(code).reduce((s, m) => s + m.width, 0);
  let narrow = 2;
  while (totalModules * narrow > maxW && narrow > 1) narrow--;
  const barW = totalModules * narrow;
  const barX = at(barW);
  const barY = sizeY + sizeLH + 10;
  const avail = LABEL_HEIGHT_MM * DOTS_PER_MM - barY - 30;  // leave ~30 dots for the digits
  const barH = Math.max(48, Math.min(avail, 96));          // minimised, still scannable

  const lines = [
    `SIZE ${LABEL_WIDTH_MM} mm,${LABEL_HEIGHT_MM} mm`,
    `GAP ${GAP_MM} mm,0 mm`,
    "DIRECTION 1",
    "CLS",
    ...nameCmds,
  ];
  if (sizeStr) lines.push(`TEXT ${sizeX},${sizeY},"${sizeFont.id}",0,1,1,"${sizeText}"`);
  // BARCODE x,y,"128",height,human-readable(1=below),rotation,narrow,wide,"data"
  lines.push(`BARCODE ${barX},${barY},"128",${barH},1,0,${narrow},${narrow},"${code}"`);
  lines.push(`PRINT 1,${copies}`, "");
  return lines.join("\r\n");
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
  // Capture the device's real identity + interface/endpoint map BEFORE claiming, so a
  // claim failure still records the VID/PID we need to build a proper filter later.
  lastXprinterDiag = {
    at: new Date().toISOString(),
    name: device.productName || "",
    manufacturer: device.manufacturerName || "",
    serial: device.serialNumber || "",
    vendorId: hex4(device.vendorId),
    productId: hex4(device.productId),
    interfaces: (device.configuration?.interfaces || []).map(ci => ({
      number: ci.interfaceNumber,
      class: ci.alternate?.interfaceClass,
      subclass: ci.alternate?.interfaceSubclass,
      protocol: ci.alternate?.interfaceProtocol,
      endpoints: (ci.alternate?.endpoints || []).map(e => ({ number: e.endpointNumber, direction: e.direction, type: e.type })),
    })),
    chosen: { iface, endpointOut },
  };
  console.log("[xprinter] device:", JSON.stringify(lastXprinterDiag));

  if (iface === null) throw new Error("No bulk OUT endpoint found on the selected USB device — is this the label printer?");
  try {
    await device.claimInterface(iface);
  } catch (e) {
    const msg = String(e?.message || e);
    const inUse = /in use|claim|access|denied|busy/i.test(msg);
    throw new Error(
      `Couldn't claim the printer${inUse ? " — the interface is in use" : ""} (${msg}). ` +
      `On macOS the system usually owns the printer: remove the XP-350B from System Settings ▸ Printers & Scanners ` +
      `(and quit any app using it), then retry. VID/PID ${lastXprinterDiag.vendorId}/${lastXprinterDiag.productId}.`
    );
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
  // Empty filters → list ALL USB devices, so the XP-350B always appears even if it
  // presents a vendor-specific class (the classCode 0x07 filter was hiding it). Once
  // we log the real VID/PID we can narrow this back down.
  const device = await navigator.usb.requestDevice({ filters: [] });
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

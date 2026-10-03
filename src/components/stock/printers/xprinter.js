// ─── USB LABEL PRINTER — WebUSB (TSPL, or ESC/POS raster) ─────────────────────
// Bulk barcode printing from desktop Chrome to whatever USB label printer is
// attached: Xprinter XP-350B, XP-360B, or any other TSPL or ESC/POS label printer.
// TSPL printers get high-level text commands and render the Code 128 themselves;
// an ESC/POS-only printer gets the label as a raster. Self-contained: failures are
// returned ({ok,error}), never thrown into the print flow.
//
// CONNECTION: no device is assumed. On every print (and on load, and whenever a
// USB device is plugged in) getDevices() is walked — the last device that worked
// first — and every bulk OUT endpoint on every configuration/interface/alternate
// is tried: open → selectConfiguration → claimInterface → a zero-length write.
// A failure gets reset() and one retry before the next device is tried. The
// device picker (requestDevice) appears ONLY when the site has no permitted USB
// device at all — the one manual escape hatch. Discovery lives in usbDiscovery.js.
//
// When nothing can be claimed (on macOS the print system may hold the printer),
// the facade falls back to the OS print route (osPrint.js) — see index.js.

import { code128Modules } from "../barcode";
import {
  discoverUsbPrinter, sendBulk, deviceKey, deviceLabel, formatAttempt,
  readIeee1284Id, commandLanguageFrom1284, isPrinterLike, deviceMatch,
} from "./usbDiscovery";
import { setPrinterStatus } from "./printerStatus";
import { renderLabelBitmap } from "./labelBitmap";

const ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

// ── LABEL SIZE (XP-350B) — the only knobs to change for a different roll ──────
const DOTS_PER_MM     = 8;   // 203 dpi ≈ 8 dots/mm
const LABEL_WIDTH_MM  = 40;  // default; tune to the loaded roll
const LABEL_HEIGHT_MM = 30;
const GAP_MM          = 2;   // inter-label gap (printer auto-detects → one label each)
const LABEL_WIDTH_DOTS = LABEL_WIDTH_MM * DOTS_PER_MM; // 320
const MARGIN_DOTS     = 16;  // ~2mm edge margin

// Shared with the OS print route so both routes print the same-size label.
export const LABEL_GEOMETRY = Object.freeze({
  widthMm: LABEL_WIDTH_MM, heightMm: LABEL_HEIGHT_MM, gapMm: GAP_MM, dotsPerMm: DOTS_PER_MM, marginDots: MARGIN_DOTS,
});

const REMEMBER_KEY = "marathon.labelPrinter.usb";   // last device that worked (VID/PID/serial)

export function isXprinterSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb;
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
export function tsplLabel({ code, productName, size, price }, copies) {
  const margin = MARGIN_DOTS;                                   // ~2mm edge margin
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
  // A product label (no size) carries its price in the same slot — as the
  // Phomemo and OS-print labels do.
  const sizeStr = (size != null && String(size).trim() !== "") ? `Size: ${String(size).trim()}`
    : (price != null && String(price).trim() !== "") ? String(price).trim() : "";
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


// ── ESC/POS raster (printers that don't speak TSPL) ──────────────────────────
// The label rendered to a 1-bit bitmap (the Phomemo renderer, sized to this
// label), sent as GS v 0, then GS FF — "feed to the next label start".
function escposLabel(item, copies) {
  const widthDots = LABEL_WIDTH_MM * DOTS_PER_MM;
  const heightDots = LABEL_HEIGHT_MM * DOTS_PER_MM;
  const { bytesPerRow, height, mono } = renderLabelBitmap(item, { widthDots, heightDots, moduleWidth: 2 });
  const one = [
    0x1b, 0x40,                                               // ESC @ — initialise
    0x1d, 0x76, 0x30, 0x00,                                   // GS v 0, normal
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff,
  ];
  const tail = [0x1d, 0x0c];                                  // GS FF — next label
  const out = new Uint8Array((one.length + mono.length + tail.length) * copies);
  let o = 0;
  for (let i = 0; i < copies; i++) { out.set(one, o); o += one.length; out.set(mono, o); o += mono.length; out.set(tail, o); o += tail.length; }
  return out;
}

// ── USB plumbing ─────────────────────────────────────────────────────────────
// Discovery, open/claim and transfer are in usbDiscovery.js; this keeps the one
// live connection, remembers which device worked, keeps the status indicator
// current and re-finds the printer when it is replugged or wakes.

let cached = null;            // { device, endpointNumber, interfaceNumber, language, name, detail }
let lastDiag = null;          // RTDB-safe description of the last device/attempts
let pickerShown = false;      // the escape-hatch picker: at most once per page load
let watching = false;
const languages = new WeakMap();   // USBDevice → "tspl" | "escpos"

export function getXprinterDiag() { return lastDiag; }

function loadRemembered() {
  try { const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null"); return v && typeof v === "object" ? v : null; }
  catch { return null; }
}
function saveRemembered(device) {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(deviceKey(device))); } catch { /* storage blocked — just no memory */ }
}

// One USB conversation at a time: the load-time probe, a replug and a print —
// including the print's transfers — never touch the device concurrently.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// The command language: the printer's own IEEE 1284 id when it answers, else
// TSPL (every Xprinter label model speaks it). Only a real answer is cached — a
// device that didn't answer this time is asked again next time.
async function languageFor(device, conn) {
  if (languages.has(device)) return languages.get(device);
  const lang = commandLanguageFrom1284(await readIeee1284Id(device, conn));
  if (lang) languages.set(device, lang);
  return lang || "tspl";
}

function useConnection(device, conn, language) {
  const detail = `interface ${conn.interfaceNumber} · endpoint ${conn.endpointNumber}${language === "escpos" ? " · ESC/POS" : ""}`;
  cached = { device, endpointNumber: conn.endpointNumber, interfaceNumber: conn.interfaceNumber, language, name: deviceLabel(device), detail };
  lastDiag = { ...conn.diag, attempts: [] };
  saveRemembered(device);
  setPrinterStatus({ state: "usb", name: cached.name, route: "usb", detail, lines: [], devicesSeen: null });
  return { route: "usb", ...cached };
}

// Find a usable USB printer. Never throws. Returns a USB connection, or
// { route: "os", attempts, lines } when no device could be used.
// allowPicker: only from a tap — the picker needs the click's activation, so it
// runs right after the first await (getDevices) when NO device is permitted. A
// print offers it once per page load; forcePicker is the explicit button.
export function findUsbPrinter(opts = {}) {
  return exclusive(() => findUnlocked(opts));
}

async function findUnlocked({ allowPicker = false, forcePicker = false } = {}) {
  if (!isXprinterSupported()) {
    setPrinterStatus({ state: "os", route: "os", name: "", detail: "this browser has no WebUSB", lines: [] });
    return { route: "os", attempts: [], lines: ["WebUSB not available in this browser"] };
  }
  setPrinterStatus({ state: "checking" });
  const usb = navigator.usb;
  let res;
  try {
    res = await discoverUsbPrinter(usb, { remembered: loadRemembered(), preferred: cached?.device || null, at: new Date().toISOString() });
  } catch (e) {
    res = { ok: false, attempts: [], devicesSeen: 0, error: e };
  }
  if (!res.ok && res.devicesSeen === 0 && allowPicker && (forcePicker || !pickerShown)) {
    try {
      const picked = await usb.requestDevice({ filters: [] });
      pickerShown = true;
      res = await discoverUsbPrinter({ getDevices: async () => [picked] }, {});
    } catch (e) {
      // NotFoundError = the person closed the picker: don't offer it again this
      // load. Anything else (e.g. the tap's activation expired) leaves it on offer.
      if (e?.name === "NotFoundError") pickerShown = true;
    }
  }
  if (res.ok) {
    const language = await languageFor(res.device, res.conn);
    return useConnection(res.device, res.conn, language);
  }
  cached = null;
  const lines = res.attempts.map(formatAttempt);
  if (!lines.length) lines.push(res.devicesSeen ? "no device could be used" : "no USB printer has been allowed for this site yet");
  if (res.error) lines.push(`getDevices failed — ${String(res.error?.message || res.error)}`);
  const held = res.attempts.some((a) => a.heldElsewhere);
  lastDiag = {
    at: new Date().toISOString(),
    devicesSeen: res.devicesSeen,
    attempts: lines,
    heldElsewhere: held,
  };
  setPrinterStatus({
    state: "os", route: "os", name: "", devicesSeen: res.devicesSeen,
    detail: held ? "USB printer is held by the computer's print system" : res.devicesSeen ? "no USB device could be claimed" : "no USB printer permitted",
    lines,
  });
  return { route: "os", attempts: res.attempts, lines, devicesSeen: res.devicesSeen, heldElsewhere: held };
}

// Watch for the printer being plugged in, unplugged or waking: re-find it silently.
export function startUsbPrinterWatch() {
  if (watching || !isXprinterSupported()) return;
  watching = true;
  const usb = navigator.usb;
  // A keyboard or a phone being plugged in is not a reason to touch the printer:
  // only a printer-looking or remembered device re-runs discovery, and only when
  // there is no working connection already. Debounced — a replug fires in bursts.
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { findUsbPrinter(); }, 400); };
  const relevant = (d) => !d || isPrinterLike(d) || deviceMatch(d, loadRemembered()) > 0;
  usb.addEventListener("connect", (e) => { if (!cached && relevant(e?.device)) later(); });
  usb.addEventListener("disconnect", (e) => {
    if (cached && e?.device === cached.device) {
      cached = null;
      setPrinterStatus({ state: "checking", route: null, name: "", detail: "printer unplugged — waiting for it", lines: [] });
      later();
    }
  });
  findUsbPrinter();
}

// Connect handle for the connect-first flow — call inside the user gesture.
export async function connectXprinter() {
  return await findUsbPrinter({ allowPicker: true });
}

// items: [{ code, productName, size, price?, count }]. One label per item with
// PRINT copies = count (never 0 → 1), all over ONE connection. Returns sentBytes
// so the caller knows whether falling back to the OS route could double-print.
export function printXprinter(items, conn = null) {
  if (!isXprinterSupported()) return Promise.resolve({ ok: false, sentBytes: 0, error: "WebUSB not available — use desktop Chrome." });
  if (!ENCODER) return Promise.resolve({ ok: false, sentBytes: 0, error: "TextEncoder unavailable." });
  // The whole batch holds the lock, so a replug-triggered probe can't release or
  // close the device under a transfer.
  return exclusive(() => sendBatch(items, conn));
}

async function sendBatch(items, conn) {
  // A handle from connectXprinter is only good while it is still THE connection
  // (an unplug in between clears it); otherwise find the printer again.
  const live = conn?.route === "usb" && cached && cached.device === conn.device;
  const c = live ? conn : await findUnlocked();
  if (c.route !== "usb") return { ok: false, sentBytes: 0, error: "No USB printer could be used.", lines: c.lines || [] };
  let sentBytes = 0, printed = 0;
  try {
    for (const it of items || []) {
      if (!it || !it.code) continue;
      const n = Number(it.count);
      const copies = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;   // never 0
      const bytes = c.language === "escpos" ? escposLabel(it, copies) : ENCODER.encode(tsplLabel(it, copies));
      sentBytes += await sendBulk(c.device, c.endpointNumber, bytes);
      printed += copies;
    }
    if (!printed) return { ok: false, sentBytes, error: "Nothing to print." };
    return { ok: true, printed, sentBytes, route: "usb", name: c.name };
  } catch (err) {
    // The device stopped answering — drop it so the next print re-discovers.
    if (cached && cached.device === c.device) cached = null;
    const line = `${c.name} · interface ${c.interfaceNumber} · OUT endpoint ${c.endpointNumber} · ${String(err?.message || err)}`;
    lastDiag = { ...(lastDiag || {}), attempts: [line] };
    setPrinterStatus({ state: "checking", route: null, lines: [line] });
    return { ok: false, sentBytes, error: line, lines: [line] };
  }
  // NO release/close — the device stays claimed so the next batch reuses it.
}

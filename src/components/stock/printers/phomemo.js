// ─── PHOMEMO M110 — Web Bluetooth ─────────────────────────────────────────────
// Connects over BLE GATT and prints each label as a Phomemo raster bitmap.
// Self-contained: every entry point is wrapped so a Bluetooth failure surfaces as
// a returned error and never throws into the print flow.
//
// ENCODE — the M110 is NOT a plain ESC/POS printer. It needs its own (reverse-
// engineered) command frame; sending only "ESC @ → GS v 0 → ESC d" makes it eject
// a BLANK label and keep feeding because it was never told the media is gapped
// labels and never given its real print/feed terminator. The working M110 frame
// (vivier/phomemo-tools + bdm-k "Print images on the Phomemo M110" gist) is:
//   INIT:     1B 4E 0D <speed 1..5>      print speed
//             1B 4E 04 <darkness 1..15>  print density
//             1F 11 <0x0A>               media type = LABEL WITH GAPS  ← the key bit
//   RASTER:   1D 76 30 00 bplLE16 linesLE16 + 1bpp rows (MSB-first, 1=black),
//             split into ≤240-line GS v 0 blocks (M110 block ceiling).
//   FINALIZE: 1F F0 05 00   print + feed to the gap (NOT ESC d). We send ONLY this —
//             the extra 1F F0 03 00 was advancing a second blank label every print.
// Width is the FULL head (48 bytes / 384 dots); the bitmap centres the content within
// it so it lands centred on the label, which sits centred under the head. See
// labelBitmap.js + the LABEL SIZE constants below.
// SEND: the whole frame is streamed in chunks, awaiting each. With an acknowledged
//   (`write`) characteristic each write is flow-controlled, so the raster tail can't
//   drop (the "reacts but prints nothing" symptom); a write-without-response char
//   falls back to paced unacknowledged writes. A short diagnostic (service/char/
//   props/bytes) is surfaced in the print toast for blind hardware debugging.
// LIFECYCLE: the connected device + characteristic are cached and REUSED across
//   prints; on gattserverdisconnected we mark it stale and silently reconnect to
//   the SAME device (device.gatt.connect()) on the next print — never re-prompting
//   the chooser unless the device object is lost.

import { renderLabelBitmap } from "./labelBitmap";

// Candidate GATT services accessed after connect. The M110 advertises by NAME only
// (not its service UUID), so we acceptAllDevices in the chooser and list these so
// getPrimaryServices() can reach them, then auto-pick the first WRITABLE char.
const CANDIDATE_SERVICES = [
  "0000ff00-0000-1000-8000-00805f9b34fb", // Phomemo (M110/M120/M200) — write 0xFF02, notify 0xFF01
  "000018f0-0000-1000-8000-00805f9b34fb", // 0x18F0 thermal SPP — write 0x2AF1, notify 0x2AF0
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // ISSC / Microchip transparent UART
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service — write 6e400002
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // misc Phomemo / serial variant
  "0000ae30-0000-1000-8000-00805f9b34fb", // some Phomemo/iDPRT variants — write 0xAE01
  "0000fee7-0000-1000-8000-00805f9b34fb", // common thermal-printer service
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10-style serial — write 0xFFE1
];
const CHUNK = 180;            // BLE write size (MTU-safe; the frame is streamed in these)
const MAX_BLOCK_LINES = 240;  // lines per GS v 0 block on the M110 (split taller bitmaps)
const PRINT_SPEED = 0x05;     // 1..5 (5 = fastest the firmware allows)
const PRINT_DARKNESS = 0x0f;  // 1..15 (15 = darkest)
const MEDIA_GAP_LABELS = 0x0a; // 1F 11 nn — 0x0a = "label with gaps" (the M110 default roll)

// ── LABEL SIZE (the only knobs to change for a different roll) ────────────────
// The physical sticker. Confirmed loaded roll is 40 × 30 mm (set 20 for 40×20 rolls).
// CRITICAL: this MUST match the physical label. When it was set to 20 mm on a 30 mm
// roll the raster (152 dots) was shorter than the label, so the print + feed-to-gap
// straddled the inter-label gap → a half-cut barcode and a blank second label. Sizing
// the raster to exactly one label (one GS v 0 block, lines = data sent) fixes both.
const DOTS_PER_MM   = 8;      // 203 dpi ≈ 8 dots/mm
const LABEL_WIDTH_MM  = 40;
const LABEL_HEIGHT_MM = 30;
const HEAD_DOTS     = 384;    // M110 print-head width (48mm). The raster is the FULL head
                             // so content can be CENTRED — the label sits centred under it.
const LABEL_WIDTH_DOTS  = LABEL_WIDTH_MM  * DOTS_PER_MM;            // 320 — printable width
const LABEL_HEIGHT_DOTS = LABEL_HEIGHT_MM * DOTS_PER_MM;           // 240 — one label tall
// Render ~1mm under the label height so we never print into the inter-label gap.
const RASTER_HEIGHT     = LABEL_HEIGHT_DOTS - DOTS_PER_MM;         // 232
// widthDots = full head (centring canvas); contentWidthDots = the label's printable
// width, centred under the head; height = one label.
const LABEL = { widthDots: HEAD_DOTS, heightDots: RASTER_HEIGHT, contentWidthDots: LABEL_WIDTH_DOTS, moduleWidth: 2 };

// Cached connection (BUG 2 — reuse across prints; don't reconnect every time).
let cachedDevice = null;
let cachedChar = null;

// Last-print diagnostic, surfaced in the print toast so a non-technical operator can
// read back what the printer actually exposed (service/char/props/bytes) — turns a
// blind "nothing prints" into an exact, fixable signal.
let lastDiag = "";
export function getPhomemoDiag() { return lastDiag; }

// Full structured GATT dump from the last connect (every service + char + props +
// the device name) plus any bytes the printer sent back on its notify channel.
// Written to RTDB by the Test Print so it can be read server-side — the reliable way
// to see what THIS printer exposes without the operator transcribing anything.
let lastDump = null;
export function getPhomemoDump() { return lastDump; }

// "0000ff02-0000-1000-8000-00805f9b34fb" → "ff02" (16-bit) else the full uuid.
function shortUuid(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid || "");
  return m ? m[1] : (uuid || "?");
}
function propsLabel(p = {}) {
  return [p.write && "w", p.writeWithoutResponse && "wNR", p.notify && "n"].filter(Boolean).join("+") || "none";
}

export function isPhomemoSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// Enumerate the FULL GATT (every reachable service + characteristic + its props),
// pick the data char (prefer the canonical Phomemo write 0xFF02, else any `write`,
// else write-without-response), and subscribe to a notify char if present — some
// Phomemo units won't process a job until the notify channel is open (the official
// app keeps it subscribed). Everything is recorded in lastDump/lastDiag.
async function discoverChar(server, deviceName) {
  const services = await server.getPrimaryServices();
  const dump = { at: new Date().toISOString(), device: deviceName || "(no name)", services: [] };
  let chosen = null, write = null, writeNR = null, notify = null;

  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    const svcEntry = { uuid: shortUuid(svc.uuid), chars: [] };
    for (const ch of chars) {
      svcEntry.chars.push({ uuid: shortUuid(ch.uuid), props: propsLabel(ch.properties) });
      const isPhomemoWrite = shortUuid(ch.uuid) === "ff02";
      if (isPhomemoWrite && ch.properties.write) chosen = ch;        // canonical, best
      if (!write && ch.properties.write) write = ch;
      if (!writeNR && ch.properties.writeWithoutResponse) writeNR = ch;
      if (!notify && ch.properties.notify) notify = ch;
    }
    dump.services.push(svcEntry);
  }

  const ch = chosen || write || writeNR;
  // Open the notify channel (best-effort) and capture whatever the printer reports —
  // both a potential fix and a strong diagnostic signal.
  if (notify) {
    try {
      await notify.startNotifications();
      dump.notifyChar = shortUuid(notify.uuid);
      notify.addEventListener("characteristicvaluechanged", (e) => {
        const v = e.target.value, b = [];
        for (let i = 0; i < v.byteLength; i++) b.push(v.getUint8(i).toString(16).padStart(2, "0"));
        if (lastDump) lastDump.notifyData = b.join(" ");
      });
    } catch (err) { dump.notifyError = String(err?.message || err); }
  }

  dump.chosenChar = ch ? shortUuid(ch.uuid) : null;
  dump.chosenProps = ch ? propsLabel(ch.properties) : null;
  lastDump = dump;
  const svcList = dump.services.map(s => s.uuid).join(",");

  if (ch) {
    console.log("[phomemo] GATT dump:", JSON.stringify(dump));
    lastDiag = `svc[${svcList}] char ${shortUuid(ch.uuid)} (${propsLabel(ch.properties)})${notify ? " +notify" : ""}`;
    return ch;
  }
  lastDiag = `no writable char; svc[${svcList || "none"}]`;
  throw new Error(`Connected but found no writable characteristic. Services seen: ${svcList || "none"}.`);
}

// First-time pick (chooser — must run in a user gesture). Lists EVERY nearby BLE
// device; caches the device + characteristic and wires silent reconnect.
async function pickAndConnect() {
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: CANDIDATE_SERVICES,
  });
  console.log("[phomemo] picked:", device.name || "(no name)", "id:", device.id);
  device.addEventListener("gattserverdisconnected", () => {
    console.log("[phomemo] disconnected — will silently reconnect to the same device on next print");
    cachedChar = null; // keep cachedDevice so we reconnect WITHOUT the chooser
  });
  const server = await device.gatt.connect();
  cachedDevice = device;
  cachedChar = await discoverChar(server, device.name);
  return { device, characteristic: cachedChar };
}

// Reuse the live connection; else silently reconnect the SAME device (no chooser);
// else prompt the chooser. The reconnect/pick run inside the caller's gesture.
async function getConnection() {
  if (cachedDevice && cachedDevice.gatt?.connected && cachedChar) {
    return { device: cachedDevice, characteristic: cachedChar };
  }
  if (cachedDevice) {
    console.log("[phomemo] reconnecting to cached device:", cachedDevice.name || cachedDevice.id);
    const server = await cachedDevice.gatt.connect();
    cachedChar = await discoverChar(server, cachedDevice.name);
    return { device: cachedDevice, characteristic: cachedChar };
  }
  return await pickAndConnect();
}

// Stream the whole frame in chunks, AWAITING each. When the char supports `write`,
// use acknowledged writes (writeValue): each resolves only once the printer has the
// data, so the stream is naturally flow-controlled and the raster tail can't drop.
// Only when the char is write-WITHOUT-response do we fall back to unacknowledged
// writes paced by a per-chunk delay (the best we can do without ACKs). Returns the
// mode + byte/chunk counts for the diagnostic.
async function writeChunked(characteristic, bytes) {
  const useResp = !!characteristic.properties?.write;
  // Keep chunks ≤ CHUNK for BOTH modes: a larger acknowledged write triggers the
  // BLE "long-write" (prepare/execute) procedure that many cheap printers don't
  // implement → silently dropped. CHUNK (180) is proven to be accepted by this
  // printer (it reacts to the init/finalize sent at this size).
  let chunks = 0;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    if (useResp) {
      await characteristic.writeValue(slice);
    } else {
      await characteristic.writeValueWithoutResponse(slice);
      await new Promise((r) => setTimeout(r, 20));
    }
    chunks++;
  }
  return { mode: useResp ? "wResp" : "wNR", bytes: bytes.length, chunks };
}

// Full Phomemo M110 frame for one 1bpp bitmap: INIT (speed/darkness/media) →
// GS v 0 block(s) (≤240 lines each) → FINALIZE (print + feed to gap). See the
// file header for the byte-level rationale — this is the M110's own protocol, not
// generic ESC/POS, which is why a plain "ESC @ / GS v 0 / ESC d" fed blank.
function buildPrintJob({ bytesPerRow, height, mono }) {
  const parts = [
    new Uint8Array([0x1b, 0x4e, 0x0d, PRINT_SPEED]),       // print speed
    new Uint8Array([0x1b, 0x4e, 0x04, PRINT_DARKNESS]),    // print density
    new Uint8Array([0x1f, 0x11, MEDIA_GAP_LABELS]),        // media = label with gaps
  ];
  for (let y = 0; y < height; y += MAX_BLOCK_LINES) {
    const lines = Math.min(MAX_BLOCK_LINES, height - y);
    parts.push(new Uint8Array([
      0x1d, 0x76, 0x30, 0x00,                          // GS v 0, mode 0
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,   // bytes-per-line LE16
      lines & 0xff, (lines >> 8) & 0xff,               // line-count LE16
    ]));
    parts.push(mono.subarray(y * bytesPerRow, (y + lines) * bytesPerRow));
  }
  // Finalize: print + feed to the gap. We send ONLY 1F F0 05 00 — the extra
  // 1F F0 03 00 feed was advancing a SECOND, full, blank label every print (two feed
  // commands = two label advances). One command presents exactly one label.
  parts.push(new Uint8Array([0x1f, 0xf0, 0x05, 0x00]));  // finalize — print + feed to gap
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Connect handle for the connect-first flow — MUST run in the user gesture the
// FIRST time (requestDevice needs activation). Reconnects need no gesture.
export async function connectPhomemo() {
  if (!isPhomemoSupported()) throw new Error("Web Bluetooth not available in this browser.");
  return await getConnection();
}

// A canvas-free test bitmap: top third solid black, middle vertical stripes, bottom
// solid black. Built directly as packed 1bpp bytes (NO renderLabelBitmap / canvas),
// so a successful print proves the protocol + BLE delivery work and isolates the
// label content (canvas) as the only other variable. Same 40×240 geometry as a label.
function buildTestBitmap() {
  const bytesPerRow = HEAD_DOTS / 8, height = RASTER_HEIGHT; // full head width × one label tall
  const mono = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < bytesPerRow; x++) {
      const solid = y < height / 3 || y >= (2 * height) / 3; // black top & bottom thirds
      mono[y * bytesPerRow + x] = solid ? 0xff : (x % 2 ? 0xff : 0x00); // stripes in the middle
    }
  }
  return { bytesPerRow, height, mono };
}

// Print the canvas-free test pattern. Returns { ok, diag, dump, error }. `dump` is the
// full GATT structure (written to RTDB by the caller for server-side diagnosis).
export async function printPhomemoTest(conn = null) {
  if (!isPhomemoSupported()) return { ok: false, error: "Web Bluetooth not available in this browser.", dump: null };
  try {
    const c = conn || await getConnection();
    const last = await writeChunked(c.characteristic, buildPrintJob(buildTestBitmap()));
    const diag = `${lastDiag} · ${last.mode} ${(last.bytes / 1024).toFixed(1)}KB/${last.chunks}`;
    lastDiag = diag;
    // Give the printer a beat to emit any status notification before we report.
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, diag, dump: lastDump ? { ...lastDump, send: { ...last } } : null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), diag: lastDiag, dump: lastDump };
  }
}

// labels: [{ code, productName, size }] already expanded to one entry per copy.
// `conn` (optional) is a pre-established connection from connectPhomemo().
export async function printPhomemo(labels, conn = null) {
  if (!isPhomemoSupported()) return { ok: false, error: "Web Bluetooth not available in this browser." };
  try {
    const c = conn || await getConnection();
    let last = null;
    for (const label of labels) {
      const bmp = renderLabelBitmap(label, LABEL);          // { width, height, bytesPerRow, mono }
      last = await writeChunked(c.characteristic, buildPrintJob(bmp));
    }
    // e.g. "svc[ff00] char ff02 (w+wNR) · wResp 9.6KB/19" — read this back if it
    // reacts but nothing prints.
    const diag = `${lastDiag}${last ? ` · ${last.mode} ${(last.bytes / 1024).toFixed(1)}KB/${last.chunks}` : ""}`;
    lastDiag = diag;
    return { ok: true, printed: labels.length, diag };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), diag: lastDiag };
  }
  // NOTE: intentionally NO disconnect — the GATT link is kept alive and reused for
  // the next print (BUG 2); it silently reconnects via getConnection() if dropped.
}

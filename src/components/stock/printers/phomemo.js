// ─── PHOMEMO M110 — Web Bluetooth ─────────────────────────────────────────────
// Connects over BLE GATT and prints each label as an ESC/POS raster bitmap
// (GS v 0). Self-contained: every entry point is wrapped so a Bluetooth failure
// surfaces as a returned error and never throws into the print flow.
//
// ENCODE (M110, 384-dot / ~48mm head → 48 bytes per line):
//   ESC @ (init) → ESC a 1 (center) → one or more GS v 0 raster blocks
//   (1D 76 30 00, bytesPerLine LE16, lineCount LE16, then the 1bpp rows; MSB-first,
//   1=black) split at 255 lines per block → ESC d 3 (feed to tear bar).
// SEND: BLE writes are MTU-limited, so the whole job is streamed in sequential
//   ~180-byte writeValueWithoutResponse chunks, awaiting each. (One big write is
//   why it fed but printed nothing.)
// LIFECYCLE: the connected device + characteristic are cached and REUSED across
//   prints; on gattserverdisconnected we mark it stale and silently reconnect to
//   the SAME device (device.gatt.connect()) on the next print — never re-prompting
//   the chooser unless the device object is lost.

import { renderLabelBitmap } from "./labelBitmap";

// Candidate GATT services accessed after connect. The M110 advertises by NAME only
// (not its service UUID), so we acceptAllDevices in the chooser and list these so
// getPrimaryServices() can reach them, then auto-pick the first WRITABLE char.
const CANDIDATE_SERVICES = [
  "0000ff00-0000-1000-8000-00805f9b34fb", // Phomemo (M110/M120/M200) — write 0xFF02
  "000018f0-0000-1000-8000-00805f9b34fb", // 0x18F0 thermal SPP — write 0x2AF1
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // ISSC / Microchip transparent UART
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service — write 6e400002
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // misc Phomemo / serial variant
];
const CHUNK = 180;            // BLE write size (MTU-safe; the job is streamed in these)
const MAX_BLOCK_LINES = 255;  // lines per GS v 0 block (split taller bitmaps)
// 384-dot head → 48 bytes per line. Height ≈ 30mm label @ 203dpi. Barcode centered.
const LABEL = { widthDots: 384, heightDots: 240, moduleWidth: 2 };

// Cached connection (BUG 2 — reuse across prints; don't reconnect every time).
let cachedDevice = null;
let cachedChar = null;

export function isPhomemoSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// Writable characteristic across the candidate services. Prefer a WITH-RESPONSE
// (ACK'd) char — the M110 hangs on "Feeding…" if any chunk of the declared raster
// is dropped, and acknowledged writes guarantee every chunk lands. Fall back to a
// write-without-response char only if that's all the printer exposes.
async function discoverChar(server) {
  const services = await server.getPrimaryServices();
  console.log("[phomemo] services:", services.map(s => s.uuid));
  let fallback = null;
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    for (const ch of chars) {
      if (ch.properties.write) {
        console.log("[phomemo] writable (with-response) char:", ch.uuid, "in service", svc.uuid, ch.properties);
        return ch;
      }
      if (ch.properties.writeWithoutResponse && !fallback) fallback = ch;
    }
  }
  if (fallback) {
    console.log("[phomemo] writable (no-response) char:", fallback.uuid, "in service", fallback.service?.uuid, fallback.properties);
    return fallback;
  }
  const seen = services.map(s => s.uuid).join(", ") || "none in the candidate list";
  throw new Error(`Connected but found no writable characteristic. Services seen: ${seen}. Send these UUIDs to the dev.`);
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
  cachedChar = await discoverChar(server);
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
    cachedChar = await discoverChar(server);
    return { device: cachedDevice, characteristic: cachedChar };
  }
  return await pickAndConnect();
}

// Stream the whole job in MTU-safe chunks, AWAITING each so the GS v 0 line-count
// the printer is told to expect always equals the bytes that actually arrive — a
// dropped tail is exactly what hangs it on "Feeding…". With-response writes are
// ACK'd (reliable); the no-response fallback adds a short drain delay per chunk so
// the BLE buffer can't overflow and silently drop the tail.
async function writeChunked(characteristic, bytes) {
  const ack = !!characteristic.properties?.write;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    if (ack) {
      await characteristic.writeValue(slice);
    } else {
      await characteristic.writeValueWithoutResponse(slice);
      await new Promise((r) => setTimeout(r, 12));
    }
  }
}

// Full ESC/POS job for one 1bpp bitmap: init + center + GS v 0 block(s) (≤255
// lines each) + feed.
function buildPrintJob({ bytesPerRow, height, mono }) {
  const parts = [
    new Uint8Array([0x1b, 0x40]),       // ESC @  — init
    new Uint8Array([0x1b, 0x61, 0x01]), // ESC a 1 — center
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
  parts.push(new Uint8Array([0x1b, 0x64, 0x03]));     // ESC d 3 — feed to tear bar
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

// labels: [{ code, productName, size }] already expanded to one entry per copy.
// `conn` (optional) is a pre-established connection from connectPhomemo().
export async function printPhomemo(labels, conn = null) {
  if (!isPhomemoSupported()) return { ok: false, error: "Web Bluetooth not available in this browser." };
  try {
    const c = conn || await getConnection();
    for (const label of labels) {
      const bmp = renderLabelBitmap(label, LABEL);          // { width, height, bytesPerRow, mono }
      await writeChunked(c.characteristic, buildPrintJob(bmp));
    }
    return { ok: true, printed: labels.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  // NOTE: intentionally NO disconnect — the GATT link is kept alive and reused for
  // the next print (BUG 2); it silently reconnects via getConnection() if dropped.
}

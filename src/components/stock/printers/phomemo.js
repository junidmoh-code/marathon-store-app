// ─── PHOMEMO M110 — Web Bluetooth ─────────────────────────────────────────────
// Proven transport (Code128/EAN/QR). Connects over BLE GATT and sends each label
// as an ESC/POS raster bitmap (GS v 0). Self-contained: every entry point is
// wrapped so a Bluetooth failure surfaces as a returned error and never throws
// into the print flow.
//
// HARDWARE NOTE: written to spec; on-device verification is pending (no tablet
// today). The M110 BLE service/characteristic UUIDs below are the community-known
// values; if a label prints blank/offset on tomorrow's test, tune moduleWidth /
// widthDots and confirm the write characteristic — nothing else depends on this.

import { renderLabelBitmap } from "./labelBitmap";

// Candidate GATT services to access after connect. The M110 advertises by NAME
// only (NOT its service UUID), so a service-based requestDevice FILTER screened it
// out entirely — that was the "printer never appears" bug. We now show ALL nearby
// BLE devices (acceptAllDevices) and list these candidates in optionalServices so
// getPrimaryServices() can reach them once the user picks the printer. We then
// auto-pick the first WRITABLE characteristic, so we don't depend on one exact
// UUID. Phomemo 0xFF00 (write 0xFF02) is primary; the rest are common BLE-printer
// serial services as fallbacks.
const CANDIDATE_SERVICES = [
  "0000ff00-0000-1000-8000-00805f9b34fb", // Phomemo (M110/M120/M200) — write 0xFF02
  "000018f0-0000-1000-8000-00805f9b34fb", // 0x18F0 thermal SPP — write 0x2AF1
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // ISSC / Microchip transparent UART
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service — write 6e400002
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // misc Phomemo / serial variant
];
const CHUNK = 200;          // BLE MTU-safe write size
const LABEL = { widthDots: 320, heightDots: 160, moduleWidth: 2 }; // 40mm @ 203dpi

export function isPhomemoSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// Prompts the chooser (must run in a user gesture). Lists EVERY nearby BLE device,
// then discovers a writable characteristic. Logs the device name + service/char
// UUIDs so we can tighten the filter once we see the real values.
async function connect() {
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: CANDIDATE_SERVICES,
  });
  console.log("[phomemo] picked:", device.name || "(no name)", "id:", device.id);
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();
  console.log("[phomemo] services:", services.map(s => s.uuid));
  let characteristic = null;
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    for (const ch of chars) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) {
        characteristic = ch;
        console.log("[phomemo] writable char:", ch.uuid, "in service", svc.uuid, ch.properties);
        break;
      }
    }
    if (characteristic) break;
  }
  if (!characteristic) {
    const seen = services.map(s => s.uuid).join(", ") || "none in the candidate list";
    throw new Error(`Connected to "${device.name || "device"}" but found no writable characteristic. Services seen: ${seen}. Send these UUIDs to the dev to whitelist.`);
  }
  return { device, characteristic };
}

async function writeChunked(characteristic, bytes) {
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    // writeValueWithoutResponse is faster but not always supported; fall back.
    if (characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(slice);
    else await characteristic.writeValue(slice);
  }
}

// ESC/POS raster command (GS v 0) for one 1bpp bitmap.
function rasterCommand({ bytesPerRow, height, mono }) {
  const header = new Uint8Array([
    0x1b, 0x40,                                            // ESC @ — init
    0x1d, 0x76, 0x30, 0x00,                                // GS v 0, mode 0
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,         // xL xH (bytes/row)
    height & 0xff, (height >> 8) & 0xff,                   // yL yH (rows)
  ]);
  const feed = new Uint8Array([0x1b, 0x64, 0x02]);        // ESC d 2 — feed 2 lines
  const out = new Uint8Array(header.length + mono.length + feed.length);
  out.set(header, 0);
  out.set(mono, header.length);
  out.set(feed, header.length + mono.length);
  return out;
}

// Connect handle for the connect-first flow — MUST be called inside the user gesture
// (requestDevice needs transient activation, which async work before it consumes).
export async function connectPhomemo() {
  if (!isPhomemoSupported()) throw new Error("Web Bluetooth not available in this browser.");
  return await connect();
}

// labels: [{ code, productName, size }] already expanded to one entry per copy.
// `conn` (optional) is a pre-established connection from connectPhomemo().
export async function printPhomemo(labels, conn = null) {
  if (!isPhomemoSupported()) return { ok: false, error: "Web Bluetooth not available in this browser." };
  let c = conn, device;
  try {
    if (!c) c = await connect();
    device = c.device;
    for (const label of labels) {
      const bmp = renderLabelBitmap(label, LABEL);
      await writeChunked(c.characteristic, rasterCommand(bmp));
    }
    return { ok: true, printed: labels.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { device?.gatt?.connected && device.gatt.disconnect(); } catch { /* ignore */ }
  }
}

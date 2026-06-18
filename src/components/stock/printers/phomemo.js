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

// Community-known Phomemo M110 GATT service + write characteristic.
const SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb";
const WRITE_UUID = "0000ff02-0000-1000-8000-00805f9b34fb";
const CHUNK = 200;          // BLE MTU-safe write size
const LABEL = { widthDots: 320, heightDots: 160, moduleWidth: 2 }; // 40mm @ 203dpi

export function isPhomemoSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// Prompts the chooser (must run in a user gesture). Returns the write characteristic.
async function connect() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: "M110" }, { namePrefix: "Phomemo" }],
    optionalServices: [SERVICE_UUID],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(WRITE_UUID);
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

// labels: [{ code, productName, size }] already expanded to one entry per copy.
export async function printPhomemo(labels) {
  if (!isPhomemoSupported()) return { ok: false, error: "Web Bluetooth not available in this browser." };
  let device;
  try {
    const conn = await connect();
    device = conn.device;
    for (const label of labels) {
      const bmp = renderLabelBitmap(label, LABEL);
      await writeChunked(conn.characteristic, rasterCommand(bmp));
    }
    return { ok: true, printed: labels.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { device?.gatt?.connected && device.gatt.disconnect(); } catch { /* ignore */ }
  }
}

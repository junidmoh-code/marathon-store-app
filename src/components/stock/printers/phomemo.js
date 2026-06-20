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
//   FINALIZE: 1F F0 05 00  1F F0 03 00   print + feed to the gap (NOT ESC d).
// Width is 40 bytes / 320 dots (the 40mm M110 label); the bitmap is rendered to
// that width so there's no centering command and nothing falls off the label edge.
// SEND: BLE writes are MTU-limited, so the whole frame is streamed in sequential
//   ~180-byte chunks, awaiting each.
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
const CHUNK = 180;            // BLE write size (MTU-safe; the frame is streamed in these)
const MAX_BLOCK_LINES = 240;  // lines per GS v 0 block on the M110 (split taller bitmaps)
const PRINT_SPEED = 0x05;     // 1..5 (5 = fastest the firmware allows)
const PRINT_DARKNESS = 0x0f;  // 1..15 (15 = darkest)
const MEDIA_GAP_LABELS = 0x0a; // 1F 11 nn — 0x0a = "label with gaps" (the M110 default roll)
// 320-dot / 40mm M110 label → 40 bytes per line. Height ≈ 30mm @ 203dpi. The bitmap
// is rendered full-width so no centering command is needed.
const LABEL = { widthDots: 320, heightDots: 240, moduleWidth: 2 };

// Cached connection (BUG 2 — reuse across prints; don't reconnect every time).
let cachedDevice = null;
let cachedChar = null;

export function isPhomemoSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// Writable characteristic across the candidate services. Prefer a WRITE-WITHOUT-
// RESPONSE char — that's what the M110's data characteristic (0xFF02) is, and it's
// the transport every working M110 implementation uses. A with-response writeValue
// to these cheap printers can stall waiting for an ATT ACK that never comes, which
// itself hangs the print on "Feeding…". Fall back to a with-response char only if
// that's all the printer exposes.
async function discoverChar(server) {
  const services = await server.getPrimaryServices();
  console.log("[phomemo] services:", services.map(s => s.uuid));
  let fallback = null;
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => []);
    for (const ch of chars) {
      if (ch.properties.writeWithoutResponse) {
        console.log("[phomemo] writable (no-response) char:", ch.uuid, "in service", svc.uuid, ch.properties);
        return ch;
      }
      if (ch.properties.write && !fallback) fallback = ch;
    }
  }
  if (fallback) {
    console.log("[phomemo] writable (with-response) char:", fallback.uuid, "in service", fallback.service?.uuid, fallback.properties);
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

// Stream the whole frame in MTU-safe chunks, AWAITING each. Prefer write-without-
// response (the M110 data char) with a short per-chunk pause — timing matters on
// these printers (bdm-k: "timing is critical"), and the pause lets the BLE buffer
// drain so no chunk is dropped. Only use with-response writeValue if the char has
// no writeWithoutResponse, since a missing ATT ACK there can stall the whole print.
async function writeChunked(characteristic, bytes) {
  const noResp = !!characteristic.properties?.writeWithoutResponse;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.slice(i, i + CHUNK);
    if (noResp) {
      await characteristic.writeValueWithoutResponse(slice);
      await new Promise((r) => setTimeout(r, 18));
    } else {
      await characteristic.writeValue(slice);
    }
  }
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
  parts.push(new Uint8Array([0x1f, 0xf0, 0x05, 0x00]));  // finalize — print
  parts.push(new Uint8Array([0x1f, 0xf0, 0x03, 0x00]));  // finalize — feed to gap
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

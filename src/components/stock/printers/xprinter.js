// ─── XPRINTER XP-350B — WebUSB (TSPL) ─────────────────────────────────────────
// UNPROVEN transport — flagged for tomorrow's hardware test. Sends TSPL text; the
// printer renders the Code 128 itself from the code value (no client bitmap), so
// this path is simple. Self-contained: failures are returned, never thrown into
// the print flow, so a failed test blocks nothing else.
//
// HARDWARE NOTE: TSPL command set + label geometry (40×30mm, gap 2mm) are written
// to spec. On tomorrow's test, if nothing prints: confirm the device exposes a
// printer-class bulk OUT endpoint over WebUSB (some XP units are USB-printer-class
// and may need the WinUSB/libusb path or a vendor driver), and tune SIZE/GAP.

const ENCODER = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

export function isXprinterSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb;
}

// Build the TSPL program for the batch. One label block per copy.
function tsplProgram(labels) {
  const lines = [];
  for (const { code, productName, size } of labels) {
    const title = `${productName || ""}${size ? " " + size : ""}`.replace(/"/g, "'").slice(0, 28);
    lines.push(
      "SIZE 40 mm,30 mm",
      "GAP 2 mm,0 mm",
      "DIRECTION 1",
      "CLS",
      `TEXT 16,12,"2",0,1,1,"${title}"`,
      // BARCODE x,y,"128",height,human-readable(1),rotation,narrow,wide,"data"
      `BARCODE 16,44,"128",60,1,0,2,2,"${code}"`,
      "PRINT 1,1",
    );
  }
  return lines.join("\n") + "\n";
}

async function connect() {
  const device = await navigator.usb.requestDevice({ filters: [] }); // user picks the printer
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  // Find an interface with a bulk OUT endpoint and claim it.
  let iface = null, endpointOut = null;
  for (const cfgIface of device.configuration.interfaces) {
    const alt = cfgIface.alternate;
    const out = alt.endpoints.find(e => e.direction === "out" && e.type === "bulk");
    if (out) { iface = cfgIface.interfaceNumber; endpointOut = out.endpointNumber; break; }
  }
  if (iface === null) throw new Error("No bulk OUT endpoint found on the selected USB device.");
  await device.claimInterface(iface);
  return { device, iface, endpointOut };
}

// Connect handle for the connect-first flow — call inside the user gesture.
export async function connectXprinter() {
  if (!isXprinterSupported()) throw new Error("WebUSB not available in this browser.");
  return await connect();
}

export async function printXprinter(labels, conn = null) {
  if (!isXprinterSupported()) return { ok: false, error: "WebUSB not available in this browser." };
  if (!ENCODER) return { ok: false, error: "TextEncoder unavailable." };
  let c = conn, device, iface;
  try {
    if (!c) c = await connect();
    device = c.device; iface = c.iface;
    const bytes = ENCODER.encode(tsplProgram(labels));
    await device.transferOut(c.endpointOut, bytes);
    return { ok: true, printed: labels.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { if (device && iface !== null && iface !== undefined) await device.releaseInterface(iface); } catch { /* ignore */ }
    try { device && await device.close(); } catch { /* ignore */ }
  }
}

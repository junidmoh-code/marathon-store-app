// ─── PRINTER TRANSPORT (facade) ───────────────────────────────────────────────
// Single entry point the print UI calls. Routes to a transport driver, isolates
// failures (drivers already return {ok,error}; this also guards against a throw),
// and expands per-size copy counts into one label entry per physical label.
//
// Transports:
//   phomemo  — Phomemo M110 via Web Bluetooth (proven; raster).
//   xprinter — Xprinter XP-350B via WebUSB (TSPL; UNPROVEN — tomorrow's test).
// A failed transport blocks nothing else: the value model, storage, reverse index
// and on-screen barcode all work regardless of whether a printer is reachable.

import { printPhomemo, connectPhomemo, isPhomemoSupported } from "./phomemo";
import { printXprinter, connectXprinter, isXprinterSupported } from "./xprinter";

export const TRANSPORTS = [
  { id: "phomemo",  label: "Phomemo M110 (Bluetooth)", proven: true,  supported: isPhomemoSupported },
  { id: "xprinter", label: "Xprinter XP-350B (USB)",   proven: false, supported: isXprinterSupported },
];

// items: [{ code, productName, size, count }] — count copies of each.
function expand(items) {
  const labels = [];
  for (const it of items || []) {
    const n = Math.max(0, Math.floor(Number(it.count) || 0));
    for (let i = 0; i < n; i++) labels.push({ code: it.code, productName: it.productName, size: it.size });
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
  const labels = expand(items);
  if (!labels.length) return { ok: false, error: "Nothing to print (all counts are 0)." };
  try {
    if (transport === "phomemo") return await printPhomemo(labels, conn);
    if (transport === "xprinter") return await printXprinter(labels, conn);
    return { ok: false, error: `Unknown transport "${transport}".` };
  } catch (err) {
    // Belt-and-suspenders — drivers already catch, but never let the flow break.
    return { ok: false, error: String(err?.message || err) };
  }
}

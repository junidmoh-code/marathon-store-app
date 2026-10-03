// ─── LABEL PRINTER STATUS (tiny store) ───────────────────────────────────────
// One shared answer to "which printer, which route, or why nothing": written by
// the USB driver and the print facade, read by the quiet indicator in the print
// screens. In-memory only — nothing here is persisted or sent anywhere.
//
// state:
//   "idle"     — nothing checked yet
//   "checking" — discovery running
//   "usb"      — a USB printer took a no-op write; labels go straight to it
//   "os"       — no USB device could be used; labels go to the system printer
//   "none"     — nothing reachable over USB, and no permitted device exists
// route:   "usb" | "os" | null — the route the NEXT print will take
// printed: "usb" | "os" | null — the route the LAST print actually took
// lines:   per-attempt failure lines (device · interface/endpoint · exception)

let status = { state: "idle", name: "", route: null, detail: "", lines: [], printed: null, at: null };
const listeners = new Set();

export function getPrinterStatus() { return status; }

export function setPrinterStatus(patch) {
  status = { ...status, ...patch, at: Date.now() };
  for (const fn of listeners) { try { fn(status); } catch { /* a listener never breaks printing */ } }
}

export function subscribePrinterStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The block a person can copy or photograph.
export function printerStatusText(s = status) {
  const head = s.state === "usb" ? `USB → ${s.name}${s.detail ? ` (${s.detail})` : ""}`
    : s.state === "os" ? `System print → the computer's default printer${s.detail ? ` (${s.detail})` : ""}`
    : s.state === "none" ? "No label printer reachable"
    : s.state === "checking" ? "Looking for a label printer…"
    : "Label printer not checked yet";
  return [head, ...(s.lines || [])].join("\n");
}

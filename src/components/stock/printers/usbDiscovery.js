// ─── WEBUSB DEVICE DISCOVERY + OPEN (pure, testable) ──────────────────────────
// Everything about GETTING TO a USB printer's bulk OUT endpoint, split out of
// xprinter.js so it can be unit-tested against fake USBDevice shapes. This module
// knows NOTHING about labels, TSPL or barcodes — it only finds an endpoint, claims
// it, and pushes bytes down it.
//
// WHY IT EXISTS: the old inline path assumed configuration 1, looked only at each
// interface's CURRENTLY-ACTIVE alternate, never called selectAlternateInterface,
// and claimed once with no retry. On macOS that produced "No bulk OUT endpoint
// found" on a perfectly good XP-350B. See docs/printer-usb-map.md.
//
// WHAT IT DOES INSTEAD:
//   • open → if there is no active configuration, select the FIRST available
//     configurationValue (macOS commonly reports none).
//   • search EVERY configuration → interface → alternate for direction "out" +
//     type "bulk". Nothing about interface 0 or endpoint 1 is assumed.
//   • prefer a printer-class (0x07) interface; fall back to any bulk OUT.
//   • claim, then selectAlternateInterface when the chosen alternate isn't 0
//     (WebUSB requires the claim FIRST — see the note on openUsbPrinter).
//   • one 300ms retry on claim: macOS can briefly hold the interface after replug.
//
// Every failure carries a `.diag` describing the device, so the caller can show it
// on screen — the machines that fail are remote and have no reachable console.

export const PRINTER_CLASS = 0x07;      // USB printer class (bInterfaceClass)
export const TX_CHUNK = 8192;           // transferOut chunk so big batches don't choke
export const CLAIM_RETRY_MS = 300;      // macOS interface-release grace period

export const NO_BULK_OUT =
  "No bulk OUT endpoint found on the selected USB device — is this the label printer?";

const hex4 = (n) => (typeof n === "number" ? "0x" + n.toString(16).padStart(4, "0") : String(n ?? ""));
const num = (v) => (typeof v === "number" ? v : null);
const str = (v) => (typeof v === "string" && v ? v : "");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every configuration the device declares. `configurations` is descriptor data and
// is readable whether or not one is active; fall back to the active one alone if a
// (non-Chrome / fake) device doesn't expose the list.
function allConfigurations(device) {
  const list = device?.configurations;
  if (Array.isArray(list) && list.length) return list;
  return device?.configuration ? [device.configuration] : [];
}

// Rank a candidate endpoint. Printer class dominates (the spec'd preference); an
// interface in the ALREADY-ACTIVE configuration breaks ties, so we avoid a
// needless selectConfiguration when both would work. Document order wins the rest.
function rank(candidate, activeConfigurationValue) {
  return (candidate.interfaceClass === PRINTER_CLASS ? 2 : 0)
       + (activeConfigurationValue != null && candidate.configurationValue === activeConfigurationValue ? 1 : 0);
}

// Search EVERY configuration, interface and alternate for a bulk OUT endpoint.
// Returns null when the device genuinely has none (→ the caller reports, not crashes).
export function findBulkOut(device) {
  const activeValue = device?.configuration?.configurationValue ?? null;
  let best = null, bestRank = -1;
  for (const cfg of allConfigurations(device)) {
    for (const intf of cfg?.interfaces || []) {
      for (const alt of intf?.alternates || []) {
        const out = (alt?.endpoints || []).find((e) => e?.direction === "out" && e?.type === "bulk");
        if (!out) continue;
        const candidate = {
          configurationValue: num(cfg.configurationValue) ?? 1,
          interfaceNumber: num(intf.interfaceNumber) ?? 0,
          alternateSetting: num(alt.alternateSetting) ?? 0,
          endpointNumber: num(out.endpointNumber) ?? 0,
          interfaceClass: num(alt.interfaceClass),
        };
        const r = rank(candidate, activeValue);
        if (r > bestRank) { best = candidate; bestRank = r; }   // strict > keeps the FIRST of equals
      }
    }
  }
  return best;
}

// Full structured description of the device — the raw material for the on-screen
// diagnostic. All values are null/""-normalised (never undefined) so the caller can
// hand it straight to Firebase set() without an undefined blowing the write up.
export function describeUsbDevice(device, { hadActiveConfiguration = null, chosen = null, at = null } = {}) {
  return {
    at: at ?? null,
    productName: str(device?.productName),
    manufacturerName: str(device?.manufacturerName),
    serialNumber: str(device?.serialNumber),
    vendorId: hex4(device?.vendorId),
    productId: hex4(device?.productId),
    deviceClass: num(device?.deviceClass),
    deviceSubclass: num(device?.deviceSubclass),
    deviceProtocol: num(device?.deviceProtocol),
    hadActiveConfiguration,
    activeConfigurationValue: num(device?.configuration?.configurationValue),
    configurations: allConfigurations(device).map((cfg) => ({
      configurationValue: num(cfg?.configurationValue),
      interfaces: (cfg?.interfaces || []).map((intf) => ({
        number: num(intf?.interfaceNumber),
        alternates: (intf?.alternates || []).map((alt) => ({
          alternateSetting: num(alt?.alternateSetting),
          interfaceClass: num(alt?.interfaceClass),
          interfaceSubclass: num(alt?.interfaceSubclass),
          interfaceProtocol: num(alt?.interfaceProtocol),
          endpoints: (alt?.endpoints || []).map((e) => ({
            direction: str(e?.direction),
            type: str(e?.type),
            number: num(e?.endpointNumber),
          })),
        })),
      })),
    })),
    chosen: chosen ?? null,
  };
}

// Flatten a diagnostic into a block of plain text that can be READ OFF A PHOTO of
// the screen or copied out of the app. This is the only channel we have to the
// machines that fail — they are remote and their console is not reachable.
export function formatUsbDiagnostics(diag, error = null) {
  if (!diag) return error ? `error: ${error}` : "no device information captured";
  const cls = (n) => (typeof n === "number" ? n : "?");
  const out = [];
  out.push(`${diag.productName || "(no product name)"} — ${diag.manufacturerName || "(no manufacturer)"} ${diag.vendorId}/${diag.productId}`);
  out.push(`device class ${cls(diag.deviceClass)}/${cls(diag.deviceSubclass)}/${cls(diag.deviceProtocol)}${diag.serialNumber ? ` · serial ${diag.serialNumber}` : ""}`);
  out.push(`configuration active before selection: ${diag.hadActiveConfiguration === null ? "unknown" : diag.hadActiveConfiguration ? "yes" : "NO"} · active now: ${diag.activeConfigurationValue ?? "none"}`);
  for (const cfg of diag.configurations || []) {
    out.push(`config ${cfg.configurationValue ?? "?"}:`);
    if (!(cfg.interfaces || []).length) out.push("  (no interfaces)");
    for (const intf of cfg.interfaces || []) {
      for (const alt of intf.alternates || []) {
        const eps = (alt.endpoints || []).map((e) => `${e.direction}/${e.type}/${e.number}`).join(", ") || "no endpoints";
        out.push(`  interface ${intf.number ?? "?"} alt ${alt.alternateSetting ?? "?"} class ${cls(alt.interfaceClass)}/${cls(alt.interfaceSubclass)}/${cls(alt.interfaceProtocol)}: ${eps}`);
      }
      if (!(intf.alternates || []).length) out.push(`  interface ${intf.number ?? "?"}: (no alternates)`);
    }
  }
  out.push(diag.chosen
    ? `chosen: config ${diag.chosen.configurationValue} · interface ${diag.chosen.interfaceNumber} · alt ${diag.chosen.alternateSetting} · bulk OUT endpoint ${diag.chosen.endpointNumber} (class ${cls(diag.chosen.interfaceClass)})`
    : "chosen: NONE — no bulk OUT endpoint anywhere on this device");
  if (diag.at) out.push(`at ${diag.at}`);
  if (error) out.push(`error: ${error}`);
  return out.join("\n");
}

function fail(message, diag) {
  const err = new Error(message);
  err.diag = diag;
  return err;
}

// Open the device and claim an interface with a bulk OUT endpoint.
//
// ORDER NOTE: the brief said "selectAlternateInterface … then claimInterface", but
// WebUSB rejects selectAlternateInterface with InvalidStateError on an unclaimed
// interface, so the claim MUST come first. Same two calls, spec-mandated order.
export async function openUsbPrinter(device, { sleep = wait, claimRetryMs = CLAIM_RETRY_MS, at = null } = {}) {
  if (!device.opened) await device.open();

  // macOS commonly reports NO active configuration — on its own that made the old
  // path find nothing. Use the first configurationValue the device declares rather
  // than assuming 1.
  const hadActiveConfiguration = device.configuration != null;
  if (!hadActiveConfiguration) {
    const first = allConfigurations(device)[0]?.configurationValue;
    await device.selectConfiguration(typeof first === "number" ? first : 1);
  }

  const chosen = findBulkOut(device);
  const diag = describeUsbDevice(device, { hadActiveConfiguration, chosen, at });
  if (!chosen) throw fail(NO_BULK_OUT, diag);

  // The winner may live in a configuration that isn't the active one.
  if (device.configuration?.configurationValue !== chosen.configurationValue) {
    await device.selectConfiguration(chosen.configurationValue);
  }

  try {
    await device.claimInterface(chosen.interfaceNumber);
  } catch (first) {
    // macOS can hold the interface for a moment after a replug / driver teardown.
    await sleep(claimRetryMs);
    try {
      await device.claimInterface(chosen.interfaceNumber);
    } catch (e) {
      const msg = String(e?.message || e);
      const inUse = /in use|claim|access|denied|busy/i.test(msg);
      throw fail(
        `Couldn't claim the printer${inUse ? " — the interface is in use" : ""} (${msg}). ` +
        `On macOS the system usually owns the printer: remove it from System Settings ▸ Printers & Scanners ` +
        `(and quit any app using it), then retry.`,
        diag
      );
    }
  }

  // Only alternate 0 is active by default; anything else has to be selected.
  if (chosen.alternateSetting !== 0) {
    await device.selectAlternateInterface(chosen.interfaceNumber, chosen.alternateSetting);
  }

  return {
    device,
    configurationValue: chosen.configurationValue,
    interfaceNumber: chosen.interfaceNumber,
    alternateSetting: chosen.alternateSetting,
    endpointNumber: chosen.endpointNumber,
    diag,
  };
}

// What a non-"ok" transferOut status actually means, so the operator isn't staring
// at a bare word. A "stall" in particular is the printer rejecting the endpoint —
// it is NOT a delivery success and must never be reported as one.
const STATUS_HINT = {
  stall: "the printer halted the endpoint (wrong endpoint, or it rejected the data)",
  babble: "the printer sent back more data than the endpoint allows",
};

// Push bytes down the endpoint that was ACTUALLY discovered. Returns the number of
// bytes the device acknowledged. Every chunk's status is checked — a partial or
// stalled write raises rather than counting as printed.
export async function sendBulk(device, endpointNumber, bytes, chunkSize = TX_CHUNK) {
  let sent = 0;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    const res = await device.transferOut(endpointNumber, chunk);
    const status = res?.status;
    if (status !== "ok") {
      const hint = STATUS_HINT[status];
      throw new Error(
        `USB transfer returned "${status || "no status"}" on endpoint ${endpointNumber}` +
        `${hint ? ` — ${hint}` : ""} (${sent} of ${bytes.length} bytes sent).`
      );
    }
    sent += typeof res?.bytesWritten === "number" ? res.bytesWritten : chunk.length;
  }
  return sent;
}

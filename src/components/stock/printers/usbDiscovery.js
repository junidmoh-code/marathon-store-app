// ─── WEBUSB DEVICE DISCOVERY + OPEN (pure, testable) ──────────────────────────
// Everything about GETTING TO a USB printer's bulk OUT endpoint, split out of
// xprinter.js so it can be unit-tested against fake USBDevice shapes. This module
// knows NOTHING about labels, TSPL or barcodes — it only finds an endpoint, claims
// it, and pushes bytes down it.
//
// WHY IT EXISTS: the old inline path assumed configuration 1, looked only at each
// interface's CURRENTLY-ACTIVE alternate, never called selectAlternateInterface,
// and claimed once with no retry. On macOS that produced "No bulk OUT endpoint
// found" on a perfectly good XP-350B.
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

// ── WHICH STEP THREW, AND WHAT THE BROWSER ACTUALLY SAID ─────────────────────
// Chrome's WebUSB rejections are DOMExceptions whose NAME is the whole diagnosis:
// "NetworkError: Unable to claim interface" (something else owns it) is a
// completely different problem from "SecurityError" (permission) or
// "NotFoundError" (wrong configuration value). The name is lost the moment
// anything does String(err.message), which every catch in the print flow does —
// so we fold BOTH the step and the raw "Name: message" into the message text
// itself, and keep them as fields for the structured diagnostic.

export const STEPS = ["open", "selectConfiguration", "claimInterface", "selectAlternateInterface", "transferOut", "noopWrite", "reset"];

const rawName = (e) => str(e?.name) || (e instanceof Error ? "Error" : "");
const rawMessage = (e) => str(e?.message) || String(e ?? "");
const rawLabel = (e) => { const n = rawName(e), m = rawMessage(e); return n && m ? `${n}: ${m}` : (n || m || "unknown error"); };

// The failure record that rides on the error and into the on-screen block.
export function failureOf(err) {
  if (!err) return null;
  if (err.usbFailure) return err.usbFailure;
  return { step: str(err.step) || "", name: rawName(err), message: rawMessage(err) };
}

// Run one WebUSB call, tagging any rejection with the step that produced it.
async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.usbFailure) throw e;                      // already tagged — don't double-wrap
    const err = new Error(`${name} failed — ${rawLabel(e)}`);
    err.step = name;
    err.usbFailure = { step: name, name: rawName(e), message: rawMessage(e) };
    err.cause = e;
    throw err;
  }
}

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

// Search EVERY configuration, interface and alternate for a bulk OUT endpoint and
// return ALL of them, best first. A device can expose more than one (a printer
// interface plus a vendor-specific one, or the same interface on two alternates);
// if the best one can't be claimed the caller tries the next before giving up on
// the device. Empty when the device genuinely has none.
export function findBulkOutCandidates(device) {
  const activeValue = device?.configuration?.configurationValue ?? null;
  const found = [];
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
        found.push({ candidate, r: rank(candidate, activeValue), i: found.length });
      }
    }
  }
  // Highest rank first; document order breaks ties (so the FIRST of equals wins).
  return found.sort((a, b) => (b.r - a.r) || (a.i - b.i)).map((f) => f.candidate);
}

// The single best candidate, or null when the device has no bulk OUT at all.
export function findBulkOut(device) {
  return findBulkOutCandidates(device)[0] || null;
}

// Full structured description of the device — the raw material for the on-screen
// diagnostic. All values are null/""-normalised (never undefined) so the caller can
// hand it straight to Firebase set() without an undefined blowing the write up.
export function describeUsbDevice(device, { hadActiveConfiguration = null, chosen = null, at = null, failure = null } = {}) {
  return {
    at: at ?? null,
    failure: failure ?? null,
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
// `error` may be an Error (preferred — its step and DOMException name survive) or
// a plain string.
export function formatUsbDiagnostics(diag, error = null) {
  const isErr = error && typeof error === "object";
  const failure = (isErr ? failureOf(error) : null) || diag?.failure || null;
  const errorText = error == null ? null : (isErr ? rawMessage(error) : String(error));
  const failureLines = [];
  if (failure?.step) failureLines.push(`failed step: ${failure.step}`);
  // The browser's own words, unwrapped — "NetworkError: Unable to claim interface"
  // says something a rewritten message cannot.
  if (failure?.name || failure?.message) {
    failureLines.push(`raw error: ${failure.name && failure.message ? `${failure.name}: ${failure.message}` : (failure.name || failure.message)}`);
  }
  if (!diag) return [...failureLines, errorText ? `error: ${errorText}` : null].filter(Boolean).join("\n") || "no device information captured";
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
  out.push(...failureLines);
  if (errorText) out.push(`error: ${errorText}`);
  return out.join("\n");
}

function fail(message, diag, failure = null) {
  const err = new Error(message);
  err.diag = diag;
  if (failure) { err.step = failure.step; err.usbFailure = failure; }
  return err;
}

// Open the device and claim an interface with a bulk OUT endpoint.
//
// ORDER NOTE: the brief said "selectAlternateInterface … then claimInterface", but
// WebUSB rejects selectAlternateInterface with InvalidStateError on an unclaimed
// interface, so the claim MUST come first. Same two calls, spec-mandated order.
//
// Every rejection leaves here tagged with the STEP that produced it and the
// browser's own DOMException name — that pair is the whole diagnosis on a machine
// we cannot open a console on.
//
// `candidate` (from findBulkOutCandidates) pins WHICH endpoint to claim; without
// it the best one is chosen after the configuration is settled.
export async function openUsbPrinter(device, { sleep = wait, claimRetryMs = CLAIM_RETRY_MS, at = null, candidate = null } = {}) {
  // Captured as we go so a failure at ANY step still describes the device.
  let hadActiveConfiguration = null, chosen = null;
  const snapshot = (failure) => describeUsbDevice(device, { hadActiveConfiguration, chosen, at, failure });

  try {
    if (!device.opened) await step("open", () => device.open());

    // macOS commonly reports NO active configuration — on its own that made the old
    // path find nothing. Use the first configurationValue the device declares rather
    // than assuming 1.
    hadActiveConfiguration = device.configuration != null;
    if (!hadActiveConfiguration) {
      const first = allConfigurations(device)[0]?.configurationValue;
      await step("selectConfiguration", () => device.selectConfiguration(typeof first === "number" ? first : 1));
    }

    chosen = candidate || findBulkOut(device);
    if (!chosen) {
      const failure = { step: "discovery", name: "", message: NO_BULK_OUT };
      throw fail(NO_BULK_OUT, snapshot(failure), failure);
    }

    // The winner may live in a configuration that isn't the active one. Select the
    // configuration that CONTAINS the chosen interface, whichever one that is.
    if (device.configuration?.configurationValue !== chosen.configurationValue) {
      await step("selectConfiguration", () => device.selectConfiguration(chosen.configurationValue));
    }

    try {
      await step("claimInterface", () => device.claimInterface(chosen.interfaceNumber));
    } catch {
      // macOS can hold the interface for a moment after a replug / driver teardown.
      await sleep(claimRetryMs);
      try {
        await step("claimInterface", () => device.claimInterface(chosen.interfaceNumber));
      } catch (e) {
        const failure = failureOf(e);
        const inUse = /in use|claim|access|denied|busy|NetworkError/i.test(`${failure.name} ${failure.message}`);
        throw fail(
          `Couldn't claim the printer${inUse ? " — the interface is in use, most likely by the computer's own print system" : ""} ` +
          `(${failure.name}: ${failure.message}). Labels go through system printing instead.`,
          snapshot(failure), failure
        );
      }
    }

    // Only alternate 0 is active by default; anything else has to be selected.
    if (chosen.alternateSetting !== 0) {
      await step("selectAlternateInterface", () => device.selectAlternateInterface(chosen.interfaceNumber, chosen.alternateSetting));
    }
  } catch (e) {
    if (!e.diag) e.diag = snapshot(failureOf(e));    // fail() already attached one
    throw e;
  }

  return {
    device,
    configurationValue: chosen.configurationValue,
    interfaceNumber: chosen.interfaceNumber,
    alternateSetting: chosen.alternateSetting,
    endpointNumber: chosen.endpointNumber,
    diag: snapshot(null),     // the map as it stands on a good connection
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
// stalled write raises rather than counting as printed. A raised error carries
// `sentBytes` (bytes that reached the printer before it failed), so a caller can
// tell "nothing went out" from "part of this label went out".
export async function sendBulk(device, endpointNumber, bytes, chunkSize = TX_CHUNK) {
  let sent = 0;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    // A rejection here (NetworkError, InvalidStateError…) is tagged "transferOut".
    let res;
    try {
      res = await step("transferOut", () => device.transferOut(endpointNumber, chunk));
    } catch (e) {
      e.sentBytes = sent;
      throw e;
    }
    const status = res?.status;
    if (status !== "ok") {
      if (typeof res?.bytesWritten === "number") sent += res.bytesWritten;
      const hint = STATUS_HINT[status];
      const err = new Error(
        `USB transfer returned "${status || "no status"}" on endpoint ${endpointNumber}` +
        `${hint ? ` — ${hint}` : ""} (${sent} of ${bytes.length} bytes sent).`
      );
      err.step = "transferOut";
      err.usbFailure = { step: "transferOut", name: `status ${status || "none"}`, message: hint || "non-ok transfer status" };
      err.sentBytes = sent;
      throw err;
    }
    sent += typeof res?.bytesWritten === "number" ? res.bytesWritten : chunk.length;
  }
  return sent;
}

// ─── EVERY PERMITTED DEVICE, EVERY ENDPOINT ──────────────────────────────────
// The print path used to try exactly ONE device — the cached one, else the first
// printer-looking one from getDevices(), else getDevices()[0] — and stop at its
// first error. A mouse, a scanner or a since-replaced printer that the site was
// once allowed to see could therefore be "the" device, and that alone yields
// "No bulk OUT endpoint found". Here every permitted device is tried in turn,
// every bulk OUT endpoint on it is tried in turn, and the first one that takes a
// no-op write wins.

const ZERO_BYTES = new Uint8Array(0);

// Identity used to remember the last device that worked (no live handles).
export function deviceKey(device) {
  return {
    vendorId: num(device?.vendorId),
    productId: num(device?.productId),
    serialNumber: str(device?.serialNumber),
  };
}

// 2 = same VID/PID/serial, 1 = same VID/PID (serial unknown on either side), 0 = no.
export function deviceMatch(device, key) {
  if (!key || key.vendorId == null || key.productId == null) return 0;
  if (num(device?.vendorId) !== key.vendorId || num(device?.productId) !== key.productId) return 0;
  const a = str(device?.serialNumber), b = str(key.serialNumber);
  if (a && b) return a === b ? 2 : 0;
  return 1;
}

export function isPrinterLike(device) {
  for (const cfg of allConfigurations(device)) {
    for (const intf of cfg?.interfaces || []) {
      for (const alt of intf?.alternates || []) {
        if (alt?.interfaceClass === PRINTER_CLASS) return true;
      }
    }
  }
  return false;
}

// Try order: the remembered device (exact serial before VID/PID-only), then
// anything with a printer-class interface, then everything else. Stable.
export function orderDevices(devices, remembered = null) {
  return (devices || [])
    .map((d, i) => ({ d, i, m: deviceMatch(d, remembered), p: isPrinterLike(d) ? 1 : 0 }))
    .sort((a, b) => (b.m - a.m) || (b.p - a.p) || (a.i - b.i))
    .map((x) => x.d);
}

// "XP-350B (Xprinter 0x0483/0x5743 · serial 1234)" — how a device is named on screen.
export function deviceLabel(device) {
  const name = str(device?.productName) || "unnamed USB device";
  const maker = str(device?.manufacturerName);
  const serial = str(device?.serialNumber);
  return `${name} (${maker ? maker + " " : ""}${hex4(device?.vendorId)}/${hex4(device?.productId)}${serial ? ` · serial ${serial}` : ""})`;
}

// A claim the OS (or another app) is holding — on macOS that is the print system.
export function isHeldElsewhere(failure) {
  if (!failure || failure.step !== "claimInterface") return false;
  return /NetworkError|in use|busy|access|denied|unable to claim/i.test(`${failure.name} ${failure.message}`);
}

// One attempt = one device × one endpoint × one round, with the exact exception.
function attemptOf(device, candidate, err, round) {
  const f = failureOf(err) || { step: "", name: "", message: String(err) };
  return {
    device: deviceLabel(device),
    configurationValue: candidate?.configurationValue ?? null,
    interfaceNumber: candidate?.interfaceNumber ?? null,
    alternateSetting: candidate?.alternateSetting ?? null,
    endpointNumber: candidate?.endpointNumber ?? null,
    round,
    step: f.step || "",
    name: f.name || "",
    message: f.message || "",
    heldElsewhere: isHeldElsewhere(f),
  };
}

// One line per attempt — readable off a photo of the screen.
export function formatAttempt(a) {
  const where = a.interfaceNumber == null
    ? "no bulk OUT endpoint"
    : `config ${a.configurationValue} · interface ${a.interfaceNumber} · alt ${a.alternateSetting} · OUT endpoint ${a.endpointNumber}`;
  const raw = a.name && a.message ? `${a.name}: ${a.message}` : (a.name || a.message || "unknown error");
  return `${a.device} · ${where} · ${a.step || "?"} → ${raw}${a.round === "after reset" ? " (after reset)" : ""}`;
}

// A zero-length bulk write: proves the endpoint accepts data without printing.
async function noopWrite(device, endpointNumber) {
  const res = await step("noopWrite", () => device.transferOut(endpointNumber, ZERO_BYTES));
  if (res && res.status && res.status !== "ok") {
    const err = new Error(`noopWrite returned "${res.status}" on endpoint ${endpointNumber}`);
    err.step = "noopWrite";
    err.usbFailure = { step: "noopWrite", name: `status ${res.status}`, message: STATUS_HINT[res.status] || "non-ok transfer status" };
    throw err;
  }
}

// Open → configure → claim → no-op write, over every bulk OUT candidate on ONE
// device. If none works: reset() and one more pass. Never throws.
export async function probeUsbDevice(device, opts = {}) {
  const attempts = [];
  const pass = async (round) => {
    const candidates = findBulkOutCandidates(device);
    // No candidate visible in the descriptors yet → let openUsbPrinter open the
    // device, settle a configuration and look again (it reports NO_BULK_OUT).
    for (const candidate of candidates.length ? candidates : [null]) {
      try {
        const conn = await openUsbPrinter(device, { ...opts, candidate });
        await noopWrite(device, conn.endpointNumber);
        return conn;
      } catch (e) {
        attempts.push(attemptOf(device, candidate || e?.diag?.chosen || null, e, round));
        if (candidate) { try { await device.releaseInterface?.(candidate.interfaceNumber); } catch { /* not claimed */ } }
      }
    }
    return null;
  };

  let conn = await pass("first");
  if (conn) return { ok: true, conn, attempts };
  // A device with no bulk OUT anywhere will not grow one after a reset. And a
  // device another program holds (on macOS: the print system, possibly mid-job)
  // is NOT reset — that could cut its job short; the OS print route covers it.
  if (!attempts.every((a) => a.step === "discovery" || a.heldElsewhere)) {
    try {
      await step("reset", () => device.reset());
      conn = await pass("after reset");
      if (conn) return { ok: true, conn, attempts };
    } catch (e) {
      attempts.push(attemptOf(device, null, e, "after reset"));
    }
  }
  // Let go, so whatever else wants the device (the OS print route) can have it.
  try { if (device.opened) await device.close(); } catch { /* best effort */ }
  return { ok: false, conn: null, attempts };
}

// Every permitted device, in try order; the first that takes a no-op write wins.
// `preferred` (a live USBDevice already known to work) goes first of all.
export async function discoverUsbPrinter(usb, { remembered = null, preferred = null, ...opts } = {}) {
  const devices = usb ? await usb.getDevices() : [];
  let ordered = orderDevices(devices, remembered);
  if (preferred && ordered.includes(preferred)) ordered = [preferred, ...ordered.filter((d) => d !== preferred)];
  const attempts = [];
  for (const device of ordered) {
    const r = await probeUsbDevice(device, opts);
    attempts.push(...r.attempts);
    if (r.ok) return { ok: true, device, conn: r.conn, attempts, devicesSeen: devices.length };
  }
  return { ok: false, device: null, conn: null, attempts, devicesSeen: devices.length };
}

// ─── WHICH LANGUAGE DOES IT SPEAK? ───────────────────────────────────────────
// USB printer-class GET_DEVICE_ID returns the IEEE 1284 id string, e.g.
// "MFG:Xprinter;CMD:TSPL,ESC/POS;MDL:XP-350B;". CMD names the command sets.
// TSPL wins when listed (label printers that speak both print labels best in
// TSPL); ESC/POS only when it is the only one; null when unknown.
export function commandLanguageFrom1284(idString) {
  const m = /(?:^|;)\s*(?:CMD|COMMAND SET)\s*:([^;]*)/i.exec(String(idString || ""));
  if (!m) return null;
  const cmd = m[1].toUpperCase();
  if (/TSPL|TSC/.test(cmd)) return "tspl";
  if (/ESC\s*\/?\s*POS|ESCPOS/.test(cmd)) return "escpos";
  return null;
}

// Read the 1284 id over the claimed interface. Never throws — null when the
// device doesn't answer (plenty don't).
export async function readIeee1284Id(device, conn) {
  // The printer-class spec puts the interface in wIndex's HIGH byte and the
  // alternate in the low byte; Chrome checks the LOW byte is a claimed interface.
  // Both agree for interface 0 / alt 0. Otherwise try the spec form, then the
  // interface number alone.
  const spec = ((conn.interfaceNumber & 0xff) << 8) | (conn.alternateSetting & 0xff);
  for (const index of [...new Set([spec, conn.interfaceNumber])]) {
    try {
      const res = await device.controlTransferIn({ requestType: "class", recipient: "interface", request: 0, value: 0, index }, 1024);
      const view = res?.data;
      if (res?.status !== "ok" || !view || view.byteLength < 3) continue;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return new TextDecoder().decode(bytes.slice(2)).replace(/\0+$/, "");   // first 2 bytes = length
    } catch { /* try the other form */ }
  }
  return null;
}

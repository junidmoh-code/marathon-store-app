import { describe, it, expect, vi } from "vitest";
import {
  findBulkOut, describeUsbDevice, formatUsbDiagnostics, openUsbPrinter, sendBulk, failureOf, NO_BULK_OUT,
} from "./usbDiscovery";

// ─── FAKE USBDevice SHAPES ────────────────────────────────────────────────────
// Every shape here is one the XP-350B (or a device sat next to it) can genuinely
// present on macOS. The old inline path saw only the ACTIVE alternate of the
// ACTIVE configuration, which is why several of these produced "No bulk OUT
// endpoint found" on a working printer.

const ep = (direction, type, endpointNumber) => ({ direction, type, endpointNumber });
const alt = (alternateSetting, interfaceClass, endpoints) =>
  ({ alternateSetting, interfaceClass, interfaceSubclass: 1, interfaceProtocol: 2, endpoints });
const iface = (interfaceNumber, alternates) => ({ interfaceNumber, alternates });
const cfg = (configurationValue, interfaces) => ({ configurationValue, interfaces });

// A DOMException as Chrome actually throws it: the NAME is the diagnosis.
const domError = (name, message) => Object.assign(new Error(message), { name });

// activeValue: the configurationValue reported as active, or null for "macOS gave
// us no active configuration" (the common case on the failing iMac).
// throwOn: { open|selectConfiguration|claimInterface|selectAlternateInterface: Error }
function fakeDevice({ configurations, activeValue = null, claimFailures = 0, opened = false, throwOn = {} }) {
  let claimAttempts = 0;
  const dev = {
    productName: "XP-350B", manufacturerName: "Xprinter", serialNumber: "SN123",
    vendorId: 0x1234, productId: 0x5678,
    deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    opened,
    configurations,
    configuration: activeValue == null ? null : configurations.find(c => c.configurationValue === activeValue) || null,
    calls: [],
    claimAttempts: () => claimAttempts,
    async open() { dev.calls.push(["open"]); if (throwOn.open) throw throwOn.open; dev.opened = true; },
    async selectConfiguration(v) {
      dev.calls.push(["selectConfiguration", v]);
      if (throwOn.selectConfiguration) throw throwOn.selectConfiguration;
      const found = configurations.find(c => c.configurationValue === v);
      // Chrome rejects an unsupported configuration value with NotFoundError —
      // the fake must too, or "just try 1" looks like it works.
      if (!found) throw domError("NotFoundError", "The configuration value provided is not supported by the device.");
      dev.configuration = found;
    },
    async claimInterface(n) {
      dev.calls.push(["claimInterface", n]);
      if (throwOn.claimInterface) throw throwOn.claimInterface;
      if (claimAttempts++ < claimFailures) throw domError("NetworkError", "Unable to claim interface.");
    },
    async selectAlternateInterface(i, a) {
      dev.calls.push(["selectAlternateInterface", i, a]);
      if (throwOn.selectAlternateInterface) throw throwOn.selectAlternateInterface;
    },
  };
  return dev;
}

const noSleep = async () => {};
const callNames = (dev) => dev.calls.map(c => c[0]);

describe("findBulkOut — searches every configuration, interface and alternate", () => {
  it("finds a bulk OUT on interface 1 alternate 0 (interface 0 is not assumed)", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])]),          // HID-ish, no bulk OUT
        iface(1, [alt(0, 0x07, [ep("in", "bulk", 2), ep("out", "bulk", 3)])]),
      ])],
    });
    expect(findBulkOut(device)).toEqual({
      configurationValue: 1, interfaceNumber: 1, alternateSetting: 0, endpointNumber: 3, interfaceClass: 0x07,
    });
  });

  it("finds a bulk OUT that only exists on a NON-ZERO alternate", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [
          alt(0, 0x07, []),                                            // active alternate: nothing
          alt(1, 0x07, [ep("out", "bulk", 2)]),                        // the real one
        ]),
      ])],
    });
    expect(findBulkOut(device)).toMatchObject({ interfaceNumber: 0, alternateSetting: 1, endpointNumber: 2 });
  });

  it("prefers the printer-class interface when a vendor-specific one also has a bulk OUT", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [alt(0, 0xff, [ep("out", "bulk", 1)])]),              // vendor-specific, listed FIRST
        iface(2, [alt(0, 0x07, [ep("out", "bulk", 4)])]),              // printer class
      ])],
    });
    expect(findBulkOut(device)).toMatchObject({ interfaceNumber: 2, endpointNumber: 4, interfaceClass: 0x07 });
  });

  it("falls back to a vendor-specific interface when no printer-class one has a bulk OUT", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [alt(0, 0x07, [ep("in", "bulk", 1)])]),               // printer class but IN only
        iface(1, [alt(0, 0xff, [ep("out", "bulk", 2)])]),
      ])],
    });
    expect(findBulkOut(device)).toMatchObject({ interfaceNumber: 1, endpointNumber: 2, interfaceClass: 0xff });
  });

  it("looks in configurations other than the active one", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [
        cfg(1, [iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])])]),
        cfg(2, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])]),
      ],
    });
    expect(findBulkOut(device)).toMatchObject({ configurationValue: 2, endpointNumber: 1 });
  });

  it("prefers the ALREADY-ACTIVE configuration when both candidates rank the same", () => {
    const device = fakeDevice({
      activeValue: 2,
      configurations: [
        cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])]),
        cfg(2, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 5)])])]),
      ],
    });
    expect(findBulkOut(device)).toMatchObject({ configurationValue: 2, endpointNumber: 5 });
  });

  it("returns null — not a throw — when the device has no bulk OUT anywhere", () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])])])],
    });
    expect(findBulkOut(device)).toBeNull();
  });
});

describe("openUsbPrinter — open, configure, claim, select alternate", () => {
  it("selects the FIRST declared configurationValue when macOS reports no active configuration", async () => {
    // configurationValue 2, deliberately not 1 — the old path hardcoded 1.
    const device = fakeDevice({
      activeValue: null,
      configurations: [cfg(2, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])],
    });
    const conn = await openUsbPrinter(device, { sleep: noSleep });
    // Not "try 1 and hope": the FIRST configuration call must already be the right one.
    expect(device.calls.filter(c => c[0] === "selectConfiguration")).toEqual([["selectConfiguration", 2]]);
    expect(conn).toMatchObject({ configurationValue: 2, interfaceNumber: 0, endpointNumber: 1 });
    expect(conn.diag.hadActiveConfiguration).toBe(false);
  });

  it("opens a device that isn't open yet, and doesn't re-open one that is", async () => {
    const configurations = [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])];
    const closed = fakeDevice({ activeValue: 1, configurations });
    await openUsbPrinter(closed, { sleep: noSleep });
    expect(callNames(closed)).toContain("open");

    const already = fakeDevice({ activeValue: 1, configurations, opened: true });
    await openUsbPrinter(already, { sleep: noSleep });
    expect(callNames(already)).not.toContain("open");
  });

  it("claims the discovered interface and reports its endpoint, not interface 0 / endpoint 1", async () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])]),
        iface(1, [alt(0, 0x07, [ep("out", "bulk", 3)])]),
      ])],
    });
    const conn = await openUsbPrinter(device, { sleep: noSleep });
    expect(device.calls).toContainEqual(["claimInterface", 1]);
    expect(conn.endpointNumber).toBe(3);
  });

  it("selects a non-zero alternate AFTER claiming it (WebUSB rejects it before)", async () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [iface(0, [alt(0, 0x07, []), alt(1, 0x07, [ep("out", "bulk", 2)])])])],
    });
    await openUsbPrinter(device, { sleep: noSleep });
    const names = callNames(device);
    expect(device.calls).toContainEqual(["selectAlternateInterface", 0, 1]);
    expect(names.indexOf("claimInterface")).toBeLessThan(names.indexOf("selectAlternateInterface"));
  });

  it("does NOT call selectAlternateInterface for alternate 0", async () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])],
    });
    await openUsbPrinter(device, { sleep: noSleep });
    expect(callNames(device)).not.toContain("selectAlternateInterface");
  });

  // The configuration that gets selected must be the one CONTAINING the chosen
  // interface — "the first one declared" is not good enough, and a claim against
  // the wrong configuration is exactly the failure mode we are fixing.
  it("selects the configuration CONTAINING the chosen interface, not merely the first declared", async () => {
    const device = fakeDevice({
      activeValue: null,                                        // macOS: nothing active
      configurations: [
        // First declared — value 3, and it has NO bulk OUT at all.
        cfg(3, [iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])])]),
        // The real printer lives here: a different configurationValue entirely.
        cfg(7, [iface(2, [alt(0, 0x07, [ep("in", "bulk", 1), ep("out", "bulk", 4)])])]),
      ],
    });
    const conn = await openUsbPrinter(device, { sleep: noSleep });

    const configCalls = device.calls.filter(c => c[0] === "selectConfiguration").map(c => c[1]);
    // Whatever it probes on the way, the configuration it ENDS on is 7 — the one
    // holding interface 2 — and it is left active on the device.
    expect(configCalls[configCalls.length - 1]).toBe(7);
    expect(device.configuration.configurationValue).toBe(7);
    expect(conn).toMatchObject({ configurationValue: 7, interfaceNumber: 2, alternateSetting: 0, endpointNumber: 4 });

    // ...and the claim happened AFTER that configuration was made active, so it
    // claimed an interface that actually exists in the live configuration.
    const claimAt = device.calls.findIndex(c => c[0] === "claimInterface");
    const cfg7At = device.calls.findIndex(c => c[0] === "selectConfiguration" && c[1] === 7);
    expect(claimAt).toBeGreaterThan(cfg7At);
    expect(device.calls[claimAt][1]).toBe(2);
    expect(device.claimAttempts()).toBe(1);                     // claim succeeded first try
  });

  it("switches configuration when the winning endpoint lives in another one", async () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [
        cfg(1, [iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])])]),
        cfg(2, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])]),
      ],
    });
    const conn = await openUsbPrinter(device, { sleep: noSleep });
    expect(device.calls).toContainEqual(["selectConfiguration", 2]);
    expect(conn.configurationValue).toBe(2);
  });

  it("retries claimInterface once after a wait — macOS briefly holds it after a replug", async () => {
    const device = fakeDevice({
      activeValue: 1, claimFailures: 1,
      configurations: [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])],
    });
    const sleep = vi.fn(async () => {});
    const conn = await openUsbPrinter(device, { sleep });
    expect(device.claimAttempts()).toBe(2);
    expect(sleep).toHaveBeenCalledWith(300);
    expect(conn.endpointNumber).toBe(1);
  });

  it("gives up after the second claim failure, with the macOS hint and the diagnostic attached", async () => {
    const device = fakeDevice({
      activeValue: 1, claimFailures: 2,
      configurations: [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])],
    });
    const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
    expect(device.claimAttempts()).toBe(2);
    expect(err.message).toMatch(/in use/);
    expect(err.message).toMatch(/Printers & Scanners/);
    expect(err.diag.productId).toBe("0x5678");
  });

  it("a device with NO bulk OUT produces the diagnostic, not a crash", async () => {
    const device = fakeDevice({
      activeValue: 1,
      configurations: [cfg(1, [
        iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])]),
        iface(1, [alt(0, 0xff, [ep("in", "bulk", 2)])]),
      ])],
    });
    const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
    expect(err.message).toBe(NO_BULK_OUT);
    expect(err.diag.chosen).toBeNull();
    expect(callNames(device)).not.toContain("claimInterface");     // nothing to claim
    // The map still names every endpoint, so the failure is diagnosable remotely.
    const text = formatUsbDiagnostics(err.diag, err.message);
    expect(text).toMatch(/interface 1 alt 0 class 255\/1\/2: in\/bulk\/2/);
    expect(text).toMatch(/chosen: NONE/);
  });
});

// ─── THE RAW EXCEPTION AND THE STEP THAT THREW ────────────────────────────────
// "NetworkError: Unable to claim interface" and "SecurityError" mean completely
// different things, and knowing WHICH call threw is half the diagnosis. Both must
// survive into the on-screen text — the remote machine gives us nothing else.
describe("every failure names its step and the browser's own exception", () => {
  const printerCfg = [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1)])])])];
  const altCfg = [cfg(1, [iface(0, [alt(0, 0x07, []), alt(1, 0x07, [ep("out", "bulk", 2)])])])];

  const cases = [
    { step: "open", name: "SecurityError", message: "Access denied.", device: () => fakeDevice({ activeValue: 1, configurations: printerCfg, throwOn: { open: domError("SecurityError", "Access denied.") } }) },
    { step: "selectConfiguration", name: "NotFoundError", message: "No such configuration.", device: () => fakeDevice({ activeValue: null, configurations: printerCfg, throwOn: { selectConfiguration: domError("NotFoundError", "No such configuration.") } }) },
    { step: "claimInterface", name: "NetworkError", message: "Unable to claim interface.", device: () => fakeDevice({ activeValue: 1, configurations: printerCfg, throwOn: { claimInterface: domError("NetworkError", "Unable to claim interface.") } }) },
    { step: "selectAlternateInterface", name: "InvalidStateError", message: "Interface not claimed.", device: () => fakeDevice({ activeValue: 1, configurations: altCfg, throwOn: { selectAlternateInterface: domError("InvalidStateError", "Interface not claimed.") } }) },
  ];

  for (const c of cases) {
    it(`tags a ${c.name} thrown by ${c.step}`, async () => {
      const device = c.device();
      const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
      expect(failureOf(err)).toEqual({ step: c.step, name: c.name, message: c.message });
      // Survives String(err.message) — which is what every catch in the print flow does.
      expect(String(err.message)).toContain(c.name);
      expect(String(err.message)).toContain(c.message);
      // ...and reads out of the on-screen block.
      const text = formatUsbDiagnostics(err.diag, err);
      expect(text).toContain(`failed step: ${c.step}`);
      expect(text).toContain(`raw error: ${c.name}: ${c.message}`);
      expect(text).toMatch(/0x1234\/0x5678/);          // the device map is still there
    });
  }

  it("keeps the DOMException name in the claim message even after the macOS hint is added", async () => {
    const device = fakeDevice({ activeValue: 1, claimFailures: 2, configurations: printerCfg });
    const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
    expect(err.message).toContain("NetworkError: Unable to claim interface.");
    expect(err.message).toMatch(/Printers & Scanners/);
    expect(failureOf(err)).toMatchObject({ step: "claimInterface", name: "NetworkError" });
    expect(formatUsbDiagnostics(err.diag, err)).toContain("failed step: claimInterface");
  });

  it("labels a device with no bulk OUT as a discovery failure, not a phantom exception", async () => {
    const device = fakeDevice({ activeValue: 1, configurations: [cfg(1, [iface(0, [alt(0, 0x03, [ep("in", "interrupt", 1)])])])] });
    const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
    expect(failureOf(err)).toMatchObject({ step: "discovery" });
    expect(formatUsbDiagnostics(err.diag, err)).toContain("failed step: discovery");
  });

  it("tags a transferOut rejection and a non-ok transfer status", async () => {
    const thrower = { async transferOut() { throw domError("NetworkError", "A transfer error has occurred."); } };
    const rejected = await sendBulk(thrower, 1, new Uint8Array(4)).catch(e => e);
    expect(failureOf(rejected)).toEqual({ step: "transferOut", name: "NetworkError", message: "A transfer error has occurred." });
    expect(String(rejected.message)).toContain("NetworkError");

    const staller = { async transferOut() { return { status: "stall", bytesWritten: 0 }; } };
    const stalled = await sendBulk(staller, 1, new Uint8Array(4)).catch(e => e);
    expect(failureOf(stalled)).toMatchObject({ step: "transferOut", name: "status stall" });
    expect(formatUsbDiagnostics(null, stalled)).toContain("failed step: transferOut");
  });

  it("does not double-wrap a step that is already tagged", async () => {
    const device = fakeDevice({ activeValue: 1, configurations: printerCfg, throwOn: { open: domError("SecurityError", "Access denied.") } });
    const err = await openUsbPrinter(device, { sleep: noSleep }).catch(e => e);
    expect(err.message).toBe("open failed — SecurityError: Access denied.");   // not "open failed — open failed — …"
  });
});

describe("describeUsbDevice / formatUsbDiagnostics — the remote evidence", () => {
  const device = fakeDevice({
    activeValue: 1,
    configurations: [cfg(1, [iface(0, [alt(0, 0x07, [ep("out", "bulk", 1), ep("in", "bulk", 2)])])])],
  });

  it("carries identity, hex ids, device class, the pre-selection configuration state and every endpoint", () => {
    const diag = describeUsbDevice(device, { hadActiveConfiguration: false, chosen: findBulkOut(device) });
    const text = formatUsbDiagnostics(diag);
    expect(text).toMatch(/XP-350B/);
    expect(text).toMatch(/Xprinter/);
    expect(text).toMatch(/0x1234\/0x5678/);
    expect(text).toMatch(/device class 0\/0\/0/);
    expect(text).toMatch(/configuration active before selection: NO/);
    expect(text).toMatch(/interface 0 alt 0 class 7\/1\/2: out\/bulk\/1, in\/bulk\/2/);
    expect(text).toMatch(/chosen: config 1 · interface 0 · alt 0 · bulk OUT endpoint 1/);
  });

  it("appends the error when one is given", () => {
    expect(formatUsbDiagnostics(describeUsbDevice(device), "boom")).toMatch(/error: boom/);
  });

  it("survives having no device information at all", () => {
    expect(formatUsbDiagnostics(null, "boom")).toBe("error: boom");
    expect(formatUsbDiagnostics(null)).toMatch(/no device information/);
  });

  it("contains no undefined values — it is written straight to RTDB", () => {
    const bare = { configurations: [{ interfaces: [{ alternates: [{ endpoints: [{}] }] }] }] };
    const diag = describeUsbDevice(bare);
    expect(JSON.stringify(diag)).not.toMatch(/undefined/);
    const walk = (v) => {
      expect(v).not.toBeUndefined();
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(diag);
  });
});

describe("sendBulk — every transfer status is checked", () => {
  const fakeOut = (statuses) => {
    const sent = [];
    let i = 0;
    return {
      sent,
      device: {
        async transferOut(endpoint, data) {
          sent.push({ endpoint, length: data.length });
          const status = statuses[Math.min(i++, statuses.length - 1)];
          return { status, bytesWritten: status === "ok" ? data.length : 0 };
        },
      },
    };
  };

  it("chunks down the discovered endpoint and returns the acknowledged byte count", async () => {
    const { device, sent } = fakeOut(["ok"]);
    const bytes = await sendBulk(device, 3, new Uint8Array(10), 4);
    expect(bytes).toBe(10);
    expect(sent.map(s => s.length)).toEqual([4, 4, 2]);
    expect(sent.every(s => s.endpoint === 3)).toBe(true);
  });

  it("raises on a stall rather than reporting success", async () => {
    const { device } = fakeOut(["stall"]);
    await expect(sendBulk(device, 1, new Uint8Array(4))).rejects.toThrow(/stall/);
    await expect(sendBulk(device, 1, new Uint8Array(4))).rejects.toThrow(/halted the endpoint/);
  });

  it("raises on a babble and says how far it got", async () => {
    const { device } = fakeOut(["ok", "babble"]);
    await expect(sendBulk(device, 1, new Uint8Array(10), 4)).rejects.toThrow(/babble.*4 of 10 bytes/s);
  });
});

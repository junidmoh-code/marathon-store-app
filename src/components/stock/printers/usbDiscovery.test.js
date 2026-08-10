import { describe, it, expect, vi } from "vitest";
import {
  findBulkOut, describeUsbDevice, formatUsbDiagnostics, openUsbPrinter, sendBulk, NO_BULK_OUT,
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

// activeValue: the configurationValue reported as active, or null for "macOS gave
// us no active configuration" (the common case on the failing iMac).
function fakeDevice({ configurations, activeValue = null, claimFailures = 0, opened = false }) {
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
    async open() { dev.calls.push(["open"]); dev.opened = true; },
    async selectConfiguration(v) {
      dev.calls.push(["selectConfiguration", v]);
      const found = configurations.find(c => c.configurationValue === v);
      // Chrome rejects an unsupported configuration value with NotFoundError —
      // the fake must too, or "just try 1" looks like it works.
      if (!found) throw new Error("NotFoundError: The configuration value provided is not supported by the device.");
      dev.configuration = found;
    },
    async claimInterface(n) {
      dev.calls.push(["claimInterface", n]);
      if (claimAttempts++ < claimFailures) throw new Error("Unable to claim interface — the device is in use.");
    },
    async selectAlternateInterface(i, a) { dev.calls.push(["selectAlternateInterface", i, a]); },
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

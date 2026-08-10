import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The XP-350B driver end-to-end over a fake WebUSB: does connectXprinter actually
// use the hardened discovery, and does a failure leave behind text an operator can
// photograph? Label CONTENT (TSPL/Code 128) is not under test here.

const ep = (direction, type, endpointNumber) => ({ direction, type, endpointNumber });

function fakeDevice(configurations, { activeValue = null } = {}) {
  const dev = {
    productName: "XP-350B", manufacturerName: "Xprinter", serialNumber: "",
    vendorId: 0x1234, productId: 0x5678, deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    opened: false, configurations,
    configuration: activeValue == null ? null : configurations.find(c => c.configurationValue === activeValue) || null,
    async open() { dev.opened = true; },
    async selectConfiguration(v) { dev.configuration = configurations.find(c => c.configurationValue === v) || null; },
    async claimInterface() {},
    async selectAlternateInterface() {},
  };
  return dev;
}

let usbDevices = [];
beforeAll(() => {
  // Node's own `navigator` is getter-only — stubGlobal redefines it properly.
  vi.stubGlobal("navigator", {
    usb: {
      addEventListener() {},
      async getDevices() { return usbDevices; },
      async requestDevice() { throw new Error("no chooser in tests"); },
    },
  });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe("xprinter over a fake WebUSB", () => {
  it("a device with no bulk OUT fails with a diagnostic text block, not a bare message", async () => {
    const { connectXprinter, getXprinterDiagText } = await import("./xprinter");
    usbDevices = [fakeDevice([
      { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [
        { alternateSetting: 0, interfaceClass: 0x03, interfaceSubclass: 0, interfaceProtocol: 0, endpoints: [ep("in", "interrupt", 1)] },
      ] }] },
    ])];
    const err = await connectXprinter().catch(e => e);
    expect(err.message).toMatch(/No bulk OUT endpoint/);
    const text = getXprinterDiagText(err.message);
    expect(text).toMatch(/XP-350B/);
    expect(text).toMatch(/0x1234\/0x5678/);
    expect(text).toMatch(/configuration active before selection: NO/);
    expect(text).toMatch(/in\/interrupt\/1/);
    expect(text).toMatch(/chosen: NONE/);
  });

  it("reports the acknowledged byte count on a successful print", async () => {
    const { printXprinter } = await import("./xprinter");
    let total = 0;
    const conn = {
      device: { async transferOut(_e, data) { total += data.length; return { status: "ok", bytesWritten: data.length }; } },
      endpointOut: 3,
    };
    const res = await printXprinter([{ code: "00001234", productName: "Nike Air Force 1", size: "9", count: 2 }], conn);
    expect(res.ok).toBe(true);
    expect(res.printed).toBe(2);
    expect(res.bytes).toBe(total);
    expect(res.bytes).toBeGreaterThan(0);
  });

  it("a stalled transfer is a failure carrying the diagnostic, never a success", async () => {
    const { printXprinter } = await import("./xprinter");
    const conn = {
      device: { async transferOut() { return { status: "stall", bytesWritten: 0 }; } },
      endpointOut: 3,
    };
    const res = await printXprinter([{ code: "00001234", productName: "X", size: "9", count: 1 }], conn);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stall/);
    expect(typeof res.diag).toBe("string");
    expect(res.diag).toMatch(/error: .*stall/);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { code128Modules } from "../barcode";
import { orderDevices, commandLanguageFrom1284, formatAttempt } from "./usbDiscovery";

// The USB label printer end-to-end over a FAKE navigator.usb: which device and
// endpoint get used, when the OS print route takes over, what the screen says on
// a failure, and that both routes print the same barcode. Every test loads the
// driver fresh (vi.resetModules) — it keeps one live connection at module level.

const ep = (direction, type, endpointNumber) => ({ direction, type, endpointNumber });
const alt = (alternateSetting, interfaceClass, endpoints) => ({ alternateSetting, interfaceClass, interfaceSubclass: 1, interfaceProtocol: 2, endpoints });
const printerConfig = (outEp = 1) => [{ configurationValue: 1, interfaces: [
  { interfaceNumber: 0, alternates: [alt(0, 7, [ep("out", "bulk", outEp), ep("in", "bulk", 2)])] },
] }];

function netError(message = "Unable to claim interface.") {
  const e = new Error(message); e.name = "NetworkError"; return e;
}

// A fake USBDevice. `claim` decides each claimInterface call: "ok", "fail"
// (NetworkError — the OS holds it) or a function (n, iface) → "ok"|"fail".
function fakeDevice({ name = "XP-350B", maker = "Xprinter", vid = 0x0483, pid = 0x5743, serial = "",
  configurations = printerConfig(), claim = "ok", transferStatus = "ok", ieee1284 = null } = {}) {
  const calls = [];
  let claims = 0;
  const dev = {
    productName: name, manufacturerName: maker, serialNumber: serial, vendorId: vid, productId: pid,
    deviceClass: 0, deviceSubclass: 0, deviceProtocol: 0,
    opened: false, configurations, configuration: null, calls, written: [],
    async open() { calls.push("open"); dev.opened = true; },
    async close() { calls.push("close"); dev.opened = false; },
    async selectConfiguration(v) {
      calls.push(`selectConfiguration:${v}`);
      const c = configurations.find(x => x.configurationValue === v);
      if (!c) { const e = new Error("config"); e.name = "NotFoundError"; throw e; }
      dev.configuration = c;
    },
    async claimInterface(i) {
      claims++;
      calls.push(`claimInterface:${i}`);
      const verdict = typeof claim === "function" ? claim(claims, i) : claim;
      if (verdict !== "ok") throw netError();
    },
    async releaseInterface(i) { calls.push(`releaseInterface:${i}`); },
    async selectAlternateInterface(i, a) { calls.push(`selectAlternateInterface:${i}:${a}`); },
    async reset() { calls.push("reset"); },
    async controlTransferIn() {
      if (!ieee1284) return { status: "stall" };
      const body = new TextEncoder().encode(ieee1284);
      const out = new Uint8Array(body.length + 2); out[0] = (out.length >> 8) & 0xff; out[1] = out.length & 0xff; out.set(body, 2);
      return { status: "ok", data: new DataView(out.buffer) };
    },
    async transferOut(endpoint, data) {
      calls.push(`transferOut:${endpoint}:${data.length}`);
      if (data.length) dev.written.push({ endpoint, text: new TextDecoder().decode(data) });
      return { status: transferStatus, bytesWritten: data.length };
    },
  };
  return dev;
}

function fakeUsb(devices = []) {
  const listeners = { connect: [], disconnect: [] };
  const usb = {
    devices,
    requestDevice: vi.fn(async () => { const e = new Error("No device selected."); e.name = "NotFoundError"; throw e; }),
    async getDevices() { return [...usb.devices]; },
    addEventListener(type, fn) { listeners[type].push(fn); },
    fire(type, device) { for (const fn of listeners[type]) fn({ device }); },
  };
  return usb;
}

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// A document just big enough for printViaOs: the iframe "loads" as soon as it is
// attached, and its window records print() calls.
function fakeDocument() {
  const printed = [];
  const doc = {
    printed,
    createElement() {
      const frame = {
        style: {}, setAttribute() {}, remove() {},
        contentWindow: { focus() {}, print() { printed.push(frame.srcdoc); } },
      };
      return frame;
    },
    body: { appendChild(frame) { queueMicrotask(() => frame.onload()); } },
  };
  return doc;
}

let usb, doc;
async function load() {
  vi.resetModules();
  const facade = await import("./index");
  const status = await import("./printerStatus");
  return { ...facade, ...status };
}
const flush = () => new Promise(r => setTimeout(r, 0));
async function settle(mod) {
  // Let queued discoveries (watch + events) finish.
  for (let i = 0; i < 50; i++) {
    await flush();
    if (mod.getPrinterStatus().state !== "checking") return;
    await new Promise(r => setTimeout(r, 20));
  }
}

beforeEach(() => {
  usb = fakeUsb();
  doc = fakeDocument();
  vi.stubGlobal("navigator", { usb, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130" });
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("document", doc);
});
afterEach(() => { vi.unstubAllGlobals(); });

const ITEM = { code: "00012345", productName: "Nike Pegasus 41", size: "9", count: 2 };

describe("every permitted device is tried", () => {
  it("skips a device with no bulk OUT and a printer the OS holds, and prints on the third", async () => {
    const mouse = fakeDevice({ name: "USB Mouse", maker: "Logi", vid: 0x046d, pid: 0xc077, configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] });
    const held = fakeDevice({ name: "XP-360B", vid: 0x2d37, pid: 0x0001, claim: "fail" });
    const good = fakeDevice({ name: "XP-350B" });
    usb.devices = [mouse, held, good];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.ok).toBe(true);
    expect(res.route).toBe("usb");
    expect(good.written.map(w => w.endpoint)).toEqual([1]);
    expect(good.written[0].text).toContain('BARCODE');
    expect(held.written).toEqual([]);
    expect(held.calls).not.toContain("reset");        // never reset a device the OS is printing on
    expect(held.calls.at(-1)).toBe("close");          // let go for the OS
    expect(m.getPrinterStatus()).toMatchObject({ state: "usb", printed: "usb" });
    expect(m.getPrinterStatus().name).toContain("XP-350B");
  });

  it("uses a bulk OUT endpoint on interface 1, alternate 1", async () => {
    const dev = fakeDevice({ configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 255, [ep("in", "interrupt", 1)])] },
      { interfaceNumber: 1, alternates: [alt(0, 7, [ep("in", "bulk", 2)]), alt(1, 7, [ep("out", "bulk", 3), ep("in", "bulk", 4)])] },
    ] }] });
    usb.devices = [dev];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.ok).toBe(true);
    const claimAt = dev.calls.indexOf("claimInterface:1");
    expect(claimAt).toBeGreaterThan(-1);
    expect(dev.calls.indexOf("selectAlternateInterface:1:1")).toBeGreaterThan(claimAt);
    expect(dev.calls).toContain("transferOut:3:0");     // the no-op write, on the found endpoint
    expect(dev.written.every(w => w.endpoint === 3)).toBe(true);
    expect(m.getPrinterStatus().detail).toContain("interface 1 · endpoint 3");
  });

  it("tries the next endpoint on the same device when the best one can't be claimed", async () => {
    const dev = fakeDevice({
      configurations: [{ configurationValue: 1, interfaces: [
        { interfaceNumber: 0, alternates: [alt(0, 7, [ep("out", "bulk", 1)])] },
        { interfaceNumber: 1, alternates: [alt(0, 255, [ep("out", "bulk", 5)])] },
      ] }],
      claim: (n, i) => (i === 0 ? "fail" : "ok"),
    });
    usb.devices = [dev];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("usb");
    expect(dev.written.every(w => w.endpoint === 5)).toBe(true);
    expect(dev.calls).not.toContain("reset");         // the second endpoint worked first time
  });

  it("recovers through reset() when the endpoint only takes data after it", async () => {
    let afterReset = false;
    const dev = fakeDevice();
    const reset = dev.reset, transferOut = dev.transferOut;
    dev.reset = async () => { afterReset = true; return reset(); };
    dev.transferOut = async (e, d) => (afterReset ? transferOut(e, d) : { status: "stall", bytesWritten: 0 });
    usb.devices = [dev];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("usb");
    expect(dev.calls.filter(c => c === "reset")).toHaveLength(1);
  });
});

describe("the OS print route", () => {
  it("claimInterface throwing (the OS holds it) falls through to window.print with the same label", async () => {
    const dev = fakeDevice({ claim: "fail" });
    usb.devices = [dev];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.ok).toBe(true);
    expect(res.route).toBe("os");
    expect(res.printed).toBe(2);
    expect(doc.printed).toHaveLength(1);
    expect(doc.printed[0]).toContain("size: 40mm 30mm");
    expect(dev.written).toEqual([]);
    const s = m.getPrinterStatus();
    expect(s).toMatchObject({ state: "os", route: "os", printed: "os" });
    // The failure names the device, the interface/endpoint tried and the exact exception.
    const text = m.printerStatusText(s);
    expect(text).toContain("XP-350B (Xprinter 0x0483/0x5743)");
    expect(text).toContain("interface 0 · alt 0 · OUT endpoint 1");
    expect(text).toContain("claimInterface → NetworkError: Unable to claim interface.");
    expect(dev.calls).not.toContain("reset");
  });

  it("never re-sends a batch through the OS once bytes reached the USB printer", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    const conn = await m.connectTransport("xprinter");
    dev.transferOut = async (e, data) => (data.length > 0 && dev.written.push({ e }) > 1
      ? { status: "stall", bytesWritten: 0 } : { status: "ok", bytesWritten: data.length });
    const res = await m.printLabels({ items: [ITEM, { ...ITEM, code: "00012346" }], transport: "xprinter", conn });
    expect(res.ok).toBe(false);
    expect(res.sentBytes).toBeGreaterThan(0);
    expect(doc.printed).toHaveLength(0);
    expect(res.error).toContain("XP-350B");
    expect(res.error).toContain("OUT endpoint 1");
  });

  it("a stale handle (printer slept, no disconnect event) is re-found once and the batch prints over USB", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    const conn = await m.connectTransport("xprinter");
    const transferOut = dev.transferOut;
    let dead = true;
    dev.transferOut = async (e, d) => {
      if (dead && d.length) { dead = false; const x = new Error("The device was disconnected."); x.name = "NetworkError"; throw x; }
      return transferOut(e, d);
    };
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter", conn });
    expect(res).toMatchObject({ ok: true, route: "usb" });
    expect(doc.printed).toHaveLength(0);
    expect(dev.written).toHaveLength(1);
  });

  it("bytes of the FIRST label that reached the printer still block the OS fallback", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    const conn = await m.connectTransport("xprinter");
    dev.transferOut = async (e, data) => (data.length ? { status: "stall", bytesWritten: 10 } : { status: "ok", bytesWritten: 0 });
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter", conn });
    expect(res.ok).toBe(false);
    expect(res.sentBytes).toBe(10);
    expect(doc.printed).toHaveLength(0);
    expect(m.getPrinterStatus().state).toBe("none");   // a final state, not "looking…" forever
  });

  it("a transfer that rejects after earlier chunks reports the bytes already sent", async () => {
    const { sendBulk } = await import("./usbDiscovery");
    let n = 0;
    const dev = { async transferOut(e, d) { if (++n === 3) throw netError("Transfer failed."); return { status: "ok", bytesWritten: d.length }; } };
    const err = await sendBulk(dev, 1, new Uint8Array(10), 4).catch(e => e);
    expect(err.sentBytes).toBe(8);
    expect(err.step).toBe("transferOut");
  });

  it("offers the picker (printers only) when the only allowed device is a keyboard — the iMac case", async () => {
    const kbd = fakeDevice({ name: "USB Keyboard", maker: "NT", vid: 0x1a86, pid: 0x5453, configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] });
    const printer = fakeDevice({ name: "XP-350B" });
    usb.devices = [kbd];
    usb.requestDevice.mockImplementation(async () => { usb.devices = [kbd, printer]; return printer; });
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(usb.requestDevice).toHaveBeenCalledTimes(1);
    const filters = usb.requestDevice.mock.calls[0][0].filters;
    expect(filters).toEqual([{ classCode: 0x07 }, { classCode: 0xff }]);   // no HID: the keyboard can't be picked again
    expect(res).toMatchObject({ ok: true, route: "usb" });
    expect(printer.written).toHaveLength(1);
    expect(doc.printed).toHaveLength(0);
  });

  it("a printer picked just now that macOS holds reads 'held', not 'no printer allowed'", async () => {
    const kbd = fakeDevice({ name: "USB Keyboard", configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] });
    const printer = fakeDevice({ name: "XP-350B", claim: "fail" });
    usb.devices = [kbd];
    usb.requestDevice.mockImplementation(async () => { usb.devices = [kbd, printer]; return printer; });
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("os");
    const st = m.getPrinterStatus();
    expect(st.noPrinter).toBe(false);
    expect(st.detail).toBe("USB printer is held by the computer's print system");
  });

  it("a printer that fails to OPEN is still a printer — no picker", async () => {
    const dev = fakeDevice();
    dev.open = async () => { const e = new Error("Access denied."); e.name = "SecurityError"; throw e; };
    usb.devices = [dev];
    const m = await load();
    await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(usb.requestDevice).not.toHaveBeenCalled();
    expect(m.getPrinterStatus().noPrinter).toBe(false);
  });

  it("the Choose button opens the picker before touching any device", async () => {
    const kbd = fakeDevice({ name: "USB Keyboard", configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] });
    const printer = fakeDevice({ name: "XP-350B" });
    usb.devices = [kbd];
    usb.requestDevice.mockImplementation(async () => { expect(kbd.calls).toEqual([]); usb.devices = [kbd, printer]; return printer; });
    const m = await load();
    await m.chooseUsbPrinter();
    expect(m.getPrinterStatus().state).toBe("usb");
    expect(printer.calls).toContain("transferOut:1:0");
    await m.chooseUsbPrinter({ showAll: true });
    expect(usb.requestDevice.mock.calls[1][0].filters).toEqual([]);
  });

  it("a keyboard-only site whose picker is dismissed says why and keeps the button on offer", async () => {
    usb.devices = [fakeDevice({ name: "USB Keyboard", configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] })];
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("os");
    const st = m.getPrinterStatus();
    expect(st.noPrinter).toBe(true);
    expect(st.detail).toBe("no USB printer allowed for this site yet");
    expect(m.printerStatusText(st)).toContain("none of the USB devices allowed for this site is a printer");
  });

  it("shows the picker only when no device is permitted, and only once per page load", async () => {
    usb.devices = [];
    const m = await load();
    const a = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    const b = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(usb.requestDevice).toHaveBeenCalledTimes(1);
    expect([a.route, b.route]).toEqual(["os", "os"]);
    expect(m.getPrinterStatus().detail).toBe("no USB printer allowed for this site yet");

    usb.devices = [fakeDevice({ claim: "fail" })];
    usb.requestDevice.mockClear();
    const m2 = await load();
    await m2.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(usb.requestDevice).not.toHaveBeenCalled();  // a permitted device exists — no picker
  });
});

describe("auto-reconnect", () => {
  it("re-finds the printer silently after unplug and replug", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    m.startUsbPrinterWatch();
    await settle(m);
    expect(m.getPrinterStatus().state).toBe("usb");

    usb.devices = [];
    usb.fire("disconnect", dev);
    await settle(m);
    expect(m.getPrinterStatus().state).toBe("os");

    const back = fakeDevice();                         // a replug is a NEW USBDevice object
    usb.devices = [back];
    usb.fire("connect", back);
    await new Promise(r => setTimeout(r, 450));        // the watch debounces replug bursts
    await settle(m);
    expect(m.getPrinterStatus().state).toBe("usb");
    expect(usb.requestDevice).not.toHaveBeenCalled();

    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("usb");
    expect(back.written.length).toBe(1);
  });
});

describe("the watch and the print don't trip over each other", () => {
  it("ignores an unrelated USB device being plugged in while the printer works", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    m.startUsbPrinterWatch();
    await settle(m);
    const before = dev.calls.length;
    const kbd = fakeDevice({ name: "Keyboard", vid: 0x05ac, pid: 0x024f, configurations: [{ configurationValue: 1, interfaces: [
      { interfaceNumber: 0, alternates: [alt(0, 3, [ep("in", "interrupt", 1)])] }] }] });
    usb.devices = [dev, kbd];
    usb.fire("connect", kbd);
    await new Promise(r => setTimeout(r, 450));
    expect(dev.calls.length).toBe(before);             // the printer was not touched
    expect(kbd.calls).toEqual([]);
  });

  it("a discovery asked for mid-batch waits until the batch is sent", async () => {
    const dev = fakeDevice();
    usb.devices = [dev];
    const m = await load();
    const conn = await m.connectTransport("xprinter");
    const transferOut = dev.transferOut;
    dev.transferOut = async (e, d) => { await new Promise(r => setTimeout(r, 15)); return transferOut(e, d); };
    const printing = m.printLabels({ items: [ITEM, { ...ITEM, code: "00012346" }, { ...ITEM, code: "00012347" }], transport: "xprinter", conn });
    await flush();
    const probe = m.findUsbPrinter();                  // e.g. a replug event
    const res = await printing;
    await probe;
    expect(res.ok).toBe(true);
    const sends = dev.calls.map((c, i) => [c, i]).filter(([c]) => /^transferOut:1:[1-9]/.test(c)).map(([, i]) => i);
    const reopenAt = dev.calls.lastIndexOf("claimInterface:0");
    expect(sends).toHaveLength(3);
    expect(reopenAt).toBeGreaterThan(Math.max(...sends)); // the probe ran AFTER the last label
  });
});

describe("remembered device first", () => {
  it("tries the device that worked last time before any other", async () => {
    const a = fakeDevice({ name: "XP-360B", vid: 0x2d37, pid: 0x0001, serial: "A1" });
    const b = fakeDevice({ name: "XP-350B", serial: "B2" });
    usb.devices = [a, b];
    localStorage.setItem("marathon.labelPrinter.usb", JSON.stringify({ vendorId: 0x0483, productId: 0x5743, serialNumber: "B2" }));
    const m = await load();
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(res.route).toBe("usb");
    expect(b.written.length).toBe(1);
    expect(a.calls).toEqual([]);                       // never even opened
  });

  it("remembers the device that worked", async () => {
    const a = fakeDevice({ name: "Scanner", claim: "fail", vid: 1, pid: 2 });
    const b = fakeDevice({ name: "XP-350B", serial: "S9" });
    usb.devices = [a, b];
    const m = await load();
    await m.printLabels({ items: [ITEM], transport: "xprinter" });
    expect(JSON.parse(localStorage.getItem("marathon.labelPrinter.usb"))).toEqual({ vendorId: 0x0483, productId: 0x5743, serialNumber: "S9" });
  });

  it("orders: exact serial, then VID/PID, then printer-class, then the rest", () => {
    const other = fakeDevice({ name: "other", vid: 9, pid: 9, configurations: [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [alt(0, 255, [ep("out", "bulk", 1)])] }] }] });
    const printer = fakeDevice({ name: "printer", vid: 8, pid: 8 });
    const vidpid = fakeDevice({ name: "vidpid", vid: 5, pid: 6, serial: "" });
    const exact = fakeDevice({ name: "exact", vid: 5, pid: 6, serial: "X" });
    const order = orderDevices([other, printer, vidpid, exact], { vendorId: 5, productId: 6, serialNumber: "X" });
    expect(order.map(d => d.productName)).toEqual(["exact", "vidpid", "printer", "other"]);
  });
});

describe("the OS route never claims a print it can't see", () => {
  it("a print dialog (which may have been cancelled) is reported as unconfirmed", async () => {
    usb.devices = [fakeDevice({ claim: "fail" })];
    const m = await load();
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const print = doc.createElement;
    doc.createElement = () => { const f = print(); const p = f.contentWindow.print; f.contentWindow.print = () => { skew += 5000; p(); }; return f; };
    const res = await m.printLabels({ items: [ITEM], transport: "xprinter" });
    vi.restoreAllMocks();
    expect(res).toMatchObject({ ok: true, route: "os", dialogShown: true, unconfirmed: true });
    expect(res.routeLabel).toContain("check the labels");
  });
});

describe("command language", () => {
  it("gives up on a printer that never answers GET_DEVICE_ID", async () => {
    vi.useFakeTimers();
    const { readIeee1284Id, ID_TIMEOUT_MS } = await import("./usbDiscovery");
    const dev = { controlTransferIn: () => new Promise(() => {}) };
    const p = readIeee1284Id(dev, { interfaceNumber: 0, alternateSetting: 0 });
    await vi.advanceTimersByTimeAsync(ID_TIMEOUT_MS + 1);
    expect(await p).toBe(null);
    vi.useRealTimers();
  });

  it("asks GET_DEVICE_ID in the class-spec form first, then the interface number", async () => {
    const { readIeee1284Id } = await import("./usbDiscovery");
    const asked = [];
    const dev = { async controlTransferIn(setup) {
      asked.push(setup.index);
      if (setup.index !== 1) return { status: "stall" };
      const b = new TextEncoder().encode("..CMD:ESC/POS;");
      return { status: "ok", data: new DataView(b.buffer) };
    } };
    expect(await readIeee1284Id(dev, { interfaceNumber: 1, alternateSetting: 1 })).toBe("CMD:ESC/POS;");
    expect(asked).toEqual([0x0101, 1]);
  });

  it("reads the IEEE 1284 command set", () => {
    expect(commandLanguageFrom1284("MFG:Xprinter;CMD:TSPL,ESC/POS;MDL:XP-350B;")).toBe("tspl");
    expect(commandLanguageFrom1284("MANUFACTURER:Acme;COMMAND SET:ESC/POS;MODEL:L1;")).toBe("escpos");
    expect(commandLanguageFrom1284("MFG:Acme;MDL:X;")).toBe(null);
    expect(commandLanguageFrom1284(null)).toBe(null);
  });

  it("formats an attempt with device, endpoint and exception", () => {
    expect(formatAttempt({ device: "XP-350B (Xprinter 0x0483/0x5743)", configurationValue: 1, interfaceNumber: 0, alternateSetting: 0,
      endpointNumber: 1, step: "claimInterface", name: "NetworkError", message: "Unable to claim interface.", round: "first" }))
      .toBe("XP-350B (Xprinter 0x0483/0x5743) · config 1 · interface 0 · alt 0 · OUT endpoint 1 · claimInterface → NetworkError: Unable to claim interface.");
  });
});

// ── Barcode parity: the USB (TSPL) and OS (HTML) routes print the same symbol ──
// Decode the HTML route's SVG bars back to Code 128 characters and compare with
// what the TSPL route asks the printer to encode.
function patternTable() {
  // Each printable char's symbol pattern, read off the encoder: [StartB, char, check, Stop].
  const table = new Map();
  for (let v = 0; v <= 94; v++) {
    const mods = code128Modules(String.fromCharCode(32 + v)).map(m => m.width);
    table.set(mods.slice(6, 12).join(""), v);
    if (v === 0) table.set(mods.slice(0, 6).join(""), "START_B");
  }
  return table;
}
function decodeSvg(svg) {
  const total = Number(/viewBox="0 0 (\d+) 1"/.exec(svg)[1]);
  const bars = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  // Rebuild alternating bar/space run widths from the bar rectangles.
  const runs = []; let x = 0;
  for (const [bx, w] of bars) { if (bx > x) runs.push(bx - x); runs.push(w); x = bx + w; }
  expect(x).toBe(total);
  const table = patternTable();
  const syms = [];
  for (let i = 0; i + 6 <= runs.length - 7; i += 6) syms.push(runs.slice(i, i + 6).join(""));
  expect(table.get(syms[0])).toBe("START_B");
  const values = syms.slice(1).map(p => table.get(p));
  const data = values.slice(0, -1);
  const check = (104 + data.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
  expect(values.at(-1)).toBe(check);                 // checksum valid
  expect(runs.slice(-7).join("")).toBe("2331112");   // Stop
  return data.map(v => String.fromCharCode(v + 32)).join("");
}

describe("barcode parity between the two routes", () => {
  it("same symbology, same data, same label size", async () => {
    const { tsplLabel, LABEL_GEOMETRY } = await import("./xprinter");
    const { labelHtml } = await import("./osPrint");
    for (const code of ["00012345", "99999999", "00000001"]) {
      const item = { code, productName: "Adidas Adizero <Boston> & \"12\"", size: "UK 9" };
      const tspl = tsplLabel(item, 1);
      const bc = /BARCODE \d+,\d+,"([^"]+)",\d+,1,0,\d+,\d+,"([^"]+)"/.exec(tspl);
      expect(bc[1]).toBe("128");                       // Code 128
      expect(bc[2]).toBe(code);
      expect(tspl).toContain(`SIZE ${LABEL_GEOMETRY.widthMm} mm,${LABEL_GEOMETRY.heightMm} mm`);

      const html = labelHtml([{ ...item, count: 1 }]);
      const svg = /<svg class="bars"[^>]*>.*?<\/svg>/.exec(html)[0];
      expect(svg).toContain('data-symbology="code128"');
      expect(decodeSvg(svg)).toBe(code);               // Code 128, same data
      expect(html).toContain(`size: ${LABEL_GEOMETRY.widthMm}mm ${LABEL_GEOMETRY.heightMm}mm`);
      expect(html).toContain("Size: UK 9");
      expect(html).toContain("&lt;Boston&gt; &amp; &quot;12&quot;");   // escaped, not injected
    }
  });

  it("prints one HTML page per copy, as the TSPL route prints PRINT 1,n", async () => {
    const { labelHtml } = await import("./osPrint");
    const html = labelHtml([{ ...ITEM, count: 3 }, { ...ITEM, code: "00000002", count: 0 }]);
    expect(html.match(/<section class="label">/g)).toHaveLength(4);   // 3 + (0 → 1)
  });
});

describe("default transport", () => {
  it("is the USB label printer on a desktop and Phomemo on a phone; a pick is remembered", async () => {
    let m = await load();
    expect(m.defaultTransportId()).toBe("xprinter");
    vi.stubGlobal("navigator", { usb, bluetooth: {}, userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile" });
    m = await load();
    expect(m.defaultTransportId()).toBe("phomemo");
    vi.stubGlobal("navigator", { usb, bluetooth: {}, userAgent: "Mozilla/5.0 (Macintosh) Chrome/130" });
    m.rememberTransport("phomemo");
    expect(m.defaultTransportId()).toBe("phomemo");
  });
});

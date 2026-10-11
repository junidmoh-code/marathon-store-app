import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  crc32, encodeFrames, seal, parsePairingCode, orderPayload, orderKeyOf, HEADER_SIZE,
} from "../protocol.js";
import { createHandoff, consumePairingHash, readPairing, PAIRING_KEY, FAIL_AFTER_MS, RETRY_MS } from "../handoff.js";
import { createQueue, MAX_AGE_MS } from "../queue.js";

const vector = JSON.parse(readFileSync(resolve(import.meta.dirname, "test-vector.json"), "utf8"));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

const ORDER = {
  id: "042", createdAt: "2026-10-11T08:01:02.345Z", destShop: "marathon-pe",
  customerName: "Thandi Mokoena", customerPhone: "27821234567",
  productId: "-NxAbC123", size: "9", sentSize: null,
};

describe("protocol — the bytes Till 1's receiver expects", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("reproduces the shared test vector byte for byte (same as the .NET receiver)", async () => {
    const key = unhex(vector.keyHex);
    const message = await seal(key, new TextEncoder().encode(vector.payload));
    const frames = encodeFrames(vector.msgId, message, vector.chunkData);
    expect(frames.map(hex)).toEqual(vector.frames);
    expect(hex(parsePairingCode(vector.pairingCode))).toBe(vector.keyHex);
  });

  it("orderPayload of a real order is exactly the vector's payload", () => {
    expect(JSON.stringify(orderPayload(ORDER, 1760169662345))).toBe(vector.payload);
  });

  it("pairing codes: case, dashes and spaces do not matter; anything else is refused", () => {
    expect(parsePairingCode(vector.pairingCode.toLowerCase().replaceAll("-", " "))).not.toBeNull();
    expect(parsePairingCode("ABCD")).toBeNull();
    expect(parsePairingCode(vector.pairingCode.replace("A", "1"))).toBeNull();
    expect(parsePairingCode(null)).toBeNull();
  });

  it("order identity is number + createdAt (numbers repeat daily)", () => {
    expect(orderKeyOf(ORDER)).toBe("042|2026-10-11T08:01:02.345Z");
  });
});

// A Till 1 in JS: reassembles, checks the HMAC, dedupes, acks.
async function fakeTill({ key, dropAcks = 0, failConnect = 0, hangConnect = 0, strictGatt = false, noNotify = false, slowRead = false, failWrites = 0 } = {}) {
  let inFlight = 0;
  let collisions = 0;
  let ackListenerAdds = 0;
  // Android Chrome: one GATT operation at a time, a second one rejects.
  const op = async (fn) => {
    if (strictGatt && inFlight > 0) { collisions++; throw new Error("GATT operation already in progress"); }
    inFlight++;
    try { await new Promise((r) => setTimeout(r, 0)); return await fn(); } finally { inFlight = Math.max(0, inFlight - 1); }
  };
  const journal = new Map();
  const pending = new Map();
  const listeners = new Set();
  let lastAck = new TextEncoder().encode("{}");
  let connects = 0;
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  async function onWrite(frame) {
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const msgId = v.getUint16(2, true), index = v.getUint16(4, true), count = v.getUint16(6, true);
    const data = frame.slice(HEADER_SIZE);
    if (crc32(data) !== v.getUint32(12, true)) return ack(msgId, "crc");
    const p = pending.get(msgId) ?? { chunks: new Array(count).fill(null) };
    p.chunks[index] = data;
    pending.set(msgId, p);
    if (p.chunks.some((c) => !c)) return;
    pending.delete(msgId);
    const msg = new Uint8Array(p.chunks.reduce((a, c) => a + c.length, 0));
    let at = 0;
    for (const c of p.chunks) { msg.set(c, at); at += c.length; }
    const body = msg.slice(0, -32);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new Uint8Array([...new TextEncoder().encode("MBT1"), ...body])));
    if (hex(mac) !== hex(msg.slice(-32))) return ack(msgId, "mac");
    const order = JSON.parse(new TextDecoder().decode(body)).order;
    const k = `${order.orderId}|${order.createdAt}`;
    const dup = journal.has(k);
    journal.set(k, order);
    return ack(msgId, dup ? "dup" : "ok");
  }
  function ack(m, s) {
    lastAck = new TextEncoder().encode(JSON.stringify({ m, s, o: null }));
    if (dropAcks > 0) { dropAcks--; lastAck = new TextEncoder().encode("{}"); return; }
    const value = new DataView(lastAck.buffer);
    listeners.forEach((l) => l({ target: { value } }));
  }

  const writeChar = {
    writeValueWithResponse: (f) => op(async () => {
      if (failWrites > 0) { failWrites--; throw new Error("GATT write failed"); }
      return onWrite(f);
    }),
  };
  const ackChar = {
    startNotifications: async () => { if (noNotify) throw new Error("notifications not supported"); },
    addEventListener: (_, l) => { ackListenerAdds++; listeners.add(l); },
    readValue: () => op(async () => {
      if (slowRead) await new Promise((r) => setTimeout(r, 30));
      return new DataView(lastAck.buffer);
    }),
  };
  const device = {
    id: "till-1",
    addEventListener() {},
    gatt: {
      connected: false,
      // Chrome rejects every pending operation on disconnect.
      disconnect() { this.connected = false; inFlight = 0; },
      async connect() {
        connects++;
        if (hangConnect > 0) { hangConnect--; return new Promise(() => {}); }
        if (failConnect > 0) { failConnect--; throw new Error("GATT connect failed"); }
        this.connected = true;
        return this;
      },
      async getPrimaryService() {
        return {
          async getCharacteristic(uuid) {
            if (uuid.includes("-0002-")) return writeChar;
            return ackChar;
          },
        };
      },
    },
  };
  return { device, journal, connects: () => connects, collisions: () => collisions, ackListenerAdds: () => ackListenerAdds };
}

function rig({ till, getDevices = true, storage = memoryStorage(), paired = true, chooserGate = null } = {}) {
  let t = 1_000_000;
  const timers = [];
  if (paired) storage.setItem(PAIRING_KEY, JSON.stringify({ code: vector.pairingCode, shop: "marathon-pe", till: "Marathon PE Till 1" }));
  let chooserCalls = 0;
  const bluetooth = {
    requestDevice: async () => { chooserCalls++; if (chooserGate) await chooserGate; return till.device; },
    ...(getDevices ? { getDevices: async () => (chooserCalls > 0 || storage.getItem("granted") ? [till.device] : []) } : {}),
  };
  const h = createHandoff({
    bluetooth, storage, now: () => t,
    setTimer: (fn, ms) => timers.push({ fn, at: t + ms }),
    log: () => {},
  });
  const runTimers = async (ms) => {
    const until = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      t = next.at;
      next.fn(); // real timers do not wait for an async callback
      await new Promise((r) => setTimeout(r, 0));
    }
    t = until;
  };
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 0)); await runTimers(500); } };
  // Real crypto.subtle resolves off the fake clock, so step until it holds.
  const until = async (cond, rounds = 200) => {
    for (let i = 0; i < rounds && !cond(); i++) { await new Promise((r) => setTimeout(r, 0)); await runTimers(1000); }
  };
  return { h, storage, chooserCalls: () => chooserCalls, runTimers, settle, until, advance: (ms) => { t += ms; }, time: () => t };
}

describe("hand-off — tablet to Till 1", () => {
  const key = () => parsePairingCode(vector.pairingCode);

  it("chooser once on the place-order tap, then every order lands on the till exactly once", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.settle();
    r.h.prepareFromGesture(); // second order's tap: no second chooser
    r.h.handOff([{ ...ORDER, id: "043" }]);
    await r.settle();
    expect(r.chooserCalls()).toBe(1);
    expect([...till.journal.keys()].sort()).toEqual(["042|2026-10-11T08:01:02.345Z", "043|2026-10-11T08:01:02.345Z"]);
    expect(r.h.status()).toMatchObject({ pending: 0, failing: false });
    expect(JSON.parse(r.storage.getItem(PAIRING_KEY)).deviceId).toBe("till-1");
  });

  it("a restarted tablet finds the till through getDevices with no chooser", async () => {
    const till = await fakeTill({ key: key() });
    const storage = memoryStorage();
    storage.setItem("granted", "1");
    const r = rig({ till, storage });
    r.h.handOff([ORDER]);
    await r.settle();
    expect(r.chooserCalls()).toBe(0);
    expect(till.journal.size).toBe(1);
  });

  it("only orders for the paired till's shop are sent", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    expect(r.h.handOff([{ ...ORDER, destShop: "trophy" }, ORDER])).toBe(1);
    await r.settle();
    expect(till.journal.size).toBe(1);
  });

  it("an unpaired tablet does nothing at all", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till, paired: false });
    r.h.prepareFromGesture();
    expect(r.h.handOff([ORDER])).toBe(0);
    await r.settle();
    expect(r.chooserCalls()).toBe(0);
    expect(r.h.status().enabled).toBe(false);
  });

  it("a lost ack is retried and the till dedupes the resend", async () => {
    const till = await fakeTill({ key: key(), dropAcks: 1 });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.until(() => r.h.status().pending === 0);
    expect(till.journal.size).toBe(1);
    expect(r.h.status().pending).toBe(0);
  });

  it("till out of range: queued, silent at first, failure shown after a while, then delivered", async () => {
    const till = await fakeTill({ key: key(), failConnect: 6 });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.settle();
    expect(r.h.status()).toMatchObject({ pending: 1, failing: false });
    await r.runTimers(FAIL_AFTER_MS + 1000);
    expect(r.h.status().failing).toBe(true);
    await r.until(() => r.h.status().pending === 0);
    expect(till.journal.size).toBe(1);
    expect(r.h.status()).toMatchObject({ pending: 0, failing: false });
  });

  it("the queue survives an app restart", async () => {
    const storage = memoryStorage();
    const down = await fakeTill({ key: key(), failConnect: 99 });
    const r1 = rig({ till: down, storage });
    r1.h.prepareFromGesture();
    await r1.settle();
    r1.h.handOff([ORDER]);
    await r1.settle();
    expect(createQueue(storage).list()).toHaveLength(1);

    const up = await fakeTill({ key: key() });
    storage.setItem("granted", "1");
    const r2 = rig({ till: up, storage });
    r2.h.flush();
    await r2.settle();
    expect(up.journal.size).toBe(1);
    expect(createQueue(storage).list()).toHaveLength(0);
  });

  it("a wrong pairing code stops retrying and asks for a re-pair", async () => {
    const till = await fakeTill({ key: new Uint8Array(16).fill(9) });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.settle();
    expect(till.journal.size).toBe(0);
    expect(r.h.status()).toMatchObject({ needsRepair: true, failing: true, pending: 1 });
  });

  it("without getDevices and no tap yet, the order waits and the banner offers the connect tap", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till, getDevices: false });
    r.h.handOff([ORDER]);
    await r.settle();
    expect(r.h.status()).toMatchObject({ needsGesture: true, pending: 1 });
    r.h.prepareFromGesture();
    await r.settle();
    expect(till.journal.size).toBe(1);
  });
});

describe("queue", () => {
  it("enqueues an order once and expires what can no longer help", () => {
    let t = 0;
    const q = createQueue(memoryStorage(), () => t);
    expect(q.enqueue(ORDER, orderPayload(ORDER))).toBe(true);
    expect(q.enqueue(ORDER, orderPayload(ORDER))).toBe(false);
    t = MAX_AGE_MS + 1;
    expect(q.expire()).toHaveLength(1);
    expect(q.list()).toHaveLength(0);
  });
});

describe("pairing link", () => {
  it("stores the code from #bt-pair and clears the address bar", () => {
    const storage = memoryStorage();
    let replaced = null;
    const r = consumePairingHash(
      { hash: `#bt-pair=${vector.pairingCode}&shop=marathon-pe&till=Marathon%20PE%20Till%201`, pathname: "/", search: "" },
      { replaceState: (_a, _b, url) => { replaced = url; } },
      storage,
    );
    expect(r).toEqual({ ok: true, shop: "marathon-pe", till: "Marathon PE Till 1" });
    expect(replaced).toBe("/");
    expect(readPairing(storage).code).toBe(vector.pairingCode);
  });

  it("ignores other hashes and refuses a bad code", () => {
    const storage = memoryStorage();
    expect(consumePairingHash({ hash: "#admin/users" }, null, storage)).toBeNull();
    expect(consumePairingHash({ hash: "#bt-pair=NOPE", pathname: "/", search: "" }, null, storage)).toEqual({ ok: false });
    expect(readPairing(storage)).toBeNull();
  });
});

// One test per review finding (PR #717): each fails with its fix reverted.
describe("hand-off — review findings", () => {
  const key = () => parsePairingCode(vector.pairingCode);

  it("a malformed pairing link or blocked storage never throws at startup", () => {
    const loc = { hash: "#bt-pair=%E0%A4%A&shop=x", pathname: "/", search: "" };
    expect(() => consumePairingHash(loc, null, memoryStorage())).not.toThrow();
    expect(consumePairingHash(loc, null, memoryStorage())).toEqual({ ok: false });
    const blocked = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    const good = { hash: `#bt-pair=${vector.pairingCode}`, pathname: "/", search: "" };
    expect(consumePairingHash(good, null, blocked)).toEqual({ ok: false });
  });

  it("GATT calls never overlap (Android allows one at a time), even on the read-back path", async () => {
    // The first ack is lost, so the till is polled; the read is slow and still
    // in flight when the deadline passes and the next order starts writing.
    const till = await fakeTill({ key: key(), strictGatt: true, slowRead: true, dropAcks: 1 });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER, { ...ORDER, id: "043" }]);
    await r.until(() => r.h.status().pending === 0);
    expect(till.journal.size).toBe(2);
    expect(till.collisions()).toBe(0);
  });

  it("a GATT call that never settles does not wedge the sender", async () => {
    const till = await fakeTill({ key: key(), hangConnect: 1 });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.until(() => r.h.status().pending === 0);
    expect(till.journal.size).toBe(1);
    expect(till.connects()).toBeGreaterThanOrEqual(2);
  });

  it("an order placed while another is sending goes in the same pass, not 15 s later", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    const t0 = r.time();
    r.h.handOff([ORDER]);
    r.h.handOff([{ ...ORDER, id: "043" }]); // flush already running
    await r.until(() => till.journal.size === 2);
    expect(r.time() - t0).toBeLessThan(RETRY_MS);
  });

  it("an entry that cannot be built is skipped; the rest of the queue still goes", async () => {
    const till = await fakeTill({ key: key() });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([{ ...ORDER, id: "041", customerName: "x".repeat(20_000) }, ORDER]);
    await r.until(() => till.journal.size === 1);
    expect([...till.journal.keys()]).toEqual(["042|2026-10-11T08:01:02.345Z"]);
    expect(r.h.status().pending).toBe(1);
  });

  it("two quick taps open the chooser once", async () => {
    const till = await fakeTill({ key: key() });
    let open;
    const gate = new Promise((res) => { open = res; });
    const r = rig({ till, getDevices: false, chooserGate: gate });
    r.h.prepareFromGesture();
    r.h.prepareFromGesture();
    open();
    await r.settle();
    expect(r.chooserCalls()).toBe(1);
  });

  it("reconnecting never stacks a second ack listener", async () => {
    const till = await fakeTill({ key: key(), failWrites: 2 });
    const r = rig({ till });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    await r.until(() => r.h.status().pending === 0);
    expect(till.journal.size).toBe(1);
    expect(till.ackListenerAdds()).toBe(1);
  });

  it("a storage error while remembering the till still sends at once (no 15 s wait)", async () => {
    const till = await fakeTill({ key: key() });
    const storage = memoryStorage();
    const r = rig({ till, getDevices: false, storage });
    r.h.handOff([ORDER]); // queued; no till chosen yet (its retry is 15 s away)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0));
    const realSet = storage.setItem;
    storage.setItem = (k, v) => { if (k === PAIRING_KEY) throw new Error("QuotaExceededError"); return realSet(k, v); };
    const t0 = r.time();
    r.h.prepareFromGesture();
    await r.until(() => till.journal.size === 1);
    expect(till.journal.size).toBe(1);
    expect(r.time() - t0).toBeLessThan(8000);
  });

  it("re-paired to another shop: the old shop's queued orders are not sent to the new till", async () => {
    const storage = memoryStorage();
    const down = await fakeTill({ key: key(), failConnect: 99 });
    storage.setItem(PAIRING_KEY, JSON.stringify({ code: vector.pairingCode, shop: "trophy", till: "Trophy Till 1" }));
    const r1 = rig({ till: down, storage, paired: false });
    r1.h.prepareFromGesture();
    await r1.settle();
    r1.h.handOff([{ ...ORDER, id: "040", destShop: "trophy" }]);
    await r1.settle();
    const up = await fakeTill({ key: key() });
    storage.setItem("granted", "1");
    const r2 = rig({ till: up, storage }); // paired to marathon-pe now
    r2.h.handOff([ORDER]);
    await r2.until(() => up.journal.size >= 1);
    await r2.settle();
    expect([...up.journal.values()].map((o) => o.destShop)).toEqual(["marathon-pe"]);
    expect(createQueue(storage).list().map((e) => e.payload.order.destShop)).toEqual(["trophy"]);
  });

  it("storage refusing the queue: the order still goes, and the screen says the queue is not saved", async () => {
    const till = await fakeTill({ key: key(), failConnect: 1 });
    const storage = memoryStorage();
    const realSet = storage.setItem;
    storage.setItem = (k, v) => { if (k === "marathon.btHandoff.queue.v1") throw new Error("QuotaExceededError"); return realSet(k, v); };
    const r = rig({ till, storage });
    r.h.prepareFromGesture();
    await r.settle();
    r.h.handOff([ORDER]);
    expect(r.h.status()).toMatchObject({ failing: true });
    await r.until(() => till.journal.size === 1);
    expect(till.journal.size).toBe(1);
  });
});

describe("hand-off — spec review", () => {
  const key = () => parsePairingCode(vector.pairingCode);

  it("a remembered till that keeps refusing to connect is forgotten: the next tap opens the chooser", async () => {
    const till = await fakeTill({ key: key(), failConnect: 3 });
    const storage = memoryStorage();
    storage.setItem("granted", "1");
    const r = rig({ till, storage });
    r.h.handOff([ORDER]);
    await r.until(() => r.h.status().needsGesture === true);
    expect(r.h.status().needsGesture).toBe(true);
    expect(r.chooserCalls()).toBe(0);
    storage.setItem("granted", "");   // Chrome forgot it: only the chooser can bring it back
    r.h.prepareFromGesture();
    await r.until(() => till.journal.size === 1);
    expect(r.chooserCalls()).toBe(1);
    expect(till.journal.size).toBe(1);
  });

  it("a device from getDevices is woken with watchAdvertisements before connecting", async () => {
    const till = await fakeTill({ key: key() });
    let watched = 0;
    const advListeners = new Set();
    till.device.watchAdvertisements = async () => { watched++; };
    till.device.addEventListener = (type, l) => { if (type === "advertisementreceived") advListeners.add(l); };
    till.device.removeEventListener = (type, l) => { if (type === "advertisementreceived") advListeners.delete(l); };
    const storage = memoryStorage();
    storage.setItem("granted", "1");
    const r = rig({ till, storage });
    r.h.handOff([ORDER]);
    await r.until(() => till.journal.size === 1);
    expect(watched).toBe(1);
    expect(advListeners.size).toBe(0); // the timer won; its listener was removed
  });
});

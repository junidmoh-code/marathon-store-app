// Bluetooth order hand-off — the tablet half. See protocol.js for the why.
//
// What staff do: nothing new. The FIRST Place order tap on a paired tablet
// opens Chrome's Bluetooth chooser (filtered to Till 1's service) once; after
// that every placed order is pushed to Till 1 in the background, retried from
// a queue until the till acks it, and the screen says something ONLY when a
// send keeps failing.
//
// Remembering the till:
//  - navigator.bluetooth.getDevices() (Chrome's persistent Web Bluetooth
//    permissions) gives the device back after a restart: chooser once per
//    tablet, ever. Feature-detected; the one-time setup enables it.
//  - without it, the BluetoothDevice stays valid while the app is open, and
//    reconnecting needs no gesture: chooser once per app start.
//
// A tablet that was never paired (no pairing code stored) does nothing at all.

import {
  ACK_UUID, SERVICE_UUID, WRITE_UUID,
  buildMessage, encodeFrames, orderPayload, parseAck, parsePairingCode,
} from "./protocol.js";
import { createQueue } from "./queue.js";

const bytesOf = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

export const PAIRING_KEY = "marathon.btHandoff.pairing.v1";
const MSGID_KEY = "marathon.btHandoff.msgId";
export const RETRY_MS = 15_000;
const ACK_TIMEOUT_MS = 6_000;
// Status shows only when something has been failing for this long.
export const FAIL_AFTER_MS = 45_000;

export function readPairing(storage = globalThis.localStorage) {
  try {
    const p = JSON.parse(storage.getItem(PAIRING_KEY) || "null");
    return p && parsePairingCode(p.code) && p.shop ? p : null;
  } catch {
    return null;
  }
}

export function savePairing(pairing, storage = globalThis.localStorage) {
  storage.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

// The pairing QR on Till 1 opens  https://<store-app>/#bt-pair=CODE&shop=marathon-pe&till=Marathon%20PE%20Till%201
// on the tablet. Store it once and take it out of the address bar.
export function consumePairingHash(loc = globalThis.location, history = globalThis.history, storage = globalThis.localStorage) {
  const m = (loc?.hash || "").match(/^#bt-pair=([^&]+)(.*)$/);
  if (!m) return null;
  const params = new URLSearchParams(m[2].replace(/^&/, ""));
  const code = decodeURIComponent(m[1]);
  const shop = params.get("shop") || "marathon-pe";
  const till = params.get("till") || "Till 1";
  history?.replaceState?.(null, "", loc.pathname + loc.search);
  if (!parsePairingCode(code)) return { ok: false };
  savePairing({ code, shop, till, pairedAt: Date.now() }, storage);
  return { ok: true, shop, till };
}

export function createHandoff({
  bluetooth = globalThis.navigator?.bluetooth,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  log = (...a) => console.warn("[bt-handoff]", ...a),
} = {}) {
  const queue = createQueue(storage, now);
  let device = null;
  let chars = null; // { write, ack }
  let sending = false;
  let retryArmed = false;
  let needsGesture = false;
  let needsRepair = false;
  let lastError = null;
  const listeners = new Set();
  const ackWaiters = new Map(); // msgId -> resolve

  const pairing = () => readPairing(storage);
  const enabled = () => Boolean(bluetooth && pairing());

  function status() {
    const pending = queue.list();
    const oldest = pending.reduce((m, e) => Math.min(m, e.queuedAt), Infinity);
    const failing = needsRepair || (pending.length > 0 && now() - oldest > FAIL_AFTER_MS);
    return { enabled: enabled(), pending: pending.length, failing, needsGesture, needsRepair, lastError, till: pairing()?.till ?? null };
  }
  const emit = () => { const s = status(); listeners.forEach((l) => l(s)); };

  function nextMsgId() {
    let n = Number(storage.getItem(MSGID_KEY)) || 0;
    n = (n + 1) & 0xffff;
    try { storage.setItem(MSGID_KEY, String(n)); } catch { /* counter only needs to differ */ }
    return n;
  }

  function adopt(d) {
    if (!d || d === device) return;
    device = d;
    chars = null;
    d.addEventListener?.("gattserverdisconnected", () => { chars = null; });
  }

  // Find the till without a gesture: the device we already hold, or one this
  // origin was granted before (getDevices).
  async function rememberedDevice() {
    if (device) return device;
    if (typeof bluetooth?.getDevices !== "function") return null;
    try {
      const devices = await bluetooth.getDevices();
      const want = pairing()?.deviceId;
      const d = devices.find((x) => x.id === want) ?? (want ? null : devices[0]);
      if (d) adopt(d);
      return d ?? null;
    } catch {
      return null;
    }
  }

  async function connect() {
    if (chars && device?.gatt?.connected) return chars;
    const d = await rememberedDevice();
    if (!d) {
      needsGesture = true;
      throw new Error("Till 1 not chosen yet");
    }
    const server = d.gatt.connected ? d.gatt : await d.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const write = await service.getCharacteristic(WRITE_UUID);
    const ack = await service.getCharacteristic(ACK_UUID);
    try {
      await ack.startNotifications();
      ack.addEventListener("characteristicvaluechanged", (ev) => {
        const a = parseAck(bytesOf(ev.target.value));
        if (a && ackWaiters.has(a.m)) ackWaiters.get(a.m)(a);
      });
    } catch {
      // Notifications refused: waitAck falls back to reading the value.
    }
    chars = { write, ack };
    needsGesture = false;
    return chars;
  }

  // Registered BEFORE the first write: the till acks inside the last write's
  // response, so a waiter set up afterwards could miss the notification.
  function waitAck(msgId) {
    const started = now();
    let finish;
    const promise = new Promise((resolve) => {
      let done = false;
      finish = (a) => {
        if (done) return;
        done = true;
        ackWaiters.delete(msgId);
        resolve(a);
      };
      ackWaiters.set(msgId, finish);
      // Poll the value too: covers a radio that drops the notification.
      const poll = async () => {
        if (done) return;
        if (now() - started > ACK_TIMEOUT_MS) return finish(null);
        try {
          const v = await chars?.ack.readValue();
          const a = v && parseAck(bytesOf(v));
          if (a && a.m === msgId) return finish(a);
        } catch { /* keep polling until the timeout */ }
        setTimer(poll, 400);
      };
      setTimer(poll, 250);
    });
    return { promise, cancel: () => finish(null) };
  }

  async function sendOne(entry, key) {
    const { write } = await connect();
    const msgId = nextMsgId();
    const message = await buildMessage(key, entry.payload);
    const ack = waitAck(msgId);
    try {
      for (const frame of encodeFrames(msgId, message)) {
        if (typeof write.writeValueWithResponse === "function") await write.writeValueWithResponse(frame);
        else await write.writeValue(frame);
      }
    } catch (e) {
      ack.cancel();
      throw e;
    }
    return ack.promise;
  }

  function armRetry() {
    if (retryArmed || queue.list().length === 0) return;
    retryArmed = true;
    setTimer(() => { retryArmed = false; flush().catch(() => {}); }, RETRY_MS);
  }

  async function flush() {
    if (sending || !enabled()) return;
    sending = true;
    try {
      for (const gone of queue.expire()) log(`gave up on order ${gone.orderId}: never acked by the till`, gone.lastError);
      const key = parsePairingCode(pairing().code);
      for (const entry of queue.list()) {
        let ack = null;
        try {
          ack = await sendOne(entry, key);
        } catch (e) {
          lastError = e?.message || String(e);
          chars = null;
          queue.noteFailure(entry.key, lastError);
          break; // the link is down: everything behind it would fail the same way
        }
        if (ack && (ack.s === "ok" || ack.s === "dup")) {
          queue.remove(entry.key);
          lastError = null;
          needsRepair = false;
        } else if (ack?.s === "mac") {
          // Wrong pairing code: retrying cannot help until it is re-paired.
          needsRepair = true;
          lastError = "Till 1 refused the pairing code";
          queue.noteFailure(entry.key, lastError);
          break;
        } else {
          lastError = ack ? `till answered ${ack.s}${ack.o ? " (" + ack.o + ")" : ""}` : "no answer from the till";
          queue.noteFailure(entry.key, lastError);
        }
      }
    } finally {
      sending = false;
      emit();
      if (!needsRepair) armRetry();
    }
  }

  return {
    status,
    enabled,
    subscribe(fn) { listeners.add(fn); fn(status()); return () => listeners.delete(fn); },

    // Call SYNCHRONOUSLY at the top of the Place order tap handler, before any
    // await: Chrome only opens the device chooser inside a user gesture. It is
    // a no-op once the till is known, and never blocks or fails the order.
    prepareFromGesture() {
      if (!enabled() || device) return;
      const ask = async () => {
        if (await rememberedDevice()) return;
        try {
          const d = await bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
          adopt(d);
          savePairing({ ...pairing(), deviceId: d.id }, storage);
          needsGesture = false;
          flush().catch(() => {});
        } catch (e) {
          lastError = e?.message || String(e); // chooser cancelled, or Bluetooth off
          emit();
        }
      };
      ask().catch(() => {});
    },

    // After the orders are written to /orders. Queues those bound for the
    // paired till's shop and starts sending. Never throws.
    handOff(orders) {
      try {
        const p = pairing();
        if (!p || !bluetooth) return 0;
        let n = 0;
        for (const o of orders) {
          if (o?.destShop !== p.shop || !o.productId) continue;
          if (queue.enqueue(o, orderPayload(o, now()))) n++;
        }
        emit();
        flush().catch(() => {});
        return n;
      } catch (e) {
        log("hand-off failed to queue", e);
        return 0;
      }
    },

    flush,
  };
}

let shared = null;
// The one instance the app uses (a second one would double-send).
export function btHandoff() {
  if (!shared) shared = createHandoff();
  return shared;
}

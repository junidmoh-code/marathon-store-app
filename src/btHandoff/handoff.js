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
  // Runs at module load, before React mounts: it must never throw, or the
  // app never starts (a stray "%" in a typed link, storage blocked).
  try {
    const m = (loc?.hash || "").match(/^#bt-pair=([^&]+)(.*)$/);
    if (!m) return null;
    try { history?.replaceState?.(null, "", loc.pathname + loc.search); } catch { /* leave the hash */ }
    const params = new URLSearchParams(m[2].replace(/^&/, ""));
    const code = decodeURIComponent(m[1]);
    const shop = params.get("shop") || "marathon-pe";
    const till = params.get("till") || "Till 1";
    if (!parsePairingCode(code)) return { ok: false };
    savePairing({ code, shop, till, pairedAt: Date.now() }, storage);
    return { ok: true, shop, till };
  } catch {
    return { ok: false };
  }
}

// Every Web Bluetooth call is time-boxed: a GATT promise that never settles
// (the till walked out of range mid-write) must not wedge the sender.
export const GATT_TIMEOUT_MS = 10_000;
export const FORGET_AFTER_FAILURES = 3;
const ADVERT_WAIT_MS = 5_000;

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
  let dirty = false;
  let retryArmed = false;
  let asking = null;
  let needsGesture = false;
  let needsRepair = false;
  let lastError = null;
  let gattChain = Promise.resolve();
  const listeners = new Set();
  const ackWaiters = new Map(); // msgId -> finish
  const listening = new WeakSet(); // ack characteristics that already have our listener
  const fromGetDevices = new WeakSet();
  let connectFailures = 0;

  // Bounded: resolves on the first advertisement or after a few seconds,
  // whichever is first; connect() is attempted either way.
  async function seenAdvertising(d) {
    let ctl = null;
    try {
      ctl = typeof AbortController === "function" ? new AbortController() : null;
      await new Promise((resolve) => {
        const done = () => resolve();
        d.addEventListener?.("advertisementreceived", done, { once: true });
        setTimer(done, ADVERT_WAIT_MS);
        Promise.resolve(d.watchAdvertisements(ctl ? { signal: ctl.signal } : undefined)).catch(done);
      });
    } catch { /* connect anyway */ } finally {
      try { ctl?.abort(); } catch { /* stopped */ }
    }
  }

  const pairing = () => readPairing(storage);
  const enabled = () => Boolean(bluetooth && pairing());
  // Only entries for the CURRENT pairing's shop are sent: a tablet re-paired
  // to another till keeps the old shop's entries for when it is paired back.
  const mine = () => {
    const shop = pairing()?.shop;
    return shop ? queue.list().filter((e) => e?.payload?.order?.destShop === shop) : [];
  };

  function status() {
    const pending = mine();
    const oldest = pending.reduce((m, e) => Math.min(m, e.queuedAt), Infinity);
    const failing = needsRepair || queue.persistFailed() || (pending.length > 0 && now() - oldest > FAIL_AFTER_MS);
    return {
      enabled: enabled(), pending: pending.length, failing, needsGesture, needsRepair,
      lastError: queue.persistFailed() ? "this tablet cannot save its queue (storage full)" : lastError,
      till: pairing()?.till ?? null,
    };
  }
  const emit = () => { const s = status(); listeners.forEach((l) => { try { l(s); } catch { /* a listener's problem */ } }); };

  function nextMsgId() {
    let n = 0;
    try { n = Number(storage.getItem(MSGID_KEY)) || 0; } catch { n = Math.floor(Math.random() * 0xffff); }
    n = (n + 1) & 0xffff;
    try { storage.setItem(MSGID_KEY, String(n)); } catch { /* counter only needs to differ */ }
    return n;
  }

  function timeout(promise, ms, what) {
    return new Promise((resolve, reject) => {
      let done = false;
      setTimer(() => { if (!done) { done = true; reject(Object.assign(new Error(`${what} timed out`), { timedOut: true })); } }, ms);
      Promise.resolve(promise).then(
        (v) => { if (!done) { done = true; resolve(v); } },
        (e) => { if (!done) { done = true; reject(e); } },
      );
    });
  }

  // Drop the GATT link: Chrome rejects every pending operation on disconnect,
  // so nothing is left half-running on the radio.
  function dropLink() {
    chars = null;
    try { device?.gatt?.disconnect?.(); } catch { /* already gone */ }
  }

  // Android Chrome runs ONE GATT operation at a time and rejects a second
  // ("GATT operation already in progress"), so every call queues behind the
  // last. The slot is freed when the call REALLY settles, not when its
  // deadline passes; a call that outlives its deadline drops the link first.
  function gatt(fn, what, ms = GATT_TIMEOUT_MS) {
    let release;
    const prev = gattChain;
    gattChain = new Promise((r) => { release = r; });
    return prev.then(() => {
      let freed = false;
      const free = () => { if (!freed) { freed = true; release(); } };
      const op = Promise.resolve().then(fn);
      op.then(free, free);
      return timeout(op, ms, what).catch((e) => {
        if (e?.timedOut) { dropLink(); free(); }
        throw e;
      });
    });
  }

  function adopt(d) {
    if (!d || d === device) return;
    device = d;
    chars = null;
    d.addEventListener?.("gattserverdisconnected", () => { chars = null; });
  }

  function rememberDevice(d) {
    adopt(d);
    needsGesture = false;
    try { savePairing({ ...pairing(), deviceId: d.id }, storage); } catch { /* remembered for this session */ }
  }

  // Find the till without a gesture: the device we already hold, or one this
  // origin was granted before (getDevices).
  async function rememberedDevice() {
    if (device) return device;
    if (typeof bluetooth?.getDevices !== "function") return null;
    try {
      const devices = await timeout(bluetooth.getDevices(), GATT_TIMEOUT_MS, "getDevices");
      const want = pairing()?.deviceId;
      const d = devices.find((x) => x.id === want) ?? (want ? null : devices[0]);
      if (d) { adopt(d); fromGetDevices.add(d); }
      return d ?? null;
    } catch {
      return null;
    }
  }

  function onAck(ev) {
    const a = parseAck(bytesOf(ev.target.value));
    if (a && ackWaiters.has(a.m)) ackWaiters.get(a.m)(a);
  }

  async function connect() {
    if (chars && device?.gatt?.connected) return chars;
    const d = await rememberedDevice();
    if (!d) {
      needsGesture = true;
      throw new Error("Till 1 not chosen yet");
    }
    if (!d.gatt.connected && fromGetDevices.has(d) && typeof d.watchAdvertisements === "function") {
      // A device handed back by getDevices() after a restart: Chrome connects
      // to it reliably only once it has been seen advertising again.
      await seenAdvertising(d);
    }
    let server;
    try {
      server = d.gatt.connected ? d.gatt : await gatt(() => d.gatt.connect(), "connect");
      connectFailures = 0;
    } catch (e) {
      // A remembered till that will not connect, again and again (Chrome
      // forgot the pairing, the till got a new radio): forget it, so the next
      // Place order tap opens the chooser instead of "still trying" for ever.
      connectFailures += 1;
      if (connectFailures >= FORGET_AFTER_FAILURES) {
        device = null;
        chars = null;
        connectFailures = 0;
        needsGesture = true;
        try { const p = pairing(); if (p?.deviceId) { const { deviceId: _gone, ...rest } = p; savePairing(rest, storage); } } catch { /* next tap re-saves */ }
      }
      throw e;
    }
    const service = await gatt(() => server.getPrimaryService(SERVICE_UUID), "service");
    const write = await gatt(() => service.getCharacteristic(WRITE_UUID), "write characteristic");
    const ack = await gatt(() => service.getCharacteristic(ACK_UUID), "ack characteristic");
    try {
      await gatt(() => ack.startNotifications(), "notifications");
      if (!listening.has(ack)) {
        ack.addEventListener("characteristicvaluechanged", onAck);
        listening.add(ack);
      }
    } catch {
      // Notifications refused: waitAck falls back to reading the value.
    }
    chars = { write, ack };
    needsGesture = false;
    return chars;
  }

  // Registered BEFORE the first write: the till acks inside the last write's
  // response, so a waiter set up afterwards could miss the notification. The
  // deadline is its own timer, so a hung read cannot stretch it.
  function waitAck(msgId) {
    let finish;
    let done = false;
    const promise = new Promise((resolve) => {
      finish = (a) => {
        if (done) return;
        done = true;
        ackWaiters.delete(msgId);
        resolve(a);
      };
      ackWaiters.set(msgId, finish);
      setTimer(() => finish(null), ACK_TIMEOUT_MS);
    });
    // Polling the value covers a radio that drops the notification. It starts
    // only once every chunk is written (never alongside a write).
    const poll = async () => {
      if (done) return;
      try {
        const v = await gatt(() => chars.ack.readValue(), "ack read", ACK_TIMEOUT_MS);
        const a = v && parseAck(bytesOf(v));
        if (a && a.m === msgId) return finish(a);
      } catch { /* the deadline decides */ }
      if (!done) setTimer(poll, 400);
    };
    return { promise, startPolling: () => setTimer(poll, 250), cancel: () => finish(null) };
  }

  // frames are built (and can fail) BEFORE the radio is touched, so a bad
  // entry is never mistaken for a dead link.
  async function sendOne(msgId, frames) {
    const { write } = await connect();
    const ack = waitAck(msgId);
    try {
      for (const frame of frames) {
        await gatt(() => (typeof write.writeValueWithResponse === "function" ? write.writeValueWithResponse(frame) : write.writeValue(frame)), "write");
      }
    } catch (e) {
      ack.cancel();
      throw e;
    }
    ack.startPolling();
    return ack.promise;
  }

  function armRetry() {
    if (retryArmed || mine().length === 0) return;
    retryArmed = true;
    setTimer(() => { retryArmed = false; flush().catch(() => {}); }, RETRY_MS);
  }

  async function flush() {
    if (sending) { dirty = true; return; } // the running pass goes round again
    if (!enabled()) return;
    sending = true;
    let linkDown = false;
    try {
      do {
        dirty = false;
        for (const gone of queue.expire()) log(`gave up on order ${gone.orderId}: never acked by the till`, gone.lastError);
        const key = parsePairingCode(pairing()?.code);
        if (!key) break;
        for (const entry of mine()) {
          const msgId = nextMsgId();
          let frames;
          try {
            frames = encodeFrames(msgId, await buildMessage(key, entry.payload));
          } catch (e) {
            // This entry cannot be built (too big, no WebCrypto): skip it, the
            // link is fine and the rest of the queue must still go.
            lastError = e?.message || String(e);
            queue.noteFailure(entry.key, lastError);
            continue;
          }
          let ack = null;
          try {
            ack = await sendOne(msgId, frames);
          } catch (e) {
            lastError = e?.message || String(e);
            chars = null;
            queue.noteFailure(entry.key, lastError);
            linkDown = true;
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
      } while (dirty && !linkDown && !needsRepair);
    } finally {
      sending = false;
      dirty = false;
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
    // a no-op once the till is known (or while the chooser is already open),
    // and never blocks or fails the order.
    prepareFromGesture() {
      if (!enabled() || device || asking) return;
      asking = (async () => {
        if (await rememberedDevice()) return;
        let d;
        try {
          d = await bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
        } catch (e) {
          lastError = e?.message || String(e); // chooser cancelled, or Bluetooth off
          emit();
          return;
        }
        rememberDevice(d);
        flush().catch(() => {});
      })().catch(() => {}).finally(() => { asking = null; });
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

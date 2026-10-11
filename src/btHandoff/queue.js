// The tablet's hand-off queue: every order bound for Till 1 waits here until
// the till acks it (ok or dup). localStorage, so a closed app, a reload or a
// flat battery loses nothing - the next start resumes sending. One entry per
// orderKey; enqueueing the same order twice is a no-op.
//
// An order is only collectable on the day it was placed, so an entry the till
// has still not taken after MAX_AGE_MS is dropped (and logged): sending it
// later could never help the customer.

import { orderKeyOf } from "./protocol.js";

export const QUEUE_KEY = "marathon.btHandoff.queue.v1";
export const MAX_AGE_MS = 18 * 60 * 60 * 1000;

function load(storage) {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(storage, list) {
  try {
    storage.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the in-flight send still happens; only the
    // after-restart resume is lost.
  }
}

export function createQueue(storage = globalThis.localStorage, now = () => Date.now()) {
  return {
    list() {
      return load(storage);
    },
    // payload is protocol.orderPayload(order); returns true when newly queued.
    enqueue(order, payload) {
      const list = load(storage);
      const key = orderKeyOf(order);
      if (list.some((e) => e.key === key)) return false;
      list.push({ key, orderId: String(order.id), payload, queuedAt: now(), attempts: 0, lastError: null });
      save(storage, list);
      return true;
    },
    remove(key) {
      save(storage, load(storage).filter((e) => e.key !== key));
    },
    noteFailure(key, error) {
      const list = load(storage);
      const e = list.find((x) => x.key === key);
      if (!e) return;
      e.attempts += 1;
      e.lastError = String(error ?? "unknown");
      e.lastTryAt = now();
      save(storage, list);
    },
    // Drop what can no longer help; returns what was dropped.
    expire() {
      const list = load(storage);
      const cutoff = now() - MAX_AGE_MS;
      const keep = list.filter((e) => e.queuedAt >= cutoff);
      if (keep.length !== list.length) save(storage, keep);
      return list.filter((e) => e.queuedAt < cutoff);
    },
  };
}

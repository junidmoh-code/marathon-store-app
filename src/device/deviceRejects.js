// ─── EVERY PHONE'S REJECTS, AND THE QUARANTINE CHECK BEFORE A PRESS ──────────
//
// On 25 Sep 2026 four Hub 2 orders (#197, #202, #204, #208) were marked Out of
// Stock while the pairs were on the shelf. The order records could not say
// which phone did it: a sneaker "Out of stock" wrote status + time, nothing
// else. It took the RTDB profiler captures on the Mac mini (IP + browser per
// write) to find it — Ayob's login, on a phone that is NOT on MC's shared
// login, so the device enrolment (#647) never saw it and its reject count
// (rejectCount.js, enrolled devices only) stayed at nothing.
//
// This file adds what #647 does not cover:
//
// 1. A REJECT LOG FOR EVERY DEVICE, enrolled or not:
//
//      /device_rejects/{saDay}/{deviceId}/{pushId} = { at, uid, kind, ref, hub, pid, size }
//
//    The order rows recycle daily (/orders ids reset at midnight) and their
//    fields are overwritten by the next status, so this small log is the one
//    durable "how many times has this phone said no". Keyed by SA day FIRST so
//    the Mirror Fleet screen reads a bounded key range (the last 7 days),
//    never the whole node. `at` is serverNowMs(); the console rule
//    (scripts/device-quarantine/) checks it against the server clock and
//    `uid` against the signed-in account.
//
// 2. THE QUARANTINE CHECK BEFORE A PRESS. A phone Junid quarantined on the
//    Mirror Fleet screen (#640, /mirror_switch/quarantine/{deviceId}) gets the
//    full-screen "Show this screen to Junid" — but that screen waits for the
//    phone to be idle, and a press can land first. So every reject and every
//    send asks, BEFORE any stock moves, whether this phone is paused. It
//    fails open (no answer in 3 s = go ahead). The console rule, once pasted,
//    is the server-side half: it refuses any order or request write whose NEW
//    device stamp names a quarantined phone (what it does not cover is listed
//    in scripts/device-quarantine/deviceQuarantineRules.mjs).
//
// Pure except `isThisDeviceQuarantined`, whose read is injected. Every export
// answers null / {} / false on bad input rather than throwing.

import { validDeviceId, quarantineVerdict, quarantinePath } from "./quarantine";

export const DEVICE_REJECTS_NODE = "device_rejects";

// The SA day of an instant. SA is UTC+2 all year (no daylight saving) — the
// same formula as serverTime.saDateStringAt, kept here so this module stays
// pure and needs nothing mocked.
const SA_OFFSET_MS = 2 * 3600e3;
export function saDayOf(ms) {
  return new Date(Number(ms) + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Where ONE reject is logged, or null when there is no safe place. */
export function deviceRejectsPath(deviceId, atMs) {
  if (!validDeviceId(deviceId) || !Number.isFinite(Number(atMs))) return null;
  return `${DEVICE_REJECTS_NODE}/${saDayOf(atMs)}/${deviceId}`;
}

/**
 * The log record. Small on purpose — the Fleet screen downloads a week of
 * these. `kind` says which button: "order" (a customer order Out of stock),
 * "clothing" (a shop-refill line Rejected), "request" (a refill request Out of
 * Stock in the queue).
 */
export function deviceRejectRecord({ kind, ref, hub, productId, size, uid, atMs }) {
  return {
    at: Number(atMs),
    uid: typeof uid === "string" && uid ? uid : null,
    kind: String(kind || "order"),
    ref: ref == null ? null : String(ref),
    hub: hub ? String(hub) : null,
    pid: productId ? String(productId) : null,
    size: size == null ? null : String(size),
  };
}

/**
 * Tally a key range of /device_rejects ({ day: { deviceId: { pushId: rec } } })
 * per device: rejects today, rejects in the range, and the latest one's time
 * and account. Malformed entries are skipped, never counted.
 */
export function tallyDeviceRejects(byDay, { today } = {}) {
  const out = {};
  if (!byDay || typeof byDay !== "object") return out;
  for (const [day, devices] of Object.entries(byDay)) {
    if (!devices || typeof devices !== "object") continue;
    for (const [deviceId, entries] of Object.entries(devices)) {
      if (!entries || typeof entries !== "object") continue;
      for (const rec of Object.values(entries)) {
        if (!rec || typeof rec !== "object" || !Number.isFinite(rec.at)) continue;
        const t = out[deviceId] || (out[deviceId] = { today: 0, total: 0, lastAt: 0, lastUid: null });
        t.total += 1;
        if (day === today) t.today += 1;
        if (rec.at > t.lastAt) { t.lastAt = rec.at; t.lastUid = rec.uid || null; }
      }
    }
  }
  return out;
}

export const PAUSED_MESSAGE =
  "This phone has been paused by Junid. Nothing was changed. Please bring it to Junid.";

/**
 * Is THIS device quarantined, by a live read of its own flag? `read(path)`
 * resolves the raw value. FAILS OPEN — no id, a refused read, or no answer
 * within `timeoutMs` means "not quarantined": the database rule is the
 * backstop, and a hub must never stop trading because this check could not
 * be made. (Same stance as src/device/quarantine.js.)
 */
export async function isThisDeviceQuarantined({ deviceId, read, timeoutMs = 3000 }) {
  const path = quarantinePath(deviceId);
  if (!path) return false;
  let timer = null;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => read(path)),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return quarantineVerdict(answer);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

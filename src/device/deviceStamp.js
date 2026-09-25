// ─── THE DEVICE STAMP — WHO, ON WHICH DEVICE, WHEN ───────────────────────────
//
// Every order action (fulfil, reject, transfer, …) and every stock-changing
// write carries one of these:
//
//   { deviceId, personName, atMs, action? }
//
// deviceId and personName come from the device's enrolment (its signed token,
// read by AuthGate into src/device/enrolment.js) — so on MC's shared login
// they name the PERSON who entered the code on that phone, not "MC". On a
// login without codes they are the browser's own device id and the account's
// name. atMs is serverNowMs(), never Date.now(): a till with a wrong clock
// must not write a wrong time.
//
// Stock movements carry it as `by` (applyMovement.js). Orders, refill requests
// and transfers keep a small history under `stamps/{atMs_device}` so a second
// action never overwrites the first — a key per action, written in the same
// update() as the action itself.

import { serverNowMs } from "../utils/serverTime";
import { getDeviceIdentity } from "./enrolment";
import { getDeviceId } from "./deviceId";

export function deviceStamp(action) {
  const id = getDeviceIdentity() || {};
  const s = {
    deviceId: id.deviceId || getDeviceId() || null,
    personName: id.personName || null,
    atMs: serverNowMs(),
  };
  if (action) s.action = String(action).slice(0, 40);
  return s;
}

// RTDB-safe and unique enough: the same device cannot act twice in one ms.
export function stampKey(s) {
  const dev = String(s?.deviceId || "nodevice").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "nodevice";
  return `${Number(s?.atMs) || 0}_${dev}`;
}

// For an update() patch on the record's own ref: adds `stamps/{key}`.
export function stampPatch(patch, action) {
  const s = deviceStamp(action);
  return { ...patch, [`stamps/${stampKey(s)}`]: s };
}

// For a whole record written with set() or returned from a transaction.
export function stampRecord(record, action) {
  const s = deviceStamp(action);
  const prev = record && typeof record.stamps === "object" && record.stamps ? record.stamps : {};
  return { ...record, stamps: { ...prev, [stampKey(s)]: s } };
}

// For a transaction body: the committed record carries the stamp; an abort
// (undefined) or a cold-cache probe (null) passes through untouched.
export function stampTxn(fn, action) {
  return (cur) => {
    const next = fn(cur);
    return next && typeof next === "object" ? stampRecord(next, action) : next;
  };
}

// For a multi-path update() at the database ROOT: the stamp for one record.
export function stampAt(recordPath, action) {
  const s = deviceStamp(action);
  return { [`${recordPath}/stamps/${stampKey(s)}`]: s };
}

// A short name for what an order patch does, for the stamp's `action`.
export function orderActionName(patch) {
  if (!patch || typeof patch !== "object") return "update";
  if (typeof patch.status === "string" && patch.status) return patch.status;
  const keys = Object.keys(patch).filter((k) => !/At$|^updated|^stamps/.test(k));
  return keys.length ? keys.slice(0, 2).join("+") : "update";
}

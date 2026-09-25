// ─── REJECT COUNT — ONE MORE ON THIS DEVICE'S RECORD ─────────────────────────
// Junid's device list shows how many rejects (Out of Stock on a request, Hub 2
// "not in stock") each enrolled device has pressed. Counted at the press, on
// the device's own record: the rule lets a live enrolment add exactly one to
// its own /device_enrolment/devices/{id}/rejectCount and nothing else. A
// device that is not enrolled (another login) has no record and counts
// nothing. Fire-and-forget: a count must never hold up or fail a reject.
//
// EVERY DEVICE, TOO (2026-09-25): the same press is also logged, with what was
// rejected, to /device_rejects/{saDay}/{deviceId} for ANY device — the phone
// that falsely rejected #197/#202/#204/#208 was on Ayob's own login, which is
// not enrolled, so the count above never saw it. The Mirror Fleet screen
// counts that log. Why and how: src/device/deviceRejects.js.
import { get, increment, push, ref, set } from "firebase/database";
import { database, auth } from "../firebase";
import { getDeviceIdentity } from "./enrolment";
import { deviceStamp } from "./deviceStamp";
import { deviceRejectsPath, deviceRejectRecord, isThisDeviceQuarantined } from "./deviceRejects";
import { readCachedQuarantine } from "./quarantine";

/**
 * @param {{kind?: string, ref?: string, hub?: string, productId?: string, size?: string}} [what]
 *        what was rejected, for the every-device log. Returns the stamp used
 *        ({ deviceId, atMs, uid }) so the caller can record the same phone on
 *        the record it rejected.
 */
export function countReject(what = {}) {
  const s = deviceStamp("reject");
  const uid = auth.currentUser?.uid || null;
  const id = getDeviceIdentity();
  if (id?.enrolled && id.deviceId) {
    set(ref(database, `device_enrolment/devices/${id.deviceId}/rejectCount`), increment(1))
      .catch((e) => console.warn("reject count not recorded:", e?.message || e));
  }
  const path = deviceRejectsPath(s.deviceId, s.atMs);
  if (path) {
    push(ref(database, path), deviceRejectRecord({ ...what, uid, atMs: s.atMs }))
      .catch((e) => console.warn("device reject log not recorded:", e?.message || e));
  }
  return { deviceId: s.deviceId || null, atMs: s.atMs, uid };
}

/**
 * Has Junid quarantined THIS phone? Asked before any reject or send moves
 * anything. Fails open (see deviceRejects.js); the console rule is the
 * server-side half.
 */
//
// COST: normally nothing. src/device/DeviceQuarantine.jsx keeps a listener on
// this exact path on every signed-in phone, and the SDK answers get() from an
// active listener's data without a round trip (repoGetValue). A flag already
// heard is also cached in localStorage and answers first. Only a phone with no
// live listener waits, and never longer than 1.5 s before going ahead.
export async function thisDevicePaused() {
  const deviceId = deviceStamp().deviceId;
  if (readCachedQuarantine(deviceId)) return true;
  return isThisDeviceQuarantined({
    deviceId, timeoutMs: 1500,
    read: async (path) => (await get(ref(database, path))).val(),
  });
}

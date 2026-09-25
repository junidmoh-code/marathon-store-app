// ─── REJECT COUNT — ONE MORE ON THIS DEVICE'S RECORD ─────────────────────────
// Junid's device list shows how many rejects (Out of Stock on a request, Hub 2
// "not in stock") each enrolled device has pressed. Counted at the press, on
// the device's own record: the rule lets a live enrolment add exactly one to
// its own /device_enrolment/devices/{id}/rejectCount and nothing else. A
// device that is not enrolled (another login) has no record and counts
// nothing. Fire-and-forget: a count must never hold up or fail a reject.
import { increment, ref, set } from "firebase/database";
import { database } from "../firebase";
import { getDeviceIdentity } from "./enrolment";

export function countReject() {
  const id = getDeviceIdentity();
  if (!id?.enrolled || !id.deviceId) return;
  set(ref(database, `device_enrolment/devices/${id.deviceId}/rejectCount`), increment(1))
    .catch((e) => console.warn("reject count not recorded:", e?.message || e));
}

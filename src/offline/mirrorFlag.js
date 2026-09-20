// ─── OFFLINE MIRROR — the enable flag ────────────────────────────────────────
//
// Default OFF: with the flag unset, bootstrap.js returns before touching
// anything and the app's behaviour is byte-for-byte what it was. The flag is a
// per-device string in localStorage — a lone string has none of the
// read-modify-write hazard that bans localStorage for mirror DATA.
//
// THE SETUP DOWNLOAD IS NOT OPTIONAL AND HAS NO STAFF TOGGLE. This flag is the
// ROLLOUT control, not a preference: it is "is this device in the trial yet",
// set by a person rolling the feature out, and once it is on the download
// starts by itself on the next open with a blocking setup screen. There is
// deliberately no UI anywhere in this app that writes it, because a per-staff
// "work offline" switch is exactly how half a shop ends up on one code path and
// half on the other with nobody able to say which.
//
// Three states, because "not yet decided" is a real one:
//   "on"   — mirror runs, setup screen blocks until the data legs finish
//   "off"  — absent or anything else; the app behaves exactly as before
//
// See docs/store-offline-mirror.md §11 for the rollout this gates.

// ── AND THE REMOTE KILL SWITCH ──────────────────────────────────────────────
//
// Since PR #623 the per-device flag is only half the answer. `/mirror_switch/
// enabled` in the database is the other half, and it is an AND: a device
// mirrors only if it is in the rollout AND the fleet switch is on. Set the
// switch to false and every device drops to live reads on the spot, with no
// reload and no deploy, because this is the one function every mirror read
// path already calls. See killSwitch.js.

import { mirrorSwitchOn } from "./killSwitch";

export const MIRROR_FLAG_KEY = "marathon-store.offlineMirror";

export function deviceInRollout({ storage } = {}) {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    return !!s && s.getItem(MIRROR_FLAG_KEY) === "on";
  } catch {
    return false; // storage refused (private mode etc.) reads as OFF
  }
}

export function offlineMirrorEnabled(opts) {
  return deviceInRollout(opts) && mirrorSwitchOn();
}

// Used by the rollout, and by the tests that prove the app is unchanged with
// the flag off. Not called from any component.
export function setOfflineMirrorEnabled(on, { storage } = {}) {
  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return false;
  try {
    if (on) s.setItem(MIRROR_FLAG_KEY, "on");
    else s.removeItem(MIRROR_FLAG_KEY);
    return true;
  } catch { return false; }
}

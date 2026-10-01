// ─── OFFLINE MIRROR — ONE DEVICE OFF, WITHOUT TOUCHING THE FLEET ─────────────
//
// The kill switch is all-or-nothing: /mirror_switch/enabled stops every device
// in the shop. This is the other half — a flag that stops exactly one handset
// mirroring while the other twenty-nine carry on:
//
//   /mirror_switch/off/<deviceId> = true   →  THIS device never mirrors
//   absent, or anything else               →  this device is unaffected
//
// ── WHY IT LIVES UNDER /mirror_switch ───────────────────────────────────────
//
// Because the rules already say the right thing about that node: readable by
// any signed-in staff member (so a device can read its own flag) and writable
// only by the owner (so only he can set one). Putting it anywhere else would
// need a new rule pasted into the console before a single device could obey
// it, and a switch that needs a deploy-shaped prerequisite is not a switch.
// killSwitch.js anticipated exactly this — devices subscribe to the CHILD
// `enabled`, so a sibling here costs the fleet nothing.
//
// It could NOT live in /mirror_devices/<deviceId>: a device rewrites that
// record wholesale every time it reports, so an owner-set field there would be
// erased within ten minutes, and the node is owner-read-only, so the device
// could not have read it anyway.
//
// ── THE DEFAULT IS THE OPPOSITE OF THE KILL SWITCH, ON PURPOSE ──────────────
//
// For the fleet switch, "never heard an answer" means OFF: the safe direction
// is reading live, because that is what the app did for two years and it is
// never wrong, only expensive.
//
// Here the safe direction is the other way. This flag is ABSENT for every
// healthy device, so treating "absent" or "could not read" as "stop
// mirroring" would take the whole fleet off the mirror the first time the read
// failed — the exact fleet-wide outcome this exists to avoid. So only a value
// somebody deliberately wrote turns a device off, and everything else,
// including silence and failure, leaves the device exactly as the fleet switch
// left it.
//
// ── WHAT IT IS KEYED ON, AND THE ONE WAY THAT BREAKS ────────────────────────
//
// The deviceId from src/device/deviceId.js, which lives in localStorage. On
// the handset this was written for, the browser has been evicting IndexedDB
// (the mirror's copy) while leaving localStorage alone — the same deviceId has
// been reporting across every wipe since 21 September — so the flag sticks
// where it is needed. If a device's localStorage is ALSO cleared it mints a
// new id and the flag stops applying to it. That is a real limit, it is why
// the Mirror Fleet screen shows the flag per device rather than by person, and
// a device that comes back under a new id will show up there as a new row
// spending real bytes.

import { getDeviceId } from "../device/deviceId";

// The node, and the child this device watches. One boolean, by exact path:
// never the parent, which would hand every device the whole list.
export const DEVICE_OFF_ROOT = "mirror_switch/off";
export const deviceOffPath = (deviceId) => `${DEVICE_OFF_ROOT}/${deviceId}`;

export const DEVICE_OFF_CACHE_KEY = "marathon-store.offlineMirror.deviceOff";

let state = null;        // { off, at } once heard; null until then
let loaded = false;
let watching = false;
const listeners = new Set();

/**
 * What a raw value at /mirror_switch/off/<deviceId> means.
 *
 * Pure and exported so the asymmetry is visible rather than inferred: only a
 * value somebody wrote on purpose is OFF. `true`, or a string saying so.
 * Everything else — false, 0, "no", an object, and ABSENT — is not off.
 */
export function deviceOffVerdict(raw) {
  if (raw === true || raw === 1) return true;
  if (typeof raw === "string" && /^(true|on|yes|1|off)$/i.test(raw.trim())) return true;
  return false;
}

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DEVICE_OFF_CACHE_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.off === "boolean") state = { off: parsed.off, at: parsed.at ?? null };
  } catch { /* a cache that cannot be read is simply no cache */ }
}

/**
 * Is THIS device switched off, right now, synchronously?
 *
 * Synchronous for the same reason mirrorSwitchOn() is: the hook gate decides
 * on its first render whether to open a live subscription, and an answer that
 * arrives after that decision arrives after the money is spent.
 */
export function deviceMirrorOff() {
  loadCache();
  return state?.off === true;
}

export function deviceMirrorOffKnown() {
  loadCache();
  return state !== null;
}

export function deviceMirrorOffState() {
  loadCache();
  return state ? { ...state, known: true } : { off: false, at: null, known: false };
}

/** Record an answer and tell everyone listening. The only way the value moves. */
export function setDeviceOffValue(raw, { now = Date.now } = {}) {
  loadCache();
  const off = deviceOffVerdict(raw);
  const changed = state?.off !== off;
  state = { off, at: now() };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DEVICE_OFF_CACHE_KEY, JSON.stringify(state));
    }
  } catch { /* private mode: the answer holds for this tab, which still works */ }
  for (const l of listeners) { try { l(off); } catch { /* a listener never breaks the flag */ } }
  return changed;
}

/**
 * A read that FAILED. Leaves the cached value alone — a device already told to
 * stop must stay stopped through a dropped line, and a device never told
 * anything must not be stopped by one.
 */
export function noteDeviceOffUnreadable(err) {
  console.warn("offline mirror: could not read this device's off flag —", err?.message ?? err);
}

export function subscribeDeviceOff(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the live subscription. Idempotent. `subscribe` is injected so this
 * module has no firebase import of its own and can be tested against a plain
 * function.
 */
export function watchDeviceOff({ subscribe, deviceId = getDeviceId() }) {
  if (watching) return () => {};
  // No device id (private mode, storage disabled) means no flag can be keyed
  // to this browser. It is left mirroring, which is what it did before this
  // existed, rather than guessing at an identity.
  if (!deviceId) return () => {};
  watching = true;
  let stop = () => {};
  try {
    stop = subscribe(
      (value) => setDeviceOffValue(value),
      (err) => noteDeviceOffUnreadable(err),
      deviceId,
    ) ?? (() => {});
  } catch (err) {
    watching = false;
    noteDeviceOffUnreadable(err);
    return () => {};
  }
  return () => {
    watching = false;
    try { stop(); } catch { /* ignore */ }
  };
}

export function deviceOffIsWatched() { return watching; }

// Test seam: the module holds process-wide state, and a test that flips the
// flag must be able to put it back.
export function resetDeviceOffForTests() {
  state = null; loaded = false; watching = false; listeners.clear();
  try { localStorage?.removeItem(DEVICE_OFF_CACHE_KEY); } catch { /* ignore */ }
}

// ── THE LIVE READ ───────────────────────────────────────────────────────────
// firebase/database imported lazily, inside the call, so this module stays
// importable by the synchronous read paths without pulling the SDK in behind
// it. One onValue on one boolean, by exact path.
export function watchDeviceOffLive() {
  return watchDeviceOff({
    subscribe: (onAnswer, onError, deviceId) => {
      let unsub = null;
      let cancelled = false;
      (async () => {
        try {
          const [{ ref, onValue }, { database }] = await Promise.all([
            import("firebase/database"),
            import("../firebase"),
          ]);
          if (cancelled) return;
          unsub = onValue(
            ref(database, deviceOffPath(deviceId)),
            (snap) => onAnswer(snap.exists() ? snap.val() : null),
            (err) => onError(err),
          );
        } catch (err) {
          onError(err);
        }
      })();
      return () => { cancelled = true; try { unsub && unsub(); } catch { /* ignore */ } };
    },
  });
}

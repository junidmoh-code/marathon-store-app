// ─── OFFLINE MIRROR — "something you are reading has changed" ────────────────
//
// A screen reading from the local copy has no onValue to wake it. When the
// change feed applies a page, every screen showing an affected node has to
// re-read — and only those.
//
// PER LEG, NOT GLOBAL. A global counter would re-read /insights_log (112,968
// rows) on every /orders change, several times a minute, on a tablet. So each
// leg carries its own version and a subscriber names the legs it cares about.
//
// Framework-free and synchronous, so it can be the getSnapshot source for
// useSyncExternalStore without a store wrapper. The version is a NUMBER rather
// than a timestamp: two changes inside one millisecond must be two versions.

const versions = new Map();
const listeners = new Set();

export function legVersion(leg) {
  return versions.get(leg) ?? 0;
}

// A stable string for a set of legs, so useSyncExternalStore can compare it by
// value. Returning an object or an array would allocate on every call and put
// React into an infinite re-render.
export function versionKey(legs) {
  let out = "";
  for (const leg of legs) out += `${leg}:${legVersion(leg)};`;
  return out;
}

export function bumpLegs(legs) {
  let changed = false;
  for (const leg of legs ?? []) {
    versions.set(leg, (versions.get(leg) ?? 0) + 1);
    changed = true;
  }
  if (changed) for (const l of listeners) l();
  return changed;
}

export function subscribeMirror(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetMirrorSignalForTests() {
  versions.clear();
  listeners.clear();
}

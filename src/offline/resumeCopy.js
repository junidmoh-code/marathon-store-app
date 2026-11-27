// ─── SAVED COPIES FOR A COLD START (Junid, 27 Nov 2026) ──────────────────────
//
// When a phone throws the page away while it is in the background, coming back
// is a cold start, and the screen used to sit on "Loading…" until the network
// answered (AuthGate waits for /users/{uid}). The offline mirror already holds
// the big nodes on the device. This holds the last good answer of the few small
// reads that are NOT mirror legs, so the screen can paint from it at once and
// swap in the live answer when it lands.
//
// NOT A SECOND CACHE. It lives in the mirror's own IndexedDB database, in its
// `meta` store, under keys starting "resume|" (no schema change, no new
// database), and it is cleared whenever the signed-in person changes or signs
// out. It is never a data source on its own:
//
//   - a saved copy is offered only to the SAME uid that saved it;
//   - it is offered only until the live answer arrives, and the caller marks
//     the screen "Updating…" meanwhile (resumeFreshness.js);
//   - nothing that acts (stock moves, requests) reads through this.
//
// Size-capped (RESUME_MAX_BYTES of JSON) and write-throttled: a value that
// changes every few seconds is written at most every RESUME_WRITE_EVERY_MS,
// with the newest value always the one that lands.

import { onIdentityChange } from "../utils/identityChange";

export const RESUME_PREFIX = "resume|";
export const RESUME_MAX_BYTES = 128 * 1024;
export const RESUME_WRITE_EVERY_MS = 30 * 1000;

export function createResumeCopies({
  getDb,
  now = () => Date.now(),
  maxBytes = RESUME_MAX_BYTES,
  writeEveryMs = RESUME_WRITE_EVERY_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  warn = (...a) => console.warn(...a),
} = {}) {
  if (typeof getDb !== "function") throw new Error("createResumeCopies: getDb is required");
  const mem = new Map();        // full key -> { uid, at, value }
  const lastWrite = new Map();  // full key -> ms of the last write
  const trailing = new Map();   // full key -> timer of a pending write
  let epoch = 0;                // bumped by clearAll: a write queued before it must not land after it

  const fullKey = (uid, key) => `${RESUME_PREFIX}${uid}|${key}`;

  const write = (fk, rec, myEpoch) => {
    lastWrite.set(fk, now());
    Promise.resolve().then(getDb).then((db) => {
      if (myEpoch !== epoch) return undefined;
      return db.setMeta(fk, rec);
    }).catch((err) => warn("resume copy: could not save —", err?.message ?? err));
  };

  return {
    /** The saved copy for this uid, or null. Never throws. */
    async load(uid, key) {
      if (!uid || !key) return null;
      const fk = fullKey(uid, key);
      if (mem.has(fk)) { const r = mem.get(fk); return { value: r.value, at: r.at }; }
      const myEpoch = epoch;
      try {
        const db = await getDb();
        const rec = await db.getMeta(fk);
        if (myEpoch !== epoch) return null;
        if (!rec || rec.uid !== uid || !("value" in rec)) return null;
        if (!mem.has(fk)) mem.set(fk, rec);
        const r = mem.get(fk);
        return { value: r.value, at: r.at };
      } catch {
        return null;
      }
    },
    /** Synchronous: only what this page has already loaded or saved. */
    peek(uid, key) {
      if (!uid || !key) return null;
      const r = mem.get(fullKey(uid, key));
      return r ? { value: r.value, at: r.at } : null;
    },
    /** Remember the latest LIVE answer. Returns false when it was not kept. */
    save(uid, key, value) {
      if (!uid || !key || value === undefined) return false;
      let json;
      try { json = JSON.stringify(value); } catch { return false; }
      if (typeof json !== "string" || json.length > maxBytes) return false;
      const fk = fullKey(uid, key);
      const rec = { uid, at: now(), value };
      mem.set(fk, rec);
      const myEpoch = epoch;
      const since = now() - (lastWrite.get(fk) ?? -Infinity);
      if (since >= writeEveryMs) {
        if (trailing.has(fk)) { clearTimer(trailing.get(fk)); trailing.delete(fk); }
        write(fk, rec, myEpoch);
      } else if (!trailing.has(fk)) {
        trailing.set(fk, setTimer(() => {
          trailing.delete(fk);
          const latest = mem.get(fk);
          if (latest && myEpoch === epoch) write(fk, latest, myEpoch);
        }, writeEveryMs - since));
      }
      return true;
    },
    /** Sign-out / another person: forget every saved copy, here and on disk. */
    async clearAll() {
      epoch += 1;
      mem.clear();
      lastWrite.clear();
      for (const t of trailing.values()) clearTimer(t);
      trailing.clear();
      try {
        const db = await getDb();
        const keys = (await db.getAllKeys("meta")) || [];
        const doomed = keys.filter((k) => typeof k === "string" && k.startsWith(RESUME_PREFIX));
        if (doomed.length) await db.deleteMetaMany(doomed);
      } catch { /* no database: nothing was saved there */ }
    },
  };
}

// ── THE APP'S ONE INSTANCE ───────────────────────────────────────────────────
let instance = null;
export function resumeCopies() {
  if (!instance) {
    instance = createResumeCopies({
      getDb: async () => (await import("./mirrorDbHandle")).getMirrorDbHandle(),
    });
    try { onIdentityChange(() => { instance.clearAll(); }); } catch { /* no auth (tests) */ }
  }
  return instance;
}
export function _setResumeCopiesForTests(next) { instance = next; }

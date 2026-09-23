// ─── OFFLINE MIRROR — IS THE BROWSER THROWING THIS DEVICE'S COPY AWAY? ───────
//
// A browser may delete a site's IndexedDB when the phone is short of space,
// unless the site's storage is "persisted". When it does, the mirror starts
// again from nothing: a ~104 MB download, then another, then another. On the
// Mirror Fleet screen that device looked BUSY — "downloading its copy" — when
// the truth was that its browser kept evicting it (one Android handset, 23 Sep
// 2026: 334.9 MB in a morning against 0.30 MB for a healthy phone on the same
// account and build).
//
// So each device now counts its own wipes and reports them, by name, with
// whether its storage is persisted.
//
// ── HOW A WIPE IS SEEN ─────────────────────────────────────────────────────
//
// The mirror's database stamps `schemaVersion` the first time it opens, and
// nothing this app does ever removes it again — a deliberate delete keeps it
// (db.purgeEverything), a schema bump overwrites it. So a database that opens
// WITHOUT it, on a device that has opened one before, has been deleted from
// outside the app. "Has opened one before" cannot be kept in IndexedDB — that
// is the thing being deleted — so it is kept in localStorage, which the
// browser does not evict with it (the evicting handset kept one device id
// through every wipe). The count then goes to /mirror_devices with the rest
// of the device's report, so it survives even a wipe of localStorage itself.

import { sastDate } from "./deviceHealth";

export const STORAGE_LEDGER_KEY = "marathon-store.offlineMirror.storageLedger";

function readLedger() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_LEDGER_KEY) : null;
    const l = raw ? JSON.parse(raw) : null;
    if (l && typeof l === "object") {
      return {
        hadCopy: l.hadCopy === true,
        wipes: Number.isFinite(l.wipes) ? l.wipes : 0,
        lastWipeAt: Number.isFinite(l.lastWipeAt) ? l.lastWipeAt : null,
        wipesDate: typeof l.wipesDate === "string" ? l.wipesDate : null,
        wipesToday: Number.isFinite(l.wipesToday) ? l.wipesToday : 0,
      };
    }
  } catch { /* an unreadable ledger is a fresh one */ }
  return { hadCopy: false, wipes: 0, lastWipeAt: null, wipesDate: null, wipesToday: 0 };
}

function writeLedger(l) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_LEDGER_KEY, JSON.stringify(l)); }
  catch { /* private mode: no ledger, no count — never a failure */ }
}

/**
 * Called once per start, with whether the mirror's database already carried
 * its schema stamp BEFORE this start stamped it. Returns the ledger, counted.
 */
export function noteMirrorOpened({ hadSchema, now = Date.now }) {
  const l = readLedger();
  const at = now();
  if (!hadSchema && l.hadCopy) {
    const today = sastDate(at);
    l.wipes += 1;
    l.lastWipeAt = at;
    l.wipesToday = l.wipesDate === today ? l.wipesToday + 1 : 1;
    l.wipesDate = today;
  }
  l.hadCopy = true;
  writeLedger(l);
  return l;
}

/** The ledger as the report shows it: wipes today are TODAY's, in SAST. */
export function wipeLedger({ now = Date.now } = {}) {
  const l = readLedger();
  return {
    wipes: l.wipes,
    wipesToday: l.wipesDate === sastDate(now()) ? l.wipesToday : 0,
    lastWipeAt: l.lastWipeAt,
  };
}

// ── PERSISTED? ─────────────────────────────────────────────────────────────
// Asked for once per start (persist()), and read back at report time
// (persisted()), because a browser may grant it later — Chrome decides by
// engagement and installation — and the screen should say so when it does.
let persistedNow = null;
let quota = null;

export async function requestPersistence() {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    persistedNow = (await navigator.storage.persist()) === true;
  } catch { /* not available */ }
  return persistedNow;
}

export async function storageSnapshot({ now = Date.now } = {}) {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persisted) {
      persistedNow = (await navigator.storage.persisted()) === true;
    }
  } catch { /* keep the last answer */ }
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      quota = {
        usageMB: Number.isFinite(e?.usage) ? Math.round(e.usage / 1e5) / 10 : null,
        quotaMB: Number.isFinite(e?.quota) ? Math.round(e.quota / 1e5) / 10 : null,
      };
    }
  } catch { /* keep the last answer */ }
  return {
    persisted: persistedNow,
    ...wipeLedger({ now }),
    usageMB: quota?.usageMB ?? null,
    quotaMB: quota?.quotaMB ?? null,
  };
}

export function _resetStorageHealthForTests() { persistedNow = null; quota = null; }

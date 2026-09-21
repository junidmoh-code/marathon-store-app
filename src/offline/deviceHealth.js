// ─── OFFLINE MIRROR — WHAT EACH DEVICE REPORTS ABOUT ITSELF ──────────────────
//
// Every device in the fleet is now serving screens from its own copy of the
// shop. The question that used to be answerable by looking at one tablet —
// "is this thing actually working?" — is now twenty-odd questions, on
// twenty-odd devices, most of them in someone's hand in another room.
//
// So each device writes one small record about itself to /mirror_devices/
// {deviceId}, and a super-admin screen lists the lot. It answers exactly the
// five things that matter when something is wrong:
//
//   · is this device's copy COMPLETE, and when did it last sync?
//   · how many BYTES has it spent today? (the whole point of the mirror)
//   · which BUILD is it on? (a device on last week's bundle explains a lot)
//   · has a GUARD tripped — a shrink refused, a census drift, an empty read?
//   · is it obeying the fleet switch?
//
// ── IT MUST NOT BECOME A COST OF ITS OWN ────────────────────────────────────
//
// A health beacon that reports every pass would write 1,440 times a day per
// device, and this is a card about the cost of reading and writing the
// database. So a write happens only when something a person would ACT on has
// changed, and never more often than once every WRITE_EVERY_MS — except a
// guard tripping, which is reported at once because it is the thing the screen
// exists for. About 300 bytes, a handful of times a day: call it 2 KB per
// device per day against the 1.15 MB the mirror is saving.
//
// ── THE BYTES ARE MEASURED, NOT ESTIMATED ───────────────────────────────────
//
// `bytesToday` is the JSON length of everything the adapter actually read,
// plus the thumbnails actually fetched, counted as they happen and reset at
// the SAST date boundary. It is the honest answer to "did this work?", and it
// is deliberately the device's own measurement rather than a share of a
// billing total: a fleet number cannot tell you WHICH tablet is the expensive
// one, and that is always the question.

import { getDeviceId } from "../device/deviceId";
import { describeDevice, isStandalone } from "../push/deviceLabel";

export const DEVICES_ROOT = "mirror_devices";

// The floor between ordinary reports. A guard tripping ignores it.
export const WRITE_EVERY_MS = 10 * 60 * 1000;

// The byte counter is per TRADING DAY, and this shop trades in SAST. A
// counter that rolled over at UTC midnight would cut the day at 02:00 local
// and split every late shift in two.
export const SAST_OFFSET_MS = 2 * 3600 * 1000;
export function sastDate(at = Date.now()) {
  return new Date(at + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

export const BYTES_META = "health.bytesToday";

/**
 * The running byte count for today, rolled over at the SAST boundary.
 *
 * Kept in the mirror's own IndexedDB rather than in memory so a tablet that is
 * closed and reopened four times in a day reports one day's bytes and not the
 * last twenty minutes of it.
 */
export async function addBytes(db, bytes, { now = Date.now } = {}) {
  if (!(bytes > 0)) return null;
  const date = sastDate(now());
  const held = await db.getMeta(BYTES_META);
  const next = (held && held.date === date)
    ? { date, bytes: held.bytes + bytes, reads: (held.reads ?? 0) + 1 }
    : { date, bytes, reads: 1 };
  await db.setMeta(BYTES_META, next);
  return next;
}

export async function bytesToday(db, { now = Date.now } = {}) {
  const held = await db.getMeta(BYTES_META);
  if (!held || held.date !== sastDate(now())) return { date: sastDate(now()), bytes: 0, reads: 0 };
  return held;
}

/**
 * The FIRST guard to have tripped, out of the leg health records.
 *
 * Named rather than counted: "a guard tripped" is not actionable and "products
 * refused a read that would have shrunk it from 4,945 rows to 799" is. The
 * reasons are health.js's own vocabulary, untranslated, because the person
 * reading this screen is the person who would grep for them.
 */
export function guardTripped(legs) {
  const bad = (legs ?? []).filter((l) => l && l.ok === false && l.reason);
  if (bad.length === 0) return null;
  // A refused swap or a census drift outranks a timeout: one says the copy
  // disagrees with the server, the other says the line was slow.
  // A leg this device has stopped trying outranks everything: it is the one
  // that will not fix itself before somebody looks.
  const RANK = {
    "gave-up": 0, "feed-stuck": 0, "cursor-stuck": 1, shrank: 2, "count-drift": 3, empty: 4, "did-not-land": 5,
  };
  bad.sort((a, b) => (RANK[a.reason] ?? 9) - (RANK[b.reason] ?? 9));
  return { leg: bad[0].name ?? bad[0].leg, reason: bad[0].reason, at: bad[0].at ?? null, of: bad.length };
}

/**
 * The record itself. Pure — it takes facts and returns the object to write —
 * so what a device reports can be tested without a database, a browser or a
 * clock.
 */
export function deviceRecord({
  deviceId, label, uid, email = null, buildVersion = null,
  legs = [], serving = [], complete = false, downloading = false,
  switchOn = true, lastSyncAt = null, lastPassAt = null, lastError = null,
  bytes = { date: null, bytes: 0, reads: 0 }, photos = null, pending = 0,
  failing = [],
  now = Date.now,
}) {
  const rows = legs.reduce((n, l) => n + (l.rows ?? 0), 0);
  return {
    deviceId,
    label,
    uid: uid ?? null,
    email: email ?? null,
    build: buildVersion,
    // "Can this device answer from its own copy, for everything?" Complete is
    // the setup marker; serving is what health.js will actually let a screen
    // read, and the two differ exactly when a guard has tripped.
    complete: !!complete,
    serving: serving.length,
    legs: legs.length,
    downloading: !!downloading,
    switchOn: !!switchOn,
    rows,
    photos: photos ?? null,
    pending,
    lastSyncAt: lastSyncAt ?? null,
    lastPassAt: lastPassAt ?? null,
    bytesToday: bytes?.bytes ?? 0,
    bytesDate: bytes?.date ?? null,
    reads: bytes?.reads ?? 0,
    guard: guardTripped(legs),
    lastError: lastError ? {
      reason: lastError.reason ?? null, where: lastError.where ?? null,
      message: typeof lastError.message === "string" ? lastError.message.slice(0, 160) : null,
    } : null,
    // Every leg failing THIS SESSION, with how often and whether it has been
    // benched (sync.js LEG_MAX_ATTEMPTS). A leg that loops is named here, on
    // the fleet screen, instead of being found on the bill. null, never [] —
    // RTDB cannot store an empty array.
    failing: failing.length
      ? failing.map((f) => ({
        leg: f.leg, attempts: f.attempts ?? 0, reason: f.reason ?? null, benched: !!f.benched,
        // The error's own words, short. "Error" alone could not tell a swap
        // that did not land from an IndexedDB transaction the browser aborted,
        // and those need different fixes. (Fleet, 2026-09-21.)
        message: typeof f.message === "string" ? f.message.slice(0, 160) : null,
      }))
      : null,
    at: now(),
  };
}

/**
 * Is this report worth a write?
 *
 * Yes if a guard has just tripped or cleared, if the device has just become
 * complete or stopped being complete, if the build changed, if the switch
 * changed — or if it has simply been WRITE_EVERY_MS since the last one, so a
 * quiet device still proves it is alive.
 */
export function worthWriting(prev, next, { every = WRITE_EVERY_MS } = {}) {
  if (!prev) return true;
  const key = (r) => [
    r.complete, r.serving, r.downloading, r.switchOn, r.build,
    r.guard ? `${r.guard.leg}:${r.guard.reason}` : "",
    (r.failing ?? []).map((f) => `${f.leg}:${f.attempts}:${f.benched}:${f.reason}`).join(","),
  ].join("|");
  if (key(prev) !== key(next)) return true;
  return (next.at - prev.at) >= every;
}

/**
 * Write it, if it is worth writing. Returns the record written, or null.
 *
 * `write` is injected so this module carries no firebase import: bootstrap
 * hands it one built on the same `update()` every other write in this app
 * uses. A failure is swallowed and logged — a device that cannot report its
 * health must go on working perfectly well, and the screen showing a device
 * that has not reported is itself a useful thing to see.
 */
export async function reportDeviceHealth({ write, record, last }) {
  if (!record.deviceId) return null;          // private-mode browser: no id, no report
  if (!worthWriting(last, record)) return null;
  try {
    await write(`${DEVICES_ROOT}/${record.deviceId}`, record);
    return record;
  } catch (err) {
    console.warn("offline mirror: could not report this device's health —", err?.message ?? err);
    return null;
  }
}

/** The device's own identity, as the fleet screen will show it. */
export function thisDevice() {
  const deviceId = getDeviceId();
  return { deviceId, label: describeDevice({ deviceId, standalone: isStandalone() }) };
}

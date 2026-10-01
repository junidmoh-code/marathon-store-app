// ─── WHAT A DEVICE REPORTS ABOUT ITSELF ──────────────────────────────────────
//
// The fleet screen is only as good as the record each device writes, and the
// two ways that record can be useless are opposite: it can lie (a device whose
// copy is short reporting itself healthy), or it can be so chatty that a card
// about the cost of the database becomes a line item in the bill.
import { describe, test, expect, vi } from "vitest";
import { freshMirrorDb } from "./helpers";
import {
  addBytes, bytesToday, sastDate, deviceRecord, guardTripped, worthWriting,
  reportDeviceHealth, WRITE_EVERY_MS, DEVICES_ROOT, BYTES_META,
} from "../deviceHealth";
import { measureBytes } from "../rtdbAdapter";

const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);   // 11:00 SAST

describe("bytes are measured, not estimated", () => {
  test("a read is weighed as the JSON that came over the wire", () => {
    expect(measureBytes({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    // RTDB answers the four characters "null" for a node with nothing in it,
    // and that is a real read that a real device really paid for.
    expect(measureBytes(null)).toBe(4);
  });

  test("they accumulate across a day and roll over at the SAST boundary", async () => {
    const db = await freshMirrorDb();
    await addBytes(db, 100, { now: () => T0 });
    await addBytes(db, 250, { now: () => T0 + 3600_000 });
    expect(await bytesToday(db, { now: () => T0 })).toMatchObject({ bytes: 350, reads: 2 });

    // Next trading day: a fresh count, not yesterday's total carried forward.
    const tomorrow = T0 + 24 * 3600_000;
    expect(sastDate(tomorrow)).not.toBe(sastDate(T0));
    expect(await bytesToday(db, { now: () => tomorrow })).toMatchObject({ bytes: 0 });
    await addBytes(db, 10, { now: () => tomorrow });
    expect(await bytesToday(db, { now: () => tomorrow })).toMatchObject({ bytes: 10, reads: 1 });
  });

  test("the day boundary is SAST, not UTC — a late shift is one day", async () => {
    const db = await freshMirrorDb();
    // 23:00 SAST on the 20th is 21:00 UTC on the 20th; 01:00 SAST on the 21st
    // is 23:00 UTC on the 20th. A UTC counter would call those the same day
    // and cut the trading day at 02:00 instead.
    expect(sastDate(Date.UTC(2026, 8, 20, 21, 0))).toBe("2026-09-20");
    expect(sastDate(Date.UTC(2026, 8, 20, 23, 0))).toBe("2026-09-21");
    await addBytes(db, 5, { now: () => Date.UTC(2026, 8, 20, 21, 0) });
    expect((await db.getMeta(BYTES_META)).date).toBe("2026-09-20");
  });

  test("a zero-byte read never writes", async () => {
    const db = await freshMirrorDb();
    expect(await addBytes(db, 0, { now: () => T0 })).toBe(null);
    expect(await db.getMeta(BYTES_META)).toBeUndefined();
  });
});

describe("the record tells the truth about a device", () => {
  const legs = [
    { name: "products", ok: true, rows: 4654, at: T0 },
    { name: "stock", ok: true, rows: 900, at: T0 },
  ];

  test("a healthy device", () => {
    const r = deviceRecord({
      deviceId: "d1", label: "iPad Safari · installed · d1", legs,
      serving: ["products", "stock"], complete: true, switchOn: true,
      bytes: { date: "2026-09-20", bytes: 1_200_000, reads: 40 }, now: () => T0,
    });
    expect(r).toMatchObject({
      complete: true, serving: 2, legs: 2, rows: 5554, guard: null,
      bytesToday: 1_200_000, bytesDate: "2026-09-20", switchOn: true,
    });
  });

  test("a guard that tripped is NAMED, and a refused swap outranks a timeout", () => {
    const tripped = [
      { name: "orders", ok: false, reason: "timed-out", rows: 10, at: T0 },
      { name: "products", ok: false, reason: "shrank", rows: 4654, at: T0 },
    ];
    expect(guardTripped(tripped)).toMatchObject({ leg: "products", reason: "shrank", of: 2 });
    // "A guard tripped" is not actionable. "products: shrank" is.
    expect(deviceRecord({ deviceId: "d1", label: "x", legs: tripped, now: () => T0 }).guard.reason)
      .toBe("shrank");
  });

  test("a device downloading is not a device serving — the two never look alike", () => {
    const r = deviceRecord({
      deviceId: "d1", label: "x", legs, serving: [], complete: false,
      downloading: true, now: () => T0,
    });
    expect(r.complete).toBe(false);
    expect(r.serving).toBe(0);
    expect(r.downloading).toBe(true);
  });
});

describe("reporting must not become a cost of its own", () => {
  const base = { deviceId: "d1", label: "x", legs: [], now: () => T0 };

  test("an unchanged device reports at most once every ten minutes", () => {
    const prev = deviceRecord({ ...base, complete: true });
    const soon = deviceRecord({ ...base, complete: true, now: () => T0 + 60_000 });
    expect(worthWriting(prev, soon)).toBe(false);
    const later = deviceRecord({ ...base, complete: true, now: () => T0 + WRITE_EVERY_MS });
    expect(worthWriting(prev, later)).toBe(true);
  });

  test("but a guard tripping is reported AT ONCE — that is what the screen is for", () => {
    const prev = deviceRecord({ ...base, complete: true });
    const bad = deviceRecord({
      ...base, complete: true, now: () => T0 + 1000,
      legs: [{ name: "products", ok: false, reason: "count-drift", at: T0 }],
    });
    expect(worthWriting(prev, bad)).toBe(true);
  });

  test("and so is the switch being flipped, or the copy completing", () => {
    const prev = deviceRecord({ ...base, complete: false, switchOn: true });
    expect(worthWriting(prev, deviceRecord({ ...base, complete: true, switchOn: true, now: () => T0 + 1 }))).toBe(true);
    expect(worthWriting(prev, deviceRecord({ ...base, complete: false, switchOn: false, now: () => T0 + 1 }))).toBe(true);
  });

  test("the first report always goes", () => {
    expect(worthWriting(null, deviceRecord(base))).toBe(true);
  });
});

describe("writing it", () => {
  test("goes to this device's own child, and nowhere else", async () => {
    const write = vi.fn(async () => true);
    const record = deviceRecord({ deviceId: "abc", label: "x", legs: [], now: () => T0 });
    await reportDeviceHealth({ write, record, last: null });
    expect(write).toHaveBeenCalledTimes(1);
    // The rule lets a device write ONLY its own child. A report that wrote the
    // node would be refused, and would deserve to be.
    expect(write.mock.calls[0][0]).toBe(`${DEVICES_ROOT}/abc`);
  });

  test("a device with no id — private mode — reports nothing and does not throw", async () => {
    const write = vi.fn();
    const record = deviceRecord({ deviceId: null, label: "x", legs: [], now: () => T0 });
    expect(await reportDeviceHealth({ write, record, last: null })).toBe(null);
    expect(write).not.toHaveBeenCalled();
  });

  test("a write that FAILS is swallowed — a device must go on working", async () => {
    const write = vi.fn(async () => { throw new Error("PERMISSION_DENIED"); });
    const record = deviceRecord({ deviceId: "abc", label: "x", legs: [], now: () => T0 });
    expect(await reportDeviceHealth({ write, record, last: null })).toBe(null);
  });
});

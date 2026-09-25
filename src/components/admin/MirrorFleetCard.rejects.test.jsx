// ─── MIRROR FLEET — REJECTS PER PHONE (2026-09-25) ───────────────────────────
//
// Junid needs to see, beside each phone, how often it has said "out of stock".
// Claims pinned here, on the firebase calls and the rendered words:
//   1. The reject log is read as a BOUNDED key range — the last REJECT_DAYS SA
//      days via orderByKey().startAt(day) — never the whole node.
//   2. Each device row shows its own count, today and over the range, from the
//      REAL tally of that log.
//   3. A log the rules do not let us read yet (before the console paste) does
//      not blank the device list: the rows still render, with a one-line note.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "#admin/mirror" }, isSecureContext: true,
  requestAnimationFrame(fn) { fn(); },
};

const NOW = Date.now();
const DAY = (ms) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10);
const BAD = "2964c145-ecad-4f61-9f7a-304231af0e01";
const OTHER = "015a0b02-1bf5-4d63-a869-5e048d116154";
const DEVICES = {
  [BAD]: { deviceId: BAD, label: "Android Chrome · browser · 2964", email: "ayob@marathon.internal", at: NOW - 60e3, rows: 1, complete: true, switchOn: true },
  [OTHER]: { deviceId: OTHER, label: "Android Chrome · browser · 015a", email: "ayob@marathon.internal", at: NOW - 120e3, rows: 1, complete: true, switchOn: true },
};
const GHOST = "9h0s7000-0000-4000-8000-00000000abcd";   // never reported to /mirror_devices
const REJECTS = {
  [DAY(NOW - 2 * 864e5)]: { [BAD]: { a: { at: NOW - 2 * 864e5, uid: "ayob", kind: "order" } }, [GHOST]: { g: { at: NOW - 2 * 864e5, uid: "x", kind: "order" } } },
  [DAY(NOW)]: {
    [BAD]: {
      b: { at: NOW - 5 * 60e3, uid: "ayob", kind: "order" }, c: { at: NOW - 4 * 60e3, uid: "ayob", kind: "order" },
      d: { at: NOW - 3 * 60e3, uid: "ayob", kind: "order" }, e: { at: NOW - 2 * 60e3, uid: "ayob", kind: "order" },
      junk: "not a record",
    },
  },
};

let rejectsRefused = false;
const calls = [];
const getMock = vi.fn(async (q) => {
  calls.push(q);
  const path = q?.ref?.path ?? q?.path;
  if (path === "device_rejects") {
    if (rejectsRefused) throw new Error("PERMISSION_DENIED: Permission denied");
    return { exists: () => true, val: () => REJECTS };
  }
  if (path === "mirror_devices") return { exists: () => true, val: () => DEVICES };
  return { exists: () => false, val: () => null };
});
vi.mock("firebase/database", () => ({
  getDatabase: () => ({ fake: true }),
  ref: (_db, path) => ({ path: path || "" }),
  query: (ref, ...parts) => ({ ref, parts }),
  orderByKey: () => ({ orderByKey: true }),
  startAt: (v) => ({ startAt: v }),
  get: (...a) => getMock(...a),
  set: vi.fn(async () => true),
  remove: vi.fn(async () => true),
  onValue: vi.fn((_r, cb) => { cb({ exists: () => false, val: () => null }); return () => {}; }),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const { default: MirrorFleetCard, REJECT_DAYS } = await import("./MirrorFleetCard.jsx");
const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com" };

async function render() {
  let tree;
  await act(async () => { tree = TestRenderer.create(<MirrorFleetCard authUser={ADMIN} onExit={() => {}} />); });
  return tree;
}
const text = (node) => (typeof node === "string" ? node : (node.children || []).map(text).join(""));

describe("rejects per phone on the Mirror Fleet screen", () => {
  beforeEach(() => { getMock.mockClear(); calls.length = 0; rejectsRefused = false; });

  it("reads the log as a bounded key range — the last 7 SA days, never the whole node", async () => {
    await render();
    const q = calls.find((c) => c?.ref?.path === "device_rejects");
    expect(q, "the reject log was never read").toBeTruthy();
    expect(q.parts).toContainEqual({ orderByKey: true });
    expect(q.parts).toContainEqual({ startAt: DAY(NOW - (REJECT_DAYS - 1) * 864e5) });
    expect(calls.some((c) => c?.path === "device_rejects")).toBe(false);      // never a bare ref
  });

  it("shows each phone's own count — today and over the week", async () => {
    const tree = await render();
    const lines = tree.root.findAll((n) => n.props?.["data-testid"] === "device-rejects").map(text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Rejects: 4 today · 5 in 7 days · last /);
    expect(lines[1]).toBe("No rejects in 7 days");
  });

  it("a log it may not read yet leaves the device list standing, with a note", async () => {
    rejectsRefused = true;
    const tree = await render();
    expect(tree.root.findAll((n) => n.props?.["data-testid"] === "device-rejects")).toHaveLength(0);
    const all = text(tree.root);
    expect(all).toContain("Android Chrome · browser · 2964");
    expect(all).toContain("Reject counts per device appear once the device-reject rule is pasted");
  });

  it("a phone with rejects but no /mirror_devices record is listed, with its full id, not dropped", async () => {
    const tree = await render();
    const box = tree.root.findAll((n) => n.props?.["data-testid"] === "unlisted-rejects");
    expect(box).toHaveLength(1);
    const t = text(box[0]);
    expect(t).toContain(`id ${GHOST} · Rejects: 0 today · 1 in 7 days`);
    expect(t).not.toContain(BAD);
  });
});

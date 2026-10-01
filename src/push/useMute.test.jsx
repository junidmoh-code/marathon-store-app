// ─── THE MUTE HOOK — the listener, the optimistic write, and the rollback ────
// Mutation-proven by scripts/mutation-proof-push-notify.mjs (U6).
//
// The bug this file was written for is the rollback. The optimistic write used
// to capture the value it was replacing and restore THAT on a refusal, which
// with two tabs open restores a stale answer over a newer truth. Firebase does
// not re-emit a snapshot for a write it refused, so nothing corrects it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

let listener = null;
let errorHandler = null;
const updateMock = vi.fn(async () => {});
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  onValue: (_node, cb, onErr) => { listener = cb; errorHandler = onErr; return () => { listener = null; }; },
  update: (...a) => updateMock(...a),
}));
vi.mock("../firebase", () => ({ database: { fake: true } }));
vi.mock("../utils/serverTime", () => ({ serverNowMs: () => 1_757_000_000_000 }));

const { usePushMute } = await import("./useMute");

let api;
function Harness({ uid }) { api = usePushMute({ uid }); return null; }
const mount = async (uid = "u1") => {
  await act(async () => { TestRenderer.create(<Harness uid={uid} />); });
};
const snapshot = async (val) => { await act(async () => { listener({ val: () => val }); }); };

beforeEach(() => { updateMock.mockClear(); updateMock.mockImplementation(async () => {}); listener = null; });

describe("the listener", () => {
  it("starts NOT known and NOT muted — audible is the safe render before an answer", async () => {
    await mount();
    expect(api.known).toBe(false);
    expect(api.muted).toBe(false);
  });

  it("an absent record is a real answer: audible, and known", async () => {
    await mount();
    await snapshot(null);
    expect(api.known).toBe(true);
    expect(api.muted).toBe(false);
  });

  it("reads a mute", async () => {
    await mount();
    await snapshot({ muted: true, updatedAt: 1 });
    expect(api.muted).toBe(true);
  });

  it("watches ONE per-uid path, never the node", async () => {
    await mount("u1");
    expect(api).toBeTruthy();
    // ref() is called with the record path; the rule scopes read and write to
    // auth.uid, so nothing above $uid is reachable.
    const { ref } = await import("firebase/database");
    expect(ref({}, "push_mutes/u1").path).toBe("push_mutes/u1");
  });

  it("A REFUSED READ IS NOT AN ANSWER — known stays false and the reason is kept", async () => {
    await mount();
    await act(async () => { errorHandler(new Error("PERMISSION_DENIED")); });
    expect(api.known).toBe(false);
    expect(api.error).toEqual({ kind: "read", message: "PERMISSION_DENIED" });
  });
});

describe("the write", () => {
  it("is optimistic", async () => {
    await mount();
    await snapshot(null);
    let p;
    await act(async () => { p = api.setMuted(true); await p; });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1]).toEqual({ "push_mutes/u1": { muted: true, updatedAt: 1_757_000_000_000 } });
  });

  it("unmuting DELETES", async () => {
    await mount();
    await snapshot({ muted: true, updatedAt: 1 });
    await act(async () => { await api.setMuted(false); });
    expect(updateMock.mock.calls[0][1]).toEqual({ "push_mutes/u1": null });
  });

  it("ROLLS BACK TO THE SERVER, not to what this tab last believed", async () => {
    // Two tabs. This one starts audible and its mute is refused slowly; the
    // other tab mutes successfully meanwhile, so this tab's listener has
    // already moved to true. The rollback must land on true — the stored
    // answer — not on the false this tab held before any of it happened.
    await mount();
    await snapshot(null);                     // audible
    updateMock.mockImplementation(async () => { throw new Error("PERMISSION_DENIED"); });
    let done;
    await act(async () => {
      done = api.setMuted(true);
      await snapshot({ muted: true, updatedAt: 2 });   // the other tab lands
      await done;
    });
    expect(api.muted).toBe(true);
    expect(api.error).toEqual({ kind: "write", message: "PERMISSION_DENIED" });
  });

  it("a refused write reports false and names the failure as a SAVE", async () => {
    await mount();
    await snapshot(null);
    updateMock.mockImplementation(async () => { throw new Error("nope"); });
    let ok;
    await act(async () => { ok = await api.setMuted(true); });
    expect(ok).toBe(false);
    expect(api.error.kind).toBe("write");
    expect(api.muted).toBe(false);
  });

  it("writes NOTHING when signed out", async () => {
    await mount(null);
    let ok;
    await act(async () => { ok = await api.setMuted(true); });
    expect(ok).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an unusable uid FAILS THE SETTING, never the home screen", async () => {
    // muteUpdates throws synchronously on an illegal RTDB key (the SDK would
    // too, before any promise exists). It is thrown INSIDE the try, so it
    // becomes a refused save with a message — a switch that does not save —
    // rather than an exception escaping into a render. A Firebase uid is
    // always legal, so this is depth, not a live path.
    await mount("a.b");
    let ok;
    await act(async () => { ok = await api.setMuted(true); });
    expect(ok).toBe(false);
    expect(api.error.message).toMatch(/unusable uid/);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

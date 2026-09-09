// ─── THE APP MUST HAVE A WAY TO ASK FOR PERMISSION ───────────────────────────
// This file exists because of a two-day outage, and it pins the exact shape of
// what went wrong so it cannot recur silently.
//
// `Notification.requestPermission()` lives in one place — registerPush.js,
// behind the `promptIfNeeded` argument. #573 deleted the personal toggle, which
// was its ONLY caller and the only thing that ever passed `true`. What was left
// called ensurePushRegistration with `promptIfNeeded: false` on every load and
// nothing else, so every browser sitting at `Notification.permission ===
// "default"` resolved to NEEDS_PERMISSION, wrote nothing, and was never asked
// again. No permission → no token → /push_tokens empty → "no device" on every
// row → nobody was told about anything.
//
// Nothing went red. Every test still passed, because "does an entrance exist"
// was not a thing anything asserted. It is now:
//
//   • the PASSIVE path (an effect, on every load) must NEVER prompt — a prompt
//     fired outside a gesture is ignored by Chrome and held against the site by
//     Safari, so this half was and remains correct;
//   • the GESTURE path must ALWAYS prompt, and must exist at all.
//
// Both halves are asserted, because either one alone is a bug: deleting the
// prompt is the outage above, and firing it from the effect is what got the
// toggle removed in the first place.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

const ensureMock = vi.fn(async () => ({ state: "on" }));
vi.mock("./registerPush", async () => {
  const actual = await vi.importActual("./registerPush");
  return { ...actual, ensurePushRegistration: (...a) => ensureMock(...a), pushCapability: () => "on" };
});

const { usePushRegistration } = await import("./usePush");
const { PUSH_STATE } = await import("./registerPush");

const USER = { uid: "u1", isAnonymous: false };

let api;
function Harness({ user }) {
  api = usePushRegistration({ user });
  return null;
}
const mount = async (user = USER) => {
  await act(async () => { TestRenderer.create(<Harness user={user} />); });
};

beforeEach(() => { ensureMock.mockClear(); ensureMock.mockImplementation(async () => ({ state: "on" })); });

describe("the passive re-arm on every load", () => {
  it("registers, so a rotated token is refreshed and an assignment can land", async () => {
    await mount();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][0]).toMatchObject({ uid: "u1", wanted: true });
  });

  it("NEVER PROMPTS — an effect is not a gesture", async () => {
    await mount();
    expect(ensureMock.mock.calls[0][0].promptIfNeeded).toBe(false);
  });

  it("clears the legacy audience buckets on the way past", async () => {
    await mount();
    expect(ensureMock.mock.calls[0][0].buckets).toEqual([]);
  });

  it("does nothing at all when signed out or anonymous", async () => {
    await mount(null);
    await mount({ uid: "u1", isAnonymous: true });
    expect(ensureMock).not.toHaveBeenCalled();
  });
});

describe("the gesture path — the entrance that was missing", () => {
  it("EXISTS", async () => {
    await mount();
    expect(typeof api.enablePush).toBe("function");
  });

  it("PROMPTS. This is the whole fix, and deleting it is the outage again", async () => {
    await mount();
    ensureMock.mockClear();
    await act(async () => { await api.enablePush(); });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(ensureMock.mock.calls[0][0].promptIfNeeded).toBe(true);
  });

  it("returns the resulting state, so a caller can react in the same turn", async () => {
    await mount();
    ensureMock.mockImplementation(async () => ({ state: PUSH_STATE.BLOCKED }));
    let got;
    await act(async () => { got = await api.enablePush(); });
    expect(got).toBe(PUSH_STATE.BLOCKED);
    expect(api.state).toBe(PUSH_STATE.BLOCKED);
    expect(api.ready).toBe(false);
  });

  it("a THROW is reported as ERROR, never as a silent success", async () => {
    await mount();
    ensureMock.mockImplementation(async () => { throw new Error("boom"); });
    let got;
    await act(async () => { got = await api.enablePush(); });
    expect(got).toBe(PUSH_STATE.ERROR);
    expect(api.ready).toBe(false);
  });

  it("GRANTS NO HUB — it registers an address and touches nothing else", async () => {
    // A token is an ADDRESS. Who is SENT to is resolved from
    // /push_hub_audience, which is super-admin-write-only. If this call ever
    // grew a bucket list or a hub, the staff switch would be granting.
    await mount();
    ensureMock.mockClear();
    await act(async () => { await api.enablePush(); });
    const args = ensureMock.mock.calls[0][0];
    expect(args.buckets).toEqual([]);
    expect(Object.keys(args).sort()).toEqual(["buckets", "promptIfNeeded", "uid", "wanted"]);
  });

  it("does nothing when signed out", async () => {
    await mount(null);
    let got;
    await act(async () => { got = await api.enablePush(); });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(got).toBe(PUSH_STATE.ERROR);
  });
});

describe("`ready` is the registration, not the intention", () => {
  it("is true only when the current uid's registration returned ON", async () => {
    await mount();
    expect(api.ready).toBe(true);
  });

  for (const state of ["blocked", "needs-permission", "needs-install", "unsupported", "error"]) {
    it(`is false for ${state} — several of those leave an older token alive`, async () => {
      ensureMock.mockImplementation(async () => ({ state }));
      await mount();
      expect(api.ready).toBe(false);
    });
  }
});

// ─── AND THE ENTRANCE HAS TO BE REACHABLE FROM THE APP ───────────────────────
// Everything above tests the hook, and the hook is not the entrance. Deleting
// both <NotificationSettingsRow /> mounts from src/App.jsx would leave every
// assertion in this file and every assertion in muteToggle.test.jsx green,
// while new browsers again had no reachable way to be asked for permission —
// which is EXACTLY the outage this file was written about. A capability test
// that cannot see whether anything calls the capability is the same blind spot
// one level up.
//
// So these read the source of App.jsx. That is a blunt instrument and it is the
// right one here: rendering AppInner in a unit test would need the whole
// Firebase surface stubbed, and the thing being defended is not behavioural —
// it is "does the wiring still exist at all".
describe("the app actually mounts the entrance", () => {
  const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  it("renders the settings row on BOTH home branches — desktop and mobile", () => {
    // Two branches, two mounts. #573 deleted them as a pair and a fix that
    // restored only one would leave half the staff with no way in.
    const mounts = APP.match(/<NotificationSettingsRow\b/g) || [];
    expect(mounts.length).toBe(2);
  });

  it("imports it, so the mounts are not dead text in a comment", () => {
    expect(APP).toMatch(/^import NotificationSettingsRow from "\.\/push\/NotificationSettingsRow";$/m);
  });

  it("feeds it BOTH hooks — a row with no push prop renders null and asks nobody", () => {
    // NotificationSettingsRow returns null unless it has push.uid AND mute, so
    // a mount that forgot either prop is an entrance that silently is not one.
    expect(APP).toMatch(/<NotificationSettingsRow push=\{push\} mute=\{mute\} \/>/);
    expect(APP).toMatch(/const push = usePushRegistration\(/);
    expect(APP).toMatch(/const mute = usePushMute\(/);
  });

  it("passes both down to the home screen that renders them", () => {
    expect(APP).toMatch(/function RoleSelector\(\{[^}]*\bpush\b[^}]*\bmute\b[^}]*\}\)/);
    expect(APP).toMatch(/<RoleSelector[^>]*push=\{push\}[^>]*mute=\{mute\}/);
  });
});

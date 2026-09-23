// ─── ONE DEVICE OFF — THE PROPERTIES THAT MATTER ─────────────────────────────
//
// The one that matters most is the default. This flag is ABSENT for every
// healthy device, so if "absent" or "could not read" ever came to mean "stop
// mirroring", the first failed read would take the whole fleet off the mirror
// — the exact fleet-wide outcome the flag exists to avoid. That is pinned here
// from several directions, because it is the failure that would be discovered
// in the bill rather than in a test.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The same minimal localStorage this estate's other offline tests use: there
// is no DOM here, and the cache across a reload is half of what is under test.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
import {
  deviceOffVerdict, deviceMirrorOff, deviceMirrorOffKnown, setDeviceOffValue,
  noteDeviceOffUnreadable, subscribeDeviceOff, watchDeviceOff, deviceOffIsWatched,
  deviceOffPath, DEVICE_OFF_ROOT, DEVICE_OFF_CACHE_KEY, resetDeviceOffForTests,
} from "../deviceOff";
import {
  offlineMirrorEnabled, setMirrorSwitchValue, _resetMirrorSwitchForTests,
} from "../killSwitch";

beforeEach(() => resetDeviceOffForTests());

describe("what counts as off", () => {
  it("only a value somebody wrote on purpose turns a device off", () => {
    for (const on of [true, 1, "true", "TRUE", " on ", "yes", "1", "off"]) {
      expect(deviceOffVerdict(on), `${JSON.stringify(on)} should be off`).toBe(true);
    }
  });

  it("absent, false and nonsense all leave the device mirroring", () => {
    for (const no of [null, undefined, false, 0, "", "false", "no", "0", {}, []]) {
      expect(deviceOffVerdict(no), `${JSON.stringify(no)} must NOT switch a device off`).toBe(false);
    }
  });
});

describe("the default is safe for the fleet", () => {
  it("a device that has never heard an answer is NOT off", () => {
    expect(deviceMirrorOff()).toBe(false);
    expect(deviceMirrorOffKnown()).toBe(false);
  });

  it("an absent node is NOT off — this is the whole-fleet case", () => {
    setDeviceOffValue(null);
    expect(deviceMirrorOff()).toBe(false);
  });

  it("a read that FAILS leaves a healthy device mirroring", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    noteDeviceOffUnreadable(new Error("permission_denied"));
    expect(deviceMirrorOff()).toBe(false);
  });

  it("a read that FAILS leaves a stopped device stopped", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setDeviceOffValue(true);
    noteDeviceOffUnreadable(new Error("network"));
    expect(deviceMirrorOff()).toBe(true);
  });
});

describe("it survives a reload", () => {
  it("the answer is cached and read back", () => {
    setDeviceOffValue(true, { now: () => 123 });
    expect(JSON.parse(localStorage.getItem(DEVICE_OFF_CACHE_KEY))).toEqual({ off: true, at: 123 });
    resetDeviceOffForTests();
    // resetDeviceOffForTests clears the cache too, so write it back the way a
    // reload would find it.
    localStorage.setItem(DEVICE_OFF_CACHE_KEY, JSON.stringify({ off: true, at: 123 }));
    expect(deviceMirrorOff()).toBe(true);
  });

  it("an unparseable cache is simply no cache, not an off switch", () => {
    localStorage.setItem(DEVICE_OFF_CACHE_KEY, "{{{not json");
    expect(deviceMirrorOff()).toBe(false);
  });
});

describe("listeners and the watch", () => {
  it("every answer notifies, not only a change", () => {
    const seen = [];
    subscribeDeviceOff((off) => seen.push(off));
    setDeviceOffValue(true);
    setDeviceOffValue(true);
    setDeviceOffValue(null);
    expect(seen).toEqual([true, true, false]);
  });

  it("a throwing listener never breaks the flag", () => {
    subscribeDeviceOff(() => { throw new Error("boom"); });
    expect(() => setDeviceOffValue(true)).not.toThrow();
    expect(deviceMirrorOff()).toBe(true);
  });

  it("watches this device's own path, and only that", () => {
    const paths = [];
    watchDeviceOff({ deviceId: "dev-1", subscribe: (onAnswer, _onErr, id) => { paths.push(id); onAnswer(true); return () => {}; } });
    expect(paths).toEqual(["dev-1"]);
    expect(deviceOffPath("dev-1")).toBe("mirror_switch/off/dev-1");
    expect(DEVICE_OFF_ROOT).toBe("mirror_switch/off");
    expect(deviceMirrorOff()).toBe(true);
  });

  it("is idempotent — several callers, one subscription", () => {
    let subs = 0;
    const sub = { deviceId: "dev-1", subscribe: () => { subs += 1; return () => {}; } };
    watchDeviceOff(sub); watchDeviceOff(sub); watchDeviceOff(sub);
    expect(subs).toBe(1);
    expect(deviceOffIsWatched()).toBe(true);
  });

  it("a browser with no device id is left mirroring, not guessed at", () => {
    let subs = 0;
    watchDeviceOff({ deviceId: null, subscribe: () => { subs += 1; return () => {}; } });
    expect(subs).toBe(0);
    expect(deviceMirrorOff()).toBe(false);
  });

  it("a subscribe that throws does not leave the watch latched on", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    watchDeviceOff({ deviceId: "dev-1", subscribe: () => { throw new Error("no sdk"); } });
    expect(deviceOffIsWatched()).toBe(false);
    expect(deviceMirrorOff()).toBe(false);
  });
});

// ─── THE TWO ANSWERS TOGETHER ────────────────────────────────────────────────
// offlineMirrorEnabled() is the one function every read path in the app asks,
// so this is the property that actually decides whether a handset mirrors.
describe("the chokepoint obeys both", () => {
  beforeEach(() => { _resetMirrorSwitchForTests(); resetDeviceOffForTests(); });

  it("fleet on + device not flagged = this device mirrors", () => {
    setMirrorSwitchValue(true);
    expect(offlineMirrorEnabled()).toBe(true);
  });

  it("fleet on + THIS device flagged = this device reads live", () => {
    setMirrorSwitchValue(true);
    setDeviceOffValue(true);
    expect(offlineMirrorEnabled()).toBe(false);
  });

  it("clearing the flag puts the device back, with no reload", () => {
    setMirrorSwitchValue(true);
    setDeviceOffValue(true);
    expect(offlineMirrorEnabled()).toBe(false);
    setDeviceOffValue(null);          // the owner removes the node
    expect(offlineMirrorEnabled()).toBe(true);
  });

  it("fleet off beats everything — a cleared flag cannot re-enable a killed fleet", () => {
    setMirrorSwitchValue(false);
    setDeviceOffValue(null);
    expect(offlineMirrorEnabled()).toBe(false);
  });
});

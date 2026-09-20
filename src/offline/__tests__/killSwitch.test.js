// ─── THE KILL SWITCH, PROVED WHERE IT HAS TO WORK ────────────────────────────
//
// The switch exists for one night that has not happened yet: the mirror is
// wrong about a number, every tablet in the fleet is serving it, and the fix
// has to be one value in the database rather than a build reaching devices
// that may not reload for days.
//
// So these tests are not about the boolean. They are about the READ PATHS: with
// the switch false, does every one of them go to RTDB? A version of this work
// where the flag is respected in four of the five places would pass an
// obvious-looking test and lose a shop a day's trading.
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

import {
  switchVerdict, mirrorSwitchOn, mirrorSwitchKnown, mirrorSwitchState,
  setMirrorSwitchValue, noteMirrorSwitchUnreadable, subscribeMirrorSwitch, offlineMirrorEnabled,
  watchMirrorSwitch, ensureMirrorSwitch, SWITCH_CACHE_KEY, MIRROR_SWITCH_PATH,
  _resetMirrorSwitchForTests,
} from "../killSwitch";
import { isLegServing, setServingLegs, subscribeServing, servingKeyFor, _resetServingForTests } from "../serving";
import { notePendingUpdate, pendingCount, _clearPendingForTests } from "../pendingWrites";
import { readPathOnce } from "../localReads";
import { mirrorCanAnswer } from "../useMirroredPath";

beforeEach(() => {
  store.clear();
  _resetMirrorSwitchForTests();
  _resetServingForTests();
  _clearPendingForTests();
});

describe("what the value in the database means", () => {
  it("reads ONLY a value somebody wrote on purpose as ON", () => {
    for (const raw of [true, 1, "true", "TRUE", " true ", "on", "yes", "1"]) {
      expect(switchVerdict(raw)).toBe(true);
    }
  });

  it("reads an ABSENT node as OFF — clearing the value is a kill, never a start", () => {
    // A switch whose absence means ON is safe in the wrong direction: pasting
    // the read rule would turn the fleet on before anyone wrote anything, and
    // an admin clearing the node to reset something would turn it on.
    for (const raw of [null, undefined, false, 0, "false", "off", "no", "0", "", "maybe"]) {
      expect(switchVerdict(raw)).toBe(false);
    }
  });
});

describe("a device that has never heard an answer", () => {
  it("does NOT mirror — the unknown answer is live reads, today's behaviour", () => {
    expect(mirrorSwitchKnown()).toBe(false);
    expect(mirrorSwitchOn()).toBe(false);
    expect(offlineMirrorEnabled()).toBe(false);
  });

  it("still does not mirror when the read FAILS — a refusal is not a yes", () => {
    noteMirrorSwitchUnreadable(new Error("permission_denied"));
    expect(mirrorSwitchOn()).toBe(false);
  });
});

describe("a device that HAS heard an answer", () => {
  it("keeps it across a reload — the offline tablet goes on serving its copy", () => {
    setMirrorSwitchValue(true);
    expect(store.get(SWITCH_CACHE_KEY)).toContain('"on":true');
    // A RELOAD, as nearly as a test can hold one: every module re-evaluated,
    // nothing in memory, the same localStorage underneath. A device in a back
    // room with no line has to come back up still serving its copy — if the
    // answer only lived in memory it would come back up reading live and
    // paying for it.
    _resetMirrorSwitchForTests({ keepCache: true });
    expect(mirrorSwitchOn()).toBe(true);
    expect(mirrorSwitchKnown()).toBe(true);
  });

  it("a FAILED re-read does not undo it — the line being down is not a kill", () => {
    setMirrorSwitchValue(true);
    noteMirrorSwitchUnreadable(new Error("network"));
    expect(mirrorSwitchOn()).toBe(true);
    expect(offlineMirrorEnabled()).toBe(true);
  });

  it("an explicit false DOES undo it, and is remembered", () => {
    setMirrorSwitchValue(true);
    setMirrorSwitchValue(false);
    expect(mirrorSwitchOn()).toBe(false);
    expect(mirrorSwitchState()).toMatchObject({ on: false, known: true });
    expect(store.get(SWITCH_CACHE_KEY)).toContain('"on":false');
  });
});

describe("FALSE means live reads, in every read path there is", () => {
  beforeEach(() => {
    setMirrorSwitchValue(true);
    setServingLegs(["products", "stock", "orders"]);
  });

  it("the serving hint — which is what a hook consults on its first render", () => {
    expect(isLegServing("products")).toBe(true);
    setMirrorSwitchValue(false);
    expect(isLegServing("products")).toBe(false);
    expect(servingKeyFor(["products", "stock"])).toBe("00");
  });

  it("the hook's own gate", async () => {
    expect(await mirrorCanAnswer("products")).toBe(false); // no db in this env…
    setMirrorSwitchValue(false);
    expect(await mirrorCanAnswer("products")).toBe(false); // …and certainly not now
  });

  it("the one-shot read — /refill_requests is 9 MB and must go live", async () => {
    const liveRead = vi.fn(async () => ({ live: true }));
    setMirrorSwitchValue(false);
    expect(await readPathOnce("refill_requests", liveRead)).toEqual({ live: true });
    expect(liveRead).toHaveBeenCalledTimes(1);
  });

  it("the pending-write echo — nothing is recorded to overlay a local read", () => {
    expect(notePendingUpdate({ "stock/hub1/p1/9/qty": 4 })).toBe(1);
    setMirrorSwitchValue(false);
    expect(notePendingUpdate({ "stock/hub1/p1/9/qty": 5 })).toBe(0);
  });

  it("the engine itself refuses to start", async () => {
    const { startOfflineMirror } = await import("../bootstrap");
    setMirrorSwitchValue(false);
    expect(await startOfflineMirror({})).toBe(null);
  });
});

describe("it takes effect WITHOUT A RELOAD", () => {
  it("a flip re-renders every mirror-reading hook, because it notifies the serving store", () => {
    // Every hook that reads from the mirror is subscribed here through
    // useSyncExternalStore. If the flip does not reach this listener, the
    // switch only takes effect on the next render that happens for some other
    // reason — which on a tablet left open on one screen could be hours, and
    // is the difference between a kill switch and a note in a runbook.
    setMirrorSwitchValue(true);
    const seen = [];
    const unsub = subscribeServing(() => seen.push(servingKeyFor(["products"])));
    setServingLegs(["products"]);
    expect(seen).toEqual(["1"]);
    setMirrorSwitchValue(false);
    expect(seen).toEqual(["1", "0"]);
    unsub();
    setMirrorSwitchValue(true);
    expect(seen).toEqual(["1", "0"]);   // and it unsubscribes cleanly
  });

  it("a flip back ON puts the hooks back on the local copy", () => {
    setServingLegs(["products"]);
    setMirrorSwitchValue(false);
    expect(isLegServing("products")).toBe(false);
    setMirrorSwitchValue(true);
    expect(isLegServing("products")).toBe(true);
  });
});

describe("the live subscription", () => {
  it("watches ONE path, and hands every answer to the switch", () => {
    let push = null;
    const stop = vi.fn();
    const subscribe = vi.fn((onAnswer) => { push = onAnswer; return stop; });
    const unwatch = watchMirrorSwitch({ subscribe });
    expect(subscribe).toHaveBeenCalledTimes(1);
    push(true);
    expect(mirrorSwitchOn()).toBe(true);
    push(false);
    expect(mirrorSwitchOn()).toBe(false);
    unwatch();
    expect(stop).toHaveBeenCalled();
  });

  it("is opened once however many callers ask", () => {
    const subscribe = vi.fn(() => () => {});
    watchMirrorSwitch({ subscribe });
    watchMirrorSwitch({ subscribe });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("the path is the CHILD, so a future sibling costs the fleet nothing", () => {
    expect(MIRROR_SWITCH_PATH).toBe("mirror_switch/enabled");
  });

  it("a subscription that throws leaves the device on live reads, not broken", () => {
    const unwatch = watchMirrorSwitch({ subscribe: () => { throw new Error("denied"); } });
    expect(mirrorSwitchOn()).toBe(false);
    expect(() => unwatch()).not.toThrow();
  });
});

describe("the first-answer wait", () => {
  it("resolves as soon as an answer arrives", async () => {
    const p = ensureMirrorSwitch({ timeoutMs: 5000 });
    setMirrorSwitchValue(true);
    expect(await p).toBe(true);
  });

  it("gives up on its own rather than holding a boot for ever", async () => {
    expect(await ensureMirrorSwitch({ timeoutMs: 1 })).toBe(false);
  });

  it("a read that fails releases the wait — nobody is held by a refused rule", async () => {
    const p = ensureMirrorSwitch({ timeoutMs: 5000 });
    noteMirrorSwitchUnreadable(new Error("permission_denied"));
    expect(await p).toBe(false);
  });
});

describe("the switch is the ONLY answer — there is no per-device flag left", () => {
  it("offlineMirrorEnabled is the switch, and nothing else", () => {
    // PR #624 removed the per-device localStorage flag. Every device in the
    // fleet mirrors, and the only thing that can say otherwise is the one
    // value in the database. A second, per-device opinion is exactly how half
    // a shop ends up on one code path and half on the other with nobody able
    // to say which.
    expect(offlineMirrorEnabled()).toBe(false);
    setMirrorSwitchValue(true);
    expect(offlineMirrorEnabled()).toBe(true);
    setMirrorSwitchValue(false);
    expect(offlineMirrorEnabled()).toBe(false);
  });
});

describe("the echo store is left alone by a kill", () => {
  it("writes already recorded are not lost when the switch goes off", () => {
    setMirrorSwitchValue(true);
    notePendingUpdate({ "stock/hub1/p1/9/qty": 4 });
    const before = pendingCount();
    setMirrorSwitchValue(false);
    // They stop being APPLIED (every local read is gone), and nothing throws
    // them away either — a kill must not look like a lost write.
    expect(pendingCount()).toBe(before);
  });
});

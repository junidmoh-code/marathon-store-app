// ─── MIRROR FLEET — THE GATE, THE COST, AND THE KILL ─────────────────────────
//
// Three claims, each of which a comment alone could not hold up.
//
//   1. A refused viewer reads NOTHING and, more importantly, is never offered
//      the kill switch. Asserted on the firebase calls, not on what rendered:
//      a card that draws "not for you" while having fetched the fleet has
//      leaked a list of staff devices.
//   2. The fleet is read ONCE with get(), never subscribed. A screen about the
//      cost of reading the database that re-downloads every device's record
//      each time any device in the shop reports is a line item in its own
//      report.
//   3. The kill takes a confirmation and writes the ONE path every device
//      watches. A kill button wired to the wrong path is a kill button that
//      does nothing, and the night you find that out is the worst possible
//      night to find it out.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "#admin/mirror" }, isSecureContext: true,
  requestAnimationFrame(fn) { fn(); },
};

const getMock = vi.fn(async () => ({ exists: () => false, val: () => null }));
const onValueMock = vi.fn(() => () => {});
const setMock = vi.fn(async () => true);

vi.mock("firebase/database", () => ({
  getDatabase: () => ({ fake: true }),
  ref: (_db, path) => ({ path: path || "" }),
  get: (...args) => getMock(...args),
  set: (...args) => setMock(...args),
  onValue: (...args) => onValueMock(...args),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const MirrorFleetCard = (await import("./MirrorFleetCard.jsx")).default;
const {
  deviceState, ago, STALE_MS, guardWords, INACTIVE_MS, isInactive, reportedServing,
} = await import("./MirrorFleetCard.jsx");

const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };

async function render(authUser) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<MirrorFleetCard authUser={authUser} onExit={() => {}} />);
  });
  return tree;
}
const buttonNamed = (tree, re) =>
  tree.root.findAll((n) => n.type === "button"
    && re.test(JSON.stringify(n.children.map((c) => (typeof c === "string" ? c : c.children)))))[0];

describe("the gate", () => {
  beforeEach(() => { getMock.mockClear(); onValueMock.mockClear(); setMock.mockClear(); });

  it("reads nothing, and subscribes to nothing, for a viewer who is not the owner", async () => {
    await render(STAFF);
    expect(getMock).not.toHaveBeenCalled();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("reads nothing for a signed-out viewer", async () => {
    await render(null);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("is not fooled by an address that merely contains the owner's", async () => {
    for (const email of ["gunidmoh@gmail.com.evil.com", "gunidmoh@gmail.co", " gunidmoh@gmail.com", "GUNIDMOH@Gmail.com"]) {
      getMock.mockClear();
      await render({ uid: "u", email });
      expect(getMock, `"${email}" must not be admitted`).not.toHaveBeenCalled();
    }
  });

  it("never renders the kill switch for anyone else", async () => {
    const tree = await render(STAFF);
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/Turn the mirror/);
  });
});

describe("it must not be expensive", () => {
  beforeEach(() => { getMock.mockClear(); onValueMock.mockClear(); });

  it("reads the fleet ONCE, by exact path, with get()", async () => {
    await render(ADMIN);
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths).toEqual(["mirror_devices"]);
  });

  it("subscribes to exactly one node, and it is the five-byte switch", async () => {
    await render(ADMIN);
    expect(onValueMock).toHaveBeenCalledTimes(1);
    expect(onValueMock.mock.calls[0][0].path).toBe("mirror_switch/enabled");
  });

  it("never subscribes to the device list", async () => {
    await render(ADMIN);
    for (const call of onValueMock.mock.calls) {
      expect(call[0].path).not.toMatch(/mirror_devices/);
    }
  });
});

describe("the kill", () => {
  beforeEach(() => { getMock.mockClear(); onValueMock.mockClear(); setMock.mockClear(); });

  it("takes a confirmation, then writes false to the path every device watches", async () => {
    const tree = await render(ADMIN);
    // The switch reports itself ON.
    await act(async () => { onValueMock.mock.calls[0][1]({ exists: () => true, val: () => true }); });

    const kill = buttonNamed(tree, /Turn the mirror OFF/);
    expect(kill).toBeTruthy();
    await act(async () => { kill.props.onClick(); });
    // One tap ARMS it and writes nothing — this is not a button to brush past.
    expect(setMock).not.toHaveBeenCalled();

    await act(async () => { buttonNamed(tree, /Yes, turn it off/).props.onClick(); });
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0][0].path).toBe("mirror_switch/enabled");
    expect(setMock.mock.calls[0][1]).toBe(false);
  });

  it("offers to turn it back ON when it is off, and writes true", async () => {
    const tree = await render(ADMIN);
    await act(async () => { onValueMock.mock.calls[0][1]({ exists: () => true, val: () => false }); });
    await act(async () => { buttonNamed(tree, /Turn the mirror back ON/).props.onClick(); });
    await act(async () => { buttonNamed(tree, /Yes, turn it on/).props.onClick(); });
    expect(setMock.mock.calls[0][1]).toBe(true);
  });

  it("offers nothing at all while it cannot read the switch", async () => {
    // A button that claims to kill a fleet it cannot even read is worse than
    // no button: it would report success on a write nobody can confirm.
    const tree = await render(ADMIN);
    await act(async () => { onValueMock.mock.calls[0][2](new Error("PERMISSION_DENIED")); });
    expect(buttonNamed(tree, /Turn the mirror/)).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toMatch(/Cannot read it/);
  });
});

describe("what a device's row says", () => {
  const T = 1_790_000_000_000;
  const ok = {
    deviceId: "d1", at: T, complete: true, switchOn: true, downloading: false,
    pending: 0, guard: null,
  };

  it("a healthy device", () => {
    expect(deviceState(ok, T).text).toBe("serving from its own copy");
  });

  it("SILENT is not the same as healthy — a device that stopped reporting says so", () => {
    // The lesson of the social silence alarm: the failure that hides is the
    // one where nothing arrives, and a screen that shows the last good record
    // for ever is a screen that says everything is fine while a device is off.
    expect(deviceState(ok, T + STALE_MS + 1).text).toMatch(/^silent/);
  });

  it("a tripped guard is named in SHOP WORDS, and outranks everything else", () => {
    // The owner is operationally savvy and not a programmer. "products:
    // shrank" is a grep term; this is a sentence somebody can act on.
    const said = deviceState({ ...ok, guard: { leg: "products", reason: "shrank" } }, T).text;
    expect(said).toBe("the catalogue came back short, so the copy already here was kept");
    // Every leg word is a SINGULAR noun phrase, so it agrees with the verb
    // whichever way the two are paired.
    expect(guardWords({ leg: "stock", reason: "count-drift" }))
      .toBe("the stock copy does not match the server's count — downloading it again");
    // A reason nobody has written words for still says something true rather
    // than nothing.
    expect(guardWords({ leg: "products", reason: "brand-new-reason" }))
      .toBe("the catalogue brand-new-reason");
  });

  it("a downloading device and an incomplete one both say they are reading live", () => {
    expect(deviceState({ ...ok, complete: false, downloading: true }, T).text).toMatch(/downloading/);
    expect(deviceState({ ...ok, complete: false }, T).text).toMatch(/reading live/);
  });

  it("a device obeying a kill says so rather than looking broken", () => {
    expect(deviceState({ ...ok, switchOn: false }, T).text).toBe("reading live — switch off");
  });

  it("ago() reads as a person would say it", () => {
    expect(ago(null)).toBe("never");
    expect(ago(T - 30_000, T)).toBe("30s ago");
    expect(ago(T - 20 * 60_000, T)).toBe("20 min ago");
    expect(ago(T - 5 * 3600_000, T)).toBe("5h ago");
    expect(ago(T - 3 * 24 * 3600_000, T)).toBe("3d ago");
  });
});

describe("devices not in use, and what counts as serving", () => {
  const T = 1_790_000_000_000;
  const ok = { at: T, switchOn: true, complete: true, downloading: false, pending: 0, guard: null };

  it("a week of silence is inactive; six days is not", () => {
    expect(isInactive({ at: T - INACTIVE_MS - 1 }, T)).toBe(true);
    expect(isInactive({ at: T - 6 * 24 * 3600 * 1000 }, T)).toBe(false);
  });

  it("a serving device that has gone quiet overnight still counts as serving", () => {
    expect(reportedServing({ ...ok, at: T - STALE_MS - 1 })).toBe(true);
    expect(reportedServing({ ...ok, complete: false })).toBe(false);
    expect(reportedServing({ ...ok, switchOn: false })).toBe(false);
    expect(reportedServing({ ...ok, guard: { leg: "stock", reason: "gave-up" } })).toBe(false);
  });

  it("a save still confirming is green, not a warning", () => {
    const s = deviceState({ ...ok, pending: 1 }, T);
    expect(s.tone).toBe("#30d158");
    expect(s.text).toMatch(/^serving from its own copy/);
  });
});

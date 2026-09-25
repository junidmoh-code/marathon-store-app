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
const removeMock = vi.fn(async () => true);

vi.mock("firebase/database", () => ({
  getDatabase: () => ({ fake: true }),
  ref: (_db, path) => ({ path: path || "" }),
  get: (...args) => getMock(...args),
  set: (...args) => setMock(...args),
  remove: (...args) => removeMock(...args),
  onValue: (...args) => onValueMock(...args),
  // The reject-log range read (MirrorFleetCard.rejects.test.jsx pins it).
  query: (r, ...parts) => ({ ...r, constraints: parts }), orderByKey: () => ({ orderByKey: true }), startAt: (v) => ({ startAt: v }),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const MirrorFleetCard = (await import("./MirrorFleetCard.jsx")).default;
const {
  deviceState, ago, STALE_MS, guardWords, INACTIVE_MS, isInactive, reportedServing,
  isEvicting, storageWords,
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

  it("reads the fleet and the off-list ONCE each, by exact path, with get()", async () => {
    // TWO reads now, not one. The second is /mirror_switch/off: a flat map of
    // the devices that have been excused from mirroring, a handful of bytes
    // even when every device is on it. It is READ with the list, never
    // subscribed, for the same reason the list is — this is a screen about the
    // cost of reading the database.
    //
    // THREE since 2026-09-25: the per-device reject log. Unlike the other two
    // it grows every day, so it is read as a KEY RANGE (orderByKey + startAt,
    // the last REJECT_DAYS SA days) and never as the bare node —
    // MirrorFleetCard.rejects.test.jsx pins the exact range.
    await render(ADMIN);
    const paths = getMock.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["device_rejects", "mirror_devices", "mirror_switch/off"]);
    const rejectsRead = getMock.mock.calls.map((c) => c[0]).find((q) => q.path === "device_rejects");
    expect(rejectsRead.constraints).toContainEqual({ orderByKey: true });
    expect(rejectsRead.constraints.some((c) => typeof c?.startAt === "string")).toBe(true);
  });

  it("subscribes to exactly two small nodes: the switch, and the quarantine flags", async () => {
    await render(ADMIN);
    expect(onValueMock.mock.calls.map((c) => c[0].path)).toEqual([
      "mirror_switch/enabled", "mirror_switch/quarantine",
    ]);
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

describe("quarantine: one device, one tap, its own path only", () => {
  const T = Date.now();
  const EVICTING = "57070bab-8813-4164-9165-2f16fd7f9244";
  const HEALTHY = "d6bb8389-7f13-481b-9437-2544117c9a9d";
  const fleet = {
    [EVICTING]: {
      deviceId: EVICTING, label: "Android Chrome · installed · 5707", email: "mike@marathon.internal", at: T,
      complete: false, downloading: true, switchOn: true,
      storage: { persisted: false, wipes: 7, wipesToday: 7, lastWipeAt: T - 60_000 },
    },
    [HEALTHY]: {
      deviceId: HEALTHY, label: "Android Chrome · installed · d6bb", email: "mike@marathon.internal", at: T - 1000,
      complete: true, switchOn: true, storage: { persisted: true, wipes: 0, wipesToday: 0 },
    },
  };
  const quarantineListener = () => onValueMock.mock.calls.find((c) => c[0].path === "mirror_switch/quarantine");

  beforeEach(() => {
    getMock.mockReset();
    getMock.mockImplementation(async () => ({ exists: () => true, val: () => fleet }));
    onValueMock.mockClear(); setMock.mockClear(); removeMock.mockClear();
  });

  async function renderFleet() {
    const tree = await render(ADMIN);
    await act(async () => { quarantineListener()[1]({ exists: () => false, val: () => null }); });
    return tree;
  }
  const rowButtons = (tree) => tree.root.findAll((n) => n.type === "button"
    && /Quarantine this device|Release this device/.test(JSON.stringify(n.children)));

  it("one tap on a row writes ONLY that device's flag", async () => {
    const tree = await renderFleet();
    const buttons = rowButtons(tree);
    expect(buttons).toHaveLength(2);
    // Newest first: the evicting device reported last, so its row is first.
    const btn = buttons[0];
    await act(async () => { btn.props.onClick(); });
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0][0].path).toBe(`mirror_switch/quarantine/${EVICTING}`);
    expect(setMock.mock.calls[0][1]).toMatchObject({ on: true, by: "gunidmoh@gmail.com" });
    // Nothing ever touches the switch, the list, or another device.
    for (const c of setMock.mock.calls) expect(c[0].path).not.toMatch(/enabled$|quarantine$/);
  });

  it("a flagged device shows QUARANTINED, and one tap releases exactly it", async () => {
    const tree = await renderFleet();
    await act(async () => { quarantineListener()[1]({ exists: () => true, val: () => ({ [EVICTING]: { on: true, at: T } }) }); });
    expect(JSON.stringify(tree.toJSON())).toMatch(/QUARANTINED/);
    const release = rowButtons(tree).find((b) => /Release this device/.test(JSON.stringify(b.children)));
    await act(async () => { release.props.onClick(); });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock.mock.calls[0][0].path).toBe(`mirror_switch/quarantine/${EVICTING}`);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("a flag on a device that has never reported can still be released", async () => {
    const tree = await renderFleet();
    const ghost = "0f0f0f0f-0000-4000-8000-000000000000";
    await act(async () => { quarantineListener()[1]({ exists: () => true, val: () => ({ [ghost]: { on: true } }) }); });
    const release = tree.root.findAll((n) => n.type === "button" && JSON.stringify(n.children) === '["Release"]')[0];
    await act(async () => { release.props.onClick(); });
    expect(removeMock.mock.calls[0][0].path).toBe(`mirror_switch/quarantine/${ghost}`);
  });

  it("offers no quarantine button until the flag list has been read", async () => {
    const tree = await render(ADMIN);
    expect(rowButtons(tree)).toHaveLength(0);
    await act(async () => { quarantineListener()[2](new Error("permission_denied")); });
    expect(rowButtons(tree)).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toMatch(/Cannot read the quarantine list/);
  });

  it("a flag list that stops being readable offers no stale Release either", async () => {
    const tree = await renderFleet();
    const ghost = "0f0f0f0f-0000-4000-8000-000000000000";
    await act(async () => { quarantineListener()[1]({ exists: () => true, val: () => ({ [ghost]: { on: true } }) }); });
    expect(JSON.stringify(tree.toJSON())).toMatch(/Quarantined, but not in the list below/);
    await act(async () => { quarantineListener()[2](new Error("permission_denied")); });
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/Quarantined, but not in the list below/);
  });

  it("a staff viewer is never offered the button", async () => {
    const tree = await render(STAFF);
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/Quarantine/);
  });

  it("an evicting device is named in red, not shown as merely downloading", async () => {
    expect(isEvicting(fleet[EVICTING])).toBe(true);
    expect(isEvicting(fleet[HEALTHY])).toBe(false);
    expect(deviceState({ ...fleet[EVICTING], storage: { wipesToday: 1, persisted: true, lastWipeAt: T } }, T).text)
      .toBe("the browser deleted this device's copy once today");
    // A wipe reported before SAST midnight is not "today" the next morning.
    const yesterday = { ...fleet[EVICTING], storage: { ...fleet[EVICTING].storage, lastWipeAt: T - 26 * 3600_000 } };
    expect(isEvicting(yesterday, T)).toBe(false);
    expect(storageWords(yesterday.storage, T)).toMatch(/wiped 0× today, 7× in all/);
    // A live guard still outranks a wipe: it is the thing to act on now.
    expect(deviceState({ ...fleet[EVICTING], guard: { leg: "products", reason: "gave-up" } }, T).text)
      .toMatch(/^the catalogue kept failing/);
    const st = deviceState(fleet[EVICTING], T);
    expect(st.tone).toBe("#ff453a");
    expect(st.text).toBe("the browser keeps deleting this device's copy — wiped 7× today, storage not protected");
    expect(storageWords(fleet[EVICTING].storage, T)).toMatch(/NOT protected.*wiped 7× today, 7× in all, last 60s ago/);
    const tree = await renderFleet();
    const out = JSON.stringify(tree.toJSON());
    expect(out).toMatch(/Evicting/);
    expect(out).toMatch(/had their copy deleted by the browser/);
  });
});

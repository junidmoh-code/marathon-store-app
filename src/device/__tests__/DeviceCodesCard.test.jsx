// The Device codes screen against a fake callable: a code is shown once and
// then gone, one tap revokes, and only Junid is offered the code-maker box.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../firebase", () => ({ functions: {} }));
// The network registry without the live /network read behind it.
vi.mock("../../utils/useNetwork", async () => {
  const { SEED_REGISTRY } = await vi.importActual("../../utils/networkRegistry");
  return { useNetwork: () => ({ registry: SEED_REGISTRY, settled: true, error: false }) };
});
const DeviceCodesCard = (await import("../DeviceCodesCard.jsx")).default;
const { when, defaultCodeSection } = await import("../DeviceCodesCard.jsx");
const { PermissionsContext } = await import("../../components/PermissionsContext.jsx");
const { SEED_REGISTRY } = await import("../../utils/networkRegistry");

const NOW = Date.now();
function fakeServer() {
  const state = {
    people: [{ personId: "p1", name: "Sipho", kind: "person", status: "active", devices: 1, maxDevices: 2, canManageCodes: false, createdAtMs: NOW - 3600e3 }],
    devices: [{ deviceId: "dev-aaaaaaaa", personId: "p1", personName: "Sipho", kind: "person", status: "active", deviceType: "Android phone · Chrome", enrolledAtMs: NOW - 3600e3, lastSeenAtMs: NOW - 120e3, rejectCount: 2 }],
  };
  const calls = [];
  const call = vi.fn(async (data) => {
    calls.push(data);
    if (data.action === "list") return { ok: true, people: state.people, devices: state.devices, email: { lastSentAtMs: NOW - 10 * 60e3, queued: 2 } };
    if (data.action === "createCode") {
      state.people = [...state.people, { personId: "p2", name: data.name.trim(), kind: data.kind, status: "active", devices: 0, maxDevices: data.kind === "shared" ? 1 : 2, section: data.section }];
      return { ok: true, code: "4821", person: { name: data.name.trim(), section: data.section } };
    }
    if (data.action === "revokeDevice") { state.devices = state.devices.map((d) => (d.deviceId === data.deviceId ? { ...d, status: "revoked", revokedAtMs: NOW } : d)); return { ok: true }; }
    if (data.action === "revokePerson") { state.people = state.people.map((p) => (p.personId === data.personId ? { ...p, status: "revoked" } : p)); return { ok: true }; }
    throw new Error("unknown");
  });
  return { call, calls, state };
}
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const textOf = (r) => JSON.stringify(r.toJSON());
const button = (r, label) => r.root.findAll((n) => n.type === "button" && JSON.stringify(n.props.children).includes(label))[0];

describe("DeviceCodesCard", () => {
  it("lists devices with person, type, enrolled, last seen and rejects", async () => {
    const { call } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    const t = textOf(r);
    for (const s of ["Sipho", "Android phone · Chrome", "Last seen ", "2 min ago", "2", " reject"]) expect(t).toContain(s);
    expect(t).toContain("Emails to Junid: last sent ");
    expect(t).toContain("10 min ago");
    expect(t).toContain("2 waiting");
  });

  it("makes a code, shows it once, and the list afterwards does not carry it", async () => {
    const { call, calls } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    const input = r.root.findByProps({ "aria-label": "Person's name" });
    await act(async () => input.props.onChange({ target: { value: "Thandi" } }));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await flush();
    // Section 2 without a tap: every device there is today is a Section 2
    // device, so making a code is the same taps it always was.
    expect(calls.find((c) => c.action === "createCode")).toEqual({ action: "createCode", name: "Thandi", kind: "person", canManageCodes: false, section: 2 });
    expect(r.root.findAll((n) => n.props && n.props["data-new-code"] === "")[0].children.join("")).toContain("4821");
    await act(async () => button(r, "Done").props.onClick());
    expect(textOf(r)).not.toContain("4821");
  });

  it("a shop device is made under its device name", async () => {
    const { call, calls } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    await act(async () => button(r, "A shop device").props.onClick());
    const input = r.root.findByProps({ "aria-label": "Device name" });
    await act(async () => input.props.onChange({ target: { value: "Hub 2 tablet" } }));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await flush();
    expect(calls.find((c) => c.action === "createCode")).toMatchObject({ name: "Hub 2 tablet", kind: "shared", canManageCodes: false });
    expect(textOf(r)).toContain("It works on one device.");
  });

  it("one tap revokes a device, one tap revokes a person", async () => {
    const { call, calls } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    await act(async () => button(r, "Revoke device").props.onClick());
    await flush();
    expect(calls).toContainEqual({ action: "revokeDevice", deviceId: "dev-aaaaaaaa" });
    await act(async () => button(r, "Revoke person").props.onClick());
    await flush();
    expect(calls).toContainEqual({ action: "revokePerson", personId: "p1" });
  });

  it("only Junid is offered 'can make codes'", async () => {
    const { call } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner={false} call={call} onExit={() => {}} />); });
    await flush();
    expect(textOf(r)).not.toContain("Can make and revoke codes");
    act(() => r.unmount());
    act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    expect(textOf(r)).toContain("Can make and revoke codes");
  });

  it("a refusal from the server is shown, not swallowed", async () => {
    const call = vi.fn(async () => { throw Object.assign(new Error("Only Junid or MC can manage device codes."), { code: "functions/permission-denied" }); });
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner={false} call={call} onExit={() => {}} />); });
    await flush();
    expect(textOf(r)).toContain("Only Junid or MC can manage device codes.");
  });

  // ── the section a code is made for ─────────────────────────────────────────
  const pick = (r, n) => r.root.findAll((x) => x.props && x.props["data-section-pick"] === n)[0];
  const makeCode = async (r, name) => {
    const input = r.root.findByProps({ "aria-label": "Person's name" });
    await act(async () => input.props.onChange({ target: { value: name } }));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await flush();
  };
  const withViewer = (value, node) => (
    <PermissionsContext.Provider value={{ permRecord: null, deviceIdentity: { section: null }, ...value }}>{node}</PermissionsContext.Provider>
  );

  it("the section is PICKED — two buttons named by the registry, Section 2 selected to start", async () => {
    const { call } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    expect(JSON.stringify(pick(r, 1).props.children)).toContain("Concrete group");
    expect(JSON.stringify(pick(r, 2).props.children)).toContain("Marathon");
    expect(pick(r, 2).props["aria-checked"]).toBe(true);
    expect(pick(r, 1).props["aria-checked"]).toBe(false);
    // Nothing is typed for it: the only text input on the form is the name.
    expect(r.root.findByType("form").findAll((n) => n.type === "input" && n.props.type !== "checkbox")).toHaveLength(1);
  });

  it("one tap makes it a Section 1 code, and the confirmation says which section", async () => {
    const { call, calls } = fakeServer();
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    await act(async () => pick(r, 1).props.onClick());
    await makeCode(r, "Pine tablet");
    expect(calls.find((c) => c.action === "createCode")).toMatchObject({ name: "Pine tablet", section: 1 });
    expect(textOf(r)).toContain("The device will work in ");
    expect(textOf(r)).toContain("Concrete group");
  });

  it("starts on the section of the code-maker's own shop, or of their own device", async () => {
    const { call, calls } = fakeServer();
    let r; act(() => { r = TestRenderer.create(withViewer({ permRecord: { destShop: "marathon-pine" } },
      <DeviceCodesCard isOwner={false} call={call} onExit={() => {}} />)); });
    await flush();
    expect(pick(r, 1).props["aria-checked"]).toBe(true);
    await makeCode(r, "Pine phone");
    expect(calls.find((c) => c.action === "createCode").section).toBe(1);

    expect(defaultCodeSection(SEED_REGISTRY, {})).toBe(2);
    expect(defaultCodeSection(SEED_REGISTRY, { destShop: "marathon-pe" })).toBe(2);
    expect(defaultCodeSection(SEED_REGISTRY, { destShop: "trophy" })).toBe(2);
    expect(defaultCodeSection(SEED_REGISTRY, { destShop: "concrete" })).toBe(1);
    expect(defaultCodeSection(SEED_REGISTRY, { destShop: "marathon-pine" })).toBe(1);
    expect(defaultCodeSection(SEED_REGISTRY, { destShop: "nowhere" })).toBe(2);
    // The device's own section wins over the account's shop.
    expect(defaultCodeSection(SEED_REGISTRY, { deviceSection: 1, destShop: "trophy" })).toBe(1);
    expect(defaultCodeSection(SEED_REGISTRY, { deviceSection: 2, destShop: "concrete" })).toBe(2);
  });

  it("the lists say each device's and each code's section; one from before sections says both", async () => {
    const { call, state } = fakeServer();
    state.devices = [{ ...state.devices[0], section: 1 }, { ...state.devices[0], deviceId: "dev-bbbbbbbb", personName: "Old phone" }];
    state.people = [{ ...state.people[0], section: 2 }];
    let r; act(() => { r = TestRenderer.create(<DeviceCodesCard isOwner call={call} onExit={() => {}} />); });
    await flush();
    const rowText = (attr, id) => {
      const walk = (n) => (n == null ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(walk).join("") : walk(n.children));
      return walk(r.toJSON().children.find((c) => JSON.stringify(c).includes(`"${attr}":"${id}"`)));
    };
    expect(rowText("data-device-row", "dev-aaaaaaaa")).toContain("Android phone · Chrome · Concrete group");
    expect(rowText("data-device-row", "dev-bbbbbbbb")).toContain("Android phone · Chrome · Both divisions");
    expect(rowText("data-person-row", "p1")).toContain("Sipho · Marathon");
  });

  it("when() reads like a person would say it", () => {
    expect(when(null)).toBe("never");
    expect(when(NOW - 30e3, NOW)).toBe("just now");
    expect(when(NOW - 5 * 60e3, NOW)).toBe("5 min ago");
    expect(when(NOW - 5 * 3600e3, NOW)).toBe("5h ago");
  });
});

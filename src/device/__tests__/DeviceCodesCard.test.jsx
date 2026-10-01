// The Device codes screen against a fake callable: a code is shown once and
// then gone, one tap revokes, and only Junid is offered the code-maker box.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../firebase", () => ({ functions: {} }));
const DeviceCodesCard = (await import("../DeviceCodesCard.jsx")).default;
const { when } = await import("../DeviceCodesCard.jsx");

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
      state.people = [...state.people, { personId: "p2", name: data.name.trim(), kind: data.kind, status: "active", devices: 0, maxDevices: data.kind === "shared" ? 1 : 2 }];
      return { ok: true, code: "4821", person: { name: data.name.trim() } };
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
    expect(calls.find((c) => c.action === "createCode")).toEqual({ action: "createCode", name: "Thandi", kind: "person", canManageCodes: false });
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

  it("when() reads like a person would say it", () => {
    expect(when(null)).toBe("never");
    expect(when(NOW - 30e3, NOW)).toBe("just now");
    expect(when(NOW - 5 * 60e3, NOW)).toBe("5 min ago");
    expect(when(NOW - 5 * 3600e3, NOW)).toBe("5h ago");
  });
});

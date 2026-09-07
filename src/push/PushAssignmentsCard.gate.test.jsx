// ─── ORDER ALERTS — THE GATES, AND THE READS A REFUSED VIEWER MUST NOT MAKE ──
// Same discipline as src/components/UserManagement.gate.test.jsx: the point is
// to make DELETING A GATE FAIL CI, and to assert on the LISTENER rather than on
// what rendered, because "it showed the refusal screen" says nothing about
// whether the staff roster was read on the way there.
//
// The RTDB rule is the only real enforcement (PUSH-ASSIGNMENT-RULES-DEPLOY.md)
// and no test here can stand in for it — a rule lives in the console. What
// these DO pin is the half that is in this repo: the component refuses on its
// own with the route bypassed, it reads nothing when it refuses, and the write
// it performs when it does not refuse is the two-path assignment update and
// nothing else.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "#admin/notifications" },
  scrollY: 0, scrollTo() {}, requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const getMock = vi.fn(async () => ({ val: () => ({}) }));
const updateMock = vi.fn(async () => {});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  get: (...args) => getMock(...args),
  update: (...args) => updateMock(...args),
}));
vi.mock("../firebase", () => ({ database: { fake: true } }));
vi.mock("../utils/serverTime", () => ({ serverNowMs: () => 1_757_000_000_000 }));

const PushAssignmentsCard = (await import("./PushAssignmentsCard.jsx")).default;

const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com", displayName: "Junid" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };

const render = async (props) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<PushAssignmentsCard onExit={() => {}} {...props} />); });
  return tree;
};
const screenNames = (tree) =>
  tree.root.findAll((n) => typeof n.type === "function").map((n) => n.type.name);

beforeEach(() => { getMock.mockClear(); updateMock.mockClear(); });

describe("a refused viewer reads NOTHING", () => {
  it("a signed-in non-super-admin triggers no read at all", async () => {
    await render({ authUser: STAFF });
    expect(getMock).not.toHaveBeenCalled();
  });

  it("no authenticated user at all triggers no read", async () => {
    await render({ authUser: null });
    expect(getMock).not.toHaveBeenCalled();
  });

  it("the super-admin DOES read — so the two above are not vacuous", async () => {
    await render({ authUser: ADMIN });
    const paths = getMock.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["push_assignments", "push_tokens", "users"]);
  });

  it("reads ONCE, not on a subscription — closing the screen ends the cost", async () => {
    await render({ authUser: ADMIN });
    expect(getMock).toHaveBeenCalledTimes(3);
  });
});

describe("LAYER 2 — the component gate, with App.jsx's route gate bypassed", () => {
  it("refuses a non-super-admin mounted directly", async () => {
    const names = screenNames(await render({ authUser: STAFF }));
    expect(names).not.toContain("PushAssignmentsAuthed");
  });

  it("refuses an account whose email merely resembles the admin's", async () => {
    for (const email of [
      "gunidmoh@gmail.com.evil.com",
      "GUNIDMOH@gmail.com",
      "junidmoh@gmail.com",   // the real near-miss: Junid's OTHER address
      "gunidmoh@gmail.co",
      " gunidmoh@gmail.com",
    ]) {
      const names = screenNames(await render({ authUser: { uid: "x", email } }));
      expect(names, `must refuse ${email}`).not.toContain("PushAssignmentsAuthed");
      expect(getMock, `must not read for ${email}`).not.toHaveBeenCalled();
    }
  });

  it("admits the super-admin — so the refusals above mean something", async () => {
    expect(screenNames(await render({ authUser: ADMIN }))).toContain("PushAssignmentsAuthed");
  });
});

describe("the roster it shows", () => {
  const world = {
    users: {
      u_ware:  { displayName: "Ayanda", stockRole: "warehouse", destShop: "marathon-pe" },
      u_bare:  { displayName: "Bongi" },                      // no stockRole, no destShop
      u_shop:  { displayName: "Chris", stockRole: "store" },   // no destShop
      "u.bad": { displayName: "Dawid" },                       // unusable as a path segment
    },
    push_assignments: { u_ware: { hub1: true, hub2: false, updatedAt: 1 } },
    push_tokens: { u_ware: { d1: { token: "tok-A" } }, u_bare: { d1: { device: "no token string" } } },
  };
  const withWorld = () => {
    getMock.mockImplementation(async (r) => ({ val: () => world[r.path] || null }));
  };

  const rowSwitches = (tree) =>
    tree.root.findAll((n) => n.props && n.props.role === "switch");

  it("shows the accounts with NO stockRole and NO destShop — they are the invisible ones", async () => {
    withWorld();
    const tree = await render({ authUser: ADMIN });
    const labels = rowSwitches(tree).map((n) => n.props["aria-label"]);
    expect(labels.join("|")).toContain("Bongi");
    expect(labels.join("|")).toContain("Chris");
  });

  it("offers exactly Hub 1 and Hub 2 per staff row", async () => {
    withWorld();
    const tree = await render({ authUser: ADMIN });
    // 3 usable accounts × 2 hubs. The 4th uid is not a legal RTDB key.
    expect(rowSwitches(tree)).toHaveLength(6);
    expect(rowSwitches(tree).map((n) => n.props["aria-label"]).join("|")).not.toContain("Dawid");
  });

  it("an existing assignment renders ON, and only for the hub it names", async () => {
    withWorld();
    const tree = await render({ authUser: ADMIN });
    const ayanda = rowSwitches(tree).filter((n) => n.props["aria-label"].includes("Ayanda"));
    expect(ayanda.map((n) => n.props["aria-checked"])).toEqual([true, false]);
  });

  it("everyone else renders OFF — absence of a record is off, not unset", async () => {
    withWorld();
    const tree = await render({ authUser: ADMIN });
    const others = rowSwitches(tree).filter((n) => !n.props["aria-label"].includes("Ayanda"));
    expect(others.every((n) => n.props["aria-checked"] === false)).toBe(true);
  });

  it("a token row with no token STRING is not a device — an assignment there cannot deliver", async () => {
    withWorld();
    const tree = await render({ authUser: ADMIN });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("no device");
  });
});

describe("what a tap actually writes", () => {
  it("writes the record AND the index in ONE multi-path update, nothing else", async () => {
    getMock.mockImplementation(async (r) => ({
      val: () => (r.path === "users" ? { u1: { displayName: "Ayanda" } } : null),
    }));
    const tree = await render({ authUser: ADMIN });
    const hub1 = tree.root.findAll((n) => n.props && n.props.role === "switch")[0];
    await act(async () => { hub1.props.onClick(); });

    expect(updateMock).toHaveBeenCalledTimes(1);
    // ref(database) with no path — a ROOT multi-path update.
    expect(updateMock.mock.calls[0][0]).toEqual({ path: "" });
    expect(updateMock.mock.calls[0][1]).toEqual({
      "push_assignments/u1": { hub1: true, hub2: false, updatedAt: 1_757_000_000_000 },
      "push_hub_audience/hub1/u1": { at: 1_757_000_000_000 },
      "push_hub_audience/hub2/u1": null,
    });
  });

  it("the stamp comes from serverNowMs, not the device clock", async () => {
    getMock.mockImplementation(async (r) => ({
      val: () => (r.path === "users" ? { u1: { displayName: "Ayanda" } } : null),
    }));
    const tree = await render({ authUser: ADMIN });
    await act(async () => {
      tree.root.findAll((n) => n.props && n.props.role === "switch")[0].props.onClick();
    });
    expect(updateMock.mock.calls[0][1]["push_assignments/u1"].updatedAt).toBe(1_757_000_000_000);
  });

  it("a REFUSED write puts the row back — an assignment that looks made and was not is the worst outcome", async () => {
    getMock.mockImplementation(async (r) => ({
      val: () => (r.path === "users" ? { u1: { displayName: "Ayanda" } } : null),
    }));
    updateMock.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    const tree = await render({ authUser: ADMIN });
    const sw = () => tree.root.findAll((n) => n.props && n.props.role === "switch")[0];
    await act(async () => { sw().props.onClick(); });
    expect(sw().props["aria-checked"]).toBe(false);
    expect(JSON.stringify(tree.toJSON())).toContain("did not save");
  });
});

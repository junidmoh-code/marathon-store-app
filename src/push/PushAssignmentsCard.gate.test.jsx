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

// ── THE FAKE HAS TO MODEL THE QUERY, NOT SWALLOW IT ─────────────────────────
// The roster is read in bounded pages (src/push/pagedRead.js), so the fake
// database must return a snapshot that supports forEach and must honour
// orderByKey/startAfter/limitToFirst. A fake that ignored the constraints and
// handed back every child would make the paging untestable and would let a
// broken cursor pass — the same trap as a fake that ignores its options
// argument. `snapshotFor` below is the ONE place the query is interpreted.
const getMock = vi.fn(async () => ({}));
const updateMock = vi.fn(async () => {});

const snapshotFor = (value, constraints) => {
  const paged = constraints.some((c) => c.kind === "limitToFirst");
  if (!paged || !value || typeof value !== "object") {
    return { val: () => (value === undefined ? null : value), forEach: () => false };
  }
  const after = constraints.find((c) => c.kind === "startAfter");
  const limit = constraints.find((c) => c.kind === "limitToFirst");
  const keys = Object.keys(value).sort()
    .filter((k) => (after ? k > after.value : true))
    .slice(0, limit.value);
  return {
    val: () => Object.fromEntries(keys.map((k) => [k, value[k]])),
    forEach: (cb) => { for (const k of keys) if (cb({ key: k, val: () => value[k] })) return true; return false; },
  };
};

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  query: (node, ...constraints) => ({ path: node.path, constraints }),
  orderByKey: () => ({ kind: "orderByKey" }),
  limitToFirst: (n) => ({ kind: "limitToFirst", value: n }),
  startAfter: (v) => ({ kind: "startAfter", value: v }),
  get: (...args) => getMock(...args),
  update: (...args) => updateMock(...args),
}));
vi.mock("../firebase", () => ({ database: { fake: true } }));
vi.mock("../utils/serverTime", () => ({ serverNowMs: () => 1_757_000_000_000 }));

const PushAssignmentsCard = (await import("./PushAssignmentsCard.jsx")).default;

const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com", displayName: "Junid" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };

// Serves any world object keyed by top-level path, including the per-uid
// `push_tokens/{uid}` reads the card now issues.
const worldReader = (world) => async (r) => {
  const direct = Object.prototype.hasOwnProperty.call(world, r.path) ? world[r.path] : undefined;
  if (direct !== undefined) return snapshotFor(direct, r.constraints || []);
  const slash = r.path.indexOf("/");
  if (slash > 0) {
    const parent = world[r.path.slice(0, slash)];
    const child = parent && parent[r.path.slice(slash + 1)];
    return snapshotFor(child === undefined ? null : child, r.constraints || []);
  }
  return snapshotFor(null, r.constraints || []);
};

// The rendered TEXT, not the JSON tree — see the note at its first use below.
const flattenTree = (tree) => {
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return "";
    if (Array.isArray(node)) return node.map(walk).join("");
    if (typeof node === "object") return walk(node.children);
    return String(node);
  };
  return walk(tree.toJSON());
};

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
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    await render({ authUser: ADMIN });
    const paths = getMock.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["push_assignments", "push_tokens/u1", "users"]);
  });

  it("NEVER reads the /push_tokens node — the live rules refuse it, and it is every token in the business", async () => {
    // This is the bug the screen shipped with: a whole-node read of
    // /push_tokens is denied for everyone (the rules put .read on $uid only),
    // and it took the two reads that DO work down with it.
    getMock.mockImplementation(worldReader({
      users: { u1: { displayName: "Ayanda" }, u2: { displayName: "Bongi" } },
    }));
    await render({ authUser: ADMIN });
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths).not.toContain("push_tokens");
    expect(paths).toContain("push_tokens/u1");
    expect(paths).toContain("push_tokens/u2");
  });

  it("the node reads are BOUNDED — orderByKey + limitToFirst, never an open fetch", async () => {
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    await render({ authUser: ADMIN });
    for (const path of ["users", "push_assignments"]) {
      const call = getMock.mock.calls.find((c) => c[0].path === path);
      const kinds = (call[0].constraints || []).map((c) => c.kind);
      expect(kinds, `${path} must be a bounded query`).toContain("limitToFirst");
      expect(kinds, `${path} must be ordered by key`).toContain("orderByKey");
    }
  });

  it("reads ONCE, not on a subscription — closing the screen ends the cost", async () => {
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    await render({ authUser: ADMIN });
    // roster + assignments + one token read for the one account. No listener.
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
  const withWorld = () => { getMock.mockImplementation(worldReader(world)); };

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
    // Bongi HAS a /push_tokens/u_bare node; its one entry just carries no
    // `token` string. Asserting only that "no device" appears somewhere was
    // vacuous — Chris has no token node at all and renders the same words. So
    // this pins Bongi's row specifically, against Ayanda's real device in the
    // same render.
    withWorld();
    const tree = await render({ authUser: ADMIN });
    // Each row renders name, then "role · shop · devices", contiguously.
    const t = flattenTree(tree);
    expect(t).toContain("Bongino stock role · no shop · no device");
    expect(t, "otherwise the token filter could be deleted")
      .toContain("Ayandawarehouse · marathon-pe · 1 device");
  });
});

describe("what a tap actually writes", () => {
  it("writes the record AND the index in ONE multi-path update, nothing else", async () => {
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
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
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    const tree = await render({ authUser: ADMIN });
    await act(async () => {
      tree.root.findAll((n) => n.props && n.props.role === "switch")[0].props.onClick();
    });
    expect(updateMock.mock.calls[0][1]["push_assignments/u1"].updatedAt).toBe(1_757_000_000_000);
  });

  it("a save that SUCCEEDS clears a warning from an earlier failure", async () => {
    // A stale "did not save" is not clutter, it is wrong information: it says
    // the rules are missing when they are not, over an assignment that IS
    // stored. Found by CodeRabbit on PR #573.
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    updateMock.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    const tree = await render({ authUser: ADMIN });
    const sw = () => tree.root.findAll((n) => n.props && n.props.role === "switch")[0];
    await act(async () => { sw().props.onClick(); });
    expect(JSON.stringify(tree.toJSON())).toContain("did not save");
    await act(async () => { sw().props.onClick(); });
    expect(sw().props["aria-checked"], "and the retry actually took").toBe(true);
    expect(JSON.stringify(tree.toJSON())).not.toContain("did not save");
  });

  it("ONE ROW'S SUCCESS DOES NOT ERASE ANOTHER ROW'S REFUSAL", async () => {
    // Rows save concurrently — only the saving row is disabled — so with one
    // shared message, B's success wiped A's warning and A sat rolled back with
    // no explanation of why. Found by the second-opinion reviewer on PR #573
    // after CodeRabbit rate-limited.
    getMock.mockImplementation(worldReader({
      users: { u1: { displayName: "Ayanda" }, u2: { displayName: "Bongi" } },
    }));
    const tree = await render({ authUser: ADMIN });
    const swFor = (name) => tree.root.findAll(
      (n) => n.props && n.props.role === "switch" && n.props["aria-label"].includes(name))[0];

    updateMock.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    await act(async () => { swFor("Ayanda").props.onClick(); });   // fails
    await act(async () => { swFor("Bongi").props.onClick(); });    // succeeds

    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("did not save");
    expect(text).toContain("Ayanda");
    expect(swFor("Ayanda").props["aria-checked"], "put back").toBe(false);
    expect(swFor("Bongi").props["aria-checked"], "and Bongi's save stands").toBe(true);
  });

  it("a row save cannot erase a failure to read the staff list", async () => {
    // Different facts about different things. The load banner says the screen
    // may be showing nothing rather than nobody, which no row save resolves.
    getMock.mockRejectedValue(new Error("PERMISSION_DENIED on /users"));
    const tree = await render({ authUser: ADMIN });
    expect(JSON.stringify(tree.toJSON())).toContain("nothing rather than nobody");
  });

  it("a REFUSED write puts the row back — an assignment that looks made and was not is the worst outcome", async () => {
    getMock.mockImplementation(worldReader({ users: { u1: { displayName: "Ayanda" } } }));
    updateMock.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    const tree = await render({ authUser: ADMIN });
    const sw = () => tree.root.findAll((n) => n.props && n.props.role === "switch")[0];
    await act(async () => { sw().props.onClick(); });
    expect(sw().props["aria-checked"]).toBe(false);
    expect(JSON.stringify(tree.toJSON())).toContain("did not save");
  });
});

// ─── WHAT THE SCREEN SAYS WHEN A READ DOES NOT COME BACK ─────────────────────
// The bug this screen shipped with was not that a read failed — it was that a
// failed read was reported as an answer: "0 of 0 assigned", under a banner, on
// a roster that had loaded fine. Every test below pins the difference between
// "I do not know" and "nobody".
describe("a read that fails is never rendered as an answer", () => {
  const STAFF_WORLD = {
    users: {
      u_ware: { displayName: "Ayanda", stockRole: "warehouse", destShop: "marathon-pe" },
      u_bare: { displayName: "Bongi" },
      u_till: { stockRole: "pos", posAccess: { role: "cashier", displayName: "yasmin" } },
    },
    push_assignments: { u_ware: { hub1: true, hub2: false, updatedAt: 1 } },
    push_tokens: { u_ware: { d1: { token: "tok-A" } } },
  };
  // A reader that serves the world but REFUSES the named top-level nodes, the
  // way the live rules refuse one of them today.
  const refusing = (world, deny) => {
    const ok = worldReader(world);
    return async (r) => {
      if (deny.some((d) => r.path === d || r.path.startsWith(`${d}/`))) {
        throw new Error(`PERMISSION_DENIED at /${r.path}`);
      }
      return ok(r);
    };
  };
  // The rendered TEXT, not the JSON. JSX splits "{n} of {m} assigned" into
  // three children, so a JSON.stringify assertion for the sentence a person
  // actually reads on screen would fail against a perfectly correct render —
  // and, worse, pass for a wrong one that happened to be split differently.
  const flatten = (node) => {
    if (node === null || node === undefined || node === false) return "";
    if (Array.isArray(node)) return node.map(flatten).join("");
    if (typeof node === "object") return flatten(node.children);
    return String(node);
  };
  const text = (tree) => flatten(tree.toJSON());

  // ── 1. the roster read fails ───────────────────────────────────────────
  it("a failed roster read shows the banner and NEVER an empty list", async () => {
    getMock.mockImplementation(refusing(STAFF_WORLD, ["users"]));
    const tree = await render({ authUser: ADMIN });
    const t = text(tree);
    expect(t, "the banner stands").toContain("nothing rather than nobody");
    expect(t, "and says plainly that this is not an empty roster").toContain("not an empty roster");
    expect(t, "the empty-list wording must not appear").not.toContain("No staff accounts match that");
    expect(t, "and no count is asserted at all").not.toMatch(/\d+ of \d+ assigned/);
    expect(tree.root.findAll((n) => n.props && n.props.role === "switch")).toHaveLength(0);
  });

  it("a roster read that succeeds does NOT show that banner — so the above is not vacuous", async () => {
    getMock.mockImplementation(worldReader(STAFF_WORLD));
    const t = text(await render({ authUser: ADMIN }));
    expect(t).not.toContain("nothing rather than nobody");
    expect(t).toContain("Ayanda");
  });

  // ── 2. the assignment read fails ───────────────────────────────────────
  it("the assigned count reflects real assignments, not a failed read", async () => {
    getMock.mockImplementation(worldReader(STAFF_WORLD));
    const t = text(await render({ authUser: ADMIN }));
    // Two visible accounts (the till is excluded), one of them assigned.
    expect(t).toContain("1 of 2 assigned");
  });

  it("a failed assignment read says so instead of counting 0 of N", async () => {
    // 0 of 2 would be a claim that nobody is assigned. Ayanda IS assigned.
    getMock.mockImplementation(refusing(STAFF_WORLD, ["push_assignments"]));
    const tree = await render({ authUser: ADMIN });
    const t = text(tree);
    expect(t).toContain("assignments could not be read");
    expect(t).not.toContain("of 2 assigned");
    expect(t, "the names still load — only the decisions are unknown").toContain("Ayanda");
  });

  it("and LOCKS the switches, because one tap would clear the other hub", async () => {
    // assignmentUpdates always writes BOTH hubs. With every row showing [] for
    // "unknown", turning hub2 on would null out Ayanda's real hub1 entry.
    getMock.mockImplementation(refusing(STAFF_WORLD, ["push_assignments"]));
    const tree = await render({ authUser: ADMIN });
    const switches = tree.root.findAll((n) => n.props && n.props.role === "switch");
    expect(switches.length).toBeGreaterThan(0);
    expect(switches.every((n) => n.props.disabled === true)).toBe(true);
    await act(async () => { switches[0].props.onClick(); });
    expect(updateMock, "and the guard holds even if the attribute is bypassed").not.toHaveBeenCalled();
  });

  // ── 3. the device reads fail ───────────────────────────────────────────
  it("a refused device read says 'device unknown', not 'no device'", async () => {
    getMock.mockImplementation(refusing(STAFF_WORLD, ["push_tokens"]));
    const tree = await render({ authUser: ADMIN });
    const t = text(tree);
    expect(t).toContain("device unknown");
    expect(t).not.toContain("no device");
    expect(t, "and points at the rule that fixes it").toContain("PUSH-TOKENS-ADMIN-READ-RULE.md");
  });

  it("THE LIST STILL WORKS with devices refused — this is the live state today", async () => {
    // Until the per-uid rule is pasted, this is exactly what the owner sees.
    // The whole point of the fix is that the screen is usable here.
    getMock.mockImplementation(refusing(STAFF_WORLD, ["push_tokens"]));
    const tree = await render({ authUser: ADMIN });
    expect(text(tree)).not.toContain("nothing rather than nobody");
    expect(text(tree)).toContain("of 2 assigned");
    const switches = tree.root.findAll((n) => n.props && n.props.role === "switch");
    expect(switches.every((n) => n.props.disabled)).toBe(false);
    await act(async () => { switches[0].props.onClick(); });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("a device read that SUCCEEDS reports the real count — so 'unknown' means something", async () => {
    getMock.mockImplementation(worldReader(STAFF_WORLD));
    const t = text(await render({ authUser: ADMIN }));
    expect(t).toContain("1 device");
    expect(t).toContain("no device");        // Bongi, who genuinely has none
    expect(t).not.toContain("device unknown");
  });

  // ── 4. the roster itself ───────────────────────────────────────────────
  it("excludes the till login and says how many it hid", async () => {
    getMock.mockImplementation(worldReader(STAFF_WORLD));
    const tree = await render({ authUser: ADMIN });
    const labels = tree.root.findAll((n) => n.props && n.props.role === "switch")
      .map((n) => n.props["aria-label"]).join("|");
    expect(labels).toContain("Ayanda");
    expect(labels).toContain("Bongi");
    expect(labels, "a till has no browser to notify").not.toContain("u_till");
    expect(text(tree)).toContain("1 till login not shown");
  });

  it("an account with NO stockRole is still on the list", async () => {
    // The 9 live accounts with no stockRole are the ones this screen exists
    // for. Absence of a role is not evidence of being a till.
    getMock.mockImplementation(worldReader({
      users: { u_bare: { displayName: "Bongi" }, u_none: {} },
    }));
    const tree = await render({ authUser: ADMIN });
    const labels = tree.root.findAll((n) => n.props && n.props.role === "switch")
      .map((n) => n.props["aria-label"]).join("|");
    expect(labels).toContain("Bongi");
    expect(labels).toContain("u_none");
    expect(text(tree)).not.toContain("till login");
  });

  it("keeps a 'pos' account that has a real identity — Zee is a person", async () => {
    getMock.mockImplementation(worldReader({
      users: { zee: { displayName: "Zee", username: "zee", role: "admin", stockRole: "pos" } },
    }));
    const tree = await render({ authUser: ADMIN });
    expect(tree.root.findAll((n) => n.props && n.props.role === "switch")
      .map((n) => n.props["aria-label"]).join("|")).toContain("Zee");
  });
});

// ─── WHAT THE SECOND-OPINION REVIEWERS FOUND, PINNED ─────────────────────────
// CodeRabbit was rate-limited on PR #579 and never ran. These are the findings
// the substitute reviewers raised on the head it never saw. Each is a real
// failure the tests above did not catch.
describe("only the newest load may write state", () => {
  const WORLD = { users: { u1: { displayName: "Ayanda" }, u2: { displayName: "Bongi" } } };

  it("a STALE load cannot revert a hub the admin just switched on", async () => {
    // The screen is wrapped in StrictMode (src/main.jsx), which double-invokes
    // mount effects, and "Try again" calls load() directly. Two runs both end
    // in setRows, so the one that RESOLVES last wins regardless of which
    // STARTED last — an older run could put back a switch whose write landed,
    // with nothing on screen saying anything failed.
    //
    // react-test-renderer does not emulate StrictMode's double effect, so the
    // race is driven through the other door onto the same instance: `load` is
    // a useCallback with no deps, so the retry button's handler is that one
    // stable function and calling it twice is exactly what two overlapping
    // mount effects do.
    const base = worldReader(WORLD);
    let rosterReads = 0;
    let release;
    const held = new Promise((r) => { release = r; });
    getMock.mockImplementation(async (r) => {
      if (r.path !== "users") return base(r);
      rosterReads += 1;
      if (rosterReads === 1) throw new Error("PERMISSION_DENIED");  // puts the retry button up
      if (rosterReads === 2) { await held; }                        // the load that goes stale
      return base(r);
    });

    const tree = await render({ authUser: ADMIN });
    const retry = tree.root.findAll((n) => n.props && typeof n.props.onClick === "function"
      && n.props.disabled !== undefined)[0].props.onClick;
    expect(retry, "the failed-read state offers a retry").toBeTruthy();

    await act(async () => { retry(); });                 // load 2 — held
    await act(async () => { retry(); await new Promise((r) => setTimeout(r, 0)); });  // load 3 — wins
    expect(rosterReads).toBe(3);

    const sw = () => tree.root.findAll((n) => n.props && n.props.role === "switch")[0];
    await act(async () => { sw().props.onClick(); });
    expect(sw().props["aria-checked"], "the toggle took").toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);

    // NOW the older load 2 finally resolves. It must write nothing at all.
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(sw().props["aria-checked"], "a stale load must not put the switch back").toBe(true);
    expect(tree.root.findAll((n) => n.props && n.props.role === "switch"),
      "and must not rebuild the list underneath it").toHaveLength(4);
  });
});

describe("a PARTIAL assignment read is an unknown one, not an empty one", () => {
  it("locks the switches and says so when the assignment read is truncated", async () => {
    // Truncation of the roster is a short list. Truncation of the ASSIGNMENTS
    // means a uid past the boundary reads as unassigned when it is not, and
    // one tap would write both hubs and clear the record we never saw.
    getMock.mockImplementation(async (r) => {
      const base = worldReader({ users: { a0: { displayName: "Ayanda" } } });
      if (r.path === "push_assignments") {
        // A node with more children than the page budget: every page comes
        // back FULL and with an advancing cursor, so the read runs out of
        // pages instead of running out of children.
        const limit = r.constraints.find((c) => c.kind === "limitToFirst").value;
        const after = r.constraints.find((c) => c.kind === "startAfter");
        let n = after ? Number(after.value.slice(1)) + 1 : 0;
        const keys = Array.from({ length: limit }, () => `k${String(n++).padStart(8, "0")}`);
        return { forEach: (cb) => { for (const k of keys) if (cb({ key: k, val: () => ({ hub1: true }) })) return true; return false; } };
      }
      return base(r);
    });
    const tree = await render({ authUser: ADMIN });
    const t = flattenTree(tree);
    expect(t).toContain("assignments could not be read");
    const switches = tree.root.findAll((n) => n.props && n.props.role === "switch");
    expect(switches.every((n) => n.props.disabled === true)).toBe(true);
    await act(async () => { switches[0].props.onClick(); });
    expect(updateMock, "a truncated read is an unknown baseline").not.toHaveBeenCalled();
  });

  it("and does NOT claim a staff account is missing — the roster read was complete", async () => {
    // A single shared `truncated` flag raised the ROSTER's banner here, which
    // says "somebody may be missing from it" over a roster that is complete.
    // Two facts, two flags, two sentences.
    getMock.mockImplementation(async (r) => {
      const base = worldReader({ users: { a0: { displayName: "Ayanda" } } });
      if (r.path !== "push_assignments") return base(r);
      const limit = r.constraints.find((c) => c.kind === "limitToFirst").value;
      const after = r.constraints.find((c) => c.kind === "startAfter");
      let n = after ? Number(after.value.slice(1)) + 1 : 0;
      const keys = Array.from({ length: limit }, () => `k${String(n++).padStart(8, "0")}`);
      return { forEach: (cb) => { for (const k of keys) if (cb({ key: k, val: () => ({ hub1: true }) })) return true; return false; } };
    });
    const t = flattenTree(await render({ authUser: ADMIN }));
    expect(t, "the assignment banner is the right one").toContain("assignments could not be read");
    expect(t, "the roster banner must NOT fire").not.toContain("more staff accounts than this screen reads");
  });
});

describe("a uid called __proto__ is a row, not a disappearance", () => {
  it("keeps an account whose key would set an accumulator's prototype", async () => {
    // data["__proto__"] = rec on a plain {} sets the prototype, and the record
    // is then invisible to Object.keys — the account would vanish with no row,
    // no count and no banner. Both accumulators are Object.create(null).
    getMock.mockImplementation(worldReader({
      // A computed key, NOT `__proto__:` — in an object literal that form is
      // the prototype setter and would make this fixture a no-op.
      users: { ["__proto__"]: { displayName: "Proto Person" }, u1: { displayName: "Ayanda" } },
      push_tokens: { ["__proto__"]: { d1: { token: "t" } } },
    }));
    const tree = await render({ authUser: ADMIN });
    const labels = tree.root.findAll((n) => n.props && n.props.role === "switch")
      .map((n) => n.props["aria-label"]).join("|");
    expect(labels, "the account must still have a row").toContain("Proto Person");
    expect(labels).toContain("Ayanda");
    expect(flattenTree(tree)).toContain("of 2 assigned");
  });
});

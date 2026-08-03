// ─── USER MANAGEMENT — THE TWO GATES ──────────────────────────────────────────
// These tests exist to make DELETING EITHER GATE FAIL CI. That is the whole
// point: before this PR both gate comments claimed the other side was doing the
// gating, and only one of them actually was. A comment cannot hold a barrier up;
// a failing test can.
//
// Three things are pinned here:
//   1. a refused viewer opens NO /users subscription — asserted on the listener,
//      not on what rendered
//   2. each layer refuses ON ITS OWN, with the other bypassed
//   3. the default export runs zero hooks (which is what lets the gate sit above
//      every effect without breaking the rules of hooks)
//
// ── WHY react-test-renderer AND NOT A DOM ────────────────────────────────────
// Requirement 1 can only be tested by letting effects RUN — the subscription
// lives in a useEffect, so anything that skips effects (react-dom/server, or
// calling the component as a function) would report "no listener" for the
// authorized case too, and pass vacuously. react-test-renderer runs effects
// under act() with no DOM, which is the smallest thing that can tell the two
// cases apart. Owner approved the devDependency 2026-08-03.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

// ── A minimal window, because there is no DOM in this environment ────────────
// react-test-renderer needs no DOM, but the AUTHORIZED component legitimately
// uses window (hash routing, scroll restoration). Refusing to stub it would mean
// only ever testing the refused path — which is the half that passes trivially.
// This supplies the environment; it changes no behaviour and touches no source.
globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { hash: "#admin/users" },
  scrollY: 0,
  scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

// ── Firebase, faked at the module boundary ───────────────────────────────────
// onValue is the thing under test: it must be called for an authorized viewer
// and never for a refused one.
const onValueMock = vi.fn(() => () => {});
const updateMock = vi.fn(async () => {});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  onValue: (...args) => onValueMock(...args),
  update: (...args) => updateMock(...args),
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));

const UserManagement = (await import("./UserManagement.jsx")).default;

const ADMIN_EMAIL = "gunidmoh@gmail.com";
const ADMIN = { uid: "admin-uid", email: ADMIN_EMAIL, displayName: "Junid" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal", displayName: "Rashid" };

const render = (props) => {
  let tree;
  act(() => { tree = TestRenderer.create(<UserManagement onExit={() => {}} {...props} />); });
  return tree;
};

// The rendered gate resolves to one of two screens. Identify by the component
// name React records on the element, so the assertion says which screen won.
const screenNames = (tree) =>
  tree.root.findAll((n) => typeof n.type === "function").map((n) => n.type.name);

beforeEach(() => { onValueMock.mockClear(); updateMock.mockClear(); });

// ── 1. THE SUBSCRIPTION ──────────────────────────────────────────────────────
describe("a refused viewer opens no /users subscription", () => {
  it("registers NO listener for a signed-in non-super-admin", () => {
    render({ authUser: STAFF });
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("registers NO listener when there is no authenticated user at all", () => {
    render({ authUser: null });
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("DOES register the listener for the super-admin — so the test above is not vacuous", () => {
    render({ authUser: ADMIN });
    expect(onValueMock).toHaveBeenCalledTimes(1);
    // …and on the right node.
    expect(onValueMock.mock.calls[0][0]).toEqual({ path: "users" });
  });

  it("tears the listener down on unmount", () => {
    const unsub = vi.fn();
    onValueMock.mockImplementationOnce(() => unsub);
    const tree = render({ authUser: ADMIN });
    act(() => { tree.unmount(); });
    expect(unsub).toHaveBeenCalled();
  });

  it("opens no listener when a refused viewer is upgraded to admin and back", () => {
    // Guards the split itself: the authed component must mount and unmount with
    // the answer, never linger.
    const tree = render({ authUser: STAFF });
    expect(onValueMock).not.toHaveBeenCalled();
    act(() => { tree.update(<UserManagement authUser={ADMIN} onExit={() => {}} />); });
    expect(onValueMock).toHaveBeenCalledTimes(1);
    act(() => { tree.update(<UserManagement authUser={STAFF} onExit={() => {}} />); });
    expect(onValueMock).toHaveBeenCalledTimes(1);      // not re-opened
  });
});

// ── 2a. LAYER 2 REFUSES ON ITS OWN ───────────────────────────────────────────
// App.jsx's route gate is BYPASSED here by construction: this test imports the
// component and renders it directly, exactly as a broken or deleted route gate
// would. The component must still refuse.
describe("LAYER 2 — the component gate, with the route gate bypassed", () => {
  it("refuses a non-super-admin even when mounted directly", () => {
    const names = screenNames(render({ authUser: STAFF }));
    expect(names).toContain("NotAuthorized");
    expect(names).not.toContain("UserManagementAuthed");
  });

  it("refuses a null user", () => {
    expect(screenNames(render({ authUser: null }))).toContain("NotAuthorized");
  });

  it("refuses an account whose email merely resembles the admin's", () => {
    for (const email of [
      "gunidmoh@gmail.com.evil.com",
      "GUNIDMOH@gmail.com",           // the check is case-sensitive; keep it that way
      "junidmoh@gmail.com",           // the real near-miss: Junid's OTHER address
      "gunidmoh@gmail.co",
      " gunidmoh@gmail.com",
    ]) {
      const names = screenNames(render({ authUser: { uid: "x", email } }));
      expect(names, `must refuse ${email}`).toContain("NotAuthorized");
      expect(names, `must refuse ${email}`).not.toContain("UserManagementAuthed");
    }
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("admits the super-admin — proving the refusals above mean something", () => {
    const names = screenNames(render({ authUser: ADMIN }));
    expect(names).toContain("UserManagementAuthed");
    expect(names).not.toContain("NotAuthorized");
  });
});

// ── 2b. LAYER 1 REFUSES ON ITS OWN ───────────────────────────────────────────
// The mirror of the test above: the ROUTE gate must refuse a non-super-admin
// even if the component's own gate were stubbed out or deleted.
//
// ⚠️ THIS IS A SOURCE-LEVEL INVARIANT, NOT A RENDER TEST, and that is a
// deliberate compromise rather than a preference. The route decision lives
// inside App.jsx — a ~16,700-line module that imports Firebase, image assets and
// the entire view tree at module scope. Rendering it in a unit test would mean
// mocking most of the application, and the mock would be far more likely to be
// wrong than the thing it was testing. The decision is also not exported, and
// exporting it would be a source change, which this task forbids.
//
// So this asserts the SHAPE of the route mount: that it is guarded, that
// UserManagement is on the authorized branch, and that no second, ungated mount
// exists. It is coarse — it reads text — but it fails loudly the moment someone
// removes the ternary, which is exactly the regression this PR exists to
// prevent. If App.jsx is ever refactored so the route decision can be imported,
// replace this with a real assertion on that function.
describe("LAYER 1 — the App.jsx route gate, independent of the component gate", () => {
  const appSrc = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  // The `if (wantUserMgmt) { … }` block, up to its closing `} else`.
  const routeBlock = (() => {
    const start = appSrc.indexOf("if (wantUserMgmt) {");
    expect(start, "the wantUserMgmt route block must exist").toBeGreaterThan(-1);
    const end = appSrc.indexOf("} else if", start);
    return appSrc.slice(start, end === -1 ? start + 2000 : end);
  })();

  it("guards the mount on isSuperAdmin", () => {
    expect(routeBlock).toMatch(/isSuperAdmin/);
  });

  it("mounts UserManagement ONLY on the authorized branch", () => {
    // Authorized branch first, refusal second — a ternary whose true-arm is the
    // privileged screen.
    expect(routeBlock).toMatch(/isSuperAdmin[\s\S]*\?[\s\S]*<UserManagement/);
    // …and the refusal arm must not be the privileged screen.
    const afterColon = routeBlock.slice(routeBlock.indexOf(":", routeBlock.indexOf("<UserManagement")));
    expect(afterColon).not.toMatch(/<UserManagement/);
  });

  it("has no second, ungated mount of UserManagement anywhere in App.jsx", () => {
    const mounts = appSrc.match(/<UserManagement[\s/>]/g) || [];
    expect(mounts).toHaveLength(1);
  });

  it("does not let the route constant itself grant anything", () => {
    // wantUserMgmt only recognises the hash; it must never be the whole test.
    const decl = appSrc.slice(appSrc.indexOf("const wantUserMgmt"));
    const line = decl.slice(0, decl.indexOf("\n"));
    expect(line).not.toMatch(/isSuperAdmin|authUser|email/);
  });
});

// ── 3. ZERO HOOKS IN THE GATE ────────────────────────────────────────────────
// The gate has to sit ABOVE every effect, and a hook cannot live above a
// conditional return — authUser arrives asynchronously, so one instance would
// render first without a user and then with one, changing its hook count and
// crashing React. That is only safe while the outer component uses NO hooks.
//
// Calling a component as a plain function is the test: outside a render there is
// no hook dispatcher, so ANY hook throws. Add a useState to the gate and this
// fails immediately.
describe("the default export runs zero hooks", () => {
  it("can be invoked as a plain function without a renderer", () => {
    expect(() => UserManagement({ authUser: STAFF, onExit: () => {} })).not.toThrow();
    expect(() => UserManagement({ authUser: ADMIN, onExit: () => {} })).not.toThrow();
    expect(() => UserManagement({ authUser: null, onExit: () => {} })).not.toThrow();
  });

  it("returns the decision directly, doing no work of its own", () => {
    // A plain call runs no effects and touches no Firebase — the gate decides and
    // delegates, nothing more.
    const refused = UserManagement({ authUser: STAFF, onExit: () => {} });
    const admitted = UserManagement({ authUser: ADMIN, onExit: () => {} });
    expect(refused.type.name).toBe("NotAuthorized");
    expect(admitted.type.name).toBe("UserManagementAuthed");
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("proves the harness would catch a hook — a hooked component DOES throw here", () => {
    const Hooked = () => { React.useState(0); return null; };
    expect(() => Hooked()).toThrow();
  });
});

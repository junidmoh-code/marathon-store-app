// ─── ENGINE POLICY — THE THREE GATES ──────────────────────────────────────────
// These tests exist to make DELETING ANY ONE GATE FAIL CI. Three independent
// checks were asked for, and "independent" is only true if each refuses with the
// other two bypassed — which is exactly what a comment cannot promise.
//
//   GATE 1  the home tile does not render                       (App.jsx)
//   GATE 2  the route refuses to mount the component            (App.jsx)
//   GATE 2b the component refuses itself, opening nothing       (this module)
//   GATE 3  setCategoryPolicy re-checks server-side             (functions/, own suite)
//
// Same approach as src/components/UserManagement.gate.test.jsx, for the same
// reasons — including the source-level assertions on App.jsx, which are a
// deliberate compromise: the route decision lives inside a ~16,700-line module
// that imports Firebase, image assets and the whole view tree at module scope.
// Rendering it would mean mocking most of the application, and the mock would be
// likelier to be wrong than the thing under test. Coarse, but it fails loudly the
// moment somebody removes the ternary.
//
// Run: npx vitest run src/components/stock/enginePolicyGates.test.jsx

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "" }, scrollY: 0, scrollTo() {},
  confirm: () => false,
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

// The callable is the thing under test for gate 2b: a refused viewer must not
// invoke it, because a census is a catalogue-wide read at the owner's expense.
const callableMock = vi.fn(async () => ({ data: { categories: [], destinations: [], history: [], cap: 75 } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callableMock(...a) }));
vi.mock("../../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));

const EnginePolicyCard = (await import("./EnginePolicyCard.jsx")).default;
const { enginePolicyVisibleForViewer } = await import("../../config/enginePolicy.js");

const ADMIN_EMAIL = "gunidmoh@gmail.com";
const OWNER = { email: ADMIN_EMAIL };
const STAFF = { email: "rashid@marathon.internal" };

const render = (props) => {
  let tree;
  act(() => { tree = TestRenderer.create(<EnginePolicyCard onExit={() => {}} {...props} />); });
  return tree;
};
const screenNames = (tree) => tree.root.findAll((n) => typeof n.type === "function").map((n) => n.type.name);

beforeEach(() => { callableMock.mockClear(); });

// ── THE SHARED PREDICATE ─────────────────────────────────────────────────────
describe("the identity test itself", () => {
  it("admits the owner's Google account and nothing else", () => {
    expect(enginePolicyVisibleForViewer(OWNER)).toBe(true);
    for (const v of [
      null, undefined, {}, { email: null }, { email: "" },
      STAFF,
      { email: "junid@marathon.internal" },
      { email: "ahmed@marathon.internal" },
      { email: "junidmoh@gmail.com" },              // Junid's OTHER address — the real near-miss
      { email: "GUNIDMOH@GMAIL.COM" },              // case-sensitive, and it stays that way
      { email: " gunidmoh@gmail.com" },
      { email: "gunidmoh@gmail.com.evil.com" },
      { email: "gunidmoh@gmail.co" },
    ]) {
      expect(enginePolicyVisibleForViewer(v), `must refuse ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("no permission, stockRole or store scope opens it", () => {
    // The brief is explicit that this is not permission-gated, and the reason
    // matters: the owner's own /users record has NO permissions array, so a
    // permission gate would lock out the only intended user while admitting
    // whoever the permission was later granted to.
    expect(enginePolicyVisibleForViewer({ email: STAFF.email, permissions: ["engine_policy", "user_management"], stockRole: "admin", destShop: null })).toBe(false);
    expect(enginePolicyVisibleForViewer({ permissions: ["everything"], stockRole: "admin" })).toBe(false);
  });
});

// ── GATE 2b — THE COMPONENT, WITH THE ROUTE GATE BYPASSED ────────────────────
// This test imports the component and mounts it directly, exactly as a broken
// or deleted route gate would. It must still refuse.
describe("GATE 2b — the component refuses on its own", () => {
  it("refuses a staff account mounted directly", () => {
    const names = screenNames(render({ viewer: STAFF }));
    expect(names).toContain("Refused");
    expect(names).not.toContain("EnginePolicyAuthed");
  });

  it("refuses a null viewer", () => {
    expect(screenNames(render({ viewer: null }))).toContain("Refused");
  });

  it("admits the owner — so the refusals above are not vacuous", () => {
    const names = screenNames(render({ viewer: OWNER }));
    expect(names).toContain("EnginePolicyAuthed");
    expect(names).not.toContain("Refused");
  });
});

// ── A REFUSED VIEWER OPENS NOTHING ───────────────────────────────────────────
// The requirement is on the LISTENER, not on what rendered. Effects must be
// allowed to run for this to mean anything, which is why this is
// react-test-renderer and not a string render.
describe("a refused viewer starts no work", () => {
  it("invokes no callable for a staff account", () => {
    render({ viewer: STAFF });
    expect(callableMock).not.toHaveBeenCalled();
  });

  it("invokes no callable with no viewer at all", () => {
    render({ viewer: null });
    expect(callableMock).not.toHaveBeenCalled();
  });

  it("DOES fetch the census for the owner", () => {
    render({ viewer: OWNER });
    expect(callableMock).toHaveBeenCalledTimes(1);
    expect(callableMock.mock.calls[0][0]).toEqual({ action: "census" });
  });

  it("mounts and unmounts with the answer rather than lingering", () => {
    const tree = render({ viewer: STAFF });
    expect(callableMock).not.toHaveBeenCalled();
    act(() => { tree.update(<EnginePolicyCard viewer={OWNER} onExit={() => {}} />); });
    expect(callableMock).toHaveBeenCalledTimes(1);
    act(() => { tree.update(<EnginePolicyCard viewer={STAFF} onExit={() => {}} />); });
    expect(callableMock).toHaveBeenCalledTimes(1);          // not re-fetched
  });
});

// ── ZERO HOOKS IN THE GATE ───────────────────────────────────────────────────
// The gate has to sit ABOVE every effect, and a hook cannot live above a
// conditional return — the viewer arrives asynchronously, so one instance would
// render first without an email and then with one, changing its hook count
// between renders and crashing React. Calling the component as a plain function
// is the test: outside a render there is no hook dispatcher, so ANY hook throws.
describe("the default export runs zero hooks", () => {
  it("can be invoked as a plain function", () => {
    expect(() => EnginePolicyCard({ viewer: STAFF, onExit: () => {} })).not.toThrow();
    expect(() => EnginePolicyCard({ viewer: OWNER, onExit: () => {} })).not.toThrow();
    expect(() => EnginePolicyCard({ viewer: null, onExit: () => {} })).not.toThrow();
  });

  it("decides and delegates, doing no work of its own", () => {
    expect(EnginePolicyCard({ viewer: STAFF, onExit: () => {} }).type.name).toBe("Refused");
    expect(EnginePolicyCard({ viewer: OWNER, onExit: () => {} }).type.name).toBe("EnginePolicyAuthed");
    expect(callableMock).not.toHaveBeenCalled();
  });
});

// ── GATES 1 AND 2, IN App.jsx ────────────────────────────────────────────────
describe("App.jsx — the tile and the route", () => {
  const appSrc = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

  // ── EVERY SLICE IS GUARDED, AND THAT IS NOT PEDANTRY ──────────────────────
  // String.prototype.slice treats a negative start as an offset from the END.
  // So an unguarded `src.slice(src.indexOf(x) - 400)` does NOT fail when x is
  // missing — it silently reads an unrelated region of the file, and the
  // assertion that follows passes or fails for reasons having nothing to do
  // with the gate. On a test whose entire job is to fail when a security gate
  // is deleted, "passes for the wrong reason" is the only failure mode that
  // matters. (CodeRabbit, PR #397.)
  const around = (needle, before, after) => {
    const i = appSrc.indexOf(needle);
    expect(i, `App.jsx must contain ${needle}`).toBeGreaterThan(-1);
    return appSrc.slice(Math.max(0, i - before), i + after);
  };
  const lineWith = (needle) => {
    const i = appSrc.indexOf(needle);
    expect(i, `App.jsx must contain ${needle}`).toBeGreaterThan(-1);
    const start = appSrc.lastIndexOf("\n", i) + 1;
    const end = appSrc.indexOf("\n", i);
    return appSrc.slice(start, end === -1 ? undefined : end);
  };

  it("GATE 1 — the tile is gated, and the gate is the shared predicate", () => {
    // Whitespace-tolerant: a formatter run must not be able to break a
    // security assertion.
    const tile = around('key:"engine_policy"', 400, 200);
    expect(tile).toMatch(/enginePolicyVisibleForViewer\(\s*enginePolicyViewer\s*\)\s*&&\s*\{\s*key:\s*"engine_policy"/);
  });

  it("GATE 1 — the tile's viewer comes from the AUTH email, not from a permissions record", () => {
    const line = lineWith("const enginePolicyViewer");
    expect(line).toMatch(/homeUser\?\.email/);
    expect(line).not.toMatch(/permRecord|permissions|hasPermission|stockRole/);
  });

  it("GATE 2 — the route guards the mount, independently of the tile", () => {
    const block = around("else if (role === ROLES.ENGINE_POLICY)", 0, 500);
    expect(block).toMatch(/enginePolicyVisibleForViewer\(\s*\{\s*email:\s*authUser\?\.email\s*\}\s*\)/);
    // Authorized branch first; the refusal arm must not be the privileged screen.
    expect(block).toMatch(/enginePolicyVisibleForViewer[\s\S]*\?[\s\S]*<EnginePolicyCard/);
    const cardAt = block.indexOf("<EnginePolicyCard");
    expect(cardAt).toBeGreaterThan(-1);
    const colonAt = block.indexOf(":", cardAt);
    expect(colonAt, "the route must be a ternary with a refusal arm").toBeGreaterThan(-1);
    expect(block.slice(colonAt)).not.toMatch(/<EnginePolicyCard/);
  });

  it("GATE 2 — a refused viewer gets the admin sign-in screen, not a dead end", () => {
    // The brief is specific: the same treatment #admin/users has had since
    // PR #302. `null` would let the role-reset effect bounce them home with no
    // explanation of what to do about it.
    expect(around("else if (role === ROLES.ENGINE_POLICY)", 0, 500)).toMatch(/<AdminSignInScreen/);
  });

  it("there is no second, ungated mount of the card anywhere in App.jsx", () => {
    expect((appSrc.match(/<EnginePolicyCard[\s/>]/g) || [])).toHaveLength(1);
  });

  it("the route constant grants nothing by itself", () => {
    // ROLES.ENGINE_POLICY only names the route. If the role string ever became
    // the whole test, a value persisted in localStorage would be the gate.
    // Read the whole ROLES object rather than assuming it stays on one line —
    // a formatter run must not silently empty this assertion.
    const i = appSrc.indexOf("const ROLES = {");
    expect(i, "App.jsx must declare ROLES").toBeGreaterThan(-1);
    const decl = appSrc.slice(i, appSrc.indexOf("};", i) + 2);
    expect(decl).toMatch(/ENGINE_POLICY:\s*"engine_policy"/);
    expect(decl).not.toMatch(/isSuperAdmin|authUser|email/);
  });
});

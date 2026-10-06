// ─── USER MANAGEMENT — THE SECTION CONTROL ───────────────────────────────────
// Junid picks Section 1, Section 2 or Both for a staff account. Pinned here:
// what each tap WRITES to /users/{uid}, that nothing is typed, that an account
// with nothing set is shown as it really behaves, and that the control sits
// behind the same owner-only gate as the rest of the screen.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {};
Object.assign(globalThis.window, {
  addEventListener() {}, removeEventListener() {},
  location: { hash: "#admin/users/u1" },
  scrollY: 0, scrollTo() {}, requestAnimationFrame(fn) { fn(); },
});
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

let USERS = {};
const onValueMock = vi.fn((_ref, cb) => { cb({ val: () => USERS }); return () => {}; });
const updateMock = vi.fn(async () => {});

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  onValue: (...args) => onValueMock(...args),
  update: (...args) => updateMock(...args),
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../firebase", () => ({ database: { fake: true }, functions: { fake: true } }));
vi.mock("../utils/useNetwork", async () => {
  const { SEED_REGISTRY } = await vi.importActual("../utils/networkRegistry");
  return { useNetwork: () => ({ registry: SEED_REGISTRY, settled: true, error: false }) };
});

const UserManagement = (await import("./UserManagement.jsx")).default;
const { ADMIN_EMAIL } = await import("./PermissionsContext.jsx");

const ADMIN = { uid: "admin-uid", email: ADMIN_EMAIL, displayName: "Junid" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };

const textOf = (node) => {
  const walk = (n) => (n == null || n === false ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(walk).join("") : walk(n.children));
  return walk(node);
};
const render = async (authUser) => {
  let tree;
  await act(async () => { tree = TestRenderer.create(<UserManagement authUser={authUser} onExit={() => {}} />); });
  return tree;
};
// The text under a rendered instance (strings and child instances alike).
const instText = (n) => (typeof n === "string" ? n : n.children.map(instText).join(""));
// A radio row: the clickable div whose text starts with the option's label.
const option = (tree, label) => tree.root.findAll((n) =>
  n.type === "div" && typeof n.props.onClick === "function" && instText(n).startsWith(label)
  // "Marathon" the division, not "Marathon PE" the store above it; and the
  // division list comes after Store Access, so "Concrete" the division is the
  // LAST match, not the Concrete store row.
  && !instText(n).startsWith(`${label} `)).at(-1);
// Its radio is filled: the inner dot is only rendered for the selected row.
const isOn = (node) => node.findAll((n) => n.type === "div" && n.props.style
  && n.props.style.width === 10 && n.props.style.borderRadius === "50%").length === 1;

beforeEach(() => {
  onValueMock.mockClear(); updateMock.mockClear();
  window.location.hash = "#admin/users/u1";
  USERS = { u1: { displayName: "Sipho", username: "sipho", permissions: [] } };
});

describe("the section control writes the scope, and only the scope", () => {
  it("offers Section 1, Section 2 and Both — each named by the registry, with its locations", async () => {
    const tree = await render(ADMIN);
    expect(instText(option(tree, "Concrete"))).toBe("ConcreteMarathon Pine · Concrete · Hub 3 · Concrete Stockroom");
    expect(instText(option(tree, "Marathon"))).toBe("MarathonMarathon PE · Trophy · Hub 1 · Hub 2");
    expect(option(tree, "Both divisions")).toBeTruthy();
  });

  it("Section 1 → sections {1: true}, allSections removed", async () => {
    const tree = await render(ADMIN);
    await act(async () => { option(tree, "Concrete").props.onClick(); });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0]).toEqual({ path: "users/u1" });
    expect(updateMock.mock.calls[0][1]).toEqual({ sections: { 1: true }, allSections: null });
  });

  it("Section 2 → sections {2: true}, allSections removed", async () => {
    const tree = await render(ADMIN);
    await act(async () => { option(tree, "Marathon").props.onClick(); });
    expect(updateMock.mock.calls[0][1]).toEqual({ sections: { 2: true }, allSections: null });
  });

  it("Both → allSections true, the map removed — never a two-key map", async () => {
    const tree = await render(ADMIN);
    await act(async () => { option(tree, "Both divisions").props.onClick(); });
    expect(updateMock.mock.calls[0][1]).toEqual({ sections: null, allSections: true });
  });

  it("writes nothing else on the record — not the shop lock, not a permission", async () => {
    USERS.u1 = { ...USERS.u1, destShop: "marathon-pe", stockRole: "store", permissions: ["store_assistant"] };
    const tree = await render(ADMIN);
    await act(async () => { option(tree, "Concrete").props.onClick(); });
    expect(Object.keys(updateMock.mock.calls[0][1]).sort()).toEqual(["allSections", "sections"]);
  });

  it("tapping the choice already stored writes nothing", async () => {
    USERS.u1 = { ...USERS.u1, sections: { 2: true } };
    const tree = await render(ADMIN);
    expect(isOn(option(tree, "Marathon"))).toBe(true);
    expect(isOn(option(tree, "Concrete"))).toBe(false);
    await act(async () => { option(tree, "Marathon").props.onClick(); });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a refused write puts the choice back", async () => {
    updateMock.mockRejectedValueOnce(Object.assign(new Error("PERMISSION_DENIED"), { code: "PERMISSION_DENIED" }));
    const tree = await render(ADMIN);
    await act(async () => { option(tree, "Concrete").props.onClick(); });
    expect(isOn(option(tree, "Concrete"))).toBe(false);
  });
});

describe("what is shown for an account as it stands", () => {
  it("an account with nothing set selects nothing and says it sees both", async () => {
    const tree = await render(ADMIN);
    for (const l of ["Concrete", "Marathon", "Both divisions"]) expect(isOn(option(tree, l)), l).toBe(false);
    expect(textOf(tree.toJSON())).toContain("Not set — sees both divisions");
  });

  it("an account with only a shop lock says which section that lock puts it in", async () => {
    USERS.u1 = { ...USERS.u1, destShop: "marathon-pine" };
    const tree = await render(ADMIN);
    expect(textOf(tree.toJSON())).toContain("Not set — follows Store Access above, so Concrete only.");
  });

  it("allSections shows Both; a one-key map shows that section", async () => {
    USERS.u1 = { ...USERS.u1, allSections: true };
    expect(isOn(option(await render(ADMIN), "Both divisions"))).toBe(true);
    USERS.u1 = { displayName: "Sipho", sections: { 1: true } };
    const tree = await render(ADMIN);
    expect(isOn(option(tree, "Concrete"))).toBe(true);
    expect(textOf(tree.toJSON())).toContain("Sees & works in Concrete");
  });
});

describe("owner only — the same gate as the rest of the screen", () => {
  it("a non-owner gets no section control, no /users read and no write path", async () => {
    const tree = await render(STAFF);
    expect(textOf(tree.toJSON())).not.toContain("Both divisions");
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("the screen and the context share ONE owner address — no private copy in this file", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./UserManagement.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ ADMIN_EMAIL \} from "\.\/PermissionsContext"/);
    expect(src).not.toMatch(/const ADMIN_EMAIL\s*=/);
    const card = readFileSync(new URL("../push/PushAssignmentsCard.jsx", import.meta.url), "utf8");
    expect(card).toMatch(/import \{ ADMIN_EMAIL \} from "\.\.\/components\/PermissionsContext"/);
    expect(card).not.toMatch(/const ADMIN_EMAIL\s*=/);
  });
});

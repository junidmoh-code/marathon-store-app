// ─── TAXONOMY TAB — the gate is two INDEPENDENT layers ───────────────────────
// Layer 1: the Admin tile + guard(ROLES.ADMIN) route gate in App.jsx.
// Layer 2: this component re-checks product_admin ITSELF via usePermissions.
// The DisplayRegister defect was a tile that was the only gate; these tests pin
// BOTH layers separately so deleting either one fails loudly. Also pinned: the
// tab is READ-ONLY (inputs disabled) whenever the registry is on the seed
// fallback — a write layered on the fallback could fork live data.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PermissionsContext } from "../PermissionsContext.jsx";
import { TAXONOMY_SEED } from "../../utils/productTaxonomy.js";

vi.mock("../../firebase.js", () => ({ database: {} }));
vi.mock("firebase/database", () => ({
  ref: vi.fn(), runTransaction: vi.fn(), update: vi.fn(), serverTimestamp: vi.fn(),
}));

const TaxonomyTab = (await import("./TaxonomyTab.jsx")).default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..");

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.children) return textOf(n.children);          // toJSON tree
  if (n.props) return textOf(n.props.children);       // element tree
  return "";
}

async function mount({ perms = [], superAdmin = false, source = "live", registry = TAXONOMY_SEED } = {}) {
  const ctx = {
    user: null, permRecord: null, isSuperAdmin: superAdmin, permissions: perms, storeIds: [],
    hasPermission: (p) => superAdmin || perms.includes(p),
    signOut: () => {},
  };
  let r;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(PermissionsContext.Provider, { value: ctx },
        React.createElement(TaxonomyTab, { registry, source })),
    );
  });
  return r;
}

describe("layer 2 — the component's own permission gate", () => {
  it("without product_admin: the lock message renders and NO run data, inputs or buttons exist", async () => {
    const r = await mount({ perms: ["warehouse"] });
    expect(textOf(r.toJSON())).toMatch(/No access/);
    expect(r.root.findAllByType("input")).toHaveLength(0);
    expect(r.root.findAllByType("button")).toHaveLength(0);
  });
  it("with product_admin: the size runs render", async () => {
    const r = await mount({ perms: ["product_admin"] });
    const text = textOf(r.toJSON());
    expect(text).toMatch(/Size runs/);
    expect(text).toMatch(/apparel/);
    expect(r.root.findAllByType("input").length).toBeGreaterThan(0);
  });
  it("super-admin passes without the permission string", async () => {
    const r = await mount({ superAdmin: true });
    expect(textOf(r.toJSON())).toMatch(/Size runs/);
  });
});

describe("read-only on the seed fallback", () => {
  it("fallback source: warning banner shown, every Add input and button disabled", async () => {
    const r = await mount({ perms: ["product_admin"], source: "fallback" });
    expect(textOf(r.toJSON())).toMatch(/Read-only/);
    for (const input of r.root.findAllByType("input")) expect(input.props.disabled).toBe(true);
  });
  it("live source: no banner, inputs enabled", async () => {
    const r = await mount({ perms: ["product_admin"], source: "live" });
    expect(textOf(r.toJSON())).not.toMatch(/Read-only/);
    expect(r.root.findAllByType("input").some((i) => !i.props.disabled)).toBe(true);
  });
});

describe("layer 1 — the route gate in App.jsx (source pin)", () => {
  const app = readFileSync(path.join(SRC, "App.jsx"), "utf8");
  it("the Admin view is mounted ONLY through guard(ROLES.ADMIN, …)", () => {
    expect(app).toMatch(/role === ROLES\.ADMIN\)\s+view = guard\(ROLES\.ADMIN,/);
  });
  it("TaxonomyTab renders only inside the admin shells (never a bare route)", () => {
    // Every JSX use of TaxonomyTab sits behind an adminSection check.
    const uses = app.split("\n").filter((l) => l.includes("<TaxonomyTab"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/adminSection === "taxonomy"/);
  });
});

describe("the tab has no size-removal surface", () => {
  it("run sizes render as plain read-only chips — no per-size button, no delete affordance", async () => {
    const r = await mount({ perms: ["product_admin"] });
    const buttons = r.root.findAllByType("button").map((b) => textOf(b.props.children));
    // The only buttons on the sizes panel are the panel switch and Add size.
    for (const label of buttons) {
      expect(label).not.toMatch(/remove|delete|rename|retire|×|✕/i);
    }
  });
  it("source pin: the tab writes sizes ONLY through the add-only helpers", () => {
    const tab = readFileSync(path.join(SRC, "components", "admin", "TaxonomyTab.jsx"), "utf8");
    expect(tab).toMatch(/appendSizeToRun/);
    expect(tab).not.toMatch(/\.splice\(|\.filter\(.*sizes|removeSize|deleteSize/);
  });
});

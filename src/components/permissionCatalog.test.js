// ─── Permission catalog — grant-shape invariants (vitest) ────────────────────
// display_checks must be grantable per-user WITHOUT the two side effects that
// would make it dangerous. These are the exact invariants that keep the Display
// Checks two-lock scheme intact; if a future edit to PERMISSION_GROUPS breaks
// either (e.g. adds `stock: true` by reflex, or drops the key into a role
// default), this test fails loudly.

import { describe, it, expect } from "vitest";
import { PERMISSION_GROUPS, ALL_PERMISSIONS, STOCK_PERM_KEYS, ROLE_DEFAULT_PERMS } from "./permissionCatalog";

const KEY = "display_checks";
const entry = ALL_PERMISSIONS.find((p) => p.key === KEY);

describe("display_checks permission — safe grant shape", () => {
  it("is grantable: present in the catalog (so the per-user toggle exists)", () => {
    expect(entry).toBeTruthy();
    expect(ALL_PERMISSIONS.map((p) => p.key)).toContain(KEY);
  });

  it("lives in the 'Products & Displays' group", () => {
    const grp = PERMISSION_GROUPS.find((g) => g.title === "Products & Displays");
    expect(grp).toBeTruthy();
    expect(grp.perms.map((p) => p.key)).toContain(KEY);
  });

  // INVARIANT 1 — no stock-role auto-link. `stock: true` would add the key to
  // STOCK_PERM_KEYS, which auto-links a stockRole on toggle-on
  // (UserManagement.jsx ~625/1083). Granting a display permission must NOT hand
  // out stock-write access. This assertion fails if anyone adds `stock: true`.
  it("does NOT carry a stock flag and is EXCLUDED from STOCK_PERM_KEYS (no stock-role auto-link)", () => {
    expect(entry?.stock).toBeFalsy();          // clean assertion even if the entry is ever removed
    expect(STOCK_PERM_KEYS).not.toContain(KEY);
  });

  // INVARIANT 2 — never auto-granted. A key in ROLE_DEFAULT_PERMS is granted to
  // every user of that role and is the Add-Staff default. display_checks must be
  // per-user-only (the second lock keeping non-test stores dark).
  it("is NOT in any ROLE_DEFAULT_PERMS (per-user only, never role-inherited)", () => {
    for (const role of Object.keys(ROLE_DEFAULT_PERMS)) {
      expect(ROLE_DEFAULT_PERMS[role], `role ${role} must not auto-grant ${KEY}`).not.toContain(KEY);
    }
  });
});

// ─── engine_policy — the 2026-08-27 grant ────────────────────────────────────
// It sits in the STOCK group because that is where a person looks for it, and
// that placement is the risk: a reflex `stock: true` on a neighbouring line
// would auto-link a stockRole and hand the holder write on /stock_targets, the
// engine kill switch, /locations and every /config branch — the exact
// over-grant this permission exists to avoid. The Categories tab needs no such
// thing: every change there goes through the setCategoryPolicy callable. (The
// Seating tab writes RTDB directly and asks for a stockRole itself — see
// enginePolicySeatingWritable.)
describe("engine_policy permission — safe grant shape", () => {
  const KEY = "engine_policy";
  const entry = ALL_PERMISSIONS.find((p) => p.key === KEY);

  it("is grantable from the editor", () => {
    expect(entry, "engine_policy missing from PERMISSION_GROUPS").toBeTruthy();
  });

  it("lives in the 'Stock' group", () => {
    const grp = PERMISSION_GROUPS.find((g) => g.title === "Stock");
    expect(grp).toBeTruthy();
    expect(grp.perms.map((p) => p.key)).toContain(KEY);
  });

  it("does NOT auto-link a stockRole", () => {
    expect(entry?.stock).toBeFalsy();
    expect(STOCK_PERM_KEYS).not.toContain(KEY);
  });

  it("is in NO role default — one tap on a role preset must never confer it", () => {
    for (const role of Object.keys(ROLE_DEFAULT_PERMS)) {
      expect(ROLE_DEFAULT_PERMS[role], `role ${role} must not auto-grant ${KEY}`).not.toContain(KEY);
    }
  });

  it("is marked sensitive, so the editor styles it as a consequential grant", () => {
    expect(entry?.sensitive).toBe(true);
  });
});

describe("STOCK_PERM_KEYS derivation is sound", () => {
  it("contains exactly the entries flagged stock:true", () => {
    const flagged = ALL_PERMISSIONS.filter((p) => p.stock).map((p) => p.key);
    expect([...STOCK_PERM_KEYS].sort()).toEqual([...flagged].sort());
  });
});

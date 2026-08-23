// ─── THE TWO NEW GRANTS, AND THE MIRROR THE RULES READ (vitest) ──────────────
// Covers the 2026-08-23 change that stopped `stockRole: "admin"` being the only
// way to hand out Shopify Publishing, and gave photo generation a permission of
// its own.
//
// Three things have to hold or the grant is either useless or dangerous:
//
//   1. The key exists in BOTH catalogs. The client decides what to show from
//      permissionCatalog.js; createStaffUser REJECTS any permission not in
//      VALID_PERMISSIONS in functions/index.js. A key in one and not the other
//      does not half-work — it makes accounts carrying it un-creatable. That is
//      exactly how Warehouse accounts became un-creatable once before, which is
//      why this is pinned rather than trusted.
//
//   2. The keys carry neither side effect. `stock: true` would auto-link a
//      stockRole on toggle-on — re-creating the very over-grant these keys were
//      added to end. Membership of ROLE_DEFAULT_PERMS would hand publish-to-the-
//      live-shop and spend-money to everyone of that role, from one tap on a
//      role preset.
//
//   3. permFlagsFor produces the same map on the client and on the server.
//      There are two copies (ESM in the bundle, CJS in functions) because the
//      two cannot share a module. A differential test over the same inputs is
//      the only thing that keeps them honest — a table of expected outputs would
//      only ever check the cases somebody thought of, and both copies could
//      drift together past it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALL_PERMISSIONS, STOCK_PERM_KEYS, ROLE_DEFAULT_PERMS, PERMISSION_GROUPS, permFlagsFor,
} from "./permissionCatalog";

const NEW_KEYS = ["shopify_publish", "photo_generation"];

// ── The server's list, read from the source rather than imported ────────────
// functions/index.js is CommonJS, pulls firebase-admin at module load and
// registers Cloud Functions as a side effect — importing it here would be a far
// heavier and more fragile thing than reading the one array we care about.
const functionsSrc = readFileSync(
  fileURLToPath(new URL("../../functions/index.js", import.meta.url)), "utf8",
);
function serverValidPermissions() {
  const m = functionsSrc.match(/const VALID_PERMISSIONS = \[([\s\S]*?)\];/);
  if (!m) throw new Error("VALID_PERMISSIONS not found in functions/index.js");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("the client and server permission lists agree", () => {
  it("every client-grantable permission is accepted by createStaffUser", () => {
    const server = serverValidPermissions();
    for (const p of ALL_PERMISSIONS) {
      expect(server, `${p.key} is offered in the editor but createStaffUser would reject it`)
        .toContain(p.key);
    }
  });
});

describe.each(NEW_KEYS)("%s — safe grant shape", (KEY) => {
  const entry = ALL_PERMISSIONS.find((p) => p.key === KEY);

  it("is grantable from the editor", () => {
    expect(entry, `${KEY} missing from PERMISSION_GROUPS`).toBeTruthy();
  });

  it("lives in the 'Online & Content' group", () => {
    const grp = PERMISSION_GROUPS.find((g) => g.title === "Online & Content");
    expect(grp).toBeTruthy();
    expect(grp.perms.map((p) => p.key)).toContain(KEY);
  });

  // INVARIANT 1 — granting this must not silently hand out stock write.
  it("does NOT auto-link a stockRole", () => {
    expect(entry?.stock).toBeFalsy();
    expect(STOCK_PERM_KEYS).not.toContain(KEY);
  });

  // INVARIANT 2 — a role preset must never confer it.
  it("is in NO role default", () => {
    for (const role of Object.keys(ROLE_DEFAULT_PERMS)) {
      expect(ROLE_DEFAULT_PERMS[role], `role ${role} must not auto-grant ${KEY}`).not.toContain(KEY);
    }
  });
});

// ─── DIFFERENTIAL: the client mirror vs the server mirror ────────────────────
// The server copy is extracted from source and evaluated, so this compares the
// two implementations that actually ship — not a restatement of one of them.
function serverPermFlagsFor() {
  const m = functionsSrc.match(/function permFlagsFor\(permissions\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error("permFlagsFor not found in functions/index.js");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return permFlagsFor;`)();
}

describe("permFlagsFor — the two copies cannot drift", () => {
  const serverFn = serverPermFlagsFor();

  it("agrees on every catalog permission, alone and together", () => {
    const keys = ALL_PERMISSIONS.map((p) => p.key);
    const cases = [[], ...keys.map((k) => [k]), keys, [...keys].reverse()];
    for (const input of cases) {
      expect(permFlagsFor(input), `disagreed on ${JSON.stringify(input)}`)
        .toEqual(serverFn(input));
    }
  });

  // A fuzz, because the table above only covers what I thought to write down.
  // Deterministic seed: the same 400 cases run on every machine and in CI, so a
  // failure is reproducible rather than a one-off nobody can chase.
  it("agrees on 400 pseudo-random inputs, including junk", () => {
    const pool = [
      ...ALL_PERMISSIONS.map((p) => p.key),
      "", "  ", "unknown_key", "shopify_publish", null, undefined, 0, 1, false, true,
      {}, [], "__proto__", "constructor", "toString",
    ];
    let seed = 20260823;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 400; i++) {
      const n = Math.floor(rnd() * 6);
      const input = Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]);
      expect(permFlagsFor(input), `disagreed on ${JSON.stringify(input)}`)
        .toEqual(serverFn(input));
    }
  });

  it("returns null for nothing granted, so RTDB removes the mirror", () => {
    for (const empty of [[], null, undefined, "not-an-array", {}, 7]) {
      expect(permFlagsFor(empty)).toBeNull();
      expect(serverFn(empty)).toBeNull();
    }
  });

  it("maps a granted key to literal true — the value the rules compare against", () => {
    // The console rule reads `…child('permFlags').child('shopify_publish').val() === true`.
    // A truthy-but-not-true value (1, "yes") would fail that comparison and the
    // grant would look present in the editor while being refused by RTDB.
    expect(permFlagsFor(["shopify_publish"])).toEqual({ shopify_publish: true });
    expect(permFlagsFor(["shopify_publish"]).shopify_publish).toBe(true);
  });

  it("drops a revoked key rather than leaving it false", () => {
    // The mirror is written whole, never patched, so a revoked permission must
    // simply be ABSENT. A lingering `{shopify_publish: false}` would be harmless
    // to the rule but would misreport the grant to any future reader.
    const after = permFlagsFor(["insights"]);
    expect(after).not.toHaveProperty("shopify_publish");
    expect(Object.keys(after)).toEqual(["insights"]);
  });
});

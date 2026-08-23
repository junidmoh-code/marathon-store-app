// ─── PER-USER HIDDEN CARDS ───────────────────────────────────────────────────
// A hide that only removes the tile is theatre — `role` persists in
// localStorage, so the route gate is the half that actually does the work.
// Both gates are pinned here, and the App.jsx wiring is pinned too, because a
// pure function nobody calls hides nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hiddenCardsFor, isCardHidden, isRoleHidden, roleForCard } from "./hiddenCards";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("hiddenCardsFor", () => {
  it("reads a plain array", () => {
    expect(hiddenCardsFor({ hiddenCards: ["attention", "total_stock"] })).toEqual(["attention", "total_stock"]);
  });

  it("accepts the object shape RTDB hands back when an index is missing", () => {
    // An array that lost an index mid-edit comes back as { "0": …, "2": … }.
    expect(hiddenCardsFor({ hiddenCards: { 0: "attention", 2: "total_stock" } }))
      .toEqual(["attention", "total_stock"]);
  });

  it("orders the object shape numerically, not lexicographically", () => {
    const got = hiddenCardsFor({ hiddenCards: { 0: "a", 2: "c", 10: "k", 1: "b" } });
    expect(got).toEqual(["a", "b", "c", "k"]);
  });

  it("is an empty list for every user who has no list at all", () => {
    for (const rec of [null, undefined, {}, { hiddenCards: null }, { hiddenCards: [] }, { hiddenCards: "" }]) {
      expect(hiddenCardsFor(rec)).toEqual([]);
    }
  });

  it("drops blanks and rubbish rather than hiding a card named ''", () => {
    expect(hiddenCardsFor({ hiddenCards: ["attention", "", "   ", null, 7, {}] })).toEqual(["attention"]);
  });

  it("trims, so a stray space in the console does not silently do nothing", () => {
    expect(hiddenCardsFor({ hiddenCards: [" attention "] })).toEqual(["attention"]);
    expect(isCardHidden("attention", { hiddenCards: [" attention "] })).toBe(true);
  });
});

describe("isCardHidden", () => {
  const mc = { hiddenCards: ["attention", "total_stock"] };

  it("hides exactly what is named and nothing else", () => {
    expect(isCardHidden("attention", mc)).toBe(true);
    expect(isCardHidden("total_stock", mc)).toBe(true);
    expect(isCardHidden("stock", mc)).toBe(false);
    expect(isCardHidden("health", mc)).toBe(false);
    expect(isCardHidden("marketing", mc)).toBe(false);
    expect(isCardHidden("shopify_publish", mc)).toBe(false);
  });

  it("changes nothing for a user with no list — the other 32 accounts", () => {
    for (const card of ["attention", "total_stock", "stock", "shopify_publish", "social"]) {
      expect(isCardHidden(card, { permissions: ["stock_management"] })).toBe(false);
      expect(isCardHidden(card, null)).toBe(false);
    }
  });

  // The recovery path: the account that edits these lists must not be able to
  // lock itself out of the screen it edits them from.
  it("never applies to the super-admin", () => {
    expect(isCardHidden("attention", mc, true)).toBe(false);
    expect(isCardHidden("total_stock", mc, true)).toBe(false);
  });

  it("does not hide on a missing card key", () => {
    expect(isCardHidden(undefined, mc)).toBe(false);
    expect(isCardHidden("", mc)).toBe(false);
    expect(isCardHidden(null, mc)).toBe(false);
  });

  it("is exact, never a prefix or substring match", () => {
    expect(isCardHidden("total", { hiddenCards: ["total_stock"] })).toBe(false);
    expect(isCardHidden("total_stock_extra", { hiddenCards: ["total_stock"] })).toBe(false);
  });

  it("isRoleHidden answers the same for a role key", () => {
    expect(isRoleHidden("attention", mc)).toBe(true);
    expect(isRoleHidden("stock", mc)).toBe(false);
    expect(isRoleHidden("attention", mc, true)).toBe(false);
  });
});

// ─── THE CARD-KEY / ROLE DIVERGENCE ──────────────────────────────────────────
// Two cards are NOT keyed by the role they open. Hiding either by its card key
// removed the tile and left the route wide open — and since `role` persists in
// localStorage, the user would have kept landing straight back on it. This is
// the half of the two-gate design that fails silently, in the two places nobody
// would have looked.
describe("hiding a card also closes the ROLE it opens", () => {
  it("customers → customers_db", () => {
    const rec = { hiddenCards: ["customers"] };
    expect(isCardHidden("customers", rec)).toBe(true);
    expect(isRoleHidden("customers_db", rec)).toBe(true);
  });

  it("broadcast → broadcast_groups", () => {
    const rec = { hiddenCards: ["broadcast"] };
    expect(isCardHidden("broadcast", rec)).toBe(true);
    expect(isRoleHidden("broadcast_groups", rec)).toBe(true);
  });

  it("roleForCard is identity for a card that does not diverge", () => {
    for (const k of ["attention", "total_stock", "stock", "social", "shopify_publish"]) {
      expect(roleForCard(k)).toBe(k);
    }
  });

  it("does not close a role a different card opens", () => {
    expect(isRoleHidden("customer", { hiddenCards: ["customers"] })).toBe(false);
    expect(isRoleHidden("stock", { hiddenCards: ["total_stock"] })).toBe(false);
  });

  // ── THE GUARD ──────────────────────────────────────────────────────────────
  // Self-maintaining: it reads the home grid's OWN card definitions out of
  // App.jsx and checks every one. A card added later whose key differs from its
  // role fails here rather than silently half-hiding, which is exactly how the
  // two divergent ones got in.
  it("every card the home grid builds maps to the role it opens", () => {
    const app = readFileSync(join(HERE, "../App.jsx"), "utf8");
    const pairs = [...app.matchAll(/key:"([a-z_]+)"[^}]*?onSelect\(ROLES\.([A-Z_]+)\)/g)]
      .map(([, cardKey, roleConst]) => ({ cardKey, roleConst }));
    expect(pairs.length).toBeGreaterThan(15);

    // Resolve ROLES.X to its literal value from the ROLES object in App.jsx.
    const rolesLine = app.match(/const ROLES = \{([^}]*)\};/);
    expect(rolesLine).not.toBeNull();
    const roleValues = Object.fromEntries(
      [...rolesLine[1].matchAll(/([A-Z_]+):\s*"([a-z_]+)"/g)].map(([, k, v]) => [k, v])
    );

    const broken = [];
    for (const { cardKey, roleConst } of pairs) {
      const roleValue = roleValues[roleConst];
      expect(roleValue, `ROLES.${roleConst} is not defined`).toBeTruthy();
      // Hiding this card must close BOTH the tile and the route.
      const rec = { hiddenCards: [cardKey] };
      if (!isCardHidden(cardKey, rec) || !isRoleHidden(roleValue, rec)) {
        broken.push(`${cardKey} → ROLES.${roleConst} ("${roleValue}")`);
      }
    }
    expect(broken, `these cards hide the tile but leave the route open:\n  ${broken.join("\n  ")}`).toEqual([]);
  });
});

// ─── THE WIRING ──────────────────────────────────────────────────────────────
// A correct pure function that nothing calls hides nothing at all, and a hide
// applied only to the tile is undone by the persisted role on the next app
// open. Both call sites are pinned.
describe("both gates are wired in App.jsx", () => {
  const app = readFileSync(join(HERE, "../App.jsx"), "utf8");

  it("imports the module", () => {
    expect(app).toMatch(/import \{ isCardHidden, isRoleHidden \} from "\.\/components\/hiddenCards"/);
  });

  it("GATE 1 — filters the assembled tile groups", () => {
    expect(app).toMatch(/cards: g\.cards\.filter\(\(c\) => !isCardHidden\(c\.key, homePerm, isSuperAdmin\)\)/);
  });

  it("GATE 2 — the route drops a hidden role home", () => {
    expect(app).toMatch(/if \(isRoleHidden\(role, permRecord, isSuperAdmin\)\) \{ setRole\(null\); return; \}/);
  });

  it("the route effect re-runs when the permission record changes", () => {
    // Without permRecord in the deps the gate would keep using a stale record
    // after a live permission edit.
    const deps = app.match(/\}, \[role, hasPermission, canAccessStock[^\]]*\]\);/);
    expect(deps).not.toBeNull();
    expect(deps[0]).toContain("permRecord");
  });

  it("the two gates are independent — neither is the other's only caller", () => {
    // Deleting one must leave the other working. They are separate call sites
    // of separate functions; this pins that they have not been collapsed.
    expect((app.match(/isCardHidden\(/g) || []).length).toBeGreaterThanOrEqual(1);
    expect((app.match(/isRoleHidden\(/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});

// ─── WHO IS ON THE ORDER ALERTS LIST — THE PREDICATE, ALONE ──────────────────
// src/push/staffRoster.js is pure, so these need no database and no render.
// The point of every test here is the same one: this screen's default is to
// SHOW a row, and the only thing that may hide one is a positive
// identification. A test that only proved "till logins are hidden" would pass
// for a predicate that hides half the staff too, so the fixtures below are
// mostly accounts that must SURVIVE it.
import { describe, it, expect } from "vitest";
import { isPosOnlyAccount, hasStoreAppIdentity, partitionRoster, POS_STOCK_ROLE } from "./staffRoster";

// Shapes copied from the live /users node on 2026-09-08, trimmed.
const TILL = {
  stockRole: "pos",
  posAccess: { role: "cashier", displayName: "yasmin", isActive: true, storeIds: ["trophy"] },
};
const TILL_BARE = { stockRole: "pos" };                 // two live records are exactly this
const ZEE = {                                            // the reason the test is a conjunction
  username: "zee", displayName: "Zee", role: "admin", stockRole: "pos",
  destShop: "marathon-pe", permissions: ["a", "b"], permFlags: { x: true },
};

describe("a till login is hidden — but only on a POSITIVE identification", () => {
  it("hides the shape the POS app actually writes", () => {
    expect(isPosOnlyAccount(TILL)).toBe(true);
    expect(isPosOnlyAccount(TILL_BARE)).toBe(true);
  });

  it("KEEPS Zee — stockRole 'pos' on an account with a real identity is not a till", () => {
    // Ten live accounts carry stockRole "pos"; nine are tills and this one is a
    // person. A predicate that tested the role alone would hide them.
    expect(isPosOnlyAccount(ZEE)).toBe(false);
  });

  it("ANY ONE store-app identity field is enough to keep the row", () => {
    // Each of these is a till record with exactly one human field added, so
    // this fails the moment the predicate stops honouring one of them.
    for (const field of ["displayName", "username", "name", "email", "role", "destShop"]) {
      expect(isPosOnlyAccount({ ...TILL_BARE, [field]: "x" }), `${field} must keep the row`).toBe(false);
    }
    expect(isPosOnlyAccount({ ...TILL_BARE, permFlags: { a: true } })).toBe(false);
    expect(isPosOnlyAccount({ ...TILL_BARE, permissions: ["one"] })).toBe(false);
  });

  it("an EMPTY permissions list is not an identity — it is a field that is there and says nothing", () => {
    expect(isPosOnlyAccount({ ...TILL_BARE, permissions: [] })).toBe(true);
  });
});

describe("absence of a role is not evidence of anything", () => {
  // The 9 live accounts with no stockRole at all are the ones this screen was
  // built for. Every one of them must survive.
  const noRole = [
    { displayName: "Jafer", role: "admin", permissions: new Array(11).fill("p") },
    { displayName: "Sphe", role: "store_assistant", permissions: ["a", "b", "c"] },
    { displayName: "Xoli", role: "store_assistant", storeIds: ["pine"] },
    { displayName: "Tv", role: "admin" },
    { displayName: "Ayanda", role: "store_assistant", destShop: "marathon-pe" },
    { isService: true, permFlags: {} },              // the card recon poller
    {},                                              // nothing at all
    null,
  ];
  it("keeps every account with no stockRole, however sparse", () => {
    for (const rec of noRole) expect(isPosOnlyAccount(rec)).toBe(false);
  });

  it("keeps an account with a NON-pos stockRole and nothing else", () => {
    for (const role of ["warehouse", "store", "admin", "", null, undefined]) {
      expect(isPosOnlyAccount({ stockRole: role })).toBe(false);
    }
  });

  it("is TOTAL — a record of any shape answers false rather than throwing", () => {
    for (const rec of [null, undefined, 0, "pos", [], ["pos"], true]) {
      expect(isPosOnlyAccount(rec)).toBe(false);
    }
  });
});

describe("hasStoreAppIdentity does not count stockRole", () => {
  it("because 'pos' is a stockRole, and counting it would make the predicate unsatisfiable", () => {
    expect(hasStoreAppIdentity({ stockRole: POS_STOCK_ROLE })).toBe(false);
    expect(hasStoreAppIdentity({ stockRole: "warehouse" })).toBe(false);
  });
});

describe("partitionRoster", () => {
  it("splits and COUNTS, so a hidden row is never silent", () => {
    const { visible, hiddenPosOnly } = partitionRoster([
      { uid: "till1", record: TILL, hubs: [] },
      { uid: "till2", record: TILL_BARE, hubs: [] },
      { uid: "zee", record: ZEE, hubs: [] },
      { uid: "sphe", record: { displayName: "Sphe" }, hubs: [] },
    ]);
    expect(visible.map((v) => v.uid)).toEqual(["zee", "sphe"]);
    expect(hiddenPosOnly).toBe(2);
  });

  it("an ASSIGNED till login stays visible — you cannot switch off a row you cannot see", () => {
    const { visible, hiddenPosOnly } = partitionRoster([
      { uid: "till1", record: TILL, hubs: ["hub1"] },
    ]);
    expect(visible.map((v) => v.uid)).toEqual(["till1"]);
    expect(hiddenPosOnly).toBe(0);
  });

  it("survives an empty or absent roster", () => {
    expect(partitionRoster([])).toEqual({ visible: [], hiddenPosOnly: 0 });
    expect(partitionRoster(null)).toEqual({ visible: [], hiddenPosOnly: 0 });
  });
});

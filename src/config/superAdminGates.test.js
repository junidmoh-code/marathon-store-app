// ─── EVERY SUPER-ADMIN GATE: JUNID AND JAFER PASS, STAFF DOES NOT ─────────────
// Junid asked (12 Nov, again 23 Nov 2026) that Jafer, his 50/50 partner, have
// exactly the same access as him everywhere. Each gate here is asked with:
//   Junid  — gunidmoh@gmail.com (with a G), no grants of his own
//   Jafer  — jafermohammed340@gmail.com, NO grants (so the pass is the
//            super-admin check itself, not a permission he happens to hold)
//   staff  — an ordinary account with a stock role and no named grants
import { describe, it, expect } from "vitest";
import { isSuperAdmin, isSuperAdminToken, SUPER_ADMIN_EMAILS, JUNID_EMAIL, JAFER_EMAIL } from "./superAdmins.js";
import { enginePolicyVisibleForViewer, enginePolicySeatingWritable, enginePolicySeatingMovable } from "./enginePolicy.js";
import { hasStockAccess } from "../components/stock/stockAccess.js";
import { canVerifyBrand } from "../components/concrete/concreteStore.js";

const JUNID = { email: JUNID_EMAIL };
const JAFER = { email: JAFER_EMAIL };
const STAFF = { email: "staff.member@gmail.com", stockRole: "store", permFlags: {} };
const PEOPLE = { Junid: JUNID, Jafer: JAFER };

describe("the list itself", () => {
  it("is exactly Junid and Jafer — nobody else", () => {
    expect([...SUPER_ADMIN_EMAILS].sort()).toEqual(["gunidmoh@gmail.com", "jafermohammed340@gmail.com"]);
  });
  it("is frozen: no code path can add to it at run time", () => {
    expect(Object.isFrozen(SUPER_ADMIN_EMAILS)).toBe(true);
    expect(() => SUPER_ADMIN_EMAILS.push("intruder@gmail.com")).toThrow();
    expect(isSuperAdmin("intruder@gmail.com")).toBe(false);
  });
  it("a look-alike address is not a super admin", () => {
    for (const e of ["junidmoh@gmail.com", "jafermohammed34@gmail.com", "jafermohammed340@gmail.com.evil.com", "gunidmoh@gmail.co"]) expect(isSuperAdmin(e)).toBe(false);
  });
  it("a token needs the verified flag", () => {
    expect(isSuperAdminToken({ email: JAFER_EMAIL, email_verified: true })).toBe(true);
    expect(isSuperAdminToken({ email: JAFER_EMAIL, email_verified: false })).toBe(false);
  });
});

describe.each(Object.entries(PEOPLE))("%s passes every gate", (_name, who) => {
  it("Missing Products (stock access)", () => {
    expect(hasStockAccess({ permRecord: null, hasPermission: () => false, isSuperAdmin: isSuperAdmin(who.email) })).toBe(true);
  });
  it("Engine Policy card", () => { expect(enginePolicyVisibleForViewer(who)).toBe(true); });
  it("Engine Policy → Seating tab: switch off / re-seat, and move", () => {
    expect(enginePolicySeatingWritable(who)).toBe(true);
    expect(enginePolicySeatingMovable(who)).toBe(true);
  });
  it("the division button / Concrete marking (brand check)", () => { expect(canVerifyBrand(who, null)).toBe(true); });
});

describe("an ordinary staff account passes none of the super-admin gates", () => {
  it("Engine Policy card", () => { expect(enginePolicyVisibleForViewer(STAFF)).toBe(false); });
  it("Seating switch-off (needs stockRole admin, which staff does not have)", () => { expect(enginePolicySeatingWritable(STAFF)).toBe(false); });
  it("Concrete marking", () => { expect(canVerifyBrand(STAFF, { stockRole: "store" })).toBe(false); });
  it("is not a super admin", () => { expect(isSuperAdmin(STAFF.email)).toBe(false); });
});

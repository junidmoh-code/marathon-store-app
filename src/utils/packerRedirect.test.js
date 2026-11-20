import { describe, it, expect } from "vitest";
import { packerRedirectUrl, POS_ONLINE_ORDERS_URL } from "./packerRedirect.js";

describe("the online packer goes to the POS (Junid, 20 Nov 2026)", () => {
  it("an active online packer is sent to the POS's Online Orders", () => {
    expect(packerRedirectUrl({ role: "admin", posAccess: { isActive: true, role: "onlinePacker" } })).toBe(POS_ONLINE_ORDERS_URL);
  });
  it("nobody else: other POS roles, an inactive packer, no record, the super admin", () => {
    expect(packerRedirectUrl({ posAccess: { isActive: true, role: "manager" } })).toBeNull();
    expect(packerRedirectUrl({ posAccess: { isActive: false, role: "onlinePacker" } })).toBeNull();
    expect(packerRedirectUrl(null)).toBeNull();
    expect(packerRedirectUrl({ posAccess: { isActive: true, role: "onlinePacker" } }, true)).toBeNull();
  });
});

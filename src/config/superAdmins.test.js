// Jafer gets the same super-admin power as Junid at every client gate.
// For each gate: Jafer passes, Junid passes, a staff account fails. Removing
// Jafer from SUPER_ADMIN_EMAILS (src/config/superAdmins.js) must fail this file.
import { describe, it, expect } from "vitest";
import {
  SUPER_ADMIN_EMAILS, JUNID_EMAIL, JAFER_EMAIL, isSuperAdmin, isSuperAdminToken, normaliseEmail,
  superAdminName, SUPER_ADMIN_RULE_EXPR,
} from "./superAdmins";
import { isStockHoldSuperAdmin } from "./stockHold";
import { isHubCountSuperAdmin, canUseHubSneakerCount } from "./hubSneakerCount";
import { enginePolicyVisibleForViewer, enginePolicySeatingWritable, enginePolicySeatingMovable } from "./enginePolicy";
import { isDisplayChecksSuperAdmin } from "./displayChecks";
import { canTogglePreview, PREVIEW_TOGGLE_EMAILS } from "../components/assistant/orderViewPreview";
import { effectiveStoreIds } from "../utils/stores";

const JUNID = "gunidmoh@gmail.com";
const JAFER = "jafermohammed340@gmail.com";
const STAFF = "rashid@marathon.internal";

describe("the list and the helper", () => {
  it("is exactly Junid and Jafer, frozen", () => {
    expect([...SUPER_ADMIN_EMAILS]).toEqual([JUNID, JAFER]);
    expect(JUNID_EMAIL).toBe(JUNID);
    expect(JAFER_EMAIL).toBe(JAFER);
    expect(Object.isFrozen(SUPER_ADMIN_EMAILS)).toBe(true);
  });

  it("isSuperAdmin: both pass, lowercased and trimmed; staff and near-misses fail", () => {
    expect(isSuperAdmin(JAFER)).toBe(true);
    expect(isSuperAdmin(JUNID)).toBe(true);
    expect(isSuperAdmin("  JaferMohammed340@GMAIL.com ")).toBe(true);
    expect(isSuperAdmin("GUNIDMOH@gmail.com")).toBe(true);
    for (const bad of [STAFF, "junidmoh@gmail.com", `${JAFER}.evil.com`, `x${JAFER}`, "jafermohammed340@gmail.co",
      "", "   ", null, undefined, 7, {}, [JAFER]]) {
      expect(isSuperAdmin(bad), `must refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("normaliseEmail trims and lowercases; non-strings become empty", () => {
    expect(normaliseEmail(" A@B.C ")).toBe("a@b.c");
    expect(normaliseEmail(null)).toBe("");
    expect(normaliseEmail(5)).toBe("");
  });

  it("isSuperAdminToken needs a verified email", () => {
    expect(isSuperAdminToken({ email: JAFER, email_verified: true })).toBe(true);
    expect(isSuperAdminToken({ email: JUNID, email_verified: true })).toBe(true);
    expect(isSuperAdminToken({ email: JAFER, email_verified: false })).toBe(false);
    expect(isSuperAdminToken({ email: STAFF, email_verified: true })).toBe(false);
    expect(isSuperAdminToken(null)).toBe(false);
  });

  it("names each admin; the rule expression admits both", () => {
    expect(superAdminName(JUNID)).toBe("Junid");
    expect(superAdminName(JAFER)).toBe("Jafer");
    expect(superAdminName(STAFF)).toBe(null);
    expect(SUPER_ADMIN_RULE_EXPR).toBe(`(auth.token.email === '${JUNID}' || auth.token.email === '${JAFER}')`);
  });
});

describe.each([
  ["Jafer", JAFER, true],
  ["Junid", JUNID, true],
  ["staff", STAFF, false],
])("every client gate — %s", (_who, email, expected) => {
  it("stock hold super-admin", () => expect(isStockHoldSuperAdmin({ email })).toBe(expected));
  it("hub sneaker count super-admin", () => expect(isHubCountSuperAdmin({ email })).toBe(expected));
  it("hub sneaker count opens", () => expect(canUseHubSneakerCount({ email, stockRole: null })).toBe(expected));
  it("engine policy visible", () => expect(enginePolicyVisibleForViewer({ email })).toBe(expected));
  it("engine policy seating writable", () => expect(enginePolicySeatingWritable({ email })).toBe(expected));
  it("engine policy seating movable", () => expect(enginePolicySeatingMovable({ email })).toBe(expected));
  it("display checks super-admin", () => expect(isDisplayChecksSuperAdmin({ email })).toBe(expected));
  it("sneaker-wall preview toggle", () => expect(canTogglePreview(email)).toBe(expected));
  it("preview list carries the super admins", () => expect(PREVIEW_TOGGLE_EMAILS.includes(email)).toBe(expected));
  it("store access bypass (via AuthGate's isSuperAdmin)", () => {
    const ids = effectiveStoreIds({ storeIds: [] }, isSuperAdmin(email));
    expect(ids.length > 0).toBe(expected);
  });
});

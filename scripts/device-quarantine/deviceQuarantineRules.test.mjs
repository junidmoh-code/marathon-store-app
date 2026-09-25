// The rules patch is pure: pinned here without the emulator (the emulator
// proof is prove-device-quarantine-rules.mjs, run against the LIVE document).
import { describe, it, expect } from "vitest";
import { patchDeviceQuarantineRules, STAMP_OK, STAMPS_NODE, DEVICE_REJECTS_NODE } from "./deviceQuarantineRules.mjs";
import { patchDeviceEnrolmentRules } from "../device-enrolment/deviceEnrolmentRules.mjs";

const LIVE = () => ({
  rules: {
    orders: { ".read": "auth != null", "$id": { ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'" } },
    refill_requests: { "$refillId": { ".write": "auth != null", status: { ".validate": "newData.isString()" } } },
    mirror_switch: { ".read": "auth != null", ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'" },
    users: { ".read": "auth != null" },
  },
});

describe("patchDeviceQuarantineRules", () => {
  it("adds the stamps rule under orders and refill_requests and the /device_rejects node — and nothing else", () => {
    const live = LIVE();
    const { doc, added } = patchDeviceQuarantineRules(live);
    expect(added).toEqual(["/orders/$id/stamps/$stamp", "/refill_requests/$refillId/stamps/$stamp", "/device_rejects"]);
    expect(doc.rules.orders.$id.stamps).toEqual(STAMPS_NODE);
    expect(doc.rules.refill_requests.$refillId.stamps).toEqual(STAMPS_NODE);
    expect(doc.rules.device_rejects).toEqual(DEVICE_REJECTS_NODE);
    // everything that was there is byte-identical
    const { stamps: _a, ...ordersRest } = doc.rules.orders.$id;
    expect(ordersRest).toEqual(live.rules.orders.$id);
    expect(doc.rules.mirror_switch).toEqual(live.rules.mirror_switch);
    expect(live.rules.device_rejects).toBeUndefined();      // the input is not mutated
  });
  it("is idempotent, and composes with #647 in either order to ONE document", () => {
    const once = patchDeviceQuarantineRules(LIVE()).doc;
    expect(patchDeviceQuarantineRules(once).doc).toEqual(once);
    const combined = patchDeviceEnrolmentRules(once).doc;
    expect(patchDeviceQuarantineRules(combined).doc).toEqual(combined);
    const enrolFirst = patchDeviceEnrolmentRules(patchDeviceQuarantineRules(patchDeviceEnrolmentRules(LIVE()).doc).doc).doc;
    expect(enrolFirst).toEqual(combined);
  });
  it("refuses to guess when a different rule is already in the place it writes", () => {
    const a = LIVE(); a.rules.orders.$id.stamps = { ".validate": "true" };
    expect(() => patchDeviceQuarantineRules(a)).toThrow(/different rule/);
    const b = LIVE(); b.rules.device_rejects = { ".read": "true" };
    expect(() => patchDeviceQuarantineRules(b)).toThrow(/different \/device_rejects/);
    const c = LIVE(); delete c.rules.refill_requests;
    expect(() => patchDeviceQuarantineRules(c)).toThrow(/refusing to guess/);
    expect(() => patchDeviceQuarantineRules({})).toThrow(/not a rules document/);
  });
  it("an existing stamp always passes; only a NEW one is judged", () => {
    expect(STAMP_OK.startsWith("data.exists() || (")).toBe(true);
  });
});

// The rules patch, as a pure function: it may only AND one condition onto each
// .write and add /device_enrolment — everything else in the live document must
// come through byte-for-byte. The emulator suite (prove-device-enrolment-
// rules.mjs) proves what the rules DO; this proves what the patch TOUCHES.
import { describe, it, expect } from "vitest";
import { patchDeviceEnrolmentRules, DEVICE_OK, DEVICE_ENROLMENT_NODE } from "./deviceEnrolmentRules.mjs";

const liveish = () => ({
  rules: {
    orders: { ".read": "auth != null", ".indexOn": ["destShop"], $id: { ".write": "auth != null" } },
    stock: { $loc: { $pid: { $size: { ".write": "auth != null && x", ".validate": "newData.hasChildren(['qty'])", qty: { ".validate": "newData.isNumber()" } } } } },
    mirror_changes: { ".read": "auth != null", ".write": "false" },
    shopify_sync: { ".read": false, ".write": false },
    open: { ".write": true },
    users: { ".read": "auth != null", ".write": "auth.token.email === 'gunidmoh@gmail.com'" },
  },
});

describe("patchDeviceEnrolmentRules", () => {
  it("ANDs the device condition onto every .write and nothing else", () => {
    const { doc, wrapped } = patchDeviceEnrolmentRules(liveish());
    expect(doc.rules.orders.$id[".write"]).toBe(`(auth != null) && ${DEVICE_OK}`);
    expect(doc.rules.stock.$loc.$pid.$size[".write"]).toBe(`(auth != null && x) && ${DEVICE_OK}`);
    expect(doc.rules.users[".write"]).toBe(`(auth.token.email === 'gunidmoh@gmail.com') && ${DEVICE_OK}`);
    expect(doc.rules.open[".write"]).toBe(DEVICE_OK);
    expect(wrapped.sort()).toEqual(["/open", "/orders/$id", "/stock/$loc/$pid/$size", "/users"]);
  });

  it("ANDs it onto every .read too — except /users and /mirror_switch, which the code screen needs", () => {
    const l = liveish();
    l.rules.mirror_switch = { ".read": "auth != null", ".write": "auth.token.email === 'x'" };
    const { doc, readsWrapped } = patchDeviceEnrolmentRules(l);
    expect(doc.rules.orders[".read"]).toBe(`(auth != null) && ${DEVICE_OK}`);
    expect(doc.rules.mirror_changes[".read"]).toBe(`(auth != null) && ${DEVICE_OK}`);
    expect(doc.rules.users[".read"]).toBe("auth != null");
    expect(doc.rules.mirror_switch[".read"]).toBe("auth != null");
    expect(doc.rules.shopify_sync[".read"]).toBe(false);
    expect(readsWrapped.sort()).toEqual(["/mirror_changes", "/orders"]);
  });

  it("leaves validates, indexes and write-false exactly as they were", () => {
    const before = liveish();
    const { doc } = patchDeviceEnrolmentRules(before);
    expect(doc.rules.orders[".indexOn"]).toEqual(["destShop"]);
    expect(doc.rules.stock.$loc.$pid.$size[".validate"]).toBe(before.rules.stock.$loc.$pid.$size[".validate"]);
    expect(doc.rules.stock.$loc.$pid.$size.qty).toEqual({ ".validate": "newData.isNumber()" });
    expect(doc.rules.mirror_changes[".write"]).toBe("false");
    expect(doc.rules.shopify_sync).toEqual({ ".read": false, ".write": false });
    // Strip every change and the rest must be identical.
    const strip = (n) => JSON.parse(JSON.stringify(n).split(` && ${DEVICE_OK.replace(/"/g, '\\"')}`).join("")
      .replace(/"\(([^"]*)\)"/g, '"$1"'));
    const { device_enrolment, ...rest } = doc.rules;
    expect(device_enrolment).toEqual(DEVICE_ENROLMENT_NODE);
    expect(strip(rest).orders).toEqual(before.rules.orders);
    expect(strip(rest).stock).toEqual(before.rules.stock);
  });

  it("does not mutate its input", () => {
    const before = liveish();
    const copy = JSON.parse(JSON.stringify(before));
    patchDeviceEnrolmentRules(before);
    expect(before).toEqual(copy);
  });

  it("is idempotent", () => {
    const once = patchDeviceEnrolmentRules(liveish()).doc;
    const twice = patchDeviceEnrolmentRules(once);
    expect(twice.doc).toEqual(once);
    expect(twice.wrapped).toEqual([]);
    expect(twice.readsWrapped).toEqual([]);
  });

  it("refuses a live /device_enrolment node it did not write", () => {
    const l = liveish();
    l.rules.device_enrolment = { ".read": true };
    expect(() => patchDeviceEnrolmentRules(l)).toThrow(/refusing to guess/);
    expect(() => patchDeviceEnrolmentRules({})).toThrow(/not a rules document/);
  });

  it("the condition passes every login that is not flagged, before it reads anything else", () => {
    // Order matters: `auth == null` first, then the flag — so for Mike, the
    // tills and Junid the rest of the expression is never evaluated.
    expect(DEVICE_OK.indexOf("auth == null")).toBe(1);
    expect(DEVICE_OK.indexOf("deviceCodeRequired")).toBeLessThan(DEVICE_OK.indexOf("deviceGate"));
  });
});

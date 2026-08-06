// ─── SAVE-FAILURE MESSAGES ───────────────────────────────────────────────────
// The contract under test: no product-save failure may reach the operator as a
// bare "please try again". Operator-flagged errors show verbatim; a permission
// denial names the fix (ask an admin about access); everything else still
// carries the underlying error text for the admin to read.

import { describe, it, expect } from "vitest";
import { saveFailureMessage } from "./saveFailureMessage.js";

const GENERIC = "Failed to save product. Please try again.";

describe("saveFailureMessage", () => {
  it("shows an operator-flagged error verbatim", () => {
    const err = Object.assign(new Error("That category is no longer available. Pick a category again."), {
      showToOperator: true,
    });
    expect(saveFailureMessage(err)).toBe(
      "Failed to save product:\nThat category is no longer available. Pick a category again."
    );
  });

  it("a permission denial is specific and actionable — access, admin, and the detail", () => {
    const err = new Error("set at /products/p123 failed: permission_denied");
    const msg = saveFailureMessage(err);
    expect(msg).toContain("permission denied");
    expect(msg).toContain("ask an admin");
    expect(msg).toContain("permission_denied");
    expect(msg).not.toBe(GENERIC);
  });

  it("matches the SDK's PERMISSION_DENIED code shape too", () => {
    const err = Object.assign(new Error("Permission denied"), { code: "PERMISSION_DENIED" });
    const msg = saveFailureMessage(err);
    expect(msg).toContain("ask an admin");
  });

  it("a network failure says so and says nothing was saved", () => {
    const msg = saveFailureMessage(new Error("Client is offline (network timeout)"));
    expect(msg).toContain("network problem");
    expect(msg).toContain("was not saved");
  });

  it("an unrecognised error still surfaces its real text — nothing is swallowed", () => {
    // The exact error behind the 2026-08-06 outage: undefined in the payload.
    const err = new Error(
      "set failed: value argument contains undefined in property 'products.p123.styleCodeSource'"
    );
    const msg = saveFailureMessage(err);
    expect(msg).toContain("contains undefined in property 'products.p123.styleCodeSource'");
    expect(msg).toContain("admin");
    expect(msg).not.toBe(GENERIC);
  });

  it("survives a non-Error throw", () => {
    expect(saveFailureMessage("boom")).toContain("boom");
    expect(saveFailureMessage(undefined)).toContain("unknown error");
  });
});

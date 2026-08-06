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

  it("a network failure is honest about the unknown outcome — check before re-saving", () => {
    // The write may have committed server-side without the ack reaching the
    // client; a blind re-save duplicates the product. The message must never
    // claim the save definitely failed.
    const msg = saveFailureMessage(new Error("Client is offline (network timeout)"));
    expect(msg).toContain("network problem");
    expect(msg).toContain("may or may not");
    expect(msg).toContain("Check the product list");
    expect(msg).toContain("duplicate");
    expect(msg).not.toContain("was not saved");
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

// ─── THE FALSE RESERVATION MESSAGE IS GONE ───────────────────────────────────
// The product write runs BEFORE the style-code claim, so a failed write means
// nothing was reserved — yet a leftover catch from the old claim-first ordering
// told staff a reservation had landed and to ask an admin to clear it
// (CodeRabbit, PR #327). Same source-text idiom as displayRegisterRemoved:
// the monolithic App.jsx save handler offers no seam to prove this
// behaviourally.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("a failed product write never claims a reservation landed", () => {
  it("App.jsx no longer carries the pre-claim 'already reserved' error", () => {
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
    expect(app).not.toMatch(/was already\s+.?reserved for id/);
    expect(app).not.toMatch(/failed AFTER the style-code claim/);
  });
});

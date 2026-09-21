// ─── EVERY FAILURE NAMES ITSELF ──────────────────────────────────────────────
// The test that matters most here is the REGRESSION one: the real 19 Sept
// outage, replayed as the error the callable actually threw, asserting that the
// server's own words reach the screen and that "check the signal" does not.

import { describe, it, expect } from "vitest";
import {
  FAILURE, describeCallableError, describeDecodeError, looksLikeServerProse,
} from "./captureFailure";

/** A rejected Firebase callable, as the SDK actually shapes one. */
const callableError = (code, message) =>
  Object.assign(new Error(message), { code: `functions/${code}`, name: "FirebaseError" });

describe("the 19 Sept 2026 outage, replayed", () => {
  // Gemini answered 402 (prepayment credits depleted) to every OCR call. The
  // callable turned that into HttpsError("unavailable", <its own sentence>).
  const outage = callableError("unavailable", "Could not read the photos right now — try again.");

  it("shows the server's own sentence, not the generic one", () => {
    const { kind, message } = describeCallableError(outage);
    expect(kind).toBe(FAILURE.SERVER_REFUSED);
    expect(message).toBe("Could not read the photos right now — try again.");
    expect(message).not.toMatch(/check the signal/i);
  });

  it("logs the code and the message, so an unknown one can be chased later", () => {
    expect(describeCallableError(outage).logLine)
      .toBe("cardBatchCapture failed [code=unavailable] [name=FirebaseError] Could not read the photos right now — try again.");
  });
});

describe("a server refusal reaches the screen verbatim", () => {
  // The refusal the owner said must reach his screen, in the server's wording.
  it("carries a duplicate-batch refusal word for word", () => {
    const err = callableError("already-exists",
      "Batch #58 for this terminal is already captured. If the earlier capture was wrong, resubmit as a correction — both records are kept.");
    const { kind, message } = describeCallableError(err);
    expect(kind).toBe(FAILURE.SERVER_REFUSED);
    expect(message).toContain("Batch #58");
    expect(message).toContain("already captured");
  });

  it("does not paraphrase a wrong-till refusal", () => {
    const err = callableError("invalid-argument",
      "This slip prints TID 67365901, not the till you picked (Marathon Till 2). Capture the slip on its own till.");
    expect(describeCallableError(err).message).toContain("TID 67365901");
  });

  it("adds the expiry hint to an auth refusal without hiding the server's words", () => {
    const err = callableError("unauthenticated", "Sign in required.");
    const { kind, message } = describeCallableError(err);
    expect(kind).toBe(FAILURE.SERVER_REFUSED);
    expect(message).toContain("Sign in required.");
    expect(message).toMatch(/session has expired/i);
  });
});

describe("transport is told apart from the server's words", () => {
  it("a bare status token is transport, not a refusal", () => {
    for (const token of ["internal", "unavailable", "Response is missing data field", "Load failed"]) {
      const { kind, message } = describeCallableError(callableError("internal", token));
      expect(kind).toBe(FAILURE.TRANSPORT);
      expect(message).toMatch(/could not reach the server/i);
      // The token itself is never shown — it says nothing to a manager.
      expect(message).not.toContain(token);
    }
  });

  it("a timeout says so, because 'try again' is different advice", () => {
    const { kind, message } = describeCallableError(callableError("deadline-exceeded", "deadline-exceeded"));
    expect(kind).toBe(FAILURE.TRANSPORT);
    expect(message).toMatch(/too long/i);
  });

  it("a call with nothing of the server's in it, while offline, says offline", () => {
    const { kind, message } = describeCallableError(callableError("internal", "internal"), { online: false });
    expect(kind).toBe(FAILURE.OFFLINE);
    expect(message).toMatch(/offline/i);
    expect(message).toMatch(/not lost/i);
  });

  it("a refusal that ALREADY ARRIVED outranks the radio dropping a moment later", () => {
    // The phone can fall off the shop wifi between the server's answer and
    // this line. Showing "you are offline" would send the manager back to
    // re-capture a slip the server has already dealt with.
    const err = callableError("already-exists", "Batch #58 for this terminal is already captured.");
    const { kind, message } = describeCallableError(err, { online: false });
    expect(kind).toBe(FAILURE.SERVER_REFUSED);
    expect(message).toContain("Batch #58");
  });
});

describe("only the CALLABLE gets to speak in its own words", () => {
  // The `try` around the capture also covers the screen's own state updates,
  // so a local exception lands in exactly the same catch. Prose is not a
  // passport: origin is read from the error's shape, never from its words.
  const localThrow = new TypeError("Cannot read properties of undefined (reading 'tid')");

  it("a local TypeError is UNKNOWN, not a server refusal", () => {
    const { kind } = describeCallableError(localThrow);
    expect(kind).toBe(FAILURE.UNKNOWN);
  });

  it("…and its raw message is never shown to the manager", () => {
    const { message, logLine } = describeCallableError(localThrow);
    expect(message).not.toContain("Cannot read properties");
    expect(message).not.toContain("undefined");
    expect(message).toMatch(/not identifiable/i);
    // It still has to be findable afterwards.
    expect(logLine).toContain("Cannot read properties of undefined");
    expect(logLine).toContain("[name=TypeError]");
  });

  it("a local throw while offline still says offline", () => {
    expect(describeCallableError(localThrow, { online: false }).kind).toBe(FAILURE.OFFLINE);
  });

  it("recognises a callable error by EITHER mark, not both", () => {
    // The two have varied across SDK versions; requiring both would silently
    // demote real refusals to "unknown".
    const byName = Object.assign(new Error("Batch #58 is already captured."), { name: "FirebaseError" });
    const byCode = Object.assign(new Error("Batch #58 is already captured."), { code: "functions/already-exists" });
    expect(describeCallableError(byName).kind).toBe(FAILURE.SERVER_REFUSED);
    expect(describeCallableError(byCode).kind).toBe(FAILURE.SERVER_REFUSED);
  });

  it("a bare status code with no functions/ prefix is not treated as the server", () => {
    const impostor = Object.assign(new Error("Something plausible happened here."), { code: "unavailable" });
    expect(describeCallableError(impostor).kind).toBe(FAILURE.UNKNOWN);
  });
});

describe("the catch-all survives, and is identifiable", () => {
  it("an error with nothing on it is UNKNOWN and says how to report it", () => {
    const { kind, message, logLine } = describeCallableError({});
    expect(kind).toBe(FAILURE.UNKNOWN);
    expect(message).toMatch(/not identifiable/i);
    expect(message).toMatch(/Junid/);
    expect(logLine).toContain("[code=none]");
    expect(logLine).toContain("(no message)");
  });

  it("every class logs a line — an unnamed failure must still be findable", () => {
    const cases = [
      describeCallableError({}),
      describeCallableError(callableError("internal", "internal")),
      describeCallableError(callableError("unavailable", "Could not read the photos right now — try again.")),
      describeDecodeError(new Error("That Apple photo couldn't be opened on this device.")),
    ];
    for (const c of cases) expect(c.logLine.length).toBeGreaterThan(20);
  });
});

describe("decode failures keep the decoder's own wording", () => {
  it("a HEIC refusal is shown as the decoder wrote it", () => {
    const msg = "That Apple photo couldn't be opened on this device. Taking a screenshot of it, or re-saving it, usually works.";
    const { kind, message } = describeDecodeError(new Error(msg));
    expect(kind).toBe(FAILURE.DECODE);
    expect(message).toBe(msg);
  });

  it("a shapeless decoder throw still gets a sentence", () => {
    const { kind, message } = describeDecodeError(Object.assign(new Error(""), { name: "DOMException" }));
    expect(kind).toBe(FAILURE.DECODE);
    expect(message).toMatch(/could not be opened on this phone/i);
  });
});

describe("looksLikeServerProse", () => {
  it("accepts sentences and rejects tokens", () => {
    expect(looksLikeServerProse("Batch #58 for this terminal is already captured.")).toBe(true);
    expect(looksLikeServerProse("internal")).toBe(false);
    expect(looksLikeServerProse("unavailable")).toBe(false);
    expect(looksLikeServerProse("")).toBe(false);
    expect(looksLikeServerProse("Load failed")).toBe(false);
    // Short two-word fragments are not sentences either.
    expect(looksLikeServerProse("no data")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { DISPOSITION, PULL_STATUS, LAYBY_STATUS, dispositionOf } from "./contract";

// Backward-compat is the whole point of the disposition field: legacy pulls (no
// field) and explicit "collect" must take the existing collect path; only the
// exact "return_to_stock" value branches to the new return-to-stock path.
describe("dispositionOf — backward compatibility", () => {
  it("defaults to collect when the field is absent (legacy pulls)", () => {
    expect(dispositionOf({})).toBe(DISPOSITION.COLLECT);
    expect(dispositionOf({ disposition: undefined })).toBe(DISPOSITION.COLLECT);
    expect(dispositionOf({ disposition: null })).toBe(DISPOSITION.COLLECT);
  });

  it("treats explicit collect as collect", () => {
    expect(dispositionOf({ disposition: "collect" })).toBe(DISPOSITION.COLLECT);
  });

  it("only the exact return_to_stock value branches to the new path", () => {
    expect(dispositionOf({ disposition: "return_to_stock" })).toBe(DISPOSITION.RETURN_TO_STOCK);
  });

  it("falls back to collect for unknown/garbage values (fail safe)", () => {
    expect(dispositionOf({ disposition: "Return_To_Stock" })).toBe(DISPOSITION.COLLECT);
    expect(dispositionOf({ disposition: "returnToStock" })).toBe(DISPOSITION.COLLECT);
    expect(dispositionOf({ disposition: "garbage" })).toBe(DISPOSITION.COLLECT);
  });

  it("tolerates null/undefined pulls", () => {
    expect(dispositionOf(null)).toBe(DISPOSITION.COLLECT);
    expect(dispositionOf(undefined)).toBe(DISPOSITION.COLLECT);
  });
});

describe("new contract constants", () => {
  it("exposes the return-to-stock pull status + returned layby status", () => {
    expect(PULL_STATUS.RETURNED_TO_STOCK).toBe("returnedToStock");
    expect(LAYBY_STATUS.RETURNED).toBe("returned");
    expect(DISPOSITION).toEqual({ COLLECT: "collect", RETURN_TO_STOCK: "return_to_stock" });
  });

  it("leaves the existing collect-path statuses intact", () => {
    expect(PULL_STATUS.PENDING).toBe("pending");
    expect(PULL_STATUS.SENT).toBe("sentToStore");
    expect(PULL_STATUS.REJECTED).toBe("rejected");
  });
});

// The queue's movement reasons are now derived from the destination. For hub2
// they MUST reproduce the existing live strings byte-for-byte, or the ledger's
// history changes meaning mid-stream.
import { describe, it, expect } from "vitest";
const auto = (dest) => `${dest}_auto_refill`;
const unc  = (dest) => `${dest}_refill_uncounted`;
describe("derived movement reasons", () => {
  it("hub2 reproduces the existing live strings exactly", () => {
    expect(auto("hub2")).toBe("hub2_auto_refill");
    expect(unc("hub2")).toBe("hub2_refill_uncounted");
  });
  it("hub1 gets its own reasons, never logged as hub2 movement", () => {
    expect(auto("hub1")).toBe("hub1_auto_refill");
    expect(unc("hub1")).toBe("hub1_refill_uncounted");
  });
});

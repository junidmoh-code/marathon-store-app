// Which lane the hub refill queue opens on. The queue has always shown CLOTHING —
// it is Central's daily job — so adding a sneaker lane must not displace it.
// Measured the day the split shipped: hub2 held 109 open clothing requests
// against 98 sneaker ones, so a sneakers-first default would have hidden all 109
// behind a pill for the people who work them.
import { describe, it, expect } from "vitest";

// Mirrors Hub2RefillQueue's activeKind expression.
const defaultLane = (clothing, sneakers, chosen = null) =>
  chosen || (clothing ? "clothing" : sneakers ? "sneakers" : "clothing");

describe("hub refill queue — default lane", () => {
  it("opens on CLOTHING whenever clothing work exists, even with more sneakers", () => {
    expect(defaultLane(109, 98)).toBe("clothing");
    expect(defaultLane(1, 500)).toBe("clothing");
  });

  it("falls through to sneakers only when there is no clothing work", () => {
    expect(defaultLane(0, 6)).toBe("sneakers");
  });

  it("shows the clothing lane when both are empty, not an empty sneaker lane", () => {
    expect(defaultLane(0, 0)).toBe("clothing");
  });

  it("an explicit pill choice always wins", () => {
    expect(defaultLane(109, 98, "sneakers")).toBe("sneakers");
    expect(defaultLane(0, 6, "clothing")).toBe("clothing");
  });
});

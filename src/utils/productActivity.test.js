import { describe, it, expect } from "vitest";
import { eventsForProduct } from "./productActivity";

const p1 = { id: "p1", name: "Y", previousNames: ["X"] };
const p2 = { id: "p2", name: "X" };          // took the freed name
const catalogue = [p1, p2];

describe("a renamed product's activity", () => {
  it("keeps its own events by id, and its old-name events with no id or a dead id", () => {
    const log = [
      { productId: "p1", productName: "X" },
      { productName: "X" },                       // pre-June event, no id
      { productId: "p-merged", productName: "X" }, // merged record
      { productName: "Y" },
    ];
    expect(eventsForProduct(log, p1, catalogue)).toHaveLength(4);
  });
  it("never takes another live product's events through a reused old name", () => {
    const log = [{ productId: "p2", productName: "X" }];
    expect(eventsForProduct(log, p1, catalogue)).toEqual([]);
    expect(eventsForProduct(log, p2, catalogue)).toHaveLength(1);
  });
});

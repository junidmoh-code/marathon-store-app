// The card's two wiring claims: a tap saves through the ONE helper and shows
// an Undo; a failed save flips the switch back and SAYS so (never silent).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const mark = vi.fn();
vi.mock("./concreteStore", () => ({ markConcreteProduct: (...a) => mark(...a), confirmBrand: vi.fn(async () => ({ ok: true })), restoreMarathonListing: vi.fn(async () => ({ ok: true, restored: false })) }));
const { default: ConcreteProductsCard } = await import("./ConcreteProductsCard.jsx");

const products = [
  { id: "p2", name: "Pant fashion 3306", category: "Clothing", productType: "clothing", categoryKey: "pants", sizes: ["S"] },
  { id: "p1", name: "Nike Air", category: "Footwear", productType: "sneaker", sizes: ["9"] },
];
const text = (r) => JSON.stringify(r.toJSON());
const sw = (r) => r.root.findAll((n) => n.props.role === "switch")[0];

describe("ConcreteProductsCard", () => {
  beforeEach(() => mark.mockReset());
  it("lists clothing only, saves optimistically, offers Undo", async () => {
    mark.mockResolvedValue({ ok: true });
    let r;
    await act(async () => { r = TestRenderer.create(<ConcreteProductsCard products={products} />); });
    expect(text(r)).toContain("Pant fashion 3306");
    expect(text(r)).not.toContain("Nike Air");
    await act(async () => { sw(r).props.onClick({ stopPropagation() {} }); });
    expect(mark).toHaveBeenCalledWith("p2", true, expect.anything());
    expect(sw(r).props["aria-checked"]).toBe(true);
    expect(text(r)).toContain("Undo");
  });
  it("a refused save flips back and shows the reason", async () => {
    mark.mockResolvedValue({ ok: false, message: "Permission denied — the Concrete console rules have not been pasted yet. Nothing was saved." });
    let r;
    await act(async () => { r = TestRenderer.create(<ConcreteProductsCard products={products} />); });
    await act(async () => { sw(r).props.onClick({ stopPropagation() {} }); });
    expect(sw(r).props["aria-checked"]).toBe(false);
    expect(text(r)).toContain("Permission denied");
  });
});

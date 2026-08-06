// ─── DISPLAY SEND — "a display cannot be sent without a size", proven ────────
// The rule the send button consults, tested as the operator experiences it.

import { describe, it, expect } from "vitest";
import { validateDisplaySend, displaySendNeedsSize, isDisplayPairSend } from "./displaySend";

const SNEAKER = { id: "p1", name: "Dunk", category: "Footwear", productType: "sneaker", sizes: ["6", "7"] };
const SHIRT = { id: "p2", name: "Tee", category: "Clothing", productType: "clothing", sizes: ["M"] };

describe("the size-at-send rule", () => {
  it("a display pair request cannot be sent without a size", () => {
    const order = { id: "o1", requestDisplayPartner: true };
    expect(validateDisplaySend(order, SNEAKER, null).ok).toBe(false);
    expect(validateDisplaySend(order, SNEAKER, "").ok).toBe(false);
    expect(validateDisplaySend(order, SNEAKER, "  ").ok).toBe(false);
    expect(validateDisplaySend(order, SNEAKER, "_").ok).toBe(false);
  });

  it("…even when the ORDER carries a size — the picker confirms what physically leaves", () => {
    const order = { id: "o1", requestDisplayPartner: true, size: "6" };
    expect(validateDisplaySend(order, SNEAKER, null).ok).toBe(false);
    expect(displaySendNeedsSize(order, SNEAKER)).toBe(true);
  });

  it("a chosen size passes and is what gets stamped", () => {
    const order = { id: "o1", requestDisplayPartner: true };
    const out = validateDisplaySend(order, SNEAKER, "7");
    expect(out).toEqual({ ok: true, sentSize: "7" });
  });

  it("an order already sent with a size does not re-demand one", () => {
    const order = { id: "o1", requestDisplayPartner: true, sentSize: "7" };
    expect(displaySendNeedsSize(order, SNEAKER)).toBe(false);
  });

  it("ordinary orders and clothing are untouched by the rule", () => {
    expect(validateDisplaySend({ id: "o2" }, SNEAKER, null).ok).toBe(true);
    expect(validateDisplaySend({ id: "o3", requestDisplayPartner: true }, SHIRT, null).ok).toBe(true);
    expect(isDisplayPairSend({ requestDisplayPartner: true }, SHIRT)).toBe(false);
  });
});

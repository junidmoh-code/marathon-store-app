import { describe, it, expect, beforeEach, vi } from "vitest";
import { transferMovementId, loadDraft, saveDraft, clearDraft } from "./transferDraft";

// Minimal Map-backed localStorage stub — the test runner is the node
// environment (no jsdom), so the module's `localStorage` reads hit this.
function installStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
  return m;
}

const BASKET = { "p1__M": { productId: "p1", productName: "Tee", size: "M", qty: 2 } };

describe("transferMovementId — deterministic + key-safe", () => {
  it("same (transferId, product, size) → identical id (idempotent retry)", () => {
    const a = transferMovementId("-Otx1", "p1783", "M");
    const b = transferMovementId("-Otx1", "p1783", "M");
    expect(a).toBe(b);
    expect(a).toBe("-Otx1:p1783:M");
  });

  it("differs by size and by transfer", () => {
    expect(transferMovementId("-Otx1", "p1", "M")).not.toBe(transferMovementId("-Otx1", "p1", "L"));
    expect(transferMovementId("-Otx1", "p1", "M")).not.toBe(transferMovementId("-Otx2", "p1", "M"));
  });

  it("encodes an RTDB-illegal half-size so the movement key is dot-free", () => {
    expect(transferMovementId("-Otx1", "p1", "5.5")).toBe("-Otx1:p1:5_5");
  });

  it("folds a null/one-size to the '_' sentinel", () => {
    expect(transferMovementId("-Otx1", "p1", null)).toBe("-Otx1:p1:_");
  });
});

describe("draft persistence round-trip", () => {
  beforeEach(() => installStorage());

  it("save → load returns the cart, source, destination and transferId", () => {
    saveDraft({ from: "central", to: "marathon-pe", refillId: null, transferId: "-Otx1", basket: BASKET, lineResults: {} });
    const d = loadDraft();
    expect(d.from).toBe("central");
    expect(d.to).toBe("marathon-pe");
    expect(d.transferId).toBe("-Otx1");
    expect(d.basket).toEqual(BASKET);
    expect(d.schema).toBe(1);
  });

  it("preserves per-line results so a restored cart keeps its failed marks", () => {
    const lineResults = { "p1__M": { status: "failed", reason: "write_failed", kind: "network" } };
    saveDraft({ from: "central", to: "marathon-pe", transferId: "-Otx1", basket: BASKET, lineResults });
    expect(loadDraft().lineResults).toEqual(lineResults);
  });

  it("an empty cart removes the key (full success / manual clear leaves nothing)", () => {
    saveDraft({ from: "central", transferId: "-Otx1", basket: BASKET });
    expect(loadDraft()).not.toBeNull();
    saveDraft({ from: "central", transferId: "-Otx1", basket: {} });
    expect(loadDraft()).toBeNull();
  });

  it("clearDraft wipes a saved draft", () => {
    saveDraft({ from: "central", transferId: "-Otx1", basket: BASKET });
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  it("rejects a stale-schema payload", () => {
    globalThis.localStorage.setItem("transfer_draft_v1", JSON.stringify({ schema: 99, basket: BASKET }));
    expect(loadDraft()).toBeNull();
  });

  it("survives a corrupt payload without throwing", () => {
    globalThis.localStorage.setItem("transfer_draft_v1", "{not json");
    expect(loadDraft()).toBeNull();
  });

  it("never throws when storage itself fails (quota / private mode)", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(() => saveDraft({ from: "central", basket: BASKET })).not.toThrow();
    expect(loadDraft()).toBeNull();
    expect(() => clearDraft()).not.toThrow();
  });
});

// ─── REGISTERING A PRINTED CODE — against a create-only index ────────────────
// The live rule on /barcodes/$code permits a write ONLY when the slot is empty
// (".write": "… && !data.exists()"). So the fake below REFUSES an overwrite the
// way the database does, and these tests prove the code never attempts one:
// remove the read-before-write and the overwrite guard fires instead of a
// silent denial nobody would have noticed in production.

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
let overwriteAttempts = [];

function getPath(path) {
  let node = store;
  for (const part of String(path).split("/")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node === undefined ? null : node;
}
function setPath(path, value) {
  const parts = String(path).split("/");
  let node = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  get: async (node) => ({ val: () => getPath(node.path), exists: () => getPath(node.path) != null }),
  // THE RULE, ENFORCED: create-only. An overwrite is recorded and rejected.
  set: async (node, value) => {
    if (getPath(node.path) != null) {
      overwriteAttempts.push(node.path);
      throw new Error("PERMISSION_DENIED: /barcodes is create-only");
    }
    setPath(node.path, value);
  },
}));
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-10T00:00:00.000Z" }));

const { registerPrintedBarcode, inspectPrintedBarcode, readBarcodeOwners } =
  await import("./printedBarcodeStore");

const OUD_MOOD = "6291106065114";
const EPIC = "6291103660466";

beforeEach(() => { store = {}; overwriteAttempts = []; });

describe("a free code registers against size \"_\"", () => {
  it("writes the index row pointing at the product, one-size", async () => {
    const out = await registerPrintedBarcode("pPerfume", OUD_MOOD);
    expect(out.ok).toBe(true);
    expect(out.written).toEqual([OUD_MOOD]);
    expect(store.barcodes[OUD_MOOD]).toEqual({
      productId: "pPerfume", size: "_", at: "2026-08-10T00:00:00.000Z",
    });
  });

  it("uses the \"_\" SENTINEL, never a display label", async () => {
    // The 2026-07 incident: a display label ("Free Size") reaching a storage
    // key minted a phantom stock cell and drove hub cells negative. The index
    // row's size must be the sentinel and nothing that resembles wording.
    await registerPrintedBarcode("pPerfume", EPIC);
    const size = store.barcodes[EPIC].size;
    expect(size).toBe("_");
    expect(size).not.toMatch(/[A-Za-z ]/);
  });

  it("registers a UPC-A under both its forms in one call", async () => {
    const out = await registerPrintedBarcode("pPerfume", "036000291452");
    expect(out.written).toEqual(["036000291452", "0036000291452"]);
    expect(store.barcodes["036000291452"].productId).toBe("pPerfume");
    expect(store.barcodes["0036000291452"].productId).toBe("pPerfume");
  });
});

describe("a code already in the index is NEVER overwritten", () => {
  it("SAME product → reports already-registered and writes nothing", async () => {
    await registerPrintedBarcode("pPerfume", OUD_MOOD);
    const before = JSON.stringify(store);

    const again = await registerPrintedBarcode("pPerfume", OUD_MOOD);
    expect(again.ok).toBe(true);            // success — there is nothing to do
    expect(again.kind).toBe("already");
    expect(again.written).toEqual([]);
    expect(JSON.stringify(store)).toBe(before);
    expect(overwriteAttempts).toEqual([]);  // the rule was never even tested
  });

  it("DIFFERENT product → refuses, names the owner, writes nothing", async () => {
    await registerPrintedBarcode("pFirst", OUD_MOOD);
    const before = JSON.stringify(store);

    const clash = await registerPrintedBarcode("pSecond", OUD_MOOD);
    expect(clash.ok).toBe(false);
    expect(clash.kind).toBe("conflict");
    expect(clash.otherProductId).toBe("pFirst");
    expect(clash.written).toEqual([]);
    expect(JSON.stringify(store)).toBe(before);
    expect(overwriteAttempts).toEqual([]);
    // And the index still resolves to the ORIGINAL owner.
    expect(store.barcodes[OUD_MOOD].productId).toBe("pFirst");
  });

  it("a UPC-A whose TWIN is owned elsewhere writes NEITHER form", async () => {
    // Half-registering would spread one duplicate across two index rows.
    setPath("barcodes/0036000291452", { productId: "pOther", size: "_" });
    const clash = await registerPrintedBarcode("pMine", "036000291452");
    expect(clash.ok).toBe(false);
    expect(getPath("barcodes/036000291452")).toBe(null);
  });
});

describe("an auto-generated barcode is never touched", () => {
  it("registering an EAN leaves the shop code resolving to the same product", async () => {
    // The product already carries a minted 8-digit shop code, and a label with
    // that code is stuck on the box. Both must keep scanning afterwards.
    setPath("barcodes/00000042", { productId: "pPerfume", size: "_" });

    await registerPrintedBarcode("pPerfume", OUD_MOOD);

    expect(store.barcodes["00000042"]).toEqual({ productId: "pPerfume", size: "_" });
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
    // Many-to-one: two codes, one product, one size.
    expect(store.barcodes["00000042"].size).toBe(store.barcodes[OUD_MOOD].size);
  });

  it("a second printed code on the same product also just adds a row", async () => {
    await registerPrintedBarcode("pPerfume", OUD_MOOD);
    await registerPrintedBarcode("pPerfume", EPIC);
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
    expect(store.barcodes[EPIC].productId).toBe("pPerfume");
  });
});

describe("inspection is read-only", () => {
  it("reports a conflict for a product that does not exist yet (create flow)", async () => {
    await registerPrintedBarcode("pFirst", OUD_MOOD);
    const verdict = await inspectPrintedBarcode(OUD_MOOD, null);
    expect(verdict.kind).toBe("conflict");
    expect(verdict.otherProductId).toBe("pFirst");
  });

  it("reads a free slot as unowned", async () => {
    expect(await readBarcodeOwners([EPIC])).toEqual([{ code: EPIC, productId: null }]);
  });

  it("refuses to register without a productId", async () => {
    await expect(registerPrintedBarcode(null, OUD_MOOD)).rejects.toThrow(/productId/);
  });
});

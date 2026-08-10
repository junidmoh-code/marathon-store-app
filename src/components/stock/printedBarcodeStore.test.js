// ─── REGISTERING A PRINTED CODE — against a create-only index ────────────────
// The live rule on /barcodes/$code permits a write ONLY when the slot is empty
// (".write": "… && !data.exists()"). So the fake below REFUSES an overwrite the
// way the database does, and these tests prove the code never attempts one:
// remove the read-before-write and the overwrite guard fires instead of a
// silent denial nobody would have noticed in production.

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
let overwriteAttempts = [];
// Codes whose write is DENIED even though the slot is empty — the race in
// which another client claims a code between our read and our write, which is
// exactly how a UPC-A ends up half-registered.
let denyWrites = new Set();
// Codes where a CONCURRENT client's row wins: our write appears to go through
// locally, but what is actually at that path afterwards names somebody else.
// This is the read→write race the create-only rule arbitrates, and the only
// way to detect it from the client is to read the row back.
let stealWrites = new Map();

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
    if ([...denyWrites].some((c) => String(node.path).endsWith(`/${c}`))) {
      throw new Error("PERMISSION_DENIED: claimed in the meantime");
    }
    const code = String(node.path).split("/").pop();
    const thief = stealWrites.get(code);
    setPath(node.path, thief ? { ...value, productId: thief } : value);
  },
}));
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-10T00:00:00.000Z" }));

const { registerPrintedBarcode, inspectPrintedBarcode, readBarcodeOwners, attachPrintedBarcode, registrationRefusalText } =
  await import("./printedBarcodeStore");

const OUD_MOOD = "6291106065114";
const EPIC = "6291103660466";

beforeEach(() => { store = {}; overwriteAttempts = []; denyWrites = new Set(); stealWrites = new Map(); });

describe("losing the read→write race is DETECTED, not assumed away", () => {
  it("reads the row back and refuses to claim a code that names somebody else", async () => {
    // Between our read of an empty slot and our write, another client claims
    // the code for a different product. Trusting the write to have "succeeded"
    // would hand the caller a code the POS resolves elsewhere — and the caller
    // would then write it onto the product record as its identity.
    stealWrites.set(OUD_MOOD, "pSomebodyElse");

    const out = await registerPrintedBarcode("pPerfume", OUD_MOOD);

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("conflict");
    expect(out.otherProductId).toBe("pSomebodyElse");
    expect(out.written).toEqual([]);
  });

  it("and attachPrintedBarcode therefore never records it on the product", async () => {
    stealWrites.set(OUD_MOOD, "pSomebodyElse");
    const writeProductField = vi.fn();
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD, writeProductField });
    expect(out.ok).toBe(false);
    expect(writeProductField).not.toHaveBeenCalled();
  });
});

describe("a UPC-A whose twin is denied mid-write", () => {
  it("keeps the form that LANDED instead of reporting total failure", async () => {
    // The primary form is written first, so the number on the box resolves.
    // Throwing here would tell the caller nothing was registered, and it would
    // mint a shop code the product did not need. (Kimi review, PR #340.)
    denyWrites.add("0036000291452");

    const out = await registerPrintedBarcode("pPerfume", "036000291452");

    expect(out.ok).toBe(true);
    expect(out.written).toEqual(["036000291452"]);
    expect(out.failed.map((f) => f.code)).toEqual(["0036000291452"]);
    expect(store.barcodes["036000291452"].productId).toBe("pPerfume");
  });

  it("throws when NOTHING landed, so the caller knows to fall back", async () => {
    denyWrites.add("036000291452");
    denyWrites.add("0036000291452");
    await expect(registerPrintedBarcode("pPerfume", "036000291452")).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

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

  it("writes ONLY the missing form when we already own the other", async () => {
    // A UPC-A registered before the EAN-13 twin existed (or a retry after a
    // half-completed write). Re-writing the form we already own would be an
    // overwrite — denied by the rule, and a denial nobody reads back looks
    // exactly like success. Only the genuinely empty slot may be written.
    setPath("barcodes/036000291452", { productId: "pPerfume", size: "_" });

    const out = await registerPrintedBarcode("pPerfume", "036000291452");

    expect(out.ok).toBe(true);
    expect(out.written).toEqual(["0036000291452"]);   // the twin ONLY
    expect(overwriteAttempts).toEqual([]);            // the owned form untouched
    expect(store.barcodes["036000291452"]).toEqual({ productId: "pPerfume", size: "_" });
    expect(store.barcodes["0036000291452"].productId).toBe("pPerfume");
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

// ─── THE ORDERING, WHICH NOTHING USED TO TEST ────────────────────────────────
// Both reviewers landed on the same gap: swapping the two writes in the detail
// page (product record before index) broke NO test, even though the comment
// calls that ordering non-negotiable. Both surfaces now route through
// attachPrintedBarcode, and the ordering is pinned here.
describe("attachPrintedBarcode — index first, product record second", () => {
  it("writes the index BEFORE the product record", async () => {
    const order = [];
    await attachPrintedBarcode({
      productId: "pPerfume", code: OUD_MOOD,
      writeProductField: async () => {
        // By the time the record is written the code must ALREADY resolve.
        order.push(`record:${getPath(`barcodes/${OUD_MOOD}/productId`)}`);
      },
    });
    expect(order).toEqual(["record:pPerfume"]);
  });

  it("never writes the product record when the index REFUSES", async () => {
    await registerPrintedBarcode("pOther", OUD_MOOD);
    const writeProductField = vi.fn();

    const out = await attachPrintedBarcode({ productId: "pMine", code: OUD_MOOD, writeProductField });

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("conflict");
    expect(out.indexed).toBe(false);
    expect(writeProductField).not.toHaveBeenCalled();
    expect(out.reason).toMatch(/already registered to another product/);
    expect(out.reason).toMatch(/Merge Products/);
  });

  it("reports indexed:true when only the RECORD write fails — the row is permanent", async () => {
    // Saying "nothing was changed" here would be false, and would send an
    // operator off to register a code that already resolves.
    const out = await attachPrintedBarcode({
      productId: "pPerfume", code: OUD_MOOD,
      writeProductField: async () => { throw new Error("permission denied"); },
    });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("record_write_failed");
    expect(out.indexed).toBe(true);
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");   // it DID land
  });

  it("reports denied (indexed:false) when nothing could be written at all", async () => {
    const out = await attachPrintedBarcode({
      productId: "pPerfume", code: "not-a-barcode", writeProductField: vi.fn(),
    });
    expect(out.ok).toBe(false);
    expect(out.indexed).toBe(false);
  });

  it("succeeds with no product write at all (the Add Product path)", async () => {
    // The record already carries the field from the product's own set().
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(true);
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
  });
});

describe("registrationRefusalText — one wording for both surfaces", () => {
  it("names the other product and points at Merge for a conflict", () => {
    const text = registrationRefusalText({ kind: "conflict", otherProductId: "pOther" }, OUD_MOOD);
    expect(text).toMatch(/pOther/);
    expect(text).toMatch(/Merge Products/);
  });

  it("says which size the index disagrees on", () => {
    expect(registrationRefusalText({ kind: "size_mismatch", indexedSize: "50ml" }, OUD_MOOD)).toMatch(/50ml/);
  });

  it("quotes the input when it was not a barcode", () => {
    expect(registrationRefusalText({ kind: "invalid" }, "junk")).toMatch(/junk/);
  });

  it("never returns an empty string for an unknown verdict", () => {
    expect(registrationRefusalText(null, OUD_MOOD).length).toBeGreaterThan(0);
    expect(registrationRefusalText({ kind: "who-knows" }, OUD_MOOD).length).toBeGreaterThan(0);
  });
});

describe("a row that is ours but points at the WRONG SIZE", () => {
  it("is NOT reported as already-registered — a scan would hit the wrong cell", async () => {
    setPath(`barcodes/${OUD_MOOD}`, { productId: "pPerfume", size: "50ml" });

    const out = await registerPrintedBarcode("pPerfume", OUD_MOOD);

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("size_mismatch");
    expect(out.indexedSize).toBe("50ml");
    expect(out.written).toEqual([]);
    expect(overwriteAttempts).toEqual([]);
  });

  it("treats an OMITTED size as one-size, matching how the POS reads it", async () => {
    // barcodeIndexRecord omits the size field for unsized items and RTDB drops
    // nulls, so absent must read as "_" — not as a mismatch.
    setPath(`barcodes/${OUD_MOOD}`, { productId: "pPerfume" });
    const out = await registerPrintedBarcode("pPerfume", OUD_MOOD);
    expect(out.kind).toBe("already");
    expect(out.ok).toBe(true);
  });
});

describe("inspection is read-only", () => {
  it("reports a conflict for a product that does not exist yet (create flow)", async () => {
    await registerPrintedBarcode("pFirst", OUD_MOOD);
    const verdict = await inspectPrintedBarcode(OUD_MOOD, null);
    expect(verdict.kind).toBe("conflict");
    expect(verdict.otherProductId).toBe("pFirst");
  });

  it("reads a free slot as unowned, and carries the row's size", async () => {
    expect(await readBarcodeOwners([EPIC])).toEqual([{ code: EPIC, productId: null, size: null }]);
    await registerPrintedBarcode("pPerfume", EPIC);
    expect(await readBarcodeOwners([EPIC])).toEqual([{ code: EPIC, productId: "pPerfume", size: "_" }]);
  });

  it("refuses a code that is not a printed barcode instead of reporting a no-op success", async () => {
    // Previously: indexCodesFor("garbage") → [] → "free" with no codes → the
    // loop wrote nothing and returned ok:true. A silent success for junk.
    const out = await registerPrintedBarcode("pPerfume", "not-a-barcode");
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("invalid");
    expect(out.written).toEqual([]);
  });

  it("refuses to register without a productId", async () => {
    await expect(registerPrintedBarcode(null, OUD_MOOD)).rejects.toThrow(/productId/);
  });
});

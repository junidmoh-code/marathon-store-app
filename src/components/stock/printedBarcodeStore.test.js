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
// Codes claimed by a CONCURRENT client between our inspect and our commit. The
// winner's row lands first, and OUR commit is then rejected by the create-only
// rule — with the same permission error a user without stockRole would get.
// That is what the real database does, and modelling anything softer would be
// testing a scenario that cannot happen.
let raceOnWrite = new Map();
// Makes a /products write fail on its own — the offline / permission case for
// the ALREADY backfill, which is the one branch that is not a single commit.
let failProductWrites = false;
// Makes every READ fail — the connection is down. Distinct from a refusal.
let failReads = false;

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
  get: async (node) => {
    if (failReads) throw new Error("network unreachable");
    return { val: () => getPath(node.path), exists: () => getPath(node.path) != null };
  },
  // ── THE RULES, ENFORCED — AND ATOMICALLY ────────────────────────────────
  // RTDB multi-path update() is ALL-OR-NOTHING and evaluates each path's rules
  // independently. This fake reproduces both: every path is validated first
  // (create-only on /barcodes, plus the injectable denials) and the tree is
  // only mutated once every path has passed. A fake that applied writes as it
  // went would let a half-committed pair pass tests that the real database
  // would never produce.
  update: async (node, updates) => {
    const base = node.path ? `${node.path}/` : "";
    const paths = Object.entries(updates).map(([k, v]) => [`${base}${k}`, v]);
    // A concurrent claim lands BEFORE our commit is evaluated — which is what
    // makes the create-only rule reject us, exactly as the real database does.
    for (const [path] of paths) {
      const winner = raceOnWrite.get(path.split("/").pop());
      if (path.startsWith("barcodes/") && winner) setPath(path, { productId: winner, size: "_" });
    }
    for (const [path, value] of paths) {
      if (!path.startsWith("barcodes/")) {                   // /products is a plain write
        if (failProductWrites) throw new Error("PERMISSION_DENIED: /products write failed");
        continue;
      }
      if (getPath(path) != null) {
        overwriteAttempts.push(path);
        throw new Error("PERMISSION_DENIED: /barcodes is create-only");
      }
      const code = path.split("/").pop();
      if (denyWrites.has(code)) throw new Error("PERMISSION_DENIED: claimed in the meantime");
      // THE .validate, ENFORCED: the referenced product must already exist, and
      // size must be a non-empty string. This is what makes the ordering
      // requirement — product write BEFORE registration — a thing these tests
      // actually prove rather than merely describe. (Codex review, PR #340.)
      if (!value || typeof value.productId !== "string" || getPath(`products/${value.productId}`) == null) {
        throw new Error("PERMISSION_DENIED: /barcodes .validate — referenced product does not exist");
      }
      if (value.size != null && (typeof value.size !== "string" || value.size.length === 0)) {
        throw new Error("PERMISSION_DENIED: /barcodes .validate — size must be a non-empty string");
      }
    }
    for (const [path, value] of paths) setPath(path, value);
  },
}));
vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => "2026-08-10T00:00:00.000Z" }));

const { registerPrintedBarcode, inspectPrintedBarcode, readBarcodeOwners, attachPrintedBarcode, registrationRefusalText, labelIsRedundant } =
  await import("./printedBarcodeStore");

const OUD_MOOD = "6291106065114";
const EPIC = "6291103660466";

beforeEach(() => {
  store = {};
  overwriteAttempts = [];
  denyWrites = new Set();
  raceOnWrite = new Map();
  failProductWrites = false;
  failReads = false;
  // The products these tests register against must EXIST — the live .validate
  // on /barcodes/$code requires it, and the fake above enforces it.
  setPath("products/pPerfume", { id: "pPerfume", name: "Oud Mood" });
  setPath("products/pOther", { id: "pOther", name: "Honeyed Fantasy" });
  setPath("products/pFirst", { id: "pFirst", name: "Epic" });
  setPath("products/pSecond", { id: "pSecond", name: "Another" });
  setPath("products/pMine", { id: "pMine", name: "Mine" });
  setPath("products/pSomebodyElse", { id: "pSomebodyElse", name: "Theirs" });
});

describe("a code with print separators is normalised, not half-accepted", () => {
  const SPACED = "6291 1060 65114";

  it("registers the BARE DIGITS, and the product field matches the index key", async () => {
    // The gate normalises, but the index lookup used the RAW string — so a
    // separated code passed validation and produced NO index keys: a FREE
    // verdict with an empty list, a commit that wrote only the product field,
    // and ok:true for a registration that registered nothing.
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: SPACED });

    expect(out.ok).toBe(true);
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
    expect(getPath("products/pPerfume/printedBarcode")).toBe(OUD_MOOD);
    // The separated spelling must never become a key or a stored value.
    expect(getPath(`barcodes/${SPACED}`)).toBe(null);
  });

  it("inspects a separated code against the row its digits own", async () => {
    await registerPrintedBarcode("pOther", OUD_MOOD);
    const verdict = await inspectPrintedBarcode(SPACED, "pPerfume");
    expect(verdict.kind).toBe("conflict");
    expect(verdict.otherProductId).toBe("pOther");
  });

  it("still refuses a code that normalises to nothing usable", async () => {
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: "62 91-10" });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("invalid");
    expect(getPath("products/pPerfume/printedBarcode")).toBe(null);
  });
});

describe("the product must exist before its barcode can be registered", () => {
  it("REFUSES to register against a product that has not been written yet", async () => {
    // The live rule validates
    //   root.child('products').child(newData.child('productId').val()).exists()
    // so registration must run AFTER the product write, never before. This is
    // the same ordering constraint the style-code claim already lives under.
    await expect(registerPrintedBarcode("pDoesNotExist", OUD_MOOD)).rejects.toThrow(/does not exist/);
    expect(getPath(`barcodes/${OUD_MOOD}`)).toBe(null);
  });
});

describe("losing the read→write race is DIAGNOSED, not misreported", () => {
  it("is reported as a CONFLICT, not as a permission problem", async () => {
    // Another client claims the code between our inspect and our commit. The
    // create-only rule then rejects us with the SAME permission error a user
    // without stockRole gets — same failure, two completely different
    // remedies. Calling it a denial sends the operator to ask an admin for
    // permissions when what they actually have is a duplicate to merge.
    raceOnWrite.set(OUD_MOOD, "pSomebodyElse");

    const out = await registerPrintedBarcode("pPerfume", OUD_MOOD);

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("conflict");
    expect(out.otherProductId).toBe("pSomebodyElse");
    expect(out.written).toEqual([]);
  });

  it("routes it to the duplicate flow, naming the winner", async () => {
    raceOnWrite.set(OUD_MOOD, "pSomebodyElse");
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("conflict");
    expect(out.indexed).toBe(false);
    expect(out.reason).toMatch(/already registered to another product/);
    expect(out.reason).toMatch(/Merge Products/);
    expect(getPath("products/pPerfume/printedBarcode")).toBe(null);
  });

  it("an UNREACHABLE index is not reported as a permission problem", async () => {
    // Telling an operator they lack stock permission when the connection
    // dropped sends them to ask an admin for something they already have.
    // Retry versus get-permission are different instructions.
    // (CodeRabbit, PR #340.)
    failReads = true;
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("unavailable");
    expect(out.indexed).toBe(false);
    expect(out.reason).toMatch(/could not be reached/i);
    expect(out.reason).toMatch(/nothing was changed/i);
  });

  it("a GENUINE denial still reports as denied — the two are not collapsed", async () => {
    // No concurrent claim, just no permission. This must NOT be dressed up as
    // a duplicate: App.jsx shows the stock-permission message off this kind.
    denyWrites.add(OUD_MOOD);
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("denied");
  });
});

describe("a UPC-A registers ATOMICALLY — both forms or neither", () => {
  it("leaves NEITHER form written when one of them is denied", async () => {
    // Writing the two rows one at a time meant the second could be refused
    // after the first had landed, leaving ONE spelling of a number registered
    // and the other free for a different product to claim — the same physical
    // barcode resolving to two products depending on the reader.
    // (CodeRabbit, PR #340.)
    denyWrites.add("0036000291452");

    await expect(registerPrintedBarcode("pPerfume", "036000291452")).rejects.toThrow(/PERMISSION_DENIED/);

    expect(getPath("barcodes/036000291452")).toBe(null);
    expect(getPath("barcodes/0036000291452")).toBe(null);
  });

  it("throws when nothing landed, so the caller knows to fall back", async () => {
    denyWrites.add("036000291452");
    await expect(registerPrintedBarcode("pPerfume", "036000291452")).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("commits both forms together on the happy path", async () => {
    const out = await registerPrintedBarcode("pPerfume", "036000291452");
    expect(out.ok).toBe(true);
    expect(out.written).toEqual(["036000291452", "0036000291452"]);
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
describe("attachPrintedBarcode — the record and the index land TOGETHER", () => {
  it("commits the product field in the SAME update as the index rows", async () => {
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(true);
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
    expect(store.products.pPerfume.printedBarcode).toBe(OUD_MOOD);
  });

  it("leaves the product field UNSET when the index refuses", async () => {
    // The record must never claim a code that does not resolve — previously a
    // second write plus a compensating removal that could itself fail.
    await registerPrintedBarcode("pOther", OUD_MOOD);

    const out = await attachPrintedBarcode({ productId: "pMine", code: OUD_MOOD });

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("conflict");
    expect(out.indexed).toBe(false);
    expect(getPath("products/pMine/printedBarcode")).toBe(null);
    expect(out.reason).toMatch(/already registered to another product/);
    expect(out.reason).toMatch(/Merge Products/);
  });

  it("leaves the product field UNSET when the whole commit is denied", async () => {
    denyWrites.add(OUD_MOOD);
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("denied");
    expect(out.indexed).toBe(false);
    expect(getPath("products/pPerfume/printedBarcode")).toBe(null);
    expect(getPath(`barcodes/${OUD_MOOD}`)).toBe(null);
  });

  it("refuses a code that is not a barcode as INVALID, not denied", async () => {
    // App.jsx branches on kind === "denied" to show the stock-permission
    // message. "not a barcode" is a different problem with a different fix, so
    // the two must not collapse into one. (CodeRabbit, PR #340.)
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: "not-a-barcode" });
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("invalid");
    expect(out.indexed).toBe(false);
    expect(getPath("products/pPerfume/printedBarcode")).toBe(null);
  });

  it("backfills the product field when the rows were ALREADY ours", async () => {
    // The index commit does not run in this case, so the field would otherwise
    // stay missing forever on a product whose code does resolve.
    setPath(`barcodes/${OUD_MOOD}`, { productId: "pPerfume", size: "_" });
    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("already");
    expect(getPath("products/pPerfume/printedBarcode")).toBe(OUD_MOOD);
  });

  it("reports indexed:true when only the BACKFILL write fails", async () => {
    // The one branch that is not a single commit: the rows were already ours,
    // so only the record field needs writing, and that write can fail on its
    // own. The code still resolves — reporting a total failure would mint a
    // shop label the box does not need. (Kimi review, PR #340.)
    setPath(`barcodes/${OUD_MOOD}`, { productId: "pPerfume", size: "_" });
    failProductWrites = true;

    const out = await attachPrintedBarcode({ productId: "pPerfume", code: OUD_MOOD });

    expect(out.ok).toBe(false);
    expect(out.kind).toBe("record_write_failed");
    expect(out.indexed).toBe(true);                 // the box still scans
    expect(store.barcodes[OUD_MOOD].productId).toBe("pPerfume");
  });
});

// ─── THE LABEL DECISION, AS BEHAVIOUR ────────────────────────────────────────
// This was an inline boolean guarded only by a source-text pin, which cannot
// exercise loading, rejection, staleness or a product change — and both
// reviewers said so. It is a pure function now, and every state it can be in is
// tested. Erring toward OFFERING a label is deliberate: a redundant sticker is
// waste, a missing one is stock nobody can scan.
describe("labelIsRedundant — a label is skipped only on CONFIRMED evidence", () => {
  const confirmed = { code: OUD_MOOD, status: "confirmed" };

  it("skips the label when the index confirmed THIS code", () => {
    expect(labelIsRedundant(OUD_MOOD, confirmed)).toBe(true);
  });

  it("offers a label while the check has not resolved yet", () => {
    expect(labelIsRedundant(OUD_MOOD, { code: OUD_MOOD, status: "unknown" })).toBe(false);
  });

  it("offers a label when the check WARNED (missing / wrong product / wrong size)", () => {
    expect(labelIsRedundant(OUD_MOOD, { code: OUD_MOOD, status: "warned" })).toBe(false);
  });

  it("offers a label when the check FAILED — a failed read is not evidence", () => {
    // A read error leaves the status where it started.
    expect(labelIsRedundant(OUD_MOOD, { code: OUD_MOOD, status: "unknown" })).toBe(false);
    expect(labelIsRedundant(OUD_MOOD, null)).toBe(false);
    expect(labelIsRedundant(OUD_MOOD, undefined)).toBe(false);
  });

  it("REFUSES a confirmation that belongs to a DIFFERENT code", () => {
    // The dangerous direction: a status computed for the previously-open
    // product surviving one render into the next one.
    expect(labelIsRedundant(EPIC, confirmed)).toBe(false);
    expect(labelIsRedundant(OUD_MOOD, { code: EPIC, status: "confirmed" })).toBe(false);
  });

  it("always offers a label when there is no captured code at all", () => {
    expect(labelIsRedundant(null, confirmed)).toBe(false);
    expect(labelIsRedundant("", confirmed)).toBe(false);
    expect(labelIsRedundant(undefined, { code: undefined, status: "confirmed" })).toBe(false);
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

  it("inspectPrintedBarcode itself reports INVALID — the first of two guards", async () => {
    // The behaviour is guarded twice (here, and again by the empty-codes check
    // in registerPrintedBarcode), which is deliberate defence in depth — but it
    // means neither guard alone can be mutation-proven through the composite.
    // So this asserts the unit's own contract directly.
    const verdict = await inspectPrintedBarcode("not-a-barcode", "pPerfume");
    expect(verdict.kind).toBe("invalid");
    expect(verdict.indexCodes).toEqual([]);
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

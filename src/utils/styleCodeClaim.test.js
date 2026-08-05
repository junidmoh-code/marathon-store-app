// ─── CLAIM-FIRST UNIQUENESS ──────────────────────────────────────────────────
// The behaviour under test is the whole reason this module exists: two staff
// scanning the SAME shoe on two tablets must not both end up creating a
// product. A check-then-write ("does any product have this code? no? create
// one") has a window between the read and the write, and two writers can both
// pass the check. The RTDB create-once rule closes it — the database arbitrates.
//
// The fake below models the rule that matters: a write to an OCCUPIED key is
// REJECTED, exactly as the deployed rule does. If the production code ever goes
// back to reading-then-writing, the concurrency test here fails.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── An in-memory RTDB enforcing create-once on /style_code_index ─────────────
let store = {};
let denyWrites = false;   // simulates a user with no stockRole
let denyReads = false;

function nodeAt(path) {
  let node = store;
  for (const part of String(path).split("/").filter(Boolean)) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  get: async (r) => {
    if (denyReads) throw new Error("PERMISSION_DENIED: read");
    const v = nodeAt(r.path);
    return { exists: () => v !== undefined && v !== null, val: () => (v === undefined ? null : v) };
  },
  set: async (r, value) => {
    if (denyWrites) throw new Error("PERMISSION_DENIED: no stockRole");
    // THE RULE: create-once. An occupied key rejects the write.
    if (nodeAt(r.path) !== undefined && nodeAt(r.path) !== null) {
      throw new Error("PERMISSION_DENIED: create-once");
    }
    // THE RULE the outage came from: the claim's productId must already exist
    // under /products. root.child('products').child(productId).exists()
    if (String(r.path).startsWith("style_code_index/") && value && value.productId) {
      if (!nodeAt(`products/${value.productId}`)) {
        throw new Error("PERMISSION_DENIED: validate — product does not exist");
      }
    }
    const parts = String(r.path).split("/").filter(Boolean);
    const last = parts.pop();
    let node = store;
    for (const p of parts) { if (node[p] == null) node[p] = {}; node = node[p]; }
    node[last] = value;
  },
}));
vi.mock("../firebase", () => ({ database: { fake: true } }));

const { claimStyleCode, readStyleCodeClaim, buildClaim, claimFailureMessage, CLAIM_OK, CLAIM_TAKEN, CLAIM_FAILED } =
  await import("./styleCodeClaim.js");

beforeEach(() => {
  // The live rule requires the claimed product to EXIST, so every test that
  // expects a successful claim must have written its product first — exactly as
  // addProduct now does. The fake enforcing this is the point: the previous
  // version was more permissive than production, which is how a claim ordering
  // that could never work in the real database passed its whole test suite.
  store = { products: Object.fromEntries(
    ["p1", "p2", "p3", "pA", "pB", "pWinner", "pLoser", "pREAL"].map((id) => [id, { id }]),
  ) };
  denyWrites = false; denyReads = false;
});

const NOW = 1754300000000;

describe("buildClaim — EXACTLY the three permitted fields", () => {
  it("writes productId, claimedAt and claimedBy, and nothing else", () => {
    // "No other child keys are permitted" — an extra field fails the write, and
    // a failed write here is indistinguishable from "someone else owns this
    // code", which would be a maddening bug to chase.
    expect(Object.keys(buildClaim({ productId: "p1", uid: "u1", nowMs: NOW })).sort())
      .toEqual(["claimedAt", "claimedBy", "productId"]);
  });

  it("omits claimedBy rather than writing null when there is no uid", () => {
    const c = buildClaim({ productId: "p1", uid: null, nowMs: NOW });
    expect("claimedBy" in c).toBe(false);
    expect(c).toEqual({ productId: "p1", claimedAt: NOW });
  });

  it("coerces types the rules validate", () => {
    const c = buildClaim({ productId: 7, uid: 9, nowMs: "123" });
    expect(typeof c.productId).toBe("string");
    expect(typeof c.claimedBy).toBe("string");
    expect(typeof c.claimedAt).toBe("number");
  });
});

describe("claiming", () => {
  it("an unclaimed code is claimed, keyed on the NORMALISED form", async () => {
    const out = await claimStyleCode("CT8527-016", { productId: "p1", uid: "u1", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_OK);
    expect(out.normalised).toBe("CT8527016");
    expect(store.style_code_index.CT8527016).toEqual({ productId: "p1", claimedAt: NOW, claimedBy: "u1" });
  });

  it("every spelling of one code claims the SAME slot", async () => {
    await claimStyleCode("ct8527 016", { productId: "p1", uid: "u1", nowMs: NOW });
    const second = await claimStyleCode("CT8527-016", { productId: "p2", uid: "u2", nowMs: NOW });
    expect(second.kind).toBe(CLAIM_TAKEN);
    expect(second.productId).toBe("p1");
  });

  // ── THE RACE ──────────────────────────────────────────────────────────────
  it("TWO TABLETS, ONE SHOE: exactly one claim wins", async () => {
    const [a, b] = await Promise.all([
      claimStyleCode("CT8527-016", { productId: "pA", uid: "uA", nowMs: NOW }),
      claimStyleCode("CT8527-016", { productId: "pB", uid: "uB", nowMs: NOW }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual([CLAIM_OK, CLAIM_TAKEN].sort());

    // The loser is told WHO won, so it can route to add-stock on that product
    // instead of creating a second record for the same shoe.
    const loser = a.kind === CLAIM_TAKEN ? a : b;
    const winner = a.kind === CLAIM_OK ? a : b;
    expect(loser.productId).toBe(store.style_code_index.CT8527016.productId);
    expect(winner.kind).toBe(CLAIM_OK);
    expect(Object.keys(store.style_code_index)).toHaveLength(1);
  });

  it("THE GATE: sibling colorways claim separate slots and never collide", async () => {
    const a = await claimStyleCode("CT8527-016", { productId: "pA", uid: "u", nowMs: NOW });
    const b = await claimStyleCode("CT8527-700", { productId: "pB", uid: "u", nowMs: NOW });
    expect(a.kind).toBe(CLAIM_OK);
    expect(b.kind).toBe(CLAIM_OK);
    expect(Object.keys(store.style_code_index).sort()).toEqual(["CT8527016", "CT8527700"]);
  });

  it("an empty code fails rather than claiming an empty key", async () => {
    const out = await claimStyleCode("---", { productId: "p1", uid: "u1", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_FAILED);
    expect(store.style_code_index).toBeUndefined();
  });
});

// ── "Taken" and "failed" must never be confused ──────────────────────────────
// Telling a staff member "that shoe already exists" when the real problem is
// their permissions sends them hunting for a product that isn't there.
describe("a denied write is diagnosed, not guessed at", () => {
  it("denied + nothing in the index = a PERMISSION problem, not a collision", async () => {
    denyWrites = true;
    const out = await claimStyleCode("CT8527-016", { productId: "p1", uid: "u1", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_FAILED);
    expect(claimFailureMessage(out)).toMatch(/stock permission/i);
    expect(claimFailureMessage(out)).toMatch(/Nothing was saved/i);
  });

  it("denied + a readable owner = genuinely taken", async () => {
    await claimStyleCode("CT8527-016", { productId: "pWinner", uid: "u1", nowMs: NOW });
    const out = await claimStyleCode("CT8527-016", { productId: "pLoser", uid: "u2", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_TAKEN);
    expect(out.productId).toBe("pWinner");
    expect(out.readable).toBe(true);
    expect(claimFailureMessage(out)).toMatch(/Add stock to that product/i);
  });

  it("denied + unreadable index = taken, but says so honestly", async () => {
    await claimStyleCode("CT8527-016", { productId: "pWinner", uid: "u1", nowMs: NOW });
    denyReads = true;
    const out = await claimStyleCode("CT8527-016", { productId: "pLoser", uid: "u2", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_TAKEN);
    expect(out.productId).toBeNull();
    expect(out.readable).toBe(false);
    expect(claimFailureMessage(out)).toMatch(/could not be read/i);
  });

  it("a claim is never reported as won when the write did not land", async () => {
    denyWrites = true;
    const out = await claimStyleCode("IE3437", { productId: "p1", uid: "u1", nowMs: NOW });
    expect(out.kind).not.toBe(CLAIM_OK);
  });
});

describe("readStyleCodeClaim", () => {
  it("reads an existing claim", async () => {
    await claimStyleCode("IE3437", { productId: "p3", uid: "u1", nowMs: NOW });
    expect(await readStyleCodeClaim("ie 3437")).toEqual({ productId: "p3", claimedAt: NOW, claimedBy: "u1" });
  });

  it("returns null for unclaimed, unusable, or unreadable — never throws", async () => {
    expect(await readStyleCodeClaim("CT8527-016")).toBeNull();
    expect(await readStyleCodeClaim("")).toBeNull();
    denyReads = true;
    expect(await readStyleCodeClaim("IE3437")).toBeNull();
  });

  it("ignores a malformed row rather than trusting it", async () => {
    store.style_code_index = { IE3437: { claimedAt: 1 } };
    expect(await readStyleCodeClaim("IE3437")).toBeNull();
  });
});

// ─── THE LIVE RULE REQUIRES THE PRODUCT TO EXIST FIRST ───────────────────────
// The deployed /style_code_index/$code rule validates:
//     root.child('products').child(newData.child('productId').val()).exists()
// so a claim for a product that has not been written yet is REJECTED. The
// original code claimed BEFORE creating the product, which meant every save
// carrying a style code was denied and staff could not add products at all.
//
// Claim-first was the safer shape — the database arbitrated the race — but the
// deployed rule makes it impossible, and the rule wins. These pin the ordering
// requirement so it cannot silently regress.
describe("the claim requires an EXISTING product (live rule)", () => {
  it("a claim for a product that does not exist is refused", async () => {
    // The fake enforces the same validate the live rule does.
    const out = await claimStyleCode("CT8527-016", { productId: "pGHOST", uid: "u1", nowMs: NOW });
    expect(out.kind).not.toBe(CLAIM_OK);
  });

  it("the same claim succeeds once the product exists", async () => {
    const out = await claimStyleCode("CT8527-016", { productId: "pREAL", uid: "u1", nowMs: NOW });
    expect(out.kind).toBe(CLAIM_OK);
    expect(store.style_code_index.CT8527016.productId).toBe("pREAL");
  });

  it("claimedAt must be a positive number within the server's future window", () => {
    // The rule: newData.isNumber() && > 0 && <= now + 86400000. A device clock
    // running more than a day fast produces a REJECTED write.
    const c = buildClaim({ productId: "pREAL", uid: "u1", nowMs: NOW });
    expect(typeof c.claimedAt).toBe("number");
    expect(c.claimedAt).toBeGreaterThan(0);
    expect(c.claimedAt).toBeLessThanOrEqual(Date.now() + 86400000);
  });
});

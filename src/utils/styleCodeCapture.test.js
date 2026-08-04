// ─── STYLE CODE CAPTURE (client) — ENQUEUE ONLY, AND THE PROGRESS COUNT ──────
// The client's whole job is to enqueue an observation. Two things must hold:
//   1. It writes EXACTLY the fields the rules permit — never a `status`, which
//      the rules reserve for admins. A stray key fails the write, and a failed
//      write looks, from a shop floor, like a button that simply does nothing.
//   2. It never writes to /products. Nothing in this module may touch a
//      product's name, image or category; that is the server's decision to make
//      and even the server only writes the CODE.

import { describe, it, expect, beforeEach, vi } from "vitest";

let store = {};
let pushN = 0;
let denyWrites = false;
let uploads = [];
let uploadFails = false;

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  push: (r) => ({ path: `${r.path}/cap${++pushN}`, key: `cap${pushN}` }),
  set: async (r, value) => {
    if (denyWrites) throw new Error("PERMISSION_DENIED");
    const parts = String(r.path).split("/").filter(Boolean);
    const last = parts.pop();
    let node = store;
    for (const p of parts) { if (node[p] == null) node[p] = {}; node = node[p]; }
    node[last] = value;
  },
}));
vi.mock("firebase/storage", () => ({
  ref: (_s, path) => ({ path }),
  uploadBytes: async (r) => { if (uploadFails) throw new Error("storage down"); uploads.push(r.path); },
  getDownloadURL: async (r) => `https://storage.example/${r.path}`,
}));
vi.mock("../firebase", () => ({ database: { fake: true }, storage: { fake: true } }));

const { buildCapture, enqueueStyleCodeCapture, styleCodeProgress, styleCodeProgressForFootwear, CAPTURES_PATH } =
  await import("./styleCodeCapture.js");

beforeEach(() => { store = {}; pushN = 0; denyWrites = false; uploads = []; uploadFails = false; });

const NOW = 1754300000000;
const args = (over = {}) => ({
  code: "CT8527-016", productId: "p1", uid: "u1", origin: "displayCheck", nowMs: NOW, ...over,
});

describe("buildCapture — exactly the permitted fields", () => {
  it("NEVER includes status — the rules reserve it for admins", () => {
    const rec = buildCapture({ normalised: "CT8527016", productId: "p1", uid: "u1", nowMs: NOW, origin: "displayCheck" });
    expect("status" in rec).toBe(false);
    expect("review" in rec).toBe(false);
  });

  it("carries the four required fields", () => {
    const rec = buildCapture({ normalised: "CT8527016", productId: "p1", uid: "u1", nowMs: NOW, origin: "displayCheck" });
    expect(rec.styleCodeNormalised).toBe("CT8527016");
    expect(rec.capturedBy).toBe("u1");
    expect(rec.capturedAt).toBe(NOW);
    expect(rec.origin).toBe("displayCheck");
  });

  it("drops a labelPhotoUrl that is not https — it would fail the whole write", () => {
    for (const bad of ["blob:http://x", "data:image/jpeg;base64,AAA", "http://insecure/x.jpg", null, 42]) {
      const rec = buildCapture({ normalised: "IE3437", productId: "p1", uid: "u1", nowMs: NOW, origin: "admin", labelPhotoUrl: bad });
      expect("labelPhotoUrl" in rec).toBe(false);
    }
    const good = buildCapture({ normalised: "IE3437", productId: "p1", uid: "u1", nowMs: NOW, origin: "admin", labelPhotoUrl: "https://s/x.jpg" });
    expect(good.labelPhotoUrl).toBe("https://s/x.jpg");
  });
});

describe("enqueueStyleCodeCapture", () => {
  it("writes one capture keyed on the normalised code, and NOTHING to /products", async () => {
    const res = await enqueueStyleCodeCapture(args());
    expect(res.ok).toBe(true);
    expect(res.normalised).toBe("CT8527016");
    expect(store[CAPTURES_PATH].cap1.styleCodeNormalised).toBe("CT8527016");
    expect(store[CAPTURES_PATH].cap1.productId).toBe("p1");
    // THE GUARANTEE at the client boundary.
    expect(store.products).toBeUndefined();
  });

  it("uploads the label photo under the product it belongs to", async () => {
    await enqueueStyleCodeCapture(args({ labelPhoto: { blob: new Blob(["x"]) } }));
    expect(uploads).toEqual(["products/p1/labels/cap1.jpg"]);
    expect(store[CAPTURES_PATH].cap1.labelPhotoUrl).toBe("https://storage.example/products/p1/labels/cap1.jpg");
  });

  it("a failed photo upload does NOT cost us the capture — the code is the point", async () => {
    uploadFails = true;
    const res = await enqueueStyleCodeCapture(args({ labelPhoto: { blob: new Blob(["x"]) } }));
    expect(res.ok).toBe(true);
    expect(store[CAPTURES_PATH].cap1.styleCodeNormalised).toBe("CT8527016");
    expect("labelPhotoUrl" in store[CAPTURES_PATH].cap1).toBe(false);
  });

  it("refuses bad input before writing anything", async () => {
    for (const bad of [args({ code: "---" }), args({ productId: null }), args({ uid: null }), args({ origin: "nope" })]) {
      const res = await enqueueStyleCodeCapture(bad);
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    }
    expect(store[CAPTURES_PATH]).toBeUndefined();
  });

  it("a denied write reports a permission problem in words a person can act on", async () => {
    denyWrites = true;
    const res = await enqueueStyleCodeCapture(args());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/i);
    expect(res.error).toMatch(/Nothing was saved/i);
  });

  it("every spelling of a code enqueues the same normalised key", async () => {
    await enqueueStyleCodeCapture(args({ code: "ct8527 016" }));
    expect(store[CAPTURES_PATH].cap1.styleCodeNormalised).toBe("CT8527016");
    expect(store[CAPTURES_PATH].cap1.styleCode).toBe("ct8527 016");
  });
});

// ── Progress ─────────────────────────────────────────────────────────────────
describe("styleCodeProgress", () => {
  const P = (over = {}) => ({ id: "x", productType: "sneaker", ...over });

  it("counts products carrying a code, minus those awaiting review", () => {
    const out = styleCodeProgress([
      P({ id: "a", styleCodeNormalised: "CT8527016" }),
      P({ id: "b", styleCodeNormalised: "CT8527700" }),
      P({ id: "c", styleCodeNormalised: "IE3437", pendingStyleCode: { status: "needsReview" } }),
      P({ id: "d" }),
    ]);
    expect(out.total).toBe(4);
    expect(out.withCode).toBe(3);
    expect(out.needsReview).toBe(1);
    expect(out.confirmed).toBe(2);
    expect(out.pct).toBe(50);
  });

  it("autoConfirmed pending data still counts as confirmed — the CODE is settled", () => {
    const out = styleCodeProgress([
      P({ id: "a", styleCodeNormalised: "CT8527016", pendingStyleCode: { status: "autoConfirmed", suggestedName: "Nike Dunk" } }),
    ]);
    expect(out.confirmed).toBe(1);
  });

  it("a suggestion alone never counts — a code must actually be stamped", () => {
    const out = styleCodeProgress([P({ id: "a", pendingStyleCode: { status: "autoConfirmed", suggestedName: "Nike Dunk" } })]);
    expect(out.withCode).toBe(0);
    expect(out.confirmed).toBe(0);
  });

  it("handles an empty or junk catalogue without dividing by zero", () => {
    for (const input of [[], null, undefined, [null, undefined]]) {
      const out = styleCodeProgress(input);
      expect(out.pct).toBe(0);
      expect(out.confirmed).toBe(0);
    }
  });

  it("never reports a negative confirmed count", () => {
    // Defensive: more review flags than stamped codes must not go below zero.
    const out = styleCodeProgress([
      P({ id: "a", pendingStyleCode: { status: "needsReview" } }),
      P({ id: "b", pendingStyleCode: { status: "needsReview" } }),
    ]);
    expect(out.confirmed).toBe(0);
  });

  it("footwear-only progress ignores clothing, which has no style code", () => {
    const out = styleCodeProgressForFootwear([
      { id: "a", productType: "sneaker", styleCodeNormalised: "CT8527016" },
      { id: "b", productType: "clothing" },
      { id: "c", category: "Footwear" },
    ]);
    expect(out.total).toBe(2);
    expect(out.confirmed).toBe(1);
    expect(out.pct).toBe(50);
  });
});

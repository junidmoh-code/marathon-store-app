// The one-off re-point of New items stuck on an old product photo: corrects
// only what is wrong, records what it was, prints the count, and can be undone.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { run, correction, undo, FIX_ID } from "./repointStalePhotos.mjs";

const { makeFakeDb } = createRequire(import.meta.url)("../../functions/test/helpers/fake-rtdb.cjs");
const staff = (pid, token) => `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${pid}%2Fphoto.jpg?alt=media&token=${token}`;
const A = "p1790000000001", B = "p1790000000002", C = "p1790000000003", D = "p1790000000004", E = "p1790000000005";
const GEN = `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${D}%2Fnew_arrivals%2Fgen_1.jpg?alt=media&token=g`;
const world = () => makeFakeDb({
  products: {
    [A]: { photoUrl: staff(A, "new") },                                   // re-shot since: STALE
    [B]: { photoUrl: staff(B, "same") },                                  // unchanged
    [C]: { photoUrl: staff(C, "new") },                                   // stale, in the rejected lane
    [D]: { photoUrl: GEN, photoUrlOriginal: staff(D, "kept") },           // an approved generated photo: its source is the kept original
    [E]: { photoUrl: staff(E, "new") },                                   // stale but already APPROVED: not on the New tab
  },
  new_arrivals: {
    items: {
      [A]: { pid: A, status: "new", originalUrl: staff(A, "old"), generations: { g1: { url: "https://x/a-g1.jpg", at: 10 }, g2: { url: "https://x/a-g2.jpg", at: 20, sourceUrl: "https://x/already-recorded.jpg" } } },
      [B]: { pid: B, status: "ready", originalUrl: staff(B, "same"), generatedUrl: "https://x/b-gen.jpg" },
      [C]: { pid: C, status: "rejected", originalUrl: staff(C, "old") },
      [D]: { pid: D, status: "ready", originalUrl: staff(D, "kept"), generatedUrl: GEN },
      [E]: { pid: E, status: "approved", originalUrl: staff(E, "old"), generatedUrl: "https://x/e-gen.jpg" },
    },
    by_status: { new: { [A]: 1 }, ready: { [B]: 1, [D]: 1 }, rejected: { [C]: 1 }, approved: { [E]: 1 } },
  },
});
const read = async (db, p) => (await db.ref(p).once()).val();

describe("re-point stuck New items at the product's current photo", () => {
  it("correction(): only a copy that differs from the current source; an item with no copy needs nothing", () => {
    expect(correction(A, staff(A, "old"), { photoUrl: staff(A, "new") })).toEqual({ was: staff(A, "old"), now: staff(A, "new") });
    expect(correction(B, staff(B, "same"), { photoUrl: staff(B, "same") })).toBeNull();
    expect(correction(A, null, { photoUrl: staff(A, "new") })).toBeNull();
    expect(correction(A, staff(A, "old"), {})).toBeNull();          // the product has no photo: nothing to point at
    expect(correction(D, staff(D, "kept"), { photoUrl: GEN, photoUrlOriginal: staff(D, "kept") })).toBeNull();
  });

  it("a dry run counts and writes NOTHING", async () => {
    const db = world();
    const out = await run({ db, dryRun: true });
    expect(out).toMatchObject({ checked: 4, corrected: 2, photosMarked: 1, reshot: 2 });
    expect(await read(db, `new_arrivals/items/${A}/generations/g1/sourceUrl`)).toBeNull();
    expect(await read(db, `new_arrivals/items/${A}/originalUrl`)).toBe(staff(A, "old"));
    expect(await read(db, `new_arrivals/fixes`)).toBeNull();
  });

  it("corrects exactly the stale New-tab items, records what each was, and touches nothing else", async () => {
    const db = world();
    const out = await run({ db, now: () => 777 });
    expect(out.corrected).toBe(2);
    expect(out.pids.sort()).toEqual([A, C]);
    expect(await read(db, `new_arrivals/items/${A}/originalUrl`)).toBe(staff(A, "new"));
    expect(await read(db, `new_arrivals/items/${C}/originalUrl`)).toBe(staff(C, "new"));
    expect(await read(db, `new_arrivals/fixes/${FIX_ID}/${A}`)).toEqual({ was: staff(A, "old"), now: staff(A, "new"), at: 777, lane: "new", stamped: ["g1"] });
    // The photos ALREADY generated for it were made from the old copy: each says so now (so the card flags
    // them and Approve waits for a Regenerate). One that already recorded its source is left as it is.
    expect(await read(db, `new_arrivals/items/${A}/generations/g1/sourceUrl`)).toBe(staff(A, "old"));
    expect(await read(db, `new_arrivals/items/${A}/generations/g2/sourceUrl`)).toBe("https://x/already-recorded.jpg");
    expect(out.photosMarked).toBe(1);
    expect(out.reshot).toBe(2);
    // Untouched: the unchanged item, the approved-generated one, the already-approved one, every generated photo, every product.
    expect(await read(db, `new_arrivals/items/${B}`)).toEqual({ pid: B, status: "ready", originalUrl: staff(B, "same"), generatedUrl: "https://x/b-gen.jpg" });
    expect(await read(db, `new_arrivals/items/${D}/originalUrl`)).toBe(staff(D, "kept"));
    expect(await read(db, `new_arrivals/items/${E}/originalUrl`)).toBe(staff(E, "old"));
    expect(await read(db, `new_arrivals/items/${E}/generatedUrl`)).toBe("https://x/e-gen.jpg");
    expect(await read(db, `products/${A}`)).toEqual({ photoUrl: staff(A, "new") });
    // A second run finds nothing left to do.
    expect((await run({ db })).corrected).toBe(0);
    // Re-shot AGAIN, run again: the record still remembers what the item FIRST pointed at (so --revert goes all the way back).
    await db.ref(`products/${A}/photoUrl`).set(staff(A, "newer"));
    expect((await run({ db, now: () => 999 })).corrected).toBe(1);
    expect(await read(db, `new_arrivals/fixes/${FIX_ID}/${A}`)).toEqual({ was: staff(A, "old"), now: staff(A, "newer"), at: 999, firstAt: 777, lane: "new", stamped: ["g1"] });
  });

  it("--revert puts every corrected copy back — except one that changed since, which is left alone and named", async () => {
    const db = world();
    await run({ db, now: () => 777 });
    await db.ref(`new_arrivals/items/${C}/originalUrl`).set("https://x/changed-by-hand.jpg");
    const out = await run({ db, revert: true, now: () => 888 });
    expect(out.reverted).toBe(1);
    expect(out.skipped).toEqual([{ pid: C, why: "changed since the correction — left alone" }]);
    expect(await read(db, `new_arrivals/items/${A}/originalUrl`)).toBe(staff(A, "old"));
    // …and the mark this step put on its generated photo goes too; one it did not put stays.
    expect(await read(db, `new_arrivals/items/${A}/generations/g1`)).toEqual({ url: "https://x/a-g1.jpg", at: 10 });
    expect(await read(db, `new_arrivals/items/${A}/generations/g2/sourceUrl`)).toBe("https://x/already-recorded.jpg");
    expect(await read(db, `new_arrivals/items/${C}/originalUrl`)).toBe("https://x/changed-by-hand.jpg");
    expect(await read(db, `new_arrivals/fixes/${FIX_ID}/${A}/reverted`)).toBe(888);
    // Reverting twice does nothing more.
    expect((await run({ db, revert: true })).reverted).toBe(0);
    expect(undo({ was: "a", now: "b", reverted: 1 }, "b")).toEqual({ skip: "already put back" });
  });
});

describe("only a staff re-shoot says the existing photos are of the old picture", () => {
  it("a copy that differs for another reason is corrected but its photos are NOT marked; an older item with no generation record is named", async () => {
    const X = "p1790000000009", Y = "p1790000000010";
    const db = makeFakeDb({
      products: { [X]: { photoUrl: staff(X, "now") }, [Y]: { photoUrl: staff(Y, "new") } },
      new_arrivals: {
        items: {
          [X]: { pid: X, status: "ready", originalUrl: "https://x/elsewhere.jpg", generations: { g1: { url: "https://x/g.jpg", at: 1 } } },
          [Y]: { pid: Y, status: "ready", originalUrl: staff(Y, "old"), generatedUrl: "https://x/y-gen.jpg" },
        },
        by_status: { ready: { [X]: 1, [Y]: 1 } },
      },
    });
    const out = await run({ db });
    expect(out).toMatchObject({ corrected: 2, reshot: 1, photosMarked: 0, unmarkable: [Y] });
    expect(await read(db, `new_arrivals/items/${X}/generations/g1/sourceUrl`)).toBeNull();
  });
});

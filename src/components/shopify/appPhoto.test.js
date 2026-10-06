import { describe, it, expect, vi, beforeEach } from "vitest";

const writes = [];
vi.mock("../../firebase", () => ({ database: {}, storage: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  update: async (r, patch) => { writes.push([r.path, patch]); },
}));
vi.mock("firebase/storage", () => ({ ref: (_s, p) => ({ p }), getBlob: async () => new Blob(["x"]), uploadBytes: async () => {}, deleteObject: async () => {} }));
vi.mock("../../utils/productThumb", () => ({ writeApprovedThumbFromUrl: vi.fn(async () => ({ ok: true })) }));

const { appPhotoPatch, syncAppPhoto } = await import("./appPhoto.js");
const { writeApprovedThumbFromUrl } = await import("../../utils/productThumb");
const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const staff = `${B}products%2Fp1%2Fphoto.jpg?alt=media&token=a`;
const pub = (n) => `${B}products%2Fp1%2Fshopify%2F${n}.jpg?alt=media&token=b`;

beforeEach(() => { writes.length = 0; writeApprovedThumbFromUrl.mockClear(); });

describe("the primary photo is the app photo (26 Sep)", () => {
  it("a changed primary writes ONLY photoUrl (+ keeps the staff original) as child keys, and rebuilds the till thumbnail", async () => {
    const product = { photoUrl: staff, styleCodeNormalised: "ABC123" };
    const r = await syncAppPhoto("p1", product, staff, pub("new"));
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(writes).toEqual([["products/p1", { photoUrl: pub("new"), photoUrlOriginal: staff }]]);
    // nothing else on the record — styleCodeNormalised above all — is in the patch
    expect(Object.keys(writes[0][1])).not.toContain("styleCodeNormalised");
    expect(writeApprovedThumbFromUrl).toHaveBeenCalledWith("p1", pub("new"), expect.any(Object));
  });
  it("an edit that does not change the primary (an extra photo, a video, a reorder behind it) never touches the app photo", async () => {
    expect(appPhotoPatch("p1", { photoUrl: staff }, staff, staff)).toBeNull();
    const r = await syncAppPhoto("p1", { photoUrl: pub("a") }, pub("a"), pub("a"));
    expect(r.changed).toBe(false);
    expect(writes).toEqual([]);
  });
  it("an original already kept is not overwritten by a later swap between publishing photos", () => {
    const product = { photoUrl: pub("a"), photoUrlOriginal: staff };
    expect(appPhotoPatch("p1", product, pub("a"), pub("b"))).toEqual({ photoUrl: pub("b") });
  });
  it("EMPTY-PID GUARD: no product id → no write, never a path at the products root", async () => {
    for (const bad of ["", null, undefined, "a/b", "p1.x"]) {
      expect(appPhotoPatch(bad, { photoUrl: staff }, staff, pub("x"))).toBeNull();
      const r = await syncAppPhoto(bad, { photoUrl: staff }, staff, pub("x"));
      expect(r.changed).toBe(false);
    }
    expect(writes).toEqual([]);
  });
});

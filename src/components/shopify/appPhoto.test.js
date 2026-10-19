import { describe, it, expect, vi, beforeEach } from "vitest";

const writes = [];
const metaReads = [];
vi.mock("../../firebase", () => ({ database: {}, storage: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  update: async (r, patch) => { writes.push([r.path, patch]); },
}));
vi.mock("firebase/storage", () => ({
  ref: (_s, p) => ({ p }),
  getMetadata: async (r) => { metaReads.push(r.p); return { md5Hash: `md5:${r.p}` }; },
  getBlob: async () => new Blob(["x"]), uploadBytes: async () => {}, deleteObject: async () => {},
}));
vi.mock("../../utils/productThumb", () => ({ writeApprovedThumbFromUrl: vi.fn(async () => ({ ok: true })) }));

const { browserPrimaryPhotoDeps: d } = await import("./appPhoto.js");
const { writeApprovedThumbFromUrl } = await import("../../utils/productThumb");
const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";

beforeEach(() => { writes.length = 0; metaReads.length = 0; writeApprovedThumbFromUrl.mockClear(); });

describe("the browser's legs for the primary-photo write", () => {
  it("writeProduct is an update() of /products/{pid} child keys — never a set of the record", async () => {
    await d.writeProduct("p1", { photoUrl: "u" });
    expect(writes).toEqual([["products/p1", { photoUrl: "u" }]]);
  });
  it("md5Of reads the object's Storage metadata by PATH, and answers null for a URL outside this bucket", async () => {
    expect(await d.md5Of(`${B}products%2Fp1%2Fphoto.jpg?alt=media&token=a`)).toBe("md5:products/p1/photo.jpg");
    expect(await d.md5Of("https://example.com/x.jpg")).toBeNull();
    expect(metaReads).toEqual(["products/p1/photo.jpg"]);
  });
  it("rebuildThumb is the AI Studio approve's thumbnail helper", async () => {
    await d.rebuildThumb("p1", "u");
    expect(writeApprovedThumbFromUrl).toHaveBeenCalledWith("p1", "u", expect.any(Object));
  });
  it("now is the server clock", () => {
    expect(typeof d.now()).toBe("number");
  });
});

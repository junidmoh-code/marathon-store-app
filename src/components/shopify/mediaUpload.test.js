import { describe, it, expect, vi, beforeEach } from "vitest";

const uploads = [];
let claimAnswer = { ok: true };
vi.mock("../../firebase", () => ({ storage: { maxUploadRetryTime: 600000 }, functions: {} }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1_790_000_000_000 }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async (data) => { uploads.push(["claim", data]); return { data: claimAnswer }; } }));
vi.mock("firebase/storage", () => ({
  ref: (_s, path) => ({ path }),
  uploadBytes: async (r) => { uploads.push(["bytes", r.path]); },
  uploadBytesResumable: (r) => { uploads.push(["resumable", r.path]); throw new Error("network down"); },
  getDownloadURL: async (r) => `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/${encodeURIComponent(r.path)}`,
}));
vi.mock("./photoTools", () => ({
  uploadFileProblem: () => null,
  compressImageFile: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
  uploadPublishPhoto: async (pid) => { uploads.push(["photo", pid]); return `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2F${pid}%2Fshopify%2Fupload_1.jpg`; },
}));

const { prepareMediaItem, pickedKind, pickedFileProblem, videoMime } = await import("./mediaUpload.js");
const file = (name, type, bytes = "hello") => new File([bytes], name, { type });

beforeEach(() => { uploads.length = 0; claimAnswer = { ok: true }; });

describe("picking", () => {
  it("knows photos from videos, by type or by extension (iOS often sends no type)", () => {
    expect(pickedKind(file("a.jpg", "image/jpeg"))).toBe("photo");
    expect(pickedKind(file("IMG_1.MOV", ""))).toBe("video");
    expect(pickedKind(file("clip.mp4", "video/mp4"))).toBe("video");
    expect(pickedKind(file("notes.pdf", "application/pdf"))).toBeNull();
    expect(pickedFileProblem(file("notes.pdf", "application/pdf"))).toMatch(/isn't a photo or a video/);
    expect(videoMime(file("IMG_1.MOV", ""))).toBe("video/quicktime");
  });
});

describe("the wrong-photo guard", () => {
  it("an exact file owned by ANOTHER product is refused, naming it — and nothing is uploaded", async () => {
    claimAnswer = { ok: false, ownerPid: "p2", ownerName: "Plain tee white" };
    await expect(prepareMediaItem("p1", file("a.jpg", "image/jpeg"))).rejects.toThrow(/already on “Plain tee white” \(p2\)/);
    expect(uploads.map((u) => u[0])).toEqual(["claim"]);
    expect(uploads[0][1]).toMatchObject({ productId: "p1", kind: "photo" });
    expect(uploads[0][1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the same file already in THIS product is refused before even asking the server", async () => {
    const f = file("a.jpg", "image/jpeg", "same bytes");
    const { sha256OfBlob } = await import("./sha256.js");
    const sha = await sha256OfBlob(f);
    await expect(prepareMediaItem("p1", f, { existing: [{ sha256: sha }] })).rejects.toThrow(/already in this product/);
    expect(uploads).toEqual([]);
  });
});

describe("no ghost entries", () => {
  it("a video whose upload fails throws — the caller has no item to add", async () => {
    await expect(prepareMediaItem("p1", file("clip.mp4", "video/mp4"))).rejects.toThrow(/network down/);
    expect(uploads.map((u) => u[0])).toEqual(["claim", "resumable"]);
  });
  it("a photo becomes an item only after its bytes are stored", async () => {
    const item = await prepareMediaItem("p1", file("a.jpg", "image/jpeg"));
    expect(item).toMatchObject({ type: "photo", source: "upload", path: "products/p1/shopify/upload_1.jpg" });
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.id).toMatch(/^m[a-z0-9]+$/);
  });
});

describe("EMPTY-PID GUARD", () => {
  it("refuses an empty or malformed product id before hashing, claiming or uploading anything", async () => {
    for (const bad of ["", null, undefined, "../p1", "a/b"]) {
      await expect(prepareMediaItem(bad, file("a.jpg", "image/jpeg"))).rejects.toThrow(/illegal product id/);
    }
    expect(uploads).toEqual([]);
  });
});

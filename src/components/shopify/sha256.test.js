import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createSha256, sha256Hex, sha256OfBlob } from "./sha256.js";

const ref = (b) => createHash("sha256").update(b).digest("hex");

describe("sha256 (incremental)", () => {
  it("matches node:crypto at every length around the block and padding boundaries", () => {
    for (let n = 0; n <= 200; n++) {
      const b = randomBytes(n);
      expect(sha256Hex(new Uint8Array(b))).toBe(ref(b));
    }
  });
  it("is independent of how the input is chunked", () => {
    const b = randomBytes(10_000);
    for (const step of [1, 7, 63, 64, 65, 1000, 4096]) {
      const h = createSha256();
      for (let i = 0; i < b.length; i += step) h.update(new Uint8Array(b.subarray(i, i + step)));
      expect(h.hex()).toBe(ref(b));
    }
  });
  it("hashes a Blob slice by slice, reporting progress to the end", async () => {
    const b = randomBytes(300_001);
    const seen = [];
    const hex = await sha256OfBlob(new Blob([b]), { chunkBytes: 65_536, onProgress: (d, t) => seen.push([d, t]) });
    expect(hex).toBe(ref(b));
    expect(seen.at(-1)).toEqual([300_001, 300_001]);
  });
});

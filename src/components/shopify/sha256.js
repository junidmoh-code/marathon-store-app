// ─── SHA-256, INCREMENTAL ────────────────────────────────────────────────────
// The content hash recorded on every publishing upload and checked against the
// wrong-photo index (functions/lib/media-hash.cjs). crypto.subtle.digest only
// takes the WHOLE file as one buffer — fine for a photo, fatal on a phone for a
// 1 GB video — so this hashes a file a slice at a time. The algorithm is
// FIPS 180-4, unchanged; sha256.test.js pins it against node:crypto across
// every block-boundary length and on multi-chunk input.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function createSha256() {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const tail = new Uint8Array(64);
  let tailLen = 0;
  let total = 0; // bytes; a Number is exact to 2^53, far past any file
  let done = false;

  const compress = (bytes, off) => {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  };

  return {
    update(bytes) {
      if (done) throw new Error("sha256: update after digest");
      let i = 0;
      total += bytes.length;
      if (tailLen) {
        const take = Math.min(64 - tailLen, bytes.length);
        tail.set(bytes.subarray(0, take), tailLen);
        tailLen += take; i = take;
        if (tailLen < 64) return this;
        compress(tail, 0); tailLen = 0;
      }
      for (; i + 64 <= bytes.length; i += 64) compress(bytes, i);
      if (i < bytes.length) { tail.set(bytes.subarray(i), 0); tailLen = bytes.length - i; }
      return this;
    },
    hex() {
      if (!done) {
        done = true;
        const bits = total * 8;
        const pad = new Uint8Array(tailLen < 56 ? 64 : 128);
        pad.set(tail.subarray(0, tailLen));
        pad[tailLen] = 0x80;
        const n = pad.length;
        // Length in bits, big-endian, 64-bit: the high word via division (bits
        // can exceed 2^32 for any file over 512 MB).
        const hi = Math.floor(bits / 0x100000000);
        const lo = bits >>> 0;
        pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
        pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
        compress(pad, 0);
        if (n === 128) compress(pad, 64);
      }
      return Array.from(H, (w) => w.toString(16).padStart(8, "0")).join("");
    },
  };
}

/** Hash one byte array. */
export function sha256Hex(bytes) {
  return createSha256().update(bytes).hex();
}

/**
 * Hash a File/Blob a slice at a time. `onProgress(doneBytes, totalBytes)`.
 * Yields to the event loop between slices so the page stays responsive.
 */
export async function sha256OfBlob(blob, { chunkBytes = 4 * 1024 * 1024, onProgress } = {}) {
  const h = createSha256();
  const size = blob.size;
  for (let off = 0; off < size; off += chunkBytes) {
    const buf = new Uint8Array(await blob.slice(off, Math.min(size, off + chunkBytes)).arrayBuffer());
    h.update(buf);
    onProgress?.(Math.min(size, off + chunkBytes), size);
  }
  if (size === 0) onProgress?.(0, 0);
  return h.hex();
}

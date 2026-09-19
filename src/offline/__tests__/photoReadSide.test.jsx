// ─── THE PHOTO MIRROR MUST NOT BE WRITE-ONLY ─────────────────────────────────
//
// This branch shipped a photos leg that downloaded 111 MB of thumbnails per
// device into a cache with NO READERS. Every grid went on fetching the ~109 KB
// original from Storage exactly as before, so the leg was pure cost. A spec
// review found it, and nothing in the suite could have. (PR #618.)
//
// So: a behavioural test that a render site prefers the local thumbnail, and a
// wiring pin that the call sites are actually wired — because a call site that
// quietly loses its productId fails nothing, the photo still shows, every test
// still passes, and the only symptom is a bill.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";

const realCreate = globalThis.URL.createObjectURL;
beforeAll(() => { globalThis.URL.createObjectURL = () => "blob:local-thumb"; });
afterAll(() => { globalThis.URL.createObjectURL = realCreate; });

const held = new Map();
vi.mock("../photoCache", async (orig) => {
  const real = await orig();
  return {
    ...real,
    isPhotoCacheApiAvailable: () => true,
    openPhotoCache: async () => ({
      match: async (req) => (held.has(req.url) ? { blob: async () => ({}) } : undefined),
    }),
  };
});

import { MirroredImg } from "../MirroredImg";
import { photoCacheRequest } from "../photoCache";

const NETWORK = "https://firebasestorage.googleapis.com/v0/b/x/o/products%2Fp1%2Fphoto.jpg";

async function render(el) {
  let tree;
  await act(async () => { tree = TestRenderer.create(el); });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  return tree;
}

describe("a grid image prefers the device's own thumbnail", () => {
  it("serves the local blob when this device holds one", async () => {
    held.set(photoCacheRequest("p1").url, true);
    const tree = await render(<MirroredImg productId="p1" src={NETWORK} alt="" />);
    expect(tree.toJSON().props.src).toBe("blob:local-thumb");
    held.clear();
  });

  it("serves the NETWORK url when it does not — never a broken image", async () => {
    held.clear();
    const tree = await render(<MirroredImg productId="p1" src={NETWORK} alt="" />);
    expect(tree.toJSON().props.src).toBe(NETWORK);
  });

  it("serves the network url when there is no productId to look up", async () => {
    held.set(photoCacheRequest("p1").url, true);
    const tree = await render(<MirroredImg src={NETWORK} alt="" />);
    expect(tree.toJSON().props.src).toBe(NETWORK);
    held.clear();
  });

  it("passes every other prop through — it is an <img>", async () => {
    const tree = await render(
      <MirroredImg productId="p1" src={NETWORK} alt="Nike" loading="lazy" style={{ width: 48 }} />,
    );
    const { props, type } = tree.toJSON();
    expect(type).toBe("img");
    expect(props.alt).toBe("Nike");
    expect(props.loading).toBe("lazy");
    expect(props.style).toEqual({ width: 48 });
  });
});

describe("the call sites are wired", () => {
  // A site that loses its productId fails nothing: the photo still renders,
  // from the network, for ever. So the wiring is pinned, not trusted — the
  // same argument productThumbCallSites.pin.test.js makes about the WRITE side.
  const app = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");

  it("App.jsx's shared ProductPhoto helper takes a productId and uses it", () => {
    expect(app).toContain("function ProductPhoto({ productId = null,");
    expect(app).toContain("<MirroredImg productId={productId} src={src}");
  });

  it("every ProductPhoto call site passes one", () => {
    const sites = [...app.matchAll(/<ProductPhoto\s/g)];
    const wired = [...app.matchAll(/<ProductPhoto productId=/g)];
    expect(sites.length).toBeGreaterThan(10);
    expect(wired.length).toBe(sites.length);
  });

  it("no product-photo <img> is left in App.jsx's grids", () => {
    // The three shapes the browse surfaces used. Each is now a MirroredImg.
    expect(app).not.toMatch(/<img src=\{p\.photoUrl(\s|\})/);
    expect(app).not.toMatch(/<img src=\{p\.photoUrl \|\| ""\}/);
    expect(app).not.toMatch(/<img src=\{product\.photoUrl\} alt=\{product\.name\}/);
  });
});

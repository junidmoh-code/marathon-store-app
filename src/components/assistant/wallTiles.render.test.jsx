// ─── GENERATED WALL TILES — the manifest decides, the original is the fallback ──
// Proves:
//   1. the tile URL is built from a fixed template — a product's own
//      studio-wall.png in our bucket — never from the manifest's text
//   2. a product in the manifest draws its generated tile; any other product
//      draws its original exactly as before (HiResPhoto)
//   3. a generated tile that fails to load drops to the original
//   4. the popup's photo is a swipeable pair, generated first, original second,
//      and the lightbox list is in the same order
//   5. a missing / broken manifest leaves every tile on its original

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("../../offline/MirroredImg.jsx", () => ({
  MirroredImg: ({ productId, src, ...rest }) => <img src={src} data-mirrored={productId} {...rest} />,
}));

const W = await import("./wallTiles.js");
const { TilePhoto } = await import("./SneakerWall.jsx");
const { WallPair } = await import("./WallPair.jsx");

const KOBE = { id: "pKobe", name: "Air Force 1 Kobe", photoUrl: "https://x/kobe.jpg" };
const PANDA = { id: "pPanda", name: "Dunk Panda", photoUrl: "https://x/panda.jpg" };
const M = { tiles: { pKobe: { v: "abc12320261105" } } };
const GEN = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2FpKobe%2Fstudio-wall.png?alt=media&v=abc12320261105";

beforeEach(() => { W.__setWallManifestForTest(null); globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false })); });
const imgs = (tr) => tr.root.findAll(n => n.type === "img");

describe("generatedTileSrc", () => {
  it("builds the product's own studio-wall.png URL from the fixed template", () => {
    expect(W.generatedTileSrc(KOBE, M)).toBe(GEN);
    expect(W.generatedTileSrc(PANDA, M)).toBeNull();
    expect(W.generatedTileSrc(KOBE, null)).toBeNull();
  });
  it("ignores any URL in the manifest and refuses odd ids", () => {
    const evil = { url: "https://evil/{pid}", tiles: { "../x": { v: "1" }, pKobe: { v: "1", url: "https://evil/k.png" } } };
    expect(W.generatedTileSrc(KOBE, evil)).toMatch(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/marathon-club\.firebasestorage\.app\/o\/products%2FpKobe%2Fstudio-wall\.png/);
    expect(W.generatedTileSrc({ id: "../x" }, evil)).toBeNull();
  });
  it("the lightbox list: generated first, then the originals", () => {
    expect(W.wallPhotoList(KOBE, ["https://x/kobe.jpg", "https://x/kobe2.jpg"], M)).toEqual([GEN, "https://x/kobe.jpg", "https://x/kobe2.jpg"]);
    expect(W.wallPhotoList(PANDA, ["https://x/panda.jpg"], M)).toEqual(["https://x/panda.jpg"]);
  });
});

describe("loadWallManifest", () => {
  it("loads the manifest from products/_studio and keeps only its tiles", async () => {
    const f = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ url: "x", tiles: { pKobe: { v: "1" } } }) }));
    const m = await W.loadWallManifest(f, 1);
    expect(f.mock.calls[0][0]).toBe(W.WALL_MANIFEST_URL);
    expect(W.WALL_MANIFEST_URL).toContain("products%2F_studio%2Fwall-manifest.json");
    expect(m).toEqual({ tiles: { pKobe: { v: "1" } } });
  });
  it("an inherited key like __proto__ is never a tile", () => {
    expect(W.generatedTileSrc({ id: "__proto__" }, { tiles: {} })).toBeNull();
    expect(W.generatedTileSrc({ id: "constructor" }, { tiles: {} })).toBeNull();
  });
  it("after a failed load, retries wait a minute (no fetch storm while offline)", async () => {
    const f = vi.fn(() => Promise.reject(new Error("offline")));
    await W.loadWallManifest(f, 1000);
    await W.loadWallManifest(f, 2000); await W.loadWallManifest(f, 30000);
    expect(f).toHaveBeenCalledTimes(1);
    await W.loadWallManifest(f, 1000 + 61000);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("sixty tiles share ONE refresh timer, gone when the wall unmounts; off the wall there is none", () => {
    const Many = ({ on = true }) => <>{Array.from({ length: 60 }, (_, i) => <Probe key={i} on={on} />)}</>;
    function Probe({ on }) { W.useWallManifest(on); return null; }
    let tr; act(() => { tr = TestRenderer.create(<Many />); });
    expect(W.__wallTimerForTest()).toEqual({ timer: true, subs: 60 });  // sixty listeners, one timer, one fetch
    act(() => { tr.unmount(); });
    expect(W.__wallTimerForTest().timer).toBe(false);
    act(() => { tr = TestRenderer.create(<Many on={false} />); });
    expect(W.__wallTimerForTest().timer).toBe(false);
    act(() => { tr.unmount(); });
  });
  it("offline or a broken manifest: nothing, so every tile keeps its original", async () => {
    expect(await W.loadWallManifest(() => Promise.reject(new Error("offline")), 1)).toBeNull();
    expect(await W.loadWallManifest(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 1 }) }), 2)).toBeNull();
  });
});

describe("TilePhoto", () => {
  it("draws the generated tile when the product has one", () => {
    act(() => { W.__setWallManifestForTest(M); });
    let tr; act(() => { tr = TestRenderer.create(<TilePhoto p={KOBE} />); });
    expect(tr.root.findAll(n => n.props["data-testid"] === "sw-gen")).toHaveLength(1);
    expect(imgs(tr).map(i => i.props.src)).toEqual([GEN]);
  });
  it("draws the original, unchanged, when it has none", () => {
    act(() => { W.__setWallManifestForTest(M); });
    let tr; act(() => { tr = TestRenderer.create(<TilePhoto p={PANDA} />); });
    expect(imgs(tr).map(i => i.props.src)).toEqual([PANDA.photoUrl]);
  });
  it("a generated tile that fails to load drops to the original", () => {
    act(() => { W.__setWallManifestForTest(M); });
    let tr; act(() => { tr = TestRenderer.create(<TilePhoto p={KOBE} />); });
    act(() => { imgs(tr)[0].props.onError(); });
    expect(imgs(tr).map(i => i.props.src)).toEqual([KOBE.photoUrl]);
  });
});

describe("WallPair (the popup's photo)", () => {
  it("generated first, original second, with Studio / Original dots", () => {
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={GEN} />); });
    expect(imgs(tr).map(i => i.props.src)).toEqual([GEN, KOBE.photoUrl]);
    const dots = tr.root.findAll(n => n.type === "button" && n.props.className === "wp-dot");
    expect(dots.map(d => d.props["aria-label"])).toEqual(["Studio photo", "Original photo"]);
    expect(dots[0].props["aria-current"]).toBe(true);
    act(() => { dots[1].props.onClick(); });
    expect(tr.root.findAll(n => n.type === "button" && n.props.className === "wp-dot")[1].props["aria-current"]).toBe(true);
  });
  it("a swipe left moves to the original", () => {
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={GEN} />); });
    const root = tr.root.find(n => n.props["data-testid"] === "wall-pair");
    act(() => { root.props.onTouchStart({ touches: [{ clientX: 300, clientY: 100 }] }); root.props.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 120 }] }); });
    expect(tr.root.find(n => n.props.className === "wp-track").props.style.transform).toBe("translateX(-50%)");
  });
  it("a mostly vertical drag is a scroll, not a swipe", () => {
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={GEN} />); });
    const root = tr.root.find(n => n.props["data-testid"] === "wall-pair");
    act(() => { root.props.onTouchStart({ touches: [{ clientX: 300, clientY: 100 }] }); root.props.onTouchEnd({ changedTouches: [{ clientX: 240, clientY: 400 }] }); });
    expect(tr.root.find(n => n.props.className === "wp-track").props.style.transform).toBe("translateX(0%)");
  });
  it("a tap opens the lightbox on the slide on screen; a swipe never opens it", () => {
    const onOpen = vi.fn(); const ev = { stopPropagation() {} };
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={GEN} onOpen={onOpen} />); });
    const root = () => tr.root.find(n => n.props["data-testid"] === "wall-pair");
    act(() => { root().props.onClick(ev); });
    expect(onOpen).toHaveBeenLastCalledWith(0);
    act(() => { root().props.onTouchStart({ touches: [{ clientX: 300, clientY: 100 }] }); root().props.onTouchEnd({ changedTouches: [{ clientX: 100, clientY: 110 }] }); });
    act(() => { root().props.onClick(ev); });            // the click that follows the swipe
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => { root().props.onClick(ev); });
    expect(onOpen).toHaveBeenLastCalledWith(1);
  });
  it("the slide off screen is hidden from screen readers", () => {
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={GEN} />); });
    const slides = tr.root.findAll(n => typeof n.props.className === "string" && n.props.className.startsWith("wp-slide"));
    expect(slides.map(x => x.props["aria-hidden"])).toEqual([false, true]);
  });
  it("no generated tile, or one that fails: just the original, as before", () => {
    let tr; act(() => { tr = TestRenderer.create(<WallPair p={KOBE} gen={null} />); });
    expect(imgs(tr).map(i => i.props.src)).toEqual([KOBE.photoUrl]);
    act(() => { tr.update(<WallPair p={KOBE} gen={GEN} />); });
    act(() => { imgs(tr)[0].props.onError(); });
    expect(imgs(tr).map(i => i.props.src)).toEqual([KOBE.photoUrl]);
  });
});

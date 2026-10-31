// The hub's layby request card shows WHAT is in the parcel: a large product
// photo and the size printed big, tap → full screen. Reads are single keys —
// the sale's lineItems and that product's photo leaves — cached per card.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { create, act } from "react-test-renderer";

const DATA = {
  "pos/sales/S1/lineItems": {
    L1: { productId: "p1", size: "9", name: "Levi's 501 Jean", qty: 1, refundedQty: 0 },
    L2: { productId: "p2", size: "M", name: "Refunded Tee", qty: 1, refundedQty: 1 },
  },
  "products/p1/photoUrl": "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp1%2Fphoto.jpg?alt=media",
  "products/p1/photoUpdatedAt": 1790000000000,
  "products/p1/thumbAt": null,
};
const reads = [];
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "t" } } }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path = "") => ({ path }),
  get: async (r) => { reads.push(r.path); return { val: () => DATA[r.path] ?? null }; },
  update: async () => {},
  onValue: () => () => {},
  runTransaction: async () => ({ committed: false, snapshot: { val: () => null } }),
}));
vi.mock("../../offline/useMirroredPhotoSrc", () => ({ useMirroredPhotoSrc: () => null }));

const { PullCard } = await import("./LaybyTab.jsx");
const { _resetLaybyItemCaches, itemsFromLineItems } = await import("./laybyItems.js");

const PULL = { pullId: "P1", laybyId: "S1", saleId: "S1", invoiceNo: "L-00628", status: "pending", storageHub: "hub1", requestingStore: "trophy", requestedAt: 0 };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function mount(props = {}) {
  let tree;
  await act(async () => { tree = create(<PullCard pull={PULL} selectedHub="hub1" nowMs={Date.now()} {...props}/>); });
  await flush();
  return tree;
}

beforeEach(() => { reads.length = 0; _resetLaybyItemCaches(); });

describe("layby request card — photo + size", () => {
  test("a large photo (thumbnail URL, not an icon) and the size printed big", async () => {
    const tree = await mount({ onOpenPhoto: () => {} });
    const imgs = tree.root.findAllByType("img");
    expect(imgs).toHaveLength(1);                                  // the refunded line is not in the parcel
    expect(imgs[0].props.src).toContain("thumb_300");              // list size = the 300px thumbnail
    const size = tree.root.findByProps({ "data-testid": "layby-item-size" });
    expect(size.props.children).toBe("9");
    expect(size.props.style.fontSize).toBeGreaterThanOrEqual(28);
    // The photo's frame is large (≥ 100px square), not an icon-sized chip.
    const frame = tree.root.findAllByType("button").find((b) => String(b.props["aria-label"]).startsWith("Show"));
    expect(frame.props.style.width).toBeGreaterThanOrEqual(100);
    expect(frame.props.style.height).toBeGreaterThanOrEqual(100);
  });

  test("tap opens the FULL photo", async () => {
    const onOpenPhoto = vi.fn();
    const tree = await mount({ onOpenPhoto });
    const photoBtn = tree.root.findAllByType("button").find((b) => String(b.props["aria-label"]).startsWith("Show"));
    act(() => photoBtn.props.onClick());
    expect(onOpenPhoto).toHaveBeenCalledWith([DATA["products/p1/photoUrl"]]);
  });

  test("reads are single keys only — that sale's lineItems and that product's photo leaves", async () => {
    await mount();
    expect(reads.sort()).toEqual(["pos/sales/S1/lineItems", "products/p1/photoUpdatedAt", "products/p1/photoUrl", "products/p1/thumbAt"]);
    for (const p of reads) expect(p.split("/").length).toBeGreaterThanOrEqual(3); // never a whole node
  });

  test("cached per card: a re-mount (e.g. Incoming → Today's history) reads nothing", async () => {
    await mount();
    const n = reads.length;
    await mount({ pull: { ...PULL, status: "sentToStore", sentAt: new Date().toISOString() } });
    expect(reads.length).toBe(n);
  });

  test("a product the warehouse already holds is never read", async () => {
    await mount({ productsById: { p1: { id: "p1", photoUrl: DATA["products/p1/photoUrl"], photoUpdatedAt: 1 } } });
    expect(reads).toEqual(["pos/sales/S1/lineItems"]);
  });

  test("no lines → the card is as it was (no empty photo box)", async () => {
    const tree = await mount({ pull: { ...PULL, saleId: "NOPE", laybyId: "NOPE" } });
    expect(tree.root.findAllByProps({ "data-testid": "layby-items" })).toHaveLength(0);
  });
});

test("itemsFromLineItems keeps line order, drops refunded-out lines, tolerates junk", () => {
  expect(itemsFromLineItems({ L10: { productId: "b", qty: 1 }, L2: { productId: "a", qty: 2, refundedQty: 1 }, x: null }).map((i) => [i.productId, i.qty]))
    .toEqual([["a", 1], ["b", 1]]);
  expect(itemsFromLineItems(null)).toEqual([]);
  expect(itemsFromLineItems({ L1: { productId: "../evil", size: 7 } })[0].productId).toBe(null);
});

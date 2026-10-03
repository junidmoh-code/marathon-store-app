// The post-approval chain against the fake RTDB (cold-null transactions, RTDB
// delete semantics). Every step is the button's own mutator; these pin what
// the chain does with their answers.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { advance, blockedReasonText, DUPLICATE, EXCELLENT } from "./chainCore.mjs";

const require = createRequire(import.meta.url);
const { makeFakeDb } = require("../../functions/test/helpers/fake-rtdb.cjs");

const PID = "p1790944425749";
const GEN = `https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2F${PID}%2Fnew_arrivals%2Fgen_1.jpg?alt=media&token=t`;
const ORIG = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp%2Fphoto.jpg?alt=media";
const T = 1790950000000;

function world({ item = {}, product = {}, node = {} } = {}) {
  return makeFakeDb({
    new_arrivals: {
      items: { [PID]: { pid: PID, status: "approved", enqueuedAt: T - 9, statusAt: T - 5, generatedUrl: GEN, originalUrl: ORIG, nameProposedAt: 111, ...item } },
      by_status: { [item.status || "approved"]: { [PID]: T - 9 } },
    },
    products: { [PID]: { id: PID, name: "Nike Air zoom mercurial vapor purple soccer boots", photoUrl: ORIG, retailPrice: 950, sizes: ["6", "7"], ...product } },
    shopify_publish: { [PID]: { state: "awaiting", nameProposal: { status: "pending", name: "Low-top football boot in lilac", proposedAt: 111, source: "vision" }, ...node } },
  });
}

function deps(db, over = {}) {
  const thumbs = [];
  let n = 0;
  return {
    thumbs,
    d: {
      db, now: async () => T + (n++), log: () => {},
      download: async () => Buffer.from("img"), uploadThumb: async (p) => { thumbs.push(p); }, removeObject: async () => {},
      encodeThumb: async (b) => b,
      claimPublish: () => true,
      ...over,
    },
  };
}
const read = async (db, p) => (await db.ref(p).once()).val();

describe("advance — the happy path, step by step", () => {
  it("does (a)–(d) through the buttons' mutators, then waits for the reconciler", async () => {
    const db = world();
    const { d, thumbs } = deps(db);
    const r = await advance(PID, d);
    expect(r).toEqual({ pid: PID, outcome: "waiting", step: "shopify" });
    // (a) app photo by the AI Studio approve path; the original kept.
    const p = await read(db, `products/${PID}`);
    expect(p.photoUrl).toBe(GEN);
    expect(p.photoUrlOriginal).toBe(ORIG);
    expect(thumbs).toHaveLength(1);
    // (a)–(d) on the publisher node.
    const n = await read(db, `shopify_publish/${PID}`);
    expect(n.photos).toEqual([GEN]);
    expect(n.cleanName).toBe("Low-top football boot in lilac");
    expect(n.cleanNameSource).toBe("ai");
    expect(n.nameProposal.status).toBe("applied");
    expect(n.condition).toBe(EXCELLENT);
    expect(n.desiredState).toBe("on");
    expect(n.updatedBy).toBe("new-arrivals-agent");
    const it2 = await read(db, `new_arrivals/items/${PID}`);
    expect(it2.status).toBe("chaining");
    expect(Object.keys(it2.chain).sort()).toEqual(["condition", "name", "photo", "publish"]);
    expect(await read(db, `new_arrivals/by_status/approved`)).toBeNull();
  });

  it("finishes to Done when the reconciler confirms live, with where and when", async () => {
    const db = world();
    const { d } = deps(db);
    await advance(PID, d);
    await db.ref(`shopify_publish/${PID}`).update({ state: "live", liveState: "on", liveAt: T + 100, adminUrl: "https://admin/x" });
    expect((await advance(PID, d)).outcome).toBe("done");
    const it2 = await read(db, `new_arrivals/items/${PID}`);
    expect(it2.status).toBe("done");
    expect(it2.destinations.shopify).toEqual({ at: T + 100, title: "Low-top football boot in lilac", adminUrl: "https://admin/x" });
    expect(await read(db, `new_arrivals/by_status/done/${PID}`)).toBe(T - 9);
  });
});

describe("refusals go to Rejected in plain words — never forced", () => {
  it("the reconciler's duplicate title/handle block", async () => {
    const db = world();
    const { d } = deps(db);
    await advance(PID, d);
    await db.ref(`shopify_publish/${PID}`).update({ state: "blocked", desiredState: "off",
      blockedReason: 'the web address this name would use ("sneaker-black") already belongs to another listing on the shop: "Sneaker Black"' });
    const r = await advance(PID, d);
    expect(r).toMatchObject({ outcome: "rejected", step: "shopify", reason: DUPLICATE });
    const it2 = await read(db, `new_arrivals/items/${PID}`);
    expect(it2.status).toBe("rejected");
    expect(it2.rejection).toMatchObject({ code: "chain", step: "shopify", reason: DUPLICATE });
    // Nothing renamed, nothing suffixed: the name is exactly the proposal.
    expect((await read(db, `shopify_publish/${PID}`)).cleanName).toBe("Low-top football boot in lilac");
  });

  it("a newer name suggestion than the one Junid saw", async () => {
    const db = world({ node: { nameProposal: { status: "pending", name: "Something else", proposedAt: 222 } } });
    const r = await advance(PID, deps(db).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "name" });
    expect(r.reason).toMatch(/newer suggestion arrived/);
    expect((await read(db, `shopify_publish/${PID}`)).cleanName).toBeUndefined();
  });

  it("no record of the name Junid saw → refused, never applied blind", async () => {
    const db = world({ item: { nameProposedAt: null } });
    const r = await advance(PID, deps(db).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "name" });
    expect((await read(db, `shopify_publish/${PID}`)).cleanName).toBeUndefined();
  });

  it("no retail price → photo, name and condition still done; only Shopify waits, rejected at publish", async () => {
    const db = world({ product: { retailPrice: null, stockPrice: 550 } });
    let claimed = 0;
    const r = await advance(PID, deps(db, { claimPublish: () => { claimed++; return true; } }).d);
    expect(r).toEqual({
      pid: PID, outcome: "rejected", step: "publish",
      reason: "Shopify waits for a retail price — set it in the app, then Retry (the groups are posted at the stock price meanwhile)",
    });
    // (a)–(c) ran without a retail price.
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(GEN);
    const n = await read(db, `shopify_publish/${PID}`);
    expect(n.photos).toEqual([GEN]);
    expect(n.cleanName).toBe("Low-top football boot in lilac");
    expect(n.condition).toBe(EXCELLENT);
    // (d) never attempted: not claimed, not switched on.
    expect(claimed).toBe(0);
    expect(n.desiredState).not.toBe("on");
    const it2 = await read(db, `new_arrivals/items/${PID}`);
    expect(Object.keys(it2.chain).sort()).toEqual(["condition", "name", "photo"]);
    expect(it2.status).toBe("rejected");
    expect(it2.rejection).toMatchObject({ code: "chain", step: "publish" });
  });

  it("a zero or junk retail price waits the same way", async () => {
    for (const retailPrice of [0, "abc"]) {
      const db = world({ product: { retailPrice } });
      const r = await advance(PID, deps(db).d);
      expect(r).toMatchObject({ outcome: "rejected", step: "publish" });
      expect(r.reason).toMatch(/Shopify waits for a retail price/);
    }
  });

  it("a listing already ON refuses the photo change", async () => {
    const db = world({ node: { state: "live", liveState: "on", condition: EXCELLENT } });
    const r = await advance(PID, deps(db).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "photo" });
    expect(r.reason).toMatch(/Listing is ON the storefront/);
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(ORIG); // app photo untouched by a refused step
  });

  it("blockedReasonText", () => {
    expect(blockedReasonText("another listing on the shop already carries this exact title. A new name…")).toBe(DUPLICATE);
    expect(blockedReasonText("catalogue sizes with no Shopify variant: S")).toBe("Shopify refused it — catalogue sizes with no Shopify variant: S");
  });
});

describe("the original photo, resume, and publish-once", () => {
  it("never overwrites an existing photoUrlOriginal", async () => {
    const db = world({ product: { photoUrl: "https://x/ai-earlier.jpg", photoUrlOriginal: "https://x/the-real-original.jpg" } });
    await advance(PID, deps(db).d);
    expect((await read(db, `products/${PID}`)).photoUrlOriginal).toBe("https://x/the-real-original.jpg");
  });

  it("resumes without repeating a finished step", async () => {
    const db = world({ item: { status: "chaining", chain: { photo: { at: 1 } } } });
    const r = await advance(PID, deps(db).d);
    expect(r.outcome).toBe("waiting");
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(ORIG); // photo step not re-run
  });

  it("a lost publish claim stops unless the intent is visibly there", async () => {
    const db = world();
    const r = await advance(PID, deps(db, { claimPublish: () => false }).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "publish" });
    const db2 = world({ item: { status: "chaining", chain: { photo: { at: 1 }, name: { at: 1 }, condition: { at: 1 } } },
      node: { desiredState: "on", condition: EXCELLENT, cleanName: "x" } });
    expect((await advance(PID, deps(db2, { claimPublish: () => false }).d)).outcome).toBe("waiting");
  });

  it("resumes the name step when the apply landed but its stamp did not", async () => {
    const db = world({ item: { status: "chaining", chain: { photo: { at: 1, url: GEN } } },
      node: { photos: [GEN], cleanName: "Low-top football boot in lilac", cleanNameSource: "ai",
        nameProposal: { status: "applied", name: "Low-top football boot in lilac", proposedAt: 111 } } });
    expect((await advance(PID, deps(db).d)).outcome).toBe("waiting");
  });

  it("a chain stamp from an older generation is redone with the new photo", async () => {
    const db = world({ item: { status: "chaining", chain: { photo: { at: 1, url: "https://old" } } } });
    await advance(PID, deps(db).d);
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(GEN);
  });

  it("a publish the button would refuse releases its claim", async () => {
    // Steps a–c done; the stored name fails the button's own trigger check.
    const db = world({ item: { status: "chaining", chain: { photo: { at: 1, url: GEN }, name: { at: 1 }, condition: { at: 1 } } },
      node: { condition: EXCELLENT, cleanName: "9" } });
    const released = [];
    const r = await advance(PID, deps(db, { releasePublish: (p) => released.push(p) }).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "publish" });
    expect(released).toEqual([PID]);
    expect((await read(db, `shopify_publish/${PID}`)).desiredState).toBeUndefined();
  });

  it("an approved item whose name is pending is NOT started — nothing written", async () => {
    const db = world({ item: { naming: { status: "pending", since: 1 }, nameProposedAt: null } });
    expect(await advance(PID, deps(db).d)).toEqual({ pid: PID, outcome: "waiting", step: "name-pending" });
    expect((await read(db, `new_arrivals/items/${PID}`)).status).toBe("approved");
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(ORIG);
  });

  it("starts by itself once the name lands", async () => {
    const db = world({ item: { naming: { status: "pending", since: 1 } } });
    await advance(PID, deps(db).d);
    await db.ref(`new_arrivals/items/${PID}/naming`).set({ status: "done", since: 1, at: 2 });
    expect((await advance(PID, deps(db).d)).outcome).toBe("waiting");
    expect((await read(db, `shopify_publish/${PID}`)).desiredState).toBe("on");
  });

  it("a failed name refuses the Shopify leg in the namer's words", async () => {
    const db = world({ item: { naming: { status: "failed", reason: "duplicate name — needs a distinct name" } } });
    const r = await advance(PID, deps(db).d);
    expect(r).toMatchObject({ outcome: "rejected", step: "name", reason: "duplicate name — needs a distinct name" });
    // Nothing of the Shopify leg was written.
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(ORIG);
    expect((await read(db, `shopify_publish/${PID}`)).photos).toBeUndefined();
    expect((await read(db, `new_arrivals/items/${PID}`)).status).toBe("rejected");
  });

  it("an item that is not approved/chaining is left alone", async () => {
    const db = world({ item: { status: "ready" } });
    expect((await advance(PID, deps(db).d)).outcome).toBe("skipped");
  });
});

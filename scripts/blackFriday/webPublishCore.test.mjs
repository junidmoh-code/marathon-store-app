// Black Friday → the website first, against the fake RTDB (cold-null transactions,
// RTDB delete semantics). Every write is the publisher card's own mutator; these
// pin what the step does with their answers.
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import {
  publishOne, drain, approvedPhotoUrl, mediaWithFirst, websitePhotoProblem, entryFor, retryDelay,
  EXCELLENT, RETRY_MS, RETRY_MAX_MS, QUEUE, WEB, SWITCH_OFF,
} from "./webPublishCore.mjs";

const require = createRequire(import.meta.url);
const { makeFakeDb } = require("../../functions/test/helpers/fake-rtdb.cjs");

const PID = "p1790944425749";
const B = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/";
const APP = `${B}products%2F${PID}%2Fphoto.jpg?alt=media&token=a`;
const GAL = `${B}products%2F${PID}%2Fgallery_1.jpg?alt=media&token=b`;
const GEN = `${B}products%2F${PID}%2Fblack_friday%2Fg1795000000000.jpg?alt=media&token=g`;
const BRANDED = `${B}products%2F${PID}%2Fnike-air.jpg?alt=media&token=n`;
const T = 1795100000000;

const pickOf = (over = {}) => ({ state: "approved", sig: "current", at: T - 50, shown: APP, kind: "sneakers", price: 650, name: "Air", section: "main", ...over });

function world({ pick = pickOf(), photo = null, product = {}, node = null, stock = { "marathon-pe": { [PID]: { "7": 3 } } }, na = null } = {}) {
  return makeFakeDb({
    bf_campaign_2026: { picks: { [PID]: pick }, ...(photo ? { photos: { [PID]: photo } } : {}) },
    products: { [PID]: { id: PID, name: "Sneaker white leather", photoUrl: APP, gallery: [GAL], retailPrice: 950, sizes: ["7", "8"], ...product } },
    ...(node ? { shopify_publish: { [PID]: node } } : {}),
    stock: Object.fromEntries(Object.entries(stock || {}).map(([loc, v]) => [loc, v])),
    locations: { "marathon-pe": { name: "PE" } },
    ...(na ? { new_arrivals: { items: { [PID]: na } } } : {}),
  });
}
function deps(db, over = {}) {
  const thumbs = [];
  let n = 0;
  return {
    thumbs,
    d: {
      db, now: async () => T + (n++), log: () => {}, locNames: ["marathon-pe"],
      download: async () => Buffer.from("img"), uploadThumb: async (p) => { thumbs.push(p); }, removeObject: async () => {},
      encodeThumb: async (b) => b,
      ...over,
    },
  };
}
const read = async (db, p) => (await db.ref(p).once()).val();
const genPhoto = { use: "generated", genId: "g1795000000000", gens: { g1795000000000: { url: GEN, at: T - 100 } } };

describe("approvedPhotoUrl — the photo that posts (the poster's approvedPhotoOf)", () => {
  it("a generated photo, a New Arrival's pinned photo, else the approved app photo", () => {
    expect(approvedPhotoUrl(pickOf({ sig: "g1795000000000" }), genPhoto, {})).toBe(GEN);
    expect(approvedPhotoUrl(pickOf({ src: "na", shown: GEN }), null, {})).toBe(GEN);
    expect(approvedPhotoUrl(pickOf(), null, { photoUrl: "x" })).toBe(APP);
    expect(approvedPhotoUrl(pickOf({ shown: null }), null, { photoUrl: APP })).toBe(APP);
  });
});

describe("mediaWithFirst — approved first, the others kept", () => {
  it("puts the approved photo first and keeps the record's photos after it", () => {
    const { media, changed } = mediaWithFirst(null, { photoUrl: APP, gallery: [GAL] }, GEN);
    expect(media.map((m) => m.url)).toEqual([GEN, APP, GAL]);
    expect(changed).toBe(true);
  });
  it("moves an approved photo already in the list to the front (no duplicate)", () => {
    const { media } = mediaWithFirst({ photos: [APP, GEN] }, {}, GEN);
    expect(media.map((m) => m.url)).toEqual([GEN, APP]);
  });
  it("unchanged when the approved photo already leads", () => {
    expect(mediaWithFirst(null, { photoUrl: APP, gallery: [GAL] }, APP).changed).toBe(false);
  });
  it("leaves out a kept photo the website would refuse (a brand word in its file name)", () => {
    const { media } = mediaWithFirst({ photos: [APP, BRANDED] }, {}, GEN);
    expect(media.map((m) => m.url)).toEqual([GEN, APP]);
    expect(websitePhotoProblem(BRANDED)).toMatch(/brand word/);
    expect(websitePhotoProblem("https://example.com/x.jpg")).toMatch(/app's own files/);
    expect(websitePhotoProblem(GEN)).toBeNull();
  });
});

describe("publishOne — the publisher card's steps", () => {
  it("an AI photo approval: photo first (others kept), app photo follows, Excellent, published", async () => {
    const db = world({ pick: pickOf({ sig: "g1795000000000" }), photo: genPhoto });
    const { d, thumbs } = deps(db);
    const r = await publishOne(PID, d);
    expect(r).toMatchObject({ pid: PID, outcome: "published", why: "Sneaker white leather" });
    const n = await read(db, `shopify_publish/${PID}`);
    expect(n.media.map((m) => m.url)).toEqual([GEN, APP, GAL]);
    expect(n.photos).toEqual([GEN, APP, GAL]);
    expect(n.condition).toBe(EXCELLENT);
    expect(n.desiredState).toBe("on");
    expect(n.cleanName).toBe("Sneaker white leather");
    expect(n.updatedBy).toBe("bf-web-agent");
    // The app photo follows the website's first photo (Junid's photo rule); the original is kept.
    const p = await read(db, `products/${PID}`);
    expect(p.photoUrl).toBe(GEN);
    expect(p.photoUrlOriginal).toBe(APP);
    expect(thumbs).toHaveLength(1);
    // Prices are never touched.
    expect(p.retailPrice).toBe(950);
  });

  it("the app photo approved: the list is saved with it first, the app photo is left alone", async () => {
    const db = world();
    const { d, thumbs } = deps(db);
    expect((await publishOne(PID, d)).outcome).toBe("published");
    expect((await read(db, `shopify_publish/${PID}`)).photos).toEqual([APP, GAL]);
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(APP);
    expect(thumbs).toHaveLength(0);
  });

  it("already on the website: nothing written", async () => {
    const node = { state: "live", liveState: "on", desiredState: "on", condition: EXCELLENT, cleanName: "x", updatedAt: 1 };
    const db = world({ node });
    const { d } = deps(db);
    expect(await publishOne(PID, d)).toEqual({ pid: PID, outcome: "live" });
    expect(await read(db, `shopify_publish/${PID}`)).toEqual(node);
  });

  it("out of stock online: not published, nothing written", async () => {
    const db = world({ stock: { "marathon-pe": { [PID]: { "7": 0 } } } });
    const { d } = deps(db);
    expect((await publishOne(PID, d)).outcome).toBe("oos");
    expect(await read(db, `shopify_publish/${PID}`)).toBeNull();
  });

  it("a New Arrival the New Arrivals chain is publishing is left to it (its stuck reason is shown)", async () => {
    const db = world({ na: { status: "chaining" } });
    const { d } = deps(db);
    expect(await publishOne(PID, d)).toMatchObject({ outcome: "pending", why: "New Arrivals is publishing it" });
    expect(await read(db, `shopify_publish/${PID}`)).toBeNull();
    const db2 = world({ na: { status: "chaining", chain: { stuck: { step: "name", reason: "duplicate name" } } } });
    expect(await publishOne(PID, deps(db2).d)).toMatchObject({ outcome: "failed", why: "New Arrivals: duplicate name" });
  });

  it("handed to the reconciler already: waits for its verdict", async () => {
    const db = world({ node: { state: "awaiting", desiredState: "on", condition: EXCELLENT, cleanName: "x" } });
    expect((await publishOne(PID, deps(db).d)).outcome).toBe("pending");
  });

  it("not approved (or approved with a photo it no longer shows): nothing to do", async () => {
    expect((await publishOne(PID, deps(world({ pick: { state: "rejected" } })).d)).outcome).toBe("unapproved");
    // Approved on a generation, but the card now shows the app photo: the approval is stale.
    expect((await publishOne(PID, deps(world({ pick: pickOf({ sig: "g1795000000000" }), photo: { ...genPhoto, use: "current" } })).d)).outcome).toBe("unapproved");
  });

  it("a name the website refused as taken: a new one is asked for; the suggestion is applied when it comes", async () => {
    const node = { state: "blocked", desiredState: "off", blockedReason: 'the web address this name would use ("sneaker-white") already belongs to another listing', condition: EXCELLENT, cleanName: "Sneaker white" };
    const db = world({ node });
    const { d } = deps(db);
    expect((await publishOne(PID, d)).outcome).toBe("needs-name");
    expect((await read(db, `shopify_publish/${PID}`)).desiredState).toBe("off");
    await db.ref(`shopify_publish/${PID}/nameProposal`).set({ status: "pending", name: "Low-top sneaker in chalk", proposedAt: 222, source: "vision" });
    const r = await publishOne(PID, d);
    expect(r).toMatchObject({ outcome: "published", why: "Low-top sneaker in chalk" });
    const n = await read(db, `shopify_publish/${PID}`);
    expect(n.cleanName).toBe("Low-top sneaker in chalk");
    expect(n.nameProposal.status).toBe("applied");
    expect(n.state).toBe("awaiting");
    expect(n.desiredState).toBe("on");
  });

  it("the reconciler refused OUR publish for another reason: shown, not retried with the same name", async () => {
    const node = { state: "blocked", desiredState: "off", blockedReason: "catalogue sizes with no Shopify variant: 9", condition: EXCELLENT, cleanName: "Sneaker white" };
    const db = world({ node });
    const r = await publishOne(PID, deps(db).d, { web: { s: "fail", pubAt: T - 10 } });
    expect(r).toMatchObject({ outcome: "failed", why: "catalogue sizes with no Shopify variant: 9" });
    expect((await read(db, `shopify_publish/${PID}`)).desiredState).toBe("off");
    // Never published by us before (a block from earlier): one fresh try.
    expect((await publishOne(PID, deps(world({ node })).d)).outcome).toBe("published");
  });

  it("a refusal of OUR publish is not retried when nothing changed — even a photo refusal (no 2-minute loop)", async () => {
    const node = { state: "blocked", desiredState: "off", blockedReason: "media[0].originalSource: brand trigger(s) in URL path: x", condition: EXCELLENT, cleanName: "Sneaker white", photos: [APP, GAL] };
    const db = world({ node });
    expect((await publishOne(PID, deps(db).d, { web: { s: "fail", pubAt: T - 10 } })).outcome).toBe("failed");
    expect((await read(db, `shopify_publish/${PID}`)).desiredState).toBe("off");
    // After RETRY_MAX_MS since our publish: one more try (the cause may lie outside).
    expect((await publishOne(PID, deps(db).d, { web: { s: "fail", pubAt: T - RETRY_MAX_MS - 10 } })).outcome).toBe("published");
  });

  it("a refusal the reconciler says a new publish fixes (photo failed processing) is retried after 30 minutes", async () => {
    const node = { state: "blocked", desiredState: "off", blockedReason: "media: a photo FAILED processing on Shopify — the product must not ship without it; publishing again retries it", condition: EXCELLENT, cleanName: "Sneaker white", photos: [APP, GAL] };
    expect((await publishOne(PID, deps(world({ node })).d, { web: { s: "fail", pubAt: T - 10 } })).outcome).toBe("failed");
    expect((await publishOne(PID, deps(world({ node })).d, { web: { s: "fail", pubAt: T - RETRY_MS - 10 } })).outcome).toBe("published");
  });

  it("the app photo follows even when the list already leads with the approved photo", async () => {
    const db = world({ pick: pickOf({ sig: "g1795000000000" }), photo: genPhoto, node: { state: "awaiting", photos: [GEN, APP], media: [{ id: "a1", type: "photo", url: GEN }, { id: "a2", type: "photo", url: APP }] } });
    expect((await publishOne(PID, deps(db).d)).outcome).toBe("published");
    expect((await read(db, `products/${PID}`)).photoUrl).toBe(GEN);
  });

  it("an old block for a branded photo file: tried again without that photo", async () => {
    const node = { state: "blocked", desiredState: "off", blockedReason: "media[1].originalSource: brand trigger(s) in URL path: nike", condition: EXCELLENT, cleanName: "Sneaker white", photos: [APP, BRANDED] };
    const db = world({ node });
    expect((await publishOne(PID, deps(db).d, { web: { s: "fail", pubAt: T - 10 } })).outcome).toBe("published");
    expect((await read(db, `shopify_publish/${PID}`)).photos).toEqual([APP]);
  });

  it("no usable name (the lexicon cannot clean it): the namer is asked", async () => {
    const db = world({ product: { name: "Nike" } });
    expect((await publishOne(PID, deps(db).d)).outcome).toBe("needs-name");
    expect(await read(db, `shopify_publish/${PID}`)).toBeNull();
  });

  it("a product that is gone or merged can never be published", async () => {
    expect((await publishOne(PID, deps(world({ product: { mergedInto: "p2" } })).d)).outcome).toBe("gone");
  });
});

describe("drain — the queue and the card's status", () => {
  it("publishes, records Publishing…, then On website ✓ once the reconciler confirms, and leaves the queue", async () => {
    const db = world();
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50, at: T - 40 });
    const { d } = deps(db);
    const o1 = await drain(d);
    expect(o1.published).toBe(1);
    expect(await read(db, `${WEB}/${PID}`)).toMatchObject({ s: "pub", approvedAt: T - 50 });
    expect((await read(db, `${WEB}/${PID}`)).pubAt).toBeGreaterThan(0);
    expect(await read(db, `${QUEUE}/${PID}`)).not.toBeNull();
    // The reconciler's verdict.
    await db.ref(`shopify_publish/${PID}`).update({ state: "live", liveState: "on" });
    await drain(d);
    expect(await read(db, `${WEB}/${PID}`)).toMatchObject({ s: "live" });
    expect(await read(db, `${QUEUE}/${PID}`)).toBeNull();
  });

  it("a failure is shown with its reason and retried later, with a growing wait", async () => {
    const db = world({ pick: pickOf({ shown: "https://example.com/x.jpg" }) });
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50, at: T - 40 });
    const { d } = deps(db);
    await drain(d);
    expect(await read(db, `${WEB}/${PID}`)).toMatchObject({ s: "fail", why: "the approved photo is not one of the app's own files" });
    const q = await read(db, `${QUEUE}/${PID}`);
    expect(q.tries).toBe(1);
    expect(q.tryAt).toBeGreaterThan(T + RETRY_MS - 100);
    // Not due yet: not looked at.
    expect((await drain(d)).results).toHaveLength(0);
    expect(retryDelay(1)).toBe(RETRY_MS);
    expect(retryDelay(2)).toBe(2 * RETRY_MS);
    expect(retryDelay(99)).toBe(RETRY_MAX_MS);
  });

  it("asks the namer once for every product that needs a name", async () => {
    const db = world({ product: { name: "Nike" } });
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50, at: T - 40 });
    const suggestNames = vi.fn(async () => {});
    const { d } = deps(db, { suggestNames });
    await drain(d);
    expect(suggestNames).toHaveBeenCalledWith([PID]);
    expect(await read(db, `${WEB}/${PID}`)).toMatchObject({ s: "pub", why: "waiting for a website name" });
    // Asked again only after NAME_RETRY_MS.
    await drain(d, { force: true });
    expect(suggestNames).toHaveBeenCalledTimes(1);
  });

  it("out of stock: listed on the card and taken off the queue", async () => {
    const db = world({ stock: {} });
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50 });
    await drain(deps(db).d);
    expect(await read(db, `${WEB}/${PID}`)).toMatchObject({ s: "oos" });
    expect(await read(db, `${QUEUE}/${PID}`)).toBeNull();
  });

  it("the off switch: nothing is published", async () => {
    const db = world();
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50 });
    await db.ref(SWITCH_OFF).set(true);
    expect((await drain(deps(db).d)).off).toBe(true);
    expect(await read(db, `shopify_publish/${PID}`)).toBeNull();
  });

  it("a quiet product writes nothing new to the card", async () => {
    const db = world({ node: { state: "awaiting", desiredState: "on", condition: EXCELLENT, cleanName: "x" } });
    await db.ref(`${QUEUE}/${PID}`).set({ approvedAt: T - 50 });
    const { d } = deps(db);
    await drain(d);
    const first = await read(db, `${WEB}/${PID}`);
    await drain(d, { force: true });
    expect(await read(db, `${WEB}/${PID}`)).toEqual(first);
  });

  it("entryFor maps each outcome to the card's three words", () => {
    expect(entryFor({ outcome: "live" })).toEqual({ s: "live" });
    expect(entryFor({ outcome: "published" })).toEqual({ s: "pub" });
    expect(entryFor({ outcome: "failed", why: "x" })).toEqual({ s: "fail", why: "x" });
    expect(entryFor({ outcome: "unapproved" })).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  planMediaSync, reorderMoves, syncProductMedia, needsLiveMediaSync, pushSigFor, uploadVideoToShopify,
  MEDIA_PENDING_PATH,
} from "./mediaSync.mjs";
import { APP_STORAGE_PREFIX } from "../../src/components/shopify/publishShared.js";
import { rtdbRoundTrip } from "../../src/components/shopify/rtdbRoundTrip.testutil.js";

const U = (n) => `${APP_STORAGE_PREFIX}products%2Fp1%2Fshopify%2F${n}.jpg?alt=media`;
const V = (n) => `${APP_STORAGE_PREFIX}products%2Fp1%2Fmedia%2F${n}.mp4?alt=media`;
const photo = (n) => ({ id: `mp${n}`, type: "photo", url: U(n) });
const video = (n, extra = {}) => ({ id: `mv${n}`, type: "video", url: V(n), bytes: 5_000_000, mime: "video/mp4",
                                   durationMs: 20_000, width: 1080, height: 1920, sha256: "c".repeat(64), ...extra });
const GID = "gid://shopify/Product/1";

// ── A fake RTDB with the real one's semantics (empty containers vanish) ──────
function fakeDb(initial = {}) {
  let store = rtdbRoundTrip(initial) || {};
  const writes = [];
  const parts = (p) => p.split("/").filter(Boolean);
  const get = (p) => parts(p).reduce((n, k) => (n == null ? null : n[k] ?? null), store);
  const put = (p, v) => {
    const ks = parts(p);
    const clone = JSON.parse(JSON.stringify(store));
    let n = clone;
    for (const k of ks.slice(0, -1)) { if (typeof n[k] !== "object" || n[k] === null) n[k] = {}; n = n[k]; }
    if (v === null || v === undefined) delete n[ks.at(-1)]; else n[ks.at(-1)] = v;
    store = rtdbRoundTrip(clone) || {};
  };
  const ref = (p) => ({
    get: async () => ({ val: () => get(p) }),
    set: async (v) => { writes.push(["set", p]); put(p, v); },
    remove: async () => { writes.push(["remove", p]); put(p, null); },
    child: (k) => ref(`${p}/${k}`),
  });
  return { db: { ref }, writes, get: (p) => get(p) };
}

// ── A fake Shopify product whose media processes asynchronously ──────────────
function fakeShopify({ readyAfterReads = 1, initial = [] } = {}) {
  const s = { media: initial.map((m) => ({ ...m })), mutations: [], next: 100, reads: 0 };
  const graphql = async (q, v) => {
    if (/productCreateMedia/.test(q)) {
      s.mutations.push(["create", v.media.map((m) => m.mediaContentType)]);
      const made = v.media.map((m) => ({ id: `gid://shopify/Media/${s.next++}`, status: "UPLOADED",
        mediaContentType: m.mediaContentType, alt: m.alt, src: m.originalSource, age: 0 }));
      s.media.push(...made);
      return { productCreateMedia: { media: made.map(({ id, status, mediaContentType }) => ({ id, status, mediaContentType })), mediaUserErrors: [] } };
    }
    if (/productDeleteMedia/.test(q)) {
      s.mutations.push(["delete", v.mediaIds]);
      s.media = s.media.filter((m) => !v.mediaIds.includes(m.id));
      return { productDeleteMedia: { deletedMediaIds: v.mediaIds, mediaUserErrors: [] } };
    }
    if (/productReorderMedia/.test(q)) {
      s.mutations.push(["reorder", v.moves]);
      for (const mv of v.moves) {
        const i = s.media.findIndex((m) => m.id === mv.id);
        const [m] = s.media.splice(i, 1);
        s.media.splice(Number(mv.newPosition), 0, m);
      }
      return { productReorderMedia: { job: { id: "j", done: false }, mediaUserErrors: [] } };
    }
    if (/stagedUploadsCreate/.test(q)) throw new Error("the injected uploader should be used");
    if (/media\(first: 250\)/.test(q)) {
      s.reads += 1;
      for (const m of s.media) { m.age = (m.age || 0) + 1; if (m.status !== "READY" && m.status !== "FAILED" && m.age > readyAfterReads) m.status = "READY"; }
      return { product: { id: GID, media: { pageInfo: { hasNextPage: false },
        nodes: s.media.map(({ id, status, mediaContentType, alt }) => ({ id, status, mediaContentType, alt, mediaErrors: [] })) } } };
    }
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  };
  return { s, graphql };
}

const live = (media, extra = {}) => ({ state: "live", liveState: "on", desiredState: "on", cleanName: "Plain tee black",
                                      media, photos: media.filter((m) => m.type === "photo").map((m) => m.url), ...extra });

function makeUploader() {
  const calls = [];
  return { calls, upload: async (_g, item) => { calls.push(item.id); return `https://shopify-staged.example/${item.id}`; } };
}

async function tick(env, node, opts = {}) {
  return syncProductMedia({ graphql: env.shop.graphql, db: env.fdb.db, pid: "p1", gid: GID, node, product: null,
                            title: "Plain tee black", mode: "live", videoBudget: 1, uploadVideo: env.up.upload, pollMs: 0, ...opts });
}

let env;
beforeEach(() => { env = { fdb: fakeDb(), shop: fakeShopify(), up: makeUploader() }; });

describe("the full ordered set, primary first", () => {
  it("pushes several photos and a video in list order, alt = the validated listing name on every item", async () => {
    const node = live([photo(1), video(1), photo(2)]);
    await tick(env, node);
    const order = env.shop.s.media.map((m) => m.src);
    expect(order).toEqual([U(1), "https://shopify-staged.example/mv1", U(2)]);
    expect(env.shop.s.media.every((m) => m.alt === "Plain tee black")).toBe(true);
  });
  it("reorderMoves reproduces any target exactly as Shopify applies moves (sequentially)", () => {
    const cur = ["a", "b", "c", "d", "x"];
    for (const target of [["d", "c", "b", "a"], ["b", "a"], ["a", "b", "c", "d"], []]) {
      const list = [...cur];
      for (const mv of reorderMoves(cur, target)) {
        const [m] = list.splice(list.indexOf(mv.id), 1);
        list.splice(Number(mv.newPosition), 0, m);
      }
      expect(list.slice(0, target.length)).toEqual(target);
      expect(list).toContain("x"); // anything not ours keeps its place after
    }
    expect(reorderMoves(cur, ["a", "b"])).toEqual([]);
  });
});

describe("a video's bytes go to Shopify EXACTLY ONCE, across ticks", () => {
  it("tick 1 uploads + attaches, tick 2 polls processing, tick 3 sees READY — one upload in all", async () => {
    env.shop = fakeShopify({ readyAfterReads: 3 });
    const node = live([photo(1), video(1)]);
    const t1 = await tick(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(t1.pending).toBe(true);
    expect(env.fdb.get(`${MEDIA_PENDING_PATH}/p1`)).toBe(true);
    const rec = env.fdb.get("shopify_sync/p1/media/items/mv1");
    expect(rec).toMatchObject({ resourceUrl: "https://shopify-staged.example/mv1", uploadAttempts: 1 });
    const n2 = { ...node, mediaShopify: env.fdb.get("shopify_publish/p1/mediaShopify") };
    await tick(env, n2);
    await tick(env, n2);
    const t4 = await tick(env, n2);
    expect(env.up.calls).toEqual(["mv1"]);   // never again
    expect(t4.pending).toBe(false);
    expect(env.fdb.get(`${MEDIA_PENDING_PATH}/p1`)).toBeNull();
    expect(env.fdb.get("shopify_publish/p1/mediaShopify")).toEqual({ mp1: { status: "ready" }, mv1: { status: "ready" } });
    expect(env.shop.s.mutations.filter((m) => m[0] === "create").length).toBe(2); // photos once, video attach once
  });
  it("an attach that fails is retried with the SAME resourceUrl — the bytes are not sent again", async () => {
    const node = live([photo(1), video(1)]);
    const real = env.shop.graphql;
    let failOnce = true;
    env.shop.graphql = async (q, v) => {
      if (failOnce && /productCreateMedia/.test(q) && v.media[0].mediaContentType === "VIDEO") { failOnce = false; throw new Error("blip"); }
      return real(q, v);
    };
    await tick(env, node);
    await tick(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.shop.s.media.some((m) => m.src === "https://shopify-staged.example/mv1")).toBe(true);
  });
  it("a video Shopify FAILED is taken off and marked failed — and NOT re-uploaded", async () => {
    const node = live([photo(1), video(1)]);
    await tick(env, node);
    env.shop.s.media.find((m) => m.mediaContentType === "VIDEO").status = "FAILED";
    await tick(env, node);
    await tick(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv1").status).toBe("failed");
    expect(env.shop.s.media.some((m) => m.mediaContentType === "VIDEO")).toBe(false);
  });
  it("uploads are capped per tick; the rest stay queued and pending", async () => {
    const node = live([photo(1), video(1), video(2), video(3)]);
    await tick(env, node, { videoBudget: 1 });
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv2").status).toBe("queued");
    await tick(env, node, { videoBudget: 1 });
    expect(env.up.calls).toEqual(["mv1", "mv2"]);
  });
});

describe("re-running with nothing changed", () => {
  it("makes ZERO Shopify writes and ZERO Storage downloads, and the live phase skips it without a Shopify read", async () => {
    const node = live([photo(1), photo(2), video(1)]);
    for (let i = 0; i < 4; i++) await tick(env, { ...node, mediaShopify: env.fdb.get("shopify_publish/p1/mediaShopify") });
    const settled = { ...node, mediaShopify: env.fdb.get("shopify_publish/p1/mediaShopify"),
                      mediaSyncedSig: env.fdb.get("shopify_publish/p1/mediaSyncedSig") };
    expect(settled.mediaSyncedSig).toBe(pushSigFor(node, null));
    // The live phase's gate: no Shopify call at all.
    expect(needsLiveMediaSync(settled, null, { pending: false })).toBe(false);
    // And even if run anyway: no mutation, no upload, no RTDB write.
    const muts = env.shop.s.mutations.length;
    const dbWrites = env.fdb.writes.length;
    const r = await tick(env, settled);
    expect(r.writes).toBe(0);
    expect(env.shop.s.mutations.length).toBe(muts);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.fdb.writes.length).toBe(dbWrites);
  });
});

describe("removal: only what this system created", () => {
  it("drops an item from Shopify when it leaves the list; leaves media it did not create alone", async () => {
    env.shop = fakeShopify({ initial: [{ id: "gid://shopify/Media/9", status: "READY", mediaContentType: "IMAGE", src: "admin-upload" }] });
    const node = live([photo(1), photo(2)]);
    await tick(env, node);   // no fingerprint → the admin's photo is foreign
    await tick(env, live([photo(1)]));
    const srcs = env.shop.s.media.map((m) => m.src);
    expect(srcs).toEqual([U(1), "admin-upload"]); // ours first, theirs untouched
    expect(env.fdb.get("shopify_sync/p1/media/items/mp2")).toBeNull();
  });
  it("replaces the photo set the OLD path attached (proven by its fingerprint) — new ones in first, old removed last", async () => {
    env.fdb = fakeDb({ shopify_sync: { p1: { shopifyProductId: GID, mediaFingerprint: "abc" } } });
    env.shop = fakeShopify({ initial: [
      { id: "gid://shopify/Media/1", status: "READY", mediaContentType: "IMAGE", src: "old-1" },
      { id: "gid://shopify/Media/2", status: "READY", mediaContentType: "IMAGE", src: "old-2" }] });
    await tick(env, live([photo(1), photo(2)]));
    const kinds = env.shop.s.mutations.map((m) => m[0]);
    expect(kinds.indexOf("create")).toBeLessThan(kinds.indexOf("delete")); // never imageless in between
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), U(2)]);
  });
  it("removing EVERY extra empties the record the way the real database does", async () => {
    await tick(env, live([photo(1), photo(2), video(1)]));
    await tick(env, live([photo(1)]));
    expect(Object.keys(env.fdb.get("shopify_sync/p1/media/items"))).toEqual(["mp1"]);
    expect(Object.keys(env.fdb.get("shopify_publish/p1/mediaShopify"))).toEqual(["mp1"]);
  });
});

describe("oversize video: kept, never pushed", () => {
  it("a 2 GB video is never uploaded and gets no Shopify status; the rest of the list syncs", async () => {
    const node = live([photo(1), video(1, { bytes: 2_000_000_000 })]);
    const r = await tick(env, node);
    expect(env.up.calls).toEqual([]);
    expect(env.shop.s.media.length).toBe(1);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv1")).toBeNull();
    expect(r.ok).toBe(true);
  });
});

describe("the publish path (mode on)", () => {
  it("waits for every photo to be READY and only queues videos", async () => {
    env.shop = fakeShopify({ readyAfterReads: 2 });
    const r = await tick(env, live([photo(1), photo(2), video(1)]), { mode: "on", pollTries: 5 });
    expect(r.ok).toBe(true);
    expect(env.up.calls).toEqual([]);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv1").status).toBe("queued");
    expect(env.fdb.get(`${MEDIA_PENDING_PATH}/p1`)).toBe(true);
  });
  it("refuses a list with no photo first", async () => {
    const r = await tick(env, live([video(1)]), { mode: "on" });
    expect(r.ok).toBe(false);
  });
});

describe("planMediaSync (pure)", () => {
  it("does nothing for a list already on Shopify, READY and in order", () => {
    const p = planMediaSync({
      desired: [photo(1)], record: { mp1: { type: "photo", shopifyMediaId: "m1" } },
      shopify: [{ id: "m1", status: "READY" }],
    });
    expect([p.createPhotos, p.uploadVideos, p.attachVideos, p.removeIds, p.legacyIds].every((a) => a.length === 0)).toBe(true);
  });
});

describe("uploadVideoToShopify — the bytes Shopify receives are the bytes in Storage", () => {
  it("streams the exact bytes in a multipart POST (file last) and checks the hash in flight", async () => {
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256));
    const sha = createHash("sha256").update(bytes).digest("hex");
    let received = null;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { received = { body: Buffer.concat(chunks), len: Number(req.headers["content-length"]) }; res.writeHead(201); res.end(); });
    });
    await new Promise((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${server.address().port}/upload`;
    const graphql = async (q, v) => {
      expect(v.input[0]).toMatchObject({ resource: "VIDEO", fileSize: String(bytes.length), httpMethod: "POST", mimeType: "video/mp4" });
      expect(v.input[0].filename).toBe("video_mv1.mp4"); // never the picked file's name
      return { stagedUploadsCreate: { stagedTargets: [{ url, resourceUrl: "https://res/1", parameters: [{ name: "key", value: "k" }, { name: "policy", value: "p" }] }], userErrors: [] } };
    };
    const fetchImpl = async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    const res = await uploadVideoToShopify(graphql, video(1, { bytes: bytes.length, sha256: sha }), { fetchImpl, request: http.request });
    server.close();
    expect(res).toBe("https://res/1");
    expect(received.len).toBe(received.body.length);
    const body = received.body;
    const start = body.indexOf(Buffer.from("Content-Type: video/mp4\r\n\r\n")) + "Content-Type: video/mp4\r\n\r\n".length;
    const fileBytes = body.subarray(start, start + bytes.length);
    expect(createHash("sha256").update(fileBytes).digest("hex")).toBe(sha); // byte-identical
    expect(body.indexOf(Buffer.from('name="key"'))).toBeLessThan(body.indexOf(Buffer.from('name="file"'))); // file LAST
  });
  it("refuses when the Storage bytes do not match the hash recorded at pick time", async () => {
    const bytes = Buffer.from("not the picked file");
    const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(201); res.end(); }); });
    await new Promise((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${server.address().port}/u`;
    const graphql = async () => ({ stagedUploadsCreate: { stagedTargets: [{ url, resourceUrl: "r", parameters: [] }], userErrors: [] } });
    await expect(uploadVideoToShopify(graphql, video(1, { bytes: bytes.length, sha256: "d".repeat(64) }),
      { fetchImpl: async () => new Response(bytes), request: http.request })).rejects.toThrow(/do not match/);
    server.close();
  });
});

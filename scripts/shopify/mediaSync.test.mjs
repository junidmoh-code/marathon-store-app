import { describe, it, expect, beforeEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import {
  planMediaSync, reorderMoves, syncProductMedia, needsLiveMediaSync, pushSigFor, uploadVideoToShopify,
  sendNextQueuedVideo, recordPatch, MEDIA_PENDING_PATH,
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
    update: async (obj) => {
      writes.push(["update", p]);
      for (const [k, v] of Object.entries(obj)) put(`${p}/${k}`, v);
    },
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
    if (/fileUpdate/.test(q)) {
      s.mutations.push(["alt", v.files.map((f) => f.id)]);
      for (const f of v.files) { const m = s.media.find((x) => x.id === f.id); if (m) m.alt = f.alt; }
      return { fileUpdate: { files: v.files.map((f) => ({ id: f.id })), userErrors: [] } };
    }
    if (/stagedUploadsCreate/.test(q)) throw new Error("the injected uploader should be used");
    if (/media\(first: 250\)/.test(q)) {
      s.reads += 1;
      for (const m of s.media) { m.age = (m.age || 0) + 1; if (m.status !== "READY" && m.status !== "FAILED" && m.age > readyAfterReads) m.status = "READY"; }
      return { product: { id: GID, media: { pageInfo: { hasNextPage: false },
        nodes: s.media.map(({ id, status, mediaContentType, alt }) => ({ id, status, mediaContentType, alt, mediaErrors: [],
          preview: mediaContentType === "VIDEO" && status === "READY" ? { image: { url: `https://cdn.example/${id.split("/").pop()}.jpg` } } : null })) } } };
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
                            title: "Plain tee black", mode: "live", pollMs: 0, ...opts });
}
// The video runner's one step (its own launchd job in production).
const send = (env, node) => sendNextQueuedVideo({ graphql: env.shop.graphql, db: env.fdb.db, pid: "p1", node, upload: env.up.upload });
// Ticks + runner steps until the product settles (or n rounds).
async function settle(env, node, n = 6) {
  let r;
  for (let i = 0; i < n; i++) { await send(env, node); r = await tick(env, node); if (!r.pending) break; }
  return r;
}

let env;
beforeEach(() => { env = { fdb: fakeDb(), shop: fakeShopify(), up: makeUploader() }; });

describe("the full ordered set, primary first", () => {
  it("pushes several photos and a video in list order, alt = the validated listing name on every item", async () => {
    const node = live([photo(1), video(1), photo(2)]);
    const r = await settle(env, node);
    expect(r.pending).toBe(false);
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), "https://shopify-staged.example/mv1", U(2)]);
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
  it("a rename re-labels every item's alt text", async () => {
    const node = live([photo(1), photo(2)]);
    await settle(env, node);
    const renamed = { ...node, cleanName: "Plain tee charcoal" };
    expect(needsLiveMediaSync({ ...renamed, mediaSyncedSig: pushSigFor(node, null) }, null)).toBe(true);
    await tick(env, renamed, { title: "Plain tee charcoal" });
    expect(env.shop.s.media.every((m) => m.alt === "Plain tee charcoal")).toBe(true);
  });
});

describe("a video's bytes go to Shopify EXACTLY ONCE, and never inside the tick", () => {
  it("the tick never uploads: it queues; the runner sends once; the tick attaches and polls to READY", async () => {
    env.shop = fakeShopify({ readyAfterReads: 3 });
    const node = live([photo(1), video(1)]);
    const t1 = await tick(env, node);
    expect(env.up.calls).toEqual([]);                       // nothing moved inside the tick
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv1").status).toBe("queued");
    expect(t1.pending).toBe(true);
    expect(env.fdb.get(`${MEDIA_PENDING_PATH}/p1`)).toBe(true);
    expect((await send(env, node)).sent).toBe(true);
    expect(env.fdb.get("shopify_sync/p1/media/items/mv1")).toMatchObject({ resourceUrl: "https://shopify-staged.example/mv1" });
    for (let i = 0; i < 6; i++) { await tick(env, node); await send(env, node); }
    expect(env.up.calls).toEqual(["mv1"]);                  // never again
    expect(env.fdb.get(`${MEDIA_PENDING_PATH}/p1`)).toBeNull();
    // A READY video carries Shopify's own preview frame — the strip's poster
    // when the phone could not draw one at upload.
    expect(env.fdb.get("shopify_publish/p1/mediaShopify")).toEqual({ mp1: { status: "ready" },
      mv1: { status: "ready", previewUrl: expect.stringMatching(/^https:\/\/cdn\.example\//) } });
    expect(env.shop.s.mutations.filter((m) => m[0] === "create").length).toBe(2); // photos once, video attach once
  });
  it("the tick's own record writes never overwrite the runner's resourceUrl (field-level)", async () => {
    const node = live([photo(1), video(1)]);
    await tick(env, node);
    await send(env, node);
    // A tick that read the record BEFORE the runner finished still only writes the fields it changed.
    expect(recordPatch({ mv1: { status: "queued", url: "u" } }, { mv1: { status: "queued", url: "u", type: "video" } }))
      .toEqual({ "items/mv1/type": "video" });
    await tick(env, node);
    expect(env.fdb.get("shopify_sync/p1/media/items/mv1/resourceUrl")).toBe("https://shopify-staged.example/mv1");
  });
  it("an attach that fails is retried with the SAME resourceUrl — the bytes are not sent again", async () => {
    const node = live([photo(1), video(1)]);
    const real = env.shop.graphql;
    let failOnce = true;
    env.shop.graphql = async (q, v) => {
      if (failOnce && /productCreateMedia/.test(q) && v.media[0].mediaContentType === "VIDEO") { failOnce = false; throw new Error("blip"); }
      return real(q, v);
    };
    await settle(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.shop.s.media.some((m) => m.src === "https://shopify-staged.example/mv1")).toBe(true);
  });
  it("a video Shopify FAILED is taken off and marked failed — and NOT re-uploaded", async () => {
    const node = live([photo(1), video(1)]);
    await send(env, node); await tick(env, node);
    env.shop.s.media.find((m) => m.mediaContentType === "VIDEO").status = "FAILED";
    await settle(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv1").status).toBe("failed");
    expect(env.shop.s.media.some((m) => m.mediaContentType === "VIDEO")).toBe(false);
  });
  it("a transfer that dies before Shopify accepts it records no resourceUrl and is sent again (the bytes never landed)", async () => {
    const node = live([photo(1), video(1)]);
    let die = true;
    const upload = async (g, item) => { if (die) { die = false; throw new Error("connection reset"); } return env.up.upload(g, item); };
    await sendNextQueuedVideo({ graphql: env.shop.graphql, db: env.fdb.db, pid: "p1", node, upload });
    expect(env.fdb.get("shopify_sync/p1/media/items/mv1")).toMatchObject({ uploadAttempts: 1, status: "queued" });
    await sendNextQueuedVideo({ graphql: env.shop.graphql, db: env.fdb.db, pid: "p1", node, upload });
    expect(env.up.calls).toEqual(["mv1"]);
  });
  it("one video per runner step; the rest stay queued and pending", async () => {
    const node = live([photo(1), video(1), video(2), video(3)]);
    await tick(env, node);
    await send(env, node);
    expect(env.up.calls).toEqual(["mv1"]);
    await tick(env, node);
    expect(env.fdb.get("shopify_publish/p1/mediaShopify/mv2").status).toBe("queued");
    await send(env, node);
    expect(env.up.calls).toEqual(["mv1", "mv2"]);
  });
});

describe("re-running with nothing changed", () => {
  it("makes ZERO Shopify writes, ZERO Storage downloads and ZERO database writes; the live phase skips it without a Shopify read", async () => {
    const node = live([photo(1), photo(2), video(1)]);
    await settle(env, node);
    const settled = { ...node, mediaShopify: env.fdb.get("shopify_publish/p1/mediaShopify"),
                      mediaSyncedSig: env.fdb.get("shopify_publish/p1/mediaSyncedSig") };
    expect(settled.mediaSyncedSig).toBe(pushSigFor(node, null));
    expect(needsLiveMediaSync(settled, null, { pending: false })).toBe(false);
    const muts = env.shop.s.mutations.length;
    const dbWrites = env.fdb.writes.length;
    const r = await tick(env, settled);
    expect((await send(env, settled)).sent).toBe(false);
    expect(r.writes).toBe(0);
    expect(env.shop.s.mutations.length).toBe(muts);
    expect(env.up.calls).toEqual(["mv1"]);
    expect(env.fdb.writes.length).toBe(dbWrites);
  });
});

describe("a live product is never without its photos", () => {
  it("swapping the primary: the old photo stays on Shopify until the new one is READY", async () => {
    await settle(env, live([photo(1)]));
    env.shop = { ...env.shop };
    const node = live([photo(2)]);
    const real = env.shop.graphql;
    // The new photo takes a few reads to process.
    await tick(env, node);
    const newOne = env.shop.s.media.find((m) => m.src === U(2));
    newOne.status = "UPLOADED"; newOne.age = -5;
    await tick(env, node);
    expect(env.shop.s.media.map((m) => m.src)).toContain(U(1));          // not removed yet
    newOne.age = 10;
    await tick(env, node);
    await tick(env, node);
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(2)]);
    void real;
  });
  it("a photo Shopify FAILED (a transient fetch error) is retried, not lost", async () => {
    const node = live([photo(1)]);
    await tick(env, node);
    env.shop.s.media[0].status = "FAILED";
    await settle(env, node);
    expect(env.shop.s.media.map((m) => [m.src, m.status])).toEqual([[U(1), "READY"]]);
  });
  it("a create whose answer was lost is adopted on the next tick, never duplicated", async () => {
    const node = live([photo(1), photo(2)]);
    const real = env.shop.graphql;
    let lose = true;
    env.shop.graphql = async (q, v) => {
      const out = await real(q, v);
      if (lose && /productCreateMedia/.test(q)) { lose = false; throw new Error("socket hang up (the create DID happen)"); }
      return out;
    };
    await expect(tick(env, node)).rejects.toThrow(/hang up/);
    expect(env.fdb.get("shopify_sync/p1/media/inflight")).toBeTruthy();
    await settle(env, node);
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), U(2)]);  // two, not four
    expect(env.fdb.get("shopify_sync/p1/media/inflight")).toBeNull();
  });
});

describe("removal: only what this system created", () => {
  it("drops an item from Shopify when it leaves the list; leaves media it did not create alone", async () => {
    env.shop = fakeShopify({ initial: [{ id: "gid://shopify/Media/9", status: "READY", mediaContentType: "IMAGE", src: "admin-upload" }] });
    await settle(env, live([photo(1), photo(2)]));   // no fingerprint → the admin's photo is foreign
    await settle(env, live([photo(1)]));
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), "admin-upload"]); // ours first, theirs untouched
    expect(env.fdb.get("shopify_sync/p1/media/items/mp2")).toBeNull();
  });
  it("replaces the photo set the OLD path attached — new ones in and READY first, old removed last, even if a removal fails once", async () => {
    env.fdb = fakeDb({ shopify_sync: { p1: { shopifyProductId: GID, mediaFingerprint: "abc", mediaCount: 2 } } });
    env.shop = fakeShopify({ initial: [
      { id: "gid://shopify/Media/1", status: "READY", mediaContentType: "IMAGE", src: "old-1" },
      { id: "gid://shopify/Media/2", status: "READY", mediaContentType: "IMAGE", src: "old-2" }] });
    const real = env.shop.graphql;
    let failDelete = true;
    env.shop.graphql = async (q, v) => {
      if (failDelete && /productDeleteMedia/.test(q)) { failDelete = false; throw new Error("blip"); }
      return real(q, v);
    };
    const node = live([photo(1), photo(2)]);
    await tick(env, node);
    expect(env.shop.s.media.length).toBe(4); // never imageless: old still up while new process
    for (let i = 0; i < 4; i++) { try { await tick(env, node); } catch { /* the one failed delete */ } }
    const kinds = env.shop.s.mutations.map((m) => m[0]);
    expect(kinds.indexOf("create")).toBeLessThan(kinds.indexOf("delete"));
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), U(2)]);
  });
  it("a legacy set whose count does not match what the old path attached is NOT taken as ours", async () => {
    env.fdb = fakeDb({ shopify_sync: { p1: { shopifyProductId: GID, mediaFingerprint: "abc", mediaCount: 1 } } });
    env.shop = fakeShopify({ initial: [
      { id: "gid://shopify/Media/1", status: "READY", mediaContentType: "IMAGE", src: "old-1" },
      { id: "gid://shopify/Media/2", status: "READY", mediaContentType: "IMAGE", src: "admin-added" }] });
    await settle(env, live([photo(1)]));
    expect(env.shop.s.media.map((m) => m.src)).toEqual([U(1), "old-1", "admin-added"]);
  });
  it("removing EVERY extra empties the record the way the real database does", async () => {
    await settle(env, live([photo(1), photo(2), video(1)]));
    await settle(env, live([photo(1)]));
    expect(Object.keys(env.fdb.get("shopify_sync/p1/media/items"))).toEqual(["mp1"]);
    expect(Object.keys(env.fdb.get("shopify_publish/p1/mediaShopify"))).toEqual(["mp1"]);
  });
});

describe("oversize video: kept, never pushed", () => {
  it("a 2 GB video is never sent and gets no Shopify status; the rest of the list syncs", async () => {
    const node = live([photo(1), video(1, { bytes: 2_000_000_000 })]);
    const r = await settle(env, node);
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
  it("refuses a list with no photo first, as not retryable", async () => {
    const r = await tick(env, live([video(1)]), { mode: "on" });
    expect(r).toMatchObject({ ok: false, retryable: false });
  });
});

describe("planMediaSync (pure)", () => {
  it("does nothing for a list already on Shopify, READY and in order", () => {
    const p = planMediaSync({
      desired: [photo(1)], record: { mp1: { type: "photo", shopifyMediaId: "m1" } },
      shopify: [{ id: "m1", status: "READY" }],
    });
    expect([p.createPhotos, p.attachVideos, p.failedIds].every((a) => a.length === 0)).toBe(true);
    expect(Object.values(p.record).some((r) => r.remove)).toBe(false);
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

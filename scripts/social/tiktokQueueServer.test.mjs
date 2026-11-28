// ── TIKTOK HANDOFF QUEUE — server tests (tiktok-queue-server.mjs) ───────────
// Real HTTP against a temp queue directory: reads, media, and the token-
// protected marks Junid's Claude chat sends.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tiktok-queue-test-"));
const TOKEN = "a".repeat(64);
let base, server;

const today = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
const batch = {
  batch_id: `${today}-evening`, slot: "evening", date: today, generated_at: new Date().toISOString(),
  posts: [
    { post_id: "-Pone", media_type: "PHOTO", media_urls: ["https://x/media/-Pone/1.jpg"], caption: "One", hashtags: ["#MarathonClub", "#OOTD", "#SouthAfrica"] },
    { post_id: "-Ptwo", media_type: "VIDEO", media_urls: ["https://x/media/-Ptwo/1.mp4"], caption: "Two", hashtags: ["#MarathonClub", "#SneakerTok", "#SouthAfrica"] },
  ],
};

beforeAll(async () => {
  mkdirSync(join(dir, "batches"), { recursive: true });
  mkdirSync(join(dir, "media", "-Pone"), { recursive: true });
  writeFileSync(join(dir, "batches", `${today}-evening.json`), JSON.stringify(batch));
  mkdirSync(join(dir, "poster"), { recursive: true });
  writeFileSync(join(dir, "poster", "ledger.json"), JSON.stringify({ families: {} }));
  process.env.TIKTOK_POSTER_STATE = join(dir, "poster");
  writeFileSync(join(dir, "latest.json"), JSON.stringify(batch));
  writeFileSync(join(dir, "media", "-Pone", "1.jpg"), Buffer.from("0123456789"));
  writeFileSync(join(dir, "token"), `${TOKEN}\n`);
  process.env.TIKTOK_QUEUE_DIR = dir;
  process.env.TIKTOK_QUEUE_TOKEN_FILE = join(dir, "token");
  const { handle } = await import("./tiktok-queue-server.mjs");
  server = createServer((q, r) => handle(q, r));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { server?.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, token = TOKEN) => fetch(`${base}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

describe("reads", () => {
  it("serves latest.json with status, with or without the Funnel prefix", async () => {
    for (const p of ["/latest.json", "/studio/tiktok-queue/latest.json"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.batch_id).toBe(`${today}-evening`);
      expect(j.posts.map((x) => x.status)).toEqual(["pending", "pending"]);
      expect(j.stale).toBe(false);
    }
  });
  it("serves media with the right type and byte ranges", async () => {
    const r = await fetch(`${base}/media/-Pone/1.jpg`);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("0123456789");
    const part = await fetch(`${base}/media/-Pone/1.jpg`, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("234");
  });
  it("never serves anything outside the media folders", async () => {
    for (const p of ["/media/..%2F/posted.json", "/media/-Pone/../../token", "/token", "/posted.json", "/media/-Pone/1.png"]) {
      expect((await fetch(`${base}${p}`)).status).toBe(404);
    }
  });
});

describe("marks", () => {
  it("refuses a missing or wrong token", async () => {
    expect((await post("/mark-posted", { post_id: "-Pone" }, null)).status).toBe(401);
    expect((await post("/mark-posted", { post_id: "-Pone" }, "b".repeat(64))).status).toBe(401);
    expect(readFileSafe("posted.json")).toBeNull();
  });
  it("refuses ids that are malformed or were never in a batch", async () => {
    expect((await post("/mark-posted", { post_id: "../x" })).status).toBe(400);
    expect((await post("/mark-posted", { post_id: "-Pnever" })).status).toBe(404);
  });
  it("marks a post posted, idempotently, and latest.json shows it", async () => {
    const r = await post("/mark-posted", { post_id: "-Pone", tiktok_url: "https://www.tiktok.com/@marathon.club7/photo/123" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "posted", already: false });
    const again = await (await post("/mark-posted", { post_id: "-Pone" })).json();
    expect(again.already).toBe(true);
    const posted = JSON.parse(readFileSafe("posted.json"));
    expect(posted["-Pone"].tiktok_url).toBe("https://www.tiktok.com/@marathon.club7/photo/123");
    const j = await (await fetch(`${base}/latest.json`)).json();
    expect(j.posts[0]).toMatchObject({ status: "posted" });
    expect(j.pending).toBe(1);
  });
  it("X-Queue-Token works too; skip and unmark", async () => {
    const r = await fetch(`${base}/mark-skipped`, { method: "POST", headers: { "x-queue-token": TOKEN }, body: JSON.stringify({ post_id: "-Ptwo" }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSafe("skipped.json"))["-Ptwo"]).toBeTruthy();
    const u = await (await post("/unmark", { post_id: "-Ptwo" })).json();
    expect(u.removed).toBe(true);
    expect(JSON.parse(readFileSafe("skipped.json"))["-Ptwo"]).toBeUndefined();
  });
  it("concurrent marks all land (one writer, in order)", async () => {
    await post("/unmark", { post_id: "-Pone" });
    await Promise.all([post("/mark-posted", { post_id: "-Pone" }), post("/mark-posted", { post_id: "-Ptwo" })]);
    expect(Object.keys(JSON.parse(readFileSafe("posted.json"))).sort()).toEqual(["-Pone", "-Ptwo"]);
  });
  it("GET form with ?token= marks too; wrong token or HEAD never does", async () => {
    await post("/unmark", { post_id: "-Pone" });
    expect((await fetch(`${base}/mark-posted?post_id=-Pone&token=nope`)).status).toBe(401);
    expect((await fetch(`${base}/mark-posted?post_id=-Pone&token=${TOKEN}`, { method: "HEAD" })).status).toBe(404);
    expect(JSON.parse(readFileSafe("posted.json"))["-Pone"]).toBeUndefined();
    const r = await fetch(`${base}/studio/tiktok-queue/mark-posted?post_id=-Pone&token=${TOKEN}`);
    expect(await r.json()).toMatchObject({ ok: true, status: "posted" });
  });
  it("GET cannot unmark (POST only)", async () => {
    expect((await fetch(`${base}/unmark?post_id=-Pone&token=${TOKEN}`)).status).toBe(404);
  });
  it("an unreadable posted.json refuses the mark and is left as it was", async () => {
    writeFileSync(join(dir, "posted.json"), "{broken");
    const r = await post("/mark-posted", { post_id: "-Ptwo" });
    expect(r.status).toBe(500);
    expect(readFileSafe("posted.json")).toBe("{broken");
    writeFileSync(join(dir, "posted.json"), "{}");
  });
  it("a family the Signal Studio poster sent shows as posted", async () => {
    writeFileSync(join(dir, "poster", "ledger.json"), JSON.stringify({ families: { "-Ptwo": { state: "live" } } }));
    const j = await (await fetch(`${base}/latest.json`)).json();
    expect(j.posts[1]).toMatchObject({ status: "posted", posted_via: "signal-studio" });
    writeFileSync(join(dir, "poster", "ledger.json"), JSON.stringify({ families: {} }));
  });
  it("a poster refusal (nothing created) stays pending", async () => {
    writeFileSync(join(dir, "poster", "ledger.json"), JSON.stringify({ families: { "-Ptwo": { state: "refused", attempts: 3 } } }));
    const j = await (await fetch(`${base}/latest.json`)).json();
    expect(j.posts[1].status).not.toBe("posted");
    writeFileSync(join(dir, "poster", "ledger.json"), JSON.stringify({ families: {} }));
  });
  it("unmark with one unreadable file changes nothing", async () => {
    await post("/mark-posted", { post_id: "-Pone" });
    const before = readFileSafe("posted.json");
    writeFileSync(join(dir, "skipped.json"), "[broken");
    expect((await post("/unmark", { post_id: "-Pone" })).status).toBe(500);
    expect(readFileSafe("posted.json")).toBe(before);
    writeFileSync(join(dir, "skipped.json"), "{}");
  });
  it("rejects bad JSON", async () => {
    const r = await fetch(`${base}/mark-posted`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{nope" });
    expect(r.status).toBe(400);
  });
});

function readFileSafe(name) { try { return readFileSync(join(dir, name), "utf8"); } catch { return null; } }

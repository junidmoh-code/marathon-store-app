#!/usr/bin/env node
// ── TIKTOK HANDOFF QUEUE: PUBLIC SERVER (Mac mini) ───────────────────────────
// Serves the batches tiktok-queue-build.mjs writes, for Junid's Claude chat,
// at the Tailscale Funnel host:
//
//   https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue/latest.json
//
// Funnel sends /studio/tiktok-queue here (127.0.0.1:8798); the rest of /studio
// stays with Signal Studio. Routes (with or without the /studio/tiktok-queue
// prefix, whichever way the proxy hands them over):
//   GET  /latest.json              newest batch, each post with status pending|posted|skipped
//   GET  /batches/<date>-<slot>.json
//   GET  /media/<post_id>/<n>.jpg|mp4   direct download, no auth, Range supported
//   GET  /health
// Everything here is public by design (it is what goes on TikTok anyway);
// nothing reads outside ~/.marathon-tiktok-queue. docs/tiktok-queue.md.
//
// WRITES (token required: Authorization: Bearer <token>, or X-Queue-Token):
//   POST /mark-posted   {post_id, tiktok_url?, note?}  Junid's chat confirms the post is live on TikTok
//   POST /mark-skipped  {post_id, note?}               Junid does not want this one; never offered again
//   POST /unmark        {post_id}                      undo either (a mistaken mark)
// mark-posted and mark-skipped also work as a GET with query parameters (?post_id=..&token=..) for chat
// tools that can only fetch URLs.
// The token is ~/.config/marathon/tiktok-queue.token (TIKTOK_QUEUE_TOKEN_FILE),
// read on every request so it can be rotated without a restart. This process
// is the only writer of posted.json and skipped.json; the builder and the
// Signal Studio poster only read them.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { BATCH_ID_RE, POST_ID_RE, applyMark, staleAfter } from "./tiktokHfQueue.mjs";
import { eligible } from "./tiktokQueue.mjs"; // eligible(undefined) is true: no entry, not sent

const DIR = process.env.TIKTOK_QUEUE_DIR || join(homedir(), ".marathon-tiktok-queue");
const PORT = Number(process.env.TIKTOK_QUEUE_PORT || 8798);
const HOST = process.env.TIKTOK_QUEUE_HOST || "127.0.0.1";
const PUBLIC_BASE = (process.env.TIKTOK_QUEUE_PUBLIC_BASE || "https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue").replace(/\/+$/, "");
const PREFIX = "/studio/tiktok-queue";
const POSTER_LEDGER = join(process.env.TIKTOK_POSTER_STATE || join(homedir(), ".marathon-tiktok"), "ledger.json");
const TYPES = { jpg: "image/jpeg", mp4: "video/mp4" };

const TOKEN_FILE = process.env.TIKTOK_QUEUE_TOKEN_FILE || join(homedir(), ".config", "marathon", "tiktok-queue.token");
const BODY_MAX = 8 * 1024;

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
/** For the files we rewrite: only a missing file is empty. Anything unreadable throws, so a mark never replaces history with {}. */
function readMap(f) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`${f} unreadable (${e.code})`); }
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${f} is not a map`);
  return v;
}
function writeJson(f, v) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 1));
  renameSync(tmp, f);
}

/** Constant-time token check. No token file → every write is refused. */
function authorized(req, query) {
  let want;
  try { want = readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return false; }
  if (want.length < 32) return false;
  const auth = String(req.headers.authorization || "");
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : String(req.headers["x-queue-token"] || query?.get("token") || "").trim();
  if (!got) return false;
  const h = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(got), h(want));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on("data", (d) => { size += d.length; if (size > BODY_MAX) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else parts.push(d); });
    req.on("end", () => {
      const text = Buffer.concat(parts).toString("utf8");
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(Object.assign(new Error("body is not JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/** Is this post_id in any batch we built? (Stops marks for ids that never went out.) */
function knownPost(postId) {
  let files = [];
  try { files = readdirSync(join(DIR, "batches")).filter((f) => f.endsWith(".json")); } catch { return false; }
  return files.some((f) => (readJson(join(DIR, "batches", f), { posts: [] }).posts || []).some((p) => p.post_id === postId));
}

// One write at a time, in arrival order.
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const MARKS = { "/mark-posted": "posted.json", "/mark-skipped": "skipped.json" };
async function mark(req, res, path, query = null) {
  if (!authorized(req, query)) { await new Promise((r) => setTimeout(r, 500)); return send(res, 401, { error: "bad or missing token" }); }
  let body;
  if (query) body = { post_id: query.get("post_id"), tiktok_url: query.get("tiktok_url") || undefined, note: query.get("note") || undefined };
  else { try { body = await readBody(req); } catch (e) { return send(res, e.status || 400, { error: e.message }); } }
  return serial(() => { try { return markNow(res, path, body); } catch (e) { console.error(e.message); return send(res, 500, { error: "queue state unreadable; nothing changed" }); } });
}

function markNow(res, path, body) {
  {
    const postId = body?.post_id;
    if (path === "/unmark") {
      if (typeof postId !== "string" || !POST_ID_RE.test(postId)) return send(res, 400, { error: "post_id missing or malformed" });
      // Read both before changing either, so an unreadable file means nothing changed.
      const maps = Object.values(MARKS).map((f) => [f, readMap(join(DIR, f))]);
      // Write every changed map to a temp file first, then rename: a failed write leaves both files as they were.
      const changed = maps.filter(([, map]) => map[postId]).map(([f, map]) => { delete map[postId]; return [f, map]; });
      const tmps = [];
      try {
        for (const [f, map] of changed) { const t = `${join(DIR, f)}.${process.pid}.unmark`; writeFileSync(t, JSON.stringify(map, null, 1)); tmps.push([t, join(DIR, f)]); }
      } catch (e) { for (const [t] of tmps) rmSync(t, { force: true }); throw e; }
      for (const [t, f] of tmps) renameSync(t, f);
      const removed = changed.length > 0;
      console.log(`${new Date().toISOString()} unmark ${postId}: ${removed ? "removed" : "nothing to remove"}`);
      return send(res, 200, { ok: true, post_id: postId, removed });
    }
    const file = join(DIR, MARKS[path]);
    const r = applyMark(readMap(file), postId, body || {}, knownPost);
    if (r.error) return send(res, r.error.includes("not in any batch") ? 404 : 400, { error: r.error });
    if (!r.already) writeJson(file, r.map);
    console.log(`${new Date().toISOString()} ${path.slice(1)} ${postId}${r.already ? " (already)" : ""}`);
    return send(res, 200, { ok: true, post_id: postId, status: path === "/mark-posted" ? "posted" : "skipped", already: r.already, at: r.map[postId].at });
  }
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text), ...headers });
  res.end(res.req.method === "HEAD" ? undefined : text);
}

/** A batch with each post's live status (posted.json / skipped.json). */
// The Signal Studio poster's ledger counts too: once the audit passes, a family it sent is never offered here as pending.
export function withStatus(batch, posted, skipped, ledger = null, now = Date.now()) {
  if (!batch) return null;
  // Sent, live, in flight or of unknown outcome. A refusal created nothing on TikTok, however many times it happened.
  // "failed" with "TikTok FAILED" is TikTok saying it created nothing; only an unknown outcome may be live.
  const viaPoster = (id) => { const e = ledger?.families?.[id]; return !!e && e.state !== "refused" && !/^TikTok FAILED/.test(e.lastError || "") && !eligible(e); };
  const posts = (batch.posts || []).map((p) => ({
    ...p,
    status: posted[p.post_id] || viaPoster(p.post_id) ? "posted" : skipped[p.post_id] ? "skipped" : "pending",
    ...(posted[p.post_id] ? { posted_at: posted[p.post_id].at, tiktok_url: posted[p.post_id].tiktok_url || null } : {}),
    ...(!posted[p.post_id] && viaPoster(p.post_id) ? { posted_via: "signal-studio" } : {}),
  }));
  return {
    ...batch,
    stale: now > staleAfter(batch.batch_id || `${batch.date}-${batch.slot}`),
    instructions: "Post each pending post through Higgsfield, then mark it posted. A rolled_over post was offered before and never confirmed: check @marathon.club7 first, and if it is already live, just mark it posted.",
    pending: posts.filter((p) => p.status === "pending").length,
    posts,
    mark_posted: { method: "POST", url: `${PUBLIC_BASE}/mark-posted`, auth: "Authorization: Bearer <token>", body: { post_id: "<post_id>", tiktok_url: "<optional>" } },
  };
}

function serveFile(req, res, file, type) {
  let st;
  try { st = statSync(file); if (!st.isFile()) throw new Error("not a file"); } catch { return send(res, 404, { error: "not found" }); }
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "public, max-age=86400", "last-modified": st.mtime.toUTCString() };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { ...base, "content-range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return stream(file, res, { start, end });
  }
  res.writeHead(200, { ...base, "content-length": st.size });
  if (req.method === "HEAD") return res.end();
  stream(file, res);
}

/** A file vanishing or failing mid-read closes that one response, never the server. */
function stream(file, res, opts) {
  createReadStream(file, opts).on("error", () => res.destroy()).pipe(res);
}

export async function handle(req, res) {
  let path = new URL(req.url, "http://x").pathname;
  if (path === PREFIX || path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length) || "/";
  const get = req.method === "GET" || req.method === "HEAD";

  if (get && (path === "/" || path === "/latest.json")) {
    const b = withStatus(readJson(join(DIR, "latest.json"), null), readJson(join(DIR, "posted.json"), {}), readJson(join(DIR, "skipped.json"), {}), readJson(POSTER_LEDGER, null));
    return b ? send(res, 200, b) : send(res, 404, { error: "no batch built yet" });
  }
  if (get && path === "/health") return send(res, 200, { ok: true });
  if (req.method === "POST" && (MARKS[path] || path === "/unmark")) return mark(req, res, path);
  // GET form for chat tools that cannot POST: same token, as ?token=. HEAD never marks; unmark is POST only.
  if (req.method === "GET" && MARKS[path]) return mark(req, res, path, new URL(req.url, "http://x").searchParams);
  let m;
  if (get && (m = /^\/batches\/([^/]+)\.json$/.exec(path)) && BATCH_ID_RE.test(m[1])) {
    const b = withStatus(readJson(join(DIR, "batches", `${m[1]}.json`), null), readJson(join(DIR, "posted.json"), {}), readJson(join(DIR, "skipped.json"), {}), readJson(POSTER_LEDGER, null));
    return b ? send(res, 200, b) : send(res, 404, { error: "no such batch" });
  }
  if (get && (m = /^\/media\/([^/]+)\/(\d{1,2})\.(jpg|mp4)$/.exec(path)) && POST_ID_RE.test(m[1])) {
    return serveFile(req, res, join(DIR, "media", m[1], `${m[2]}.${m[3]}`), TYPES[m[3]]);
  }
  return send(res, 404, { error: "not found" });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: "internal error" }); else res.destroy(); });
  }).listen(PORT, HOST, () => console.log(`TikTok queue server on http://${HOST}:${PORT} (${DIR})`));
}

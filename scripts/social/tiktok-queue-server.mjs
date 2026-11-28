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
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { BATCH_ID_RE, POST_ID_RE } from "./tiktokHfQueue.mjs";

const DIR = process.env.TIKTOK_QUEUE_DIR || join(homedir(), ".marathon-tiktok-queue");
const PORT = Number(process.env.TIKTOK_QUEUE_PORT || 8798);
const HOST = process.env.TIKTOK_QUEUE_HOST || "127.0.0.1";
const PUBLIC_BASE = (process.env.TIKTOK_QUEUE_PUBLIC_BASE || "https://mac-mini-von-marathon-3.tail5a5180.ts.net/studio/tiktok-queue").replace(/\/+$/, "");
const PREFIX = "/studio/tiktok-queue";
const STALE_MS = 13 * 3600000; // a batch older than this means a build was missed
const TYPES = { jpg: "image/jpeg", mp4: "video/mp4" };

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 1);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text), ...headers });
  res.end(res.req.method === "HEAD" ? undefined : text);
}

/** A batch with each post's live status (posted.json / skipped.json). */
export function withStatus(batch, posted, skipped, now = Date.now()) {
  if (!batch) return null;
  const posts = (batch.posts || []).map((p) => ({
    ...p,
    status: posted[p.post_id] ? "posted" : skipped[p.post_id] ? "skipped" : "pending",
    ...(posted[p.post_id] ? { posted_at: posted[p.post_id].at, tiktok_url: posted[p.post_id].tiktok_url || null } : {}),
  }));
  return {
    ...batch,
    stale: now - Date.parse(batch.generated_at || 0) > STALE_MS,
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
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, "content-length": st.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

export async function handle(req, res) {
  let path = new URL(req.url, "http://x").pathname;
  if (path === PREFIX || path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length) || "/";
  const get = req.method === "GET" || req.method === "HEAD";

  if (get && (path === "/" || path === "/latest.json")) {
    const b = withStatus(readJson(join(DIR, "latest.json"), null), readJson(join(DIR, "posted.json"), {}), readJson(join(DIR, "skipped.json"), {}));
    return b ? send(res, 200, b) : send(res, 404, { error: "no batch built yet" });
  }
  if (get && path === "/health") return send(res, 200, { ok: true });
  let m;
  if (get && (m = /^\/batches\/([^/]+)\.json$/.exec(path)) && BATCH_ID_RE.test(m[1])) {
    const b = withStatus(readJson(join(DIR, "batches", `${m[1]}.json`), null), readJson(join(DIR, "posted.json"), {}), readJson(join(DIR, "skipped.json"), {}));
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

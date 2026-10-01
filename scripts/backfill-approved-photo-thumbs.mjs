#!/usr/bin/env node
// ─── BACKFILL: THUMBNAILS FOR ALREADY-APPROVED AI PHOTOS ─────────────────────
//
// Dry run by default; writes only with --apply.
//   node scripts/backfill-approved-photo-thumbs.mjs
//   node scripts/backfill-approved-photo-thumbs.mjs --apply
//   node scripts/backfill-approved-photo-thumbs.mjs --apply --limit=20
//
// THE BUG THIS REPAIRS
// Approving an AI photo proposal points products/{id}/photoUrl at
// products/{id}/photo_proposal_{token}.jpg and deliberately leaves
// products/{id}/photo.jpg standing — the original is kept, not overwritten.
// But the offline-mirror thumbnail has exactly ONE path per product,
// products/{id}/thumb_300.webp, and every one in the bucket was generated from
// photo.jpg. So an approval left the shop showing the clean white-background
// photo online and every till showing the ORIGINAL — and nothing ever
// corrected it, because a thumbnail is only revisited when photo.jpg changes
// and an approval does not change photo.jpg.
//
// src/utils/productThumb.js now closes this at approval time. This script is
// the one-off for the approvals that already happened.
//
// THE POPULATION, RECONCILED (measured live 2026-09-04)
//   927  photo proposals exist          (775 approved, 130 rejected, 22 pending)
//   775  approvals ever happened
//  -270  of those products have since had a HUMAN photo upload, which writes a
//        correct thumbnail and stamps photoUpdatedAt — already right
//    -2  no longer have a photoUrl at all
//   503  still point at their proposal
//   +19  point at a proposal with no approved proposal record (approved before
//        the status field, or the record was cleaned up) — equally affected
//   522  products to repair
// "775" is the number of APPROVALS, not the number of broken products. The
// work set is derived here from /products every run — the authority is what
// photoUrl actually points at, never a remembered count.
//
// GEOMETRY: `cwebp -resize 300 0` at q80 — the width is pinned and the height
// falls out of the aspect ratio. That is what produced all 5,039 thumbnails in
// the bucket and what src/utils/productThumb.js reproduces in the browser.
// Deliberately NOT "scale the longest edge": that would make this writer
// disagree with the other two about what a thumbnail is, silently, for every
// portrait photo. See the note in src/utils/productPhotoPaths.js.
//
// IT MARKS WHAT IT WROTE, AND THAT MATTERS
// Each object gets custom metadata thumbSource=proposal plus the proposal path
// it came from. marathon-pos-app/scripts/thumbs/generate.mjs regenerates
// thumbnails FROM photo.jpg and keys its skip on a gitignored local manifest —
// so a run from a fresh clone would cheerfully overwrite all 522 of these with
// the original photo again and undo this whole repair. The metadata is what
// lets that script leave them alone (see the guard added there in the matching
// POS PR). A later human re-upload writes a thumbnail with no such metadata,
// so the product becomes ordinary again, which is correct.
//
// RESUMABLE: skips any product whose thumbnail already carries thumbSource=
// proposal for THIS proposal path, read from the bucket listing — no local
// manifest, no state file, nothing to lose or to go stale.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const BUCKET = "marathon-club.firebasestorage.app";
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const LIMIT = (() => { const h = process.argv.find(a => a.startsWith("--limit=")); return h ? Number(h.slice(8)) : Infinity; })();
const MAX_EDGE = 300, QUALITY = 80, CONCURRENCY = 6;
const THUMB_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const thumbPath = (id) => `products/${id}/thumb_300.webp`;

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg?.tokens?.refresh_token, grant_type: "refresh_token",
  }).toString();
  const res = JSON.parse(execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token", "-d", "@-"], { input: body, encoding: "utf8" }));
  if (!res.access_token) throw new Error(`token refresh failed: ${JSON.stringify(res).slice(0, 200)}`);
  return res.access_token;
}
let tok = accessToken();
async function authed(url, opts = {}) {
  const go = () => fetch(url, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });
  let r = await go();
  if (r.status === 401) { tok = accessToken(); r = await go(); }
  return r;
}

// products/{id}/... out of a Firebase download URL
const objectPathFromUrl = (u) => { const m = /\/o\/([^?]+)/.exec(String(u || "")); return m ? decodeURIComponent(m[1]) : null; };
const isProposal = (u) => typeof u === "string" && u.includes("photo_proposal");

async function listThumbs() {
  const out = new Map(); let pageToken;
  do {
    const u = new URL(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`);
    u.searchParams.set("prefix", "products/");
    u.searchParams.set("maxResults", "1000");
    u.searchParams.set("fields", "nextPageToken,items(name,metadata)");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await authed(u);
    if (!r.ok) throw new Error(`list failed: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const it of j.items ?? []) { const m = /^products\/([^/]+)\/thumb_300\.webp$/.exec(it.name); if (m) out.set(m[1], it); }
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function main() {
  const t0 = Date.now();
  console.log("Reading /products …");
  const pr = await fetch(`${DB}/products.json?access_token=${tok}`);
  if (!pr.ok) throw new Error(`GET /products failed: ${pr.status}`);
  const products = await pr.json();
  const affected = Object.entries(products).filter(([, p]) => isProposal(p?.photoUrl)).map(([id, p]) => ({ id, url: p.photoUrl, path: objectPathFromUrl(p.photoUrl) }));
  console.log(`products: ${Object.keys(products).length}, photoUrl points at a proposal: ${affected.length}`);

  console.log("Listing thumbnails …");
  const thumbs = await listThumbs();
  const todo = affected.filter(a => thumbs.get(a.id)?.metadata?.thumbSourceObject !== a.path).slice(0, LIMIT);
  console.log(`already repaired: ${affected.length - affected.filter(a => thumbs.get(a.id)?.metadata?.thumbSourceObject !== a.path).length}`);
  console.log(`to repair:        ${todo.length}${LIMIT !== Infinity ? ` (capped by --limit=${LIMIT})` : ""}`);
  if (!todo.length) { console.log("nothing to do"); return; }

  const scratch = mkdtempSync(join(tmpdir(), "approved-thumbs-"));
  const stats = { done: 0, down: 0, up: 0, errors: [] };
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const a = todo[i++];
      try {
        // Download the PROPOSAL via its own tokenised URL (it is the object
        // photoUrl actually names — no guessing at a path).
        const r = await fetch(a.url);
        if (!r.ok) throw new Error(`download HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        stats.down += buf.length;
        const src = join(scratch, `${a.id}.src`), dst = join(scratch, `${a.id}.webp`);
        writeFileSync(src, buf);
        execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), "-resize", String(MAX_EDGE), "0", src, "-o", dst]);
        const thumb = readFileSync(dst);
        stats.up += thumb.length;
        if (APPLY) {
          const u = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
          u.searchParams.set("uploadType", "multipart");
          const meta = {
            name: thumbPath(a.id), contentType: "image/webp", cacheControl: THUMB_CACHE_CONTROL,
            // The mark that stops generate.mjs undoing this.
            metadata: { thumbSource: "proposal", thumbSourceObject: a.path },
          };
          const b = "===bnd" + Math.random().toString(36).slice(2) + "===";
          const body = Buffer.concat([
            Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: image/webp\r\n\r\n`),
            thumb, Buffer.from(`\r\n--${b}--\r\n`),
          ]);
          const up = await authed(u, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
          if (!up.ok) throw new Error(`upload HTTP ${up.status} ${await up.text()}`);
        }
        rmSync(src, { force: true }); rmSync(dst, { force: true });
        stats.done++;
        if (stats.done % 50 === 0) console.log(`  … ${stats.done}/${todo.length}`);
      } catch (e) {
        stats.errors.push({ id: a.id, message: e?.message || String(e) });
        console.error(`✗ ${a.id}: ${e?.message || e}`);
      }
    }
  };
  const rs = await Promise.allSettled(Array.from({ length: CONCURRENCY }, worker));
  rmSync(scratch, { recursive: true, force: true });
  for (const r of rs) if (r.status === "rejected") throw r.reason;

  const mb = (n) => (n / 1048576).toFixed(1);
  console.log("\n── summary ──");
  console.log(`mode:        ${APPLY ? "APPLY (wrote to Storage)" : "DRY RUN (nothing written)"}`);
  console.log(`repaired:    ${stats.done}`);
  console.log(`errors:      ${stats.errors.length}`);
  console.log(`downloaded:  ${mb(stats.down)} MB`);
  console.log(`uploaded:    ${mb(stats.up)} MB`);
  console.log(`wall time:   ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const e of stats.errors.slice(0, 10)) console.log(`  ${e.id}: ${e.message}`);
  if (!APPLY) console.log("\nDry run — re-run with --apply to write.");
}
await main();

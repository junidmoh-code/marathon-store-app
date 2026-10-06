// ── The video sender (Mac mini, its own launchd job) ─────────────────────────
// Sends ONE queued product video's bytes to Shopify per run, then exits;
// launchd (com.marathon.shopifymediavideo, KeepAlive + ThrottleInterval 120)
// starts it again. It exists so that a video transfer — up to 1 GB on the
// shop's uplink — NEVER runs inside the reconcile tick: the tick publishes,
// pushes inventory and attaches videos whose bytes are already on Shopify; this
// job only moves bytes. See mediaSync.mjs (sendNextQueuedVideo) for the
// exactly-once contract.
//
// SINGLE-FLIGHT. Its own lockfile (logs/shopify-media-video.lock, the owning
// pid inside, created by link() so two starts cannot both win). A lock whose
// owner is alive is respected however long the transfer takes; one whose owner
// is gone (crash, reboot) is reclaimed by rename. Two senders can never push
// the same video.
//
// WHAT IT READS: /shopify_sync/_mediaPending (the small carry-forward set), and
// per pending product its own node, record and mapping — never a whole node.
// Runs at any hour: a video arriving on Shopify is invisible until the tick
// attaches it, so there is no customer-facing reason to wait for trading hours.
//
//   node scripts/shopify/media-video-runner.mjs      (what launchd runs)
import { createRequire } from "module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, linkSync, renameSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { graphql } from "./client.mjs";
import { sendNextQueuedVideo, MEDIA_PENDING_PATH } from "./mediaSync.mjs";
import { assertSafeSegment } from "../../src/utils/sizeKey.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LOG_DIR = join(REPO, "logs");
const LOG_FILE = join(LOG_DIR, "shopify-media-video.log");
const LOCK_FILE = join(LOG_DIR, "shopify-media-video.lock");
mkdirSync(LOG_DIR, { recursive: true });

const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
function log(line) {
  try {
    if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* no log yet */ }
  appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

function acquireLock() {
  for (let i = 0; i < 2; i++) {
    const tmp = `${LOCK_FILE}.new.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    try { linkSync(tmp, LOCK_FILE); return true; }
    catch (e) { if (e?.code !== "EEXIST") throw e; }
    finally { try { unlinkSync(tmp); } catch { /* linked */ } }
    let held = null;
    try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* unreadable */ }
    if (held?.pid && alive(held.pid)) return false;
    try { renameSync(LOCK_FILE, `${LOCK_FILE}.stale.${process.pid}`); unlinkSync(`${LOCK_FILE}.stale.${process.pid}`); }
    catch { /* another start took it — re-evaluate */ }
  }
  return false;
}
function releaseLock() {
  try { if (JSON.parse(readFileSync(LOCK_FILE, "utf8"))?.pid === process.pid) unlinkSync(LOCK_FILE); } catch { /* gone */ }
}

process.on("unhandledRejection", (e) => { log(`FAILED: ${String(e?.stack || e)}`); releaseLock(); process.exit(1); });

if (!acquireLock()) process.exit(0); // a transfer is in flight — this start stands down
let code = 0;
try {
  const require = createRequire(new URL("../../functions/package.json", import.meta.url));
  const admin = require("firebase-admin");
  admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const db = admin.database();
  const pending = Object.keys((await db.ref(MEDIA_PENDING_PATH).get()).val() || {});
  for (const pid of pending) {
    assertSafeSegment(pid, "productId");
    const node = (await db.ref(`shopify_publish/${pid}`).get()).val();
    // Only a product on the shop: one still going live has its videos sent
    // after the publish confirms it (they stay queued until then).
    if (!(node?.state === "live" && node?.liveState === "on" && node?.desiredState === "on")) continue;
    const r = await sendNextQueuedVideo({ graphql, db, pid, node, log });
    if (r.sent) { log(`✓ ${pid}: video ${r.itemId} is on Shopify (attached at the next reconcile tick)`); break; }
    if (r.error) { log(`✗ ${pid}: video ${r.itemId} not sent — ${r.error}`); code = 1; break; }
  }
  await admin.app().delete();
} catch (e) {
  log(`FAILED: ${String(e?.message || e)}`);
  code = 1;
} finally {
  releaseLock();
}
process.exit(code);

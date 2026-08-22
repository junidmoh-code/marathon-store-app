// ── THE SCHEDULED SOCIAL PUBLISHER (Mac mini) ────────────────────────────────
// launchd fires this; it supervises one run of scripts/social/publish.mjs and
// exits. Deliberately the SAME mechanism as the Shopify reconciler — a user
// LaunchAgent running node against the repo checkout, logs under the repo,
// single-flight enforced by a pid-carrying lockfile — so the machine has one
// way of running scheduled work, not two.
//
// THE CADENCE IS THE SCHEDULE, NOT THIS FILE. Three posts a week means the
// plist fires on Monday, Wednesday and Saturday at 18:00 SAST, matching the
// slots the queue shows and the generator assigns
// (src/components/social/socialCore.js SLOT_DAYS / SLOT_HOUR_SAST). This
// runner does not decide when anything goes out; it asks the publisher what is
// DUE, and the publisher asks each post.
//
// A tick with nothing approved and due exits in under a second having made
// zero platform calls, and logs one line so a quiet log still proves the
// schedule is alive.
//
// CREDENTIALS are not this file's business: publish.mjs reads them from Google
// Secret Manager through scripts/social/secrets.mjs, using the same service
// account GOOGLE_APPLICATION_CREDENTIALS already points at. Nothing here logs,
// echoes or copies a credential value.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runTick } from "../lib/launchdRunner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const code = await runTick({
  name: "social-publish",
  logDir: join(REPO, "logs"),
  script: join(HERE, "publish.mjs"),
  cwd: REPO,
  // Sized well above a full run: a carousel of ten images is ten container
  // creations plus a publish, and a video container can take minutes to
  // ingest (meta.mjs CONTAINER_MAX_WAIT_MS is five, per item).
  staleLockMs: 45 * 60 * 1000,
  // "N due" with N > 0 is what proves there is real work. Anything on stderr
  // also settles it — see the runner.
  busyWhen: (text) => {
    const m = text.match(/·\s*(\d+)\s*due/);
    return !!(m && Number(m[1]) > 0);
  },
  idleLine: "tick: nothing approved and due",
});
process.exit(code);

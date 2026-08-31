// ─── THE SCHEDULED CARD RECON MAILBOX POLLER (Mac mini) ──────────────────────
// launchd fires this; it supervises one run of email-poller.mjs and exits.
// Deliberately the SAME mechanism as the social publisher and the Shopify
// reconciler — a user LaunchAgent running node against the repo checkout, logs
// under the repo, single-flight enforced by the pid-carrying lockfile in
// scripts/lib/launchdRunner.mjs — so the machine has one way of running
// scheduled work rather than a third.
//
// A tick with no unread mail exits in under a second having made zero capture
// calls, and logs one line, so a quiet log still proves the schedule is alive.
//
// CREDENTIALS are not this file's business: the poller reads them from the
// gitignored .env at the repo root. Nothing here logs, echoes or copies one.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runTick } from "../lib/launchdRunner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const code = await runTick({
  name: "card-recon-poll",
  logDir: join(REPO, "logs"),
  script: join(HERE, "email-poller.mjs"),
  cwd: REPO,
  // A tick reads at most 20 messages and each is one PDF parse plus two
  // callable round trips; the callable itself is capped at 300s. Well above a
  // full run, well below "something is stuck".
  staleLockMs: 20 * 60 * 1000,
  maxRunMs: 30 * 60 * 1000,
  // A message count above zero is what proves there was work. Anything on
  // stderr settles it too — see the runner.
  busyWhen: (text) => {
    // "unprocessed", not "unread": the poller now scans by the PROCESSED
    // ledger, because the owner's phone marks mail read before the poller
    // sees it. The regex must track the poller's own line.
    const m = text.match(/·\s*(\d+)\s*unprocessed message/);
    return !!(m && Number(m[1]) > 0);
  },
  idleLine: "tick: nothing unprocessed in the recon mailbox",
});
process.exit(code);

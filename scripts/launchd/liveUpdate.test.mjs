// ── live-update.mjs end to end, against a throwaway origin and checkout ─────
// Real git, real files, a temp directory: the script is copied into a small
// repository that stands in for ~/marathon-store-app, and "origin" is a bare
// repository beside it. Nothing here touches the network or launchd (no
// change below is under a long-lived service's paths, so nothing is restarted).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
let root, origin, work, live;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (...args) => spawnSync(process.execPath, [join(live, "scripts/launchd/live-update.mjs"), ...args], { cwd: live, env: ENV, encoding: "utf8" });
const logText = () => readFileSync(join(live, "logs/live-update.log"), "utf8");
const lockFile = () => join(live, "logs/shopify-reconcile.lock");
// A commit on origin/main, made from a separate working clone (as a merged PR is).
function publish(files, message = "change") {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "live-update-"));
  origin = join(root, "origin.git"); work = join(root, "work"); live = join(root, "live");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  mkdirSync(join(work, "scripts/launchd"), { recursive: true });
  for (const f of ["live-update.mjs", "liveUpdatePlan.mjs"]) copyFileSync(join(HERE, f), join(work, "scripts/launchd", f));
  writeFileSync(join(work, ".gitignore"), "logs/\n");
  publish({ "scripts/social/a.mjs": "export const a = 1;\n" }, "first");
  git(root, "clone", "-q", origin, live);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("live-update.mjs", () => {
  it("already at origin/main: exits 0, moves nothing, says so once an hour", () => {
    const head = git(live, "rev-parse", "HEAD");
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(logText().match(/up to date/g)).toHaveLength(1);
  });

  it("a merged change reaches the checkout on the next run, and the run lock is free again afterwards", () => {
    const target = publish({ "scripts/social/a.mjs": "export const a = 2;\n" });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(target);
    expect(readFileSync(join(live, "scripts/social/a.mjs"), "utf8")).toContain("a = 2");
    expect(logText()).toMatch(/✓ updated/);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("--dry-run says what it would do and changes nothing", () => {
    const head = git(live, "rev-parse", "HEAD");
    publish({ "scripts/social/a.mjs": "export const a = 2;\n" });
    const r = run("--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN — would move/);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
  });

  it("while a reconcile tick holds the run lock it waits; the tick's lock is not touched", () => {
    const head = git(live, "rev-parse", "HEAD");
    const target = publish({ "scripts/social/a.mjs": "export const a = 2;\n" });
    mkdirSync(join(live, "logs"), { recursive: true });
    const held = JSON.stringify({ pid: process.pid, childPid: null, startedAt: Date.now() });
    writeFileSync(lockFile(), held);
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(lockFile(), "utf8")).toBe(held);
    rmSync(lockFile());
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(target);
  });

  it("a change that does not parse is rolled back, reported, and not tried again until main moves", () => {
    const head = git(live, "rev-parse", "HEAD");
    publish({ "scripts/social/a.mjs": "export const a = ;\n" }, "broken");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/failed/);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(live, "scripts/social/a.mjs"), "utf8")).toContain("a = 1");
    expect(logText()).toMatch(/UPDATE TO .* FAILED/);
    expect(logText()).toMatch(/rolled back/);
    expect(existsSync(lockFile())).toBe(false);
    const again = run();
    expect(again.status).toBe(0);
    expect(logText().match(/FAILED/g)).toHaveLength(1);
    // The fix lands on main: the next run takes it.
    const fixed = publish({ "scripts/social/a.mjs": "export const a = 3;\n" }, "fixed");
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(fixed);
  });

  it("a tracked file edited in the live checkout stops the update, and the edit survives", () => {
    const head = git(live, "rev-parse", "HEAD");
    publish({ "scripts/social/b.mjs": "export const b = 1;\n" });
    writeFileSync(join(live, "scripts/social/a.mjs"), "export const a = 'hand edit';\n");
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(live, "scripts/social/a.mjs"), "utf8")).toContain("hand edit");
    expect(logText().match(/NOT UPDATED/g)).toHaveLength(1); // said once, not every five minutes
  });

  it("files only ADDED in the live checkout (untracked, or staged new) do not stop it and are kept", () => {
    const target = publish({ "scripts/social/b.mjs": "export const b = 1;\n" });
    writeFileSync(join(live, ".env.bak"), "x\n");
    mkdirSync(join(live, "tools/cutouts"), { recursive: true });
    writeFileSync(join(live, "tools/cutouts/cutout.py"), "print(1)\n");
    git(live, "add", "tools/cutouts/cutout.py");
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(target);
    expect(existsSync(join(live, ".env.bak"))).toBe(true);
    expect(git(live, "diff", "--cached", "--name-only")).toBe("tools/cutouts/cutout.py");
  });

  it("a checkout that is AHEAD of main (someone's local commit) is never moved", () => {
    writeFileSync(join(live, "scripts/social/a.mjs"), "export const a = 9;\n");
    git(live, "commit", "-q", "-am", "local");
    const head = git(live, "rev-parse", "HEAD");
    publish({ "scripts/social/b.mjs": "export const b = 1;\n" });
    expect(run().status).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(logText()).toMatch(/NOT UPDATED — HEAD .* is not behind origin\/main/);
  });
});

// ─── THE GUARD THAT STOPS A MUTATION RUN EATING UNCOMMITTED WORK ─────────────
// The control is only a control if it actually refuses, so these drive
// requireCleanTree against a REAL throwaway git repository rather than a stub
// of git. A fake `git` would let the argument list, the --porcelain parsing and
// the path scoping all be wrong while every test passed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCleanTree } from "./mutationPreflight.mjs";

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** Run the guard inside the temp repo, capturing what it did instead of exiting. */
const run = (files) => {
  const cwd = process.cwd();
  const lines = [];
  let code = null;
  try {
    process.chdir(repo);
    requireCleanTree(files, { exit: (c) => { code = c; return undefined; }, log: (m) => lines.push(m) });
  } finally { process.chdir(cwd); }
  return { code, text: lines.join("\n") };
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "mutpre-"));
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.js"), "let a = 1;\n");
  writeFileSync(join(repo, "b.js"), "let b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
});
afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe("a clean tree is allowed through", () => {
  it("returns without exiting and says nothing", () => {
    expect(run(["a.js"])).toEqual({ code: null, text: "" });
    expect(run()).toEqual({ code: null, text: "" });
  });
});

describe("a dirty tree is REFUSED", () => {
  it("exits non-zero when the file the harness mutates has uncommitted work", () => {
    writeFileSync(join(repo, "a.js"), "let a = 2;\n");
    const r = run(["a.js"]);
    expect(r.code).toBe(2);
    expect(r.text).toContain("a.js");
    // The message has to say what to do, not merely that something is wrong.
    expect(r.text).toContain("Commit first");
    git("checkout", "--", "a.js");
  });

  it("refuses on an UNTRACKED file too — a new file is uncommitted work as well", () => {
    writeFileSync(join(repo, "new.js"), "x\n");
    expect(run(["new.js"]).code).toBe(2);
    rmSync(join(repo, "new.js"));
  });

  it("refuses on a whole-tree check when anything at all is dirty", () => {
    writeFileSync(join(repo, "b.js"), "let b = 2;\n");
    expect(run().code).toBe(2);
    git("checkout", "--", "b.js");
  });
});

describe("the scope is the files given, and nothing wider", () => {
  it("a dirty file the harness does NOT touch does not block the run", () => {
    // Otherwise one unrelated edit anywhere in a large repo makes every
    // harness unrunnable, and the guard gets commented out — which is worse
    // than not having it.
    writeFileSync(join(repo, "b.js"), "let b = 3;\n");
    expect(run(["a.js"]).code, "a.js is clean").toBe(null);
    expect(run(["b.js"]).code, "b.js is not").toBe(2);
    expect(run(["a.js", "b.js"]).code, "and the pair is dirty").toBe(2);
    git("checkout", "--", "b.js");
  });
});

describe("\"I could not check\" is not \"it is clean\"", () => {
  it("refuses when git cannot answer at all", () => {
    // Outside a checkout git exits non-zero. Treating that as clean would let
    // the guard evaporate in exactly the situation it is least able to help.
    const outside = mkdtempSync(join(tmpdir(), "notrepo-"));
    const cwd = process.cwd();
    let code = null; const lines = [];
    try {
      process.chdir(outside);
      requireCleanTree(["a.js"], { exit: (c) => { code = c; }, log: (m) => lines.push(m) });
    } finally { process.chdir(cwd); rmSync(outside, { recursive: true, force: true }); }
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Could not ask git");
  });
});

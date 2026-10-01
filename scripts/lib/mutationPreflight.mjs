// ─── A MUTATION RUN MUST NOT START ON A DIRTY TREE ───────────────────────────
// Shared preflight for every scripts/mutation-proof-*.mjs harness.
//
// ── WHY THIS IS A HARD STOP AND NOT A WARNING ───────────────────────────────
// A mutation harness edits a source file, runs the tests, and puts the file
// back. "Puts it back" is the dangerous half. If it restores by asking git for
// the file — `git checkout -- <file>`, `git stash`, `git restore` — it restores
// to HEAD, not to the state the file was in when the run began. Uncommitted
// work in that file is then gone, silently, while the run carries on printing
// results as though nothing had happened.
//
// That has now happened three times on this project (feedback_commit_before_
// mutation_tests, feedback_never_git_add_all_near_a_mutation_harness,
// feedback_never_checkout_before_committing) and most recently on 2026-09-08,
// where an ad-hoc loop wiped a round of review fixes out of two files. It was
// caught only because two later mutations reported "pattern not found" — the
// anchors they were looking for had been part of the deleted work. Had every
// anchor still matched, the run would have looked perfectly clean.
//
// Remembering has failed three times, so remembering is not the control. The
// control is that the harness refuses to run.
//
// ── THE HARNESSES RESTORE FROM BYTES, AND STILL NEED THIS ───────────────────
// Every harness here captures `readFileSync(file)` before mutating and writes
// those bytes back afterwards, which cannot reach past the mutation. So why
// stop on a dirty tree at all? Because the bytes it captures would be the
// DIRTY ones: the run would then be proving a guard against uncommitted work,
// report PROVEN, and tell you nothing about what is actually committed. A pass
// obtained against a tree nobody can reproduce is worse than no pass.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// `files` narrows the check to the files a harness actually mutates, so an
// unrelated edit elsewhere in a large repo does not block a run. Pass nothing
// to check the whole tree.

import { execFileSync } from "node:child_process";

/**
 * Exit the process unless the given files are clean in git.
 *
 * @param {string[]} [files] paths to check; omit to check the entire tree
 * @param {{exit?: (code: number) => never, log?: (msg: string) => void}} [io]
 *        seams for testing — the real ones are process.exit and console.error
 * @returns {void} returns only when the tree is clean
 */
export function requireCleanTree(files, io = {}) {
  const exit = io.exit || ((c) => process.exit(c));
  const log = io.log || ((m) => console.error(m));

  const paths = [...new Set(files || [])].filter(Boolean);
  let dirty;
  try {
    dirty = execFileSync(
      "git",
      paths.length ? ["status", "--porcelain", "--", ...paths] : ["status", "--porcelain"],
      { encoding: "utf8" },
    ).trim();
  } catch (e) {
    // Not a checkout, or git is unavailable. REFUSE rather than assume clean:
    // "I could not check" and "it is clean" are different answers, and only one
    // of them is safe to mutate source files on.
    log(`Could not ask git whether the tree is clean: ${e && e.message}`);
    log("Refusing to mutate source files without that answer.");
    return exit(2);
  }

  if (dirty) {
    log(
      paths.length
        ? "Working tree is not clean for the files this harness mutates:\n" + dirty
        : "Working tree is not clean:\n" + dirty,
    );
    log("");
    log("Commit first — a WIP commit is fine. Two reasons, and the second is the one");
    log("that has actually bitten:");
    log("  1. the harness would capture your uncommitted edits as the baseline, so a");
    log("     PROVEN verdict would be about work nobody else can reproduce;");
    log("  2. any restore that goes through git (checkout/stash/restore) returns the");
    log("     file to HEAD and deletes that work outright.");
    return exit(2);
  }
}

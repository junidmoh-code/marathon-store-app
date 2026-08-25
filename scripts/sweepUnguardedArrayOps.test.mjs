// Pins what the unguarded-array-op sweep does and does not report.
//
// A sweep that misses things is worse than no sweep, because a clean run reads
// as "checked". The case that matters most here is the one CodeRabbit caught on
// PR #444: `post?.media.map(...)` LOOKS guarded and is not — the `?.` is on the
// `post` hop, and `media` is the field that comes back null. The sweep called
// that safe, which would have let exactly the class of bug it exists to find
// walk straight past it.
import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";

const run = (target) => {
  const r = spawnSync("node", ["scripts/sweep-unguarded-array-ops.mjs", target], { encoding: "utf8" });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
};

test("optional chaining on the wrong hop is REPORTED; on the call hop it is not", () => {
  const { out, status } = run("scripts/fixtures/sweep/probes.js");
  expect(out).toContain("post?.media.map()");
  expect(status).toBe(1);
  // The three safe shapes must not appear. Counting is the check: exactly two
  // findings, the two the fixture marks as unguarded.
  expect(out).toContain("2 to look at");
  expect(out).toContain("post.media.some()");
});

test("the social card itself sweeps clean, and a clean sweep exits 0", () => {
  const { out, status } = run("src/components/social");
  expect(out).toContain("clean");
  expect(status).toBe(0);
});

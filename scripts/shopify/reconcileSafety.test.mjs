// ─── THE FAIL-SAFE DISCIPLINE, ASSERTED AGAINST THE SOURCE ───────────────────
// reconcile.mjs is the only thing in this repo that makes a product publicly
// purchasable, and its containment rules live in prose comments that two
// reviews found already broken in three places:
//
//   · `tookDown: true` was passed unconditionally after a fail-safe unpublish
//     that swallowed its own failures — so markBlocked could record
//     `liveState: "off"` for a product still on sale (Codex + architect, 2026-08-28);
//   · three read-back refusals skipped the unpublish their siblings take;
//   · a throw after publishablePublish left the product public with nothing but
//     a line in the report.
//
// None of those is reachable from a unit test — the file is a top-level script
// that talks to Shopify the moment it is imported. So the guard is a READ of
// the source. It is coarse by nature; it is also the only thing standing
// between this discipline and the next well-meaning edit.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./reconcile.mjs", import.meta.url), "utf8");
const lines = SRC.split("\n");

describe("failSafeUnpublish reports whether it worked", () => {
  it("returns true only on a clean unpublish, and false on BOTH failure modes", () => {
    const body = SRC.slice(SRC.indexOf("const failSafeUnpublish"), SRC.indexOf("const refuse ="));
    // userErrors is Shopify's normal failure channel — a mutation can "succeed"
    // and refuse. Both it and a thrown error must answer false.
    expect(body).toMatch(/if \(errs\?\.length\) \{[\s\S]*?return false;/);
    expect(body).toMatch(/catch \(e\) \{[\s\S]*?return false;\s*\}/);
    expect(body).toMatch(/return true;/);
  });
});

describe("no refusal ever CLAIMS a take-down it did not get", () => {
  it("tookDown is never a literal true — it is always the unpublish's answer", () => {
    // The exact defect: `await failSafeUnpublish(gid); refuse(..., { tookDown: true })`.
    // markBlocked writes liveState "off" on that word, and a throttled unpublish
    // would make it a durable lie about a product customers can still buy.
    expect(SRC).not.toMatch(/tookDown:\s*true/);
  });

  it("every tookDown value is a variable captured from failSafeUnpublish", () => {
    for (const [i, line] of lines.entries()) {
      const m = /tookDown:\s*([A-Za-z_$][\w$]*)/.exec(line);
      if (!m || m[1] === "tookDown") continue;   // the refuse() signature itself
      const name = m[1];
      // The capture is within the few lines above — a multi-line refusal call
      // can put the interpolated reason between the two.
      const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      expect(window).toContain(`const ${name} = await failSafeUnpublish(`);
    }
  });
});

describe("a throw after the product went public still takes it down", () => {
  it("the loop carries a publicGid, set only after publishablePublish succeeded", () => {
    expect(SRC).toMatch(/let publicGid = null;/);
    expect(SRC).toMatch(/if \(!pubErrs\?\.length\) publicGid = gid;/);
  });

  it("the outer catch unpublishes it, and does NOT block — a timeout must stay retryable", () => {
    // THE LOOP'S catch, not the file's last one — the search-index sweep at the
    // bottom has a catch of its own and slicing to the end would test that.
    const start = SRC.indexOf("  } catch (e) {\n    // DELIBERATELY NOT markBlocked");
    expect(start).toBeGreaterThan(-1);
    const catchBlock = SRC.slice(start, SRC.indexOf("\n}", start));
    expect(catchBlock).toContain("await failSafeUnpublish(publicGid)");
    // markBlocked consumes desiredState. Blocking on a transient throw would
    // mean the next tick never retries a publish that only needed retrying.
    // CODE ONLY — the block's own comment says the words on purpose.
    const code = catchBlock.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("markBlocked");
    expect(code).not.toContain("refuse(");
  });
});

describe("a handle-collision refusal records the handle as a FIELD", () => {
  it("both collision refusals pass blockedHandle", () => {
    const collisions = SRC.split("\n").filter((l) => l.includes("the web address this name would use"));
    expect(collisions.length).toBeGreaterThanOrEqual(2);
    for (const l of collisions) expect(l).toContain("blockedHandle: payload.handle");
  });
});

describe("no message a person reads names a script", () => {
  it("no refusal or request text mentions a .mjs file", () => {
    // "adopt it via round-trip.mjs" was the remedy this page used to offer a
    // shop owner. A file name is not a remedy.
    for (const [i, line] of lines.entries()) {
      if (!/refuse\(|requestFreshName\(/.test(line)) continue;
      expect(`${i + 1}: ${line}`).not.toMatch(/\.mjs/);
    }
  });
});


// ─── THE OFF WRITE IS A MULTI-PATH ADD, NOT A MAP REPLACEMENT ────────────────
// RTDB REJECTS an update() containing both an ancestor and a descendant of the
// same path — this repo has hit that before. `lastOff` and `offLog/<n>` are
// disjoint first segments so they are safe together, and mixing a child-path
// key with plain sibling keys in one update() is the pattern
// approve-name-proposals.mjs already runs in production. Both facts are worth
// pinning, because the alternative shape (writing the whole `offLog` map) is
// the one that deleted history.
describe("the script-side off write", () => {
  it("adds ONE child and never writes the offLog map", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publishNode.mjs", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function offFields"), src.indexOf("async function trimOffLog"));
    expect(body).toContain("[`offLog/${record.at}`]: record");
    // The map form would be `offLog: <something>` — that is what wiped history.
    expect(body).not.toMatch(/\boffLog:\s/);
  });

  it("never puts an ancestor and its descendant in the same update", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publishNode.mjs", import.meta.url), "utf8");
    // The only path-shaped keys written are under offLog/, and `offLog` itself
    // is never a key alongside them.
    const pathKeys = src.match(/\[`([a-zA-Z]+\/[^`]*)`\]:/g) || [];
    for (const k of pathKeys) expect(k).toContain("offLog/");
    expect(src).not.toMatch(/^\s*offLog:\s/m);
  });

  it("trims AFTER the state write, so a slow trim cannot cost the record", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./publishNode.mjs", import.meta.url), "utf8");
    for (const fn of ["confirmLiveState", "markBlocked"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const end = body.indexOf("\n}\n");
      const scoped = body.slice(0, end);
      const update = scoped.indexOf(".update(");
      const trim = scoped.indexOf("trimOffLog(");
      expect(update).toBeGreaterThan(-1);
      expect(trim).toBeGreaterThan(update);
    }
  });
});

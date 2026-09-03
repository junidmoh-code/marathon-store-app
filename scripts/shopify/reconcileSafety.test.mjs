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

// Brace-match a block so a guard can assert CONTAINMENT rather than "appears
// later in the file". Strings and comments are skipped, because a brace inside
// either would otherwise close the block early and make the guard lie.
function blockAt(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { start: openIndex, end: i }; }
  }
  throw new Error("unbalanced block");
}

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

// ─── THE BANDWIDTH CONTRACT, ASSERTED THE SAME WAY ───────────────────────────
// This loop was measured on 3 Sep 2026 at 45–79% of ALL traffic in the
// database — ~$87–160/month — for a shop where most ticks have nothing to do
// (docs/bandwidth-capture-sept.md). The three lines that caused it are the
// three easiest lines in the world to write back in, so they are pinned here.
describe("no whole-node read on the scheduled path", () => {
  it("the location names for the inventory read come from a SHALLOW resolver, never from all of /stock", () => {
    // The line that was there: Object.keys((await db.ref("stock").get()).val())
    // — 6,204,009 measured bytes, per product, to learn ten strings.
    expect(SRC).not.toMatch(/db\.ref\(\s*["'`]stock["'`]\s*\)\s*\.get\(\)/);
    expect(SRC).toMatch(/const locNames = await stockLocationKeys\(\)/);
  });

  it("the search-index sweep does not re-read the whole publish node", () => {
    // It used to call readAllPublishNodes a SECOND time, purely to learn which
    // products are live — 1.9–2.2 MB, every two minutes, all night.
    const sweep = SRC.slice(SRC.indexOf("SEARCH-INDEX SWEEP"));
    expect(sweep).not.toMatch(/readAllPublishNodes/);
    expect(sweep).toMatch(/readLivePids|Object\.entries\(all\)/);
  });

  it("a missing index falls back to the OLD whole-node read, loudly, rather than throwing", () => {
    // RTDB refuses an unindexed orderByChild outright — it does not sort it
    // server-side. Verified against the live database, 3 Sep 2026.
    expect(SRC).toMatch(/isMissingIndexError\(e, "updatedAt"\)/);
    expect(SRC).toMatch(/if \(!isMissingIndexError\(e, "updatedAt"\)\) throw e;/);
  });

  it("a commit tick's worklist is scoped, and a dry run's is not", () => {
    // The dry run answers "what is outstanding across the whole shop?" and must
    // keep reading everything; only the scheduled tick reads a window.
    expect(SRC).toMatch(/const scan = COMMIT && !ONLY/);
    expect(SRC).toMatch(/readChangedPublishNodes/);
  });

  it("the watermark advances to when the run STARTED, never to now", () => {
    // Advancing to "now" would step over any intent written while the run was
    // in flight — a product that silently never publishes.
    expect(SRC).toMatch(/watermark: runStartedAt/);
    expect(SRC).not.toMatch(/watermark: Date\.now\(\)/);
  });

  it("work the run could not finish is carried, because its node's updatedAt did not move", () => {
    expect(SRC).toMatch(/worklist\.slice\(capped\.length\)/);
    expect(SRC).toMatch(/results\.filter\(\(r\) => !r\.ok\)\.map\(\(r\) => r\.pid\)/);
  });

  it("a --pids run never tells the scheduler it is caught up", () => {
    // Pinned as CONTAINMENT, not as a character distance and not as a mere
    // file position. The first version of this guard allowed 600 characters
    // between the gate and the call, so adding a comment inside the block
    // failed it while the contract was intact; the second only asserted the
    // call came LATER in the file, which would still pass if the write were
    // moved out from under the gate entirely — the exact regression it
    // exists to catch. So the block is delimited by brace matching and the
    // call must fall inside it.
    const gate = SRC.indexOf("if (COMMIT && !ONLY) {");
    expect(gate).toBeGreaterThan(-1);
    const body = blockAt(SRC, SRC.indexOf("{", gate));
    const calls = [...SRC.matchAll(/await writeReconcileState\(/g)].map((m) => m.index);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(body.start);
    expect(calls[0]).toBeLessThan(body.end);
  });
});

describe("a deleted Shopify product is not retried forever", () => {
  it("the userErrors branch asks Shopify whether the product is gone before confirming off", () => {
    // Five records refused with 'Resource does not exist' on 30 Aug 2026 were
    // still being retried 1,367 ticks later, every two minutes, day and night.
    // The SECOND occurrence — the first belongs to failSafeUnpublish.
    const first = SRC.indexOf("const errs = res.publishableUnpublish.userErrors");
    const off = SRC.slice(SRC.indexOf("const errs = res.publishableUnpublish.userErrors", first + 1));
    expect(off.slice(0, 3000)).toMatch(/await productIsAbsent\(mapNode\.shopifyProductId\)/);
  });

  it("productIsAbsent answers 'not gone' when it cannot ask — the answer that keeps the intent standing", () => {
    const body = SRC.slice(SRC.indexOf("async function productIsAbsent"));
    expect(body.slice(0, 600)).toMatch(/catch \{\s*return false;\s*\}/);
  });
});

// ─── A ONE-SHOT TRANSACTION ABORT IS NOT EVIDENCE ────────────────────────────
// Returning `undefined` from an RTDB transaction callback aborts WITHOUT a
// server round trip, and the callback's first invocation is not guaranteed the
// server value — it may fire against a stale local cache. Both refusal paths
// in idMap.mjs therefore CONFIRM against a fresh read before they throw.
// writeIdMap has always done this; claimShopifyProduct did not until CodeRabbit
// pointed at the asymmetry on PR #551. A false refusal here is a product that
// silently fails to publish over a conflict that does not exist.
describe("idMap refusals are confirmed against the server, not against a cache", () => {
  const IDMAP = readFileSync(new URL("./idMap.mjs", import.meta.url), "utf8");

  it("the claim refusal re-reads before throwing, and retries once", () => {
    const body = IDMAP.slice(IDMAP.indexOf("export async function claimShopifyProduct"));
    const scoped = body.slice(0, body.indexOf("\n}\n"));
    expect(scoped).toMatch(/planClaim\(\(await ref\.get\(\)\)\.val\(\), productId\)/);
    // Bounded: the re-read happens on the FIRST abort only, so a genuine
    // conflict throws on the second pass rather than spinning.
    expect(scoped).toMatch(/attempt === 0/);
  });

  it("writeIdMap keeps the same discipline", () => {
    const body = IDMAP.slice(IDMAP.indexOf("export async function writeIdMap"));
    const scoped = body.slice(0, body.indexOf("\n}\n"));
    expect(scoped).toMatch(/planIdMapWrite\(\(await ref\.get\(\)\)\.val\(\), mapping\)/);
    expect(scoped).toMatch(/attempt === 0/);
  });
});

// ─── A RESOLVED RETRY LEAVES THE RETRY SET ───────────────────────────────────
// Retry pids are read individually every tick. One whose node was deleted, or
// which now needs no action, produces no worklist entry — so counting only
// `capped` as attempted would hold it in the bounded retry set for good,
// re-read every two minutes forever and crowding out a real failure.
describe("the retry set drains", () => {
  it("attempted counts every evaluated retry pid except those the cap deferred", () => {
    const gate = SRC.indexOf("if (COMMIT && !ONLY) {");
    const block = SRC.slice(gate, SRC.indexOf("\n}\n", gate));
    expect(block).toMatch(/retryPids\.filter\(\(pid\) => !deferred\.has\(pid\) && !unreadable\.has\(pid\)\)/);
    // The deferred set and the carried list must agree on what the cap missed,
    // or a pid could be dropped as attempted while never having been tried.
    expect(block).toMatch(/const deferred = new Set\(worklist\.slice\(capped\.length\)/);
    expect(block).toMatch(/\.\.\.deferred,/);
  });

  it("a retry pid whose own read failed is NOT counted as evaluated", () => {
    // Otherwise one transient blip drops a product from the retry set for good.
    expect(SRC).toMatch(/onUnreadable: \(pid, e\) =>/);
    expect(SRC).toMatch(/unreadable\.add\(pid\)/);
  });
});

// ─── THE TWO LEG TABLES MUST AGREE ──────────────────────────────────────────
//
// src/offline/nodes.js says which nodes this app mirrors and how deep a row
// is. functions/mirrorChanges/legs.cjs says which nodes get a change trigger
// and at what depth. They are separate files because functions/ deploys as its
// own package and cannot import from src/.
//
// IF THEY DRIFT, NOTHING BREAKS LOUDLY:
//   - a leg on the client with no trigger is mirrored once at setup and then
//     serves a copy that silently ages for ever, while its health record says
//     ok and its row count still matches whatever it downloaded;
//   - a trigger with no client leg writes change records nothing reads;
//   - a trigger at the WRONG DEPTH is the worst of the three. Too shallow and
//     every edit makes every device re-read a megabyte; too deep and the row
//     the client re-reads is not the row the store is keyed by, so the change
//     lands under a key nothing ever asks for.
//
// So this test reads both files and compares them. It imports nodes.js
// normally and `require`s the .cjs, because that is what each of them is.

import { describe, test, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { CHANGE_FED_LEGS, MIRROR_LEGS } from "../nodes";
import { CHANGE_RETENTION_MS } from "../changeFeed";
import { PAD_MS } from "../../insights/insightsLogRange";

const require_ = createRequire(import.meta.url);
const server = require_("../../../functions/mirrorChanges/legs.cjs");

describe("the client and server leg tables", () => {
  test("name exactly the same nodes", () => {
    expect(server.LEGS.map((l) => l.node).sort())
      .toEqual(CHANGE_FED_LEGS.map((l) => l.node).sort());
  });

  test("agree on every leg's name and depth", () => {
    const byNode = Object.fromEntries(CHANGE_FED_LEGS.map((l) => [l.node, l]));
    for (const s of server.LEGS) {
      const c = byNode[s.node];
      expect(c, `${s.node} has a trigger but no client leg`).toBeDefined();
      expect(s.name, `${s.node} leg name`).toBe(c.name);
      expect(s.depth, `${s.node} row depth`).toBe(c.depth);
    }
  });

  test("the ranged legs deliberately have NO trigger", () => {
    // /insights_log and /stock_movements are append-only and carry their own
    // forward cursor. A trigger on them would double the write traffic of the
    // two busiest nodes in the database for nothing.
    const ranged = MIRROR_LEGS.filter((l) => l.feed !== "changes").map((l) => l.node);
    for (const node of ranged) {
      expect(server.LEGS.map((l) => l.node)).not.toContain(node);
    }
  });

  test("agree on how long a change record is kept", () => {
    // The client decides "my cursor has fallen off the back" from this number.
    // If the server sweeps sooner, a device resumes from a cursor that skips
    // records — silently, and for ever.
    expect(server.CHANGE_RETENTION_MS).toBe(CHANGE_RETENTION_MS);
  });

  test("agree on where the log and the census live", async () => {
    const feed = await import("../changeFeed");
    expect(server.CHANGES_ROOT).toBe(feed.CHANGES_ROOT);
    expect(server.COUNTS_ROOT).toBe(feed.COUNTS_ROOT);
  });

  test("every leg's function name is exported by the trigger module", () => {
    // mirrorChanges.js builds its triggers from LEGS, so this reads it as
    // TEXT rather than importing it — importing would need
    // firebase-functions and would build eighteen live triggers in a unit test.
    const src = readFileSync(
      new URL("../../../functions/mirrorChanges/mirrorChanges.js", import.meta.url), "utf8",
    );
    expect(src).toContain("for (const leg of LEGS) triggers[leg.fn] = makeTrigger(leg);");
    expect(src).toContain("...triggers,");
  });

  test("index.js re-exports the trigger module, and skips its test-only exports", () => {
    const src = readFileSync(new URL("../../../functions/index.js", import.meta.url), "utf8");
    expect(src).toContain('require("./mirrorChanges/mirrorChanges.js")');
    // The underscore-prefixed exports are helpers, not functions. Deploying one
    // as a function would fail the deploy at best and create a nonsense
    // function at worst.
    expect(src).toContain('if (name.startsWith("_")) continue;');
  });
});

describe("push key arithmetic agrees in all three places", () => {
  test("the server, the change feed and insightsLogRange share one alphabet", async () => {
    const lib = require_("../../../functions/mirrorChanges/lib.cjs");
    const { pushKeyForMs } = await import("../../insights/insightsLogRange");
    const { msFromPushKey } = await import("../changeFeed");
    for (const ms of [0, 1, 1_700_000_000_000, 1_790_000_000_000]) {
      expect(lib.pushKeyForMs(ms)).toBe(pushKeyForMs(ms));
      expect(msFromPushKey(pushKeyForMs(ms))).toBe(ms);
    }
  });

  test("insightsLogRange's measured skew padding is still what it was", () => {
    // The change feed's cursor is a key we have SEEN, so it needs no padding.
    // /insights_log's does: its key and its `timestamp` are written by
    // different clocks, measured up to −725 s apart. This pins the padding so
    // a later tidy cannot quietly remove the margin that covers it.
    expect(PAD_MS).toBe(48 * 60 * 60 * 1000);
  });
});

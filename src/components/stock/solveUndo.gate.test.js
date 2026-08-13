import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Source-pinned wiring gates for Solve Undo (house idiom — no component
// renderer in this environment; see hiddenProducts.gate.test.js).
const here = dirname(fileURLToPath(import.meta.url));
const NETWORK = readFileSync(join(here, "NetworkTransfer.jsx"), "utf8");

describe("solve → undo wiring", () => {
  it("a solve is recorded as undoable ONLY when it actually wrote cells, with the exact written paths", () => {
    // updates is seed-if-absent: a cell that already existed is not in it and
    // must survive an undo — so the recorded paths MUST be Object.keys(updates),
    // inside the non-empty guard.
    const start = NETWORK.indexOf("if (Object.keys(updates).length) {");
    expect(start).toBeGreaterThan(-1);
    const block = NETWORK.slice(start, NETWORK.indexOf("setSolved", start));
    expect(block).toMatch(/setUndoables\(\(l\) => \[\{ key: `\$\{card\.pid\}_\$\{now\}`, pid: card\.pid, name: card\.name, store, locs, paths: Object\.keys\(updates\), at: serverNowMs\(\) \}, \.\.\.l\]\)/);
  });
  it("undo re-reads the cells and the engine's open node, refuses via solveUndoBlockers, and deletes via undoUpdate only", () => {
    expect(NETWORK).toMatch(/solveUndoBlockers\(\{ cellsByPath, openByLoc, solvedAtMs: u\.at \}\)/);
    expect(NETWORK).toMatch(/if \(blockers\.length\) \{/);
    expect(NETWORK).toMatch(/await update\(ref\(database\), undoUpdate\(u\.paths\)\)/);
    // No other write shapes in the undo handler.
    const undoStart = NETWORK.indexOf("const undoSolve = async (u) => {");
    const undoBlock = NETWORK.slice(undoStart, NETWORK.indexOf("\n  };", undoStart));
    const writes = undoBlock.match(/update\(ref\(database\)[^)]*\)/g) || [];
    expect(writes).toEqual(["update(ref(database), undoUpdate(u.paths)"]);
  });
  it("the engine guard reads the scoped per-product open node, never the whole tree", () => {
    expect(NETWORK).toMatch(/refill_engine\/open\/\$\{loc\}\/\$\{u\.pid\}/);
  });
  it("the undo strip survives the empty list — solving the last card is when it matters most", () => {
    // undoStrip must render inside the !cards.length early return too.
    const start = NETWORK.indexOf("if (!cards.length) {");
    const block = NETWORK.slice(start, NETWORK.indexOf("\n  }", start));
    expect(block).toMatch(/\{undoStrip\}/);
  });
  it("undo is canAct-gated like every other write on this screen", () => {
    expect(NETWORK).toMatch(/if \(!canAct \|\| u\.busy \|\| u\.done\) return;/);
  });
});

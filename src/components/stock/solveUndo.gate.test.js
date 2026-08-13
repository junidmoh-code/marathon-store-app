import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Source-pinned wiring gates for Solve Undo (house idiom — no component
// renderer in this environment; see hiddenProducts.gate.test.js).
const here = dirname(fileURLToPath(import.meta.url));
const NETWORK = readFileSync(join(here, "NetworkTransfer.jsx"), "utf8");
const HEALTH = readFileSync(join(here, "HealthView.jsx"), "utf8");

describe("solve → undo wiring", () => {
  it("a solve is recorded as undoable ONLY when it actually wrote cells, with the exact written paths and the prior-lock snapshot", () => {
    // updates is seed-if-absent: a cell that already existed is not in it and
    // must survive an undo — so the recorded paths MUST be Object.keys(updates),
    // inside the non-empty guard, alongside the solve-time priorOpen snapshot.
    const start = NETWORK.indexOf("if (Object.keys(updates).length) {");
    expect(start).toBeGreaterThan(-1);
    const block = NETWORK.slice(start, NETWORK.indexOf("setSolved", start));
    expect(block).toMatch(/setUndoables\(\(l\) => \[\{ key: `\$\{card\.pid\}_\$\{now\}`, pid: card\.pid, name: card\.name, store, locs, paths: Object\.keys\(updates\), priorOpen \}, \.\.\.l\]\)/);
  });
  it("the prior-lock snapshot is read BEFORE the seed write — identity, never clocks", () => {
    // A lock's createdAt is its scan's START time, so clock comparison
    // misclassifies a scan that spans the solve. The snapshot must be taken
    // in the pre-write loop.
    const readAt = NETWORK.indexOf("priorOpen[loc] = (await get(ref(database, `refill_engine/open/${loc}/${card.pid}`))).val()");
    const writeAt = NETWORK.indexOf("await update(ref(database), updates)");
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(writeAt);
    // And the guard core carries no timestamp inputs at all.
    expect(NETWORK).toMatch(/solveUndoBlockers\(\{ paths: u\.paths, openByLoc, priorOpenByLoc: u\.priorOpen \}\)/);
    expect(NETWORK).not.toMatch(/solvedAtMs/);
  });
  it("the deletion is per-cell TRANSACTIONS through undoCellTxn — never read-then-delete", () => {
    // The TOCTOU HIGH from the substitute pair: a plain update() of nulls
    // erases whatever landed after the guard read. Each cell must re-verify
    // the untouched seed INSIDE the CAS.
    expect(NETWORK).toMatch(/await Promise\.all\(u\.paths\.map\(\(p\) => runTransaction\(ref\(database, p\), undoCellTxn\)\)\)/);
    const undoStart = NETWORK.indexOf("const undoSolve = async (u) => {");
    const undoBlock = NETWORK.slice(undoStart, NETWORK.indexOf("\n  };", undoStart));
    expect(undoBlock).not.toMatch(/update\(ref\(database\)/);
  });
  it("an aborted cell is reported, a full undo clears the stale Solved banner and leaves the strip", () => {
    expect(NETWORK).toMatch(/const kept = u\.paths\.filter\(\(p, i\) => !results\[i\]\.committed\)/);
    expect(NETWORK).toMatch(/setUndoables\(\(l\) => l\.filter\(\(x\) => x\.key !== u\.key\)\)/);
    expect(NETWORK).toMatch(/setSolved\(\(d\) => \{ const n = \{ \.\.\.d \}; delete n\[u\.pid\]; return n; \}\);/);
  });
  it("double-tap cannot race two undos of one entry — in-flight keys live in a ref", () => {
    expect(NETWORK).toMatch(/undoInFlight\.current\.has\(u\.key\)\) return;/);
    expect(NETWORK).toMatch(/undoInFlight\.current\.delete\(u\.key\);/);
  });
  it("the engine guard reads the scoped per-product open node, never the whole tree", () => {
    expect(NETWORK).toMatch(/refill_engine\/open\/\$\{loc\}\/\$\{u\.pid\}/);
  });
  it("the undo strip survives the empty list — solving the last card is when it matters most", () => {
    const start = NETWORK.indexOf("if (!cards.length) {");
    const block = NETWORK.slice(start, NETWORK.indexOf("\n  }", start));
    expect(block).toMatch(/\{undoStrip\}/);
  });
  it("undo is canAct-gated like every other write on this screen", () => {
    expect(NETWORK).toMatch(/if \(!canAct \|\| u\.busy \|\| undoInFlight\.current\.has\(u\.key\)\) return;/);
  });
  it("the undoables list is OWNED by HealthView — a glance at Sneakers/Hidden cannot drop a fresh undo", () => {
    // NetworkTransfer unmounts on those chips; its local state would die with
    // it. HealthView persists for the whole Inventory Health visit.
    expect(HEALTH).toMatch(/const \[solveUndoables, setSolveUndoables\] = useState\(\[\]\)/);
    expect(HEALTH).toMatch(/<NetworkTransfer[^>]*undoables=\{solveUndoables\} setUndoables=\{setSolveUndoables\}/);
    expect(NETWORK).toMatch(/const undoables = undoablesProp \?\? localUndoables;/);
  });
});

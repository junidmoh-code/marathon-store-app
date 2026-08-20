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
    expect(block).toMatch(/paths: cellPaths,/);
    expect(block).toMatch(/priorOpen,?\s*\}/);
    // `cellPaths` is captured BEFORE the introduce rows are merged into `updates`
    // (PR: Solve's carriage gate). That is stricter than the old
    // `paths: Object.keys(updates)`, not looser: `updates` now also carries
    // /stock_targets leaves, and undo runs `paths` through undoCellTxn — a CAS whose
    // predicate tests a stock CELL. Feeding a target row into it would abort every
    // time at best, and evaluate a cell predicate against a row at worst.
    const capture = NETWORK.indexOf("const cellPaths = Object.keys(updates);");
    const merge = NETWORK.indexOf("Object.assign(updates, introPaths);");
    expect(capture).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(merge);
    // And the two path sets are recorded separately, never conflated.
    expect(block).toMatch(/introPaths: Object\.keys\(introPaths\), introAt: now/);
  });

  it("the introduce rows ride in the SAME atomic update as the cells", () => {
    // Two halves of one statement: "this shop stocks this line, and here are its
    // sizes". Split across two writes, a failure between them leaves seeded cells
    // with no carriage behind them — cells the engine will never refill, which is
    // precisely the silent lie the carriage gate exists to stop.
    const solveStart = NETWORK.indexOf("const solve = async (card, panelPlan = null) => {");
    const body = NETWORK.slice(solveStart, NETWORK.indexOf("\n  };", solveStart));
    expect(body).toMatch(/Object\.assign\(updates, introPaths\);/);
    // Exactly ONE write in the whole solve path.
    expect(body.match(/await update\(ref\(database\)/g) || []).toHaveLength(1);
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
    // STILL LITERALLY TRUE after the carriage gate added a /stock_targets cleanup.
    // That cleanup lives in removeIntroducedRows(), outside this function, precisely
    // so this assertion keeps meaning what it says — a guard you can satisfy by
    // arguing "but MY update is a different kind of path" has stopped being a guard.
    expect(undoBlock).not.toMatch(/update\(ref\(database\)/);
    expect(undoBlock).toMatch(/await removeIntroducedRows\(u\.introPaths, u\.introAt\)/);
  });

  it("the introduce-row cleanup never touches a stock cell, and removes ONLY rows this solve wrote", () => {
    const fnStart = NETWORK.indexOf("async function removeIntroducedRows(");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = NETWORK.slice(fnStart, NETWORK.indexOf("\n}", fnStart));
    // It only ever addresses the row paths it was handed. Nothing here can
    // address /stock.
    expect(fn).not.toMatch(/stockCellPath|`stock\//);
    // Per-row CAS, not read-then-delete: authorship is proven INSIDE the
    // transaction by the solve's own introducedAt stamp, so a row edited since
    // (a target added, a later re-introduction) aborts and stays whole. The
    // first version skipped rows with a numeric target OUTSIDE the transaction
    // and left introduce:true standing over zero cells — the incident shape this
    // PR exists to prevent.
    expect(fn).toMatch(/runTransaction\(ref\(database, p\)/);
    expect(fn).toMatch(/cur\.introducedAt === introAt/);
    expect(fn).toMatch(/typeof cur\.target !== "number"/);
  });

  it("a PARTIAL undo leaves the introduction standing", () => {
    // Cells that kept real stock are still carried, and revoking the carriage under
    // them would starve exactly the cells the CAS just proved are in use. So the
    // cleanup sits in the fully-undone branch only.
    const undoStart = NETWORK.indexOf("const undoSolve = async (u) => {");
    const undoBlock = NETWORK.slice(undoStart, NETWORK.indexOf("\n  };", undoStart));
    const keptBranch = undoBlock.indexOf("if (kept.length) {");
    const cleanup = undoBlock.indexOf("removeIntroducedRows");
    const elseBranch = undoBlock.indexOf("} else {", keptBranch);
    expect(keptBranch).toBeGreaterThan(-1);
    expect(elseBranch).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(elseBranch);
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

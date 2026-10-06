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
    //
    // One confirm can now cover several stores (sections, 2026-10): each
    // store's part is built into its own `updates`, its undo record is made
    // under the SAME non-empty guard with the SAME exact paths, and the
    // records are added to the list only after the ONE merged write landed.
    expect(NETWORK).toContain("if (Object.keys(updates).length) entries.push({ key, pid: card.pid, name: card.name, store, locs, paths: Object.keys(updates), priorOpen });");
    // a single-store confirm keeps the key it always had
    expect(NETWORK).toContain("const key = many ? `${card.pid}_${now}_${store}` : `${card.pid}_${now}`;");
    const start = NETWORK.indexOf("const updates = mergeSolveUpdates(parts);");
    expect(start).toBeGreaterThan(-1);
    const block = NETWORK.slice(start, NETWORK.indexOf("setSolved", start));
    expect(block).toMatch(/if \(Object\.keys\(updates\)\.length\) \{\s+await update\(ref\(database\), updates\);\s+setUndoables\(\(l\) => \[\.\.\.entries, \.\.\.l\]\);\s+\}/);
  });
  it("the prior-lock snapshot is read BEFORE the seed write — identity, never clocks", () => {
    // A lock's createdAt is its scan's START time, so clock comparison
    // misclassifies a scan that spans the solve. The snapshot must be taken
    // in the pre-write loop.
    // Two write paths since the first batch (2026-09-17), each with its own
    // pre-write snapshot: the first-batch path takes it from the LIVE lock
    // read it already makes for Central's reservations (openNow), the old
    // path from its own per-location read. Both must precede their write.
    const fbReadAt = NETWORK.indexOf("if (onPath) { try { openNow = await readOpenLocks(card.pid); } catch { openNow = null; } }");
    const fbSnapAt = NETWORK.indexOf("priorOpen[loc] = openNow[loc] ?? null;");
    // (Sections, 2026-10: both paths are now per-store parts of ONE write —
    // there is a single update in the solve, and BOTH snapshots precede it.)
    const solveStart = NETWORK.indexOf("const solve = async (card) => {");
    const solveBlock = NETWORK.slice(solveStart, NETWORK.indexOf("\n  };", solveStart));
    expect(solveBlock.split("await update(ref(database), updates)").length - 1).toBe(1);
    const writeAt = NETWORK.indexOf("await update(ref(database), updates)");
    expect(fbReadAt).toBeGreaterThan(-1);
    expect(fbSnapAt).toBeGreaterThan(fbReadAt);
    expect(fbSnapAt).toBeLessThan(writeAt);
    const readAt = NETWORK.indexOf("priorOpen[loc] = (await get(ref(database, `refill_engine/open/${loc}/${card.pid}`))).val()");
    expect(readAt).toBeGreaterThan(fbReadAt);
    expect(readAt).toBeLessThan(writeAt);
    // And the guard core carries no timestamp inputs at all.
    // (ownRunId, first batch 2026-09-17: the solve's OWN server-claimed lock is
    // exempted by runId — an identity, still never a clock.)
    // (Sections, 2026-10: the paths judged and deleted are the entry's own,
    // less any a sibling solve of the same product still standing also wrote
    // — for a one-store solve, every path. solveSections.undoablePaths.)
    expect(NETWORK).toContain("const ownPaths = undoablePaths(u, undoables);");
    expect(NETWORK).toMatch(/solveUndoBlockers\(\{ paths: ownPaths, openByLoc, priorOpenByLoc: u\.priorOpen, ownRunId: [^}]*\}\)/);
    expect(NETWORK).not.toMatch(/solvedAtMs/);
  });
  it("the deletion is per-cell TRANSACTIONS through undoCellTxn — never read-then-delete", () => {
    // The TOCTOU HIGH from the substitute pair: a plain update() of nulls
    // erases whatever landed after the guard read. Each cell must re-verify
    // the untouched seed INSIDE the CAS.
    expect(NETWORK).toMatch(/await Promise\.all\(ownPaths\.map\(\(p\) => runTransaction\(ref\(database, p\), undoCellTxn\)\)\)/);
    const undoStart = NETWORK.indexOf("const undoSolve = async (u) => {");
    const undoBlock = NETWORK.slice(undoStart, NETWORK.indexOf("\n  };", undoStart));
    // (First batch, 2026-09-17: the shop-request cancel is ALSO a CAS —
    // firstBatchUndoCancelTxn through runTransaction — so the undo still
    // issues no plain update() at all.)
    expect(undoBlock).not.toMatch(/update\(ref\(database\)/);
    expect(undoBlock).toMatch(/runTransaction\(ref\(database, `refill_requests\/\$\{id\}`\), txn\)/);
  });
  it("an aborted cell is reported, a full undo clears the stale Solved banner and leaves the strip", () => {
    expect(NETWORK).toMatch(/const kept = ownPaths\.filter\(\(p, i\) => !results\[i\]\.committed\)/);
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

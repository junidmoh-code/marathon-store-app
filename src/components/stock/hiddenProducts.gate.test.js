import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Source-pinned gates, in the house idiom (UserManagement.gate.test.jsx,
// refill-cadence.test.cjs): this environment has no component renderer, so
// the wiring decisions that make hide SAFE are asserted against the source.
// Each is a real decision a refactor could silently undo.
const here = dirname(fileURLToPath(import.meta.url));
const HEALTH = readFileSync(join(here, "HealthView.jsx"), "utf8");
const HIDDEN = readFileSync(join(here, "HiddenProducts.jsx"), "utf8");
const NETWORK = readFileSync(join(here, "NetworkTransfer.jsx"), "utf8");

describe("HealthView wiring — the partition is downstream and the lists don't cross", () => {
  it("the main list renders the VISIBLE set, the hidden tab joins against the FULL set", () => {
    // NetworkTransfer must get missingVisible (a hidden card leaves the list),
    // while HiddenProducts must get the FULL card list — the join that labels
    // rows STILL MISSING vs NO LONGER MISSING needs cards the main list no
    // longer shows.
    expect(HEALTH).toMatch(/<NetworkTransfer[^>]*cards=\{missingVisible\}/);
    expect(HEALTH).toMatch(/<HiddenProducts[^>]*cards=\{missingProductCards \|\| \[\]\}/);
  });
  it("chips and the headline count are built from the visible set", () => {
    expect(HEALTH).toMatch(/buildChips\(missingVisible,/);
    expect(HEALTH).toMatch(/missingProductCards == null \? null : missingVisible\.length/);
  });
  it("the hidden tab bypasses pickActiveTab — it is not a chip, so the fallback must not eat it", () => {
    // pickActiveTab only knows the visible chips; without the special case,
    // selecting "hidden" would silently fall back to Clothing and the
    // entrance would appear dead.
    expect(HEALTH).toMatch(/missingTab === "hidden" \? "hidden" : pickActiveTab\(chips, missingTab\)/);
  });
  it("the entrance is the unlabelled HoldSpot in the chip row, and the Hidden chip only shows once open", () => {
    expect(HEALTH).toMatch(/<HoldSpot onTrigger=\{\(\) => setMissingTab\("hidden"\)\} \/>/);
    // The visible "Hidden (n)" chip is inside the activeTab === "hidden"
    // branch, and counts ENTRIES (what the tab lists — resolved included),
    // not hidden cards.
    expect(HEALTH).toMatch(/\{activeTab === "hidden" && \([\s\S]{0,800}?Hidden \(\{Object\.keys\(hiddenMap \|\| \{\}\)\.length\}\)/);
  });
});

describe("HoldSpot — deliberate, invisible, accident-proof", () => {
  it("renders no label, no icon, no text — a customer over the counter sees nothing", () => {
    const holdSpot = HIDDEN.slice(HIDDEN.indexOf("export function HoldSpot"));
    // Its one element is an empty self-closing div (handlers + style only).
    expect(holdSpot).toMatch(/\/>\s*\);\s*}\s*$/);
    expect(holdSpot).not.toMatch(/>[A-Za-z]/);
  });
  it("requires a 600 ms hold — a stray tap can never open it", () => {
    expect(HIDDEN).toMatch(/holdMs = 600/);
    expect(HIDDEN).toMatch(/setTimeout\(\(\) => \{ press\.current = null; onTrigger\(\); \}, holdMs\)/);
  });
  it("a hold in progress dies with the component — unmount clears the timer", () => {
    // Without this, unmounting mid-hold fires onTrigger into a dead tree.
    // (Sonnet architect review, PR #356.)
    expect(HIDDEN).toMatch(/useEffect\(\(\) => cancel, \[\]\);/);
  });
  it("cancels on movement — a scroll gesture over the spot cannot fire it", () => {
    expect(HIDDEN).toMatch(/Math\.hypot\(e\.clientX - p\.x, e\.clientY - p\.y\) > 12/);
    expect(HIDDEN).toMatch(/onPointerUp=\{cancel\} onPointerLeave=\{cancel\} onPointerCancel=\{cancel\}/);
  });
  it("is discretion, not security — no password, no role gate on viewing", () => {
    const holdSpot = HIDDEN.slice(HIDDEN.indexOf("export function HoldSpot"));
    expect(holdSpot).not.toMatch(/password|permRecord|isSuperAdmin|stockRole/i);
  });
  it("a stale 'hidden' selection does NOT survive leaving the screen", () => {
    // HealthView never unmounts between drill-ins, so without this reset one
    // hold gesture would leave the hidden tab a plain tap away for the rest
    // of the session — the exact over-the-counter exposure the HoldSpot
    // prevents. (Sonnet architect review, PR #356 — the MAJOR finding.)
    expect(HEALTH).toMatch(/setMissingTab\(\(t\) => \(t === "hidden" \? null : t\)\); setScreen\("missingProducts"\)/);
  });
});

describe("the writes stay inside the one small node", () => {
  it("HiddenProducts writes ONLY via unhideUpdate (one action, entry delete, nothing else)", () => {
    const writes = HIDDEN.match(/update\(ref\(database\)[^)]*\)/g) || [];
    expect(writes).toEqual(["update(ref(database), unhideUpdate([pid])"]);
    // No set(), no other update targets — unhide restores by deleting the
    // entry; it must never touch stock, targets, or anything beside the node.
    expect(HIDDEN).not.toMatch(/\bset\(/);
  });
  it("NetworkTransfer's hide writes ONLY the hidden-root entry for that pid", () => {
    expect(NETWORK).toMatch(/\[`\$\{HIDDEN_ROOT\}\/\$\{card\.pid\}`\]: hideEntry\(/);
  });
  it("Hide is a dim text control BELOW the action row, never a third button box", () => {
    // The card's action language is one green primary + one ghost secondary;
    // a third bordered box read as a disabled sibling and crowded the name
    // column (owner feedback, 2026-08-13).
    expect(NETWORK).toMatch(/flexDirection: "column", alignItems: "flex-end"/);
    expect(NETWORK).toMatch(/background: "none", border: "none"[^}]*\}\}>\s*\{hOpen \? "Cancel" : "Hide from list"\}/);
  });
  it("bulk hide is ONE update over exactly the selection, via the pinned builder", () => {
    // bulkHideUpdate is the tested guarantee that only the selected set is
    // written; bulk hide must go through it, in a single update().
    expect(NETWORK).toMatch(/update\(ref\(database\), bulkHideUpdate\(selectedPids, \{ at: serverNowMs\(\), by: auth\.currentUser\?\.uid, reason \}\)\)/);
  });
});

describe("select mode — a mis-tap can only toggle selection", () => {
  it("select-mode cards render no actions and no panels — Solve/Transfer/Hide all stand down", () => {
    // The early-return block for selectMode must not reach any acting code:
    // the whole card is a checkbox, so tapping around at speed over hundreds
    // of cards can never move stock or seed cells.
    const start = NETWORK.indexOf("if (selectMode) {");
    expect(start).toBeGreaterThan(-1);
    const block = NETWORK.slice(start, NETWORK.indexOf("\n        }", start));
    expect(block).not.toMatch(/solve\(|transfer\(|hide\(|applyMovement|setSolvePid|setOpenPid/);
    expect(block).toMatch(/setSelected/);
  });
  it("entering select mode closes any open panel — nothing reopens stale on exit", () => {
    expect(NETWORK).toMatch(/setSelectMode\(true\); setOpenPid\(null\); setSolvePid\(null\); setHidePid\(null\);/);
  });
  it("the selection reconciles against the live card list before counting or writing", () => {
    // A selected card that resolves out mid-select must neither inflate the
    // "N selected" count nor ride into the bulk write — and the set derives
    // from `cards` (the fallback-aware RENDERED list), not the allCards prop,
    // which is null on the standalone path and would dead-end select mode.
    // (Kimi + Sonnet substitute pair, PR #356.)
    expect(NETWORK).toMatch(/selected\[k\] && cardPidSet\.has\(k\)/);
    expect(NETWORK).toMatch(/cardPidSet = useMemo\(\(\) => new Set\(cards\.map\(\(c\) => c\.pid\)\), \[cards\]\)/);
  });
  it("the viewing-only banner renders on the EMPTY hidden tab too", () => {
    // The banner must be computed above the empty-state early return and
    // rendered inside it. (Kimi substitute review, PR #356.)
    const bannerAt = HIDDEN.indexOf("const banner = !canAct");
    const emptyReturnAt = HIDDEN.indexOf("if (!rows.length)");
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(emptyReturnAt);
    expect(HIDDEN).toMatch(/return <>\{banner\}<div/);
  });
  it("a selection never survives a chip switch", () => {
    expect(NETWORK).toMatch(/useEffect\(\(\) => \{ exitSelect\(\); \}, \[category\]\)/);
  });
  it("selection cards are keyboard-operable checkboxes, not click-only divs", () => {
    // (CodeRabbit, PR #356.)
    expect(NETWORK).toMatch(/role="checkbox" aria-checked=\{on\} tabIndex=\{0\} onClick=\{toggle\}/);
    expect(NETWORK).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });
});

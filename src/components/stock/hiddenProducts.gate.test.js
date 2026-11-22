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
const SCREEN = readFileSync(join(here, "MissingProductsScreen.jsx"), "utf8");
const CARD = readFileSync(join(here, "MissingCard.jsx"), "utf8");
const APP = readFileSync(join(here, "../../App.jsx"), "utf8");

// 22 Nov 2026: Missing Products left Inventory Health for its own screen
// (MissingProductsScreen.jsx). The same decisions, pinned where they now live.
describe("the screen's wiring — the partition is downstream and the lists don't cross", () => {
  it("the main list renders the VISIBLE set, the hidden tab joins against the FULL set", () => {
    // The Solve hook must get the visible set (a hidden card leaves the list)
    // BEFORE the "resolving" filter — it hides just-solved cards itself and
    // needs the live list to know when the card has really gone — while
    // HiddenProducts must get the FULL card list: the join that labels rows
    // STILL MISSING vs NO LONGER MISSING needs cards the main list no longer shows.
    // (22 Nov 2026, the rebuilt screen: the hide filter is applied to the ROWS,
    // after they are built — one place, for the list and the count alike —
    // and every card has a Hide, sneakers included, so the hidden tab joins
    // against both cores' cards.)
    expect(SCREEN).toMatch(/const listedOf = \(id\) => sliced\.rows\[id\]\.filter\(\(r\) => !\(hiddenMap && hiddenMap\[r\.pid\]\) && !gone\[r\.key\]\);/);
    expect(SCREEN).toMatch(/divisions\.flatMap\(\(s\) => \[\.\.\.\(walked\[s\]\?\.all \|\| \[\]\), \.\.\.\(walked\[s\]\?\.sneakers \|\| \[\]\)/);
    expect(SCREEN).toMatch(/<HiddenProducts products=\{products\} cards=\{hiddenCards\} hiddenMap=\{hiddenMap\} \/>/);
  });
  it("the count on the division switch is built from the visible set", () => {
    // The count is the number of cards on the division's two lists — the same
    // rows, through the same filter…
    expect(SCREEN).toMatch(/KINDS\.reduce\(\(t, \[k\]\) => t \+ listedOf\(bucketId\(sec, k\)\)\.length, 0\)/);
    // …and never from a half-loaded /stock or a list still being worked out
    // (a zero would say "nothing missing"): no number until both are complete.
    expect(SCREEN).toMatch(/const countOf = \(sec\) => \(KINDS\.every\(\(\[k\]\) => sliced\.complete\[bucketId\(sec, k\)\]\)/);
    expect(SCREEN).toMatch(/const ready = stockReady && /);
  });
  it("the entrance is the unlabelled HoldSpot beside the title, and the word Hidden only shows once open", () => {
    expect(SCREEN).toMatch(/<HoldSpot onTrigger=\{\(\) => setView\("hidden"\)\} \/>/);
    // "Hidden (n)" is the title only inside the hidden view, and counts
    // ENTRIES (what the tab lists — resolved included).
    expect(SCREEN).toContain('{view === "hidden" ? `Hidden (${hiddenCount})` : "Missing Products"}');
    expect(SCREEN).toMatch(/const hiddenCount = Object\.keys\(hiddenMap \|\| \{\}\)\.length;/);
    expect((SCREEN.match(/setView\("hidden"\)/g) || []).length).toBe(1);   // the HoldSpot is the only way in
  });
  it("Inventory Health no longer carries the tab — its tile leads to the screen", () => {
    expect(HEALTH).not.toMatch(/<NetworkTransfer|<MissingFootwear|<HiddenProducts|<HoldSpot|partitionHidden\(/);
    expect(HEALTH).toMatch(/onClick=\{onOpenMissingProducts \|\| undefined\}/);
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
    // One hold gesture must not leave the hidden tab a plain tap away for the
    // rest of the session — the over-the-counter exposure the HoldSpot
    // prevents (Sonnet architect review, PR #356). The view is the screen's
    // own state: leaving the screen unmounts it, and switching division
    // returns to the list.
    expect(SCREEN).toMatch(/const \[view, setView\] = useState\("list"\);/);
    expect(SCREEN).toMatch(/onClick=\{\(\) => \{ setPick\(sec\); setView\("list"\); \}\}/);
    expect(SCREEN).toMatch(/onClick=\{\(\) => \{ setKind\(k\); setView\("list"\); \}\}/);
    expect(APP).toMatch(/<MissingProductsScreen products=\{products\} onExit=\{\(\) => setRole\(null\)\} \/>/);
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
  it("Hide is a quiet text link under the one primary action, never a second button box", () => {
    // The card's action language is ONE primary; a bordered Hide box beside
    // it read as a disabled sibling (owner feedback, 2026-08-13). It is one of
    // the card's small links (MissingCard.jsx), with a full-size tap target.
    expect(NETWORK).toMatch(/links\.push\(\{ action: "open-hide", label: "Hide from list"/);
    expect(CARD).toMatch(/const linkBtn = \{ background: "none", border: "none"[^}]*minHeight: 44/);
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
    expect(CARD).toMatch(/role: "checkbox", "aria-checked": !!select\.on, tabIndex: 0, onClick: select\.toggle/);
    expect(CARD).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });
});

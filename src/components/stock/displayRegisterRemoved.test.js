// ─── DISPLAY REGISTER — PROOF OF REMOVAL ─────────────────────────────────────
// Owner spec 2026-08-06 §8: after the cleanup we do not track what is on
// display at all. The accumulating register (one row per distinct size ever
// sent — the "size 6 and size 8 both marked displayed" bug) is REMOVED, and
// sending a display must not create any display record.
//
// The register lived at /settings/displayRegister and had exactly one writer
// module (DisplayRegister.jsx, via its own UI and registerDisplayPair called
// from the send flow) and one reader (the same module). This test pins that the
// module is gone and that NOTHING in src can reach that node again — the same
// source-text idiom the deleted DisplayRegister.gate.test.jsx used, because a
// monolithic App.jsx offers no seam to prove a non-write behaviourally.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the display register is gone", () => {
  it("the module and its card no longer exist", () => {
    expect(existsSync(join(SRC, "components/stock/DisplayRegister.jsx"))).toBe(false);
    expect(existsSync(join(SRC, "components/stock/HubSneakerCountCard.jsx"))).toBe(false);
  });

  it("nothing in src reads or writes /settings/displayRegister any more", () => {
    const offenders = walk(SRC).filter((p) => {
      if (p.endsWith("displayRegisterRemoved.test.js")) return false;
      return /settings\/displayRegister|registerDisplayPair/.test(readFileSync(p, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("the send flow consults the pure size rule instead of registering a display", () => {
    const app = readFileSync(join(SRC, "App.jsx"), "utf8");
    expect(app).toMatch(/displaySendNeedsSize\(order, guardProduct\)/);
    expect(app).not.toMatch(/registerDisplayPair/);
  });
});

describe("the merge redirect wiring holds (review round pins)", () => {
  const app = () => readFileSync(join(SRC, "App.jsx"), "utf8");

  it("every order→product lookup resolves through the unfiltered index", () => {
    // The filtered products array must never be used to find an order's
    // product — a merged-away id would come back undefined and fail open
    // (double dispatch deduction, skipped size gate, wrong refill hub).
    expect(app()).not.toMatch(/products\.find\(\(?p\)? *=> *p(?: && p)?\.id === order\.productId\)/);
    expect((app().match(/resolveProductById\(order\.productId\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(app()).toMatch(/ALL_PRODUCTS_BY_ID = Object\.fromEntries/);
  });

  it("review-round pins: junk style input is refused with a note; the barcode shortcut loads stock", () => {
    const reader = readFileSync(join(SRC, "components/stock/TongueLabelReader.jsx"), "utf8");
    // applyTyped must refuse an input that formats to nothing, with an explanation:
    expect(reader).toMatch(/if \(!formatted\) \{/);
    expect(reader).toMatch(/doesn't look like a style number/);
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    // the register branch of the barcode shortcut must start the stock-by-location load:
    expect(hubCleanup).toMatch(/setPanel\(registerPanelFor\(out\.product, out\.size\)\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*ensureAllStock\(\)/);
  });

  it("count-pass pins: label-first entry, one shared reader, unresolved fires on the label path", () => {
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    // ONE shared tongue-label reader component (its own module since fix 4,
    // reused by register, count AND the assistant) — the count tab mounts it
    // big as the primary entry, the register panel reuses it:
    const readerFile = readFileSync(join(SRC, "components/stock/TongueLabelReader.jsx"), "utf8");
    expect((readerFile.match(/export function TongueLabelReader/g) || []).length).toBe(1);
    expect(hubCleanup).not.toMatch(/function TongueLabelReader/);
    expect(hubCleanup).toMatch(/<TongueLabelReader big busy=\{busy\} onCode=\{\(code, meta\) => handleStyleNumber\(code, meta\)\} onTokens=\{handleAliasTokens\} \/>/);
    expect(hubCleanup).toMatch(/<TongueLabelReader busy=\{busy\} onCode=\{takeCode\} onTokens=\{takeTokens\} \/>/);
    // The count tab must NOT lead with a barcode scan any more:
    expect(hubCleanup).not.toMatch(/SCAN A SHOE/);
    // The never-registered signal fires on the LABEL path (style-number
    // resolution), not only on the barcode shortcut:
    expect(hubCleanup).toMatch(/reads cleanly but nothing owns it/);
    expect(hubCleanup).toMatch(/recordUnresolvedScan\(\{ hub, code: display, context: "count" \}\)/);
    // Substitute-review pins (Kimi + Sonnet round):
    // exactly ONE name-search input on the count tab — the leftover twin is gone:
    expect((hubCleanup.match(/or search by name/g) || []).length).toBe(1);
    expect(hubCleanup).not.toMatch(/search by name \(secondary\)/);
    // a failed product lookup on a claim is an ERROR, never a false never-registered:
    expect(hubCleanup).toMatch(/Couldn't look that product up/);
    // the never-registered note only confirms when the write succeeded:
    expect(hubCleanup).toMatch(/noted\.ok/);
    // a claim resolving to a ghost/id-less record falls through WITH feedback:
    expect(hubCleanup).toMatch(/const cp = countPanelFor\(p\);/);
  });

  it("display-send confirm pins: no inline size commit, banner after commit", () => {
    const app = readFileSync(join(SRC, "App.jsx"), "utf8");
    // Size buttons in the display-send guard dispatch PICK_SIZE — they never
    // call markSentAndPrint directly (the mis-tap-commits defect):
    expect(app).toMatch(/onClick=\{\(\) => d\(\{ type: "PICK_SIZE", size: s \}\)\}/);
    expect(app).not.toMatch(/onClick=\{\(\) => markSentAndPrint\(order, \{ sentSize: s \}\)\}/);
    // The commit runs only through the machine's CONFIRM directive:
    expect(app).toMatch(/const done = sendFlowReduce\(flow, \{ type: "CONFIRM" \}\);/);
    expect(app).toMatch(/if \(!done\.commit\) return;/);
    // OOS goes through its own confirm, and the post-commit banner exists:
    expect(app).toMatch(/OPEN_OOS/);
    expect(app).toMatch(/sentBannerCopy\(done\.commit/);
    // Flow state is keyed id+createdAt, never bare order.id — the counter
    // resets daily and reuses ids, and a stale confirm step must not attach
    // itself to the NEXT day's unrelated order (substitute-review CRITICAL):
    expect(app).toMatch(/sendFlowKey = \(order\) => `\$\{order\.id\}::\$\{order\.createdAt \?\? ""\}`/);
    expect(app).toMatch(/sendFlows\[sendFlowKey\(order\)\]/);
    expect(app).not.toMatch(/sendFlows\[order\.id\]/);
  });

  it("alias-era pins: readings never touch styleCodeNormalised; the mid-band asks a human", () => {
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    // The mid-band confirm files the reading as a further alias on YES:
    expect(hubCleanup).toMatch(/addLabelAlias\(\{ productId: cand\.id, tokens \}\)/);
    // Three frames, ≥2-of-3 agreement, through the shared merge helper:
    expect(readFileSync(join(SRC, "components/stock/TongueLabelReader.jsx"), "utf8")).toMatch(/mergeFrameTokens\(frameTokens\)/);
    // A failed alias match is an ERROR, never a false never-registered:
    expect(hubCleanup).toMatch(/Couldn't check that reading/);
    const store = readFileSync(join(SRC, "components/stock/hubCleanupStore.js"), "utf8");
    // Alias registrations never enqueue a capture and never stamp a code:
    expect(store).toMatch(/aliasTokens \? "label_alias"/);
  });

  it("fix-4 pins: the assistant finder is wired, explicit about the tongue label, informative on a miss", () => {
    const app = readFileSync(join(SRC, "App.jsx"), "utf8");
    expect(app).toMatch(/function AssistantLabelFinder/);
    expect((app.match(/setLabelFinderOpen\(true\)/g) || []).length).toBe(2);   // mobile + desktop buttons
    expect(app).toMatch(/Find by the tongue label/);
    expect(app).toMatch(/Not the shop barcode sticker, not the box/);
    // A clean read with no registered owner says EXACTLY that — never generic:
    expect(app).toMatch(/isn't registered to any product — search by name instead/);
    expect(app).toMatch(/no registered product carries it — search by name instead/);
  });

  it("fix-3 pins: zero-seeds ride the save through setCellState; the run resets per category", () => {
    const app = readFileSync(join(SRC, "App.jsx"), "utf8");
    expect(app).toMatch(/for \(const zSize of zeroEntries\(sizes, recvQtys\)\)/);
    expect(app).toMatch(/setCellState\(recvLoc, id, zSize, "live"\)/);
    // The category reset. The printed-barcode answer joined it (PR #340): a
    // perfume EAN must not survive a switch to a SIZED category, where it
    // would register a one-size code against a product sized 9/10.
    expect(app).toMatch(/sizeRun: \[\],[\s\S]{0,700}?hubs: hubs\.length/);
    expect(app).toMatch(/printedBarcode: null,\n\s*printedBarcodeAuto: false,/);
    // The no-label rule follows what actually REGISTERED, never what was
    // merely attempted. Deriving it from the attempt told staff to print and
    // stick a fallback shop label while suppressing the only screen that
    // prints one. (Codex review, PR #340.)
    expect(app).toMatch(/const usesPrintedBarcode = printedBarcodeActive;/);
    expect(app).toMatch(/printedBarcodeActive = attach\.ok;/);
    // Review pins (#330): a failed seed is OBSERVED and reported (setCellState
    // resolves {ok:false}, it never throws), and the finder only ever hands
    // back records from the CURRENT catalog:
    expect(app).toMatch(/if \(!seed \|\| !seed\.ok\) failedSeeds\.push\(zSize\);/);
    expect(app).toMatch(/could not be created/);
    expect(app).toMatch(/return products\.find\(\(x\) => x && x\.id === fetched\.id\) \|\| null;/);
    const reader = readFileSync(join(SRC, "components/stock/TongueLabelReader.jsx"), "utf8");
    // Manual entry can never race a burst still reading:
    expect(reader).toMatch(/if \(reading \|\| busy\) return;/);
  });

  it("scan panels remount per scanned product, and the camera effect is render-stable", () => {
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    expect(hubCleanup).toMatch(/key=\{`reg_\$\{panel\.product\.id\}/);
    expect(hubCleanup).toMatch(/key=\{`cnt_\$\{panel\.product\.id\}/);
    const cam = readFileSync(join(SRC, "components/stock/CameraScanner.jsx"), "utf8");
    expect(cam).toMatch(/onScanRef\.current\(decodedText\)/);
    expect(cam).toMatch(/\}, \[\]\);/);
  });
});

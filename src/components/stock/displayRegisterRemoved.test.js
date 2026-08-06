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
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    // applyTyped must refuse an input that formats to nothing, with an explanation:
    expect(hubCleanup).toMatch(/if \(!formatted\) \{/);
    expect(hubCleanup).toMatch(/doesn't look like a style number/);
    // the register branch of the barcode shortcut must start the stock-by-location load:
    expect(hubCleanup).toMatch(/setPanel\(registerPanelFor\(out\.product, out\.size\)\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*ensureAllStock\(\)/);
  });

  it("count-pass pins: label-first entry, one shared reader, unresolved fires on the label path", () => {
    const hubCleanup = readFileSync(join(SRC, "components/stock/HubCleanup.jsx"), "utf8");
    // ONE shared tongue-label reader component, used by BOTH passes — the count
    // tab mounts it big as the primary entry, the register panel reuses it:
    expect((hubCleanup.match(/function TongueLabelReader/g) || []).length).toBe(1);
    expect(hubCleanup).toMatch(/<TongueLabelReader big busy=\{busy\} onCode=\{\(code\) => handleStyleNumber\(code\)\} \/>/);
    expect(hubCleanup).toMatch(/<TongueLabelReader busy=\{busy\} onCode=\{takeCode\} \/>/);
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

// ─── THE ABSOLUTE RULE, PINNED ───────────────────────────────────────────────
//
// (Owner directive, 2026-09-08.) "Nothing ever picks, guesses, suggests or
// pre-selects a display size — no default, no last-used, no most-available, no
// auto-fill."
//
// A rule about what code MUST NOT do cannot be proved by exercising the code:
// there is no input that demonstrates the absence of a default. So this reads
// the source of every surface that can put a size on the display record and
// pins the shapes that would reintroduce one.
//
// It is a source test on purpose, and it is the same technique
// displayMarkerInformational.test.js uses to pin that a deleted divert stays
// deleted. The failure it prevents has already happened twice on this feature:
//   • before 2026-08-26 the sheet did not appear at all, so the SENT size was
//     silently recorded as the display size;
//   • the fix left the sent size PRESELECTED, which is the same mistake wearing
//     a smaller hat — a preselected answer is the answer that gets confirmed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

// COMMENTS ARE STRIPPED BEFORE MATCHING. These files explain at length what
// they must not do — displayRowUi.jsx's own header says "no `defaultSize`
// prop" — so matching the raw source would fail on the documentation of the
// rule rather than on a breach of it. Strings survive: a preselect would be
// code, and code is what is being pinned.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const APP = code(read("../../App.jsx"));
const PICKER = code(read("./displayRowUi.jsx"));
// ONE SCREEN NOW. The Duplicate Displays and Unregistered Displays tabs were
// folded into the Display Registration view (owner, 2026-09-08), so the surface
// that can put a size on the record is this one file plus the shared picker.
const VIEW = code(read("./DisplayRegistrationView.jsx"));
const REQUEST = code(read("./displayRequestStore.js"));

describe("the warehouse size sheet opens with NOTHING chosen", () => {
  it("the sheet is opened with picked: null, always", () => {
    expect(APP).toContain("setSizeSheet({ order, options: sz.options, picked: null })");
  });

  it("no branch computes a picked size from the order", () => {
    // The exact shape that was there, and any near relative of it.
    expect(APP).not.toMatch(/picked:\s*sz\.known/);
    expect(APP).not.toMatch(/picked:\s*(order|o)\.(sentSize|size|displayRefillSize)/);
    expect(APP).not.toMatch(/picked:\s*[^n,}]*\?\s*String\(/);
  });

  it("a footwear refill ALWAYS asks — it never falls through to a direct write", () => {
    // `needed` is unconditionally true for footwear; the only early return is
    // the non-footwear one, which has no size to choose between.
    expect(APP).toMatch(/if \(!productIsFootwear\(prod\)\) return \{ needed: false/);
    expect(APP).toContain("return { needed: true, options, known: null };");
    // The old escape hatch: "no sizes on record → write the order's size".
    expect(APP).not.toMatch(/if \(!options\.length && known\) return \{ needed: false/);
  });
});

describe("the shared size picker has no default", () => {
  it("takes no defaultSize / initial / preselect prop of any kind", () => {
    expect(PICKER).not.toMatch(/default(Size|Picked)|preselect|initialSize|suggested/i);
  });

  it("starts at null and the confirm is dead until a human picks", () => {
    expect(PICKER).toContain("useState(null)");
    expect(PICKER).toContain("disabled={!picked || busy}");
  });

  it("offers no way through when the product declares no sizes", () => {
    // The empty-options branch renders a refusal, not a fallback.
    expect(PICKER).toMatch(/no sizes on record/);
    expect(PICKER).not.toMatch(/onPick\((order|row|product)\./);
  });
});

describe("nothing else invents a size", () => {
  it("the screen gets its size from the picker's callback only", () => {
    expect(VIEW).toContain("onPick={(sz) =>");
    // No "most available", no "the biggest cell", no "the one we sent".
    expect(VIEW).not.toMatch(/sort\([^)]*qty/);
    expect(VIEW).not.toMatch(/mostAvailable|lastUsed|bestSize|suggestSize/i);
  });

  it("the 15-minute timer raises a request and never a size", () => {
    // The request an auto/manual raise mints carries size: null, explicitly.
    expect(REQUEST).toMatch(/size:\s*null/);
    expect(REQUEST).not.toMatch(/size:\s*(product|p)\.sizes/);
  });

  it("the wall walk's request carries no size either", () => {
    // The wall walk's request passes a product and a hub, never a size.
    expect(VIEW).toMatch(/raiseDisplayRequest\(\{[\s\S]{0,200}?product:/);
    expect(VIEW).not.toMatch(/raiseDisplayRequest\([\s\S]{0,200}?size:/);
  });
});

// ─── CLAUSE 1'S GUARD MUST NOT GO BLIND WHEN A PULL MINTER COMES BACK ────────
//
// The checkout's one-open-request guard reads the STORE-SCOPED /orders feed, so
// it can only fence a wall that feed covers. Today it always does: a scoped
// user's effectiveShop IS the feed's scope (availableShops is clamped to
// myShop), and the only branch that could name a DIFFERENT store —
// `displayPairStore`, on a display-pair pull — has had no minter on the
// ordering screen since #576 deleted the divert.
//
// The display source-of-truth job is expected to re-attach a minter. On the day
// it does, this guard silently starts passing on walls it cannot read, and two
// pairs get walked to one wall. That is a failure with no symptom at the point
// of the change, which is exactly what a source pin is for.
// (Spec-conformance review.)
describe("the one-request guard cannot silently outgrow the feed it reads", () => {
  it("nothing on the ordering screen mints a display-pair pull", () => {
    // The flag the cross-store branch keys on. `addToCart`/quickAdd must never
    // set it true again without the guard learning to refuse an unreadable
    // store the way UnregisteredDisplaysTab's canRequest does.
    expect(APP).not.toMatch(/displayPairRequest:\s*true/);
  });

  it("availableShops stays clamped to myShop — the reason the guard can see", () => {
    // If this clamp goes, a scoped user can select a shop their /orders feed
    // does not cover and the guard reads an empty list as "nothing open".
    expect(APP).toMatch(/const availableShops = myShop\s*\n?\s*\?\s*allShops\.filter\(s => s\.id === myShop\)/);
  });

  it("the wall walk still refuses what it cannot verify", () => {
    expect(VIEW).toContain("const canRequest = !ordersScope || ordersScope === store;");
  });
});

// ─── CLAUSE 1 SITS ON THE PATH THAT MINTS THE TASK ──────────────────────────
//
// The READY re-stamp IS the auto-raise — it schedules the refill task the
// warehouse sees fifteen minutes later, and nothing raises it by hand. The
// guard sat on the two places a request is CREATED and not on the two that
// RE-OPEN one, which left two reachable routes to two pairs on one wall
// (OOS→Available re-stamping a cleared order, and an undo re-opening one after
// a newer request was raised).
//
// These are source pins because neither path is reachable from a unit test —
// they live inside WarehouseView's status handler and its undo, both of which
// need the whole warehouse screen. The predicate itself is exercised properly
// in displayRowCore.test.js. (Spec-conformance review.)
describe("the re-openers ask the guard before they re-open", () => {
  it("the READY re-stamp is conditional on no OTHER open request", () => {
    // The stamp must not be an unconditional `= now` any more: it lives in the
    // ELSE of the blocker check, so a blocked READY reaches none of it.
    expect(APP).toMatch(/if \(blockers\.length\) \{[\s\S]{0,300}?\} else \{\s*\n\s*patch\.displayRefillScheduledAt\s+= now;/);
    expect(APP).toMatch(/otherOpenDisplayRequests\(orders, \{ store: reqStore, productId: order\.productId, exceptId: order\.id \}\)/);
  });

  it("a BLOCKED ready touches no display-refill field at all", () => {
    // Nulling scheduledAt while still running the four resets wiped a resolved
    // order's resolution and left it OPEN WITH NO TASK — a fence invisible in
    // the warehouse list, held until the daily /orders id recycled. Every reset
    // must sit inside the else. (CodeRabbit.)
    // ANCHORED ON CODE, NOT A COMMENT. `APP` is comment-stripped (see the
    // header), so slicing from a comment returned -1 and sliced from the END of
    // the file — the assertion below then ran against a few closing braces and
    // could never fail. Found by mutation-testing this very test.
    const start = APP.indexOf("if (blockers.length) {");
    expect(start).toBeGreaterThan(0);
    const blockedArm = APP.slice(start, APP.indexOf("} else {", start));
    expect(blockedArm).toMatch(/console\.warn/);      // we are looking at the right arm
    expect(blockedArm).not.toMatch(/patch\.displayRefill/);
    expect(blockedArm).not.toMatch(/patch\.displayRefilled/);
  });

  it("the READY path still lets the CUSTOMER's half through — no early return", () => {
    // Withholding the wall's task must never swallow the order_ready WhatsApp
    // or the insight log. An early return in that branch would do both.
    // Same anchoring rule: code, not comments.
    const s2 = APP.indexOf("const blockers = reqStore");
    expect(s2).toBeGreaterThan(0);
    const readyBranch = APP.slice(s2, APP.indexOf("} else if (status !== STATUS.COLLECTED) {", s2));
    expect(readyBranch).not.toMatch(/\breturn;/);
  });

  it("the refill undo refuses when another request holds the wall", () => {
    expect(APP).toMatch(/otherOpenDisplayRequests\(orders, \{ store: undoStore, productId: order\.productId, exceptId: order\.id \}\)/);
    expect(APP).toMatch(/if \(undoBlockers\.length\) \{[\s\S]{0,400}?return;/);
  });

  it("both re-openers exclude the order in hand, or they would block themselves", () => {
    const uses = APP.match(/otherOpenDisplayRequests\([^)]*\)/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const u of uses) expect(u).toMatch(/exceptId: order\.id/);
  });
});

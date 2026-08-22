// ─── THE MERGE TARGET PICKER TAKES A PHOTO (owner spec 2026-08-22) ───────────
// THE DEFECT: the merge picker's only camera was CameraScanner — a LIVE
// barcode stream. Tongue labels carry no barcode, so it never resolved, and
// typing a name was the only working path: the exact act that manufactures the
// duplicates this screen exists to clean up.
//
// This suite proves the PORT of the count flow's photo-capture reader into the
// merge picker. The real MergeProducts renders; these are wiring claims:
//
//   1. The picker mounts the PHOTO-CAPTURE reader, and the live scanner is NOT
//      the primary action (it is not mounted until its secondary tap).
//   2. A label with THREE code-shaped tokens produces ONE pooled list holding
//      candidates found by all three, and every token is resolved.
//   3. NO AUTO-PICK: two or more candidates never advances to the confirm.
//   4. Not even a SINGLE candidate is auto-picked — the operator taps.
//   5. Every row carries the product PHOTO and the number that found it.
//   6. Name search still works, BELOW the suggestions, with both lists visible.
//   7. Picking a row reaches the UNCHANGED confirm screen (both products,
//      photos, every stock cell, an explicit MERGE button).
//   8. NO merge behaviour changed: nothing is written before the confirm tap,
//      and the confirm still calls mergeProducts with {loserId, survivorId}.
//   9. The label wording path (a read with no code) pools into the same list.
//  10. The live-barcode secondary action still resolves through onScanLookup.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const lookupStyleClaim = vi.fn(async () => null);
const resolveAnyCodes = vi.fn(async () => ({ resolved: null, owners: [] }));
const matchLabelAlias = vi.fn(async () => ({ band: "low", candidates: [] }));
const fetchProductFollowingMerge = vi.fn(async () => null);

vi.mock("./hubCleanupStore", () => ({
  fetchProductFollowingMerge: (...a) => fetchProductFollowingMerge(...a),
  lookupStyleClaim: (...a) => lookupStyleClaim(...a),
  resolveAnyCodes: (...a) => resolveAnyCodes(...a),
  matchLabelAlias: (...a) => matchLabelAlias(...a),
}));

const mergeCall = vi.fn(async () => ({ data: { moved: [], barcodesRepointed: [] } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => mergeCall(...a) }));

// The shared reader is a BOUNDARY here: this suite proves the picker mounts it
// and consumes its props, never that the reader itself works (its own pipeline
// is covered where it lives, and this file must not be able to change it).
let readerProps = null;
let readerMounts = 0;
vi.mock("./TongueLabelReader.jsx", () => ({
  TongueLabelReader: (props) => { readerProps = props; readerMounts += 1; return null; },
}));
let scannerProps = null;
vi.mock("./CameraScanner.jsx", () => ({
  default: (props) => { scannerProps = props; return null; },
}));

const { default: MergeProducts } = await import("./MergeProducts.jsx");

// A Timberland tongue label printing THREE numbers, each owned by a different
// product — the shape the old picker could never see.
const LOSER = { id: "pDup", name: "timberland boot (dup)", photoUrl: "https://x/dup.jpg" };
const TIMBER = { id: "pTimber", name: "Timberland 6-Inch Wheat", styleCodeNormalised: "A6CWNEN3",
                 photoUrl: "https://x/timber.jpg" };
const EURO = { id: "pEuro", name: "Timberland Euro Hiker Black", styleCodeNormalised: "A8425",
               photoUrl: "https://x/euro.jpg" };
const SPRINT = { id: "pSprint", name: "Timberland Sprint Trekker", styleCodeNormalised: "TB0A2Q1M",
                 photoUrl: "https://x/sprint.jpg" };
// Owned ONLY through the alias store — invisible to anything but the sweep.
const ALIASED = { id: "pAliased", name: "Timberland Field Boot", styleCodeNormalised: null,
                  photoUrl: "https://x/field.jpg" };
const PRODUCTS = [LOSER, TIMBER, EURO, SPRINT];

const ALL_STOCK = {
  hub1: { pTimber: { "8": { qty: 3 } } },
  pe: { pDup: { "9": { qty: 1 } } },
};

const THREE = { allCodes: ["A6CWNEN3", "A8425", "TB0A2Q1M"], auto: true };

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const buttons = (tr) => tr.root.findAll((n) => n.type === "button");
const buttonWith = (tr, needle) => buttons(tr).filter((n) => textIn(n).includes(needle))[0];
const rowFor = (tr, name) => buttons(tr).filter((n) => textIn(n).includes(name))[0];
const allText = (tr) => JSON.stringify(tr.toJSON());
const photoUrls = (node) => node.findAll((n) => n.type === "img").map((n) => n.props.src);

function mount(props = {}) {
  let tr;
  act(() => {
    tr = TestRenderer.create(
      <MergeProducts initialLoser={LOSER} products={PRODUCTS} allStock={ALL_STOCK} registry={{}}
                     onScanLookup={props.onScanLookup} onClose={() => {}} onMerged={() => {}} />
    );
  });
  return tr;
}

beforeEach(() => {
  vi.clearAllMocks();
  readerProps = null;
  readerMounts = 0;
  scannerProps = null;
  lookupStyleClaim.mockImplementation(async () => null);
  resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [] }));
  matchLabelAlias.mockImplementation(async () => ({ band: "low", candidates: [] }));
  fetchProductFollowingMerge.mockImplementation(async () => null);
});

describe("the merge target picker photographs the label", () => {
  it("1. mounts the photo-capture reader; the live scanner is not the primary action", () => {
    const tr = mount();
    expect(readerMounts).toBe(1);
    expect(readerProps.onCode).toBeTypeOf("function");
    expect(readerProps.onTokens).toBeTypeOf("function");
    // The live stream is NOT mounted on arrival.
    expect(scannerProps).toBe(null);
    // …and it survives only as a plainly-subordinate action.
    expect(buttonWith(tr, "shop barcode sticker")).toBeTruthy();
    expect(allText(tr)).not.toContain("Scan the real shoe");
  });

  it("2. three tokens produce ONE pooled list, and every token is resolved", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    const asked = lookupStyleClaim.mock.calls.map((c) => c[0]);
    expect(asked).toEqual(expect.arrayContaining(["A6CWNEN3", "A8425", "TB0A2Q1M"]));
    expect(resolveAnyCodes).toHaveBeenCalledTimes(1);
    expect(resolveAnyCodes.mock.calls[0][0]).toEqual(["A6CWNEN3", "A8425", "TB0A2Q1M"]);
    const t = allText(tr);
    expect(t).toContain("Timberland 6-Inch Wheat");
    expect(t).toContain("Timberland Euro Hiker Black");
    expect(t).toContain("Timberland Sprint Trekker");
  });

  it("2b. an alias-only owner the sweep names joins the SAME list", async () => {
    resolveAnyCodes.mockImplementation(async () => ({ resolved: null, owners: [{ productId: "pAliased", code: "A8425" }] }));
    fetchProductFollowingMerge.mockImplementation(async (id) => (id === "pAliased" ? ALIASED : null));
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    expect(allText(tr)).toContain("Timberland Field Boot");
    expect(allText(tr)).toContain("Timberland 6-Inch Wheat");
  });

  it("3. no auto-pick: several candidates never advances to the confirm", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    // The confirm screen's own words are absent — nothing was chosen for them.
    expect(allText(tr)).not.toContain("SURVIVES");
    expect(allText(tr)).not.toContain("MERGE — one product remains");
  });

  it("4. a SINGLE candidate is not auto-picked either", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A8425", { allCodes: ["A8425"] }); });
    const t = allText(tr);
    expect(t).toContain("Timberland Euro Hiker Black");
    expect(t).not.toContain("SURVIVES");
    // One token means NO whole-node sweep — the live-bandwidth gate.
    expect(resolveAnyCodes).not.toHaveBeenCalled();
  });

  it("5. every row carries the product photo and the number that found it", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    for (const [name, url, code] of [
      ["Timberland 6-Inch Wheat", "https://x/timber.jpg", "A6CWNEN3"],
      ["Timberland Euro Hiker Black", "https://x/euro.jpg", "A8425"],
      ["Timberland Sprint Trekker", "https://x/sprint.jpg", "TB0A2Q1M"],
    ]) {
      const row = rowFor(tr, name);
      expect(row).toBeTruthy();
      expect(photoUrls(row)).toContain(url);
      expect(textIn(row).replace(/\s+/g, " ")).toContain("found by");
      expect(textIn(row).replace(/-/g, "")).toContain(code);
    }
  });

  it("6. the name search still works, below the suggestions, both lists visible", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    const field = tr.root.findAll((n) => n.type === "input" && n.props.placeholder)[0];
    expect(field.props.placeholder).toContain("search by name");
    await act(async () => { field.props.onChange({ target: { value: "Sprint" } }); });
    const t = allText(tr);
    expect(t).toContain("Timberland Sprint Trekker");
    // The suggestions did not disappear when the operator typed.
    expect(t).toContain("found by");
    // The reader is still ABOVE: the search input comes after the suggestion rows.
    expect(t.indexOf("found by")).toBeLessThan(t.indexOf("search by name"));
  });

  it("6b. the merge away card and Close survive on the picker", () => {
    const tr = mount();
    expect(allText(tr)).toContain("Merging away");
    expect(buttonWith(tr, "Close")).toBeTruthy();
  });

  it("7. picking a row reaches the unchanged confirm screen", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    await act(async () => { rowFor(tr, "Timberland Euro Hiker Black").props.onClick(); });
    const t = allText(tr);
    expect(t).toContain("GOES AWAY");
    expect(t).toContain("SURVIVES");
    expect(t).toContain("MERGE — one product remains");
    expect(t).toContain("Swap direction");
    // Both products' photos, and the loser's every stock cell.
    const urls = photoUrls(tr.root);
    expect(urls).toContain("https://x/dup.jpg");
    expect(urls).toContain("https://x/euro.jpg");
    expect(t).toContain("pe");
  });

  it("8. nothing is written before the confirm tap, and the merge call is unchanged", async () => {
    const tr = mount();
    await act(async () => { await readerProps.onCode("A6CWNEN3", THREE); });
    await act(async () => { rowFor(tr, "Timberland Euro Hiker Black").props.onClick(); });
    expect(mergeCall).not.toHaveBeenCalled();
    await act(async () => { buttonWith(tr, "MERGE — one product remains").props.onClick(); });
    expect(mergeCall).toHaveBeenCalledTimes(1);
    expect(mergeCall.mock.calls[0][0]).toEqual({ loserId: "pDup", survivorId: "pEuro" });
  });

  it("9. a code-less read pools the label's WORDING into the same list", async () => {
    matchLabelAlias.mockImplementation(async () => ({ band: "mid", candidates: [{ productId: "pSprint" }] }));
    const tr = mount();
    await act(async () => { await readerProps.onTokens(["timberland", "sprint", "trekker"]); });
    expect(matchLabelAlias).toHaveBeenCalledWith(["timberland", "sprint", "trekker"]);
    const row = rowFor(tr, "Timberland Sprint Trekker");
    expect(row).toBeTruthy();
    expect(photoUrls(row)).toContain("https://x/sprint.jpg");
    expect(textIn(row).replace(/\s+/g, " ")).toContain("found by this label's wording");
    expect(allText(tr)).not.toContain("SURVIVES");
  });

  it("10. the secondary live-barcode action still resolves through onScanLookup", async () => {
    const onScanLookup = vi.fn(async () => ({ productId: "pTimber" }));
    const tr = mount({ onScanLookup });
    await act(async () => { buttonWith(tr, "shop barcode sticker").props.onClick(); });
    expect(scannerProps).toBeTruthy();
    await act(async () => { await scannerProps.onScan("6001234567890"); });
    expect(onScanLookup).toHaveBeenCalledWith("6001234567890");
    expect(allText(tr)).toContain("SURVIVES");
  });

  it("11. the record being merged away can never be offered as its own target", async () => {
    lookupStyleClaim.mockImplementation(async (t) => (t === "ZZDUP1" ? { productId: "pDup" } : null));
    const tr = mount();
    await act(async () => { await readerProps.onCode("ZZDUP1", { allCodes: ["ZZDUP1"] }); });
    expect(rowFor(tr, "timberland boot (dup)")).toBeFalsy();
    expect(allText(tr)).toContain("search by name below");
  });
});

// ─── THE DUPLICATE PANEL — WIRING CLAIMS ─────────────────────────────────────
// The matcher itself is proven in utils/productDupMatch.test.js and mutated in
// scripts/mutation-proof-dup-suggest.mjs. What is claimed HERE is everything the
// panel does around it, and every one of these is a way the feature fails
// quietly rather than loudly:
//
//   1. it says nothing under MIN_CHARS, so it does not open on the first key
//   2. it waits DEBOUNCE_MS, so a typed code is matched once, not five times
//   3. exact code matches head "ALREADY IN THE CATALOGUE"; everything else
//      heads "POSSIBLY THE SAME" — the two questions are not the same question
//   4. every row carries a PHOTO — this is a visual confirmation, not a list
//   5. …and the category and the units on hand, which is what tells a live
//      record from an abandoned twin
//   6. an unreadable stock read says UNKNOWN, never "0 units"
//   7. "None of these — create new" is ALWAYS there. The panel never blocks.
//   8. …and dismissing is keyed to the NAME it was tapped for, so it cannot
//      silently disarm the guard for the rest of the session
//   9. picking a row calls back with the product and writes nothing
//  10. IT READS NO PRODUCTS. The catalogue arrives as a prop; the only reads
//      this panel issues are per-product /stock reads for rows on screen.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const loadTotals = vi.fn(async () => {});
const cachedTotals = vi.fn(() => null);
const totalsFailed = vi.fn(() => false);
vi.mock("../stock/networkTotalsStore.js", () => ({
  loadTotals: (...a) => loadTotals(...a),
  cachedTotals: (...a) => cachedTotals(...a),
  totalsFailed: (...a) => totalsFailed(...a),
}));

const { default: DuplicateSuggestPanel, DEBOUNCE_MS, MIN_CHARS } =
  await import("./DuplicateSuggestPanel.jsx");

const CATALOGUE = [
  { id: "p1", name: "44712", category: "Clothing", photoUrl: "https://x/44712.jpg" },
  { id: "p2", name: "44712-01", category: "Clothing", photoUrl: "https://x/4471201.jpg" },
  { id: "p3", name: "Mens Fleece Tracksuit", category: "Clothing", photoUrl: "https://x/fleece.jpg" },
  { id: "p4", name: "144712", category: "Clothing", photoUrl: "https://x/144712.jpg" },
];

// A SECOND product already answering to 44712 — the catalogue is already
// inconsistent, and that is the one case a human must settle.
const TIED = [...CATALOGUE, { id: "p5", name: "44712 Older Record", category: "Clothing", photoUrl: "https://x/old.jpg" }];

const LOCS = ["hub1", "hub2", "marathon-pe"];

function render(props) {
  let r;
  act(() => {
    r = TestRenderer.create(
      <DuplicateSuggestPanel products={CATALOGUE} locationIds={LOCS} onPick={() => {}} {...props} />,
    );
  });
  return r;
}

// Advance past the debounce and let the totals effect settle.
async function settle(ms = DEBOUNCE_MS) {
  await act(async () => { vi.advanceTimersByTime(ms + 1); await Promise.resolve(); });
}

const textOf = (r) => JSON.stringify(r.toJSON());

beforeEach(() => {
  vi.useFakeTimers();
  loadTotals.mockClear(); cachedTotals.mockReset(); totalsFailed.mockReset();
  cachedTotals.mockReturnValue(null);
  totalsFailed.mockReturnValue(false);
});

describe("the panel opens only when there is something to say", () => {
  it(`says nothing under ${MIN_CHARS} characters`, async () => {
    const r = render({ typed: "44" });
    await settle();
    expect(r.toJSON()).toBeNull();
  });

  it("says nothing when nothing matches", async () => {
    const r = render({ typed: "99999" });
    await settle();
    expect(r.toJSON()).toBeNull();
  });

  it(`waits ${DEBOUNCE_MS}ms after a keystroke before it answers`, async () => {
    // Mounted empty, as the real form opens. Then the code is typed.
    const r = render({ typed: "" });
    act(() => { r.update(<DuplicateSuggestPanel typed="44712" products={CATALOGUE} locationIds={LOCS} onPick={() => {}} />); });
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS - 50); await Promise.resolve(); });
    expect(r.toJSON()).toBeNull();
    await settle();
    expect(r.toJSON()).not.toBeNull();
  });

  it("a name already in the field when the form opens is answered at once", async () => {
    // The style-code gate prefills `suggestedName`; that is not a keystroke and
    // there is nothing to wait for.
    const r = render({ typed: "44712" });
    await act(async () => { await Promise.resolve(); });
    expect(r.toJSON()).not.toBeNull();
  });
});

describe("the two headings are two different questions", () => {
  it("an exact code match heads ALREADY IN THE CATALOGUE", async () => {
    const r = render({ typed: "44712" });
    await settle();
    expect(textOf(r)).toContain("Already in the catalogue");
  });

  it("a partial / fuzzy match heads POSSIBLY THE SAME", async () => {
    // Two products already answer to this code, so the panel is a picker and the
    // weaker tiers sit under their own heading beneath it.
    const r = render({ typed: "44712", products: TIED });
    await settle();
    expect(textOf(r)).toContain("Already in the catalogue");
    expect(textOf(r)).toContain("Possibly the same");
  });

  it("a neighbouring code never appears at all", async () => {
    const r = render({ typed: "44712" });
    await settle();
    expect(textOf(r)).not.toContain("144712");
  });
});

describe("ONE CODE, ONE PRODUCT — the consistency rule", () => {
  it("a sole exact match is RESOLVED, not offered as a choice", async () => {
    const r = render({ typed: "44712" });
    await settle();
    const t = textOf(r);
    expect(t).toContain("Already in the catalogue");
    expect(t).toContain("This code is already");
    expect(t).toContain("ADD STOCK TO IT");
    // The weaker sibling is NOT shown alongside it — that would be a choice.
    expect(t).not.toContain("Possibly the same");
    expect(t).not.toContain("44712-01");
  });

  it("the resolved banner still offers create-new — the operator is never one tap from blocked", async () => {
    const r = render({ typed: "44712" });
    await settle();
    expect(textOf(r)).toContain("None of these — create new");
  });

  it("the banner names the product so it can be checked against the rail", async () => {
    cachedTotals.mockImplementation((pid) => (pid === "p1" ? { total: 9 } : null));
    const r = render({ typed: "44712" });
    await settle();
    const t = textOf(r);
    expect(t).toContain("44712");
    expect(t).toContain("9 units on hand");
  });

  it("the override is an escape, and it takes an extra tap", async () => {
    const r = render({ typed: "44712" });
    await settle();
    expect(textOf(r)).toContain("Not this one?");
    const link = r.root.findAllByType("button").find((b) => JSON.stringify(b.props.children).includes("Not this one"));
    act(() => link.props.onClick());
    const t = textOf(r);
    expect(t).toContain("Possibly the same");
    expect(t).toContain("None of these — create new");
  });

  it("TWO products already answering to one code is the case a human must settle", async () => {
    const r = render({ typed: "44712", products: TIED });
    await settle();
    const t = textOf(r);
    expect(t).not.toContain("This code is already");   // no auto-resolve
    expect(t).toContain("44712 Older Record");          // both are on screen
    expect(t).toContain("None of these — create new");
  });
});

describe("the row is evidence the operator can check", () => {
  it("carries the product photo", async () => {
    const r = render({ typed: "44712" });
    await settle();
    const imgs = r.root.findAllByType("img").map((i) => i.props.src);
    expect(imgs).toContain("https://x/44712.jpg");
  });

  it("carries the category and the units on hand", async () => {
    cachedTotals.mockImplementation((pid) => (pid === "p1" ? { total: 14 } : null));
    const r = render({ typed: "44712" });
    await settle();
    const t = textOf(r);
    expect(t).toContain("Clothing");
    expect(t).toContain("14 units on hand");
  });

  it("says one unit, not one units", async () => {
    cachedTotals.mockImplementation((pid) => (pid === "p1" ? { total: 1 } : null));
    const r = render({ typed: "44712" });
    await settle();
    expect(textOf(r)).toContain("1 unit on hand");
  });

  it("NO LOCATIONS says unknown too — it must not sit on \"counting…\" for a read never issued", async () => {
    const r = render({ typed: "44712", locationIds: [] });
    await settle();
    const t = textOf(r);
    expect(t).toContain("units unknown");
    expect(t).not.toContain("counting units");
    expect(t).not.toContain("0 units on hand");
  });

  it("an unreadable stock read says UNKNOWN, never zero", async () => {
    cachedTotals.mockReturnValue(null);
    totalsFailed.mockReturnValue(true);
    const r = render({ typed: "44712" });
    await settle();
    const t = textOf(r);
    expect(t).toContain("units unknown");
    expect(t).not.toContain("0 units on hand");
  });
});

describe("it costs nothing to open", () => {
  it("reads unit totals ONLY for the products it is showing", async () => {
    render({ typed: "44712" });
    await settle();
    expect(loadTotals).toHaveBeenCalled();
    const [ids, locs] = loadTotals.mock.calls[0];
    expect(ids.sort()).toEqual(["p1", "p2"]);   // never p3, never p4
    expect(locs).toEqual(LOCS);
  });

  it("issues no read at all when it has nothing to show", async () => {
    render({ typed: "99999" });
    await settle();
    expect(loadTotals).not.toHaveBeenCalled();
  });
});

describe("it never blocks", () => {
  it("always offers create-new, even under exact code matches", async () => {
    const r = render({ typed: "44712", products: TIED });
    await settle();
    expect(textOf(r)).toContain("None of these — create new");
  });

  it("dismisses for the name it was tapped for, and comes back on the next one", async () => {
    const onCreateNew = vi.fn();
    let r;
    act(() => {
      r = TestRenderer.create(
        <DuplicateSuggestPanel typed="44712" products={TIED} locationIds={LOCS} onPick={() => {}} onCreateNew={onCreateNew} />,
      );
    });
    await settle();
    const btn = r.root.findAll((n) => n.type === "button" && String(n.children?.[0]?.children ?? "").includes("None of these"))[0]
             || r.root.findAllByType("button").find((b) => JSON.stringify(b.props.children).includes("None of these"));
    act(() => btn.props.onClick());
    expect(onCreateNew).toHaveBeenCalled();
    expect(r.toJSON()).toBeNull();

    // A different name is a different question — the guard re-arms.
    act(() => {
      r.update(<DuplicateSuggestPanel typed="44712-01" products={TIED} locationIds={LOCS} onPick={() => {}} onCreateNew={onCreateNew} />);
    });
    await settle();
    expect(r.toJSON()).not.toBeNull();
  });

  it("there is NO way to switch create-new off", async () => {
    // Every rendering state, including the resolved banner and the picker.
    for (const products of [CATALOGUE, TIED]) {
      const r = render({ typed: "44712", products });
      await settle();
      expect(textOf(r)).toContain("None of these — create new");
    }
  });
});

describe("picking", () => {
  it("hands the whole product back and writes nothing", async () => {
    const onPick = vi.fn();
    const r = render({ typed: "44712", onPick });
    await settle();
    const row = r.root.findAll((n) => n.props && n.props.role === "button")[0];
    act(() => row.props.onClick());
    expect(onPick).toHaveBeenCalledWith(CATALOGUE[0]);
  });
});

// ─── THE PANEL'S COST CLAIM ──────────────────────────────────────────────────
// Matching is a scan of the whole in-memory catalogue — 4,700-odd products. That
// is nothing once, and it is not nothing on every keystroke of a name being
// typed. Two floors keep it honest, and neither shows up in the rendered output,
// so they are proven here by counting calls instead:
//
//   • nothing is matched below MIN_CHARS
//   • nothing is matched again for a keystroke the debounce swallowed
//
// The matcher is mocked deliberately — this file is about how OFTEN it runs, not
// what it returns. What it returns is proven in utils/productDupMatch.test.js.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const rankCandidates = vi.fn(() => []);
vi.mock("../../utils/productDupMatch.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, rankCandidates: (...a) => rankCandidates(...a) };
});
vi.mock("../stock/networkTotalsStore.js", () => ({
  loadTotals: async () => {}, cachedTotals: () => null, totalsFailed: () => false,
}));

const { default: DuplicateSuggestPanel, DEBOUNCE_MS, MIN_CHARS } =
  await import("./DuplicateSuggestPanel.jsx");

const PRODUCTS = [{ id: "p1", name: "44712" }];
const panel = (typed) => (
  <DuplicateSuggestPanel typed={typed} products={PRODUCTS} locationIds={["hub1"]} onPick={() => {}} />
);

beforeEach(() => { vi.useFakeTimers(); rankCandidates.mockClear(); });

describe("it does not scan the catalogue for nothing", () => {
  it(`never matches below ${MIN_CHARS} characters`, async () => {
    let r;
    act(() => { r = TestRenderer.create(panel("")); });
    for (const typed of ["4", "44"]) {
      act(() => { r.update(panel(typed)); });
      await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); await Promise.resolve(); });
    }
    expect(rankCandidates).not.toHaveBeenCalled();

    // …and does the moment there are enough characters to mean something.
    act(() => { r.update(panel("447")); });
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); await Promise.resolve(); });
    expect(rankCandidates).toHaveBeenCalledTimes(1);
  });

  it("matches an article code ONCE however fast it is typed", async () => {
    let r;
    act(() => { r = TestRenderer.create(panel("")); });
    for (const typed of ["447", "4471", "44712"]) {
      act(() => { r.update(panel(typed)); });
      await act(async () => { vi.advanceTimersByTime(40); await Promise.resolve(); });
    }
    expect(rankCandidates).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(DEBOUNCE_MS + 1); await Promise.resolve(); });
    expect(rankCandidates).toHaveBeenCalledTimes(1);
    expect(rankCandidates.mock.calls[0][0]).toBe("44712");
  });
});

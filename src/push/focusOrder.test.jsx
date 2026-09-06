// ─── THE RING COMES OFF ──────────────────────────────────────────────────────
// The focus ring is a temporary state painted on a card in a queue a picker is
// working from, and the marker that starts it is CONSUMED on its first read. So
// every way out of the effect has to clear it: an effect that re-runs finds no
// marker, returns early, and — if the early return left the previous key in
// state — there would be nothing left to take the ring off. It would sit on
// whatever card matched, on a later and unrelated hub view, forever.
//
// Rendered through react-test-renderer like the other hook tests here — no new
// test dependency for one hook.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { FOCUS_ORDER_KEY } from "./deepLink";
import { useFocusOrder } from "./useFocusOrder";

const AT = "2026-09-06T07:07:41.633Z";

// The hook reaches for the real globals; give it the smallest ones that work.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
globalThis.document = globalThis.document || { querySelector: () => null };
globalThis.CSS = globalThis.CSS || { escape: (s) => s };

function Harness({ ready, onKey }) {
  onKey(useFocusOrder(ready));
  return null;
}

const armMarker = (writtenAt = Date.now()) =>
  store.set(FOCUS_ORDER_KEY, JSON.stringify({ id: "005", createdAt: AT, writtenAt }));

describe("useFocusOrder", () => {
  beforeEach(() => { store.clear(); vi.useRealTimers(); });

  it("rings the card the marker names, and consumes the marker", async () => {
    armMarker();
    let key = "unset";
    await act(async () => { TestRenderer.create(<Harness ready onKey={(k) => { key = k; }} />); });
    expect(key).toBe(`005::${AT}`);
    expect(store.has(FOCUS_ORDER_KEY)).toBe(false);
  });

  it("does nothing at all when there is no marker", async () => {
    let key = "unset";
    await act(async () => { TestRenderer.create(<Harness ready onKey={(k) => { key = k; }} />); });
    expect(key).toBe(null);
  });

  it("holds the marker until the screen can use it", async () => {
    // Before a hub is chosen there is no queue to search, so the marker must be
    // left for the render that can actually act on it rather than spent on the
    // hub picker.
    armMarker();
    let key = "unset";
    await act(async () => { TestRenderer.create(<Harness ready={false} onKey={(k) => { key = k; }} />); });
    expect(key).toBe(null);
    expect(store.has(FOCUS_ORDER_KEY)).toBe(true, "the marker is still there for the next render");
  });

  it("A RE-RUN TAKES THE RING OFF — the marker is gone, so nothing else would", async () => {
    armMarker();
    let key = "unset";
    let tree;
    await act(async () => {
      tree = TestRenderer.create(<Harness ready onKey={(k) => { key = k; }} />);
    });
    expect(key).toBe(`005::${AT}`);

    // The hub selector is reopened and a hub picked again, inside the few
    // seconds the ring lasts. The marker was consumed by the first run.
    await act(async () => { tree.update(<Harness ready={false} onKey={(k) => { key = k; }} />); });
    expect(key).toBe(null, "the ring is cleared by the teardown, not left for a timer that was cancelled");

    await act(async () => { tree.update(<Harness ready onKey={(k) => { key = k; }} />); });
    expect(key).toBe(null, "and the second run finds no marker and paints nothing");
  });

  it("unmounting clears it too, so no timer fires into a dead component", async () => {
    armMarker();
    let key = "unset";
    let tree;
    await act(async () => {
      tree = TestRenderer.create(<Harness ready onKey={(k) => { key = k; }} />);
    });
    expect(key).toBe(`005::${AT}`);
    await act(async () => { tree.unmount(); });
  });
});

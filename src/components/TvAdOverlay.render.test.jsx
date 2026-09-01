// Pins the TV ad overlay timer contract:
//  1. hidden at mount;
//  2. becomes visible after AD_HIDDEN_MS and shows the configured ad image;
//  3. hides again after AD_VISIBLE_MS, then repeats the cycle (loops forever).
import { test, expect, vi } from "vitest";
import { create, act } from "react-test-renderer";
import TvAdOverlay, { AD_OVERLAY_CONFIG } from "./TvAdOverlay.jsx";

const HIDDEN_MS = 1000;
const VISIBLE_MS = 500;

test("ad overlay: hidden → visible → hidden → visible, on its own timer", () => {
  vi.useFakeTimers();
  let tree;
  act(() => {
    tree = create(<TvAdOverlay hiddenMs={HIDDEN_MS} visibleMs={VISIBLE_MS} />);
  });

  expect(tree.toJSON()).toBeNull();

  act(() => { vi.advanceTimersByTime(HIDDEN_MS); });
  expect(tree.toJSON()).not.toBeNull();
  const img = tree.root.findByType("img");
  expect(img.props.src).toBe(AD_OVERLAY_CONFIG.src);

  act(() => { vi.advanceTimersByTime(VISIBLE_MS); });
  expect(tree.toJSON()).toBeNull();

  act(() => { vi.advanceTimersByTime(HIDDEN_MS); });
  expect(tree.toJSON()).not.toBeNull();

  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

// Pins the TV ad overlay contract:
//  1. disabled or no mediaUrl → renders nothing, ever (no timer even starts);
//  2. enabled + mediaUrl → hidden at mount, visible after intervalMinutes,
//     hidden again after durationMinutes, then repeats;
//  3. mediaType "video" renders a muted/autoplay/loop <video>, not <img>.
// Firebase is fully mocked — no test touches live data.
import { test, expect, vi } from "vitest";
import { create, act } from "react-test-renderer";

const listeners = [];
vi.mock("../firebase", () => ({ database: { __mockDb: true } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb, errCb) => {
    listeners.push({ path: r.path, cb, errCb });
    return () => {};
  },
}));

import TvAdOverlay from "./TvAdOverlay.jsx";

const snap = (v) => ({ val: () => v });

test("no ad configured → renders nothing and never starts a timer", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvAdOverlay />); });
  act(() => { listeners[listeners.length - 1].cb(snap({ enabled: false, mediaUrl: "" })); });
  expect(tree.toJSON()).toBeNull();
  act(() => { vi.advanceTimersByTime(60 * 60_000); });
  expect(tree.toJSON()).toBeNull();
  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

test("enabled ad: hidden → visible → hidden → visible on the configured schedule", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvAdOverlay />); });
  const l = listeners[listeners.length - 1];
  expect(l.path).toBe("settings/tvAd");
  act(() => {
    l.cb(snap({
      enabled: true, mediaUrl: "/ads/lacoste-buy2-r750.png", mediaType: "image",
      intervalMinutes: 1, durationMinutes: 1,
    }));
  });
  expect(tree.toJSON()).toBeNull();

  act(() => { vi.advanceTimersByTime(60_000); });
  expect(tree.toJSON()).not.toBeNull();
  const img = tree.root.findByType("img");
  expect(img.props.src).toBe("/ads/lacoste-buy2-r750.png");

  act(() => { vi.advanceTimersByTime(60_000); });
  expect(tree.toJSON()).toBeNull();

  act(() => { vi.advanceTimersByTime(60_000); });
  expect(tree.toJSON()).not.toBeNull();

  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

test("mediaType video renders a muted/autoplay/loop <video>", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvAdOverlay />); });
  const l = listeners[listeners.length - 1];
  act(() => {
    l.cb(snap({
      enabled: true, mediaUrl: "/ads/promo.mp4", mediaType: "video",
      intervalMinutes: 1, durationMinutes: 1,
    }));
  });
  act(() => { vi.advanceTimersByTime(60_000); });
  const video = tree.root.findByType("video");
  expect(video.props.src).toBe("/ads/promo.mp4");
  expect(video.props.autoPlay).toBe(true);
  expect(video.props.muted).toBe(true);
  expect(video.props.loop).toBe(true);

  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

test("toggling enabled off stops the overlay", () => {
  vi.useFakeTimers();
  let tree;
  act(() => { tree = create(<TvAdOverlay />); });
  const l = listeners[listeners.length - 1];
  act(() => {
    l.cb(snap({ enabled: true, mediaUrl: "/ads/x.png", mediaType: "image", intervalMinutes: 1, durationMinutes: 1 }));
  });
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(tree.toJSON()).not.toBeNull();

  act(() => { l.cb(snap({ enabled: false, mediaUrl: "/ads/x.png", mediaType: "image", intervalMinutes: 1, durationMinutes: 1 })); });
  expect(tree.toJSON()).toBeNull();
  act(() => { vi.advanceTimersByTime(5 * 60_000); });
  expect(tree.toJSON()).toBeNull();

  act(() => { tree.unmount(); });
  vi.useRealTimers();
});

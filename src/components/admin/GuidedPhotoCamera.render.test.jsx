// ─── THE GUIDED CAMERA, RENDERED ─────────────────────────────────────────────
//   • no camera stream on the device → the "Choose from photos" fallback is
//     offered and calls onFallback — the flow is never lost
//   • with a stream → the rear camera is requested, the outline overlay SVG
//     renders over the video, non-interactive, and the step's copy is on screen
//   • the stream is stopped when the camera closes (unmount)
//   • the form's step card opens the camera when there is a stream

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import GuidedPhotoCamera, { GuidedPhotoStep, GuideOutline } from "./GuidedPhotoCamera.jsx";
import { SHOE_STEP, BOX_STEP } from "./photoGuides.js";

const textIn = (inst) => (typeof inst === "string" ? inst : (inst.children || []).map(textIn).join(" "));
const textOf = (tr) => JSON.stringify(tr.toJSON());
const buttonWith = (tr, needle) => tr.root.findAll((n) => n.type === "button" && textIn(n).includes(needle))[0];

// Node 22 exposes a read-only `navigator` getter on globalThis — redefine it.
function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}
let getUserMedia;
let stopped;
beforeEach(() => {
  stopped = 0;
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }));
});
afterEach(() => { setNavigator(undefined); });

async function mount(el) {
  let tr;
  await act(async () => { tr = TestRenderer.create(el, { createNodeMock: () => ({}) }); });
  return tr;
}

describe("no camera stream", () => {
  it("offers Choose from photos, which calls onFallback; no overlay, no getUserMedia", async () => {
    setNavigator({});
    const onFallback = vi.fn();
    const tr = await mount(<GuidedPhotoCamera step={SHOE_STEP} onCapture={vi.fn()} onFallback={onFallback} onClose={vi.fn()} />);
    expect(tr.root.findAll((n) => n.type === "svg")).toHaveLength(0);
    await act(async () => { buttonWith(tr, "Choose from photos").props.onClick(); });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("the stream being refused falls back the same way", async () => {
    setNavigator({ mediaDevices: { getUserMedia: vi.fn(async () => { throw new Error("denied"); }) } });
    const onFallback = vi.fn();
    const tr = await mount(<GuidedPhotoCamera step={SHOE_STEP} onCapture={vi.fn()} onFallback={onFallback} onClose={vi.fn()} />);
    expect(textOf(tr)).toContain("Camera unavailable");
    await act(async () => { buttonWith(tr, "Choose from photos").props.onClick(); });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});

describe("with a camera stream", () => {
  it("requests the rear camera and draws the outline over the video, with the copy", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const tr = await mount(<GuidedPhotoCamera step={SHOE_STEP} onCapture={vi.fn()} onFallback={vi.fn()} onClose={vi.fn()} />);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" } });
    const svg = tr.root.find((n) => n.type === "svg" && n.props["data-testid"] === "photo-guide-overlay");
    expect(svg.props.style.pointerEvents).toBe("none");
    expect(svg.props.style.position).toBe("absolute");
    expect(svg.findByType(GuideOutline).props.step).toBe(SHOE_STEP);
    const g = svg.find((n) => n.type === "g");
    expect(g.props.stroke).toBe("rgba(255,255,255,.35)");
    expect(textOf(tr)).toContain("toe pointing right");
    // The fallback is still there under a live camera.
    expect(buttonWith(tr, "Choose from photos")).toBeTruthy();
  });

  it("a capture that fails (no canvas) falls back, releases the camera and frees the button", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const onCapture = vi.fn(), onFallback = vi.fn();
    let tr;
    // A video element with a real frame size; no `document` here, so drawing throws.
    await act(async () => {
      tr = TestRenderer.create(<GuidedPhotoCamera step={SHOE_STEP} onCapture={onCapture} onFallback={onFallback} onClose={vi.fn()} />,
        { createNodeMock: (el) => (el.type === "video" ? { videoWidth: 640, videoHeight: 480, play: () => Promise.resolve(), srcObject: null } : {}) });
    });
    await act(async () => { await buttonWith(tr, "Take photo").props.onClick(); });
    expect(onCapture).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(stopped).toBeGreaterThan(0);
  });

  it("the box step draws the box outline and its copy", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const tr = await mount(<GuidedPhotoCamera step={BOX_STEP} onCapture={vi.fn()} onFallback={vi.fn()} onClose={vi.fn()} />);
    expect(tr.root.find((n) => n.type === "g").props["data-guide"]).toBe("box");
    expect(textOf(tr)).toContain("front panel facing you");
  });

  it("stops the stream when the camera goes away", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const tr = await mount(<GuidedPhotoCamera step={SHOE_STEP} onCapture={vi.fn()} onFallback={vi.fn()} onClose={vi.fn()} />);
    await act(async () => { tr.unmount(); });
    expect(stopped).toBe(1);
  });
});

describe("the form's step card", () => {
  it("Take opens the guided camera when a stream exists", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const tr = await mount(<GuidedPhotoStep step={SHOE_STEP} filled={false} previewUrl={null} onFile={vi.fn()} />);
    expect(tr.root.findAllByType(GuidedPhotoCamera)).toHaveLength(0);
    await act(async () => { buttonWith(tr, "Take shoe photo").props.onClick(); });
    expect(tr.root.findAllByType(GuidedPhotoCamera)).toHaveLength(1);
  });

  it("a capture is handed to onFile and the camera closes", async () => {
    setNavigator({ mediaDevices: { getUserMedia } });
    const onFile = vi.fn();
    const tr = await mount(<GuidedPhotoStep step={BOX_STEP} filled={false} previewUrl={null} onFile={onFile} />);
    await act(async () => { buttonWith(tr, "Take box photo").props.onClick(); });
    const blob = { size: 1 };
    await act(async () => { tr.root.findByType(GuidedPhotoCamera).props.onCapture(blob); });
    expect(onFile).toHaveBeenCalledWith(blob);
    expect(tr.root.findAllByType(GuidedPhotoCamera)).toHaveLength(0);
  });

  it("without a stream, Take goes straight to the photo picker", async () => {
    setNavigator({});
    const click = vi.fn();
    let tr;
    await act(async () => {
      tr = TestRenderer.create(<GuidedPhotoStep step={SHOE_STEP} filled={false} previewUrl={null} onFile={vi.fn()} />,
        { createNodeMock: (el) => (el.type === "input" ? { click } : {}) });
    });
    await act(async () => { buttonWith(tr, "Take shoe photo").props.onClick(); });
    expect(click).toHaveBeenCalledTimes(1);
    expect(tr.root.findAllByType(GuidedPhotoCamera)).toHaveLength(0);
  });
});

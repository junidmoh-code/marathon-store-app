// ─── PhotoThumb / PhotoLightbox — THE SHARED PAIR ────────────────────────────
// These are widget-level tests, not screen tests, and that distinction is the
// point of this file.
//
// WHY IT EXISTS. The Seating tab's own test asserts that tapping a photo
// selects nothing — and that is true there for a STRUCTURAL reason: the thumb
// is a SIBLING of the row's button, so a click could never have reached it.
// stopPropagation is inert at that call site, so a guard pointed at the Seating
// tab proves only that the code calls a method, not that the method protects
// anything. That is a weak guard wearing a strong name.
//
// The contract stopPropagation actually serves is for callers who NEST the
// thumb inside something clickable — which is how all three of the existing
// private copies are used (HubSneakerCount's row, CountedStockReview's group,
// AssignCategoriesTab's card) and how this pair will be used when those are
// folded in. So the contract is tested where it lives: inside a clickable
// parent, where breaking it really does turn looking into choosing.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame(fn) { fn(); },
};

const { PhotoThumb, PhotoLightbox } = await import("./healthWidgets.jsx");

// A real click on the img, propagating the way the DOM would: the parent's
// handler runs unless the child stopped it.
function clickThrough(img, parentHandler) {
  let stopped = false;
  img.props.onClick?.({ stopPropagation: () => { stopped = true; } });
  if (!stopped) parentHandler();
}

describe("PhotoThumb inside something clickable", () => {
  const nested = (onOpen, onParent) => {
    let tree;
    act(() => {
      tree = TestRenderer.create(
        <div onClick={onParent}>
          <PhotoThumb url="https://x/a.jpg" onOpen={onOpen} />
        </div>,
      );
    });
    return tree;
  };

  it("opens the photo and does NOT trigger the parent", () => {
    const onOpen = vi.fn();
    const onParent = vi.fn();
    const tree = nested(onOpen, onParent);
    clickThrough(tree.root.findAllByType("img")[0], onParent);
    expect(onOpen).toHaveBeenCalledWith("https://x/a.jpg");
    expect(onParent).not.toHaveBeenCalled();
  });

  it("without an onOpen it is inert — the parent keeps its click", () => {
    const onParent = vi.fn();
    const tree = nested(undefined, onParent);
    clickThrough(tree.root.findAllByType("img")[0], onParent);
    expect(onParent).toHaveBeenCalledTimes(1);
  });
});

describe("PhotoThumb rendering", () => {
  const render = (props) => {
    let tree;
    act(() => { tree = TestRenderer.create(<PhotoThumb {...props} />); });
    return tree;
  };

  it("renders the picture when there is one", () => {
    const tree = render({ url: "https://x/a.jpg", alt: "Tee" });
    const img = tree.root.findAllByType("img")[0];
    expect(img.props.src).toBe("https://x/a.jpg");
    expect(img.props.alt).toBe("Tee");
    expect(img.props.loading).toBe("lazy");
  });

  it("falls back to a placeholder with NO img when there is none", () => {
    const tree = render({ url: null });
    expect(tree.root.findAllByType("img")).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain("📦");
  });

  it("a dead URL hides the element rather than collapsing the row", () => {
    const tree = render({ url: "https://x/gone.jpg" });
    const img = tree.root.findAllByType("img")[0];
    const el = { style: {} };
    img.props.onError({ currentTarget: el });
    // visibility, not display: the row must keep its shape.
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.display).toBeUndefined();
  });

  it("shows no zoom cursor when it cannot be opened", () => {
    expect(render({ url: "https://x/a.jpg" }).root.findAllByType("img")[0].props.style.cursor).toBe("default");
    expect(render({ url: "https://x/a.jpg", onOpen: () => {} }).root.findAllByType("img")[0].props.style.cursor).toBe("zoom-in");
  });
});

describe("PhotoLightbox", () => {
  const render = (props) => {
    let tree;
    act(() => { tree = TestRenderer.create(<PhotoLightbox {...props} />); });
    return tree;
  };

  it("renders nothing without a url", () => {
    expect(render({ url: "", onClose: () => {} }).toJSON()).toBe(null);
  });

  it("is a modal dialog that closes on a tap anywhere", () => {
    const onClose = vi.fn();
    const tree = render({ url: "https://x/a.jpg", onClose });
    const dialog = tree.root.findAll((n) => n.props?.role === "dialog")[0];
    expect(dialog.props["aria-modal"]).toBe("true");
    act(() => { dialog.props.onClick(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

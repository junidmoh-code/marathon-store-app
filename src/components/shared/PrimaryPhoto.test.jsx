// <PrimaryPhoto>: the one primary, at the size the screen needs.
import { describe, it, expect } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PrimaryPhoto } from "./PrimaryPhoto.jsx";
import { primaryThumbUrl } from "../../utils/primaryPhoto";

const OWN = "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/products%2Fp1%2Fphoto.jpg?alt=media";
const P1 = { id: "p1", photoUrl: OWN, photoUpdatedAt: 1700000000000 };

const render = (el) => {
  let tr;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
};

describe("<PrimaryPhoto>", () => {
  it("serves the 300px thumbnail at list size", () => {
    const tr = render(<PrimaryPhoto product={P1} alt="" />);
    const img = tr.root.findByType("img");
    expect(img.props.src).toBe(primaryThumbUrl(P1, "p1"));
    expect(img.props.src).not.toBe(OWN);
  });

  it("serves the full photo at size=\"full\"", () => {
    const tr = render(<PrimaryPhoto product={P1} size="full" alt="" />);
    expect(tr.root.findByType("img").props.src).toBe(OWN);
  });

  it("renders the fallback when the product has no photo", () => {
    const tr = render(<PrimaryPhoto product={{ id: "p1" }} fallback={<span>NO IMAGE</span>} />);
    expect(tr.root.findAllByType("img")).toHaveLength(0);
    expect(tr.root.findByType("span").props.children).toBe("NO IMAGE");
  });

  it("falls back to the full photo when the thumbnail 404s", () => {
    let errors = 0;
    const tr = render(<PrimaryPhoto product={P1} onError={() => { errors += 1; }} />);
    act(() => { tr.root.findByType("img").props.onError({ currentTarget: {} }); });
    expect(tr.root.findByType("img").props.src).toBe(OWN);
    expect(errors).toBe(0);  // a missing thumbnail is not the caller's error
  });

  it("uses the snapshot only when there is no live photo", () => {
    const SNAP = "https://x/old-order-photo.jpg";
    const live = render(<PrimaryPhoto product={P1} snapshot={SNAP} size="full" />);
    expect(live.root.findByType("img").props.src).toBe(OWN);
    const none = render(<PrimaryPhoto product={{ id: "p1" }} snapshot={SNAP} />);
    expect(none.root.findByType("img").props.src).toBe(SNAP);
  });
});

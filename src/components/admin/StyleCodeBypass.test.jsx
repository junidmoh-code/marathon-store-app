// ─── THE BYPASS CANNOT BE COMPLETED CASUALLY ─────────────────────────────────
// An exempt product gets NO /style_code_index claim, so the name search on this
// panel is the ONLY duplicate protection it will EVER have — not the first line
// of defence, the only line. These tests exist to make removing either
// precondition fail CI.
//
// The visual subordination is tested next door in StyleCodeGate.unblock.test.jsx
// (a link, not a button). This file is about what the panel demands.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const StyleCodeBypass = (await import("./StyleCodeBypass.jsx")).default;
const { EXEMPT_REASON_KEYS } = await import("../../config/styleCode");

const PRODUCTS = [
  { id: "p1", name: "Gucci Ace Leather Sneaker", category: "Footwear", photoUrl: null },
  { id: "p2", name: "Nike Dunk Low Panda", category: "Footwear", photoUrl: null },
];

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const btn = (root, re) => root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));
const screen = (r) => JSON.stringify(r.toJSON());

let onConfirm, onCancel;
beforeEach(() => { onConfirm = vi.fn(); onCancel = vi.fn(); });

async function mount(products = PRODUCTS) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(StyleCodeBypass, { products, onCancel, onConfirm }));
  });
  return r;
}
const type = async (r, v) => act(async () => {
  r.root.findAllByType("input")[0].props.onChange({ target: { value: v } });
});
const submit = (r) => btn(r.root, /Add without a style code/);

describe("the bypass demands a duplicate check AND a reason", () => {
  it("starts DISABLED", async () => {
    const r = await mount();
    expect(submit(r).props.disabled).toBe(true);
  });

  it("a name alone is not enough", async () => {
    const r = await mount();
    await type(r, "Gucci Ace Leather Sneaker");
    expect(submit(r).props.disabled).toBe(true);
    expect(screen(r)).toMatch(/Run the duplicate search/i);
  });

  it("a name + search, but NO reason, is not enough", async () => {
    const r = await mount();
    await type(r, "Gucci Ace Leather Sneaker");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });
    expect(submit(r).props.disabled).toBe(true);
    expect(screen(r)).toMatch(/Choose a reason/i);
  });

  it("a reason but NO search is not enough", async () => {
    const r = await mount();
    await type(r, "Gucci Ace Leather Sneaker");
    await act(async () => { btn(r.root, /no style code at all/i).props.onClick(); });
    expect(submit(r).props.disabled).toBe(true);
    expect(screen(r)).toMatch(/Run the duplicate search/i);
  });

  it("BOTH done → enabled, and it reports the reason", async () => {
    const r = await mount();
    await type(r, "Gucci Ace Leather Sneaker");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });
    await act(async () => { btn(r.root, /no style code at all/i).props.onClick(); });

    expect(submit(r).props.disabled).toBe(false);
    await act(async () => { submit(r).props.onClick(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual({
      name: "Gucci Ace Leather Sneaker", reason: "no_code_exists",
    });
  });

  it("EDITING THE NAME AFTER SEARCHING invalidates the check", async () => {
    // Search "Nike", read "no matches", retype "Gucci Ace", bypass — the search
    // never looked at Gucci. That must not count.
    const r = await mount();
    await type(r, "Nike Air Force");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });
    await act(async () => { btn(r.root, /no style code at all/i).props.onClick(); });
    expect(submit(r).props.disabled).toBe(false);

    await type(r, "Gucci Ace Leather Sneaker");
    expect(submit(r).props.disabled).toBe(true);
    expect(screen(r)).toMatch(/Run the duplicate search/i);
  });
});

describe("the duplicate results are actually shown", () => {
  it("existing products matching the name are listed", async () => {
    const r = await mount();
    await type(r, "Gucci Ace");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });
    const s = screen(r);
    expect(s).toMatch(/Gucci Ace Leather Sneaker/);
    expect(s).toMatch(/cancel and add stock to it instead/i);
  });

  it("a clean search says so plainly", async () => {
    const r = await mount([]);
    await type(r, "Something Entirely New");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });
    expect(screen(r)).toMatch(/No existing product matches/i);
  });

  it("the panel states why this check is the only protection", async () => {
    const r = await mount();
    expect(screen(r)).toMatch(/only/i);
  });
});

describe("the reasons are the configured ones", () => {
  it("every configured reason is offered and selectable", async () => {
    const r = await mount();
    await type(r, "Gucci Ace Leather Sneaker");
    await act(async () => { btn(r.root, /Search existing products/).props.onClick(); });

    for (const key of EXEMPT_REASON_KEYS) {
      const label = { no_code_exists: /no style code at all/i,
                      label_unreadable: /can't read it/i,
                      label_missing: /has been removed/i }[key];
      await act(async () => { btn(r.root, label).props.onClick(); });
      await act(async () => { submit(r).props.onClick(); });
      expect(onConfirm.mock.calls.at(-1)[0].reason).toBe(key);
    }
  });

  it("'no code exists' and 'cannot read it' stay separate — the metric depends on it", () => {
    expect(EXEMPT_REASON_KEYS).toContain("no_code_exists");
    expect(EXEMPT_REASON_KEYS).toContain("label_unreadable");
    expect(new Set(EXEMPT_REASON_KEYS).size).toBe(EXEMPT_REASON_KEYS.length);
  });
});

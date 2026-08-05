// ─── ROUTING MUST WAIT FOR THE LIVE ENFORCEMENT CONFIG ───────────────────────
// Continue was enabled while the config was still loading, so the parent routed
// on the DEFAULT list. If the console enforces any category beyond sneakers,
// that product reached the form with no style-code gate at all — the gate
// silently not applying is worse than it applying wrongly, because nothing on
// screen says it was skipped. (CodeRabbit, PR #320.)

import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
vi.mock("./CategorySelect", () => ({ default: () => null }));

const CategoryFirstStep = (await import("./CategoryFirstStep.jsx")).default;

function textOf(n) {
  if (n == null || n === false) return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (n.props) return textOf(n.props.children);
  return "";
}
const contBtn = (r) => r.root.findAllByType("button")
  .find((b) => /Continue|Loading/.test(textOf(b.props.children)));

async function mount(props) {
  let r;
  await act(async () => {
    r = TestRenderer.create(React.createElement(CategoryFirstStep, {
      taxonomy: {}, taxonomySource: "live", value: "", onChange: vi.fn(),
      onContinue: vi.fn(), onCancel: vi.fn(), enforced: ["sneakers"], configReady: true, ...props,
    }));
  });
  return r;
}

describe("Continue waits for the live config", () => {
  it("is DISABLED while the config is still loading, even with a category chosen", async () => {
    const r = await mount({ value: "boots", configReady: false });
    expect(contBtn(r).props.disabled).toBe(true);
    expect(textOf(contBtn(r).props.children)).toMatch(/Loading/);
  });

  it("is disabled with no category, config ready or not", async () => {
    expect(contBtn(await mount({ value: "", configReady: true })).props.disabled).toBe(true);
    expect(contBtn(await mount({ value: "", configReady: false })).props.disabled).toBe(true);
  });

  it("enables only once BOTH a category is chosen and the config has loaded", async () => {
    const r = await mount({ value: "sneakers", configReady: true });
    expect(contBtn(r).props.disabled).toBe(false);
    expect(textOf(contBtn(r).props.children)).toMatch(/Continue/);
  });

  it("cannot be clicked through while loading", async () => {
    const onContinue = vi.fn();
    const r = await mount({ value: "boots", configReady: false, onContinue });
    expect(contBtn(r).props.disabled).toBe(true);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("announces the next step only once the config is real", async () => {
    const loading = await mount({ value: "sneakers", configReady: false });
    expect(JSON.stringify(loading.toJSON())).not.toMatch(/inside-tongue/i);
    const ready = await mount({ value: "sneakers", configReady: true });
    expect(JSON.stringify(ready.toJSON())).toMatch(/inside-tongue/i);
  });

  it("a non-enforced category says no code is needed", async () => {
    const r = await mount({ value: "belts", configReady: true, enforced: ["sneakers"] });
    expect(JSON.stringify(r.toJSON())).toMatch(/No style code needed/i);
  });
});

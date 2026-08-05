// ─── STYLE CODE CAPTURE — save() MUST ALWAYS RELEASE THE BUTTON ──────────────
// enqueueStyleCodeCapture returns an error RESULT only for its final set().
// push(), getDownloadURL() and serverNowMs() run outside that try, so the
// promise itself can reject. save() did not catch, so setBusy(false) never ran:
// the button sat disabled showing "Saving…" forever, with no error and no way
// to retry. On a shop floor that is indistinguishable from a broken app.
// (CodeRabbit, PR #312.)
//
// ── WHY react-test-renderer AND NOT A SOURCE ASSERTION ───────────────────────
// The guarantee is behavioural — "the operator can always try again" — and only
// a rendered component that actually awaits a REJECTED promise can demonstrate
// it. Grepping for `finally` would pass against a finally that did the wrong
// thing, and would say nothing about the error the operator sees. Same
// devDependency and same reasoning as DisplayRegister.gate.test.jsx.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

// The unit under test is save()'s error handling, so the enqueue is a spy we
// can make REJECT (not merely resolve {ok:false}) — that is the untested path.
const enqueueMock = vi.fn();
vi.mock("../../utils/styleCodeCapture", () => ({
  enqueueStyleCodeCapture: (...a) => enqueueMock(...a),
  styleCodeProgress: () => ({ total: 0, withCode: 0, needsReview: 0, confirmed: 0, pct: 0 }),
  styleCodeProgressForFootwear: () => ({ total: 0, withCode: 0, needsReview: 0, confirmed: 0, pct: 0 }),
}));
vi.mock("../../firebase", () => ({ auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 1754300000000 }));
vi.mock("../../utils/labelPhoto", () => ({ prepareLabelPhoto: async () => ({ dataUrl: "d", base64: "b", blob: {} }) }));

const StyleCodeCapture = (await import("./StyleCodeCapture.jsx")).default;

beforeEach(() => { enqueueMock.mockReset(); });

// Collect visible text WITHOUT JSON.stringify — React children carry fiber
// back-references, so stringifying them hits a circular structure.
function textOf(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (node.props) return textOf(node.props.children);
  return "";
}
function byText(root, re) {
  return root.findAllByType("button").find((b) => re.test(textOf(b.props.children)));
}
// The rendered output IS plain JSON, so this one is safe.
const screen = (r) => JSON.stringify(r.toJSON());

async function openAndType(root, code = "CT8527-016") {
  await act(async () => { byText(root, /ADD STYLE CODE/).props.onClick(); });
  // Two inputs render: the code field and the hidden file picker. Pick the
  // code field by its placeholder rather than by position.
  const field = root.findAllByType("input").find((i) => i.props.placeholder === "CT8527-016");
  await act(async () => { field.props.onChange({ target: { value: code } }); });
}

const render = () => TestRenderer.create(
  React.createElement(StyleCodeCapture, { productId: "p1", productName: "Nike Dunk" }),
);

describe("save() always releases the button", () => {
  it("A REJECTED promise still re-enables the button and shows an error", async () => {
    // THE BUG: without a catch, this rejection strands the component.
    enqueueMock.mockRejectedValue(new Error("push failed"));
    let r;
    await act(async () => { r = render(); });
    await openAndType(r.root);

    const save = byText(r.root, /Save style code/);
    expect(save.props.disabled).toBe(false);

    await act(async () => { await save.props.onClick(); });

    const after = byText(r.root, /Save style code/);
    expect(after).toBeDefined();                    // still on the form, not stuck
    expect(after.props.disabled).toBe(false);       // THE GUARANTEE: retryable
    expect(screen(r)).not.toMatch(/Saving…/);
    expect(screen(r).toUpperCase()).toMatch(/PUSH FAILED|COULDN'T SAVE/);
  });

  it("an error RESULT (not a rejection) also re-enables the button", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "You don't have permission." });
    let r;
    await act(async () => { r = render(); });
    await openAndType(r.root);
    await act(async () => { await byText(r.root, /Save style code/).props.onClick(); });

    const after = byText(r.root, /Save style code/);
    expect(after.props.disabled).toBe(false);
    expect(screen(r).toUpperCase()).toMatch(/PERMISSION/);
  });

  it("success shows the confirmation and does not strand the sheet", async () => {
    enqueueMock.mockResolvedValue({ ok: true, captureId: "c1", normalised: "CT8527016" });
    let r;
    await act(async () => { r = render(); });
    await openAndType(r.root);
    await act(async () => { await byText(r.root, /Save style code/).props.onClick(); });

    const json = screen(r);
    expect(json).toMatch(/STYLE CODE SAVED/);
    expect(json).not.toMatch(/Saving…/);
    // The promise it makes the operator, still on screen.
    expect(json).toMatch(/name, photo and category are unchanged/i);
  });

  it("a rejection can be retried — the second attempt actually fires", async () => {
    enqueueMock.mockRejectedValueOnce(new Error("network"));
    enqueueMock.mockResolvedValueOnce({ ok: true, captureId: "c1", normalised: "CT8527016" });
    let r;
    await act(async () => { r = render(); });
    await openAndType(r.root);

    await act(async () => { await byText(r.root, /Save style code/).props.onClick(); });
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    // If the button were still disabled this second click could never happen.
    await act(async () => { await byText(r.root, /Save style code/).props.onClick(); });
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(screen(r)).toMatch(/STYLE CODE SAVED/);
  });
});

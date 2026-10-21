// ─── DISPLAY CHECKS — a website order pick gets ITS two verdicts ─────────────
// Run: npx vitest run src/pages/DisplayChecks/CheckSheet.online.test.jsx
// An online_pick record shows the WEB badge + packer instruction and offers
// "Handed to packer" / "Not found" — never Display Confirmed / No Stock — and
// each calls completeDisplayCheck with its own result. A normal check is
// unchanged. The server refuses a mismatch anyway (display-checks-online-pick
// test); this pins that the shop is never OFFERED one.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, activeElement: null };

const callMock = vi.fn(async () => ({ data: { ok: true } }));
vi.mock("../../firebase", () => ({ functions: {} }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => (...a) => callMock(...a) }));
vi.mock("./StyleCodeCapture", () => ({ default: () => null }));

const { default: CheckSheet } = await import("./CheckSheet.jsx");
const { PACKER_INSTRUCTION } = await import("../../utils/onlineOrders.js");

const strings = (c) => (c == null || typeof c === "boolean" ? "" : Array.isArray(c) ? c.map(strings).join("") : typeof c === "object" ? strings(c.props?.children) : String(c));
const buttons = (tree) => tree.root.findAll((n) => n.type === "button").map((b) => ({ label: strings(b.props.children).trim(), b }));
const all = (tree) => JSON.stringify(tree.toJSON());

async function render(check) {
  let tree;
  await act(async () => { tree = TestRenderer.create(<CheckSheet store="marathon-pe" check={check} onClose={() => {}} />); });
  return tree;
}
const pick = { key: "online__9__0", checkId: "online__9__0", productId: "p9", productName: "Boss Tee", size: "M", status: "open",
               kind: "online_pick", ref: "WEB-1042", orderId: "9", lineIndex: 0, qty: 1 };

describe("CheckSheet for an online_pick", () => {
  it("shows the WEB badge and the instruction, offers Handed to packer / Not found and NOT the display verdicts", async () => {
    const tree = await render(pick);
    const labels = buttons(tree).map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(["Handed to packer", "Not found", "Cancel"]));
    expect(labels).not.toContain("Display Confirmed");
    expect(labels).not.toContain("No Stock Available");
    expect(all(tree)).toContain("WEB-1042");
    expect(all(tree)).toContain(PACKER_INSTRUCTION);
  });

  for (const [label, result] of [["Handed to packer", "handed"], ["Not found", "not_found"]]) {
    it(`${label} → completeDisplayCheck with result "${result}"`, async () => {
      callMock.mockClear();
      const tree = await render(pick);
      await act(async () => { await buttons(tree).find((x) => x.label === label).b.props.onClick(); });
      expect(callMock).toHaveBeenCalledWith({ store: "marathon-pe", key: "online__9__0", checkId: "online__9__0", result, override: false });
    });
  }

  it("a normal display check is unchanged", async () => {
    const tree = await render({ ...pick, kind: undefined, ref: undefined, key: "p9__M", checkId: "c1" });
    const labels = buttons(tree).map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(["Display Confirmed", "No Stock Available"]));
    expect(labels).not.toContain("Handed to packer");
    expect(all(tree)).not.toContain(PACKER_INSTRUCTION);
  });
});

// ─── JUNID'S TYPED TOTAL IS JUNID'S ALONE, AND NEVER TRAVELS WITHOUT A PHOTO ──
// Some printers print half the slip, so the total is not on the paper. The
// owner may type it beside the photo; nobody else is ever offered the field.
// The server refuses everyone else regardless (functions/test/
// card-declared-total.test.cjs) — this pins the half that a manager SEES.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  "0000Z4M6": { label: "Trophy Till 2", storeId: "trophy", tillId: "till-2" },
  "0000HP1X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
};

const auth = { currentUser: null };
const calls = [];
vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, get auth() { return auth; } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (refOrQuery, cb) => {
    cb({ val: () => (String(refOrQuery?.path ?? "").includes("cardTerminals") ? ESTATE : {}) });
    return () => {};
  },
  query: (r) => r, orderByChild: () => {}, limitToLast: () => {},
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (payload) => {
    calls.push(payload);
    if (calls.hold) await calls.hold;
    return { data: payload.action === "extract" ? { ok: true, draftId: "draft-0000001" } : { ok: true } };
  },
}));
vi.mock("../../utils/serverTime", () => ({
  serverNowMs: () => Date.parse("2026-09-25T16:40:00Z"),
  saDateStringAt: () => "2026-09-25",
}));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: vi.fn(async (file) => ({ source: { file }, width: 1000, height: 2000, release: () => {} })),
  isAcceptedImageFile: () => true, describePickedFile: () => "",
}));

const CardReconScreen = (await import("./CardReconScreen")).default;

const render = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<CardReconScreen onExit={() => {}} />); });
  return tree;
};
const textOf = (n) => [].concat(n.props.children).filter((c) => typeof c === "string").join("");
const cards = (tree) => tree.root.findAll((n) => n.type === "button" && n.props["aria-expanded"] !== undefined);
const buttonNamed = (tree, name) => tree.root.findAll((n) => n.type === "button" && textOf(n) === name);
const labelNamed = (tree, name) => tree.root.findAll((n) => n.type === "label" && textOf(n).trim() === name)
  .map((l) => l.find((n) => n.type === "input"));
const typedInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.inputMode === "decimal");
const fileInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.type === "file");
const everyString = (tree) => tree.root.findAll((n) => typeof n.props?.children === "string" || Array.isArray(n.props?.children))
  .map(textOf).join(" | ");
const pick = async (input) => {
  await act(async () => { await input.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } }); });
};
const tap = (node) => act(() => { node.props.onClick(); });

beforeEach(() => {
  calls.length = 0;
  // The downscale draws on a canvas; the renderer has no DOM.
  // Each canvas remembers what was drawn on it: a file named "new.jpg" encodes
  // as TkVX, anything else as QUJDRA== — so a test can tell WHICH photo won.
  globalThis.document = { createElement: () => {
    let drawn = null;
    return {
      getContext: () => ({ drawImage: (src) => { drawn = src; } }),
      toDataURL: () => `data:image/jpeg;base64,${drawn?.file?.name === "new.jpg" ? "TkVX" : "QUJDRA=="}`,
    };
  } };
});

describe("the card list is clean", () => {
  it("one card per till, and nothing under any card until it is tapped — for Junid too", () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    expect(cards(tree)).toHaveLength(2);
    expect(fileInputs(tree)).toHaveLength(0);
    expect(typedInputs(tree)).toHaveLength(0);
    expect(everyString(tree)).not.toMatch(/Type|total|Photograph|gallery/i);
  });

  it("tapping a card opens the chooser under THAT card only", () => {
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    tap(cards(tree)[0]);
    expect(tree.root.findAll((n) => n.props["data-testid"] === "capture-chooser")).toHaveLength(1);
    expect(labelNamed(tree, "Photograph the slip")).toHaveLength(1);
    expect(labelNamed(tree, "Choose from gallery / file")).toHaveLength(1);
    // Cancel puts the list back exactly as it was.
    tap(buttonNamed(tree, "Cancel")[0]);
    expect(fileInputs(tree)).toHaveLength(0);
  });

  it("the camera option opens the camera; the gallery option does not", () => {
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    tap(cards(tree)[0]);
    expect(labelNamed(tree, "Photograph the slip")[0].props.capture).toBe("environment");
    expect(labelNamed(tree, "Choose from gallery / file")[0].props.capture).toBeUndefined();
  });

  it("a gallery pick sends straight away, with no typed figure — even for Junid", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    tap(cards(tree)[0]);
    await pick(labelNamed(tree, "Choose from gallery / file")[0]);
    const extract = calls.find((c) => c.action === "extract");
    expect(extract.photos[0].base64).toBe("QUJDRA==");
    expect("declaredTotal" in extract).toBe(false);
    expect(calls.some((c) => c.action === "submit")).toBe(true);
  });
});

describe("Type the total — Junid only", () => {
  it("a manager's chooser has no Type the total", () => {
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    tap(cards(tree)[0]);
    expect(buttonNamed(tree, "Type the total")).toHaveLength(0);
  });

  it("Junid's git address is not his admin identity — not offered either", () => {
    auth.currentUser = { email: "junidmoh@gmail.com" };
    const tree = render();
    tap(cards(tree)[0]);
    expect(buttonNamed(tree, "Type the total")).toHaveLength(0);
  });

  it("photo, then total, then ONE Submit — enabled only once both are there", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    tap(cards(tree)[0]);
    tap(buttonNamed(tree, "Type the total")[0]);
    const submit = () => buttonNamed(tree, "Submit")[0];
    expect(submit(), "the Submit button is always present").toBeTruthy();
    expect(submit().props.disabled, "nothing attached, nothing typed").toBe(true);

    // The figure alone is not enough.
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "43,530.00" } }); });
    expect(submit().props.disabled, "typed but no photo").toBe(true);

    // Attaching the photo SENDS NOTHING — it only attaches.
    await pick(labelNamed(tree, "Take photo")[0]);
    expect(calls, "attaching must not send").toHaveLength(0);
    expect(everyString(tree)).toContain("✓ Photo attached");
    expect(submit().props.disabled, "photo + figure").toBe(false);

    await act(async () => { await submit().props.onClick(); });
    const extract = calls.find((c) => c.action === "extract");
    expect(extract.declaredTotal).toBe("43,530.00");
    expect(extract.photos).toHaveLength(1);
    expect(extract.photos[0].base64).toBe("QUJDRA==");
    expect(extract.summaryOnly).toBe(true);
    expect(extract.pickedTid, "the first card is Marathon Till 2").toBe("0000HP1X");
    expect(calls.some((c) => c.action === "submit"), "one Submit completes the capture").toBe(true);
    // Done: the panel closes and the card ticks.
    expect(typedInputs(tree)).toHaveLength(0);
    expect(tree.root.findAll((n) => n.props["aria-label"] === "today's report is in")).toHaveLength(1);
  });

  it("a photo with the figure cleared again cannot be submitted", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    tap(cards(tree)[0]);
    tap(buttonNamed(tree, "Type the total")[0]);
    await pick(labelNamed(tree, "Choose file")[0]);
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "   " } }); });
    expect(buttonNamed(tree, "Submit")[0].props.disabled).toBe(true);
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    expect(calls).toHaveLength(0);
  });

  it("the typed figure goes to the till whose card was tapped", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    const second = cards(tree)[1];
    tap(second);
    tap(buttonNamed(tree, "Type the total")[0]);
    await pick(labelNamed(tree, "Take photo")[0]);
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "100" } }); });
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    // Registry order is by label: Marathon Till 2 (0000HP1X), Trophy Till 2 (0000Z4M6).
    expect(calls.find((c) => c.action === "extract").pickedTid).toBe("0000Z4M6");
  });
});


describe("Type the total — the races (CodeRabbit, PR #650)", () => {
  it("a slow earlier photo never replaces the photo picked after it", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const { decodeImageFile } = await import("../shopify/imageDecode");
    let releaseOld;
    decodeImageFile.mockImplementationOnce((file) => new Promise((resolve) => {
      releaseOld = () => resolve({ source: { file }, width: 1000, height: 2000, release: () => {} });
    }));
    const tree = render();
    tap(cards(tree)[0]);
    tap(buttonNamed(tree, "Type the total")[0]);
    // The handler, held directly: while a photo attaches the panel hides its
    // pick buttons, so through the UI this race needs a fast double-tap. The
    // sequence guard is what makes it safe either way.
    const onChange = labelNamed(tree, "Take photo")[0].props.onChange;
    // First pick (old.jpg) hangs in decode; the second (new.jpg) finishes first.
    let slow;
    act(() => { slow = onChange({ target: { files: [{ name: "old.jpg" }], value: "" } }); });
    await act(async () => { await onChange({ target: { files: [{ name: "new.jpg" }], value: "" } }); });
    // Now the OLD decode finishes, last.
    await act(async () => { releaseOld(); await slow; });
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "100" } }); });
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    expect(calls.find((c) => c.action === "extract").photos[0].base64, "the NEWER photo is sent").toBe("TkVX");
  });

  it("a finished submit closes only its own till's panel", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    let finish;
    const tree = render();
    tap(cards(tree)[0]);
    tap(buttonNamed(tree, "Type the total")[0]);
    await pick(labelNamed(tree, "Take photo")[0]);
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "100" } }); });
    // Hold the extract open, and meanwhile open the OTHER till's panel.
    calls.hold = new Promise((r) => { finish = r; });
    let sending;
    act(() => { sending = buttonNamed(tree, "Submit")[0].props.onClick(); });
    tap(cards(tree)[1]);
    tap(buttonNamed(tree, "Type the total")[0]);
    await act(async () => { finish(); await sending; });
    expect(tree.root.findAll((n) => n.props["data-testid"] === "typed-total"), "Trophy's panel stays open").toHaveLength(1);
    delete calls.hold;
  });
});

describe("Type the total — Submit says what it is waiting for (26 Sept screenshot)", () => {
  it("a figure with no photo names the missing photo; attaching clears it", async () => {
    auth.currentUser = { email: "gunidmoh@gmail.com" };
    const tree = render();
    tap(cards(tree)[1]);
    tap(buttonNamed(tree, "Type the total")[0]);
    act(() => { typedInputs(tree)[0].props.onChange({ target: { value: "1900" } }); });
    const status = () => tree.root.findAll((n) => n.props.role === "status").map(textOf).join("");
    expect(status()).toBe("Add the slip photo (step 1) to submit.");
    await pick(labelNamed(tree, "Choose file")[0]);
    expect(status()).toBe("");
    expect(buttonNamed(tree, "Submit")[0].props.disabled).toBe(false);
  });

  it("the photo buttons fit their panel: border-box, and the columns may shrink", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "CardReconScreen.jsx"), "utf8");
    expect(src).toMatch(/option: \{[^}]*boxSizing: "border-box"/);
    expect(src).toMatch(/pair: \{[^}]*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  });
});

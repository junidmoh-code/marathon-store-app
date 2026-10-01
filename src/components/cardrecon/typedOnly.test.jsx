// ─── A TYPED-TOTAL MACHINE: ONE BOX, NO CAMERA, THE OWNER ONLY ──────────────
// Trophy Till 2 cannot email its report and its printer leaves the total off
// the paper, so there is nothing to photograph (Junid, 1 Oct 2026). Its card
// opens one box for the figure and that is the whole capture.
//
// TWO THINGS ARE PINNED HERE AND NOWHERE ELSE ON THE CLIENT. The first is that
// the camera is really GONE from this card — not hidden behind a condition that
// a later edit re-opens, but absent: no file input, no chooser, no photo step.
// The second is that it is NOT the owner's typed total: that one stays his and
// still demands a photograph, and the two panels must never be confused for
// each other, because one of them has paper behind it and the other does not.
//
// The server holds the same two lines independently (functions/test/
// card-typed-capture.test.cjs); this is the half a manager SEES.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  // Set to typed entry: no email, no camera, a figure typed in.
  "0000Z4M6": { label: "Trophy Till 2", storeId: "trophy", tillId: "till-2", capture: "typed" },
  // An ordinary machine beside it, so every assertion below is about the
  // TYPED card rather than about the screen having nothing on it.
  "0000HP1X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
};

const OWNER = "gunidmoh@gmail.com";
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
    if (calls.refuse && payload.action === "typed" && !payload.correction) {
      return { data: { ok: false, reason: "A total for this machine has already been typed in today (batch #486). If that figure was wrong, submit this one as a replacement — both are kept." } };
    }
    return { data: payload.action === "submit" ? { ok: true } : { ok: true, draftId: "draft-0000001" } };
  },
}));
vi.mock("../../utils/serverTime", () => ({
  serverNowMs: () => Date.parse("2026-10-01T15:30:00Z"),
  saDateStringAt: () => "2026-10-01",
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
const typedInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.inputMode === "decimal");
const fileInputs = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.type === "file");
const panel = (tree, id) => tree.root.findAll((n) => n.props["data-testid"] === id);
const tap = (node) => act(() => { node.props.onClick(); });
const type = (input, value) => act(() => { input.props.onChange({ target: { value } }); });

// The typed card is Trophy Till 2 — the list is sorted by label, so it is the
// one whose name says so rather than whichever index happens to be right.
const typedCard = (tree) => cards(tree).find((c) => textOf(c.findAll((n) => n.type === "span")[0]) === "Trophy Till 2");
const photoCard = (tree) => cards(tree).find((c) => textOf(c.findAll((n) => n.type === "span")[0]) === "Marathon Till 2");

beforeEach(() => {
  calls.length = 0;
  delete calls.refuse;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => "data:image/jpeg;base64,QUJDRA==",
  }) };
});

describe("the camera is gone from a typed-total card", () => {
  it("for Junid its card is tappable, and says what it wants instead of showing a camera", () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    // Still a card, still tappable: a silent card reads as "nothing to do
    // here", which is the one thing this must not say.
    expect(typedCard(tree)).toBeTruthy();
    expect(textOf(typedCard(tree).findAll((n) => n.type === "span")[1] ?? { props: {} })).toBe("Type total");
  });

  it("a manager sees the card and who captures it, with nothing to tap", () => {
    // No manual-typing capture route for staff (standing rule, 1 Oct 2026).
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    expect(typedCard(tree)).toBeUndefined();
    expect(typedInputs(tree)).toHaveLength(0);
    const shown = tree.root.findAll((n) => typeof n.props?.children === "string").map(textOf).join(" | ");
    expect(shown).toMatch(/Junid types this/);
  });

  it("tapping it opens ONE box and no photo step at all", () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    expect(panel(tree, "typed-only")).toHaveLength(1);
    expect(typedInputs(tree)).toHaveLength(1);
    // THE POINT: no camera, no gallery, no chooser, no photo step.
    expect(fileInputs(tree)).toHaveLength(0);
    expect(panel(tree, "capture-chooser")).toHaveLength(0);
    expect(panel(tree, "typed-total")).toHaveLength(0);
  });

  it("Junid gets the one box — not the photo-and-total panel", () => {
    // The owner's own typed total still requires a photograph. On a machine
    // with no slip there is none to require, so he gets the typed-only panel;
    // offering him the photo panel here would ask for a photograph that cannot
    // be taken.
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    expect(panel(tree, "typed-only")).toHaveLength(1);
    expect(panel(tree, "typed-total")).toHaveLength(0);
    expect(fileInputs(tree)).toHaveLength(0);
  });

  it("the machine beside it is untouched — chooser, camera and all", () => {
    auth.currentUser = { email: "manager@marathon.co.za" };
    const tree = render();
    tap(photoCard(tree));
    expect(panel(tree, "capture-chooser")).toHaveLength(1);
    expect(panel(tree, "typed-only")).toHaveLength(0);
    expect(fileInputs(tree).length).toBeGreaterThan(0);
  });
});

describe("what the box sends", () => {
  it("Junid's figure is sent to the typed action, not as a photo capture", async () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "2250.00");
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    const sent = calls.find((c) => c.action === "typed");
    expect(sent).toBeTruthy();
    expect(sent.pickedTid).toBe("0000Z4M6");
    expect(sent.declaredTotal).toBe("2250.00");
    expect(sent.correction).toBe(false);
    // NOT A PHOTO CAPTURE: nothing resembling one is sent.
    expect("photos" in sent).toBe(false);
    expect(calls.some((c) => c.action === "extract")).toBe(false);
    expect(calls.some((c) => c.action === "submit")).toBe(true);
  });

  it("Submit does nothing until there is a figure", () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    expect(buttonNamed(tree, "Submit")[0].props.disabled).toBe(true);
    type(typedInputs(tree)[0], "   ");
    expect(buttonNamed(tree, "Submit")[0].props.disabled).toBe(true);
    type(typedInputs(tree)[0], "2250");
    expect(buttonNamed(tree, "Submit")[0].props.disabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("the figure is sent as typed — the client never parses it", () => {
    // The slip's own strict parser lives on the server and refuses what it
    // cannot read. A client that tidied the text first would be a second,
    // quieter parser that nobody tests.
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "  2,250.00  ");
    expect(typedInputs(tree)[0].props.value).toBe("  2,250.00  ");
  });

  it("the panel closes and the card ticks once it is recorded", async () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "2250.00");
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    expect(panel(tree, "typed-only")).toHaveLength(0);
    expect(typedInputs(tree)).toHaveLength(0);
  });
});

describe("a second entry the same day", () => {
  it("is refused in the server's words, with the replacement offered", async () => {
    auth.currentUser = { email: OWNER };
    calls.refuse = true;
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "2250.00");
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    const shown = tree.root.findAll((n) => typeof n.props?.children === "string").map(textOf).join(" | ");
    expect(shown).toMatch(/already been typed in today/);
    // The way out, worded for a figure rather than for a photo.
    expect(buttonNamed(tree, "Replace today's typed total")).toHaveLength(1);
    expect(buttonNamed(tree, "Replace the earlier capture")).toHaveLength(0);
  });

  it("the replacement resends the SAME figure, marked as a correction", async () => {
    auth.currentUser = { email: OWNER };
    calls.refuse = true;
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "2250.00");
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    calls.length = 0;
    delete calls.refuse;
    await act(async () => { await buttonNamed(tree, "Replace today's typed total")[0].props.onClick(); });
    const resent = calls.find((c) => c.action === "typed");
    expect(resent.correction).toBe(true);
    expect(resent.declaredTotal).toBe("2250.00");
  });
});

describe("no money is rendered, as everywhere else on this screen", () => {
  it("the figure is never echoed back, only held in the box being typed into", async () => {
    auth.currentUser = { email: OWNER };
    const tree = render();
    tap(typedCard(tree));
    type(typedInputs(tree)[0], "2250.00");
    await act(async () => { await buttonNamed(tree, "Submit")[0].props.onClick(); });
    const shown = tree.root.findAll((n) => typeof n.props?.children === "string").map(textOf).join(" | ");
    expect(shown).not.toMatch(/2250|2,250|R\s*2/);
  });
});

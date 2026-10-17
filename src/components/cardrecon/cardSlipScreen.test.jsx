// ─── THE ONE-TILL SLIP SCREEN: A PHOTO, A NUMBER, "SENT" ─────────────────────
// Junid, 16 Oct 2026: Yasmin and Amanda each send ONE till's slip — a photo
// and the card total, 0 accepted — and see nothing back. These pin what they
// see; the server's half (scope, correction, record) is
// functions/test/card-slip-scope.test.cjs and card-slip-record.test.cjs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  "0000AA2X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
  "0000BB2Y": { label: "Trophy Till 2", storeId: "trophy", tillId: "till-2", capture: "typed" },
  "67000003": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" },
};
const perms = vi.hoisted(() => ({ permRecord: null }));
const calls = [];
vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, auth: {} }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => perms, ADMIN_EMAIL: "gunidmoh@gmail.com" }));
const reads = [];
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, cb) => { reads.push(r.path); cb({ val: () => (r.path === "config/cardTerminals" ? ESTATE : null) }); return () => {}; },
}));
vi.mock("firebase/functions", () => ({
  httpsCallable: () => async (payload) => {
    if (payload.action === "slipTills") return new Promise(() => {}); // the registry fixture answers these tests
    calls.push(payload);
    if (calls.fail) throw calls.fail;
    return { data: calls.reply ? calls.reply(payload) : { ok: true, received: true } };
  },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-10-16T18:00:00+02:00") }));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: vi.fn(async (file) => ({ source: { file }, width: 1000, height: 2000, release: () => {} })),
  isAcceptedImageFile: () => true, describePickedFile: () => "",
}));

const CardSlipScreen = (await import("./CardSlipScreen")).default;
const { _resetSlipTerminals } = await import("./slipTerminals");

const textOf = (n) => [].concat(n.props.children).filter((c) => typeof c === "string").join("");
const everyString = (tree) => tree.root.findAll((n) => typeof n.props?.children === "string" || Array.isArray(n.props?.children))
  .map(textOf).join(" | ");
const render = () => { let t; act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); }); return t; };
const fileInputs = (t) => t.root.findAll((n) => n.type === "input" && n.props.type === "file");
const amount = (t) => t.root.find((n) => n.type === "input" && n.props.inputMode === "decimal");
const submitBtn = (t) => t.root.findAll((n) => n.type === "button" && /^(Submit|Sending…)$/.test(textOf(n)))[0];
const pick = async (input) => { await act(async () => { await input.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } }); }); };
const type = (t, v) => act(() => { amount(t).props.onChange({ target: { value: v } }); });
const press = async (b) => { await act(async () => { await b.props.onClick(); }); };

beforeEach(() => {
  _resetSlipTerminals(); // every test opens its own registry read
  calls.length = 0; calls.fail = null; calls.reply = null; reads.length = 0;
  perms.permRecord = { displayName: "yasmin", stockRole: "pos", cardSlipTills: { pe: { "till-2": true } } };
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,QUJDRA==" }) };
});

describe("Yasmin's screen", () => {
  it("is ONE till — hers — and nothing else from card recon", () => {
    const t = render();
    const text = everyString(t);
    expect(text).toMatch(/Marathon Till 2/);
    expect(text).not.toMatch(/Trophy Till 2|Marathon Till 3|Card machines|settings|variance|expected|clean/i);
    expect(t.root.findAll((n) => n.props["aria-label"] === "Terminal settings")).toHaveLength(0);
    // The registry is the only node it reads.
    expect([...new Set(reads)]).toEqual(["config/cardTerminals"]);
  });

  // Junid, 17 Oct 2026: Marathon PE Till 2's slip is a PHOTO ONLY — the total
  // is read off it on the server. Only a typed-total till (Trophy Till 2) asks
  // for the number.
  it("offers the camera and the gallery, and NO number box", () => {
    const t = render();
    const inputs = fileInputs(t);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.props.capture)).toEqual(["environment", undefined]);
    expect(t.root.findAll((n) => n.type === "input" && n.props.inputMode === "decimal")).toHaveLength(0);
    expect(everyString(t)).not.toMatch(/Card total on the slip/);
  });

  it("Submit waits for the photo only, and says so", async () => {
    const t = render();
    expect(submitBtn(t).props.disabled).toBe(true);
    expect(everyString(t)).toMatch(/Add the slip photo to submit/);
    expect(everyString(t)).not.toMatch(/type the card total/i);
    await pick(fileInputs(t)[0]);
    expect(submitBtn(t).props.disabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends the photo with NO typed total, and the answer is 'Sent — thank you' and nothing else", async () => {
    const t = render();
    await pick(fileInputs(t)[1]);
    await press(submitBtn(t));
    expect([...calls]).toEqual([{ action: "slip", pickedTid: "0000AA2X", photos: [{ base64: "QUJDRA==" }] }]);
    expect(t.root.findAll((n) => n.props["data-testid"] === "slip-sent")).toHaveLength(1);
    expect(everyString(t)).toMatch(/Sent — thank you/);
    expect(everyString(t)).not.toMatch(/R\s?\d|batch|variance|clean|short|over/i);
  });

  it("sending again is allowed", async () => {
    const t = render();
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    await act(async () => { t.root.find((n) => n.type === "button" && textOf(n) === "Send it again").props.onClick(); });
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => !("declaredTotal" in c))).toBe(true);
  });

  it("a refusal is shown in the server's words", async () => {
    calls.reply = () => ({ ok: false, reason: "That is not a photo. Take a photo of the slip." });
    const t = render();
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    expect(everyString(t)).toMatch(/That is not a photo/);
    expect(t.root.findAll((n) => n.props["data-testid"] === "slip-sent")).toHaveLength(0);
  });
});

describe("Amanda's screen: Trophy Till 2 is a typed-total till — photo AND number", () => {
  beforeEach(() => { perms.permRecord = { displayName: "Amanda", cardSlipTills: { trophy: { "till-2": true } } }; });

  it("offers the camera and a number box labelled for the card total", () => {
    const t = render();
    expect(fileInputs(t)).toHaveLength(2);
    expect(amount(t).props.inputMode).toBe("decimal");
    expect(everyString(t)).toMatch(/Card total on the slip \(R\)/);
  });

  it("Submit waits for BOTH the photo and the number, and says which", async () => {
    const t = render();
    expect(everyString(t)).toMatch(/Add the slip photo and type the card total/);
    type(t, "1,250.00");
    expect(submitBtn(t).props.disabled).toBe(true);
    expect(everyString(t)).toMatch(/Add the slip photo \(step 1\)/);
    type(t, "");
    await pick(fileInputs(t)[0]);
    expect(submitBtn(t).props.disabled).toBe(true);
    expect(everyString(t)).toMatch(/Type the card total \(step 2\)/);
    type(t, "1,250.00");
    expect(submitBtn(t).props.disabled).toBe(false);
  });

  it("0 is a number: a no-sales evening sends R0 with its photo", async () => {
    const t = render();
    await pick(fileInputs(t)[1]);
    type(t, "0");
    await press(submitBtn(t));
    expect([...calls]).toEqual([{ action: "slip", pickedTid: "0000BB2Y", photos: [{ base64: "QUJDRA==" }], declaredTotal: "0" }]);
    expect(everyString(t)).toMatch(/Sent — thank you/);
  });

  it("a refusal is shown in the server's words, and the form stays filled", async () => {
    calls.reply = () => ({ ok: false, reason: "\"12abc\" is not an amount — type the total as it would print, e.g. 12,345.67." });
    const t = render();
    await pick(fileInputs(t)[0]);
    type(t, "12abc");
    await press(submitBtn(t));
    expect(everyString(t)).toMatch(/is not an amount/);
    expect(amount(t).props.value).toBe("12abc");
  });
});

describe("Amanda's screen, and an account with no till", () => {
  it("Amanda sees Trophy Till 2", () => {
    perms.permRecord = { displayName: "Amanda", cardSlipTills: { trophy: { "till-2": true } } };
    const text = everyString(render());
    expect(text).toMatch(/Trophy Till 2/);
    expect(text).not.toMatch(/Marathon Till/);
  });

  it("no scope draws no till and no form", () => {
    perms.permRecord = { permFlags: { card_recon: true } };
    const t = render();
    expect(fileInputs(t)).toHaveLength(0);
    expect(everyString(t)).toMatch(/isn't set up here yet/);
  });
});

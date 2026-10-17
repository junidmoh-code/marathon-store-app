// ─── THE ONE-TILL SLIP SCREEN: A PHOTO, A NUMBER, "SENT" ─────────────────────
// Junid, 16 Oct 2026: Yasmin and Amanda each send ONE till's slip — a photo
// and the card total, 0 accepted — and see nothing back. These pin what they
// see; the server's half (scope, correction, record) is
// functions/test/card-slip-scope.test.cjs and card-slip-record.test.cjs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = {
  "0000AA2X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
  "0000BB2Y": { label: "Trophy Till 2", storeId: "trophy", tillId: "till-2", capture: "typed" },
  "67000003": { label: "Marathon Till 3", storeId: "pe", tillId: "till-3" },
};
const perms = vi.hoisted(() => ({ permRecord: null, user: null }));
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
    if (payload.action === "slipTills") {
      calls.tillAsks = (calls.tillAsks || 0) + 1;
      // The registry fixture answers most tests; these answer for the server.
      return calls.tills ? { data: calls.tills() } : new Promise(() => {});
    }
    calls.push(payload);
    if (calls.fail) throw calls.fail;
    return { data: calls.reply ? calls.reply(payload) : SENT };
  },
}));
const clock = vi.hoisted(() => ({ now: null }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => clock.now ?? Date.parse("2026-10-16T18:00:00+02:00") }));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: vi.fn(async (file) => ({ source: { file }, width: 1000, height: 2000, release: () => {} })),
  isAcceptedImageFile: () => true, describePickedFile: () => "",
}));

// What the server says when it has KEPT the slip: when, and for which day.
const SENT = { ok: true, received: true, receipt: { at: Date.parse("2026-10-16T18:01:00+02:00"), dayYmd: "2026-10-16" } };
// Warm the modules slipTerminals.js imports lazily: a cold first import can
// outlast a test, and its answer then belongs to no test at all.
await Promise.all([import("firebase/functions"), import("../../firebase")]);
const CardSlipScreen = (await import("./CardSlipScreen")).default;
const { _resetSlipTerminals } = await import("./slipTerminals");

const textOf = (n) => [].concat(n.props.children).filter((c) => typeof c === "string").join("");
const everyString = (tree) => tree.root.findAll((n) => typeof n.props?.children === "string" || Array.isArray(n.props?.children))
  .map(textOf).join(" | ");
// Every screen a test draws is taken down after it, so no test's effects or
// pending server answers run on into the next one.
const mounted = [];
const render = () => { let t; act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); }); mounted.push(t); return t; };
const fileInputs = (t) => t.root.findAll((n) => n.type === "input" && n.props.type === "file");
const amount = (t) => t.root.find((n) => n.type === "input" && n.props.inputMode === "decimal");
const submitBtn = (t) => t.root.findAll((n) => n.type === "button" && /^(Submit|Sending…)$/.test(textOf(n)))[0];
const pick = async (input) => { await act(async () => { await input.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } }); }); };
const type = (t, v) => act(() => { amount(t).props.onChange({ target: { value: v } }); });
const press = async (b) => { await act(async () => { await b.props.onClick(); }); };
// The server's till list arrives after a dynamic import — wait for what it draws.
const until = async (ok) => {
  for (let i = 0; i < 200 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return ok();
};

afterEach(async () => {
  await act(async () => { while (mounted.length) mounted.pop().unmount(); await new Promise((r) => setTimeout(r, 20)); });
});

beforeEach(() => {
  _resetSlipTerminals(); // every test opens its own registry read
  calls.length = 0; calls.fail = null; calls.reply = null; calls.tills = null; calls.tillAsks = 0; reads.length = 0;
  perms.user = null;
  clock.now = null;
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
    expect(everyString(t)).toMatch(/Received at 18:01/);
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

  it("a refusal is 'Not sent — try again', in the server's words", async () => {
    calls.reply = () => ({ ok: false, reason: "That is not a photo. Take a photo of the slip." });
    const t = render();
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    expect(everyString(t)).toMatch(/Not sent — try again/);
    expect(everyString(t)).toMatch(/That is not a photo/);
    expect(t.root.findAll((n) => n.props["data-testid"] === "slip-sent")).toHaveLength(0);
    expect(submitBtn(t).props.disabled).toBe(false);
  });

  // Junid, 17 Oct 2026: "Sent — thank you" ONLY after the server confirms the write.
  it("an 'ok' with no receipt is NOT sent — the server never said it kept the slip", async () => {
    for (const reply of [{ ok: true, received: true }, { ok: true }, { received: true, receipt: SENT.receipt }, null, { ok: true, received: true, receipt: { dayYmd: "2026-10-16" } }, { ok: true, received: true, receipt: { at: 1 } }, { ok: true, received: true, receipt: { at: 1, dayYmd: "16 Oct" } }]) {
      calls.reply = () => reply;
      const t = render();
      await pick(fileInputs(t)[0]);
      await press(submitBtn(t));
      expect(t.root.findAll((n) => n.props["data-testid"] === "slip-sent"), JSON.stringify(reply)).toHaveLength(0);
      expect(everyString(t), JSON.stringify(reply)).toMatch(/Not sent — try again/);
      expect(everyString(t)).not.toMatch(/Sent — thank you/);
    }
  });

  it("a send that never lands (dropped connection, timeout) is 'Not sent — try again', and the photo stays", async () => {
    calls.fail = Object.assign(new Error("deadline-exceeded"), { name: "FirebaseError", code: "functions/deadline-exceeded" });
    const t = render();
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    expect(everyString(t)).toMatch(/Not sent — try again/);
    expect(everyString(t)).toMatch(/took too long to send/);
    expect(everyString(t)).toMatch(/Photo attached/);
    expect(t.root.findAll((n) => n.props["data-testid"] === "slip-sent")).toHaveLength(0);
  });
});

describe("whether today's slip is in — the server's word, not the phone's", () => {
  const TILL = { tid: "0000AA2X", storeId: "pe", tillId: "till-2", label: "Marathon Till 2", typed: false };
  beforeEach(() => { perms.user = { uid: "u-yasmin" }; });

  it("nothing in yet today: says so", async () => {
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: null }] });
    const t = render();
    await until(() => /No slip sent yet today/.test(everyString(t)));
    expect(everyString(t)).toMatch(/No slip sent yet today/);
  });

  it("today's slip is in: the till says when — and nothing about the figure", async () => {
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: { at: Date.parse("2026-10-16T16:24:30+02:00") } }] });
    const t = render();
    await until(() => /Today's slip is in/.test(everyString(t)));
    expect(everyString(t)).toMatch(/Today's slip is in — sent at 16:24/);
    expect(everyString(t)).not.toMatch(/R\s?\d|batch|variance/i);
  });

  it("after a send, the server is asked again — so the line is its answer, not the phone's", async () => {
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: null }] });
    const t = render();
    await until(() => /No slip sent yet today/.test(everyString(t)));
    expect(everyString(t)).toMatch(/No slip sent yet today/); // the first answer is in
    const before = calls.tillAsks;
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: { at: SENT.receipt.at } }] });
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    await until(() => calls.tillAsks > before);
    expect(calls.tillAsks).toBeGreaterThan(before);
    await act(async () => { t.root.find((n) => n.type === "button" && textOf(n) === "Send it again").props.onClick(); });
    await until(() => /Today's slip is in/.test(everyString(t)));
    expect(everyString(t)).toMatch(/Today's slip is in — sent at 18:01/);
  });

  it("the device's copy from another day never claims today's slip is in", async () => {
    globalThis.localStorage = { getItem: (k) => (k === "cardSlip.tills.v1.u-yasmin" ? JSON.stringify([{ ...TILL, sent: { at: 1 } }]) : null), setItem: () => {} };
    try {
      const t = render(); // the server never answers in this test
      expect(everyString(t)).not.toMatch(/Today's slip is in|No slip sent yet/);
    } finally { delete globalThis.localStorage; }
  });

  it("after midnight, before the server answers, the page is already the evening's day", () => {
    clock.now = Date.parse("2026-10-17T00:30:00+02:00");
    expect(everyString(render())).toMatch(/Friday, 16 October/);
    clock.now = Date.parse("2026-10-17T06:00:00+02:00");
    expect(everyString(render())).toMatch(/Saturday, 17 October/);
  });

  it("an answer for yesterday (the screen left open past 06:00) never says today's slip is in — the server is asked again", async () => {
    let asks = 0;
    calls.tills = () => (++asks === 1
      ? { ok: true, dayYmd: "2026-10-15", tills: [{ ...TILL, sent: { at: Date.parse("2026-10-15T16:00:00+02:00") } }] }
      : { ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: null }] });
    const t = render();
    expect(everyString(t)).not.toMatch(/Today's slip is in/);
    await until(() => /No slip sent yet today/.test(everyString(t)));
    expect(everyString(t)).toMatch(/No slip sent yet today/); // only a fresh ask can say this
    expect(everyString(t)).not.toMatch(/Today's slip is in/);
    expect(everyString(t)).toMatch(/Friday, 16 October/);
  });

  it("while the only answer is yesterday's, the till claims nothing either way", async () => {
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-15", tills: [{ ...TILL, sent: { at: Date.parse("2026-10-15T16:00:00+02:00") } }] });
    const t = render();
    await until(() => calls.tillAsks >= 2);
    await until(() => false); // let every answer land
    expect(everyString(t)).not.toMatch(/Today's slip is in|No slip sent yet today/);
  });

  it("a send that timed out asks the server again — it may have landed after the phone gave up", async () => {
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: null }] });
    const t = render();
    await until(() => /No slip sent yet today/.test(everyString(t)));
    const before = calls.tillAsks;
    calls.fail = Object.assign(new Error("deadline-exceeded"), { name: "FirebaseError", code: "functions/deadline-exceeded" });
    calls.tills = () => ({ ok: true, dayYmd: "2026-10-16", tills: [{ ...TILL, sent: { at: Date.parse("2026-10-16T18:01:00+02:00") } }] });
    await pick(fileInputs(t)[0]);
    await press(submitBtn(t));
    await until(() => /Today's slip is in/.test(everyString(t)));
    expect(calls.tillAsks).toBeGreaterThan(before);
    expect(everyString(t)).toMatch(/Not sent — try again/);
    expect(everyString(t)).toMatch(/Today's slip is in — sent at 18:01/);
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

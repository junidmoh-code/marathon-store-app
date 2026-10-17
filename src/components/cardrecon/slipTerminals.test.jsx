// Junid, 17 Oct 2026: "card slip did load but it was too slow". The screen's one
// read is now opened from the home screen and kept, and the last answer is
// kept on the device, so the form is drawn at once.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const ESTATE = { "0000AA2X": { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" } };
const live = vi.hoisted(() => ({ subs: [], answer: null }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, auth: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (r, ok, err) => { const s = { path: r.path, ok, err, closed: false }; live.subs.push(s); return () => { s.closed = true; }; },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: { ok: true, received: true } }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-10-17T18:00:00+02:00") }));
const perms = vi.hoisted(() => ({ permRecord: null }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => perms, ADMIN_EMAIL: "x" }));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: vi.fn(async (file) => ({ source: { file }, width: 1000, height: 2000, release: () => {} })),
  isAcceptedImageFile: () => true, describePickedFile: () => "",
}));
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,QUJDRA==" }) };

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const mod = await import("./slipTerminals");
const CardSlipScreen = (await import("./CardSlipScreen")).default;
const textOf = (n) => [].concat(n.props.children).filter((c) => typeof c === "string").join("");
const allText = (t) => t.root.findAll((n) => n.props && (typeof n.props.children === "string" || Array.isArray(n.props.children))).map(textOf).join(" | ");

beforeEach(() => {
  mod._resetSlipTerminals();
  live.subs.length = 0;
  mem.clear();
  perms.permRecord = { cardSlipTills: { pe: { "till-2": true } } };
});

describe("the Card Slip registry, ready before the tap", () => {
  it("a cold start with the device's last copy draws the form at once — before the live read answers", () => {
    mem.set(mod.SLIP_TERMINALS_KEY, JSON.stringify(ESTATE));
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    expect(live.subs.length).toBe(1); // the live read is still opened
    expect(allText(t)).toMatch(/Marathon Till 2/);
    expect(allText(t)).not.toMatch(/Loading/);
    expect(t.root.findAll((n) => n.props?.["data-testid"] === "slip-form").length).toBe(1);
  });

  it("with nothing on the device it says Loading until the live answer, then saves that answer for next time", () => {
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    expect(allText(t)).toMatch(/Loading/);
    act(() => { live.subs[0].ok({ val: () => ESTATE }); });
    expect(allText(t)).toMatch(/Marathon Till 2/);
    expect(JSON.parse(mem.get(mod.SLIP_TERMINALS_KEY))).toEqual(ESTATE);
  });

  it("the live answer replaces the device copy (a machine moved to another till is followed)", () => {
    mem.set(mod.SLIP_TERMINALS_KEY, JSON.stringify({ OLD1: { label: "Old machine", storeId: "pe", tillId: "till-2" } }));
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    expect(allText(t)).toMatch(/Old machine/);
    act(() => { live.subs[0].ok({ val: () => ESTATE }); });
    expect(allText(t)).toMatch(/Marathon Till 2/);
    expect(allText(t)).not.toMatch(/Old machine/);
  });

  it("ONE subscription, shared: the home prefetch and the screen don't read twice, and leaving keeps it warm", () => {
    const P = () => { mod.usePrefetchSlipTerminals(true); return null; };
    let home;
    act(() => { home = TestRenderer.create(<P />); });
    expect(live.subs.length).toBe(1);
    act(() => { live.subs[0].ok({ val: () => ESTATE }); });
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    expect(live.subs.length).toBe(1);
    expect(allText(t)).toMatch(/Marathon Till 2/);
    act(() => { t.unmount(); home.unmount(); });
    expect(live.subs[0].closed).toBe(false);
  });

  it("the home screen opens it only for an account with a Card Slip scope", () => {
    const P = ({ on }) => { mod.usePrefetchSlipTerminals(on); return null; };
    act(() => { TestRenderer.create(<P on={false} />); });
    expect(live.subs.length).toBe(0);
  });

  it("a refused read with nothing known says 'not set up' rather than loading forever; with a copy, the copy stays", () => {
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    act(() => { live.subs[0].err(new Error("permission_denied")); });
    expect(allText(t)).toMatch(/isn't set up here yet/);
    mod._resetSlipTerminals(); live.subs.length = 0;
    mem.set(mod.SLIP_TERMINALS_KEY, JSON.stringify(ESTATE));
    let u;
    act(() => { u = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    act(() => { live.subs[0].err(new Error("network")); });
    expect(allText(u)).toMatch(/Marathon Till 2/);
  });

  it("drawn from the device copy, the form can be filled but NOT sent until the live registry confirms the till", async () => {
    mem.set(mod.SLIP_TERMINALS_KEY, JSON.stringify(ESTATE));
    let t;
    act(() => { t = TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
    const submit = () => t.root.findAll((n) => n.type === "button" && /^(Submit|Sending…)$/.test(textOf(n)))[0];
    const file = t.root.findAll((n) => n.type === "input" && n.props.type === "file")[0];
    await act(async () => { await file.props.onChange({ target: { files: [{ name: "slip.jpg" }], value: "" } }); });
    // the photo is in (Marathon Till 2 is photo-only): only the live confirmation is missing
    expect(submit().props.disabled).toBe(true);
    expect(allText(t)).toMatch(/Checking your till/);
    act(() => { live.subs[0].ok({ val: () => ESTATE }); });
    expect(submit().props.disabled).toBe(false);
    expect(allText(t)).not.toMatch(/Checking your till/);
  });

  it("a refused read is retried while the screen is open", () => {
    vi.useFakeTimers();
    try {
      act(() => { TestRenderer.create(<CardSlipScreen onExit={() => {}} />); });
      act(() => { live.subs[0].err(new Error("permission_denied")); });
      expect(live.subs.length).toBe(1);
      act(() => { vi.advanceTimersByTime(mod.SLIP_RETRY_MS + 10); });
      expect(live.subs.length).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("a broken device copy is ignored, never thrown", () => {
    mem.set(mod.SLIP_TERMINALS_KEY, "{not json");
    expect(mod.readCachedTerminals()).toBe(null);
    mem.set(mod.SLIP_TERMINALS_KEY, "[1,2]");
    expect(mod.readCachedTerminals()).toBe(null);
  });
});

describe("the home screen wires the prefetch", async () => {
  const { readFileSync } = await import("node:fs");
  it("RoleSelector starts the registry read for a Card Slip account", () => {
    const src = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
    expect(src).toMatch(/usePrefetchSlipTerminals\(hasSlipScope\(homePerm\)\);/);
  });
});

// The per-device, per-day bound on whole-leg downloads. See downloadLedger.js.
import { describe, test, expect } from "vitest";
import {
  createDownloadLedger, LEG_DOWNLOADS_PER_DAY, DOWNLOAD_WINDOW_MS, DOWNLOAD_LEDGER_KEY,
  MirrorDownloadBudgetError,
} from "../downloadLedger";

const T0 = Date.UTC(2026, 10, 10, 8);
function storageOf(m = new Map()) {
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}

describe("the download ledger", () => {
  test("allows LEG_DOWNLOADS_PER_DAY starts per leg and then refuses", () => {
    let t = T0;
    const l = createDownloadLedger({ storage: storageOf(), now: () => t });
    for (let i = 0; i < LEG_DOWNLOADS_PER_DAY; i += 1) { expect(l.consume("products")).toBe(true); t += 1000; }
    expect(l.consume("products")).toBe(false);
    expect(l.remaining("products")).toBe(0);
    expect(l.remaining("stock")).toBe(LEG_DOWNLOADS_PER_DAY);     // per leg, not per device
  });

  test("several starts in the SAME millisecond are several starts", () => {
    const l = createDownloadLedger({ storage: storageOf(), now: () => T0 });
    let n = 0;
    while (l.consume("products") && n < 50) n += 1;
    expect(n).toBe(LEG_DOWNLOADS_PER_DAY);
  });

  test("the window ROLLS: a slot comes back 24 hours after the start that took it", () => {
    let t = T0;
    const l = createDownloadLedger({ storage: storageOf(), now: () => t });
    l.consume("products"); t += 3600_000;
    l.consume("products"); t += 3600_000;
    l.consume("products");
    expect(l.nextAt("products")).toBe(T0 + DOWNLOAD_WINDOW_MS);
    t = T0 + DOWNLOAD_WINDOW_MS - 1;
    expect(l.consume("products")).toBe(false);
    t = T0 + DOWNLOAD_WINDOW_MS;
    expect(l.consume("products")).toBe(true);
    expect(l.consume("products")).toBe(false);
  });

  test("it is shared by every engine on the device and survives a reload", () => {
    const storage = storageOf();
    const now = () => T0;
    createDownloadLedger({ storage, now }).consume("products");
    createDownloadLedger({ storage, now }).consume("products");
    const third = createDownloadLedger({ storage, now });
    expect(third.remaining("products")).toBe(1);
    expect(JSON.parse(storage.m.get(DOWNLOAD_LEDGER_KEY)).products.length).toBe(2);
  });

  test("a storage that throws falls back to memory — still a bound, for this tab", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const l = createDownloadLedger({ storage: broken, now: () => T0 });
    for (let i = 0; i < LEG_DOWNLOADS_PER_DAY; i += 1) expect(l.consume("products")).toBe(true);
    expect(l.consume("products")).toBe(false);
  });

  test("a storage that STOPS accepting writes still counts the start it could not write down", () => {
    const m = new Map();
    let full = false;
    const storage = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { if (full) throw new Error("QuotaExceeded"); m.set(k, String(v)); },
    };
    const l = createDownloadLedger({ storage, now: () => T0 });
    l.consume("products");
    full = true;
    l.consume("products");
    l.consume("products");
    expect(l.consume("products")).toBe(false);
  });

  test("garbage in storage is an empty ledger, not a crash", () => {
    const storage = storageOf(new Map([[DOWNLOAD_LEDGER_KEY, "{not json"]]));
    const l = createDownloadLedger({ storage, now: () => T0 });
    expect(l.remaining("products")).toBe(LEG_DOWNLOADS_PER_DAY);
    expect(l.consume("products")).toBe(true);
  });

  test("a start stamped in the future (a clock that was wrong) does not hold its slot for ever", () => {
    const storage = storageOf(new Map([[DOWNLOAD_LEDGER_KEY, JSON.stringify({ products: [T0 + 400 * 86400_000] })]]));
    let t = T0;
    const l = createDownloadLedger({ storage, now: () => t });
    expect(l.remaining("products")).toBe(LEG_DOWNLOADS_PER_DAY - 1);
    t = T0 + DOWNLOAD_WINDOW_MS;
    expect(l.remaining("products")).toBe(LEG_DOWNLOADS_PER_DAY - 1);   // counted from when it was first SEEN as now…
    l.consume("products");
    t = T0 + 2 * DOWNLOAD_WINDOW_MS + 1;
    expect(l.remaining("products")).toBe(LEG_DOWNLOADS_PER_DAY);       // …and gone a day after it was rewritten
  });

  test("the ledger does not grow: old starts are pruned on every write", () => {
    const storage = storageOf();
    let t = T0;
    const l = createDownloadLedger({ storage, now: () => t });
    for (let d = 0; d < 30; d += 1) { l.consume("products"); l.consume(`leg${d}`); t += DOWNLOAD_WINDOW_MS + 1; }
    const held = JSON.parse(storage.m.get(DOWNLOAD_LEDGER_KEY));
    expect(Object.keys(held).length).toBeLessThanOrEqual(2);
  });

  test("the refusal names the leg and when it may be tried again", () => {
    const err = new MirrorDownloadBudgetError("products", { max: 3, windowMs: DOWNLOAD_WINDOW_MS, nextAt: T0 });
    expect(err.name).toBe("MirrorDownloadBudgetError");
    expect(err.message).toContain("\"products\"");
    expect(err.message).toContain(new Date(T0).toISOString());
  });
});

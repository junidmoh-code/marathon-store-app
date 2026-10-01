// ─── STOCK AUDIT WRITERS — one outcome, and it moves no stock ────────────────
// The three answers on the hub tab and four on the shop tab are gone, and with
// them the adjustment that wrote /stock. What is asserted here is what remains:
// a check is recorded, the rotation is stamped, and NOTHING calls the stock
// writer — because correcting a quantity is the Adjust screen's job and having
// two writers for one act was the problem.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const state = { updates: [] };

vi.mock("../../firebase", () => ({ database: { fake: true }, auth: { currentUser: { uid: "u9" } } }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path ?? "" }),
  update: async (_r, upd) => { state.updates.push(upd); },
}));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => Date.parse("2026-09-07T09:00:00.000Z") }));

const store = await import("./stockAuditStore.js");
const NOW = Date.parse("2026-09-07T09:00:00.000Z");
const HUB_RESULTS = "settings/stockAudit/hub/hub1/results/2026-09-07";
const RESULTS = "settings/stockAudit/marathon-pe/results/2026-09-07";
const ROTATION = "settings/stockAudit/rotation/marathon-pe";

const HUB_ROW = { k: "p1__9__hub1", p: "p1", n: "AF1", s: "9", sk: "9", w: "hub1", q: 3, r: "out_of_stock", c: 2 };
const ROT_ROW = { p: "p2", n: "Tee", slow: false, z: [{ s: "S", sk: "S", q: 2 }, { s: "M", sk: "M", q: 3 }] };

beforeEach(() => { state.updates = []; });

describe("the hub tab", () => {
  it("records the check, and what the person was looking at when they made it", async () => {
    const res = await store.markHubRowFixed({ hub: "hub1", row: HUB_ROW });
    expect(res).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0][`${HUB_RESULTS}/p1__9__hub1`]).toEqual({
      outcome: "fixed", at: NOW, by: "u9",
      productId: "p1", sizeKey: "9", where: "hub1",
      // the believed quantity is the only record of what they were shown; the
      // cell itself will have moved on by the time anyone reads this back
      believed: 3, answer: "out_of_stock",
    });
  });

  it("refuses a row it cannot key, rather than writing a junk path", async () => {
    for (const bad of [null, undefined, {}, { p: "p1" }]) {
      expect((await store.markHubRowFixed({ hub: "hub1", row: bad })).ok).toBe(false);
    }
    expect(state.updates).toHaveLength(0);
  });
});

describe("the shop tab", () => {
  it("stamps the rotation AND the day, in one update", async () => {
    const res = await store.markRotationRowFixed({ store: "marathon-pe", row: ROT_ROW });
    expect(res).toEqual({ ok: true });
    // ONE update: a stamped product can never be missing from the day's
    // results, or the reverse.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0][`${ROTATION}/p2`]).toEqual({ at: NOW, o: "fixed", by: "u9" });
    expect(state.updates[0][`${RESULTS}/p2`]).toEqual({ outcome: "fixed", at: NOW, by: "u9", productId: "p2" });
  });

  it("the stamp is what sends the product to the back of the rotation", async () => {
    await store.markRotationRowFixed({ store: "marathon-pe", row: ROT_ROW });
    const stamp = state.updates[0][`${ROTATION}/p2`];
    // selectRotationBatch orders on `at`, ascending, never-checked first — so a
    // stamp that is present and positive is the whole contract.
    expect(typeof stamp.at).toBe("number");
    expect(stamp.at).toBeGreaterThan(0);
  });

  it("refuses a row with no product", async () => {
    expect((await store.markRotationRowFixed({ store: "marathon-pe", row: {} })).ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });
});

describe("nothing here writes stock", () => {
  it("the module does not import the stock writer at all", () => {
    // Not a mock assertion — a mock proves only that this test did not call it.
    // The source is the witness: an audit that also moved stock was a second
    // writer for one act, with its own idea of what the shelf held.
    const src = readFileSync(new URL("./stockAuditStore.js", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .*?from ["'](.+?)["']/gm)].map((m) => m[1]);
    expect(imports).not.toContain("./applyMovement");
    expect(imports.some((i) => i.includes("sizeKey"))).toBe(false);
    expect(src).not.toMatch(/\bapplyMovement\s*\(/);
    expect(src).not.toMatch(/stockCellPath\s*\(/);
  });

  it("and every write it does make lands under /settings/stockAudit", async () => {
    await store.markHubRowFixed({ hub: "hub1", row: HUB_ROW });
    await store.markRotationRowFixed({ store: "marathon-pe", row: ROT_ROW });
    const paths = state.updates.flatMap((u) => Object.keys(u));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith("settings/stockAudit/")).toBe(true);
  });
});

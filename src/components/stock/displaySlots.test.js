// ─── DISPLAY SLOTS — pure-helper behaviour pins ──────────────────────────────
// The count reads the slot's CURRENT state: these tests pin that a display
// changing size mid-count moves the off-shelf unit to the NEW size's cell with
// no re-walk of the floor, and that cleared slots stop counting entirely.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("firebase/database", () => ({
  ref: vi.fn(), child: vi.fn(), get: vi.fn(), update: vi.fn(), runTransaction: vi.fn(),
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1" } } }));
vi.mock("../../utils/serverTime", () => ({
  serverNowIso: vi.fn(() => "2026-08-12T12:00:00.000Z"),
  serverNowMs: vi.fn(() => Date.parse("2026-08-12T12:00:00.000Z")),
}));

const { slotIsLive, slotsForCell, liveSlotsForProduct } = await import("./displaySlots");

const liveSlot = (over = {}) => ({
  productId: "p1", productName: "Air Force 1", size: "6", sizeKey: "6",
  bookedHub: "hub1", source: "registration", at: "2026-08-12T08:00:00.000Z", by: "u1",
  ...over,
});

describe("slotIsLive", () => {
  it("live only when a real size is on the floor", () => {
    expect(slotIsLive(liveSlot())).toBe(true);
    expect(slotIsLive(liveSlot({ sizeKey: null, size: null }))).toBe(false);  // cleared tombstone
    expect(slotIsLive(liveSlot({ sizeKey: "_" }))).toBe(false);               // one-size sentinel is never a display
    expect(slotIsLive(null)).toBe(false);
  });
});

describe("slotsForCell — the count's off-shelf source", () => {
  const slots = {
    "marathon-pe": { p1: liveSlot() },
    trophy: { p1: liveSlot({ sizeKey: "8", size: "8" }), p2: liveSlot({ productId: "p2", bookedHub: "hub2" }) },
  };

  it("matches hub + product + size exactly", () => {
    expect(slotsForCell(slots, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(1);
    expect(slotsForCell(slots, { hub: "hub1", productId: "p1", sizeKey: "8" })).toHaveLength(1);
    expect(slotsForCell(slots, { hub: "hub2", productId: "p1", sizeKey: "6" })).toHaveLength(0); // other hub's books
    expect(slotsForCell(slots, { hub: "hub1", productId: "p2", sizeKey: "6" })).toHaveLength(0); // booked at hub2
  });

  it("a display that CHANGES SIZE mid-count is read at its current size", () => {
    // Size 6 sold at PE, size 7 replaced it: the slot now says 7.
    const after = { "marathon-pe": { p1: liveSlot({ sizeKey: "7", size: "7" }) } };
    expect(slotsForCell(after, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(0);
    expect(slotsForCell(after, { hub: "hub1", productId: "p1", sizeKey: "7" })).toHaveLength(1);
  });

  it("a cleared slot (display sold, nothing out) counts nowhere", () => {
    const cleared = { "marathon-pe": { p1: liveSlot({ sizeKey: null, size: null, source: "display_sold" }) } };
    expect(slotsForCell(cleared, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(0);
  });

  it("two stores can each hold one display of the same product+size", () => {
    const both = {
      "marathon-pe": { p1: liveSlot() },
      trophy: { p1: liveSlot() },
    };
    expect(slotsForCell(both, { hub: "hub1", productId: "p1", sizeKey: "6" })).toHaveLength(2);
  });
});

describe("liveSlotsForProduct", () => {
  it("lists every live slot for the product at the hub, any size", () => {
    const slots = {
      "marathon-pe": { p1: liveSlot({ sizeKey: "6" }) },
      trophy: { p1: liveSlot({ sizeKey: "9", size: "9" }) },
    };
    const out = liveSlotsForProduct(slots, { hub: "hub1", productId: "p1" });
    expect(out.map((s) => s.slot.sizeKey).sort()).toEqual(["6", "9"]);
  });
});

// ─── THE STALENESS FENCE (CodeRabbit, PR #347) ───────────────────────────────
// Writers carry the instant they were INITIATED; a slot transition NEWER than
// that instant wins, so a clear delayed on bad wifi can never erase the
// replacement that landed while it was in flight — and vice versa.
describe("slot write fence — fresh truth always wins", () => {
  let store;
  beforeEach(async () => {
    store = {};
    const db = await import("firebase/database");
    db.runTransaction.mockImplementation(async (node, fn) => {
      const cur = store[node.path] ?? null;
      const next = fn(cur);
      if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
      store[node.path] = next;
      return { committed: true, snapshot: { val: () => next } };
    });
    db.ref.mockImplementation((_db, path) => ({ path }));
  });

  it("a DELAYED clear does not erase a replacement that landed after it was initiated", async () => {
    const { setDisplaySlot, clearDisplaySlot } = await import("./displaySlots");
    const st = await import("../../utils/serverTime");
    // The replacement lands at 12:05…
    st.serverNowIso.mockReturnValue("2026-08-12T12:05:00.000Z");
    await setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "7", bookedHub: "hub1", source: "display_refill" });
    // …then a clear INITIATED at 12:00 finally arrives off a bad connection.
    st.serverNowIso.mockReturnValue("2026-08-12T12:00:00.000Z");
    const res = await clearDisplaySlot({ store: "marathon-pe", productId: "p1", source: "display_sold" });
    expect(res.noop).toBe(true);
    expect(store["settings/displaySlots/marathon-pe/p1"].sizeKey).toBe("7");   // replacement survives
  });

  it("a DELAYED refill write does not resurrect a slot a later sale cleared", async () => {
    const { setDisplaySlot, clearDisplaySlot } = await import("./displaySlots");
    const st = await import("../../utils/serverTime");
    st.serverNowIso.mockReturnValue("2026-08-12T12:00:00.000Z");
    await setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "6", bookedHub: "hub1", source: "registration" });
    st.serverNowIso.mockReturnValue("2026-08-12T12:10:00.000Z");
    await clearDisplaySlot({ store: "marathon-pe", productId: "p1", source: "display_sold" });
    // A refill write initiated at 12:03 arrives late:
    st.serverNowIso.mockReturnValue("2026-08-12T12:03:00.000Z");
    const res = await setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1", source: "display_refill" });
    expect(res.superseded).toBe(true);
    expect(store["settings/displaySlots/marathon-pe/p1"].sizeKey).toBeNull();  // stays cleared
  });

  it("in-order writes still apply normally", async () => {
    const { setDisplaySlot, clearDisplaySlot } = await import("./displaySlots");
    const st = await import("../../utils/serverTime");
    st.serverNowIso.mockReturnValue("2026-08-12T12:00:00.000Z");
    await setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "6", bookedHub: "hub1", source: "registration" });
    st.serverNowIso.mockReturnValue("2026-08-12T12:10:00.000Z");
    await clearDisplaySlot({ store: "marathon-pe", productId: "p1" });
    expect(store["settings/displaySlots/marathon-pe/p1"].sizeKey).toBeNull();
    st.serverNowIso.mockReturnValue("2026-08-12T12:20:00.000Z");
    await setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "9", bookedHub: "hub1", source: "display_refill" });
    expect(store["settings/displaySlots/marathon-pe/p1"].sizeKey).toBe("9");
  });
});

// ─── THE TRANSITION'S OWN INSTANT, AND WHO WINS A TIE ────────────────────────
// The staleness fence decides which of two writes for the same slot stands.
// Two properties matter and both were review findings:
//   • a caller who KNOWS the transition's instant passes `at`, so the write is
//     judged at the moment the thing happened rather than the moment the
//     network got round to it (a sale clear fires after `await writeOrder`);
//   • a STAND-IN write — displayPairCore's repair of a dropped write — passes
//     loseTies, because between the snapshot it decided on and this
//     transaction, a real write stamped the same millisecond may have landed.
describe("the staleness fence: `at` and `loseTies`", () => {
  let runTransaction, committedValue;
  beforeEach(async () => {
    const db = await import("firebase/database");
    runTransaction = db.runTransaction;
    committedValue = undefined;
  });

  // Drive the real updater the writers hand to runTransaction against a
  // given stored record, and report what it decided.
  const decide = async (call, current) => {
    let updater = null;
    runTransaction.mockImplementation((_ref, fn) => {
      updater = fn;
      const next = fn(current);
      committedValue = next;
      return Promise.resolve({ committed: next !== undefined, snapshot: { val: () => current } });
    });
    const res = await call();
    return { res, next: committedValue, updater };
  };

  const stored = (at, over = {}) => ({ productId: "p1", size: "6", sizeKey: "6", bookedHub: "hub1", at, ...over });

  it("`at` is the instant judged AND the instant stamped — not the call time", async () => {
    const { setDisplaySlot } = await import("./displaySlots");
    const { next } = await decide(
      () => setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1",
                             source: "display_refill", at: "2026-08-12T09:00:00.000Z" }),
      stored("2026-08-12T08:00:00.000Z"));
    expect(next.at).toBe("2026-08-12T09:00:00.000Z");     // not the mocked "now" of 12:00
    expect(next.sizeKey).toBe("8");
  });

  it("omitting `at` keeps the old behaviour exactly — stamped now", async () => {
    const { setDisplaySlot } = await import("./displaySlots");
    const { next } = await decide(
      () => setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1", source: "display_refill" }),
      stored("2026-08-12T08:00:00.000Z"));
    // whatever serverNowIso currently answers — the point is that it is used
    const { serverNowIso } = await import("../../utils/serverTime");
    expect(next.at).toBe(serverNowIso());
  });

  it("a STRICTLY newer record always wins, `at` given or not", async () => {
    const { setDisplaySlot } = await import("./displaySlots");
    const { next, res } = await decide(
      () => setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1",
                             source: "display_refill", at: "2026-08-12T09:00:00.000Z" }),
      stored("2026-08-12T10:00:00.000Z"));
    expect(next).toBeUndefined();                          // aborted
    expect(res).toEqual({ ok: true, superseded: true });
  });

  it("AN AUTHOR WINS A TIE; a stand-in with loseTies does NOT", async () => {
    const { setDisplaySlot } = await import("./displaySlots");
    const T = "2026-08-12T09:00:00.000Z";
    // The author: its own newer intent, stamped the same millisecond.
    const author = await decide(
      () => setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1", source: "display_refill", at: T }),
      stored(T));
    expect(author.next).toBeDefined();
    expect(author.next.sizeKey).toBe("8");
    // The stand-in: a real write may have landed at T since its snapshot.
    const standIn = await decide(
      () => setDisplaySlot({ store: "marathon-pe", productId: "p1", size: "8", bookedHub: "hub1",
                             source: "display_refill", at: T, loseTies: true }),
      stored(T));
    expect(standIn.next).toBeUndefined();
    expect(standIn.res).toEqual({ ok: true, superseded: true });
  });

  it("and the same for a CLEAR — a repair may not tombstone a replacement stamped the same instant", async () => {
    const { clearDisplaySlot } = await import("./displaySlots");
    const T = "2026-08-12T09:00:00.000Z";
    const standIn = await decide(
      () => clearDisplaySlot({ store: "marathon-pe", productId: "p1", source: "display_sold", at: T, loseTies: true }),
      stored(T, { size: "8", sizeKey: "8", source: "display_refill" }));
    expect(standIn.next).toBeUndefined();                  // the replacement stands
    const author = await decide(
      () => clearDisplaySlot({ store: "marathon-pe", productId: "p1", source: "display_sold", at: T }),
      stored(T, { size: "8", sizeKey: "8", source: "display_refill" }));
    expect(author.next.sizeKey).toBeNull();
    expect(author.next.prevSize).toBe("8");
  });

  it("clearing an already-cleared record is still a quiet no-op, ties or not", async () => {
    const { clearDisplaySlot } = await import("./displaySlots");
    const { next, res } = await decide(
      () => clearDisplaySlot({ store: "marathon-pe", productId: "p1", at: "2026-08-12T09:00:00.000Z", loseTies: true }),
      stored("2026-08-12T08:00:00.000Z", { size: null, sizeKey: null }));
    expect(next).toBeUndefined();
    expect(res).toEqual({ ok: true, noop: true });
  });
});

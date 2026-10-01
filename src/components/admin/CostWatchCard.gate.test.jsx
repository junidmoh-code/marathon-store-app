// ─── COST WATCH — THE GATE, AND THE PROMISE THAT IT IS CHEAP ─────────────────
//
// Two things are pinned here, and both of them would otherwise be held up by a
// comment alone.
//
//   1. A refused viewer reads NOTHING. Asserted on `get`, not on what rendered:
//      a card that renders "not for you" while still having fetched the cost
//      breakdown has leaked it. The component gate is tested on its own, with
//      the route gate bypassed, because each layer must refuse independently.
//
//   2. The card reads THREE small nodes by exact path and opens NO live
//      subscription. This is a card about the cost of reading the database.
//      `onValue` on /cost_watch/daily would re-download both days every time
//      the watcher republishes — every ten minutes, for as long as the card is
//      open — and the card would become a line item in the report it displays.
//      That regression would be invisible in review and obvious in the bill,
//      so it fails here instead.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  location: { hash: "#admin/cost" },
  isSecureContext: true,
  scrollY: 0,
  scrollTo() {},
  requestAnimationFrame(fn) { fn(); },
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());
// navigator is a getter-only global in this runtime, so it cannot be
// assigned. The card only touches it inside the copy handler, which these
// tests never invoke.

const getMock = vi.fn(async () => ({ exists: () => false, val: () => null }));
const onValueMock = vi.fn(() => () => {});

vi.mock("firebase/database", () => ({
  getDatabase: () => ({ fake: true }),
  ref: (_db, path) => ({ path: path || "" }),
  get: (...args) => getMock(...args),
  onValue: (...args) => onValueMock(...args),
}));
vi.mock("../PermissionsContext", () => ({ ADMIN_EMAIL: "gunidmoh@gmail.com" }));

const CostWatchCard = (await import("./CostWatchCard.jsx")).default;

const ADMIN = { uid: "admin-uid", email: "gunidmoh@gmail.com" };
const STAFF = { uid: "staff-uid", email: "rashid@marathon.internal" };

async function render(authUser) {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<CostWatchCard authUser={authUser} onExit={() => {}} />);
  });
  return tree;
}

describe("CostWatchCard gate", () => {
  beforeEach(() => { getMock.mockClear(); onValueMock.mockClear(); });

  it("reads nothing at all for a viewer who is not the owner", async () => {
    await render(STAFF);
    expect(getMock).not.toHaveBeenCalled();
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("reads nothing for a signed-out viewer", async () => {
    await render(null);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("is not fooled by an address that merely contains the owner's", async () => {
    for (const email of ["gunidmoh@gmail.com.evil.com", "gunidmoh@gmail.co", " gunidmoh@gmail.com", "x-gunidmoh@gmail.com"]) {
      getMock.mockClear();
      await render({ uid: "u", email });
      expect(getMock, `"${email}" must not be admitted`).not.toHaveBeenCalled();
    }
  });

  it("compares the address strictly, like every other gate and like the rule", async () => {
    // Deliberately NOT case-insensitive. Every other ADMIN_EMAIL gate in this
    // app compares strictly, and so does the RTDB rule that actually enforces
    // the read. A card that admitted "GUNIDMOH@Gmail.com" would then be
    // refused by the database, turning a clean "not for you" into a
    // PERMISSION_DENIED nobody can explain.
    await render({ uid: "admin-uid", email: "GUNIDMOH@Gmail.com" });
    expect(getMock).not.toHaveBeenCalled();
    getMock.mockClear();
    await render(ADMIN);
    expect(getMock).toHaveBeenCalled();
  });

  it("a subscription-triggered reload does not re-read the suggestions", async () => {
    // The suggestions change when a day's totals change, not on every rollup
    // tick. Re-reading them every ten minutes for as long as the card is open
    // is exactly the kind of quiet waste this card exists to find.
    await render(ADMIN);
    getMock.mockClear();
    const cb = onValueMock.mock.calls[0][1];
    await act(async () => { cb({ exists: () => true, val: () => ({ n: 1 }) }); }); // first: skipped
    await act(async () => { cb({ exists: () => true, val: () => ({ n: 2 }) }); }); // second: reloads
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths).not.toContain("cost_watch/suggestions");
    expect(paths.filter((p) => p.startsWith("cost_watch/daily/"))).toHaveLength(2);
  });

  it("reads exactly three cost_watch nodes, by exact path, for the owner", async () => {
    await render(ADMIN);
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths).toHaveLength(3);
    expect(paths.filter((p) => p.startsWith("cost_watch/daily/"))).toHaveLength(2);
    expect(paths).toContain("cost_watch/suggestions");
    // Every path is a leaf the watcher writes. A path ending in the collection
    // rather than a document would download every day ever recorded.
    for (const p of paths) expect(p).not.toMatch(/cost_watch\/daily\/?$/);
  });

  it("subscribes to exactly one node, and it is the smallest one", async () => {
    // The card is live, and it must stay cheap while being live. Exactly one
    // subscription, on /cost_watch/latest — a handful of fields. Subscribing
    // to a daily node instead would re-stream a whole day summary on every
    // rollup, every ten minutes, for as long as the card is left open, and a
    // card about the cost of reading the database would become a line in its
    // own report. That regression is invisible in review and obvious in the
    // bill, so it fails here.
    await render(ADMIN);
    expect(onValueMock).toHaveBeenCalledTimes(1);
    expect(onValueMock.mock.calls[0][0].path).toBe("cost_watch/latest");
  });

  it("never subscribes to a daily or hourly node", async () => {
    await render(ADMIN);
    for (const call of onValueMock.mock.calls) {
      expect(call[0].path).not.toMatch(/cost_watch\/(daily|hourly)/);
    }
  });

  it("opens no subscription at all for a viewer who is not the owner", async () => {
    await render(STAFF);
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("never reads the per-hour detail, which carries the full tables", async () => {
    await render(ADMIN);
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths.some((p) => p.includes("cost_watch/hourly"))).toBe(false);
  });
});

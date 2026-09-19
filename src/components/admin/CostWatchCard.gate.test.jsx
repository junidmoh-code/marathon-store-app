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

  it("admits the owner regardless of the case of the address", async () => {
    await render({ uid: "admin-uid", email: "GUNIDMOH@Gmail.com" });
    expect(getMock).toHaveBeenCalled();
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

  it("never opens a live subscription — this card must not cost anything to leave open", async () => {
    await render(ADMIN);
    expect(onValueMock).not.toHaveBeenCalled();
  });

  it("never reads the per-hour detail, which carries the full tables", async () => {
    await render(ADMIN);
    const paths = getMock.mock.calls.map((c) => c[0].path);
    expect(paths.some((p) => p.includes("cost_watch/hourly"))).toBe(false);
  });
});

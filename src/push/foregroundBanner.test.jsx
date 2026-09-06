// ─── SWITCHING PUSH OFF TAKES THE BANNER WITH IT ─────────────────────────────
// A banner left on screen after the feature that produced it was switched off
// reads as a broken switch: the user turns alerts off, the alert is still
// there, and they conclude the tap did nothing.
//
// Rendered through react-test-renderer like every other component test here —
// no new test dependency for one hook.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// The hook dynamically imports firebase/messaging; stub it so no SDK, no
// network and no service worker are involved.
const handlers = [];
vi.mock("firebase/messaging", () => ({
  isSupported: async () => true,
  getMessaging: () => ({}),
  onMessage: (_m, fn) => { handlers.push(fn); return () => {}; },
}));
vi.mock("./chime", () => ({ armAudioUnlock: () => {}, playChime: () => true }));

// vitest's default environment is node, where the hook's `typeof window` guard
// would bail before the listener ever attaches. The hook needs only these two.
globalThis.window = globalThis.window || {};
// node 22 defines navigator as a getter-only global, so it is redefined rather
// than assigned.
if (!("serviceWorker" in (globalThis.navigator || {}))) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker: { addEventListener: () => {}, removeEventListener: () => {} } },
  });
}

import { useForegroundPush } from "./useForegroundPush";

function Harness({ enabled, onState }) {
  const push = useForegroundPush({ enabled });
  onState(push);
  return null;
}

// The hook attaches its listener after a DYNAMIC import resolves, and the very
// first import of a module takes more turns of the microtask queue than the
// cached ones that follow. Waiting for the listener rather than for a fixed
// number of turns makes the first test in the file behave like the rest.
async function settle() {
  for (let i = 0; i < 50 && handlers.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

const MESSAGE = {
  data: {
    kind: "order", title: "Marathon PE — new order", body: "#005 · Nike Air Max 90 · size 6",
    sentAt: "1", tag: "order-marathon-pe",
  },
};

describe("useForegroundPush", () => {
  beforeEach(() => { handlers.length = 0; });

  it("shows a banner for an order message, then clears it when push is switched off", async () => {
    let latest = null;
    const onState = (p) => { latest = p; };
    let tree;
    await act(async () => {
      tree = TestRenderer.create(<Harness enabled onState={onState} />);
    });
    await settle();
    expect(handlers.length).toBeGreaterThan(0);

    await act(async () => { handlers[0](MESSAGE); });
    expect(latest.banner).not.toBe(null);
    expect(latest.banner.title).toBe("Marathon PE — new order");

    await act(async () => { tree.update(<Harness enabled={false} onState={onState} />); });
    expect(latest.banner).toBe(null);
  });

  it("never fires twice for the same message — a reconnect or a StrictMode remount is not a second alert", async () => {
    let latest = null;
    const onState = (p) => { latest = p; };
    await act(async () => { TestRenderer.create(<Harness enabled onState={onState} />); });
    await settle();

    await act(async () => { handlers[0](MESSAGE); });
    await act(async () => { latest.dismiss(); });
    expect(latest.banner).toBe(null);

    // The SAME message again: same tag, same sentAt.
    await act(async () => { handlers[0](MESSAGE); });
    expect(latest.banner).toBe(null);
  });

  it("ignores a message that is not an order", async () => {
    let latest = null;
    const onState = (p) => { latest = p; };
    await act(async () => { TestRenderer.create(<Harness enabled onState={onState} />); });
    await settle();
    await act(async () => { handlers[0]({ data: { kind: "something-else", title: "x", sentAt: "2" } }); });
    expect(latest.banner).toBe(null);
  });
});

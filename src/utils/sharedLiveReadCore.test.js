// ─── ONE LISTENER PER PATH, KEPT ACROSS A SCREEN SWITCH — PROVED AS A COUNT ──
//
// The saving is the number of times a listener is OPENED, because opening one
// is what downloads the node. So these tests count opens (and closes) against
// a fake `listen`, and drive time by hand.
import { describe, it, expect, beforeEach } from "vitest";
import { createSharedLiveReads, LINGER_MS } from "./sharedLiveReadCore";

/** A fake onValue: records every open and close, and lets a test push data. */
function makeServer() {
  const open = new Map();   // target -> { onSnap, onErr }
  const log = { opens: [], closes: [] };
  const listen = (target, onSnap, onErr) => {
    log.opens.push(target);
    const handle = { onSnap, onErr };
    open.set(target, handle);
    return () => { log.closes.push(target); if (open.get(target) === handle) open.delete(target); };
  };
  return {
    listen, log, open,
    push: (target, value) => open.get(target).onSnap({ val: () => value }),
    cancel: (target, err = new Error("permission_denied")) => {
      const h = open.get(target); open.delete(target); h.onErr(err);
    },
  };
}

/** Timers by hand. */
function makeClock() {
  let now = 0; let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    advance: (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

let server; let clock; let shared;
beforeEach(() => {
  server = makeServer();
  clock = makeClock();
  shared = createSharedLiveReads({ listen: server.listen, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});
const sub = (key, seen, errs) => shared.subscribe(key, () => key, (s) => seen.push(s.val()), errs ? (e) => errs.push(e) : undefined);

describe("sharing", () => {
  it("two subscribers to one path open ONE listener and both get every value", () => {
    const a = []; const b = [];
    sub("refills", a); sub("refills", b);
    expect(server.log.opens).toEqual(["refills"]);
    server.push("refills", { r1: 1 });
    server.push("refills", { r1: 2 });
    expect(a).toEqual([{ r1: 1 }, { r1: 2 }]);
    expect(b).toEqual([{ r1: 1 }, { r1: 2 }]);
  });

  it("a subscriber that arrives late is handed the value already held, at once", () => {
    const a = []; const b = [];
    sub("refills", a);
    server.push("refills", { r1: 1 });
    sub("refills", b);
    expect(b).toEqual([{ r1: 1 }]);
    expect(server.log.opens).toHaveLength(1);
  });

  it("a late subscriber before the first answer is NOT handed an empty value", () => {
    const a = []; const b = [];
    sub("refills", a); sub("refills", b);
    expect(a).toEqual([]); expect(b).toEqual([]);
  });

  it("different keys never share — a scoped query is not the whole node", () => {
    const whole = []; const scoped = [];
    sub("orders", whole); sub("orders?destShop=pe", scoped);
    expect(server.log.opens).toEqual(["orders", "orders?destShop=pe"]);
    server.push("orders?destShop=pe", { o1: 1 });
    expect(whole).toEqual([]);
    expect(scoped).toEqual([{ o1: 1 }]);
  });

  it("one subscriber leaving does not close the listener the other is using", () => {
    const a = []; const b = [];
    const offA = sub("refills", a); sub("refills", b);
    offA();
    expect(server.log.closes).toEqual([]);
    server.push("refills", 7);
    expect(a).toEqual([]); expect(b).toEqual([7]);
  });
});

describe("the screen switch — the measured cost", () => {
  it("unmount then mount inside the linger opens NOTHING and shows the held value", () => {
    const first = []; const second = [];
    const off = sub("refills", first);
    server.push("refills", { r1: 1 });
    off();                                  // leave the Refill screen
    expect(server.log.closes).toEqual([]);  // …the listener is kept
    clock.advance(4 * 60 * 1000);           // four minutes on another screen
    server.push("refills", { r1: 2 });      // changes keep arriving meanwhile
    sub("refills", second);                 // open Health, which reads the same node
    expect(server.log.opens).toEqual(["refills"]);   // ONE download, not two
    expect(second).toEqual([{ r1: 2 }]);    // and the CURRENT value, not the one left behind
  });

  it("28 screen switches in a row open the listener once", () => {
    for (let i = 0; i < 28; i += 1) {
      const off = sub("refills", []);
      if (i === 0) server.push("refills", {});
      off();
      clock.advance(60 * 1000);
    }
    expect(server.log.opens).toHaveLength(1);
  });

  it("past the linger the listener IS closed, and the next mount opens a fresh one", () => {
    const off = sub("refills", []);
    server.push("refills", { r1: 1 });
    off();
    clock.advance(LINGER_MS - 1);
    expect(server.log.closes).toEqual([]);
    clock.advance(1);
    expect(server.log.closes).toEqual(["refills"]);
    const again = [];
    sub("refills", again);
    expect(server.log.opens).toHaveLength(2);
    // Nothing stale is handed over: the dropped value went with the listener.
    expect(again).toEqual([]);
  });

  it("coming back cancels the pending close", () => {
    const off = sub("refills", []);
    off();
    clock.advance(LINGER_MS - 1000);
    const off2 = sub("refills", []);
    clock.advance(5000);
    expect(server.log.closes).toEqual([]);
    off2();
    clock.advance(LINGER_MS);
    expect(server.log.closes).toEqual(["refills"]);
  });

  it("with lingerMs 0 it behaves exactly like a bare onValue: closed on the last unsubscribe", () => {
    const plain = createSharedLiveReads({ listen: server.listen, lingerMs: 0, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const off = plain.subscribe("stock/hub1", () => "stock/hub1", () => {});
    off();
    expect(server.log.closes).toEqual(["stock/hub1"]);
    expect(clock.pending()).toBe(0);
    plain.subscribe("stock/hub1", () => "stock/hub1", () => {});
    expect(server.log.opens).toHaveLength(2);
  });

  it("unsubscribing twice is harmless", () => {
    const off = sub("refills", []); const b = [];
    sub("refills", b);
    off(); off();
    server.push("refills", 1);
    expect(b).toEqual([1]);
    expect(server.log.closes).toEqual([]);
  });
});

describe("what is never kept", () => {
  it("a hidden page releases every listener nobody is subscribed to — and only those", () => {
    const off = sub("refills", []);
    const inUse = [];
    sub("stock/hub2", inUse);
    off();
    shared.releaseIdle();
    expect(server.log.closes).toEqual(["refills"]);
    server.push("stock/hub2", 3);
    expect(inUse).toEqual([3]);
    expect(clock.pending()).toBe(0);
  });

  it("an identity change drops idle listeners now and stops the rest lingering", () => {
    const offIdle = sub("customers", []);
    server.push("customers", { secret: 1 });
    offIdle();
    const offBusy = sub("orders?destShop=pe", []);
    server.push("orders?destShop=pe", { o: 1 });
    shared.identityChanged();
    expect(server.log.closes).toEqual(["customers"]);
    // The next person's screen is not handed the last person's customers.
    const next = [];
    sub("customers", next);
    expect(next).toEqual([]);
    expect(server.log.opens.filter((t) => t === "customers")).toHaveLength(2);
    // The one still on screen carries on, but is closed the moment it is left.
    offBusy();
    expect(server.log.closes).toContain("orders?destShop=pe");
  });

  it("a listener the server cancelled reports the error, caches nothing, and the next mount retries", () => {
    const seen = []; const errs = [];
    const off = sub("laybys", seen, errs);
    server.push("laybys", { l1: 1 });
    server.cancel("laybys");
    expect(errs).toHaveLength(1);
    off();
    expect(clock.pending()).toBe(0);         // a dead listener does not linger
    const again = [];
    sub("laybys", again);
    expect(again).toEqual([]);               // not the value from before the refusal
    expect(server.log.opens).toHaveLength(2);
  });

  it("a second subscriber to a cancelled listener reopens it for everyone still mounted", () => {
    const a = []; const b = [];
    sub("laybys", a, []);
    server.cancel("laybys");
    sub("laybys", b, []);
    expect(server.log.opens).toHaveLength(2);
    server.push("laybys", 5);
    expect(a).toEqual([5]); expect(b).toEqual([5]);
  });

  it("an error with no error handler does not throw", () => {
    sub("laybys", []);
    expect(() => server.cancel("laybys")).not.toThrow();
  });
});

describe("guards", () => {
  it("refuses to be built without a listen function", () => {
    expect(() => createSharedLiveReads({})).toThrow();
  });
  it("reset closes everything", () => {
    sub("a", []); const off = sub("b", []); off();
    shared.reset();
    expect(server.log.closes.sort()).toEqual(["a", "b"]);
    expect(shared.stats()).toEqual({ listeners: 0, idle: 0, keys: [] });
  });
  it("the linger is ten minutes", () => { expect(LINGER_MS).toBe(600000); });
});

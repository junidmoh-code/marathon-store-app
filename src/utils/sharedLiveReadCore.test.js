// ─── ONE LISTENER PER PATH, KEPT ACROSS A SCREEN SWITCH — PROVED AS A COUNT ──
//
// The saving is the number of times a listener is OPENED, because opening one
// is what downloads the node. So these tests count opens (and closes) against
// a fake `listen`, and drive time by hand.
import { describe, it, expect, beforeEach } from "vitest";
import { createSharedLiveReads, LINGER_MS, MAX_IDLE_HEAVY, MAX_IDLE_BYTES, HEAVY_BYTES } from "./sharedLiveReadCore";

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

  it("after a refusal and a retry, nobody is handed anything until the NEW listener answers", () => {
    const a = []; const b = []; const c = [];
    sub("laybys", a, []);
    server.push("laybys", { before: 1 });
    server.cancel("laybys");
    sub("laybys", b, []);          // reopens it
    sub("laybys", c, []);          // arrives before the reopened listener has answered
    expect(b).toEqual([]);
    expect(c).toEqual([]);         // not the pre-refusal value, and not a null snapshot
    server.push("laybys", { after: 1 });
    expect(c).toEqual([{ after: 1 }]);
  });

  it("an error with no error handler does not throw", () => {
    sub("laybys", []);
    expect(() => server.cancel("laybys")).not.toThrow();
  });
});

describe("a subscriber that throws", () => {
  const quiet = () => createSharedLiveReads({ listen: server.listen, setTimer: clock.setTimer, clearTimer: clock.clearTimer, warn: (...a) => warned.push(a) });
  let warned;
  beforeEach(() => { warned = []; });

  it("on a delivery: the others are still told, and it is logged", () => {
    const s2 = quiet(); const good = [];
    s2.subscribe("k", () => "k", () => { throw new Error("boom"); });
    s2.subscribe("k", () => "k", (s) => good.push(s.val()));
    expect(() => server.push("k", 1)).not.toThrow();
    expect(good).toEqual([1]);
    expect(warned).toHaveLength(1);
    server.push("k", 2);
    expect(good).toEqual([1, 2]);
  });

  it("in its error handler: the others still hear the refusal", () => {
    const s2 = quiet(); const errs = [];
    s2.subscribe("k", () => "k", () => {}, () => { throw new Error("boom"); });
    s2.subscribe("k", () => "k", () => {}, (e) => errs.push(e.message));
    expect(() => server.cancel("k")).not.toThrow();
    expect(errs).toEqual(["permission_denied"]);
  });

  it("on the immediate replay: it sees its own error, is NOT left subscribed, and the listener still lingers and closes", () => {
    const s2 = quiet(); const good = [];
    const off = s2.subscribe("k", () => "k", (s) => good.push(s.val()));
    server.push("k", 1);
    let calls = 0;
    expect(() => s2.subscribe("k", () => "k", () => { calls += 1; throw new Error("boom"); })).toThrow("boom");
    server.push("k", 2);
    expect(calls).toBe(1);                    // never called again: it was removed
    expect(good).toEqual([1, 2]);
    off();                                    // the good one leaves — nobody is left
    clock.advance(LINGER_MS);
    expect(server.log.closes).toEqual(["k"]); // so the listener is not leaked
    expect(s2.stats().keys).toEqual([]);
  });

  it("on the replay with nobody else subscribed: the entry goes back to lingering, not to a leak", () => {
    const s2 = quiet();
    s2.subscribe("k", () => "k", () => {})();
    server.push("k", 1);
    expect(() => s2.subscribe("k", () => "k", () => { throw new Error("boom"); })).toThrow("boom");
    expect(s2.stats().idle).toBe(1);
    clock.advance(LINGER_MS);
    expect(s2.stats().keys).toEqual([]);
  });
});

describe("listen() itself throwing", () => {
  it("the caller sees the error, nothing is left registered, and the next subscribe tries again", () => {
    let fail = true;
    const s2 = createSharedLiveReads({
      listen: (t, a, b) => { if (fail) throw new Error("bad query"); return server.listen(t, a, b); },
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    expect(() => s2.subscribe("k", () => "k", () => {})).toThrow("bad query");
    expect(s2.stats()).toEqual({ listeners: 0, idle: 0, keys: [] });
    expect(clock.pending()).toBe(0);
    fail = false;
    const seen = [];
    s2.subscribe("k", () => "k", (s) => seen.push(s.val()));
    server.push("k", 9);
    expect(seen).toEqual([9]);
  });

  it("makeTarget throwing is the same", () => {
    expect(() => shared.subscribe("k", () => { throw new Error("no ref"); }, () => {})).toThrow("no ref");
    expect(shared.stats().keys).toEqual([]);
  });
});

describe("the connection dropping", () => {
  it("releases idle entries and stops a held value being replayed until the server answers again", () => {
    const offIdle = sub("customers", []);
    server.push("customers", { c: 1 });
    offIdle();
    const onScreen = [];
    sub("refills", onScreen);
    server.push("refills", { r: 1 });
    shared.connectionLost();
    expect(server.log.closes).toEqual(["customers"]);
    // A new subscriber is not handed the held snapshot: the listener is reopened.
    const late = [];
    sub("refills", late);
    expect(late).toEqual([]);
    expect(server.log.opens.filter((t) => t === "refills")).toHaveLength(2);
    server.push("refills", { r: 2 });
    expect(late).toEqual([{ r: 2 }]);
    expect(onScreen).toEqual([{ r: 1 }, { r: 2 }]);
  });

  it("a fresh snapshot vouches for the entry again — the next subscriber is replayed to, nothing reopened", () => {
    sub("refills", []);
    server.push("refills", { r: 1 });
    shared.connectionLost();
    server.push("refills", { r: 2 });          // the server's answer after the reconnect
    const late = [];
    sub("refills", late);
    expect(late).toEqual([{ r: 2 }]);
    expect(server.log.opens).toHaveLength(1);
  });

  it("connectionRestored vouches for what is held — but never for an identity change", () => {
    sub("refills", []); sub("customers", []);
    server.push("refills", 1); server.push("customers", 2);
    shared.connectionLost();
    shared.identityChanged();
    shared.connectionRestored();
    const late = [];
    sub("customers", late);
    expect(late).toEqual([]);                  // still not replayed: the identity changed
    expect(server.log.opens.filter((t) => t === "customers")).toHaveLength(2);
  });

  it("connectionRestored after a plain loss: replayed, nothing reopened", () => {
    sub("refills", []);
    server.push("refills", 1);
    shared.connectionLost();
    shared.connectionRestored();
    const late = [];
    sub("refills", late);
    expect(late).toEqual([1]);
    expect(server.log.opens).toHaveLength(1);
  });

  it("an entry that may not be replayed is not held once its last subscriber leaves", () => {
    const off = sub("refills", []);
    server.push("refills", 1);
    shared.connectionLost();
    off();
    expect(server.log.closes).toEqual(["refills"]);
    expect(clock.pending()).toBe(0);
  });
});

describe("a direct switch from one person to another, with a screen still mounted", () => {
  it("the next subscriber is never handed the first person's rows", () => {
    const a = [];
    sub("customers", a);
    server.push("customers", { whose: "A" });
    shared.identityChanged();
    expect(server.log.closes).toEqual([]);     // in use: not pulled from under the screen
    const b = [];
    sub("customers", b);
    expect(b).toEqual([]);
    expect(server.log.opens).toHaveLength(2);  // reopened under the new identity
    server.push("customers", { whose: "B" });
    expect(b).toEqual([{ whose: "B" }]);
    // The reopened listener is an ordinary one again: it may linger.
    shared.reset();
  });
});

describe("the per-path policy", () => {
  const withPolicy = (policy, extra = {}) => createSharedLiveReads({
    listen: server.listen, policy, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra,
  });
  const visit = (s2, key) => { const off = s2.subscribe(key, () => key, () => {}); server.push(key, key); off(); };

  it("each key is held for its own time", () => {
    const s2 = withPolicy((k) => (k === "big" ? { lingerMs: 600000, bytes: 0 } : { lingerMs: 25000, bytes: 0 }));
    visit(s2, "big"); visit(s2, "small");
    clock.advance(25000);
    expect(server.log.closes).toEqual(["small"]);
    clock.advance(600000);
    expect(server.log.closes).toEqual(["small", "big"]);
  });

  it("a key whose policy is zero is not held at all", () => {
    const s2 = withPolicy(() => ({ lingerMs: 0, bytes: 0 }));
    visit(s2, "k");
    expect(server.log.closes).toEqual(["k"]);
  });

  it("unsubscribe({ linger: false }) closes at once whatever the policy — the caller has another source", () => {
    const s2 = withPolicy(() => ({ lingerMs: 600000, bytes: 0 }));
    const off = s2.subscribe("k", () => "k", () => {});
    off({ linger: false });
    expect(server.log.closes).toEqual(["k"]);
    // …but not while somebody else still needs it.
    const offA = s2.subscribe("j", () => "j", () => {});
    s2.subscribe("j", () => "j", () => {});
    offA({ linger: false });
    expect(server.log.closes).toEqual(["k"]);
  });
});

describe("the cap on what is held for nobody", () => {
  const MBs = 1024 * 1024;
  const sizes = { refills: 16, products: 8, orders: 4, customers: 2.5, rows: 1.3, targets: 3, small1: 0.25, small2: 0.25 };
  const capped = (extra = {}) => createSharedLiveReads({
    listen: server.listen, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    policy: (k) => ({ lingerMs: 600000, bytes: (sizes[k] ?? 0.25) * MBs }), ...extra,
  });
  const visit = (s2, key) => { const off = s2.subscribe(key, () => key, () => {}); server.push(key, key); off(); };

  it("the defaults: three big nodes, 32 MB", () => {
    expect(MAX_IDLE_HEAVY).toBe(3);
    expect(MAX_IDLE_BYTES).toBe(32 * MBs);
    expect(HEAVY_BYTES).toBe(MBs);
  });

  it("keeps the three most recently left big nodes and releases the OLDEST first", () => {
    const s2 = capped();
    visit(s2, "orders"); visit(s2, "customers"); visit(s2, "rows");
    expect(server.log.closes).toEqual([]);
    visit(s2, "targets");
    expect(server.log.closes).toEqual(["orders"]);
    visit(s2, "products");
    expect(server.log.closes).toEqual(["orders", "customers"]);
    expect(s2.stats().keys.sort()).toEqual(["products", "rows", "targets"]);
  });

  it("coming back to a held node makes it the most recent again", () => {
    const s2 = capped();
    visit(s2, "orders"); visit(s2, "customers"); visit(s2, "rows");
    visit(s2, "orders");                       // back on Orders, and away again
    visit(s2, "targets");
    expect(server.log.closes).toEqual(["customers"]);
  });

  it("small nodes do not count against the three, and do not push a big one out", () => {
    const s2 = capped();
    visit(s2, "orders"); visit(s2, "customers"); visit(s2, "rows");
    visit(s2, "small1"); visit(s2, "small2");
    expect(server.log.closes).toEqual([]);
  });

  it("the byte budget: the oldest goes when the hints add up past it, even under three", () => {
    const s2 = capped({ maxIdleBytes: 20 * MBs });
    visit(s2, "products");                     // 8
    visit(s2, "refills");                      // 16 — 24 in all: products is released
    expect(server.log.closes).toEqual(["products"]);
    visit(s2, "orders");                       // 4 + 16 = 20: fits
    expect(server.log.closes).toEqual(["products"]);
  });

  it("the newest is always kept, however big — or the biggest node could never be held", () => {
    const s2 = capped({ maxIdleBytes: 10 * MBs });
    visit(s2, "refills");
    expect(server.log.closes).toEqual([]);
    const again = [];
    s2.subscribe("refills", () => "refills", (s) => again.push(s.val()));
    expect(again).toEqual(["refills"]);
    expect(server.log.opens).toHaveLength(1);
  });

  it("a node in use is never evicted, and does not count as idle", () => {
    const s2 = capped();
    s2.subscribe("refills", () => "refills", () => {});
    visit(s2, "orders"); visit(s2, "customers"); visit(s2, "rows"); visit(s2, "targets");
    expect(server.log.closes).toEqual(["orders"]);
    expect(s2.stats().keys).toContain("refills");
  });

  it("a visit to every big screen in ten minutes holds at most the budget", () => {
    const s2 = capped();
    for (const k of ["refills", "products", "orders", "customers", "rows", "targets"]) visit(s2, k);
    const held = s2.stats().keys;
    expect(held.sort()).toEqual(["customers", "rows", "targets"]);
    expect(held.reduce((n, k) => n + sizes[k], 0)).toBeLessThanOrEqual(32);
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

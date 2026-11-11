// ─── ONE LISTENER PER PATH, KEPT ACROSS A SCREEN SWITCH — PROVED AS A COUNT ──
//
// The saving is the number of times a listener is OPENED, because opening one
// is what downloads the node. So these tests count opens (and closes) against
// a fake `listen`, and drive time by hand.
import { describe, it, expect, beforeEach } from "vitest";
import { createSharedLiveReads, LINGER_MS, MAX_IDLE_BYTES } from "./sharedLiveReadCore";

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

describe("the connection dropping — left to the SDK, exactly as a bare onValue is", () => {
  it("releases idle entries, and nothing else", () => {
    const offIdle = sub("customers", []);
    server.push("customers", { c: 1 });
    offIdle();
    const onScreen = [];
    sub("refills", onScreen);
    server.push("refills", { r: 1 });
    shared.connectionLost();
    expect(server.log.closes).toEqual(["customers"]);
    expect(server.log.opens.filter((t) => t === "refills")).toHaveLength(1);
  });

  it("a second subscriber joining while offline is replayed the held value at once — the listener is NOT restarted", () => {
    const onScreen = [];
    sub("refills", onScreen);
    server.push("refills", { r: 1 });
    shared.connectionLost();
    const late = [];
    sub("refills", late);
    expect(late).toEqual([{ r: 1 }]);          // what a bare onValue would have been handed from the SDK cache
    expect(server.log.opens).toHaveLength(1);  // not stopped, not reopened: nothing to re-download on reconnect
    expect(server.log.closes).toEqual([]);
    server.push("refills", { r: 2 });          // the SDK's own re-sync after the line returns
    expect(late).toEqual([{ r: 1 }, { r: 2 }]);
    expect(onScreen).toEqual([{ r: 1 }, { r: 2 }]);
  });

  it("an in-use entry still lingers normally after a connection loss", () => {
    const off = sub("refills", []);
    server.push("refills", 1);
    shared.connectionLost();
    off();
    expect(server.log.closes).toEqual([]);
    expect(clock.pending()).toBe(1);
  });

  it("there is no reconnect probe and no offline state to clear", () => {
    expect(shared.connectionRestored).toBeUndefined();
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

describe("the cap on what is held for nobody — a byte budget, cheapest to refetch goes first", () => {
  const MBs = 1024 * 1024;
  const sizes = { refills: 16, products: 8, orders: 4, customers: 2.5, rows: 1.3, targets: 3, stock: 7,
                  "stock/a": 1.5, "stock/b": 1.5, "stock/c": 1.5, "stock/d": 1.5, small1: 0.25, small2: 0.25 };
  // `defer` runs the cap when the test says the screen switch is over.
  let deferred;
  const settleSwitch = () => { const d = deferred; deferred = []; for (const fn of d) fn(); };
  const capped = (extra = {}) => createSharedLiveReads({
    listen: server.listen, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    defer: (fn) => deferred.push(fn),
    policy: (k) => ({ lingerMs: 600000, bytes: (sizes[k] ?? 0.25) * MBs }), ...extra,
  });
  const mount = (s2, keys) => {
    const offs = keys.map((k) => { const off = s2.subscribe(k, () => k, () => {}); if (!server.open.has(k)) return off; server.push(k, k); return off; });
    return () => offs.forEach((off) => off());
  };
  const visit = (s2, key) => { mount(s2, [key])(); settleSwitch(); };
  const opensOf = (k) => server.log.opens.filter((t) => t === k).length;
  beforeEach(() => { deferred = []; });

  it("the default budget is 16 MB of hints, and there is no count cap", () => {
    expect(MAX_IDLE_BYTES).toBe(16 * MBs);
  });

  it("HOME → SHOP → HOME: the shop's stock locations never push the request node out — ONE open", () => {
    const s2 = capped();
    let leave = mount(s2, ["refills"]);                                   // Home (the badge)
    leave(); leave = mount(s2, ["stock/a", "stock/b", "stock/c", "stock/d"]); settleSwitch();   // → shop
    leave(); leave = mount(s2, ["refills"]); settleSwitch();              // → Home
    leave(); leave = mount(s2, ["stock/a", "stock/b", "stock/c", "stock/d"]); settleSwitch();   // → shop again
    leave(); mount(s2, ["refills"]); settleSwitch();                      // → Home again
    expect(opensOf("refills")).toBe(1);
  });

  it("HEALTH → REFILL → HEALTH: whole stock is opened ONCE", () => {
    const s2 = capped();
    const health = ["stock", "refills", "targets"]; const refill = ["refills", "stock/a"];
    let leave = mount(s2, health);
    leave(); leave = mount(s2, refill); settleSwitch();
    leave(); leave = mount(s2, health); settleSwitch();
    leave(); leave = mount(s2, refill); settleSwitch();
    leave(); mount(s2, health); settleSwitch();
    expect(opensOf("stock")).toBe(1);
    expect(opensOf("refills")).toBe(1);
    expect(opensOf("targets")).toBe(1);
  });

  it("the cap waits for the screen switch to finish: a node the next screen reads is never evicted in between", () => {
    const s2 = capped();
    const leave = mount(s2, ["refills", "stock", "targets"]);      // 26 MB in use
    leave();                                                       // all idle for an instant
    expect(server.log.closes).toEqual([]);                         // nothing evicted yet
    mount(s2, ["refills"]);                                        // the next screen takes the big one
    settleSwitch();
    expect(server.log.closes).toEqual([]);                         // 10 MB idle: fits
  });

  it("over the budget, the SMALLEST goes first and the biggest last", () => {
    const s2 = capped();
    visit(s2, "refills");                      // 16: fits exactly
    expect(server.log.closes).toEqual([]);
    visit(s2, "stock/a"); visit(s2, "stock/b");
    expect(server.log.closes).toEqual(["stock/a", "stock/b"]);   // each one released rather than the 16 MB node
    expect(s2.stats().keys).toEqual(["refills"]);
  });

  it("middling nodes: the cheapest are released until the rest fit", () => {
    const s2 = capped();
    const leave = mount(s2, ["products", "orders", "customers", "rows", "targets"]);   // 18.8 MB
    leave(); settleSwitch();
    expect(server.log.closes).toEqual(["rows", "customers"]);    // 15 MB left: fits
    expect(s2.stats().keys.sort()).toEqual(["orders", "products", "targets"]);
  });

  it("equal sizes: the one left longest ago goes first", () => {
    const s2 = capped({ maxIdleBytes: 3 * MBs });
    visit(s2, "stock/a"); visit(s2, "stock/b"); visit(s2, "stock/c");
    expect(server.log.closes).toEqual(["stock/a"]);
  });

  it("the largest is always kept, however big — or the biggest node could never be held", () => {
    const s2 = capped({ maxIdleBytes: 10 * MBs });
    visit(s2, "refills");
    expect(server.log.closes).toEqual([]);
    visit(s2, "small1");
    expect(server.log.closes).toEqual(["small1"]);
    const again = [];
    s2.subscribe("refills", () => "refills", (s) => again.push(s.val()));
    expect(again).toEqual(["refills"]);
    expect(opensOf("refills")).toBe(1);
  });

  it("a node in use is never evicted and does not count against the budget", () => {
    const s2 = capped();
    s2.subscribe("refills", () => "refills", () => {});
    visit(s2, "products"); visit(s2, "orders"); visit(s2, "targets");   // 15 MB idle
    expect(server.log.closes).toEqual([]);
  });

  it("what is held for nobody never exceeds the budget once a switch has settled", () => {
    const s2 = capped();
    for (const k of Object.keys(sizes)) visit(s2, k);
    const idle = s2.stats().keys;
    expect(idle.reduce((n, k) => n + sizes[k], 0)).toBeLessThanOrEqual(16);
    expect(idle).toContain("refills");
  });

  it("by default the cap runs on a microtask — after the commit that switched screens", async () => {
    const s2 = createSharedLiveReads({
      listen: server.listen, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      policy: (k) => ({ lingerMs: 600000, bytes: (sizes[k] ?? 0.25) * MBs }),
    });
    mount(s2, ["refills", "stock"])();
    expect(server.log.closes).toEqual([]);
    await Promise.resolve();
    expect(server.log.closes).toEqual(["stock"]);
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

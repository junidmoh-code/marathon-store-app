// ─── WEBSITE ORDERS — Settings → Online orders: Resolve ───────────────────────
// Run: npx vitest run src/components/onlineOrders/attention.test.js
import { describe, it, expect } from "vitest";
import { resolveAttentionUpdates, attentionRows, resolveLabel, orderLineEntries, rungByHandUpdates, openOrderRows } from "./attention.js";

const order = (kind, lines, over = {}) => ({
  ref: "WEB-7", status: "needs_attention", customer: { name: "Thandi" },
  attention: { kind, reason: "why", at: 50, mailedAt: 60 }, attentionOpen: true, lines, ...over,
});
const L = (status) => ({ pid: "p", size: "M", source: { locationId: status === "no_stock" ? null : "marathon-pe", status } });

describe("resolveAttentionUpdates", () => {
  for (const kind of ["unresolved", "no_stock", "not_found", "walkin_override"]) {
    it(`${kind}: every attention line → reroute, attention cleared, order back to new — healthy lines untouched`, () => {
      const o = order(kind, [L("handed"), L("no_stock"), L("not_found"), L("needs_attention"), L("unresolved"), L("display"), L("pick")]);
      expect(resolveAttentionUpdates("555", o)).toEqual({
        "online_orders/555/attention": null,
        "online_orders/555/attentionOpen": null,
        "online_orders/555/status": "new",
        "online_orders/555/lines/1/source/status": "reroute",
        "online_orders/555/lines/2/source/status": "reroute",
        "online_orders/555/lines/3/source/status": "reroute",
        "online_orders/555/lines/4/source/status": "reroute",
      });
    });
  }

  it("lines that came back as an index-keyed object (a hole) keep their real indices", () => {
    const o = order("not_found", { 0: L("handed"), 2: L("not_found") });
    const u = resolveAttentionUpdates("555", o);
    expect(u["online_orders/555/lines/2/source/status"]).toBe("reroute");
    expect(Object.keys(u).some((k) => k.includes("/lines/1/"))).toBe(false);
  });

  it("fulfil_failed: back to pending for the poller's retry; the packed order stays packed, lines untouched", () => {
    const u = resolveAttentionUpdates("555", order("fulfil_failed", [L("handed")], { status: "packed", fulfilState: "failed", fulfil: { state: "failed", attempts: 3 } }));
    expect(u).toEqual({
      "online_orders/555/attention": null,
      "online_orders/555/attentionOpen": null,
      "online_orders/555/fulfilState": "pending",
      "online_orders/555/fulfil/state": "pending",
    });
  });

  it("cancelled_after_pack: acknowledge only — attention and its flag cleared, nothing else", () => {
    expect(resolveAttentionUpdates("555", order("cancelled_after_pack", [L("handed")], { status: "packed" }))).toEqual({
      "online_orders/555/attention": null,
      "online_orders/555/attentionOpen": null,
    });
  });

  it("an unknown kind or a bad id resolves NOTHING (never guessed)", () => {
    expect(resolveAttentionUpdates("555", order("mystery", [L("not_found")]))).toBeNull();
    expect(resolveAttentionUpdates("555", { attentionOpen: true })).toBeNull();
    expect(resolveAttentionUpdates("a/b", order("no_stock", [L("no_stock")]))).toBeNull();
    expect(resolveAttentionUpdates("", order("no_stock", [L("no_stock")]))).toBeNull();
  });

  it("every branch clears attention AND attentionOpen together (else the row sits in the list forever)", () => {
    for (const k of ["unresolved", "no_stock", "not_found", "walkin_override", "fulfil_failed", "cancelled_after_pack"]) {
      const u = resolveAttentionUpdates("9", order(k, [L("no_stock")]));
      expect(u["online_orders/9/attention"]).toBeNull();
      expect(u["online_orders/9/attentionOpen"]).toBeNull();
      expect(resolveLabel(k)).toBeTruthy();
    }
  });
});

describe("attentionRows", () => {
  it("rows from the attentionOpen query: ref, customer, kind, reason, time — newest first", () => {
    const rows = attentionRows({
      a: order("no_stock", [], { ref: "WEB-1", attention: { kind: "no_stock", reason: "r1", at: 10 } }),
      b: order("not_found", [], { ref: "WEB-2", customer: null, attention: { kind: "not_found", reason: "r2", at: 20 } }),
      c: { ref: "WEB-3", attentionOpen: false },
    });
    expect(rows.map((r) => [r.orderId, r.ref, r.customer, r.kind, r.reason, r.at])).toEqual([
      ["b", "WEB-2", "—", "not_found", "r2", 20],
      ["a", "WEB-1", "Thandi", "no_stock", "r1", 10],
    ]);
    expect(attentionRows(null)).toEqual([]);
  });

  it("orderLineEntries ignores non-index keys", () => {
    expect(orderLineEntries({ lines: { 0: { a: 1 }, foo: { b: 2 } } }).map(([i]) => i)).toEqual([0]);
  });
});

describe("Rung by hand at a till", () => {
  it("only asks: release_requested, who and when, attention cleared", () => {
    expect(rungByHandUpdates("9001", { by: "u", at: 5 })).toEqual({
      "online_orders/9001/status": "release_requested",
      "online_orders/9001/handledByHand": { by: "u", at: 5 },
      "online_orders/9001/attention": null,
      "online_orders/9001/attentionOpen": null,
    });
    expect(rungByHandUpdates("a/b", { by: "u", at: 5 })).toBeNull();
  });
  it("lists open orders only, newest first", () => {
    const rows = openOrderRows({
      new: { a: { ref: "WEB-1", status: "new", createdAt: 1, lines: [{}] } },
      ready: { b: { ref: "WEB-2", status: "ready", createdAt: 2, lines: [{}, {}] }, c: { ref: "WEB-3", status: "packed", createdAt: 3 } },
    });
    expect(rows.map((r) => [r.ref, r.lines])).toEqual([["WEB-2", 2], ["WEB-1", 1]]);
  });
});

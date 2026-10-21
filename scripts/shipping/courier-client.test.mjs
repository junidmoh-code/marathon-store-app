import { describe, it, expect } from "vitest";
import { createCourierClient, redact, BASE_URL, CourierHttpError } from "./courier-client.mjs";
import { redactRatesResponse } from "./smoke-rates.mjs";
import doorDurban from "./fixtures/rates-door-durban.json";

const KEY = "0123456789abcdef0123456789abcdef";

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status >= 200 && next.status < 300, text: async () => next.body ?? "" };
  };
  fn.calls = calls;
  return fn;
}

function client(fetchImpl, lines = []) {
  return createCourierClient({ apiKey: KEY, fetchImpl, log: (l) => lines.push(l), sleep: async () => {} });
}

describe("courier-client", () => {
  it("sends the key as a Bearer header to the pinned host only", async () => {
    const f = fakeFetch([{ status: 200, body: '{"rates":[]}' }]);
    await client(f).getRates({ parcels: [] });
    expect(f.calls[0].url).toBe(`${BASE_URL}/rates`);
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("never writes the key to the log, even when the server echoes it", async () => {
    const lines = [];
    const f = fakeFetch([{ status: 401, body: `bad key ${KEY}` }]);
    await expect(client(f, lines).getRates({})).rejects.toBeInstanceOf(CourierHttpError);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).toContain("[REDACTED]");
  });

  it("redact() strips the key and any Bearer token", () => {
    expect(redact(`x ${KEY} y`, KEY)).toBe("x [REDACTED] y");
    expect(redact("Authorization: Bearer abc.def-123", "")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("retries a read on 5xx, then succeeds", async () => {
    const f = fakeFetch([{ status: 502 }, { status: 503 }, { status: 200, body: '{"ok":1}' }]);
    expect(await client(f).getRates({})).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(3);
  });

  it("does NOT retry a 4xx", async () => {
    const f = fakeFetch([{ status: 400, body: "bad" }, { status: 200, body: "{}" }]);
    await expect(client(f).getRates({})).rejects.toThrow(/HTTP 400/);
    expect(f.calls).toHaveLength(1);
  });

  it("never retries createShipment on 5xx — a second POST could book a second waybill", async () => {
    const f = fakeFetch([{ status: 500, body: "oops" }, { status: 200, body: "{}" }]);
    await expect(client(f).createShipment({})).rejects.toThrow(/HTTP 500/);
    expect(f.calls).toHaveLength(1);
  });

  it("never retries cancelShipment on 5xx or a transport failure", async () => {
    const f1 = fakeFetch([{ status: 504 }, { status: 200, body: "{}" }]);
    await expect(client(f1).cancelShipment("ABC")).rejects.toThrow(/HTTP 504/);
    expect(f1.calls).toHaveLength(1);
    const f2 = fakeFetch([new Error("socket hang up"), { status: 200, body: "{}" }]);
    await expect(client(f2).createShipment({})).rejects.toThrow(/socket/);
    expect(f2.calls).toHaveLength(1);
  });

  it("gives up on a read after maxAttempts 5xx", async () => {
    const f = fakeFetch([{ status: 500 }]);
    await expect(client(f).getShipments({ tracking_reference: "X" })).rejects.toThrow(/HTTP 500/);
    expect(f.calls).toHaveLength(4);
  });
});

describe("recorded fixtures", () => {
  it("carry no real account ids and only placeholder prices", () => {
    const s = JSON.stringify(doorDurban);
    expect(s).not.toMatch(/"\w*id":\s*[1-9]/);
    expect(doorDurban.rates.map((r) => r.rate)).toEqual([100, 110, 120, 130, 140]);
  });

  it("redactRatesResponse keeps the price ORDER and zeroes ids", () => {
    const out = redactRatesResponse({
      rates: [
        { rate: 300.5, service_level: { id: 9, code: "B" }, base_rate: { charge: 290.1, charge_per_parcel: [290.1] } },
        { rate: 99.9, service_level: { id: 8, code: "A" }, rate_adjustments: [{ group_id: 5, charge: 9.9 }] },
      ],
    });
    expect(out.rates[0].rate).toBe(110);
    expect(out.rates[1].rate).toBe(100);
    expect(out.rates[0].base_rate.charge_per_parcel).toEqual([110]);
    expect(out.rates[1].rate_adjustments[0]).toEqual({ group_id: 0, charge: 100 });
    expect(out.rates[0].service_level.id).toBe(0);
  });
});

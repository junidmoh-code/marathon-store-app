import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { answerQuoteRequest, REQUEST_TTL_MS } from "./quote-runner.mjs";
import { fakeDb } from "./fakeDb.testutil.mjs";
import doorCpt from "./fixtures/rates-door-capetown.json";
import lockerCpt from "./fixtures/rates-locker-capetown.json";

function fakeClient() {
  const calls = [];
  return {
    calls,
    getRates: async (body) => { calls.push(["getRates", body]); return body.collection_pickup_point_id ? lockerCpt : doorCpt; },
    createShipment: async () => { calls.push(["createShipment"]); throw new Error("must never be called"); },
    cancelShipment: async () => { calls.push(["cancelShipment"]); throw new Error("must never be called"); },
  };
}

const req = (over = {}) => ({
  ref: "W1001", requestedAt: 1_000_000,
  deliveryAddress: { street_address: "5 Esplanade Road", city: "Cape Town", code: "7441", zone: "WC", country: "ZA" },
  parcel: { lengthCm: 35, widthCm: 23, heightCm: 14, actualKg: 1.5 },
  ...over,
});

describe("quote runner", () => {
  it("prices door + locker, names the choice, writes the answer, deletes the request", async () => {
    const db = fakeDb({ shipping_quotes: { requests: { q1: req() } } });
    const client = fakeClient();
    const a = await answerQuoteRequest({ db, client, id: "q1", req: req(), now: 1_000_500 });
    expect(client.calls.map((c) => c[0])).toEqual(["getRates", "getRates"]);
    expect(a.chosen).toMatchObject({ mode: "locker", code: "L2DM - ECO" });
    expect(db.root.shipping_quotes.answers.q1.door.rates.map((r) => r.code)).toEqual(["ECO", "PRI", "SDX"]);
    expect(db.root.shipping_quotes.requests?.q1).toBeUndefined();
  });

  it("a parcel over every locker threshold is quoted for the door choice", async () => {
    const db = fakeDb();
    const a = await answerQuoteRequest({ db, client: fakeClient(), id: "q2", req: req({ parcel: { lengthCm: 55, widthCm: 40, heightCm: 35, actualKg: 16 } }), now: 1_000_500 });
    expect(a.chosen).toMatchObject({ mode: "door", code: "ECO" });
  });

  it("drops a stale request unanswered", async () => {
    const db = fakeDb({ shipping_quotes: { requests: { q3: req() } } });
    const client = fakeClient();
    expect(await answerQuoteRequest({ db, client, id: "q3", req: req(), now: 1_000_000 + REQUEST_TTL_MS + 1 })).toBeNull();
    expect(client.calls).toHaveLength(0);
    expect(db.root.shipping_quotes.requests.q3).toBeUndefined();
  });

  it("a TCG error becomes the answer's error, never a crash", async () => {
    const db = fakeDb();
    const client = { getRates: async () => { throw new Error("HTTP 401"); } };
    const a = await answerQuoteRequest({ db, client, id: "q4", req: req(), now: 1_000_500 });
    expect(a.door.error).toMatch(/401/);
    expect(a.chosen).toBeNull();
  });

  it("RATES ONLY: the runner's source never reaches a booking or cancel call", () => {
    const src = readFileSync(new URL("./quote-runner.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/createShipment|cancelShipment|bookShipment|\/shipments/);
    const q = readFileSync(new URL("./quote.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(q).not.toMatch(/createShipment|cancelShipment/);
  });
});

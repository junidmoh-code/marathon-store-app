// THREE COPIES, ONE BODY. The registry is read by the store app, by the Cloud
// Functions and by the POS. If the wall or the back-stock mapping differs
// between them, the client allows what the server refuses (or worse, the other
// way round). This pins the functions copy to this one textually, pins the
// behaviour of both, and publishes the body's hash for the POS repo's own
// parity test to compare against.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as esm from "./networkRegistry";

const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/network-registry.cjs");

const BEGIN = "// ── BEGIN SHARED BODY";
const END = "// ── END SHARED BODY";
function body(file) {
  const t = readFileSync(join(process.cwd(), file), "utf8");
  return t.slice(t.indexOf(BEGIN), t.indexOf("\n", t.indexOf(END)) + 1);
}

// The POS repo's src/shared/networkRegistry.parity.test.js holds the same
// constant. Changing the body means running scripts/sync-network-registry.mjs
// and updating BOTH.
export const SHARED_BODY_SHA256 = "5723201ad4182c258b854c785f32456ae51ba5e563b158fb9fb1476c5a482820";

describe("network registry parity", () => {
  it("functions copy carries the same body, byte for byte", () => {
    const a = body("src/utils/networkRegistry.js");
    expect(a.length).toBeGreaterThan(5000);
    expect(body("functions/lib/network-registry.cjs")).toBe(a);
  });

  it("the body matches the hash the POS copy is pinned to", () => {
    expect(createHash("sha256").update(body("src/utils/networkRegistry.js")).digest("hex")).toBe(SHARED_BODY_SHA256);
  });

  it("both copies export the same names and answer the same", () => {
    expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
    const raw = { creditScope: "section", locations: { hub3: { live: true } }, backStock: { concrete: { hoodies: "concrete-stockroom" } } };
    expect(cjs.normalizeNetwork(raw)).toEqual(esm.normalizeNetwork(raw));
    const ids = ["central", "hub1", "hub2", "hub3", "concrete-stockroom", "marathon-pe", "trophy", "marathon-pine", "concrete", "in_transit", "nope", null];
    for (const a of ids) for (const b of ids) {
      expect(cjs.wallCheck(null, a, b)).toEqual(esm.wallCheck(null, a, b));
    }
  });
});

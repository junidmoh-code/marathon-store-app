// ─── HUB 2'S "OUT OF STOCK" RECORDS WHO PRESSED IT (2026-09-23) ──────────────
// Run: npx vitest run src/hub2RefusalName.gate.test.js
//
// House pattern (UserManagement.gate.test.jsx): App.jsx's clothing batch is not
// exported, so the artefact under test is the source. Hub 2's Reject on a shop
// line writes the ORDER; the hourly scan carries the account on to the request
// (functions/test/hub2-refusal-name.test.cjs pins that half and the write-off).
// This pins the app half: every Reject stamps the signed-in account, the same
// auth.currentUser the Central queue records, and every path that UNDOES a
// refusal (a later fulfil, an undo) clears it with the timestamp.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "App.jsx"), "utf8");
const Q = readFileSync(join(HERE, "components/stock/RefillQueue.jsx"), "utf8");
const calls = (re) => SRC.split("\n").filter((l) => re.test(l));

describe("Hub 2 Reject on a shop line", () => {
  it("stamps the signed-in account next to clothingOutOfStockAt", () => {
    const rejects = calls(/clothingRefillStatus: "rejected"/);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toContain("clothingOutOfStockAt: now");
    expect(rejects[0]).toContain("clothingOutOfStockByUid: auth.currentUser?.uid || null");
  });

  it("is the same account Central's queue records", () => {
    expect(Q).toContain("resolvedBy: auth.currentUser.uid");
  });

  it("every write that clears clothingOutOfStockAt clears the account too", () => {
    const clears = calls(/updateOrder\(.*clothingOutOfStockAt: null/);
    expect(clears.length).toBeGreaterThanOrEqual(2);   // fulfil + undo
    for (const l of clears) expect(l).toContain("clothingOutOfStockByUid: null");
  });

  it("the staff-facing Reject flow is unchanged: no new prompt, no new wording", () => {
    const i = SRC.indexOf('clothingRefillStatus: "rejected"');
    const around = SRC.slice(i - 600, i + 600);
    expect(around).not.toMatch(/window\.(prompt|confirm|alert)/);
  });
});

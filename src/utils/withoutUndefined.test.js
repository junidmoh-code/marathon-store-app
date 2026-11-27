import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { withoutUndefined, isFirebaseArgumentError } from "./withoutUndefined";

describe("withoutUndefined (Junid 26 Nov 2026: insights_log.customerPhone banner)", () => {
  it("drops undefined at any depth, keeps null, false, 0 and arrays", () => {
    expect(withoutUndefined({ customerPhone: undefined, customerName: "Shopify", n: 0, f: false, z: null, a: [1, undefined], d: { x: undefined, y: 2 } }))
      .toEqual({ customerName: "Shopify", n: 0, f: false, z: null, a: [1, null], d: { y: 2 } });
  });
  it("recognises Firebase write-argument errors", () => {
    expect(isFirebaseArgumentError("push failed: value argument contains undefined in property 'insights_log.customerPhone'")).toBe(true);
    expect(isFirebaseArgumentError("update failed: first argument contains undefined in property 'orders.CHZ.x'")).toBe(true);
    expect(isFirebaseArgumentError("PERMISSION_DENIED")).toBe(false);
  });
});

describe("wiring", () => {
  const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const MAIN = readFileSync(new URL("../main.jsx", import.meta.url), "utf8");
  const PRINT = readFileSync(new URL("../components/stock/printDispatch.js", import.meta.url), "utf8");
  it("insight rows and order patches are cleaned and never throw at the tap", () => {
    expect(APP).toContain('push(ref(database, "insights_log"), withoutUndefined(entry))');
    expect(APP).toContain("withoutUndefined(stampPatch(patch, orderActionName(patch)))");
  });
  it("the global banner stays quiet for Firebase argument errors", () => {
    expect(MAIN).toContain("if (quiet(m)) return;");
  });
  it("send prints no label: the one setting is off and gates the print", () => {
    expect(PRINT).toContain("export const SEND_PRINTS_LABEL = false;");
    expect(APP).toContain("if (!SEND_PRINTS_LABEL) return transfer;");
  });
  it("one reject button: the card's button reads Out of stock, the Tomorrow slot hides its duplicate", () => {
    expect(APP).not.toContain("Mark as Out of Stock\n");
    // Schedule for Tomorrow itself is gone (Junid 26 Nov 11:32), and on-hold can never be written.
    expect(APP).not.toContain("<TomorrowActionButton order={order}");
    expect(APP).toContain("if (status === STATUS.COMING_TOMORROW) { console.warn(");
  });
});

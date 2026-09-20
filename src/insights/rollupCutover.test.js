// ─── THE THREE SCREENS ACTUALLY GO THROUGH THE ROLLUP ────────────────────────
//
// Everything else in this folder tests that the rollup path produces the same
// numbers. None of it tests that anything USES it — and a cutover that is
// merged but not wired up is indistinguishable, from every other test, from a
// cutover that works. The bill would say otherwise a day later.
//
// So this reads App.jsx and asserts the wiring, in the same spirit as
// hubIsolation.test.js. It is a coarse test on purpose: it names the call
// sites, so deleting one is a red build rather than a silent return to the
// 35.99 MB read.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

describe("the all-time screens read a window, not the whole node", () => {
  it("nothing calls useInsightsLog() any more", () => {
    // The hook and the provider stay — they are the rollback path, and the
    // read contract keeps the legacy route alive until the cutover has been
    // live for a month. What must not exist is a CALL SITE.
    const calls = APP.split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /=\s*useInsightsLog\(\)/.test(line));
    expect(calls).toEqual([]);
  });

  it("Insights, Customers and the Admin product line all use useInsightsWindow", () => {
    const uses = APP.match(/useInsightsWindow\(\{/g) || [];
    expect(uses.length).toBe(3);
  });

  it("InsightsView asks for the window it is rendering, not for all of history", () => {
    const view = APP.slice(APP.indexOf("function InsightsView("));
    const call = view.slice(view.indexOf("useInsightsWindow({"), view.indexOf("useInsightsWindow({") + 400);
    // logStart, not filterStart: the Overview KPIs carry a "vs previous"
    // figure computed over the PREVIOUS equal-length window, so the read has
    // to cover both. A revert to filterStart makes those chips read zero and
    // disappear, which is a rendered figure changing.
    expect(call).toContain("startIso: logStart");
    expect(call).toContain("endIso: filterEnd");
    expect(call).toContain('allTime: filterMode === "all"');
    expect(view).toMatch(/const logStart = useMemo/);
  });

  it("the previous-period read is derived from the window, never hard-coded", () => {
    const view = APP.slice(APP.indexOf("function InsightsView("));
    const memo = view.slice(view.indexOf("const logStart = useMemo"), view.indexOf("const logStart = useMemo") + 800);
    expect(memo).toContain("a - (b - a)");
    expect(memo).toContain("[filterStart, filterEnd]");
  });

  it("the two genuinely all-time screens ask for all of it, in the same words", () => {
    for (const fn of ["function CustomersView(", "function AdminView("]) {
      const at = APP.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const body = APP.slice(at, at + 40000);
      const call = body.slice(body.indexOf("useInsightsWindow({"), body.indexOf("useInsightsWindow({") + 400);
      expect(call).toContain("startIso: ALL_TIME_START");
      expect(call).toContain("endIso: ALL_TIME_END");
      expect(call).toContain("allTime: true");
    }
  });

  it("the sidebar total comes from the rollup's running counter, not the loaded window", () => {
    // `filteredLog.length` was every event the store had ever logged, because
    // the array held all of history. It no longer does. Leaving that expression
    // in place would have turned an all-time total into a window total without
    // anything looking wrong.
    expect(APP).not.toMatch(/\{filteredLog\.length\.toLocaleString\(\)\}/);
    expect(APP).toMatch(/\{allTimeEventCount\.toLocaleString\(\)\}/);
    expect(APP).toMatch(/\{allTimeEventCount\} entries/);
  });

  it("the window read is declared BEFORE the memo that filters it", () => {
    // `const filteredLog = useMemo(() => log.filter(...), [log, ...])` placed
    // above `const { log } = useInsightsWindow(...)` is a temporal dead zone
    // error at render — and bundlers do not catch it, so the build stayed
    // green while the screen would have thrown.
    const view = APP.slice(APP.indexOf("function InsightsView("));
    expect(view.indexOf("useInsightsWindow({")).toBeLessThan(view.indexOf("const filteredLog"));
  });
});

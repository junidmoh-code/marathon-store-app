// ─── HUB 3 GETS HUB 2'S REFILL SCREEN (Junid, 10 Nov 2026) ───────────────────
// Source → Hub 3 mounts the same hub refill screen as Hub 2 (hubTabContent, the
// RefillQueue with dest passed in), with its own SNEAKERS / CLOTHING toggle.
// App.jsx cannot be imported in isolation, so this pins the wiring; the split
// itself is the footwear classifier (isFootwearLine), tested where it lives.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sourceTabsFor } from "./utils/sectionRouting";
import { SEED_REGISTRY } from "./utils/networkRegistry";
import { REACTIVE_REFILL_HUBS } from "./components/stock/reactiveRefillHubs";

const APP = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const between = (a, b) => { const i = APP.indexOf(a); const j = APP.indexOf(b, i); return i > -1 && j > -1 ? APP.slice(i, j) : null; };

describe("Source → Hub 3 refill screen", () => {
  const screen = between("const hubTabContent = (h) => {", "const content = (");
  const content = between("const content = (", "{tab===\"refillhistory\"");

  it("Hub 3's tab mounts the hub screen, not the bare request list", () => {
    expect(content).toContain(': sectionTabLoc[tab] === "hub3"\n            ? hubTabContent("hub3")');
  });

  it("the toggle is drawn for every hub with a line, from that hub's own state", () => {
    expect(screen).toContain("const mode = lineOf(h);");
    expect(screen).toContain("{mode && (");
    expect(screen).toContain('[["sneakers", "Sneakers"], ["clothing", "Clothing"]]');
    expect(screen).toContain("onClick={() => setLineOf(h)(val)}");
    expect(screen).toContain("<RefillQueue products={products} dest={h} lineFilter={lineFilter}");
    expect(APP).toContain('const lineOf = (h) => (h === "hub2" ? hub2Line : h === "hub3" ? hub3Line : null);');
    expect(APP).toContain('const setLineOf = (h) => (h === "hub3" ? setHub3Line : setHub2Line);');
  });

  it("Hub 2 is unchanged: same tab key, same mount, its own state; Hub 1 stays footwear-only (no toggle)", () => {
    expect(content).toContain('{tab==="clothing" && hubTabContent("hub2")}');
    expect(content).toContain('{tab==="hub1refill" && hubTabContent("hub1")}');
    expect(APP).toContain('const [hub2Line, setHub2Line] = useState("sneakers");');
    expect(APP).toContain('const [hub3Line, setHub3Line] = useState("sneakers");');
  });

  it("Hub 3 lists request rows only: no sale-driven rows unless it is a reactive hub", () => {
    expect(APP).toContain("activeHub && isReactiveRefillHub(activeHub) ? saleRowsFor(activeHub, activeCellFilter) : []");
    expect(REACTIVE_REFILL_HUBS).not.toContain("hub3");
  });

  it("the registry gives Hub 3 a Source tab keyed loc:hub3", () => {
    const tabs = sourceTabsFor(SEED_REGISTRY);
    expect(tabs.find((t) => t.loc === "hub3")).toMatchObject({ key: "loc:hub3", kind: "hub" });
    expect(tabs.find((t) => t.loc === "hub2")).toMatchObject({ key: "clothing", label: "Hub 2 Refill" });
  });
});

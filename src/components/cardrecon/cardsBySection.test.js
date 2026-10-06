// Which tills a viewer is shown, and under which section — the capture
// screen's one filter beyond "is it retired". Pure, over the network registry.
import { describe, it, expect, vi } from "vitest";
import { captureCards, cardsBySection } from "./terminalRegistry";
import { storeGroups } from "./TerminalSettings";
import { SEED_REGISTRY, normalizeNetwork } from "../../utils/networkRegistry";

vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../../firebase", () => ({ functions: {} }));
vi.mock("../../utils/useNetwork", () => ({ useNetwork: () => ({ registry: null }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowMs: () => 0, saDateStringAt: () => "2026-10-02" }));

const ESTATE = {
  A1: { label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
  A2: { label: "Marathon Till 2", storeId: "pe", tillId: "till-2" },
  T1: { label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
  P1: { label: "Pine Till 1", storeId: "pine", tillId: "till-1" },
  C1: { label: "Concrete Till 1", storeId: "concrete", tillId: "till-1" },
  C2: { label: "Concrete Till 2", storeId: "concrete", tillId: "till-2" },
  R1: { label: "Old Trophy", storeId: "trophy", tillId: "till-2", retiredAt: 5 },
};
const shape = (groups) => groups.map((g) => [g.section, g.name, g.cards.map((c) => c.label)]);

describe("cardsBySection", () => {
  const cards = captureCards(ESTATE);

  it("SECTION 2, AS TODAY: a Section 2 viewer gets ONE group — the Section 2 tills, in label order", () => {
    const groups = cardsBySection(cards, SEED_REGISTRY, [2]);
    expect(shape(groups)).toEqual([[2, "Marathon", ["Marathon Till 1", "Marathon Till 2", "Trophy Till 1"]]]);
    // The same cards, in the same order, captureCards alone gives for those stores.
    expect(groups[0].cards).toEqual(captureCards({ A1: ESTATE.A1, A2: ESTATE.A2, T1: ESTATE.T1 }));
  });

  it("a Section 1 viewer gets Pine and both Concrete tills, and nothing of Section 2", () => {
    expect(shape(cardsBySection(cards, SEED_REGISTRY, [1])))
      .toEqual([[1, "Concrete", ["Concrete Till 1", "Concrete Till 2", "Pine Till 1"]]]);
  });

  it("a viewer of both gets both groups, Section 2 first", () => {
    expect(shape(cardsBySection(cards, SEED_REGISTRY, [1, 2]))).toEqual([
      [2, "Marathon", ["Marathon Till 1", "Marathon Till 2", "Trophy Till 1"]],
      [1, "Concrete", ["Concrete Till 1", "Concrete Till 2", "Pine Till 1"]],
    ]);
  });

  it("a viewer with no section at all sees no sectioned till", () => {
    expect(cardsBySection(cards, SEED_REGISTRY, [])).toEqual([]);
  });

  it("a retired machine has no card in any group", () => {
    expect(JSON.stringify(cardsBySection(cards, SEED_REGISTRY, [1, 2]))).not.toContain("Old Trophy");
  });

  it("a till whose store the registry does not know is shown to everyone, last, under no heading", () => {
    const odd = captureCards({ ...ESTATE, X1: { label: "Mystery Till", storeId: "shop-from-2019", tillId: "till-1" } });
    for (const sections of [[1], [2], [1, 2]]) {
      const groups = cardsBySection(odd, SEED_REGISTRY, sections);
      expect(groups.at(-1)).toMatchObject({ section: null, name: null });
      expect(groups.at(-1).cards.map((c) => c.label)).toEqual(["Mystery Till"]);
    }
  });

  it("the section is the LIVE registry's: a store added on the Network card lands in its section", () => {
    const R = normalizeNetwork({ locations: { mall: { name: "Mall", type: "store", section: 2, posId: "mall", sort: 25 } } });
    const withMall = captureCards({ ...ESTATE, M1: { label: "Mall Till 1", storeId: "mall", tillId: "till-1" } });
    expect(cardsBySection(withMall, R, [2])[0].cards.map((c) => c.label)).toContain("Mall Till 1");
    expect(JSON.stringify(cardsBySection(withMall, R, [1]))).not.toContain("Mall Till 1");
  });
});

describe("storeGroups — the settings sheet's store picker", () => {
  const stores = [
    { storeId: "pe", label: "Marathon PE", section: 2 }, { storeId: "pine", label: "Marathon Pine", section: 1 },
    { storeId: "trophy", label: "Trophy", section: 2 }, { storeId: "concrete", label: "Concrete", section: 1 },
  ];
  it("groups by the section the callable sent, Section 2 first, order kept inside a group", () => {
    expect(storeGroups(stores, SEED_REGISTRY).map((g) => [g.name, g.stores.map((s) => s.storeId)]))
      .toEqual([["Marathon", ["pe", "trophy"]], ["Concrete", ["pine", "concrete"]]]);
  });
  it("an older callable that sends no section is grouped by the registry instead", () => {
    const bare = stores.map(({ section: _s, ...rest }) => rest);
    expect(storeGroups(bare, SEED_REGISTRY).map((g) => [g.name, g.stores.map((s) => s.storeId)]))
      .toEqual([["Marathon", ["pe", "trophy"]], ["Concrete", ["pine", "concrete"]]]);
  });
  it("a store neither knows goes last, under Other — never dropped from the picker", () => {
    const g = storeGroups([...stores, { storeId: "zzz", label: "Zed" }], SEED_REGISTRY);
    expect(g.at(-1)).toMatchObject({ section: null, name: "Other" });
    expect(g.at(-1).stores.map((s) => s.storeId)).toEqual(["zzz"]);
  });
});

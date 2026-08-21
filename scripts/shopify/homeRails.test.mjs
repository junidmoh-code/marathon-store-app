// ── THE RAIL TABLE AND THE THEME SETTING MUST NOT DRIFT ─────────────────────
// The home page's "Rail order" setting parses `Label~tag~collection-handle`
// rows. A value in any other shape parses to nothing and the home page renders
// with no category rails at all — silently, with no error anywhere.
//
// That is not hypothetical: sell-through.mjs originally printed bare collection
// keys under a heading telling the owner to paste them into that setting.
// Following the instruction would have emptied the page. These tests exist so
// the two halves cannot say different things again.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  HOME_RAILS, HOME_RAIL_BY_KEY, buildRailOrderSetting,
  COLLECTION_BY_KEY, CATEGORY_MAP,
} from "./collectionMap.mjs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

const HOME = new URL("../../theme/sections/marathon-home.liquid", import.meta.url).pathname;

function themeSetting(id) {
  const src = readFileSync(HOME, "utf8");
  const m = src.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  const schema = JSON.parse(m[1]);
  return schema.settings.find((s) => s.id === id);
}

// The order measured from POS sell-through over the 56 days to 2026-08-21
// (scripts/shopify/sell-through.mjs). Pinned so a change to the shipped default
// has to be a deliberate edit here, next to the evidence, rather than a drift.
const MEASURED_ORDER = [
  "sneakers", "tracksuits", "soccer-boots", "clothing", "caps-hats",
  "t-shirts", "pants", "bags", "fragrance", "sandals-slides",
  "boots", "accessories", "jackets", "hoodies-sweats", "shorts",
];

describe("HOME_RAILS is coherent with the collection map", () => {
  it("every rail names a real manual collection", () => {
    for (const r of HOME_RAILS) {
      // COLLECTION_BY_KEY is a Map, not a plain object — `[key]` on it is
      // always undefined, which is how sell-through.mjs came to print collection
      // KEYS where it meant to print titles.
      expect(COLLECTION_BY_KEY.get(r.key), `no collection "${r.key}"`).toBeTruthy();
      expect(COLLECTION_BY_KEY.get(r.key).kind).toBe("manual");
    }
  });

  it("no two rails draw from the same collection", () => {
    const keys = HOME_RAILS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every rail tag is a subcategory the category map actually routes", () => {
    // The tag a rail links to must be a tag products really carry, or
    // /collections/all/{tag} is an empty page. Every product's tags are its
    // category and subcategory (compliance.mjs buildTags), so the tag has to
    // appear on one side of a CATEGORY_MAP row.
    const known = new Set();
    for (const pair of Object.keys(CATEGORY_MAP)) {
      const [cat, sub] = pair.split("|");
      known.add(cat);
      if (sub !== "*") known.add(sub);
    }
    for (const r of HOME_RAILS) {
      expect(known.has(r.tag), `tag "${r.tag}" is on no product`).toBe(true);
    }
  });

  it("labels and tags carry no brand triggers — they are shopper-facing", () => {
    for (const r of HOME_RAILS) {
      expect(triggersInText(r.label)).toEqual([]);
      expect(triggersInText(r.tag)).toEqual([]);
    }
  });
});

describe("buildRailOrderSetting produces what the theme parses", () => {
  it("emits Label~tag~handle rows separated by semicolons", () => {
    for (const row of buildRailOrderSetting(MEASURED_ORDER).split(";")) {
      const parts = row.split("~");
      expect(parts).toHaveLength(3);
      expect(HOME_RAIL_BY_KEY[parts[2]]).toBeTruthy();
      expect(parts[0]).toBe(HOME_RAIL_BY_KEY[parts[2]].label);
      expect(parts[1]).toBe(HOME_RAIL_BY_KEY[parts[2]].tag);
    }
  });

  it("keeps the requested order and appends anything unranked", () => {
    const rows = buildRailOrderSetting(["bags", "sneakers"]).split(";");
    expect(rows[0]).toMatch(/~bags$/);
    expect(rows[1]).toMatch(/~sneakers$/);
    expect(rows).toHaveLength(HOME_RAILS.length); // nothing dropped
  });

  it("ignores keys with no rail and never emits an unparseable row", () => {
    const rows = buildRailOrderSetting(["not-a-collection", "sneakers"]).split(";");
    expect(rows[0]).toMatch(/~sneakers$/);
    for (const row of rows) expect(row.split("~")).toHaveLength(3);
  });

  it("does not repeat a rail when a key is listed twice", () => {
    const rows = buildRailOrderSetting(["sneakers", "sneakers"]).split(";");
    expect(rows.filter((r) => r.endsWith("~sneakers"))).toHaveLength(1);
  });
});

describe("the shipped theme default IS the generated one", () => {
  it("rail_order default matches buildRailOrderSetting(MEASURED_ORDER)", () => {
    expect(themeSetting("rail_order").default).toBe(buildRailOrderSetting(MEASURED_ORDER));
  });

  it("every row of the shipped default parses to a real collection", () => {
    for (const row of themeSetting("rail_order").default.split(";")) {
      const [label, tag, key] = row.split("~");
      expect(COLLECTION_BY_KEY.get(key), `row "${row}"`).toBeTruthy();
      expect(label).toBeTruthy();
      expect(tag).toBeTruthy();
    }
  });
});

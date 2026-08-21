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
const NAV = new URL("../../theme/snippets/marathon-nav.liquid", import.meta.url).pathname;
const GRID = new URL("../../theme/sections/marathon-grid.liquid", import.meta.url).pathname;

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

// ── THE NAVIGATION TREE ──────────────────────────────────────────────────────
// The navigation carries its own tree, deliberately: it is a two-level shopper
// hierarchy, not the flat ranked list the home rails use, and the two answer
// different questions. What they MUST agree on is that every tag they name is a
// tag products actually carry — a nav row pointing at /collections/all/{tag}
// for a tag on no product is a dead end, which is the one thing the whole
// tag-driven design exists to avoid.
describe("navigation tags are real", () => {
  const routedTags = (() => {
    const known = new Set();
    for (const pair of Object.keys(CATEGORY_MAP)) {
      const [cat, sub] = pair.split("|");
      known.add(cat);
      if (sub !== "*") known.add(sub);
    }
    return known;
  })();

  // The `rows` assign: 'Label~kind~target[~child,child,…];…'
  const navRows = (() => {
    const src = readFileSync(NAV, "utf8");
    const m = src.match(/assign rows = '([^']+)'/);
    if (!m) throw new Error("could not find the nav `rows` table — did it move?");
    return m[1].split(";").map((r) => r.split("~"));
  })();

  it("found the tree", () => expect(navRows.length).toBeGreaterThan(3));

  it("every tag row names a tag products carry", () => {
    for (const [label, kind, target] of navRows) {
      if (kind !== "tag") continue;
      expect(routedTags.has(target), `nav row "${label}" -> tag "${target}"`).toBe(true);
    }
  });

  it("every child names a tag products carry", () => {
    for (const row of navRows) {
      for (const kid of (row[3] || "").split(",").filter(Boolean)) {
        expect(routedTags.has(kid), `nav child "${kid}"`).toBe(true);
      }
    }
  });

  it("every collection row names a real collection", () => {
    for (const [label, kind, target] of navRows) {
      if (kind !== "collection") continue;
      expect(COLLECTION_BY_KEY.get(target), `nav row "${label}" -> "${target}"`).toBeTruthy();
    }
  });

  it("no label or tag carries a brand trigger", () => {
    for (const row of navRows) {
      expect(triggersInText(row[0])).toEqual([]);
      if (row[1] === "tag") expect(triggersInText(row[2])).toEqual([]);
      for (const kid of (row[3] || "").split(",").filter(Boolean)) {
        expect(triggersInText(kid)).toEqual([]);
      }
    }
  });
});

// ── THE SIBLING STRIP ────────────────────────────────────────────────────────
// marathon-grid.liquid holds a THIRD copy of the category vocabulary — the two
// lists behind the "where else can I go" strip on a category page. It is a
// third copy because Liquid cannot read collectionMap.mjs, and an unpinned
// third copy is exactly the thing these tests exist to stop: rename a category
// in the map and the strip would go on offering the old name, silently, in the
// one place built to guarantee no dead ends.
describe("the category-page sibling strip", () => {
  const routedTags = (() => {
    const known = new Set();
    for (const pair of Object.keys(CATEGORY_MAP)) {
      const [cat, sub] = pair.split("|");
      known.add(cat);
      if (sub !== "*") known.add(sub);
    }
    return known;
  })();

  const lists = (() => {
    const src = readFileSync(GRID, "utf8");
    const out = {};
    for (const name of ["footwear", "everything_else"]) {
      const m = src.match(new RegExp(`assign ${name} = '([^']+)'`));
      if (!m) throw new Error(`the grid's "${name}" list moved or was renamed`);
      out[name] = m[1].split(",").map((x) => x.trim());
    }
    return out;
  })();

  it("found both lists", () => {
    expect(lists.footwear.length).toBeGreaterThan(2);
    expect(lists.everything_else.length).toBeGreaterThan(5);
  });

  it("every sibling names a tag products carry", () => {
    for (const [name, list] of Object.entries(lists)) {
      for (const tag of list) {
        expect(routedTags.has(tag), `${name}: "${tag}"`).toBe(true);
      }
    }
  });

  it("no sibling carries a brand trigger", () => {
    for (const list of Object.values(lists)) {
      for (const tag of list) expect(triggersInText(tag)).toEqual([]);
    }
  });

  it("the two lists do not overlap — a shoe belongs to one strip", () => {
    const overlap = lists.footwear.filter((t) => lists.everything_else.includes(t));
    expect(overlap).toEqual([]);
  });
});

// ── TAG URLS MUST LAND NEWEST-FIRST ─────────────────────────────────────────
// /collections/all/{tag} inherits collections.all's sort, and that default is
// `title-ascending` (measured on production 2026-08-21). These titles are
// machine-generated with every brand term stripped out, so alphabetical is a
// sort on noise — and tag URLs ARE the category navigation, so it was the
// landing order of every category in the shop. Every generated tag link
// therefore carries an explicit sort, and this holds it there: the param is one
// `| append:` away from being dropped by a refactor, and nothing else would
// notice.
describe("generated tag URLs carry an explicit sort", () => {
  const SORT = "?sort_by=created-descending";
  const files = {
    "marathon-nav.liquid": readFileSync(NAV, "utf8"),
    "marathon-grid.liquid": readFileSync(GRID, "utf8"),
    "marathon-home.liquid": readFileSync(HOME, "utf8"),
  };

  for (const [name, src] of Object.entries(files)) {
    it(`${name} appends the sort to every /collections/all/ link it builds`, () => {
      // Every assign that prepends the tag base is a link the shopper follows.
      const builders = [...src.matchAll(/assign\s+(\w+)\s*=\s*([^\n]*prepend:\s*'\/collections\/all\/'[^\n]*)/g)];
      expect(builders.length, `${name} builds no tag URLs — did the idiom change?`).toBeGreaterThan(0);

      for (const [, varName, expr] of builders) {
        // Either this line appends the sort, or it is an explicitly-named *_path
        // used only for the aria-current comparison (which must NOT carry it,
        // because request.path has no query string).
        const isPathOnly = /_path$/.test(varName);
        if (isPathOnly) {
          expect(expr, `${name}: ${varName} must stay query-free`).not.toContain("sort_by");
        } else {
          expect(expr, `${name}: ${varName} lost its sort`).toContain(SORT);
        }
      }
    });
  }

  it("the *_path variables are actually used for aria-current, not for href", () => {
    const src = files["marathon-nav.liquid"];
    for (const m of src.matchAll(/assign\s+(\w+_path)\s*=/g)) {
      const v = m[1];
      expect(src, `${v} is built but never compared`).toContain(`request.path == ${v}`);
      expect(src).not.toContain(`href="{{ ${v} }}"`);
    }
  });
});

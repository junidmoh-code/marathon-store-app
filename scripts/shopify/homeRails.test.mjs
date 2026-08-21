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

// ── EVERY /collections/all LINK MUST CARRY AN EXPLICIT SORT ─────────────────
// `collections.all` defaults to `title-ascending`, and every category URL in
// this storefront is `/collections/all` or `/collections/all/{tag}` — so
// without an explicit sort the whole category navigation lands sorted A-to-Z on
// machine-generated titles with every brand term stripped out. A sort on noise,
// on the primary browsing surface.
//
// THIS TEST HAS BEEN WRONG TWICE, in two different ways, and both are worth
// remembering because they are how guard rails usually fail:
//
//   1. It first matched `assign` SYNTAX (`prepend: '/collections/all/'`), which
//      in the nav matches only the query-free `*_path` helpers — never the real
//      link variables, which are built FROM those with `| append:`. It asserted
//      nothing at all about the file it existed for.
//   2. Rewritten to judge links, it then (a) merged every branch of a
//      multiply-assigned variable into one blob, so a later branch that DROPPED
//      the sort was excused by an earlier one that had it, and (b) scanned raw
//      source, so an href inside a {% comment %} counted as a real link — enough
//      to satisfy the "found some links" guard while every real link was broken.
//
// So it now: strips comments first, keeps each assignment BRANCH separate, and
// requires every branch that reaches /collections/all to carry the sort.

/** Liquid/HTML comments are documentation, not links. */
function stripComments(src) {
  return src
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, " ");
}

/**
 * name -> EVERY expression assigned to it, kept separate. Liquid reassigns
 * freely inside branches, and a variable is only safe if EVERY branch is safe.
 */
function assignBranches(src) {
  const m = new Map();
  const add = (name, e) => {
    if (e === "''" || e === '""' || e === "") return; // empty scaffolding
    if (!m.has(name)) m.set(name, []);
    m.get(name).push(e);
  };
  // The trailing `-` of a whitespace-trimming `{%- assign x = y -%}` is Liquid
  // punctuation, not part of the value. Keeping it left `coll_base` as
  // `'/collections' -`, so substituting it produced `'/collections' -/all`,
  // which does not contain "/collections/all" — a composite link slipped past.
  for (const a of src.matchAll(/assign\s+(\w+)\s*=\s*([^\n%]*)/g)) {
    add(a[1], a[2].trim().replace(/\s*-$/, "").trim());
  }

  // {% capture %} BUILDS A VARIABLE TOO, and reading only `assign` meant a
  // capture was invisible: a link rebuilt as a capture kept whatever OTHER
  // assign branches its name still had, resolved cleanly through those, and the
  // unsorted capture never appeared in the scan at all. Its body is literal
  // text, which is exactly what this test wants to read.
  for (const c of src.matchAll(/\{%-?\s*capture\s+(\w+)\s*-?%\}([\s\S]*?)\{%-?\s*endcapture\s*-?%\}/g)) {
    add(c[1], c[2].trim());
  }
  return m;
}

// ─── RESOLVING A LINK ────────────────────────────────────────────────────────
// THE DEFAULT IS "I CANNOT VERIFY THIS", NOT "THIS IS FINE".
//
// This file has now had the SAME SHAPE of hole four times: a link the resolver
// could not understand fell back to some raw text, that text happened not to
// contain "/collections/all", and so the link was neither flagged as unsorted
// NOR counted toward coverage — it simply vanished from the scan while the
// file's other links kept the "did we check anything?" guard satisfied. Four
// different escape routes (a *_path helper, a merged branch blob, a comment, a
// {% capture %}, `collections.all.url`) all exploited that one default.
//
// Patching escape routes one at a time was the mistake. Every link must now
// resolve to a CONCRETE PATH — a string starting with "/" — or it fails as
// unverifiable. There is no third outcome.

const MASK = "\u0000";

/** Hide string literals so identifiers inside them are never treated as code. */
function maskLiterals(expr) {
  const lits = [];
  const masked = expr.replace(/'[^']*'|"[^"]*"/g, (m) => {
    lits.push(m);
    return `${MASK}${lits.length - 1}${MASK}`;
  });
  return { masked, lits };
}
const unmask = (s, lits) => s.replace(new RegExp(`${MASK}(\\d+)${MASK}`, "g"), (_, i) => lits[+i]);

/** The mapped variables an expression names, ignoring anything inside quotes. */
function refsOf(expr, map) {
  const { masked } = maskLiterals(expr);
  const out = new Set();
  // A PROPERTY is not a variable: `c.url` refers to `c`, not to some unrelated
  // `url` assigned elsewhere in the file.
  for (const m of masked.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)/gi)) {
    if (map.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * Shopify's own objects, rewritten to the path they actually render.
 * `collections.all.url` renders "/collections/all" — the literal this whole
 * test is about — but its SOURCE TEXT contains dots and no leading slash, so
 * judging the text directly reported "no /collections/all here" and passed a
 * link that was exactly the bug.
 *
 * An index that is a variable becomes /collections/{dynamic}: it is knowably
 * not `all`, because the collection rows the nav builds are pinned to real
 * collection keys by the "every collection row names a real collection" test
 * above.
 */
function normaliseShopifyGlobals(text) {
  return text
    // `collection.url` (singular) is the CURRENT collection. On a tag page —
    // which is every category page in this storefront — that object is
    // /collections/all. Normalising to the worst case is the safe direction.
    .replace(/(?<![\w.])collection\s*\.\s*url/g, "/collections/all")
    .replace(/collections\s*\.\s*all\s*\.\s*url/g, "/collections/all")
    .replace(/collections\s*\[\s*['"]all['"]\s*\]\s*\.?\s*url/g, "/collections/all")
    .replace(/collections\s*\[\s*['"]([\w-]+)['"]\s*\]/g, "/collections/$1")
    .replace(/collections\s*\[[^\]]+\]/g, "/collections/{dynamic}");
}

/**
 * Every value an expression could resolve to, one string per branch, with each
 * variable SUBSTITUTED IN PLACE.
 *
 * Substitution rather than appending, because appending let one variable's sort
 * excuse another variable's unsorted path: the two expansions landed in a single
 * string and "contains /collections/all AND lacks the sort" was satisfied
 * jointly. Throws on an expression naming more than one variable AT ANY DEPTH —
 * checking only the top level left the same hole one assign further down.
 */
function expand(expr, map, seen = new Set()) {
  const refs = refsOf(expr, map);
  if (refs.length > 1) {
    throw new Unverifiable(`built from more than one variable (${expr.trim()}) — simplify it or assert it explicitly`);
  }
  const { masked, lits } = maskLiterals(expr);
  let out = [masked];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    const deeper = new Set(seen);
    deeper.add(ref);
    const subs = map.get(ref).flatMap((b) => expand(b, map, deeper));
    const re = new RegExp(`(?<![\\w.])${ref}(?![\\w])`, "g");
    out = out.flatMap((o) => subs.map((sub) => o.replace(re, maskLiterals(sub).masked === sub ? sub : sub)));
  }
  return out.map((o) => unmask(o, lits));
}

class Unverifiable extends Error {}

/**
 * A link, resolved — or an explicit refusal. Never a silent pass.
 */
function linkFrom(raw, nameOrLiteral, map, isVariable) {
  if (!isVariable) {
    // A COMPOSITE href — literal text mixed with {{ variables }} — used to be
    // returned as raw source and skip every gate: no resolution, no globals
    // normalisation, no concreteness check. Rewriting the "Everything" row as
    // href="/collections/{{ all_handle }}" therefore passed while rendering
    // /collections/all unsorted, and the grid's own sort links
    // ("{{ sort_base }}?sort_by={{ bits[0] }}") were never checked at all.
    // Every {{ var }} inside the href is now resolved and substituted.
    const text = String(nameOrLiteral);
    const vars = [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)];
    if (!vars.length) return { raw, branches: [normaliseShopifyGlobals(text)], verifiable: true };
    try {
      let branches = [text];
      for (const [token, varName] of vars) {
        const inner = linkFrom(token, varName, map, true);
        if (inner.verifiable === false) throw new Unverifiable(inner.why);
        branches = branches.flatMap((b) => inner.branches.map((sub) => b.replace(token, sub)));
      }
      return { raw, branches: branches.map(normaliseShopifyGlobals), verifiable: true };
    } catch (e) {
      if (e instanceof Unverifiable) return { raw, branches: [], verifiable: false, why: e.message };
      throw e;
    }
  }
  const name = nameOrLiteral;
  try {
    const dot = name.indexOf(".");
    let branches;
    if (dot > 0) {
      const root = name.slice(0, dot);
      const suffix = name.slice(dot);
      branches = map.has(root)
        ? map.get(root).flatMap((b) => expand(b, map)).map((x) => x + suffix)
        : [name];
    } else {
      if (!map.has(name)) {
        throw new Unverifiable(`"${name}" is built by neither assign nor capture — cannot be resolved`);
      }
      branches = map.get(name).flatMap((b) => expand(b, map));
    }
    branches = branches.map(normaliseShopifyGlobals);

    // THE INVERTED DEFAULT. A branch that is not a concrete path is not a pass.
    const vague = branches.find((b) => !b.includes("/"));
    if (vague !== undefined) {
      throw new Unverifiable(`"${name}" resolves to ${JSON.stringify(vague)}, which is not a path — cannot be judged`);
    }
    branches = branches.map(normaliseShopifyGlobals);
    return { raw, branches, verifiable: true };
  } catch (e) {
    if (e instanceof Unverifiable) return { raw, branches: [], verifiable: false, why: e.message };
    throw e;
  }
}

/**
 * Every LINK the file is responsible for. "Link" is not the same as "href": a
 * section can build a URL and hand it to a snippet where the href actually
 * lives — marathon-home.liquid does exactly that via `render 'marathon-rail',
 * rail_url: …` — so `*_url:` render arguments count too. The leading `,` or `(`
 * requirement keeps it from matching the `| image_url:` FILTER.
 *
 * Comments and schema are stripped FIRST: an href inside a {% comment %} once
 * satisfied the coverage guard while every real link was broken.
 */
function fileLinks(rawSrc) {
  const src = stripComments(rawSrc);
  const map = assignBranches(src);
  const out = [];
  for (const h of src.matchAll(/href="([^"]*)"/g)) {
    const raw = h[1];
    const v = raw.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    out.push(linkFrom(raw, v ? v[1] : raw, map, Boolean(v)));
  }
  for (const a of src.matchAll(/[,(]\s*(\w+_url):\s*([\w.]+)/g)) {
    const [, argName, value] = a;
    out.push(linkFrom(`${argName}: ${value}`, value, map, true));
  }
  return out;
}

// ─── WHAT THIS TEST CANNOT SEE ───────────────────────────────────────────────
// Said plainly, because claiming exhaustiveness is how this file went wrong five
// times. It reads Liquid SOURCE with regexes; it does not render it. It has been
// mutation-proven against fifteen concrete regression shapes, and it will not
// catch:
//
//   • a URL assembled at RUNTIME from data it cannot see — a metafield, a
//     setting, a value that only exists once Shopify renders the page;
//   • control flow: it treats every assignment branch as possible and never
//     works out which one actually runs;
//   • a link built by markup this parser does not model (a `{% for %}` building
//     handles, a `{% liquid %}` echo, a link emitted from JavaScript).
//
// It is a convention check, not a proof. The honest way to close the remaining
// gap is to render the sections with liquidjs and assert on the OUTPUT hrefs —
// that needs a devDependency, which is a decision for the owner rather than a
// thing to slip into a test file.

describe("every /collections/all link carries an explicit sort", () => {
  // ANY explicit sort, not one specific value. The property being protected is
  // "never inherit collections.all's title-ascending default" — the navigation
  // states created-descending, and the sort control's own links state whichever
  // the shopper picked. Both are explicit; requiring one literal value would
  // have failed the sort control the moment it was actually checked.
  const SORT = "sort_by=";
  const files = { "marathon-nav.liquid": NAV, "marathon-grid.liquid": GRID, "marathon-home.liquid": HOME };

  for (const [name, path] of Object.entries(files)) {
    it(name, () => {
      const links = fileLinks(readFileSync(path, "utf8"));
      expect(links.length, `${name}: no links found — did the markup change?`).toBeGreaterThan(0);

      // Both failure kinds in ONE assertion, so an unverifiable link cannot mask
      // a genuinely unsorted one sitting behind it.
      const problems = [];
      for (const link of links) {
        if (link.verifiable === false) { problems.push(`UNVERIFIABLE ${link.raw} — ${link.why}`); continue; }
        for (const branch of link.branches) {
          // JUDGE ON QUOTE-STRIPPED TEXT. A resolved branch keeps the quotes of
          // the literal it came from, so `{{ coll_base }}/all` with
          // `coll_base = '/collections'` substituted to `'/collections'/all` —
          // which does not contain "/collections/all", because a quote sits in
          // the middle of it. Stripping quotes can only JOIN text that Liquid
          // would also join, so it cannot invent a match that the rendered page
          // would not have.
          const text = branch.replace(/['"]/g, "");
          if (text.includes("/collections/all") && !text.includes(SORT)) {
            problems.push(`ALPHABETICAL ${link.raw} -> ${branch.trim()}`);
          }
        }
      }
      expect(problems, `${name}: link problems`).toEqual([]);

      const covered = links.filter((l) => l.branches.some((b) => b.replace(/['"]/g, "").includes("/collections/all")));
      expect(
        covered.length,
        `${name}: no /collections/all links found — this test has stopped covering anything`
      ).toBeGreaterThan(0);
    });
  }

  it("the aria-current comparisons stay query-free", () => {
    // request.path carries no query string, so anything compared against it must
    // not pick up the sort — otherwise no row is ever highlighted.
    const src = stripComments(readFileSync(NAV, "utf8"));
    const map = assignBranches(src);
    for (const m of src.matchAll(/request\.path\s*==\s*(\w+)/g)) {
      const name = m[1];
      if (!map.has(name)) continue;
      let branches;
      try { branches = map.get(name).flatMap((b) => expand(b, map)); }
      catch (e) { throw new Error(`${name} cannot be resolved: ${e.message}`); }
      for (const branch of branches) {
        expect(branch, `${name} is compared to request.path but carries a query`).not.toContain("sort_by");
      }
    }
  });
});

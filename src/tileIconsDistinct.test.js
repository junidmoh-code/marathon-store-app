// ─── NO TWO HOME TILES MAY WEAR THE SAME ICON ─────────────────────────────────
// Run: npx vitest run src/tileIconsDistinct.test.js
//
// The home screen is a wall of ~20 tiles. When two of them draw the same picture
// the icon stops being a way to find anything and the label does all the work —
// which is the same as having no icon. This happened three separate ways before
// this guard existed, and none of them were noticed by a person reading a diff:
//
//   • ONE ICON, MANY TILES. RoleIcons.insights was the icon for Internal
//     Insights, Inventory Health, Marketing AND Engine Policy; RoleIcons.stock
//     for Stock, Barcodes AND Print Labels. Adding a tile and reaching for the
//     nearest existing icon is the path of least resistance, and nothing pushed
//     back.
//   • TWO KEYS, ONE PICTURE. shopify_publish and assistant were separate entries
//     holding byte-identical path data. A duplicate you cannot see by grepping
//     for the key name.
//   • A NEW TILE LANDING ON AN OLD SHAPE. The Social tile arrived from another
//     branch with a speaker-and-waves while Group Broadcast already had a horn.
//     Two branches, each correct alone.
//
// So the check is on the RENDERED SHAPES, not the key names: every icon's
// geometry is normalised (whitespace and comments stripped) and compared. Two
// entries that draw the same thing fail even if they are spelled differently.
//
// This reads src/App.jsx as text rather than importing it — App.jsx is a ~17k
// line module that pulls in Firebase at import time, and none of that is needed
// to compare SVG geometry.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const APP = readFileSync(join(process.cwd(), "src", "App.jsx"), "utf8");

// The RoleIcons object literal, as source text.
function roleIconsBody(source = APP) {
  const start = source.indexOf("const RoleIcons = {");
  expect(start, "RoleIcons was renamed or removed — this guard needs updating").toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  return source.slice(start, end);
}

// key -> the drawable geometry, with comments and ALL whitespace removed, so
// `0 0 2 2` and `002 2` compare equal. Anything that is not a shape element is
// dropped: the wrapping <svg>'s own attributes are identical on every icon and
// would mask a real difference.
function shapesByKey(source = APP) {
  const body = roleIconsBody(source);
  const entry = /^ {2}([a-z_]+): \(([\s\S]*?)\n {2}\),/gm;
  const out = {};
  let m;
  while ((m = entry.exec(body))) {
    const svg = m[2].replace(/\/\/.*$/gm, "");
    const shapes = (svg.match(/<(path|rect|circle|line|polyline|ellipse|polygon)[^>]*\/?>/g) || []).join("");
    out[m[1]] = shapes.replace(/\s+/g, "");
  }
  return out;
}

// Every `icon:RoleIcons.x` on a home tile, with the tile key it belongs to.
function tileIcons(source = APP) {
  const re = /key:"([a-z_]+)",\s*icon:RoleIcons\.([a-z_]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push({ tile: m[1], icon: m[2] });
  return out;
}

describe("home tile icons are all different", () => {
  it("finds the icon set at all", () => {
    const shapes = shapesByKey();
    expect(Object.keys(shapes).length).toBeGreaterThan(15);
    // Every entry must actually draw something — an icon that parsed to an empty
    // string would make every other entry trivially "distinct" from it.
    for (const [key, shape] of Object.entries(shapes)) {
      expect(shape, `RoleIcons.${key} parsed to no shapes`).not.toBe("");
    }
  });

  it("no two icons draw the same shape", () => {
    const byShape = {};
    for (const [key, shape] of Object.entries(shapesByKey())) {
      (byShape[shape] = byShape[shape] || []).push(key);
    }
    const dupes = Object.values(byShape).filter((keys) => keys.length > 1);
    expect(dupes, `these RoleIcons entries draw identical pictures: ${dupes.map((d) => d.join(" + ")).join("; ")}`).toEqual([]);
  });

  it("no icon is used by more than one tile", () => {
    const used = {};
    for (const { tile, icon } of tileIcons()) (used[icon] = used[icon] || []).push(tile);
    const shared = Object.entries(used).filter(([, tiles]) => tiles.length > 1);
    expect(shared, `these icons are shared across tiles: ${shared.map(([i, t]) => `${i} -> ${t.join(", ")}`).join("; ")}`).toEqual([]);
  });

  it("every tile points at an icon that exists", () => {
    const shapes = shapesByKey();
    for (const { tile, icon } of tileIcons()) {
      expect(shapes[icon], `tile "${tile}" points at RoleIcons.${icon}, which is not defined`).toBeDefined();
    }
  });
});

// MUTATION PROOF. A guard that cannot go red is decoration, and each of the
// three ways this actually broke needs its own attempted mutation — they are
// caught by different assertions, so one mutant would not prove the other two.
describe("the guard would catch each way this has actually broken", () => {
  it("catches two keys holding byte-identical geometry", () => {
    const mutated = APP.replace(
      "const RoleIcons = {",
      `const RoleIcons = {\n  clone_a: (\n    <svg><path d="M1 1h2"/>\n    </svg>\n  ),\n  clone_b: (\n    <svg><path d="M1 1h2"/>\n    </svg>\n  ),`,
    );
    const byShape = {};
    for (const [key, shape] of Object.entries(shapesByKey(mutated))) {
      (byShape[shape] = byShape[shape] || []).push(key);
    }
    expect(Object.values(byShape).some((keys) => keys.length > 1)).toBe(true);
  });

  it("catches the same geometry spelled with different whitespace", () => {
    const mutated = APP.replace(
      "const RoleIcons = {",
      `const RoleIcons = {\n  spaced_a: (\n    <svg><path d="M1 1 h2"/>\n    </svg>\n  ),\n  spaced_b: (\n    <svg><path d="M1 1h2"/>\n    </svg>\n  ),`,
    );
    const shapes = shapesByKey(mutated);
    expect(shapes.spaced_a).toBe(shapes.spaced_b);
  });

  it("catches one icon being reused by a second tile", () => {
    const mutated = `${APP}\n// { key:"a_new_tile", icon:RoleIcons.stock, name:"X" }\nkey:"a_new_tile", icon:RoleIcons.stock`;
    const used = {};
    for (const { tile, icon } of tileIcons(mutated)) (used[icon] = used[icon] || []).push(tile);
    expect(Object.values(used).some((tiles) => tiles.length > 1)).toBe(true);
  });
});

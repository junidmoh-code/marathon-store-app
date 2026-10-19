// ─── THE STYLE GUIDE: THE MARKDOWN AND THE JSON SAY THE SAME THING ───────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseStyleGuide } = require("../lib/style-guide-parse.cjs");

const MD = fs.readFileSync(path.join(__dirname, "../../docs/style-guide.md"), "utf8");
const JSON_GUIDE = require("../lib/style-guide.json");

describe("style guide", () => {
  test("style-guide.json is docs/style-guide.md, rebuilt (run scripts/social/build-style-guide.mjs)", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(parseStyleGuide(MD))), JSON_GUIDE);
  });

  test("the guide has the brief's looks, palette families and hard rules", () => {
    const g = parseStyleGuide(MD);
    for (const k of ["clean-monochrome", "earth-tone-street", "sport-luxe", "prep-casual"]) assert.ok(g.looks.find((l) => l.key === k), k);
    assert.equal(g.rules.maxAccentHues, 1);
    assert.equal(g.rules.maxLoudPieces, 1);
    assert.equal(g.rules.maxFormalitySpread, 2);
    assert.equal(g.palette.white.family, "light");
    assert.equal(g.palette.olive.family, "earth");
    assert.equal(g.seasons[1], "summer");
    assert.equal(g.seasons[7], "winter");
    const w = ["weightColour", "weightSilhouette", "weightFamily", "weightFormality", "weightSeason", "weightLook", "weightFresh"];
    assert.equal(w.reduce((s, k) => s + g.rules[k], 0), 100, "the weights are points out of 100");
  });

  test("an escaped pipe stays inside its cell; a header breaks on it", () => {
    const g = parseStyleGuide(MD);
    const mono = g.looks.find((l) => l.key === "clean-monochrome");
    assert.deepEqual(mono.header, ["CLEAN", "MONOCHROME"]);
    assert.deepEqual(mono.core, [["tee", "jacket"], ["bottoms"], ["sneakers"]]);
  });

  test("a typo is refused with the table and the row", () => {
    assert.throws(() => parseStyleGuide(MD.replace("| olive | earth |", "| olive | erth |")), /palette row \d+: family "erth"/);
    assert.throws(() => parseStyleGuide(MD.replace("| earth>=2 |", "| earthy |")), /looks row 2: requires "earthy"/);
    assert.throws(() => parseStyleGuide(MD.replace("| tee, bottoms, sneakers | hat, bag | shorts, summer |", "| tee, shoes, sneakers | hat, bag | shorts, summer |")), /slot "shoes"/);
    assert.throws(() => parseStyleGuide(MD.replace("| tieWindow | 6 |", "| tieWindow | six |")), /"tieWindow" needs a number/);
    assert.throws(() => parseStyleGuide(MD.replace(/\| 12 \| summer \|\n/, "")), /month 12 has no season/);
  });
});

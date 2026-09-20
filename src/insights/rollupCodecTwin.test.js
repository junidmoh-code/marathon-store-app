// ─── THE TWO HALVES OF THE CODEC ARE THE SAME CODE ───────────────────────────
//
// A Cloud Function writes the day rollups; this bundle reads them. One is
// CommonJS, the other ESM, so the shared block lives in both files.
//
// Two copies of an encoder and a decoder that must agree is the shape of a bug
// that surfaces months later as "the numbers moved" — the writer gained a
// column, the reader did not, and every row after it shifted by one. So the
// duplication is allowed and POLICED: this compares the two blocks character
// for character, and it compares behaviour on the same real trading day.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as esm from "./rollupCodec";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const cjs = require_("../../functions/insightsRollup/rollupCodec.cjs");

const BEGIN = "/* ─── SHARED:BEGIN";
const END = "/* ─── SHARED:END";

function sharedBlockOf(url) {
  const src = readFileSync(url, "utf8");
  const from = src.indexOf(BEGIN);
  const to = src.indexOf(END);
  if (from < 0 || to < 0) throw new Error(`no SHARED markers in ${url}`);
  return src.slice(from, to);
}

describe("rollupCodec — the CommonJS half and the ESM half", () => {
  it("share a byte-identical block", () => {
    const a = sharedBlockOf(new URL("./rollupCodec.js", import.meta.url));
    const b = sharedBlockOf(new URL("../../functions/insightsRollup/rollupCodec.cjs", import.meta.url));
    expect(a).toBe(b);
  });

  it("agree on the row layout", () => {
    expect(esm.ROLLUP_SHAPE).toBe(cjs.ROLLUP_SHAPE);
    expect(esm.COL).toEqual(cjs.COL);
    expect(esm.COL_COUNT).toBe(cjs.COL_COUNT);
    expect(esm.DICTS).toEqual(cjs.DICTS);
    expect(esm.KEPT_FIELDS).toEqual(cjs.KEPT_FIELDS);
  });

  it("produce the same node, and read each other's, on a real trading day", () => {
    const day = JSON.parse(
      readFileSync(new URL("./__fixtures__/day-2026-09-18.json", import.meta.url), "utf8"),
    );
    const events = Object.keys(day).sort().map((k) => day[k]);
    const meta = { date: "2026-09-18", anchorMs: Date.parse("2026-09-18T00:00:00.000+02:00") };

    const written = cjs.compactDay(events, meta);          // the function writes
    const read = esm.expandDay(written);                   // the browser reads
    expect(read).toEqual(events.map(cjs.keptFieldsOf));

    // and the other way round, so neither half can drift into being the only
    // one that is right.
    expect(esm.compactDay(events, meta)).toEqual(written);
    expect(cjs.expandDay(esm.compactDay(events, meta))).toEqual(read);
  });
});

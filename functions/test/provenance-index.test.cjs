// ─── /stock_provenance INDEX CONTRACT ─────────────────────────────────────────
// MUTATION-PROVED. Each test names, in its own comment, the edit that must break
// it. None of these rebuild carriesByIndex/indexReady and compare against a
// re-implementation — every expectation is a literal written by hand from the
// contract, so a bug copied into the test cannot pass it.

const test = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const idx = require("../lib/provenance-index.cjs");

test("carriesByIndex: a sale at the location is sufficient on its own", () => {
  // MUTATION: delete the `if (n(entry.s) > 0) return true;` line → this fails.
  // A shop that sold the line but whose stocked counter is empty (POS-written
  // sales, or history older than any transfer we hold) must still carry it.
  assert.strictEqual(idx.carriesByIndex({ s: 1 }), true);
  assert.strictEqual(idx.carriesByIndex({ s: 9 }), true);
});

test("carriesByIndex: net stocked units decide when there is no sale", () => {
  // MUTATION: change `n(entry.k) - n(entry.u) > 0` to `n(entry.k) > 0` → the
  // fully-undone case below flips to true and the 2026-08-17 loop returns.
  assert.strictEqual(idx.carriesByIndex({ k: 4 }), true);
  assert.strictEqual(idx.carriesByIndex({ k: 4, u: 4 }), false);   // fully undone
  assert.strictEqual(idx.carriesByIndex({ k: 4, u: 1 }), true);    // partial undo leaves real stock
  assert.strictEqual(idx.carriesByIndex({ k: 4, u: 9 }), false);   // over-undone still refuses
});

test("carriesByIndex: THE INCIDENT — marathon-pe, 2026-08-17, both sweatshirts", () => {
  // The exact folded counters from the live ledger for
  //   p1786452575638 @ marathon-pe : stocked 4, unstocked 4, one collection
  //   p1786453234097 @ marathon-pe : stocked 5, unstocked 5, one collection
  // and for trophy, the shop that actually trades them.
  //
  // MUTATION: any change that lets a collection or a fully-undone fulfil count →
  // one of these four assertions fails. This is the regression fixture for the
  // whole change; if it ever goes green the wrong way, the bug is back.
  assert.strictEqual(idx.carriesByIndex({ k: 4, u: 4 }), false, "navy @ marathon-pe must NOT carry");
  assert.strictEqual(idx.carriesByIndex({ k: 5, u: 5 }), false, "grey @ marathon-pe must NOT carry");
  assert.strictEqual(idx.carriesByIndex({ s: 6, k: 10 }), true, "navy @ trophy must carry");
  assert.strictEqual(idx.carriesByIndex({ s: 8, k: 11 }), true, "grey @ trophy must carry");
});

test("carriesByIndex: absent, malformed and hostile entries never arm", () => {
  // MUTATION: relax the type guard, or `n()`'s isFinite check → one of these arms.
  for (const bad of [null, undefined, {}, [], "yes", 7, true, { s: "3" }, { k: NaN }, { k: Infinity }, { s: null }, { k: -5 }]) {
    assert.strictEqual(idx.carriesByIndex(bad), false, `${JSON.stringify(bad)} must not arm`);
  }
});

test("indexReady: only a complete, current sentinel licenses arming", () => {
  // MUTATION: drop any clause of indexReady → one of these passes when it must not.
  const good = { "marathon-pe": { at: "2026-08-17T10:00:00.000Z", pairs: 2467, version: idx.INDEX_VERSION } };
  assert.strictEqual(idx.indexReady(good, "marathon-pe"), true);

  assert.strictEqual(idx.indexReady(good, "trophy"), false, "a location with no sentinel is NOT ready");
  assert.strictEqual(idx.indexReady(null, "marathon-pe"), false, "an unreadable meta node is NOT ready");
  assert.strictEqual(idx.indexReady({}, "marathon-pe"), false);
  assert.strictEqual(idx.indexReady({ "marathon-pe": { at: "x", pairs: 1, version: idx.INDEX_VERSION + 1 } }, "marathon-pe"), false, "a future/older index version is NOT ready");
  assert.strictEqual(idx.indexReady({ "marathon-pe": { pairs: 1, version: idx.INDEX_VERSION } }, "marathon-pe"), false, "no timestamp");
  assert.strictEqual(idx.indexReady({ "marathon-pe": { at: "", pairs: 1, version: idx.INDEX_VERSION } }, "marathon-pe"), false, "empty timestamp");
  assert.strictEqual(idx.indexReady({ "marathon-pe": { at: "x", version: idx.INDEX_VERSION } }, "marathon-pe"), false, "no pair count");
  assert.strictEqual(idx.indexReady({ "marathon-pe": true }, "marathon-pe"), false, "a truthy non-object is NOT ready");
  assert.strictEqual(idx.indexReady({ "marathon-pe": [] }, "marathon-pe"), false, "an array is NOT ready");
  // A location legitimately holding nothing is still READY — zero pairs is a fact,
  // not a failure. Without this, an empty shop could never be armed at all.
  assert.strictEqual(idx.indexReady({ x: { at: "2026-08-17T10:00:00.000Z", pairs: 0, version: idx.INDEX_VERSION } }, "x"), true);
});

test("provenanceEntry: one lookup, no ledger, hostile shapes refused", () => {
  const index = { "marathon-pe": { p1: { k: 3 }, p2: "junk", p3: [] } };
  assert.deepStrictEqual(idx.provenanceEntry(index, "marathon-pe", "p1"), { k: 3 });
  assert.strictEqual(idx.provenanceEntry(index, "marathon-pe", "p2"), null);
  assert.strictEqual(idx.provenanceEntry(index, "marathon-pe", "p3"), null);
  assert.strictEqual(idx.provenanceEntry(index, "marathon-pe", "nope"), null);
  assert.strictEqual(idx.provenanceEntry(index, "trophy", "p1"), null);
  assert.strictEqual(idx.provenanceEntry(null, "marathon-pe", "p1"), null);
});

test("toRecord omits zeroes — the stored shape is what the bandwidth note claims", () => {
  // MUTATION: write zero fields anyway → this fails. The node is read on all 49
  // engine runs a day; storing `u: 0` on ~8,400 pairs is paid for every time.
  assert.deepStrictEqual(idx.toRecord({ sold: 0, stockedUnits: 0, unstockedUnits: 0 }), {});
  assert.deepStrictEqual(idx.toRecord({ sold: 2, stockedUnits: 0, unstockedUnits: 0 }), { s: 2 });
  assert.deepStrictEqual(idx.toRecord({ sold: 0, stockedUnits: 4, unstockedUnits: 4 }), { k: 4, u: 4 });
  assert.deepStrictEqual(idx.toRecord({}), {});
  // A record that round-trips to nothing must also read as "does not carry", or an
  // omitted-zero pair would behave differently from a stored-zero one.
  assert.strictEqual(idx.carriesByIndex(idx.toRecord({ sold: 0, stockedUnits: 4, unstockedUnits: 4 })), false);
});

test("applyMovement writes to the SAME root the engine reads", () => {
  // applyMovement.js duplicates the root string rather than importing this CommonJS
  // module into the browser bundle. If the two ever disagree, the app maintains an
  // index nobody reads and the engine reads one nobody maintains — a silent, total
  // failure with no error anywhere. So both declarations are read and compared.
  const app = readFileSync(path.join(__dirname, "../../src/components/stock/applyMovement.js"), "utf8");
  const m = app.match(/const PROVENANCE_ROOT = "([^"]+)";/);
  assert.ok(m, "applyMovement.js must declare PROVENANCE_ROOT as a string literal");
  assert.strictEqual(m[1], idx.PROVENANCE_ROOT, "applyMovement and the engine disagree about the index root");
  // …and it must actually be used to build the write paths, not merely declared.
  assert.match(app, /\$\{PROVENANCE_ROOT\}\/\$\{prov\.loc\}\/\$\{movement\.productId\}/);
  // The three counters, and only those three (the rules reject any fourth key).
  for (const k of ["s", "k", "u"]) {
    assert.ok(app.includes("`${base}/" + k + "`"), `applyMovement must maintain the '${k}' counter`);
  }
  // Written with increment(), never a read-modify-write: two devices landing a
  // movement in the same instant must both count.
  assert.match(app, /= increment\(1\);/);
  assert.match(app, /= increment\(prov\.qty\);/);
});

test("paths are stable — the rules in PROVENANCE-RULES.md are written against these", () => {
  assert.strictEqual(idx.PROVENANCE_ROOT, "stock_provenance");
  assert.strictEqual(idx.locPath("marathon-pe"), "stock_provenance/marathon-pe");
  assert.strictEqual(idx.pairPath("marathon-pe", "p1"), "stock_provenance/marathon-pe/p1");
  assert.strictEqual(idx.metaPath("marathon-pe"), "stock_provenance/_meta/marathon-pe");
});

// ── THE CROSS-MODULE PIN ─────────────────────────────────────────────────────
// carriesByIndex (CommonJS, required by refill-engine.cjs) and
// carriesByProvenance (ESM, imported by the app and the backfill) are the same
// predicate expressed twice because they live in different module systems. A
// one-line predicate duplicated across a module boundary is exactly the drift this
// repo has paid for, so both sources are read and the shapes compared.
test("the ESM and CJS predicates cannot drift apart", () => {
  const esm = readFileSync(path.join(__dirname, "../../src/components/stock/provenanceClass.js"), "utf8");
  const cjs = readFileSync(path.join(__dirname, "../lib/provenance-index.cjs"), "utf8");

  // The ESM side must still short-circuit on sales and net the undos.
  assert.match(esm, /if \(entry\.sold > 0\) return true;/, "ESM predicate must arm on a sale");
  assert.match(esm, /entry\.stockedUnits - entry\.unstockedUnits > 0/, "ESM predicate must net undos");
  // The CJS side must do the same, on the short keys.
  assert.match(cjs, /if \(n\(entry\.s\) > 0\) return true;/, "CJS predicate must arm on a sale");
  assert.match(cjs, /n\(entry\.k\) - n\(entry\.u\) > 0/, "CJS predicate must net undos");

  // And they must agree on the same inputs, checked through both real functions
  // rather than by reasoning about the text above.
  const { execFileSync } = require("node:child_process");
  const probe = `
    import { carriesByProvenance } from ${JSON.stringify(path.join(__dirname, "../../src/components/stock/provenanceClass.js"))};
    const cases = [
      { sold: 0, stockedUnits: 0, unstockedUnits: 0 },
      { sold: 1, stockedUnits: 0, unstockedUnits: 0 },
      { sold: 0, stockedUnits: 4, unstockedUnits: 4 },
      { sold: 0, stockedUnits: 4, unstockedUnits: 1 },
      { sold: 0, stockedUnits: 0, unstockedUnits: 3 },
      { sold: 6, stockedUnits: 10, unstockedUnits: 0 },
    ];
    process.stdout.write(JSON.stringify(cases.map(carriesByProvenance)));
  `;
  const esmAnswers = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" }));
  const cjsAnswers = [
    { s: 0, k: 0, u: 0 }, { s: 1, k: 0, u: 0 }, { s: 0, k: 4, u: 4 },
    { s: 0, k: 4, u: 1 }, { s: 0, k: 0, u: 3 }, { s: 6, k: 10, u: 0 },
  ].map(idx.carriesByIndex);
  assert.deepStrictEqual(cjsAnswers, esmAnswers, "the two predicates disagree — they have drifted");
  // Pin the expected answers literally too, so a bug present in BOTH is still caught.
  assert.deepStrictEqual(cjsAnswers, [false, true, false, true, false, true]);
});

// ── THE THIRD COPY — solveCarriage.js (PR #381) ──────────────────────────────
// Solve's gate duplicates BOTH the predicate (carriesByEntry) and the readiness
// check (indexReadyAt), plus a private INDEX_VERSION. The adversarial review's
// finding stands: "the pin is what makes the duplication safe", and the first
// version of the PR shipped without one. The functions are EXTRACTED FROM THE
// REAL SOURCE and executed here (the file's extensionless ESM imports keep it
// from loading directly under node), so a drift in either body fails this test,
// not just a drift in the lines the regexes happen to name.
test("solveCarriage.js cannot drift from the engine — predicate, readiness, and version", () => {
  const src = readFileSync(path.join(__dirname, "../../src/components/stock/solveCarriage.js"), "utf8");

  // The version is a private copy; pin its value to the engine's export.
  const ver = src.match(/const INDEX_VERSION = (\d+);/);
  assert.ok(ver, "solveCarriage.js must declare INDEX_VERSION");
  assert.strictEqual(Number(ver[1]), idx.INDEX_VERSION, "solveCarriage INDEX_VERSION drifted from provenance-index.cjs");

  const extract = (name) => {
    const m = src.match(new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `solveCarriage.js must export ${name}`);
    // eslint-disable-next-line no-new-func
    return new Function(`const INDEX_VERSION = ${idx.INDEX_VERSION}; ${m[0].replace("export ", "")}; return ${name};`)();
  };
  const carriesByEntry = extract("carriesByEntry");
  const indexReadyAt = extract("indexReadyAt");

  const entries = [
    null, {}, [], { s: 1 }, { s: 0 }, { k: 4, u: 4 }, { k: 4, u: 1 }, { u: 3 },
    { s: "2" }, { k: NaN }, { k: 5, u: -1 }, { s: -1, k: 1 }, { k: Infinity },
  ];
  assert.deepStrictEqual(
    entries.map(carriesByEntry),
    entries.map((e) => idx.carriesByIndex(Array.isArray(e) ? null : e)),
    "carriesByEntry disagrees with the engine's carriesByIndex",
  );

  const metas = [
    {}, null,
    { hub2: { at: "x", pairs: 1, version: idx.INDEX_VERSION } },
    { hub2: { at: "x", pairs: 1, version: idx.INDEX_VERSION + 1 } },
    { hub2: { at: "", pairs: 1, version: idx.INDEX_VERSION } },
    { hub2: { at: "x", version: idx.INDEX_VERSION } },
    { hub2: [] },
    { hub2: { at: "x", pairs: 0, version: idx.INDEX_VERSION } },
  ];
  assert.deepStrictEqual(
    metas.map((m) => indexReadyAt(m, "hub2")),
    metas.map((m) => idx.indexReady(m, "hub2")),
    "indexReadyAt disagrees with the engine's indexReady",
  );
});

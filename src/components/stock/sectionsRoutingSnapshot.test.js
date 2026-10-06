// ─── SECTION 2 ROUTES EXACTLY AS IT DID BEFORE SECTIONS EXISTED (CLIENT) ─────
//
// Every client-side routing decision for Marathon PE, Trophy, Hub 1 and Hub 2
// — Solve, first batch, Missing Products, Missing Sneakers, excess, sneaker
// sourcing, initial distribution, introduce-existing — computed over the
// SYNTHETIC routing fixture (functions/test/fixtures/sections-routing-fixture.json,
// written by make-sections-routing-fixture.cjs; nothing in it is real) and
// compared to a golden file written by the code as it stood on main BEFORE
// any routing change.
//
// The golden file is the "before". It is never regenerated to make a test
// pass: a difference means Section 2 routing changed, which is a
// stop-and-report condition for the sections work.
//
// Regenerating (only from an untouched checkout of the pre-sections commit):
//   SECTIONS_SNAPSHOT_WRITE=1 npx vitest run src/components/stock/sectionsRoutingSnapshot.test.js
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSizeKey } from "../../utils/sizeKey";
import { effectiveCategoryKey } from "../../utils/productTaxonomy";
import { seedLocations, resolvedRun, qualifyingSizes, solvePlan } from "./solvePlan";
import {
  firstBatchEligible, firstBatchSplit, buildPlacementIndex, firstBatchHistory, firstBatchStoreChoice,
} from "./firstBatchCore";
import { computeMissingProducts } from "./missingProductsCore";
import { computeMissingFootwear } from "./missingFootwearCore";
import { computeHubSneakerExcess, computeHubClothingExcess, computeHubExcess } from "./excessComputation";
import { resolveSneakerSourcing } from "./availabilityCore";
import { suggestInitialDistribution } from "./distributionSuggest";
import { computeUnintroduced, destsFrom, effectiveRun } from "./introduceExistingCore";

const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), "functions/test/fixtures/sections-routing-fixture.json"), "utf8"));
const GOLDEN_PATH = join(process.cwd(), "functions/test/fixtures/sections-routing-golden.client.json");
const STORES = ["marathon-pe", "trophy"];
const SOURCES = ["central", "hub2"];

function stable(v) {
  if (v instanceof Map) return stable(Object.fromEntries(v));
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v === undefined ? null : v;
}

// /stock as the screens hold it: size keys DECODED (useStockCells).
function decodeStock(stock) {
  const out = {};
  for (const loc of Object.keys(stock)) {
    out[loc] = {};
    for (const pid of Object.keys(stock[loc])) {
      out[loc][pid] = Object.fromEntries(Object.entries(stock[loc][pid] || {}).map(([k, c]) => [decodeSizeKey(k), c]));
    }
  }
  return out;
}

function compute(fixture = FIXTURE) {
  const { config, targets } = fixture;
  const allStock = decodeStock(fixture.stock);
  const products = Object.values(fixture.products);
  const byId = new Map(products.map((p) => [p.id, p]));
  const qtyAt = (loc, pid, sz) => Math.max(Number(allStock?.[loc]?.[pid]?.[sz]?.qty) || 0, 0);
  const index = buildPlacementIndex({ products, allStock });

  const solve = {};
  for (const p of products) {
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const run = resolvedRun({
      std: config.defaultRunByStore, subRun: config.subcategoryRunByLocation, subcategory: p.subcategory, sizes,
      targets, pid: p.id, ruleBasedTargets: config.ruleBasedTargets, categoryPolicy: config.categoryPolicy,
      categoryKey: effectiveCategoryKey(p),
      unitsAnywhere: (sz) => Object.keys(allStock).reduce((t, loc) => t + qtyAt(loc, p.id, sz), 0),
    });
    const history = firstBatchHistory({ pid: p.id, product: p, index, allStock, targets });
    const perStore = {};
    for (const store of STORES) for (const source of SOURCES) {
      const q = qualifyingSizes(sizes, source, store, run);
      const eligible = firstBatchEligible({ source, store, product: p, routes: config.routes, enabled: true, hub2Present: false });
      perStore[`${source}>${store}`] = {
        seed: seedLocations(source, store),
        qualifying: q,
        plan: solvePlan({ std: run, sizes: q, source, store, availAt: (loc, sz) => qtyAt(loc, p.id, sz) }),
        firstBatchEligible: eligible,
        firstBatchSplit: eligible
          ? firstBatchSplit({ sizes: q, run, store, centralAvail: (sz) => qtyAt("central", p.id, sz), maxUnitsPerIntent: config.maxUnitsPerIntent })
          : null,
      };
    }
    solve[p.id] = {
      run, perStore,
      storeChoice: firstBatchStoreChoice({ history, candidates: STORES }),
    };
  }

  const ctx = { products: fixture.products, stock: fixture.stock, targets, config };
  const reserved = new Map();
  const sneakerSourcing = {};
  const hubData = Object.fromEntries(["hub1", "hub2"].map((h) => [h, { ready: true, cells: allStock[h] || {}, promised: new Map() }]));
  for (const p of products.filter((x) => x.category === "Footwear")) {
    for (const tag of ["hub1", "hub2", "hub3"]) for (const size of p.sizes || []) {
      sneakerSourcing[`${p.id}|${tag}|${size}`] = resolveSneakerSourcing({ product: p, taggedHub: tag, size, hubData });
    }
  }

  return stable({
    solve,
    missingProducts: computeMissingProducts({ allStock, products }).map(({ photo, ...c }) => c),
    missingFootwear: computeMissingFootwear({ allStock, products }),
    sneakerExcess: computeHubSneakerExcess(ctx, reserved),
    clothingExcess: computeHubClothingExcess(ctx, reserved),
    allExcess: computeHubExcess(ctx, reserved),
    sneakerSourcing,
    initialDistribution: Object.fromEntries(products.map((p) => [p.id, suggestInitialDistribution({ product: p })])),
    introduceDests: destsFrom(config),
    introduceRuns: Object.fromEntries(destsFrom(config).map((l) => [l, effectiveRun(config, l)])),
    unintroduced: computeUnintroduced(allStock, targets, byId, destsFrom(config), config.categoryPolicy),
  });
}

if (process.env.SECTIONS_SNAPSHOT_WRITE === "1") {
  writeFileSync(GOLDEN_PATH, JSON.stringify(compute(), null, 1) + "\n");
}
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

describe("Section 2 client routing is unchanged", () => {
  const got = compute();

  it("the snapshot covers enough real decisions to mean something", () => {
    expect(Object.keys(GOLDEN.solve)).toHaveLength(130);
    const eligible = Object.values(GOLDEN.solve).flatMap((s) => Object.values(s.perStore)).filter((x) => x.firstBatchEligible).length;
    const solvable = Object.values(GOLDEN.solve).flatMap((s) => Object.values(s.perStore)).filter((x) => x.qualifying.length).length;
    expect(eligible).toBeGreaterThan(50);
    expect(solvable).toBeGreaterThan(50);
    expect(Object.keys(GOLDEN.sneakerSourcing).length).toBeGreaterThan(100);
  });

  for (const key of ["solve", "missingProducts", "missingFootwear", "sneakerExcess", "clothingExcess", "allExcess",
    "sneakerSourcing", "initialDistribution", "introduceDests", "introduceRuns", "unintroduced"]) {
    it(`${key}`, () => {
      expect(got[key]).toEqual(GOLDEN[key]);
    });
  }

  it("Section 1 stock being present or absent changes no Section 2 decision", () => {
    const f = JSON.parse(JSON.stringify(FIXTURE));
    delete f.stock.hub3;
    delete f.stock["marathon-pine"];
    const without = compute(f);
    for (const key of ["missingProducts", "sneakerExcess", "clothingExcess", "allExcess", "unintroduced", "introduceDests"]) {
      expect(without[key], key).toEqual(GOLDEN[key]);
    }
    for (const pid of Object.keys(GOLDEN.solve)) {
      for (const lane of Object.keys(GOLDEN.solve[pid].perStore)) {
        expect(without.solve[pid].perStore[lane].qualifying, `${pid} ${lane}`).toEqual(GOLDEN.solve[pid].perStore[lane].qualifying);
        expect(without.solve[pid].perStore[lane].seed).toEqual(GOLDEN.solve[pid].perStore[lane].seed);
      }
    }
  });
});

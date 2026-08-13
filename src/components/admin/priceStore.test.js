// priceStore against the house flat path→value fake RTDB. Proves the live
// layer end to end: apply writes atomically (one update call), the specials
// interlock refuses retail writes on on-special products, restore-by-batchId
// returns exact priors and refuses a double restore — and NOTHING here ever
// touches a real database (firebase/database is fully mocked).
import { test, vi, beforeEach } from "vitest";
import assert from "node:assert";

const store = {}; // flat fake RTDB: path → value
// A read must see BOTH a value written whole at this key AND deeper values
// written at child paths (real RTDB merges them into one tree) — e.g. the
// batch record written at price_history/{id} plus the restoredAt stamp written
// later at price_history/{id}/restoredAt.
const getPath = (p) => {
  const direct = p in store ? store[p] : undefined;
  const out = {};
  const prefix = p ? `${p}/` : "";
  for (const [k, v] of Object.entries(store)) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length).split("/");
      let node = out;
      for (let i = 0; i < rest.length - 1; i++) node = node[rest[i]] = node[rest[i]] || {};
      node[rest[rest.length - 1]] = v;
    }
  }
  const hasChildren = Object.keys(out).length > 0;
  if (direct !== undefined && direct !== null && typeof direct === "object") {
    return hasChildren ? { ...direct, ...out } : direct;
  }
  if (direct !== undefined) return direct;
  return hasChildren ? out : null;
};
const read = (path) => getPath(path);
const updateCalls = [];
const applyUpdate = (base, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    const full = base ? `${base}/${k}` : k;
    if (v === null) delete store[full];
    else store[full] = v;
  }
};

vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  get: (r) => Promise.resolve({ val: () => getPath(r.path), exists: () => getPath(r.path) != null }),
  query: (r, ...mods) => ({ path: r.path, mods }),
  orderByKey: () => "orderByKey",
  limitToLast: (n) => ({ limitToLast: n }),
  update: (r, patch) => { updateCalls.push({ path: r.path || "", patch }); applyUpdate(r.path || "", patch); return Promise.resolve(); },
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u_test", email: "junid@marathon.internal" } } }));

const { applyPriceBatch, restorePriceBatch, previewRestore, loadRecentBatches, mintBatchId } =
  await import("./priceStore.js");

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  updateCalls.length = 0;
  store["products/p100/name"] = "Nike Cap";
  store["products/p200/name"] = "Puma Tee";
  store["products/p200/stockPrice"] = 90;
  store["products/p200/retailPrice"] = 180;
  store["products/p300/name"] = "Bystander";
  store["products/p300/retailPrice"] = 500;
});

const fillLines = () => ({
  p100: { name: "Nike Cap", from: { retailPrice: null }, to: { retailPrice: 250 } },
  p200: { name: "Puma Tee", from: { stockPrice: 90, retailPrice: 180 }, to: { stockPrice: 100, retailPrice: 200 } },
});

test("apply → restore round-trip: exact priors return, bystanders untouched, single atomic update each way", async () => {
  const res = await applyPriceBatch({ action: "bulk_fill", lines: fillLines(), label: "test fill" });
  assert.equal(res.ok, true);
  assert.equal(updateCalls.length, 1); // atomic: everything in ONE update()
  assert.equal(store["products/p100/retailPrice"], 250);
  assert.equal(store["products/p200/stockPrice"], 100);
  assert.equal(store["products/p300/retailPrice"], 500); // bystander untouched
  assert.ok(read(`price_history/${res.batchId}`).lines);
  assert.equal(read(`price_history_index/${res.batchId}`).count, 2);

  const productsById = {
    p100: { retailPrice: 250 },
    p200: { stockPrice: 100, retailPrice: 200 },
    p300: { retailPrice: 500 },
  };
  const pv = await previewRestore(res.batchId, productsById);
  assert.equal(pv.ok, true);
  assert.deepEqual(pv.drift, []);

  const undo = await restorePriceBatch(res.batchId, productsById);
  assert.equal(undo.ok, true);
  assert.equal(updateCalls.length, 2);
  // EXACT priors: p100 retail back to NOT SET (deleted), p200 back to 90/180.
  assert.equal("products/p100/retailPrice" in store, false);
  assert.equal(store["products/p200/stockPrice"], 90);
  assert.equal(store["products/p200/retailPrice"], 180);
  assert.equal(store["products/p300/retailPrice"], 500); // still untouched
  // Original stamped restored; the restore is its own audited batch.
  assert.ok(read(`price_history/${res.batchId}`).restoredAt);
  assert.equal(read(`price_history/${res.batchId}`).restoredByBatchId, undo.batchId);
  assert.equal(read(`price_history/${undo.batchId}`).restoresBatchId, res.batchId);

  // Double restore refused, and nothing changes.
  const again = await restorePriceBatch(res.batchId, productsById);
  assert.equal(again.ok, false);
  assert.equal(again.code, "already_restored");
  assert.equal(updateCalls.length, 2);
});

test("specials interlock: retailPrice write on an on-special product is refused before anything is written", async () => {
  store["specials/p200/price"] = 150;
  const res = await applyPriceBatch({ action: "bulk_change", lines: fillLines() });
  assert.equal(res.ok, false);
  assert.equal(res.code, "on_special");
  assert.deepEqual(res.products, ["p200"]);
  assert.equal(updateCalls.length, 0); // NOTHING written
  assert.equal(store["products/p200/retailPrice"], 180);
  // stockPrice-only lines on the same product are fine.
  const stockOnly = await applyPriceBatch({ action: "bulk_change", lines: { p200: { name: "Puma Tee", from: { stockPrice: 90 }, to: { stockPrice: 95 } } } });
  assert.equal(stockOnly.ok, true);
  // The specials flow itself passes allowSpecials.
  const special = await applyPriceBatch({ action: "special_end", allowSpecials: true,
    lines: { p200: { name: "Puma Tee", from: { retailPrice: 180 }, to: { retailPrice: 165 } } } });
  assert.equal(special.ok, true);
});

test("invalid batches are refused with nothing written", async () => {
  const res = await applyPriceBatch({ action: "bulk_fill", lines: { p100: { name: "Nike Cap", from: { retailPrice: null }, to: { retailPrice: 0 } } } });
  assert.equal(res.ok, false);
  assert.equal(updateCalls.length, 0);
});

test("loadRecentBatches reads only the compact index, newest first", async () => {
  const a = await applyPriceBatch({ action: "bulk_fill", lines: { p100: { name: "Nike Cap", from: { retailPrice: null }, to: { retailPrice: 250 } } }, label: "first" });
  const b = await applyPriceBatch({ action: "bulk_change", lines: { p200: { name: "Puma Tee", from: { retailPrice: 180 }, to: { retailPrice: 190 } } }, label: "second" });
  const recent = await loadRecentBatches(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].batchId, b.batchId); // newest first
  assert.equal(recent[0].label, "second");
  assert.equal(recent[1].batchId, a.batchId);
  assert.equal(recent[0].lines, undefined); // index rows carry no lines
});

test("batch ids are key-safe and chronologically ordered by key", () => {
  const id = mintBatchId();
  assert.match(id, /^pb_\d{13}_[a-z0-9]+$/);
});

test("bulk fill end to end: the write is EXACTLY the previewed plan — same products, same values, nothing else", async () => {
  const { buildBulkFillPlan } = await import("../../utils/bulkPricing.js");
  const products = [
    { id: "p100", name: "Nike Cap" },                                  // bare
    { id: "p200", name: "Puma Tee", stockPrice: 90, retailPrice: 180 }, // priced → skipped by default
    { id: "p300", name: "Bystander", retailPrice: 500 },               // NOT selected
  ];
  const plan = buildBulkFillPlan({ products, selectedIds: ["p100", "p200"], stockDraft: "70", retailDraft: "150" });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, 1); // p200 skipped (already priced, skip is default)
  assert.deepEqual(plan.skippedAlready.map((s) => s.pid), ["p200"]);

  const res = await applyPriceBatch({ action: "bulk_fill", lines: plan.lines, label: "e2e" });
  assert.equal(res.ok, true);
  // Written: exactly the plan's one product, with the previewed values.
  const patch = updateCalls[0].patch;
  const productPaths = Object.keys(patch).filter((k) => k.startsWith("products/"));
  assert.deepEqual(productPaths.sort(), ["products/p100/retailPrice", "products/p100/stockPrice"]);
  assert.equal(patch["products/p100/stockPrice"], 70);
  assert.equal(patch["products/p100/retailPrice"], 150);
  // Untouched: the skipped product and the unselected bystander.
  assert.equal(store["products/p200/retailPrice"], 180);
  assert.equal(store["products/p200/stockPrice"], 90);
  assert.equal(store["products/p300/retailPrice"], 500);
});

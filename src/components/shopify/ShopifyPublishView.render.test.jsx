// Pins the Shopify Publishing page's load discipline and review flow: the
// page mounts with sections COLLAPSED and no row mounted, expanding a section
// fetches bodies for exactly its reviewed pids, rows render original name +
// live-checked input + condition chips, the Awaiting filter keeps a
// condition-only node visible, Approve writes through the store and advances
// focus to the next unreviewed row, and a refused write surfaces its message.
// Store fully mocked — no live data, no network.
import { test, expect, vi, beforeEach } from "vitest";
import React from "react";
import { create, act } from "react-test-renderer";

const calls = { approve: [], nodesFor: [] };
let keys = new Set();
let pipeline = {};
let bodies = {};
let approveResult = { ok: true };

vi.mock("./shopifyPublishStore", () => ({
  loadPublishKeys: () => Promise.resolve(keys),
  loadPipelineNodes: () => Promise.resolve(pipeline),
  loadNodesFor: (pids) => {
    calls.nodesFor.push([...pids]);
    const nodes = {};
    for (const pid of pids) if (bodies[pid]) nodes[pid] = bodies[pid];
    return Promise.resolve({ nodes, failed: [] });
  },
  // The real store's writes return the committed node on success — the view
  // folds it straight into state instead of refetching. Mirror that contract.
  approveName: (pid, node, name) => {
    calls.approve.push({ pid, name });
    return Promise.resolve(approveResult.ok
      ? { ok: true, node: { ...(node || {}), state: node?.state || "none", cleanName: name, cleanNameSource: "manual", nameApprovedAt: 1 } }
      : approveResult);
  },
  nominateProduct: (pid, node) => Promise.resolve({ ok: true, node: { ...(node || {}), state: "nominated" } }),
  withdrawNomination: (pid, node) => Promise.resolve({ ok: true, node: { ...(node || {}), state: "none" } }),
  setCondition: (pid, node, condition) => Promise.resolve({ ok: true, node: { ...(node || {}), condition, state: node?.state || "none" } }),
}));

const { default: ShopifyPublishView } = await import("./ShopifyPublishView.jsx");

const PRODUCTS = [
  { id: "p1", name: "Plain tee black", category: "Clothing", subcategory: "Tees" },
  { id: "p2", name: "Plain tee white", category: "Clothing", subcategory: "Tees" },
  { id: "p3", name: "Court sneaker grey", category: "Footwear", subcategory: "Sneakers" },
];

const flush = async () => { await act(() => Promise.resolve()); await act(() => Promise.resolve()); };
const texts = (tree) => JSON.stringify(tree.toJSON());
const focused = [];
// react-test-renderer re-invokes createNodeMock on every element UPDATE; a
// fresh object each call reads as a changed instance, so React detaches and
// re-attaches the ref on each row re-render — real DOM nodes don't do that.
// Memoise per input identity (placeholder|value is stable in these tests) so
// refs behave like the browser's.
const mockCache = new Map();
const nodeMock = (el) => {
  if (el.type !== "input") return {};
  const key = `${el.props.placeholder}|${el.props.value}`;
  if (!mockCache.has(key)) {
    mockCache.set(key, { focus: () => focused.push(el.props.value), scrollIntoView: () => {} });
  }
  return mockCache.get(key);
};

beforeEach(() => {
  mockCache.clear();
  calls.approve.length = 0;
  calls.nodesFor.length = 0;
  focused.length = 0;
  keys = new Set();
  pipeline = {};
  bodies = {};
  approveResult = { ok: true };
});

test("mounts with sections collapsed — no rows, no body fetches", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("Clothing");
  expect(out).toContain("Footwear");
  expect(out).not.toContain("Plain tee black"); // rows only exist after expand
  expect(calls.nodesFor.length).toBe(0);
});

test("expanding fetches only that section's reviewed pids and renders rows", async () => {
  keys = new Set(["p2"]);
  bodies.p2 = { state: "none", cleanName: "Basic tee white", cleanNameSource: "manual", nameApprovedAt: 5 };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const clothing = tree.root.findAll((n) => n.type === "div" && n.children.includes("Clothing"))[0];
  await act(() => { clothing.parent.props.onClick(); });
  await flush();
  expect(calls.nodesFor).toEqual([["p2"]]); // p1 has no node key — no body read
  const out = texts(tree);
  expect(out).toContain("Plain tee black");   // original name shown
  expect(out).toContain("Excellent");         // condition chips present
  expect(out).toContain("APPROVED");          // p2's chip from its body
  expect(out).not.toContain("Court sneaker"); // Footwear stays collapsed
});

test("Awaiting filter keeps a condition-only node visible", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "none", condition: "Excellent — no visible wear" }; // seen but never name-approved
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const awaiting = tree.root.findAll((n) => n.type === "button" && n.children.includes("Awaiting review"))[0];
  await act(() => { awaiting.props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("Clothing"); // section survives the filter
});

test("Enter approves through the store and focus advances to the next unreviewed row", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const clothing = tree.root.findAll((n) => n.type === "div" && n.children.includes("Clothing"))[0];
  await act(() => { clothing.parent.props.onClick(); });
  await flush();
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.placeholder !== "Search products…");
  await act(() => { inputs[0].props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(calls.approve).toEqual([{ pid: "p1", name: "Plain tee black" }]);
  expect(focused.length).toBe(1); // cursor moved to the next unreviewed input
});

test("a refused write surfaces its message in the row", async () => {
  approveResult = { ok: false, message: "Not saved — the database refused this write." };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const clothing = tree.root.findAll((n) => n.type === "div" && n.children.includes("Clothing"))[0];
  await act(() => { clothing.parent.props.onClick(); });
  await flush();
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.placeholder !== "Search products…");
  await act(() => { inputs[0].props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(texts(tree)).toContain("the database refused this write");
});

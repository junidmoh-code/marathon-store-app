// Pins the Shopify Publishing page's load discipline and review flow: the
// page mounts with sections COLLAPSED and no row mounted, expanding a section
// fetches bodies for exactly its reviewed pids, rows render original name +
// live-checked input + condition chips, the Awaiting filter keeps a
// condition-only node visible, Enter-approve writes through the store and
// advances focus, a refused write surfaces its message — and the 2026-08-14
// publish flow: Publish opens the page's ONE confirmation dialog (naming the
// cleaned name and the storefront), confirm writes desiredState intent, the
// Live filter splits into On/Off groups, and switching OFF asks nothing.
// Store fully mocked — no live data, no network.
import { test, expect, vi, beforeEach } from "vitest";
import React from "react";
import { create, act } from "react-test-renderer";

const calls = { approve: [], publish: [], desired: [], nodesFor: [] };
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
      ? { ok: true, node: { ...(node || {}), state: node?.state || "awaiting", cleanName: name, cleanNameSource: "manual", nameApprovedAt: 1 } }
      : approveResult);
  },
  publishProduct: (pid, node, name) => {
    calls.publish.push({ pid, name });
    return Promise.resolve({ ok: true, node: { ...(node || {}), state: "awaiting", cleanName: name, nameApprovedAt: 1, desiredState: "on" } });
  },
  setDesiredState: (pid, node, want) => {
    calls.desired.push({ pid, want });
    return Promise.resolve({ ok: true, node: { ...(node || {}), state: node?.state || "awaiting", desiredState: want } });
  },
  setCondition: (pid, node, condition) => Promise.resolve({ ok: true, node: { ...(node || {}), condition, state: node?.state || "awaiting" } }),
}));

const { default: ShopifyPublishView } = await import("./ShopifyPublishView.jsx");

const COND = "Very good — light cosmetic marks";
const PRODUCTS = [
  { id: "p1", name: "Plain tee black", category: "Clothing", subcategory: "Tees", retailPrice: 199, photoUrl: "https://x/p1.jpg" },
  { id: "p2", name: "Plain tee white", category: "Clothing", subcategory: "Tees" },
  { id: "p3", name: "Court sneaker grey", category: "Footwear", subcategory: "Sneakers", retailPrice: 899 },
];

const flush = async () => { await act(() => Promise.resolve()); await act(() => Promise.resolve()); };
const texts = (tree) => JSON.stringify(tree.toJSON());
const focused = [];
// react-test-renderer re-invokes createNodeMock on every element UPDATE; a
// fresh object each call reads as a changed instance, so React detaches and
// re-attaches the ref on each row re-render — real DOM nodes don't do that.
// Memoise per input identity (placeholder|value is stable in these tests) so
// refs behave like the browser's. Buttons get a focus() too — the dialog's
// cancel button takes default focus on mount.
const mockCache = new Map();
const nodeMock = (el) => {
  if (el.type === "button") return { focus: () => focused.push("cancel-button") };
  if (el.type !== "input") return {};
  const key = `${el.props.placeholder}|${el.props.value}`;
  if (!mockCache.has(key)) {
    mockCache.set(key, { focus: () => focused.push(el.props.value), scrollIntoView: () => {} });
  }
  return mockCache.get(key);
};

const button = (tree, label) =>
  tree.root.findAll((n) => n.type === "button" && n.children.includes(label))[0];

const openClothing = async (tree) => {
  const clothing = tree.root.findAll((n) => n.type === "div" && n.children.includes("Clothing"))[0];
  await act(() => { clothing.parent.props.onClick(); });
  await flush();
};

beforeEach(() => {
  mockCache.clear();
  calls.approve.length = 0;
  calls.publish.length = 0;
  calls.desired.length = 0;
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
  bodies.p2 = { state: "awaiting", cleanName: "Basic tee white", cleanNameSource: "manual", nameApprovedAt: 5 };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  expect(calls.nodesFor).toEqual([["p2"]]); // p1 has no node key — no body read
  const out = texts(tree);
  expect(out).toContain("Plain tee black");   // original name shown
  expect(out).toContain("Excellent");         // condition chips present
  expect(out).toContain("APPROVED");          // p2's chip from its body
  expect(out).not.toContain("Court sneaker"); // Footwear stays collapsed
});

test("Awaiting filter keeps a condition-only node visible", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", condition: "Excellent — no visible wear" }; // seen but never name-approved
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const awaiting = button(tree, "Awaiting review");
  await act(() => { awaiting.props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("Clothing"); // section survives the filter
});

test("Enter approves through the store and focus advances to the next unreviewed row", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.placeholder !== "Search products…");
  await act(() => { inputs[0].props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(calls.approve).toEqual([{ pid: "p1", name: "Plain tee black" }]);
  expect(calls.publish.length).toBe(0);         // Enter NEVER publishes
  expect(focused).toContain("Plain tee white"); // cursor moved to the next unreviewed input
});

test("a refused write surfaces its message in the row", async () => {
  approveResult = { ok: false, message: "Not saved — the database refused this write." };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.placeholder !== "Search products…");
  await act(() => { inputs[0].props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(texts(tree)).toContain("the database refused this write");
});

test("Publish without a condition refuses BEFORE any dialog", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("Pick a condition grade first");
  expect(out).not.toContain("public storefront");
  expect(calls.publish.length).toBe(0);
});

test("Publish opens the confirmation naming the cleaned name; confirm writes intent; row shows pending", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", cleanNameSource: "manual", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  let out = texts(tree);
  expect(out).toContain("Put on the public storefront?");
  expect(out).toContain("Basic tee black");     // the compliance-critical field, shown in full
  expect(out).toContain(COND);
  expect(out).toContain("R 199.00");
  expect(out).toContain('"1"," photo"'); // photo count (JSX splits the text nodes)
  expect(focused).toContain("cancel-button");    // cancel is the default focus
  await act(() => { button(tree, "Put it live").props.onClick(); });
  await flush();
  expect(calls.publish).toEqual([{ pid: "p1", name: "Basic tee black" }]);
  expect(texts(tree)).toContain("PUBLISHING");   // pending until the reconciler confirms
});

test("cancel closes the dialog without writing", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  await act(() => { button(tree, "Cancel").props.onClick(); });
  await flush();
  expect(calls.publish.length).toBe(0);
  expect(calls.desired.length).toBe(0);
  expect(texts(tree)).not.toContain("Put on the public storefront?");
});

test("Live filter splits into On and Off groups; OFF needs no dialog; ON re-confirms", async () => {
  keys = new Set(["p1", "p3"]);
  pipeline = {
    p1: { state: "live", liveState: "on",  desiredState: "on",  cleanName: "Basic tee black", condition: COND },
    p3: { state: "live", liveState: "off", desiredState: "off", cleanName: "Court low grey",  condition: COND },
  };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Live").props.onClick(); });
  await flush();
  let out = texts(tree);
  expect(out).toContain("On — visible to customers");
  expect(out).toContain("Off — on Shopify, not published");
  expect(out).not.toContain("Plain tee black"); // groups collapsed until opened

  // open the ON group, flip p1 off — intent written straight away, no dialog
  const onHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("On — visible to customers"))[0];
  await act(() => { onHeader.parent.props.onClick(); });
  await flush();
  await act(() => { button(tree, "Off").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }]);
  expect(texts(tree)).not.toContain("Put on the public storefront?");

  // open the OFF group, switching p3 ON goes through the dialog
  const offHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("Off — on Shopify, not published"))[0];
  await act(() => { offHeader.parent.props.onClick(); });
  await flush();
  const onButtons = tree.root.findAll((n) => n.type === "button" && n.children.includes("On") && !n.props.disabled);
  await act(() => { onButtons[0].props.onClick(); });
  await flush();
  out = texts(tree);
  expect(out).toContain("Put on the public storefront?");
  expect(out).toContain("Court low grey");
  await act(() => { button(tree, "Put it live").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }, { pid: "p3", want: "on" }]);
});

test("an ON row locks its name input; a dirty live-off row refuses the switch until saved", async () => {
  keys = new Set(["p1", "p3"]);
  pipeline = {
    p1: { state: "live", liveState: "on",  desiredState: "on",  cleanName: "Basic tee black", condition: COND },
    p3: { state: "live", liveState: "off", desiredState: "off", cleanName: "Court low grey",  condition: COND },
  };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Live").props.onClick(); });
  await flush();
  for (const label of ["On — visible to customers", "Off — on Shopify, not published"]) {
    const header = tree.root.findAll((n) => n.type === "div" && n.children.includes(label))[0];
    await act(() => { header.parent.props.onClick(); });
    await flush();
  }
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.placeholder !== "Search products…");
  const onInput = inputs.find((n) => n.props.value === "Basic tee black");
  const offInput = inputs.find((n) => n.props.value === "Court low grey");
  expect(onInput.props.disabled).toBe(true);   // ON — customers see this name; locked
  expect(offInput.props.disabled).toBe(false); // OFF — still editable
  // edit the off row's name, then try to switch it On without saving
  await act(() => { offInput.props.onChange({ target: { value: "Court low grey v2" } }); });
  await flush();
  const onButtons = tree.root.findAll((n) => n.type === "button" && n.children.includes("On") && !n.props.disabled);
  await act(() => { onButtons[0].props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("Save the edited name first");
  expect(out).not.toContain("Put on the public storefront?"); // no dialog on a dirty row
  expect(calls.desired.length).toBe(0);
});

test("a pending publish says it waits for the reconciler and shows Cancel, which writes desiredState off", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND, desiredState: "on" };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  expect(texts(tree)).toContain("PUBLISHING");
  // Not just a chip: the row states in words that a reconciler run is what
  // it's waiting on (owner feedback — the pending marker alone didn't tell
  // Junid that a separate script has to run).
  expect(texts(tree)).toContain("waiting for the reconciler run");
  await act(() => { button(tree, "Cancel").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }]);
});

test("a live row shows when it went live and its Shopify admin link", async () => {
  keys = new Set(["p1"]);
  const liveAt = new Date("2026-08-10T09:00:00Z").getTime();
  pipeline = {
    p1: { state: "live", liveState: "on", desiredState: "on", cleanName: "Basic tee black",
          condition: COND, liveAt, adminUrl: "https://admin.shopify.com/store/nu3ei8-0p/products/123" },
  };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Live").props.onClick(); });
  await flush();
  const onHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("On — visible to customers"))[0];
  await act(() => { onHeader.parent.props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain(`Went live ${new Date(liveAt).toLocaleDateString()}`);
  const link = tree.root.findAll((n) => n.type === "a")[0];
  expect(link.props.href).toBe("https://admin.shopify.com/store/nu3ei8-0p/products/123");
});

test("home badge counts only never-seen products — live and blocked are excluded", async () => {
  // The badge prices "awaiting review" as key ABSENCE: any product with a
  // /shopify_publish node (live, blocked, or merely seen) is out of the count.
  const { useShopifyAwaitingCount } = await import("./ShopifyPublishView.jsx");
  keys = new Set(["p1", "p3"]); // p1 live, p3 blocked — both have nodes
  let seen = null;
  function Probe() { seen = useShopifyAwaitingCount(PRODUCTS, true); return null; }
  await act(() => { create(<Probe />); });
  await flush();
  expect(seen).toBe(1); // only p2 has never been reviewed
});

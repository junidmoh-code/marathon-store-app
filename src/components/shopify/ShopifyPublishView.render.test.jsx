// Pins the Shopify Publishing page's load discipline and the 2026-08-14
// list→page split: the page mounts with sections COLLAPSED and no row
// mounted, expanding a section fetches bodies for exactly its reviewed pids,
// rows are NAVIGATION (tap → the product's own page at #shopify/{pid}, back
// restores the list's scroll and open sections) with only the batch checkbox
// and the condition chips interactive in place — and the product page owns
// everything else: the live-checked name editor, the photo picker, the
// description preview (the EXACT pushed template), Publish behind the ONE
// confirmation dialog, the live On/Off switch, the pending Cancel.
// Store fully mocked — no live data, no network, no DOM (minimal window stub,
// same pattern as UserManagement.gate.test.jsx).
import { test, expect, vi, beforeEach } from "vitest";
import React from "react";
import { create, act } from "react-test-renderer";

// ── A minimal window — hash routing + scroll restoration need one ───────────
// location.hash is a real accessor so assigning it fires the hashchange
// listeners exactly like a browser; history.back() clears it the same way.
const hashListeners = new Set();
const scrollToCalls = [];
let hashValue = "";
// Drives window.history.length: 1 = a tab opened directly on the URL (nothing
// to pop), >1 = navigated here in-app.
let historyLength = 2;
const fakeLocation = {};
Object.defineProperty(fakeLocation, "hash", {
  get: () => hashValue,
  set: (v) => {
    hashValue = v === "" || String(v).startsWith("#") ? String(v) : `#${v}`;
    for (const fn of [...hashListeners]) fn();
  },
});
const fakeWindow = {
  addEventListener: (ev, fn) => { if (ev === "hashchange") hashListeners.add(fn); },
  removeEventListener: (ev, fn) => { hashListeners.delete(fn); },
  location: fakeLocation,
  history: { back: () => { fakeLocation.hash = ""; }, get length() { return historyLength; } },
  scrollY: 0,
  scrollTo: (...args) => scrollToCalls.push(args),
};
globalThis.window = fakeWindow;
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());

const calls = { approve: [], publish: [], desired: [], nodesFor: [], photos: [] };
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
  setPublishPhotos: (pid, node, photos) => {
    calls.photos.push({ pid, photos });
    return Promise.resolve({ ok: true, node: { ...(node || {}), state: node?.state || "awaiting", photos } });
  },
}));
// photoTools reaches firebase storage — mock it out entirely (uploads are
// exercised by their own unit layer, not the render tests).
vi.mock("./photoTools", () => ({
  uploadFileProblem: () => null,
  compressImageFile: () => Promise.resolve(new Blob()),
  uploadPublishPhoto: () => Promise.resolve("https://firebasestorage.googleapis.com/up.jpg"),
}));

const { default: ShopifyPublishView } = await import("./ShopifyPublishView.jsx");

const COND = "Very good — light cosmetic marks";
const PRODUCTS = [
  { id: "p1", name: "Plain tee black", category: "Clothing", subcategory: "Tees", retailPrice: 199, photoUrl: "https://x/p1.jpg" },
  { id: "p2", name: "Plain tee white", category: "Clothing", subcategory: "Tees", photoUrl: "https://x/p2.jpg" },
  { id: "p3", name: "Court sneaker grey", category: "Footwear", subcategory: "Sneakers", retailPrice: 899, photoUrl: "https://x/p3.jpg" },
];

const flush = async () => { await act(() => Promise.resolve()); await act(() => Promise.resolve()); };
const texts = (tree) => JSON.stringify(tree.toJSON());
const focused = [];
// react-test-renderer re-invokes createNodeMock on every element UPDATE; a
// fresh object each call reads as a changed instance, so React detaches and
// re-attaches the ref on each re-render — real DOM nodes don't do that.
// Memoise per input identity so refs behave like the browser's. Buttons get a
// focus() too — the dialog's cancel button takes default focus on mount.
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

// The row's navigable area: the pointer div carrying this product's original
// name (checkbox and condition chips stop propagation and stay out of it).
// TestInstance children are circular — collect text recursively, no stringify.
const textOf = (inst) =>
  inst.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const rowFor = (tree, originalName) =>
  tree.root.findAll((n) => n.type === "div" && typeof n.props.onClick === "function" &&
    n.props.style?.cursor === "pointer" &&
    textOf(n).includes(originalName))[0];

const openProductPage = async (tree, originalName) => {
  await act(() => { rowFor(tree, originalName).props.onClick(); });
  await flush();
};

const goBack = async () => {
  await act(() => { fakeWindow.history.back(); });
  await flush();
};

// The page's name editor — the only TEXT input on the product page (the
// photo picker carries a hidden type="file" input; keep it out).
const pageNameInput = (tree) =>
  tree.root.findAll((n) => n.type === "input" && n.props.type !== "checkbox" &&
    n.props.type !== "file" && n.props.placeholder !== "Search products…")[0];

beforeEach(() => {
  mockCache.clear();
  calls.approve.length = 0;
  calls.publish.length = 0;
  calls.desired.length = 0;
  calls.nodesFor.length = 0;
  calls.photos.length = 0;
  focused.length = 0;
  scrollToCalls.length = 0;
  hashValue = "";
  historyLength = 2;
  hashListeners.clear();
  fakeWindow.scrollY = 0;
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

test("expanding fetches only that section's reviewed pids; rows show the cleaned name read-only", async () => {
  keys = new Set(["p2"]);
  bodies.p2 = { state: "awaiting", cleanName: "Basic tee white", cleanNameSource: "manual", nameApprovedAt: 5,
                photos: ["https://firebasestorage.googleapis.com/a.jpg", "https://firebasestorage.googleapis.com/b.jpg"] };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  expect(calls.nodesFor).toEqual([["p2"]]); // p1 has no node key — no body read
  const out = texts(tree);
  expect(out).toContain("Plain tee black");   // original name shown
  expect(out).toContain("Basic tee white");   // the cleaned name, as text
  expect(out).toContain("Excellent");         // condition chips stay in the list (batch needs them)
  expect(out).toContain("APPROVED");          // p2's chip from its body
  expect(out).toContain('"2"," photo"');      // publishing-set count on the row (JSX splits text nodes)
  expect(out).not.toContain("Court sneaker"); // Footwear stays collapsed
  // The list holds NO name editor — editing lives on the product page.
  const inputs = tree.root.findAll((n) => n.type === "input" && n.props.type !== "checkbox" && n.props.placeholder !== "Search products…");
  expect(inputs.length).toBe(0);
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

test("tapping a row opens the product page; back restores the list, its open section and its scroll", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  fakeWindow.scrollY = 333; // where the list sat when the row was tapped
  await openProductPage(tree, "Plain tee black");
  expect(fakeWindow.location.hash).toBe("#shopify/p1");
  let out = texts(tree);
  expect(out).toContain("SHOPIFY PRODUCT");           // the page, not the list
  expect(out).toContain("In the shop system:");       // original name for reference
  expect(pageNameInput(tree).props.value).toBe("Plain tee black"); // lexicon-cleaned draft
  await goBack();
  out = texts(tree);
  expect(out).toContain("SHOPIFY PUBLISHING");        // the list again
  expect(out).toContain("Plain tee black");           // Clothing still open — section state survived
  expect(scrollToCalls).toContainEqual([0, 333]);     // scroll restored
});

test("the row is keyboard-operable — Enter opens the product page", async () => {
  // The page owns every editing action now, so a row that only answers to a
  // mouse would put the whole flow out of a keyboard user's reach.
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const row = rowFor(tree, "Plain tee black");
  expect(row.props.role).toBe("button");
  expect(row.props.tabIndex).toBe(0);
  await act(() => { row.props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(fakeWindow.location.hash).toBe("#shopify/p1");
  expect(texts(tree)).toContain("SHOPIFY PRODUCT");
});

test("the navigable element contains NO other control", async () => {
  // Structural pin (reviewers, 2026-08-14). An element with role="button"
  // makes its descendants presentational to assistive technology, and a
  // keydown from a nested button bubbles to the row — where preventDefault
  // would cancel that button's own activation and navigate instead. So the
  // condition chips and the Shopify admin link must stay SIBLINGS of the
  // navigable element, never children of it.
  keys = new Set(["p1"]);
  pipeline = {
    p1: { state: "live", liveState: "off", desiredState: "off", cleanName: "Basic tee black",
          condition: COND, adminUrl: "https://admin.shopify.com/store/nu3ei8-0p/products/123" },
  };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const row = rowFor(tree, "Plain tee black");
  expect(row.props.role).toBe("button");
  // Condition chips and the admin link both render on the page...
  expect(tree.root.findAll((n) => n.type === "button" && n.children.includes("Excellent")).length).toBeGreaterThan(0);
  expect(tree.root.findAll((n) => n.type === "a").length).toBe(1);
  // ...and neither is inside the navigable element.
  expect(row.findAll((n) => n.type === "button", { deep: true }).length).toBe(0);
  expect(row.findAll((n) => n.type === "a", { deep: true }).length).toBe(0);
});

test("a hash change straight from one product to another does not carry the draft across", async () => {
  // Regression pin (reviewers, 2026-08-14): without key={detailPid} React
  // reconciles the page in place, so product A's unsaved name draft would sit
  // under product B's data — and saving would write A's text as B's public
  // listing name. Reachable without the list ever rendering in between: a
  // pasted #shopify/{pid} link, or forward/back across two product hashes.
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { fakeWindow.location.hash = "shopify/p1"; });
  await flush();
  const input = pageNameInput(tree);
  expect(input.props.value).toBe("Plain tee black");
  await act(() => { input.props.onChange({ target: { value: "TYPED FOR P1 ONLY" } }); });
  await flush();
  // Straight to another product — no list render in between.
  await act(() => { fakeWindow.location.hash = "shopify/p3"; });
  await flush();
  expect(pageNameInput(tree).props.value).toBe("Court sneaker grey"); // p3's own name, not p1's draft
  await act(() => { button(tree, "Save name").props.onClick(); });
  await flush();
  expect(calls.approve).toEqual([{ pid: "p3", name: "Court sneaker grey" }]);
});

test("Back works on a direct landing, where there is no history entry to pop", async () => {
  // A tab opened straight on #shopify/{pid} (shared link, bookmark, reload)
  // has nothing to pop; an unconditional history.back() would leave the user
  // stranded on the product with a dead Back button.
  hashValue = "#shopify/p1"; // landed here directly — the view never pushed it
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  expect(texts(tree)).toContain("SHOPIFY PRODUCT");
  const back = tree.root.findAll((n) => n.type === "span" && n.children.includes("← Publishing"))[0];
  await act(() => { back.parent.props.onClick(); });
  await flush();
  expect(fakeWindow.location.hash).toBe("");
  expect(texts(tree)).toContain("SHOPIFY PUBLISHING"); // back on the list
});

test("a hash pointing at a product that no longer exists returns to the list", async () => {
  hashValue = "#shopify/pGONE";
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  expect(fakeWindow.location.hash).toBe("");
  expect(texts(tree)).toContain("SHOPIFY PUBLISHING");
});

test("page: Save name writes through the store; Enter saves too and NEVER publishes", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  await act(() => { pageNameInput(tree).props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
  await flush();
  expect(calls.approve).toEqual([{ pid: "p1", name: "Plain tee black" }]);
  expect(calls.publish.length).toBe(0); // Enter NEVER publishes
  expect(texts(tree)).toContain("Name saved.");
});

test("page: a refused write surfaces its message", async () => {
  approveResult = { ok: false, message: "Not saved — the database refused this write." };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Save name").props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("the database refused this write");
});

test("page: Publish without a condition refuses BEFORE any dialog", async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("Pick a condition grade first");
  expect(out).not.toContain("public storefront");
  expect(calls.publish.length).toBe(0);
});

test("page: Publish opens the confirmation naming the cleaned name; confirm writes intent; page and row show pending", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", cleanNameSource: "manual", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
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
  // Not just a chip: the page states in words that a reconciler run is what
  // it's waiting on (owner feedback — the pending marker alone didn't tell
  // Junid that a separate script has to run).
  expect(texts(tree)).toContain("waiting for the reconciler run");
  await goBack();
  expect(texts(tree)).toContain("PUBLISHING");   // the row shows pending too
});

test("page: cancel closes the dialog without writing", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  await act(() => { button(tree, "Cancel").props.onClick(); });
  await flush();
  expect(calls.publish.length).toBe(0);
  expect(calls.desired.length).toBe(0);
  expect(texts(tree)).not.toContain("Put on the public storefront?");
});

test("Live filter splits into On and Off groups; the page's OFF needs no dialog; ON re-confirms", async () => {
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

  // open the ON group — the list row carries NO switch; the page does.
  const onHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("On — visible to customers"))[0];
  await act(() => { onHeader.parent.props.onClick(); });
  await flush();
  expect(tree.root.findAll((n) => n.type === "button" && n.children.includes("Off")).length).toBe(0);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Off").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }]);
  expect(texts(tree)).not.toContain("Put on the public storefront?"); // off asks nothing
  await goBack();

  // open the OFF group; switching p3 ON goes through the dialog on its page
  const offHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("Off — on Shopify, not published"))[0];
  await act(() => { offHeader.parent.props.onClick(); });
  await flush();
  await openProductPage(tree, "Court sneaker grey");
  await act(() => { button(tree, "On").props.onClick(); });
  await flush();
  out = texts(tree);
  expect(out).toContain("Put on the public storefront?");
  expect(out).toContain("Court low grey");
  await act(() => { button(tree, "Put it live").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }, { pid: "p3", want: "on" }]);
});

test("page: an ON product locks its name; a dirty live-off page refuses the switch until saved", async () => {
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
  await openProductPage(tree, "Plain tee black");
  expect(pageNameInput(tree).props.disabled).toBe(true); // ON — customers see this name; locked
  expect(texts(tree)).toContain("switch it off to rename");
  await goBack();
  await openProductPage(tree, "Court sneaker grey");
  const offInput = pageNameInput(tree);
  expect(offInput.props.disabled).toBe(false); // OFF — still editable
  await act(() => { offInput.props.onChange({ target: { value: "Court low grey v2" } }); });
  await flush();
  await act(() => { button(tree, "On").props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("Save the edited name first");
  expect(out).not.toContain("Put on the public storefront?"); // no dialog on a dirty page
  expect(calls.desired.length).toBe(0);
});

test("a pending publish: the row says it waits for the reconciler; the page carries the Cancel", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND, desiredState: "on" };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  expect(texts(tree)).toContain("PUBLISHING");
  expect(texts(tree)).toContain("waiting for the reconciler run");
  await openProductPage(tree, "Plain tee black");
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

test("page: the description preview is the EXACT pushed template, or the plain no-condition reason", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  const box = tree.root.findAll((n) => n.props?.dangerouslySetInnerHTML)[0];
  expect(box).toBeTruthy();
  // The template itself lives in publishShared.js (single-sourced with the
  // reconciler's push); the preview must carry the reviewed condition.
  expect(box.props.dangerouslySetInnerHTML.__html).toContain("Curated by Marathon Club");
  expect(box.props.dangerouslySetInnerHTML.__html).toContain(COND);
  await goBack();
  // No condition yet → no invented default, a plain reason instead.
  await openProductPage(tree, "Plain tee white");
  expect(tree.root.findAll((n) => n.props?.dangerouslySetInnerHTML).length).toBe(0);
  expect(texts(tree)).toContain("Pick a condition grade");
});

const COND2 = "Excellent — no visible wear";
const checkboxes = (tree) => tree.root.findAll((n) => n.type === "input" && n.props.type === "checkbox");

test("batch: a condition-unset row cannot be selected and says why inline", async () => {
  keys = new Set(["p2"]);
  bodies.p2 = { state: "awaiting", cleanName: "Basic tee white", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const boxes = checkboxes(tree);
  expect(boxes.length).toBe(2); // both awaiting rows offer the checkbox
  const disabled = boxes.filter((b) => b.props.disabled);
  expect(disabled.length).toBe(1); // p1 has no condition — unselectable, not silently skipped
  expect(texts(tree)).toContain("Can't batch-select");
  expect(texts(tree)).toContain("set a condition grade first");
});

test("batch: select-all, the shared confirmation lists every cleaned name, confirm writes one intent per product", async () => {
  keys = new Set(["p1", "p2"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  bodies.p2 = { state: "awaiting", cleanName: "Basic tee white", nameApprovedAt: 5, condition: COND2 };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await act(() => { button(tree, "Select all").props.onClick({ stopPropagation: () => {} }); });
  await flush();
  let out = texts(tree);
  expect(out).toContain('"2"," of ","25"," selected"'); // running count + the stated cap (JSX splits text nodes)
  await act(() => { button(tree, "Publish selected…").props.onClick(); });
  await flush();
  out = texts(tree);
  expect(out).toContain("public storefront");
  expect(out).toContain("Basic tee black");   // every product about to go live, by cleaned name
  expect(out).toContain("Basic tee white");
  expect(focused).toContain("cancel-button"); // cancel is the default focus, same as single publish
  await act(() => { button(tree, "Put 2 live").props.onClick(); });
  await flush();
  expect(calls.publish).toEqual([
    { pid: "p1", name: "Basic tee black" },
    { pid: "p2", name: "Basic tee white" },
  ]);
  out = texts(tree);
  expect(out).toContain("PUBLISHING");                      // rows now pending
  expect(out).toContain("until the reconciler runs");       // the notice says what happens next
  expect(out).not.toContain("Publish selected…");           // intents saved ⇒ selection emptied, bar gone
});

test("batch: cancel in the confirmation writes nothing and keeps the selection", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const box = checkboxes(tree).find((b) => !b.props.disabled);
  await act(() => { box.props.onChange(); });
  await flush();
  await act(() => { button(tree, "Publish selected…").props.onClick(); });
  await flush();
  await act(() => { button(tree, "Cancel").props.onClick(); });
  await flush();
  expect(calls.publish.length).toBe(0);
  expect(texts(tree)).toContain("Publish selected…"); // still selected, bar still up
});

test("page photo picker: always visible, reorder writes the full ordered list, last photo cannot be removed", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND,
                photos: ["https://firebasestorage.googleapis.com/a.jpg", "https://firebasestorage.googleapis.com/b.jpg"] };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  // The picker is part of the page — no chip to tap first.
  const thumbs = tree.root.findAll((n) => n.type === "img" && n.props.src === "https://firebasestorage.googleapis.com/b.jpg");
  expect(thumbs.length).toBe(1);
  expect(thumbs[0].props.loading).toBe("lazy");
  expect(texts(tree)).toContain("PRIMARY");
  // select the second thumb, move it left — the WHOLE ordered list is written
  await act(() => { thumbs[0].props.onClick(); });
  await flush();
  await act(() => { button(tree, "‹ Move").props.onClick(); });
  await flush();
  expect(calls.photos).toEqual([{ pid: "p1", photos: [
    "https://firebasestorage.googleapis.com/b.jpg",
    "https://firebasestorage.googleapis.com/a.jpg",
  ] }]);
  // now try to strip it to nothing: remove twice — the last one refuses.
  // The moved thumb keeps its selection after the write, so Remove is already
  // offered. (stripThumb filters to PICKER thumbs — they carry onClick.)
  const stripThumb = (src) => tree.root.findAll((n) =>
    n.type === "img" && n.props.src === src && typeof n.props.onClick === "function")[0];
  await act(() => { button(tree, "Remove from publish set").props.onClick(); });
  await flush();
  expect(calls.photos[1].photos).toEqual(["https://firebasestorage.googleapis.com/a.jpg"]);
  await act(() => { stripThumb("https://firebasestorage.googleapis.com/a.jpg").props.onClick(); });
  await flush();
  await act(() => { button(tree, "Remove from publish set").props.onClick(); });
  await flush();
  expect(calls.photos.length).toBe(2); // refused locally — no third write
  expect(texts(tree)).toContain("never ships imageless");
});

test("page photo picker: locked read-only while the listing is ON", async () => {
  keys = new Set(["p1"]);
  pipeline = { p1: { state: "live", liveState: "on", desiredState: "on", cleanName: "Basic tee black", condition: COND } };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Live").props.onClick(); });
  await flush();
  const onHeader = tree.root.findAll((n) => n.type === "div" && n.children.includes("On — visible to customers"))[0];
  await act(() => { onHeader.parent.props.onClick(); });
  await flush();
  await openProductPage(tree, "Plain tee black");
  expect(texts(tree)).toContain("switch it off to change photos");
  expect(tree.root.findAll((n) => n.type === "button" && n.children.includes("Remove from publish set")).length).toBe(0);
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

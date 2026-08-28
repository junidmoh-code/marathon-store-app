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
import { NAME_PROPOSAL_KEY } from "../../utils/visionNaming";
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

const calls = { approve: [], publish: [], desired: [], nodesFor: [], photos: [],
                applyProposal: [], dismissProposal: [], proposalPages: [] };
let keys = new Set();
let pipeline = {};
let bodies = {};
let approveResult = { ok: true };
let proposalWriteResult = { ok: true };
let proposalPages = [];
// Read-in-flight control — see loadNodesFor below.
let holdNodesFor = false;
// One-shot: the next loadNodesFor answers "failed" for everything it was asked
// for, then clears itself. Models a transient network blip on ONE batch.
let failNodesFor = false;
const heldReads = [];

vi.mock("./shopifyPublishStore", () => ({
  PROPOSAL_PAGE_SIZE: 300,
  // The lane's OWN read: lazy (only when the lane is selected) and bounded
  // (one page per call). `proposalPages` is the fake server's pages.
  loadProposalPage: ({ after = null } = {}) => {
    calls.proposalPages.push(after);
    const page = proposalPages.shift() || { nodes: {}, lastKey: null, done: true };
    return Promise.resolve(page);
  },
  applyNameProposal: (pid, node) => {
    calls.applyProposal.push(pid);
    const proposal = (node || {})[NAME_PROPOSAL_KEY];
    return Promise.resolve(proposalWriteResult.ok
      ? { ok: true, node: { ...(node || {}), cleanName: proposal.name, cleanNameSource: "ai",
                            nameApprovedAt: 1, [NAME_PROPOSAL_KEY]: { ...proposal, status: "applied" } } }
      : { ok: false, message: proposalWriteResult.message });
  },
  dismissNameProposal: (pid, node) => {
    calls.dismissProposal.push(pid);
    const proposal = (node || {})[NAME_PROPOSAL_KEY];
    return Promise.resolve({ ok: true,
      node: { ...(node || {}), [NAME_PROPOSAL_KEY]: { ...proposal, status: "rejected" } } });
  },
  loadPublishKeys: () => Promise.resolve(keys),
  loadPipelineNodes: () => Promise.resolve(pipeline),
  loadNodesFor: (pids) => {
    calls.nodesFor.push([...pids]);
    // The result is snapshotted at CALL time, exactly like a real read: what
    // the server hands back is what it held when the request went out.
    // ONE DATABASE. A per-pid read returns whatever /shopify_publish holds,
    // whichever fixture put it there — `bodies`, the pipeline query's result,
    // or a page of the proposal walk. Answering null for a node another
    // fixture declares would model a database that contradicts itself, and the
    // page (which reads bodies for the rows on screen and then FILLS, never
    // overwrites) would faithfully cache the contradiction.
    if (failNodesFor) { const f = [...pids]; failNodesFor = false; return Promise.resolve({ nodes: {}, failed: f }); }
    const held = (pid) =>
      bodies[pid] ?? pipeline?.[pid] ?? proposalPages.map((p) => p?.nodes?.[pid]).find(Boolean) ?? null;
    const nodes = {};
    for (const pid of pids) { const n = held(pid); if (n) nodes[pid] = n; }
    const result = { nodes, failed: [] };
    // `holdNodesFor` lets a test keep a read in flight while something else
    // happens — the only way to exercise a genuine read-vs-write race.
    if (!holdNodesFor) return Promise.resolve(result);
    return new Promise((resolve) => heldReads.push(() => resolve(result)));
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

const PROPOSAL = {
  name: "Brushed nubuck low-top in sand",
  source: "vision",
  previousName: "Sneaker",
  identity: { brand: "Nike", model: "Air Force 1", colourway: "Sand", confidence: 0.82,
              text: "Nike Air Force 1 Sand" },
  attempts: 1,
  visionModel: "gemini-3.7-flash",
  proposedAt: 1787000000000,
  status: "pending",
};

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

// Categories are gone — there is no Clothing section and nothing to open. The
// rows are simply there once the window's body fetch settles.
const openClothing = async () => { await flush(); };

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
  proposalWriteResult = { ok: true };
  proposalPages = [];
  calls.applyProposal.length = 0;
  calls.dismissProposal.length = 0;
  calls.proposalPages.length = 0;
  holdNodesFor = false;
  failNodesFor = false;
  heldReads.length = 0;
});

test("mounts on Awaiting review as ONE flat list — no category headings anywhere", async () => {
  // Categories are gone (owner instruction 2026-08-28). A heading between the
  // reviewer and the rows is exactly what this removed.
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const out = texts(tree);
  expect(out).not.toContain("Clothing");
  expect(out).not.toContain("Footwear");
  expect(out).toContain("Plain tee black");   // the rows are simply there
  expect(out).toContain("Court sneaker grey");
  // …and so are the three tabs, and only those three.
  expect(out).toContain("Live");
  expect(out).toContain("Awaiting review");
  expect(out).toContain("Suggested names");
  expect(out).not.toContain('"All"');
  // No node keys in this fixture ⇒ nothing to fetch. The window asks for the
  // bodies of rows on screen and nothing else.
  expect(calls.nodesFor.length).toBe(0);
});

test("the window fetches bodies for the rows on screen and no others; rows show the cleaned name read-only", async () => {
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
  expect(out).toContain("Court sneaker");     // one list — nothing is behind a heading any more
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
  await flush();
  // A node holding only a condition has NOT been name-approved, so it is still
  // awaiting — and it is a row, not a section that has to be opened first.
  expect(texts(tree)).toContain("Plain tee black");
  expect(texts(tree)).toContain("AWAITING REVIEW");
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

test("the row opens on SPACE too, and swallows the page-scroll default", async () => {
  // A div with role="button" gets no native activation, so Space has to be
  // handled explicitly — and its default (scroll the page) suppressed.
  // Pinned separately from Enter so an edit cannot quietly drop it.
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  const row = rowFor(tree, "Plain tee black");
  let prevented = false;
  await act(() => { row.props.onKeyDown({ key: " ", preventDefault: () => { prevented = true; } }); });
  await flush();
  expect(prevented).toBe(true);
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

test("Live is what is ON; a live-OFF product is filed under Awaiting review; OFF needs no dialog, ON re-confirms", async () => {
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
  // ONE list, and it holds only what a customer can actually see. The
  // live-but-OFF product is NOT here: it used to sit behind a second collapsed
  // heading inside this very tab, which is where 152 products went unnoticed.
  expect(out).not.toContain("On — visible to customers");
  expect(out).not.toContain("Off — on Shopify, not published");
  expect(out).toContain("Plain tee black");
  expect(out).not.toContain("Court sneaker grey");
  // The list row carries NO switch; the page does.
  expect(tree.root.findAll((n) => n.type === "button" && n.children.includes("Off")).length).toBe(0);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Off").props.onClick(); });
  await flush();
  expect(calls.desired).toEqual([{ pid: "p1", want: "off" }]);
  expect(texts(tree)).not.toContain("Put on the public storefront?"); // off asks nothing
  await goBack();

  // The live-OFF product is under Awaiting review — it is not on the shop and
  // it is not finished. Switching it ON goes through the dialog on its page.
  await act(() => { button(tree, "Awaiting review").props.onClick(); });
  await flush();
  await flush();
  expect(texts(tree)).toContain("Court sneaker grey");
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
  await flush(); // one flat list — nothing to expand
  await openProductPage(tree, "Plain tee black");
  expect(pageNameInput(tree).props.disabled).toBe(true); // ON — customers see this name; locked
  // The rename lock is no longer a dead sentence: it carries the action that
  // does the thing it tells you to do, and that action is what records
  // reasonCode "off_to_rename" (docs/PUBLISH-AUTO-OFF.md).
  expect(texts(tree)).toContain("it has to come off the shop to be renamed");
  expect(texts(tree)).toContain("Take it off the shop to rename");
  await goBack();
  // The live-OFF product is under Awaiting review now, not behind a second
  // heading inside Live.
  await act(() => { button(tree, "Awaiting review").props.onClick(); });
  await flush();
  await flush();
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
  await flush(); // the Live tab is one flat list — no group to open
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
  // Every awaiting row offers the checkbox, and there is no category boundary
  // any more — the whole catalogue is one list.
  expect(boxes.length).toBe(3);
  const disabled = boxes.filter((b) => b.props.disabled);
  expect(disabled.length).toBe(2); // p1 and p3 have no condition — unselectable, not silently skipped
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
  await act(() => { button(tree, "Select all shown").props.onClick({ stopPropagation: () => {} }); });
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
  await flush(); // the Live tab is one flat list — no group to open
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

// ─── KEEPING UP WITH THE RECONCILER ──────────────────────────────────────────
// The reconciler runs OUTSIDE the browser. Until now the page only re-asked on
// window focus, so the operator who publishes and then WATCHES — tab focused,
// never clicking away — was the one who never saw the answer: rows sat on
// "publishing…" and stayed in Awaiting review until a reload. These pin the
// pending poll and everything that has to stay correct as a row vanishes.

// A publish intent the reconciler has not applied. `nameApprovedAt` is what
// Publish stamps, so this reads as review state "approved".
const AWAITING_PENDING = {
  state: "awaiting", condition: COND, cleanName: "Plain tee black",
  nameApprovedAt: 1, desiredState: "on",
};
// The same intent on a node whose name was never signed off — a legacy node,
// or a grade set and the switch thrown without an approval. Review state
// "awaiting", so THIS is the shape that actually sits under the Awaiting
// review filter while pending.
const AWAITING_PENDING_UNAPPROVED = {
  state: "awaiting", condition: COND, cleanName: "Plain tee black", desiredState: "on",
};
const CONFIRMED_LIVE = {
  state: "live", liveState: "on", condition: COND, cleanName: "Plain tee black",
  desiredState: "on", liveAt: 1700000000000,
};

// Run body with fake timers, always restoring real ones.
const withFakeTimers = async (body) => {
  vi.useFakeTimers();
  try { await body(); } finally { vi.useRealTimers(); }
};

// CATEGORIES ARE GONE. There is nothing to expand: a tab renders one flat
// list and its window fetches the bodies for the rows on screen. The helper is
// kept as a no-op so the tests that used to call it still read as the same
// scenario, and so a test that reintroduces a section header fails loudly.
const openSection = async (tree) => {
  await flush();
  expect(tree.root.findAll((n) => n.type === "div" && n.children?.includes?.("Clothing")).length).toBe(0);
};

const mountOpen = async () => {
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await flush(); // the window's body fetch settles on the second tick
  return tree;
};

const setFilter = async (tree, label) => {
  await act(() => { button(tree, label).props.onClick(); });
  await flush();
};

// The reconciler lands its confirmation, then the page's own tick fires.
const reconcilerConfirms = async (pid, node) => {
  bodies[pid] = node;
  await act(async () => { vi.advanceTimersByTime(20000); });
  await flush();
};

test("a pending row reflects the reconciler's confirmation with no user action at all", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();
    expect(texts(tree)).toContain("PUBLISHING…");

    await reconcilerConfirms("p1", { ...CONFIRMED_LIVE });

    // No click, no focus event, no reload. The page opens on Awaiting review,
    // so the proof that the poll landed is that the row LEFT it — a product on
    // the shop is not awaiting anything.
    expect(texts(tree)).not.toContain("PUBLISHING…");
    expect(texts(tree)).not.toContain("Plain tee black");
    // …and it is on the Live tab, from the same state, with no further read.
    await setFilter(tree, "Live");
    expect(texts(tree)).toContain("ON — LIVE");
  });
});

test("a product that reaches live DISAPPEARS from the awaiting-review list", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING_UNAPPROVED } };
    const tree = await mountOpen();
    await setFilter(tree, "Awaiting review");
    expect(texts(tree)).toContain("Plain tee black");

    await reconcilerConfirms("p1", { ...CONFIRMED_LIVE });

    const out = texts(tree);
    expect(out).not.toContain("Plain tee black");
    expect(out).toContain("Plain tee white"); // the still-awaiting sibling stays
  });
});

test("the list's count drops with the row that went live", async () => {
  await withFakeTimers(async () => {
    // The count is the honest size of the tab, so it has to move when the tab
    // does. (It replaced the per-category count badge, which is gone with the
    // categories.)
    keys = new Set(["p3"]);
    bodies = { p3: { ...AWAITING_PENDING_UNAPPROVED, cleanName: "Court sneaker grey" } };
    const tree = await mountOpen();
    await setFilter(tree, "Awaiting review");
    expect(texts(tree)).toContain('"3"," product"');   // all three, one list
    expect(texts(tree)).toContain("Court sneaker grey");

    await reconcilerConfirms("p3", { ...CONFIRMED_LIVE, cleanName: "Court sneaker grey" });

    expect(texts(tree)).toContain('"2"," product"');
    expect(texts(tree)).not.toContain("Court sneaker grey");
  });
});

test("batch → pending → confirmed: the selection empties and STAYS empty as the rows go live", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1", "p2"]);
    bodies = {
      p1: { state: "awaiting", condition: COND, cleanName: "Plain tee black", nameApprovedAt: 5 },
      p2: { state: "awaiting", condition: COND, cleanName: "Plain tee white", nameApprovedAt: 5 },
    };
    const tree = await mountOpen();
    await act(() => { button(tree, "Select all shown").props.onClick({ stopPropagation: () => {} }); });
    await flush();
    expect(button(tree, "Publish selected…")).toBeTruthy();

    await act(() => { button(tree, "Publish selected…").props.onClick(); });
    await flush();
    await act(() => { button(tree, "Put 2 live").props.onClick(); });
    await flush();
    // Intents saved ⇒ both rows pending, selection emptied, bar gone.
    // NB the ellipsis: bare "PUBLISHING" also matches the page header.
    expect(button(tree, "Publish selected…")).toBeUndefined();
    expect(texts(tree)).toContain("PUBLISHING…");

    // Now the reconciler applies them, out of band, while the operator watches.
    bodies.p1 = { ...CONFIRMED_LIVE };
    bodies.p2 = { ...CONFIRMED_LIVE, cleanName: "Plain tee white" };
    await act(async () => { vi.advanceTimersByTime(20000); });
    await flush();

    const out = texts(tree);
    expect(out).not.toContain("PUBLISHING…");
    // The bar must not come back: a live product can never re-enter a batch.
    expect(button(tree, "Publish selected…")).toBeUndefined();
    expect(button(tree, "Select all shown")).toBeUndefined();
    await setFilter(tree, "Live");
    expect(texts(tree)).toContain("ON — LIVE");
  });
});

test("the Live tab picks the confirmed row up, with no reload", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    pipeline = {};
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();
    await setFilter(tree, "Live");
    // Nothing is on the shop yet, so the Live tab is empty.
    expect(texts(tree)).toContain("Nothing is on the shop yet.");

    await reconcilerConfirms("p1", { ...CONFIRMED_LIVE });

    const out = texts(tree);
    expect(out).not.toContain("Nothing is on the shop yet.");
  });
});

test("with nothing pending the page never polls — an idle page makes no requests", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { state: "awaiting", condition: COND, cleanName: "Plain tee black", nameApprovedAt: 1 } };
    const tree = await mountOpen();
    const afterOpen = calls.nodesFor.length;

    await act(async () => { vi.advanceTimersByTime(20000 * 10); });
    await flush();

    expect(calls.nodesFor.length).toBe(afterOpen);
    expect(texts(tree)).toContain("Plain tee black");
  });
});

test("the poll asks for the PENDING pids only, never the whole node", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1", "p2"]);
    bodies = {
      p1: { ...AWAITING_PENDING },
      p2: { state: "awaiting", condition: COND, cleanName: "Plain tee white", nameApprovedAt: 1 },
    };
    const tree = await mountOpen();
    calls.nodesFor.length = 0;

    await act(async () => { vi.advanceTimersByTime(20000); });
    await flush();

    expect(calls.nodesFor).toEqual([["p1"]]);
    expect(texts(tree)).toContain("Plain tee white");
  });
});

test("sitting on the product's OWN page, a confirmation swaps Publish for the live switch", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();
    await openProductPage(tree, "Plain tee black");
    expect(texts(tree)).toContain("waiting for the reconciler run to send it to Shopify");

    await reconcilerConfirms("p1", { ...CONFIRMED_LIVE });

    const out = texts(tree);
    // Not stranded on the awaiting view: the page is now the live workbench.
    expect(out).not.toContain("waiting for the reconciler run to send it to Shopify");
    expect(out).toContain("Went live");
    expect(out).toContain("Listing is ON");
    expect(button(tree, "Publish")).toBeUndefined();
    expect(button(tree, "Off")).toBeTruthy();
  });
});

test("the poll never rolls back a write that landed while its read was in flight", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();
    await openProductPage(tree, "Plain tee black");
    expect(texts(tree)).toContain("waiting for the reconciler run to send it to Shopify");

    // The tick fires and its read goes out holding the OLD (still pending)
    // node — and is HELD there, in flight.
    holdNodesFor = true;
    await act(() => { vi.advanceTimersByTime(20000); });
    expect(heldReads).toHaveLength(1);

    // While it hangs, the operator hits Cancel. That write is NEWER than
    // anything the in-flight read can return.
    await act(() => { button(tree, "Cancel").props.onClick(); });
    await flush();
    expect(calls.desired).toEqual([{ pid: "p1", want: "off" }]);
    expect(texts(tree)).not.toContain("waiting for the reconciler run to send it to Shopify");

    // Now the stale read lands. It must be DISCARDED — applying it would put
    // the row back to pending and make the Cancel look undone.
    await act(async () => { heldReads.forEach((release) => release()); });
    await flush();

    expect(texts(tree)).not.toContain("waiting for the reconciler run to send it to Shopify");
    expect(button(tree, "Publish")).toBeTruthy(); // still an awaiting product
  });
});

test("a pending live product's On switch is disabled until the reconciler answers", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { state: "live", liveState: "off", desiredState: "on", condition: COND, cleanName: "Plain tee black" } };
    const tree = await mountOpen();
    await openProductPage(tree, "Plain tee black");
    // desiredState on + liveState off ⇒ pending. The switch must not offer a
    // second write while the first is unapplied, and the page says why.
    expect(texts(tree)).toContain("waiting for the reconciler run to update Shopify");
    expect(button(tree, "On").props.disabled).toBe(true);
    expect(button(tree, "Off").props.disabled).toBe(true);

    await reconcilerConfirms("p1", { ...CONFIRMED_LIVE });

    expect(texts(tree)).toContain("Went live");
    expect(button(tree, "Off").props.disabled).toBe(false); // switchable again
  });
});

// ─── THE CONFIRMATION'S STATE SNAPSHOT ───────────────────────────────────────
// Tested against ShopifyProductPage DIRECTLY, by re-rendering it with a changed
// `node` prop. That is the component's actual contract — "the page reflects the
// node it is given" — and it is the honest level for this guard: no path in the
// current parent delivers a node change under an OPEN publish dialog (the poll
// only refreshes PENDING pids, and a product offering Publish is by definition
// not pending). The guard is defence for the paths that do exist now and any
// that arrive later; pinning it here says so without inventing a scenario the
// list cannot produce.
const { default: ShopifyProductPage } = await import("./ShopifyProductPage.jsx");
const AWAITING_READY = { state: "awaiting", condition: COND, cleanName: "Plain tee black", nameApprovedAt: 5 };

const renderProductPage = async (node) => {
  let tree;
  await act(() => {
    tree = create(
      <ShopifyProductPage product={PRODUCTS[0]} node={node} onBack={() => {}} onChanged={() => {}} />,
      { createNodeMock: nodeMock });
  });
  await flush();
  return tree;
};

test("the publish confirmation closes, and writes nothing, when the node changes under it", async () => {
  const tree = await renderProductPage(AWAITING_READY);
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("public storefront"); // the dialog is up
  calls.publish.length = 0;

  // Only desiredState moves — state and live state are untouched, which is
  // exactly the change a transition-by-transition check would have missed.
  await act(() => {
    tree.update(<ShopifyProductPage product={PRODUCTS[0]} node={{ ...AWAITING_READY, desiredState: "on" }}
                                    onBack={() => {}} onChanged={() => {}} />);
  });
  await flush();

  const out = texts(tree);
  expect(out).not.toContain("public storefront");
  expect(out).toContain("changed while the confirmation was open");
  expect(calls.publish).toEqual([]); // nothing was sent
});

test("an unchanged node leaves the confirmation alone", async () => {
  const tree = await renderProductPage(AWAITING_READY);
  await act(() => { button(tree, "Publish").props.onClick(); });
  await flush();

  // A re-render with an EQUIVALENT node (new object, same publishing state) —
  // the snapshot compares the state, not object identity, so the dialog stays.
  await act(() => {
    tree.update(<ShopifyProductPage product={PRODUCTS[0]} node={{ ...AWAITING_READY }}
                                    onBack={() => {}} onChanged={() => {}} />);
  });
  await flush();

  expect(texts(tree)).toContain("public storefront");
  expect(texts(tree)).not.toContain("changed while the confirmation was open");
});

test("two overlapping reads, IN order: the fresher answer sticks", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();
    expect(texts(tree)).toContain("PUBLISHING…");

    // R1 goes out and is HELD, holding the still-pending node.
    holdNodesFor = true;
    await act(() => { vi.advanceTimersByTime(20000); });
    expect(heldReads).toHaveLength(1);

    // The reconciler confirms; R2 goes out and is held too, holding the LIVE node.
    bodies.p1 = { ...CONFIRMED_LIVE };
    await act(() => { vi.advanceTimersByTime(20000); });
    expect(heldReads).toHaveLength(2);

    // R1 lands first with the stale answer, then R2 with the fresh one. R1's
    // own apply must NOT make R2 look stale — comparing node objects did
    // exactly that, and the row sat on "publishing…" for another full tick.
    await act(async () => { heldReads[0](); });
    await flush();
    await act(async () => { heldReads[1](); });
    await flush();

    expect(texts(tree)).not.toContain("PUBLISHING…");
    await setFilter(tree, "Live");
    expect(texts(tree)).toContain("ON — LIVE");
  });
});

test("two overlapping reads landing OUT of order: the older answer never overwrites the newer", async () => {
  await withFakeTimers(async () => {
    keys = new Set(["p1"]);
    bodies = { p1: { ...AWAITING_PENDING } };
    const tree = await mountOpen();

    // R1 goes out holding the still-pending node, and is held.
    holdNodesFor = true;
    await act(() => { vi.advanceTimersByTime(20000); });
    // The reconciler confirms; R2 goes out holding the LIVE node, also held.
    bodies.p1 = { ...CONFIRMED_LIVE };
    await act(() => { vi.advanceTimersByTime(20000); });
    expect(heldReads).toHaveLength(2);

    // R2 (newer) lands FIRST, then R1 (older). Tracking local writes alone
    // cannot tell these apart — neither is a write — so without a read
    // sequence the stale R1 wins and the row reverts to pending for a
    // whole tick.
    await act(async () => { heldReads[1](); });
    await flush();
    // Off the Awaiting tab it goes — the newer answer landed.
    expect(texts(tree)).not.toContain("PUBLISHING…");

    await act(async () => { heldReads[0](); });
    await flush();

    // And the older answer does NOT drag it back onto Awaiting.
    expect(texts(tree)).not.toContain("PUBLISHING…");
    await setFilter(tree, "Live");
    expect(texts(tree)).toContain("ON — LIVE");
  });
});

// ─── NOT MERCHANDISE ─────────────────────────────────────────────────────────
// Price-carrier records ("Entry 30 Line", "Budget 180 Range" …) are internal
// bookkeeping rows with no sizes, no SKU and no photo. Junid found them listed
// on this page under a "Price Products" heading. They must not be here at all:
// no section, no row, no badge count, and no way in through the hash route.
// The reconciler refuses them independently — this covers the page half.
const PRICE_RECORD = {
  id: "p1785900000000", name: "Entry 30 Line", barcode: "30",
  priceProduct: true, category: "Price Products", subcategory: "Price Products",
  retailPrice: 30, stockPrice: 30,
};
const WITH_PRICE_RECORD = [...PRODUCTS, PRICE_RECORD];

test("a price record has no row on the publishing page", async () => {
  keys = new Set();
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={WITH_PRICE_RECORD} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await flush();
  const out = texts(tree);
  expect(out).toContain("Plain tee black");     // real merchandise is listed
  expect(out).toContain('"3"," product"');      // and the count excludes the price record
  expect(out).not.toContain("Price Products");
  expect(out).not.toContain("Entry 30 Line");
});

test("a price record cannot be reached by its hash either — the route bounces to the list", async () => {
  keys = new Set();
  hashValue = "#shopify/p1785900000000";
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={WITH_PRICE_RECORD} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  expect(hashValue).toBe("");
  expect(texts(tree)).not.toContain("Entry 30 Line");
  // A REAL product on the same route still opens, so the guard is specific
  // to price records and not a blanket "the hash route is broken".
  await act(() => { fakeLocation.hash = "#shopify/p1"; });
  await flush();
  expect(texts(tree)).toContain("Plain tee black");
  await act(() => { fakeLocation.hash = ""; });
});

test("the home badge does not count price records as awaiting review", async () => {
  const { useShopifyAwaitingCount } = await import("./ShopifyPublishView.jsx");
  keys = new Set(["p1", "p3"]);
  let seen = null;
  function Probe() { seen = useShopifyAwaitingCount(WITH_PRICE_RECORD, true); return null; }
  await act(() => { create(<Probe />); });
  await flush();
  expect(seen).toBe(1); // p2 only — the price record adds nothing
});

test("the Live filter cannot surface a price record either, even with a live node", async () => {
  // The Live groups are built from NODES, not from the category sections, so
  // they were the one place on the page a price record could still appear —
  // a node written before the exclusion shipped, or by hand in the console.
  keys = new Set(["p1785900000000", "p1"]);
  pipeline = {
    p1785900000000: { state: "live", liveState: "on", condition: COND, cleanName: "Entry 30 Line" },
    p1: { state: "live", liveState: "on", condition: COND, cleanName: "Plain tee black" },
  };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={WITH_PRICE_RECORD} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Live").props.onClick(); });
  await flush();
  await flush(); // the Live tab is one flat list — no group to open
  const out = texts(tree);
  expect(out).toContain("Plain tee black"); // the real live product still shows
  expect(out).not.toContain("Entry 30 Line");
  pipeline = {};
});

test("a selected product that stops being publishable leaves the selection", async () => {
  // The prune effect reacts to productById, not only to node updates. Covers
  // the case the batch DIALOG already tolerated but the batch BAR did not: a
  // pid that has left the map still counted towards `selected.size` and still
  // consumed one of the 25 cap slots, while the dialog silently dropped it.
  keys = new Set(["p1", "p2"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  bodies.p2 = { state: "awaiting", cleanName: "Basic tee white", nameApprovedAt: 5, condition: COND };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await act(() => { button(tree, "Select all shown").props.onClick({ stopPropagation: () => {} }); });
  await flush();
  expect(texts(tree)).toContain('"2"," of ","25"," selected"');

  // Now the /products subscription delivers an edit that turns p1 into a price
  // record. Its row disappears — and so must its place in the selection.
  const edited = PRODUCTS.map((p) => (p.id === "p1" ? { ...p, priceProduct: true } : p));
  await act(() => { tree.update(<ShopifyPublishView products={edited} onExit={() => {}} />); });
  await flush();
  const out = texts(tree);
  expect(out).toContain('"1"," of ","25"," selected"'); // p2 survives, p1 is gone
  expect(out).not.toContain("Plain tee black");
  bodies = {};
});

// ─── PROPOSED NAMES — the vision run's review lane ───────────────────────────
// The reason this lane exists: 663 names had already been read off product
// photos and written to /shopify_publish/{pid}/nameProposal with NO surface in
// the app to decide any of them. These tests pin the surface, not the model.


// The lane reads from the PIPELINE query, not from an expanded section — that
// is the whole point of the runner stamping state:"awaiting" on the nodes it
// touches. A proposal must therefore be visible with nothing expanded at all.
const mountProposals = async (nodes, { viaPipeline = false } = {}) => {
  // A live/blocked product's node arrives with the pipeline query as before;
  // an AWAITING one arrives only from the lane's own paged read.
  if (viaPipeline) pipeline = nodes;
  else proposalPages = [{ nodes, lastKey: Object.keys(nodes).slice(-1)[0] || null, done: true }];
  keys = new Set(Object.keys(nodes));
  // The node EXISTS in the database, so a per-pid read must return it. The
  // Awaiting tab (which the page opens on) reads the bodies of the rows on
  // screen, and a fixture that answered null there would be lying about what
  // RTDB holds — the lane's own paged read fills only where nothing is held.
  for (const [pid, n] of Object.entries(nodes)) bodies[pid] = n;
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  const chip = button(tree, "Suggested names");
  await act(() => { chip.props.onClick(); });
  await flush();
  return tree;
};

test("proposals: the lane lists a waiting name with NOTHING expanded, and both names are shown", async () => {
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } });
  const out = texts(tree);
  expect(out).toContain("Brushed nubuck low-top in sand"); // the proposal
  expect(out).toContain("Sneaker");                       // what it replaces
  // The lane itself made no body fetch — it came from the lane's OWN bounded
  // paged read, not from the pipeline and not from a per-pid read. (The page
  // opens on Awaiting review, whose window read the row on the way past; the
  // lane adds nothing to it.)
  expect(calls.proposalPages).toEqual([null]);
});

test("proposals: the lane is not read until it is selected, and it pages", async () => {
  proposalPages = [
    { nodes: { p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } }, lastKey: "p3", done: false },
    { nodes: { p2: { state: "awaiting", cleanName: "Tee", nameProposal: { ...PROPOSAL, name: "Ribbed cotton crew tee in bone", proposedAt: 1787000000001 } } }, lastKey: "p2", done: true },
  ];
  keys = new Set(["p2", "p3"]);
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  // MOUNTED ON ANOTHER FILTER: the awaiting set has not been touched. This is
  // the whole point — it is the big set and it is not free.
  expect(calls.proposalPages).toEqual([]);

  await act(() => { button(tree, "Suggested names").props.onClick(); });
  await flush();
  expect(calls.proposalPages).toEqual([null]);            // ONE page read, not the walk
  expect(texts(tree)).toContain("Brushed nubuck low-top in sand");

  await act(() => { button(tree, "Load more suggestions").props.onClick(); });
  await flush();
  expect(calls.proposalPages).toEqual([null, "p3"]);       // continued from the last key
  expect(texts(tree)).toContain("Ribbed cotton crew tee in bone");
  // WHAT IS PINNED HERE IS THE READ, not the render. The lane's paging exists
  // to bound what it FETCHES; what it draws is whatever the page holds, and
  // the Awaiting tab's window may already have paid for a node the walk has
  // not reached yet. Bounding the render as well would hide a suggestion the
  // reviewer has already been charged for.
});

test("proposals: Use this name writes through the store and the row leaves the lane", async () => {
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } });
  await act(() => { button(tree, "Use this name").props.onClick(); });
  await flush();
  expect(calls.applyProposal).toEqual(["p3"]);
  // The lane's membership test is the node's own pending flag; the applied
  // node is no longer pending, so the row is gone with no bookkeeping.
  expect(texts(tree)).not.toContain("Brushed nubuck low-top in sand");
});

test("proposals: Keep the old one dismisses without touching the name", async () => {
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } });
  await act(() => { button(tree, "Keep the old one").props.onClick(); });
  await flush();
  expect(calls.dismissProposal).toEqual(["p3"]);
  expect(calls.applyProposal).toEqual([]);
});

test("proposals: a refused write surfaces its message and the row stays", async () => {
  proposalWriteResult = { ok: false, message: "Listing is ON the storefront — switch it off before taking a new name." };
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } });
  await act(() => { button(tree, "Use this name").props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).toContain("switch it off before taking a new name");
  expect(out).toContain("Brushed nubuck low-top in sand");
});

test("proposals: a name that is a brand trigger TODAY cannot be taken, and says why", async () => {
  // A proposal written before the lexicon grew. The lane must not be a softer
  // door than the hand-typed name editor.
  const tree = await mountProposals({
    p3: { state: "awaiting", cleanName: "Sneaker",
          nameProposal: { ...PROPOSAL, name: "Nike low-top in sand" } },
  });
  const use = button(tree, "Use this name");
  expect(use.props.disabled).toBe(true);
  expect(texts(tree)).toContain("brand trigger");
});

test("proposals: a listing that is ON cannot take a new name from the lane", async () => {
  const tree = await mountProposals({
    p3: { state: "live", liveState: "on", cleanName: "Sneaker", nameProposal: PROPOSAL },
  }, { viaPipeline: true });
  expect(button(tree, "Use this name").props.disabled).toBe(true);
  expect(texts(tree)).toContain("switch it off");
});

test("proposals: an already-decided proposal never appears in the lane", async () => {
  const tree = await mountProposals({
    p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: { ...PROPOSAL, status: "applied" } },
  });
  expect(texts(tree)).toContain("No names are waiting");
});

test("proposals: the lane is empty-stated, not blank, when nothing is waiting", async () => {
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker" } });
  expect(texts(tree)).toContain("No names are waiting");
});

test("proposals: a page with nothing pending does NOT claim the lane is empty while more pages remain", async () => {
  // The realistic shape once Junid has worked through the front of the queue:
  // the first page is products whose names he has already decided, and the
  // ones still waiting are behind them. Claiming "no names are waiting" here
  // — with no way forward — is the dead end this guards.
  proposalPages = [
    { nodes: { p3: { state: "awaiting", cleanName: "Sneaker" } }, lastKey: "p3", done: false },
    { nodes: { p2: { state: "awaiting", cleanName: "Tee", nameProposal: PROPOSAL } }, lastKey: "p2", done: true },
  ];
  // p2's node is NOT in the shallow key list — the naming run stamped it after
  // that list was read, which is the ordinary case (the list is cached for the
  // session). So the Awaiting window has no reason to fetch it, and the second
  // proposal page is genuinely the first sight of it.
  keys = new Set(["p3"]);
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Suggested names").props.onClick(); });
  await flush();
  const out = texts(tree);
  expect(out).not.toContain("No names are waiting");     // it would be a lie
  expect(out).toContain("more to look through");

  await act(() => { button(tree, "Keep looking").props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("Brushed nubuck low-top in sand");
});

test("proposals: the terminal message appears once the paging really is finished", async () => {
  proposalPages = [{ nodes: { p3: { state: "awaiting", cleanName: "Sneaker" } }, lastKey: "p3", done: true }];
  keys = new Set(["p3"]);
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Suggested names").props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("No names are waiting");
});

// ─── THE SAME DECISION, ON THE PRODUCT'S OWN PAGE ────────────────────────────
// The lane is where a batch of names gets worked through; this card is for the
// reviewer who arrived at one product instead. Both must offer the same
// decision, and both must pass the proposal they DISPLAYED so a re-run's newer
// name cannot be approved sight unseen.
test("page: the photo-read name appears under Listing name, with the identity guess and its confidence", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Plain tee", nameProposal: PROPOSAL };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  const out = texts(tree);
  expect(out).toContain("Suggested from the photo");
  expect(out).toContain("Brushed nubuck low-top in sand");
  expect(out).toContain("Nike Air Force 1 Sand");   // the identity guess, shown as a guess
  expect(out).toContain("82");                      // its confidence, as a percentage
  // and the guess is labelled as internal-only — it must never read as a title
  expect(out).toContain("never goes on the storefront");
});

test("page: taking the name writes through the store, carrying the proposal that was displayed", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Plain tee", nameProposal: PROPOSAL };
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await openClothing(tree);
  await openProductPage(tree, "Plain tee black");
  await act(() => { button(tree, "Use this name").props.onClick(); });
  await flush();
  expect(calls.applyProposal).toEqual(["p1"]);
  // the editor follows the name that was just saved, so the page is not left
  // showing a draft that no longer matches the product
  expect(pageNameInput(tree).props.value).toBe("Brushed nubuck low-top in sand");
});

test("proposals: the row is keyboard-operable, and the navigable element holds no other control", async () => {
  // Without this the identity guess, the confidence and the photos are
  // mouse-only from this lane. Same treatment ProductListRow already uses.
  const tree = await mountProposals({ p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } });
  const nav = tree.root.findAll((n) => n.props && n.props.role === "button" &&
                                       String(n.props["aria-label"] || "").startsWith("Open "))[0];
  expect(nav).toBeTruthy();
  expect(nav.props.tabIndex).toBe(0);

  // Structure FIRST, while the row is still mounted: activating it navigates
  // and the row goes away with the list.
  // role="button" makes descendants presentational, so the decision buttons
  // must be SIBLINGS — a keydown from a nested button would bubble here and
  // preventDefault would cancel that button's own activation.
  expect(nav.findAll((n) => n.type === "button").length).toBe(0);
  // and the two decisions are genuinely still reachable, just not inside it
  expect(button(tree, "Use this name")).toBeTruthy();
  expect(button(tree, "Keep the old one")).toBeTruthy();

  let opened = null;
  hashValue = "";
  await act(() => { nav.props.onKeyDown({ key: "Enter", preventDefault: () => { opened = true; } }); });
  await flush();
  expect(opened).toBe(true);              // it swallowed the default
  expect(hashValue).toBe("#shopify/p3");  // and it navigated
});

test("proposals: a finished pass offers to look again — it does not claim the queue is empty", async () => {
  // The walk moves FORWARD through keys and a product's key is its creation
  // time, so a suggestion the naming runner writes while this page is open can
  // land behind where the reading got to. "No names are waiting" full stop
  // would be a claim the walk cannot support.
  proposalPages = [{ nodes: {}, lastKey: null, done: true }];
  keys = new Set();
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Suggested names").props.onClick(); });
  await flush();
  expect(texts(tree)).toContain("can add more behind what has already been read");

  // and Check again re-walks from the TOP, not from a spent cursor
  proposalPages = [{ nodes: { p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } }, lastKey: "p3", done: true }];
  await act(() => { button(tree, "Check again").props.onClick(); });
  await flush();
  expect(calls.proposalPages).toEqual([null, null]);   // both walks started at the top
  expect(texts(tree)).toContain("Brushed nubuck low-top in sand");
});

test("proposals: Check again re-walks from the TOP, not from where the last pass stopped", async () => {
  // NOTE ON WHAT THIS DOES AND DOES NOT PIN. It pins that restartProposalWalk
  // asks for the first page again. It does NOT pin the removal of the
  // `lastKey ?? p.lastKey` fallback in loadMoreProposals — putting that
  // fallback back leaves all 61 of these tests green, because Check again
  // passes fromStart explicitly and the UI never offers Load more once the
  // walk is done, so the stale cursor is unreachable from the interface.
  // Removing it was a contract fix (the store returning null MEANS finished,
  // and the state should not contradict it), not a live-bug fix, and this
  // comment exists so nobody later reads a passing suite as proof it was.
  // The store-side contract IS pinned, in proposalPaging.test.js.
  proposalPages = [
    { nodes: { p3: { state: "awaiting", cleanName: "Sneaker", nameProposal: PROPOSAL } }, lastKey: "p3", done: false },
    { nodes: {}, lastKey: null, done: true },   // the store's finished contract
  ];
  keys = new Set(["p3"]);
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await act(() => { button(tree, "Suggested names").props.onClick(); });
  await flush();
  await act(() => { button(tree, "Load more suggestions").props.onClick(); });
  await flush();
  expect(calls.proposalPages).toEqual([null, "p3"]);

  // Now finished. Check again must start at the TOP — if the spent cursor had
  // been kept, this third request would carry "p3".
  proposalPages = [{ nodes: {}, lastKey: null, done: true }];
  await act(() => { button(tree, "Check again").props.onClick(); });
  await flush();
  expect(calls.proposalPages).toEqual([null, "p3", null]);
});


// ─── A FAILED BODY READ MUST NOT WEDGE THE TAB ───────────────────────────────
// The window fetches bodies for the rows on screen and holds the list on
// "Loading…" until they land. A read that ERRORS is never coming back on its
// own — the window has not changed, so the effect has no reason to re-run —
// and counting it as still-pending hid every row AND the retry behind a
// spinner, for ever, on one transient blip (Codex review, 2026-08-28).
test("a failed body read shows the rows, says so, and the retry actually re-reads", async () => {
  keys = new Set(["p1"]);
  bodies.p1 = { state: "awaiting", cleanName: "Basic tee black", nameApprovedAt: 5, condition: COND };
  failNodesFor = true;
  let tree;
  await act(() => { tree = create(<ShopifyPublishView products={PRODUCTS} onExit={() => {}} />, { createNodeMock: nodeMock }); });
  await flush();
  await flush();

  // NOT stuck on Loading. The rows are there, the banner says what happened.
  const out = texts(tree);
  expect(out).not.toContain("Loading…");
  expect(out).toContain("Plain tee black");
  expect(out).toContain("didn't load");
  expect(button(tree, "Try again")).toBeTruthy();

  // THE RETRY MUST ACTUALLY RE-READ. Clearing the failed set is the only state
  // that changes, so it has to be a dependency of the fetch effect — it was
  // not, and the button cleared the flags and re-fired nothing.
  const before = calls.nodesFor.length;
  await act(() => { button(tree, "Try again").props.onClick(); });
  await flush();
  await flush();
  expect(calls.nodesFor.length).toBeGreaterThan(before);
  expect(calls.nodesFor[calls.nodesFor.length - 1]).toEqual(["p1"]);
  // …and the real body landed, so the row now shows its cleaned name.
  expect(texts(tree)).toContain("Basic tee black");
  expect(texts(tree)).not.toContain("didn't load");
});

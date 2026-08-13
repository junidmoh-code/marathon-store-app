// Pins the Marketing card's pricing behaviour: tiles show real prices, the
// on-special tile is badged and NOT tickable, ticking opens the bulk bar with
// an honest count, and the phone grid guarantees two tiles side by side
// (min(196px, 42vw) columns). Fully mocked RTDB — no live data.
import { test, expect, vi } from "vitest";
import { create, act } from "react-test-renderer";

const store = {
  "attention_lists/marketing/items/p1": { addedAtMs: 1 },
  "attention_lists/marketing/items/p2": { addedAtMs: 2 },
  "attention_lists/marketing/items/p3": { addedAtMs: 3 },
  "specials/p3": { name: "Special Thing", price: 90, wasPrice: 120 },
};
const getPath = (p) => {
  if (p in store) return store[p];
  const out = {};
  const prefix = `${p}/`;
  for (const [k, v] of Object.entries(store)) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length).split("/");
      let node = out;
      for (let i = 0; i < rest.length - 1; i++) node = node[rest[i]] = node[rest[i]] || {};
      node[rest[rest.length - 1]] = v;
    }
  }
  return Object.keys(out).length ? out : null;
};

const failGets = new Set(); // paths whose one-shot get() rejects (missing rule)
const subscribers = {}; // path → [cb] — lets tests push live specials updates
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path: path || "" }),
  child: (node, path) => ({ path: node.path ? `${node.path}/${path}` : path }),
  onValue: (r, cb) => {
    (subscribers[r.path] = subscribers[r.path] || []).push(cb);
    cb({ val: () => getPath(r.path) });
    return () => {};
  },
  get: (r) => failGets.has(r.path)
    ? Promise.reject(new Error("Permission denied"))
    : Promise.resolve({ val: () => getPath(r.path), exists: () => getPath(r.path) != null }),
  set: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  update: () => Promise.resolve(),
  query: (r) => r,
  orderByKey: () => "orderByKey",
  limitToLast: () => "limitToLast",
}));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1", email: "x@marathon.internal" } } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ user: { uid: "u1" }, hasPermission: () => true }) }));

const { default: MarketingView } = await import("./MarketingView.jsx");

const PRODUCTS = [
  { id: "p1", name: "Slow Mover One", retailPrice: 450, stockPrice: 200, photoUrl: "" },
  { id: "p2", name: "Slow Mover Two", retailPrice: 300 },
  { id: "p3", name: "Special Thing", retailPrice: 90, stockPrice: 40 },
];

const flush = () => act(() => Promise.resolve());
// Flatten the rendered tree to plain text so adjacent JSX text nodes
// ("1", " ticked") read as one string.
const plain = (tree) => {
  const walk = (n) => n == null ? "" : typeof n === "string" ? n : Array.isArray(n) ? n.map(walk).join("") : walk(n.children);
  return walk(tree.toJSON());
};

async function render() {
  let tree;
  await act(async () => { tree = create(<MarketingView products={PRODUCTS} onExit={() => {}} />); });
  await flush();
  return tree;
}

test("tiles show retail + stock prices and an Edit price button", async () => {
  const tree = await render();
  const text = plain(tree);
  expect(text).toContain("R450");
  expect(text).toContain("stock R200");
  expect(text).toContain("✎ Edit price");
});

test("the on-special tile is badged and offers NO tick; normal tiles are tickable", async () => {
  const tree = await render();
  expect(plain(tree)).toContain("ON SPECIAL");
  const ticks = tree.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
  const labels = ticks.map((i) => i.props["aria-label"]);
  expect(labels).toContain("Select Slow Mover One");
  expect(labels).toContain("Select Slow Mover Two");
  expect(labels).not.toContain("Select Special Thing");
});

test("ticking a tile opens the bulk bar with the honest count", async () => {
  const tree = await render();
  const tick = tree.root.findAllByType("input").find((i) => i.props["aria-label"] === "Select Slow Mover One");
  await act(async () => { tick.props.onChange(); });
  const text = plain(tree);
  expect(text).toContain("1 ticked");
  expect(text).toContain("% change");
  expect(text).toContain("Preview…");
});

test("the grid guarantees two-up on phones: columns are min(196px, 42vw)", async () => {
  const tree = await render();
  const grids = tree.root.findAllByType("div").filter((d) => d.props.style?.gridTemplateColumns);
  expect(grids.length).toBeGreaterThan(0);
  expect(grids[0].props.style.gridTemplateColumns).toBe("repeat(auto-fill, minmax(min(196px, 42vw), 1fr))");
});

test("Edit price opens the single-product modal with current values loaded", async () => {
  const tree = await render();
  const edit = tree.root.findAllByType("button").find((b) =>
    b.children.some((c) => typeof c === "string" && c.includes("Edit price")));
  await act(async () => { edit.props.onClick(); });
  const inputs = tree.root.findAllByType("input").filter((i) => i.props.type === "number");
  expect(inputs.length).toBe(2);
  expect(inputs.map((i) => i.props.value)).toEqual(["200", "450"]); // stock, retail of Slow Mover One
});

test("LIVE specials: a special started elsewhere un-ticks its tile on the next snapshot", async () => {
  const tree = await render();
  const tick = tree.root.findAllByType("input").find((i) => i.props["aria-label"] === "Select Slow Mover One");
  await act(async () => { tick.props.onChange(); });
  expect(plain(tree)).toContain("1 ticked");
  // A special lands on p1 from another device → push the new snapshot.
  store["specials/p1"] = { name: "Slow Mover One", price: 300, wasPrice: 450 };
  await act(async () => { for (const cb of subscribers["specials"] || []) cb({ val: () => getPath("specials") }); });
  const text = plain(tree);
  expect(text).not.toContain("1 ticked"); // selection dropped, bulk bar gone
  const labels = tree.root.findAllByType("input").filter((i) => i.props.type === "checkbox").map((i) => i.props["aria-label"]);
  expect(labels).not.toContain("Select Slow Mover One"); // no longer tickable
  delete store["specials/p1"];
});

test("per-tile edit surfaces the fail-open bypass — a silent unguarded save is impossible (Sonnet review PR #360)", async () => {
  failGets.add("specials"); // the store's interlock read fails; save proceeds fail-open
  const tree = await render();
  const edit = tree.root.findAllByType("button").find((b) =>
    b.children.some((c) => typeof c === "string" && c.includes("Edit price")));
  await act(async () => { edit.props.onClick(); });
  const retail = tree.root.findAllByType("input").find((i) => i.props["aria-label"] === "Retail price");
  await act(async () => { retail.props.onChange({ target: { value: "500" } }); });
  const saveBtn = tree.root.findAllByType("button").find((b) =>
    b.children.some((c) => typeof c === "string" && c === "Save"));
  await act(async () => { await saveBtn.props.onClick(); });
  await flush();
  const text = plain(tree);
  expect(text).toContain("Saved Slow Mover One");
  expect(text).toContain("could not read /specials"); // the bypass is named
  expect(text).toContain("on-special guard cannot read /specials"); // standing banner armed
  failGets.delete("specials");
});
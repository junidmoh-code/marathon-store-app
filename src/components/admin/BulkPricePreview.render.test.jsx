// Pins the confirm gate's honesty: the preview must show the exact count that
// will be written, name the kept-as-is products, offer skip-vs-overwrite with
// SKIP as the default, and disable Apply when the plan writes nothing.
import { test, expect } from "vitest";
import { create, act } from "react-test-renderer";
import BulkPricePreview from "./BulkPricePreview.jsx";
import { buildBulkFillPlan } from "../../utils/bulkPricing.js";

const CATALOG = [
  { id: "p1", name: "Bare Cap" },
  { id: "p2", name: "Priced Tee", stockPrice: 90, retailPrice: 180 },
];

const textOf = (tree) => JSON.stringify(tree.toJSON());

test("preview shows the written count, the skip note, and defaults to skip", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p1", "p2"], stockDraft: "70", retailDraft: "150" });
  let tree;
  act(() => { tree = create(<BulkPricePreview title="Fill" plan={plan} overwrite={false} onOverwriteChange={() => {}} onConfirm={() => {}} onCancel={() => {}} />); });
  const text = textOf(tree);
  expect(text).toContain("Bare Cap");                 // the row that will change
  expect(text).toContain("kept as is");               // the honest partial note
  expect(text).toContain("Apply · 1");                // count = exactly the plan
  const checkbox = tree.root.findAllByType("input").find((i) => i.props.type === "checkbox");
  expect(checkbox.props.checked).toBe(false);         // skip is the default
});

test("a plan that writes nothing disables Apply", () => {
  const plan = buildBulkFillPlan({ products: CATALOG, selectedIds: ["p2"], retailDraft: "180", overwrite: true }); // no-op
  let tree;
  act(() => { tree = create(<BulkPricePreview title="Fill" plan={plan} onConfirm={() => {}} onCancel={() => {}} />); });
  const apply = tree.root.findAllByType("button").find((b) => JSON.stringify(b.children).includes("Apply"));
  expect(apply.props.disabled).toBe(true);
  expect(textOf(tree)).toContain("Nothing to write");
});

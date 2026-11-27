// The product name on the Admin product page: read-only with Edit; Edit gives
// Save and Cancel; Save is disabled unchanged / blank / a twin's name; Cancel
// restores; saving / saved / error are shown. Drives the production component
// and the production renameProduct (only the callable is stubbed).
import { describe, it, expect, vi, afterEach } from "vitest";
import TestRenderer, { act } from "react-test-renderer";

vi.mock("../../firebase", () => ({ database: {} }));
vi.mock("../../offline/pendingWrites", () => ({ notePendingUpdate: vi.fn() }));

import { ProductNameEditor } from "./ProductNameEditor.jsx";
import { renameRefusal } from "./productSave";

const AM96 = { id: "p1", name: "Nike Air Max 96 DT blue Whitet", styleCode: "724274-002", styleCodeNormalised: "724274002" };
const CATALOGUE = [AM96, { id: "p2", name: "Nike Air Max 96 Blue White", styleCode: "AB1234-100" }, { id: "p3", name: "Gucci slide brown " }];

let tree = null;
afterEach(() => { if (tree) act(() => tree.unmount()); tree = null; });
const mount = (props) => { act(() => { tree = TestRenderer.create(<ProductNameEditor product={AM96} allProducts={CATALOGUE} {...props} />); }); };
const byId = (id) => tree.root.findAll((n) => n.props && n.props["data-testid"] === id && typeof n.type === "string")[0] || null;
const text = (n) => (n == null ? null : (n.children || []).map((c) => (typeof c === "string" ? c : text(c))).join(""));
const type = (v) => act(() => { byId("name-input").props.onChange({ target: { value: v } }); });
const click = async (id) => { await act(async () => { await byId(id).props.onClick(); }); };

describe("the name editor", () => {
  it("shows the name read-only with Edit — no input until Edit", () => {
    mount({ call: vi.fn() });
    expect(text(byId("name-text"))).toBe(AM96.name);
    expect(byId("name-input")).toBeNull();
    expect(byId("name-edit")).not.toBeNull();
  });

  it("Save is disabled when unchanged or blank", async () => {
    mount({ call: vi.fn() });
    await click("name-edit");
    expect(byId("name-save").props.disabled).toBe(true);           // unchanged
    type("   ");
    expect(byId("name-save").props.disabled).toBe(true);           // blank
    type(`  ${AM96.name}  `);
    expect(byId("name-save").props.disabled).toBe(true);           // unchanged once trimmed
    type("Nike Air Max 96 DT Blue White");
    expect(byId("name-save").props.disabled).toBe(false);
  });

  it("Cancel restores the old name and writes nothing", async () => {
    const call = vi.fn();
    mount({ call });
    await click("name-edit");
    type("Something else");
    await click("name-cancel");
    expect(text(byId("name-text"))).toBe(AM96.name);
    expect(call).not.toHaveBeenCalled();
    await click("name-edit");
    expect(byId("name-input").props.value).toBe(AM96.name);       // the draft did not survive
  });

  it("a duplicate name is refused, naming the product that has it — nothing is sent", async () => {
    const call = vi.fn();
    mount({ call });
    await click("name-edit");
    type("nike air max 96  BLUE white ");
    expect(byId("name-save").props.disabled).toBe(true);
    expect(text(byId("name-status"))).toMatch(/“Nike Air Max 96 Blue White” is already the name of another product \(AB1234-100\)/);
    await act(async () => { byId("name-input").props.onKeyDown({ key: "Enter" }); });
    expect(call).not.toHaveBeenCalled();
  });

  it("Save trims, sends through the callable with the old name, and shows saving then saved", async () => {
    let finish;
    const call = vi.fn(() => new Promise((r) => { finish = r; }));
    mount({ call, deviceId: "dev-12345678", buildExtras: () => ({ brand: "Nike" }) });
    await click("name-edit");
    type("  Nike Air Max 96 DT Blue White  ");
    act(() => { byId("name-save").props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    expect(text(byId("name-save"))).toBe("Saving…");
    expect(call).toHaveBeenCalledWith({
      productId: "p1", name: "Nike Air Max 96 DT Blue White", from: AM96.name, extras: { brand: "Nike" }, deviceId: "dev-12345678",
    });
    await act(async () => { finish({ data: { ok: true, name: "Nike Air Max 96 DT Blue White", openRefillRequests: 2, patch: { name: "Nike Air Max 96 DT Blue White" } } }); });
    expect(text(byId("name-status"))).toMatch(/^Saved\. 2 open refill requests for this product stay attached/);
    expect(byId("name-input")).toBeNull();                         // back to read-only
  });

  it("a refusal from the server is shown plainly and the edit is kept for another try", async () => {
    const call = vi.fn(() => Promise.reject(Object.assign(new Error("permission-denied: This product has stock or sales, so only Junid, Jafer or MC can rename it. Ask one of them."), { code: "functions/permission-denied" })));
    mount({ call });
    await click("name-edit");
    type("Renamed");
    await click("name-save");
    expect(text(byId("name-status"))).toBe("Could not rename: This product has stock or sales, so only Junid, Jafer or MC can rename it. Ask one of them.");
    expect(byId("name-status").props.role).toBe("alert");
    expect(byId("name-input").props.value).toBe("Renamed");
  });

  it("an empty catalogue never skips the twin check", () => {
    expect(renameRefusal({ product: AM96, draft: "Anything", allProducts: [] })).toMatch(/still loading/);
  });
});

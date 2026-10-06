// The printed rules block (docs/SECTIONS-RULES.md) is pasted by hand into the
// console. This cannot evaluate it, but it can refuse the mistakes that would
// take the shop down on paste: invalid JSON, unbalanced brackets in an
// expression, an unguarded child() on a value that may be missing, or a wall
// clause that quietly went missing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const md = readFileSync(join(process.cwd(), "docs/SECTIONS-RULES.md"), "utf8");
// Two fenced JSON blocks: A (new keys and optional children) and B (the wall).
const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(`{${m[1]}}`));
const [blockA, blockB] = blocks;
const block = { ...blockA, ...blockB };

function expressions(node, path = "", out = []) {
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") out.push({ path: `${path}/${k}`, expr: v });
    else if (v && typeof v === "object" && !Array.isArray(v)) expressions(v, `${path}/${k}`, out);
  }
  return out;
}
const all = expressions(block);

describe("the printed rules block", () => {
  it("is two valid JSON blocks with exactly the keys the document describes", () => {
    expect(blocks).toHaveLength(2);
    expect(Object.keys(blockA)).toEqual(["network", "orderCounter_byStore", "refillCounter_byStore", "central_dispatch", "sections_repair", "push_assignments", "users"]);
    expect(Object.keys(blockB)).toEqual(["stock_movements", "transfers", "orders", "refill_requests"]);
  });

  it("block A refuses nothing that works today: it only adds keys, or optional children under an unchanged parent", () => {
    // /users keeps its owner-only root write and gains no child .write
    expect(blockA.users[".write"]).toBe("auth.token.email === 'gunidmoh@gmail.com'");
    expect(JSON.stringify(blockA.users.$uid)).not.toContain(".write");
    // push_assignments keeps its required children and its catch-all
    expect(blockA.push_assignments.$uid[".validate"]).toBe("newData.hasChildren(['hub1','hub2','updatedAt'])");
    expect(blockA.push_assignments.$uid.$other[".validate"]).toBe(false);
    expect(blockA.push_assignments.$uid["concrete-stockroom"][".validate"]).toBe("newData.isBoolean()");
  });

  it("the per-store counters accept exactly what the app writes", () => {
    for (const k of ["orderCounter_byStore", "refillCounter_byStore"]) {
      expect(blockA[k].$shop[".validate"]).toContain("newData.hasChildren(['day','counter'])");
      expect(blockA[k].$shop[".validate"]).toContain("newData.child('counter').val() <= 999");
    }
  });

  it("a dispatch cost row must describe the Central movement written with it", () => {
    const v = blockA.central_dispatch.$mvId[".validate"];
    expect(v).toContain("child('stock_movements').child($mvId).child('from').val() === newData.child('from').val()");
    expect(v).toContain("child('stock_movements').child($mvId).child('qty').val() === newData.child('qty').val()");
    expect(v).toContain("child('type').val() !== 'hub'");
  });

  it("every expression has balanced brackets and quotes", () => {
    for (const { path, expr } of all) {
      let depth = 0;
      for (const ch of expr.replace(/'[^']*'/g, "''").replace(/\/[^/]+\/[a-z]*/g, "")) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        expect(depth, path).toBeGreaterThanOrEqual(0);
      }
      expect(depth, path).toBe(0);
      expect((expr.match(/'/g) || []).length % 2, path).toBe(0);
    }
  });

  it("keeps the live stock_movements rule word for word and only ADDS to it", () => {
    const v = block.stock_movements.$mvId[".validate"];
    expect(v.startsWith("newData.hasChildren(['type','productId','size','qty','actor','ts'])")).toBe(true);
    expect(v).toContain("root.child('locations').child(newData.child('to').val()).exists())");
    expect(block.stock_movements.$mvId[".write"]).toBe("!data.exists() && newData.exists() && auth != null && auth.token.firebase.sign_in_provider != 'anonymous'");
    expect(block.stock_movements.$mvId.type[".validate"]).toContain("transfer_out");
  });

  it("the three wall clauses on stock_movements are present", () => {
    const v = block.stock_movements.$mvId[".validate"];
    expect(v).toContain("child('section').val() === root.child('network').child('locations').child(newData.child('to').val()).child('section').val()");
    expect(v).toContain("newData.child('type').val() !== 'return'");
    expect(v).toContain("newData.child('type').val() !== 'sold'");
    expect(v).toContain("child('posStores')");
  });

  it("never calls child() on the POS store id without checking it exists first", () => {
    const v = block.stock_movements.$mvId[".validate"];
    const guard = "!root.child('pos').child('sales').child(newData.child('link').child('saleId').val()).child('storeId').exists() || ";
    const uses = v.split("!root.child('network').child('posStores').child(root.child('pos')").length - 1;
    expect(uses).toBe(2);
    expect(v.split(guard).length - 1).toBe(2);
    // and the saleId itself is checked before it is used as a key
    expect(v.split("!newData.child('link').child('saleId').exists()").length - 1).toBe(2);
  });

  it("orders and refill_requests are judged on create only, so older records can still be closed", () => {
    expect(block.orders.$id[".validate"].startsWith("data.exists() || ")).toBe(true);
    expect(block.refill_requests.$refillId[".validate"].startsWith("data.exists() || ")).toBe(true);
    expect(block.orders[".read"]).toContain("destShop");
    expect(block.refill_requests.$refillId.status[".validate"]).toBeTruthy();
  });

  it("transfers keeps its field rules and gains the pair check — guarded, so a transfer with no from/to is still writable", () => {
    expect(block.transfers.$transferId.from[".validate"]).toContain("root.child('locations')");
    const v = block.transfers.$transferId[".validate"];
    expect(v).toContain("child('section')");
    expect(v.startsWith("!newData.exists() || !newData.child('from').exists() || !newData.child('to').exists() || ")).toBe(true);
  });

  it("a device enrolled for a section writes stock only in that section or at Central; no claim, no restriction", () => {
    const v = block.stock_movements.$mvId[".validate"];
    expect(v.split("auth.token.section === null").length - 1).toBe(2);
    expect(v).toContain(".val() === auth.token.section)");
    expect(v).toContain("(!newData.child('to').exists() || (auth.token.section === null");
  });

  it("/network is owner-write, and back stock must be a hub in the store's own section", () => {
    expect(block.network[".write"]).toBe("auth != null && auth.token.email === 'gunidmoh@gmail.com'");
    expect(block.network.backStock.$store.$category[".validate"]).toContain("child('section').val() === newData.parent().parent().parent().child('locations').child($store).child('section').val()");
    expect(block.sections_repair[".write"]).toBe(false);
  });
});

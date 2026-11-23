// ─── MISSING PRODUCTS — CENSUS OF "NOT LISTED" (read-only, opt-in) ────────────
// Junid, 23 Nov 2026: every product with stock at Central and none at any shop
// or hub of a division — is it on that division's list, and if not, why? This
// mounts the REAL screen over a saved snapshot and reads the answer off the
// rendered "Not listed" sheet. Writes nothing, reads nothing live.
//   CENSUS_SNAPSHOT=/path/snap.json CENSUS_OUT=/path/out.json \
//     npx vitest run src/components/stock/notListedCensus.harness.test.jsx
// (The rest of this header is the original census's, whose mocks it shares.)
// Junid, 22 Nov 2026: "how many of the 1664 Concrete and 271 Marathon entries
// can actually be sent?" This runs the REAL screen code — the two cores, the
// two Solve hooks' planners, missingListCore — over a saved snapshot of the
// nodes the screen reads, and counts. It writes nothing and reads nothing
// live. Skipped unless CENSUS_SNAPSHOT names a snapshot file:
//   CENSUS_SNAPSHOT=/path/snap.json CENSUS_HIDDEN=/path/hidden.json CENSUS_OUT=/path/out.json \
//     npx vitest run src/components/stock/missingCensus.harness.test.jsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync, writeFileSync } from "fs";

const SNAP = process.env.CENSUS_SNAPSHOT;
const snap = SNAP ? JSON.parse(readFileSync(SNAP, "utf8")) : null;
let hidden = null;
try { hidden = process.env.CENSUS_HIDDEN ? JSON.parse(readFileSync(process.env.CENSUS_HIDDEN, "utf8")) : (snap?.hidden ?? null); } catch { hidden = null; }
const paths = snap ? {
  stock: snap.stock, stock_targets: snap.targets, refill_requests: snap.recentRequests, "config/refillEngine": snap.config,
  network: snap.network ?? null, "settings/missingProductsHidden": hidden,
  "settings/concreteOnlyIndex": snap.concreteIdx ?? null, "settings/marathonOnlyIndex": snap.marathonIdx ?? null,
  "refill_engine/seats/marathon-pine": snap.seats?.["marathon-pine"] ?? null, "refill_engine/seats/concrete": snap.seats?.concrete ?? null, "settings/stockHold/held": snap.held && Object.keys(snap.held).length ? snap.held : null,
} : {};
const gets = snap ? {
  "config/refillEngine/footwearRunByLocation": snap.config.footwearRunByLocation ?? null,
  "config/refillEngine/policyGroups/footwear-all/policy/hub3": snap.config.policyGroups?.["footwear-all"]?.policy?.hub3 ?? null,
} : {};
vi.mock("firebase/database", () => ({
  query: (r) => r, orderByChild: () => ({}), equalTo: () => ({}),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: () => { throw new Error("the census writes nothing"); },
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: "x" }), runTransaction: () => { throw new Error("the census writes nothing"); },
}));
vi.mock("./solvedLogStore", () => ({ useSolvedLog: () => ({ entries: [], settled: true, error: null, hasMore: false, loadMore: () => {} }), saveSolvedRows: async () => {}, markSolvedUndone: async () => {} }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "census" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "census" } } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "admin" }, isSuperAdmin: true }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => snap?.readAt || new Date(0).toISOString(), serverNowMs: () => Date.parse(snap?.readAt || 0) }));
const seen = [];
vi.mock("./missingListCore", async () => {
  const real = await vi.importActual("./missingListCore");
  return {
    ...real,
    decideProductRow: (a) => { const d = real.decideProductRow(a); seen.push({ kind: "clothing", a, d }); return d; },
    decideSneakerRow: (a) => { const d = real.decideSneakerRow(a); seen.push({ kind: "sneakers", a, d }); return d; },
  };
});

describe.skipIf(!SNAP)("census of Not listed", () => {
  it("accounts for every product Central holds that a division does not", async () => {
    const { default: MissingProductsScreen } = await import("./MissingProductsScreen.jsx");
    const { strandedAtCentral } = await import("./notListedCore");
    const { decodeSizeKey } = await import("../../utils/sizeKey");
    const products = Object.entries(snap.products).map(([id, p]) => ({ id, ...p }));
    const byId = new Map(products.map((p) => [p.id, p]));
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={products} onExit={() => {}} onOpenEnginePolicy={() => {}} />); });
    const all = (pred) => tree.root.findAll((n) => typeof n.type === "string" && pred(n.props));
    const settled = () => all((p) => p["data-division-count"] !== undefined).every((n) => typeof n.props.children === "number");
    for (let i = 0; i < 6000 && !settled(); i++) { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
    const counts = Object.fromEntries(all((p) => p["data-division-count"] !== undefined).map((n) => [n.props["data-division-count"], n.props.children]));
    const decode = (stock) => Object.fromEntries(Object.entries(stock || {}).map(([loc, byPid]) => [loc, Object.fromEntries(Object.entries(byPid || {}).map(([pid, cells]) => [pid, Object.fromEntries(Object.entries(cells || {}).map(([k, c]) => [decodeSizeKey(k), c]))]))]));
    const allStock = decode(snap.stock);
    const last = new Map();
    for (const s of seen) last.set(`${s.a.section}:${s.kind}:${s.a.card.pid}`, s);
    const hidden = snap.hidden || {};
    const out = { snapshotReadAt: snap.readAt, counts, divisions: {} };
    const LOCS = { 2: ["marathon-pe", "trophy", "hub1", "hub2"], 1: ["marathon-pine", "concrete", "hub3"] };
    for (const [sec, name] of [[2, "Marathon"], [1, "Concrete"]]) {
      await act(async () => { all((p) => p["data-division"] === sec)[0].props.onClick(); });
      for (let i = 0; i < 400 && !all((p) => p["data-not-listed-line"] !== undefined).length; i++) {
        const more = all((p) => p["data-action"] === "show-more");
        await act(async () => { if (more.length) more[0].props.onClick(); await new Promise((r) => setTimeout(r, 5)); });
      }
      const line = all((p) => p["data-not-listed-line"] !== undefined)[0];
      const n = line.props["data-not-listed-line"];
      await act(async () => { line.props.onClick(); });
      for (let i = 0; i < 100; i++) { const m = all((p) => p["data-action"] === "not-listed-more"); if (!m.length) break; await act(async () => { m[0].props.onClick(); }); }
      const rows = all((p) => p["data-not-listed-row"] !== undefined).map((x) => ({ pid: x.props["data-not-listed-row"], reason: x.props["data-reason"] }));
      await act(async () => { all((p) => p["data-action"] === "exit")[0].props.onClick(); });
      // Independently of the screen: which products the rule is about, and
      // which of them are cards on the list.
      const stranded = strandedAtCentral({ allStock, locations: LOCS[sec], central: "central" });
      const listed = new Set([...last.entries()].filter(([k, s]) => k.startsWith(`${sec}:`) && s.d.row && !hidden[s.a.card.pid]).map(([, s]) => s.a.card.pid));
      const notListed = new Map(rows.map((r) => [r.pid, r.reason]));
      const list = stranded.map(({ pid, centralUnits }) => {
        const p = byId.get(pid);
        const cost = Number(p?.stockPrice) > 0 ? Number(p.stockPrice) : 0;
        return { pid, name: p?.name || pid, category: p?.categoryKey || p?.subcategory || p?.category || null, centralUnits, stockPrice: cost, value: cost * centralUnits,
          retail: Number(p?.retailPrice) > 0 ? Number(p.retailPrice) * centralUnits : 0,
          onList: listed.has(pid), reason: listed.has(pid) ? null : (notListed.get(pid) || "MISSING-FROM-BOTH") };
      });
      const absent = list.filter((r) => r.reason === "MISSING-FROM-BOTH");
      const extra = rows.filter((r) => !stranded.some((s) => s.pid === r.pid));
      out.divisions[name] = { lineCount: n, rows: rows.length, stranded: stranded.length, onList: list.filter((r) => r.onList).length, absent: absent.length, extra: extra.length, list };
      console.log(name, JSON.stringify({ lineCount: n, rows: rows.length, stranded: stranded.length, onList: list.filter((r) => r.onList).length, absent: absent.length, extra: extra.length }));
      expect(n).toBe(rows.length);
      expect(absent).toEqual([]);
      expect(extra).toEqual([]);
    }
    if (process.env.CENSUS_OUT) writeFileSync(process.env.CENSUS_OUT, JSON.stringify(out, null, 1));
  }, 600000);
});

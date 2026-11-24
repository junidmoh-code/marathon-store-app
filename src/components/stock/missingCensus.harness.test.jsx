// ─── MISSING PRODUCTS — CENSUS OF THE REAL LISTS (read-only, opt-in) ──────────
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
// Every row decision the screen makes is recorded on its way past.
const seen = [];
vi.mock("./missingListCore", async () => {
  const real = await vi.importActual("./missingListCore");
  return {
    ...real,
    productRow: (a) => { const row = real.productRow(a); seen.push({ kind: "clothing", a, row }); return row; },
    sneakerRow: (a) => { const row = real.sneakerRow(a); seen.push({ kind: "sneakers", a, row }); return row; },
    // The screen asks the decide* forms (with the reason); record those too.
    decideProductRow: (a) => { const d = real.decideProductRow(a); seen.push({ kind: "clothing", a, row: d.row, why: d.why }); return d; },
    decideSneakerRow: (a) => { const d = real.decideSneakerRow(a); seen.push({ kind: "sneakers", a, row: d.row, why: d.why }); return d; },
  };
});

describe.skipIf(!SNAP)("census of the real Missing Products lists", () => {
  it("counts what can be sent", async () => {
    const { default: MissingProductsScreen } = await import("./MissingProductsScreen.jsx");
    const { computeMissingProducts } = await import("./missingProductsCore");
    const { computeMissingFootwear } = await import("./missingFootwearCore");
    const { partitionQueued } = await import("./missingScreenCore");
    const { decodeSizeKey } = await import("../../utils/sizeKey");
    const { isSneakerOrSlide } = await import("./firstBatchCore");
    const products = Object.entries(snap.products).map(([id, p]) => ({ id, ...p }));
    const byId = new Map(products.map((p) => [p.id, p]));
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={products} onExit={() => {}} />); });
    const t0 = Date.now();
    const settled = () => tree.root.findAll((n) => typeof n.type === "string" && n.props["data-division-count"] !== undefined).every((n) => typeof n.props.children === "number");
    for (let i = 0; i < 6000 && !settled(); i++) { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
    console.log(`rows settled in ${Date.now() - t0} ms, ${seen.length} row decisions`);
    const counts = Object.fromEntries(tree.root.findAll((n) => typeof n.type === "string" && n.props["data-division-count"] !== undefined).map((n) => [n.props["data-division-count"], n.props.children]));

    // The LAST decision per (section, kind, pid) is the settled one.
    const last = new Map();
    for (const s of seen) last.set(`${s.a.section}:${s.kind}:${s.a.card.pid}`, s);
    const isHidden = (pid) => !!(hidden && hidden[pid]);
    const out = { snapshotReadAt: snap.readAt, newCounts: counts, divisions: {} };
    const decode = (stock) => Object.fromEntries(Object.entries(stock || {}).map(([loc, byPid]) => [loc, Object.fromEntries(Object.entries(byPid || {}).map(([pid, cells]) => [pid, Object.fromEntries(Object.entries(cells || {}).map(([k, c]) => [decodeSizeKey(k), c]))]))]));
    const allStock = decode(snap.stock);
    const requests = Object.entries(snap.recentRequests || {}).map(([id, r]) => ({ id, ...r }));
    for (const [sec, name] of [[2, "Marathon"], [1, "Concrete"]]) {
      const hubs = sec === 2 ? ["hub1", "hub2"] : ["hub3"];
      const oldClothing = (sec === 2 ? computeMissingProducts({ allStock, products }) : computeMissingProducts({ allStock, products, section: sec, centralFed: snap.config })).filter((c) => !isHidden(c.pid));
      const oldSneakers = partitionQueued(computeMissingFootwear({ allStock, products, hubs, heldLines: null, central: "central" }), requests, hubs).todo;
      const d = { oldCount: oldClothing.length + oldSneakers.length, oldClothing: oldClothing.length, oldSneakers: oldSneakers.length,
        clothing: { solvableInFull: 0, partlySolvable: 0, nothingToSend: 0, nothingSourceHoldsNone: 0, nothingAllAlreadyPromised: 0, noPolicy: 0, sneakerOrSlideOnWrongList: 0, falselyReportedNothing: 0 },
        sneakers: { solvable: 0, needsPolicy: 0, queuedOrCentralNoneFree: 0, otherHubHasIt: 0, solvableOnlyByTargetRow: 0 },
        needsPolicy: [], examples: { nothingToSend: [], noPolicy: [] } };
      for (const c of oldClothing) {
        const s = last.get(`${sec}:clothing:${c.pid}`);
        const p = byId.get(c.pid);
        // A read check, independent of the screen: does ANY Central cell of a
        // size the old card called "Central has none" hold units under some
        // other spelling of the key?
        const raw = snap.stock?.central?.[c.pid] || {};
        const norm = (x) => String(x).replace(/_/g, ".").trim().toUpperCase();
        const misread = (c.sizes || []).filter((z) => z.centralNone).some((z) => Object.entries(raw).some(([k, cell]) => norm(decodeSizeKey(k)) === norm(z.size) && Number(cell?.qty) > 0));
        if (misread) d.clothing.falselyReportedNothing += 1;
        if (s && s.row) {
          const best = s.row.dests.filter((x) => x.ok).sort((a, b) => b.sizes.length - a.sizes.length)[0];
          let needed = best.sizes.length;
          try { needed = Math.max(needed, (s.a.planFor(c, [best.id], s.a.openByLoc)?.lines?.[0]?.sizes || []).length, c.centralFed ? c.sizes.length : 0); } catch { /* keep */ }
          if (best.sizes.length >= needed) d.clothing.solvableInFull += 1; else d.clothing.partlySolvable += 1;
          continue;
        }
        if (isSneakerOrSlide(p)) { d.clothing.sneakerOrSlideOnWrongList += 1; continue; }
        let anyPolicy = false;
        try { anyPolicy = (s?.a.tickable || []).some((st) => (s.a.planFor(c, [st], s.a.openByLoc)?.lines?.[0]?.sizes || []).length > 0); } catch { anyPolicy = false; }
        if (anyPolicy) {
          // WHY nothing: the source holds none of the needed sizes, or it
          // holds them and every unit is already promised to an open request.
          const src = snap.stock?.[c.source]?.[c.pid] || {};
          const need = new Set((s.a.tickable || []).flatMap((st) => { try { return (s.a.planFor(c, [st], s.a.openByLoc)?.lines?.[0]?.sizes || []).map((z) => norm(z)); } catch { return []; } }));
          const holds = Object.entries(src).some(([k, cell]) => need.has(norm(decodeSizeKey(k))) && Number(cell?.qty) > 0);
          if (holds) d.clothing.nothingAllAlreadyPromised += 1; else d.clothing.nothingSourceHoldsNone += 1;
        }
        if (anyPolicy) { d.clothing.nothingToSend += 1; if (d.examples.nothingToSend.length < 8) d.examples.nothingToSend.push(`${c.name} (${c.kind})`); }
        else { d.clothing.noPolicy += 1; if (d.examples.noPolicy.length < 8) d.examples.noPolicy.push(`${c.name} (${c.kind}; ${p?.categoryKey || p?.subcategory || "no category"})`); }
      }
      const run = snap.config.footwearRunByLocation || {};
      for (const c of oldSneakers) {
        if (isHidden(c.pid)) continue;
        const s = last.get(`${sec}:sneakers:${c.pid}`);
        const p = byId.get(c.pid);
        if (s && s.row && s.row.needsPolicy) {
          d.sneakers.needsPolicy += 1;
          d.needsPolicy.push({ pid: c.pid, name: c.name, categoryKey: p?.categoryKey || null, centralUnits: c.centralUnits, sizes: c.sizes.map((z) => `${z.size}×${z.avail}`).join(" ") });
        } else if (s && s.row) {
          d.sneakers.solvable += 1;
          if (sec === 2 && !(p?.sizes || []).some((z) => hubs.some((h) => Number(run[h]?.[String(z).replace(".", "_")]) > 0))) d.sneakers.solvableOnlyByTargetRow += 1;
        } else {
          const refused = s ? s.a.dests.every((h) => { try { return !!s.a.refusal(c, [h]); } catch { return false; } }) : false;
          if (refused) d.sneakers.otherHubHasIt += 1; else d.sneakers.queuedOrCentralNoneFree += 1;
        }
      }
      out.divisions[name] = d;
    }
    // A closer look at named products: each destination and what it would send.
    for (const pid of String(process.env.CENSUS_PIDS || "").split(",").filter(Boolean)) {
      for (const [k, s] of last) if (k.endsWith(`:${pid}`)) {
        let plans = {};
        try { for (const d of s.a.dests || []) plans[typeof d === "string" ? d : d] = (s.a.kind === undefined && s.a.planFor && s.a.tickable) ? (s.a.planFor(s.a.card, [d], s.a.openByLoc)?.lines?.[0] || null) : null; } catch (e) { plans = { error: String(e) }; }
        console.log("PID", k, JSON.stringify(s.row ? s.row.dests : null), "tickable", JSON.stringify(s.a.tickable), "openByLoc", JSON.stringify(s.a.openByLoc), "plans", JSON.stringify(plans));
      }
    }
    // ONE OWNER on the Concrete clothing list: how each card's owners decided it.
    const own = { neither: 0, neitherListed: 0, one: 0, oneListed: 0, oneNothingToSend: 0, both: 0 };
    for (const [k, s2] of last) {
      if (!k.startsWith("1:clothing:")) continue;
      const o = s2.a.owners;
      if (!Array.isArray(o) || o.length === 0) { own.neither += 1; if (s2.row) own.neitherListed += 1; }
      else if (o.length === 1) { own.one += 1; if (s2.row) own.oneListed += 1; else own.oneNothingToSend += 1; }
      else own.both += 1;
    }
    out.concreteOwnership = own;
    // Every clothing decision, for before/after comparisons (CENSUS_ROWS_OUT).
    if (process.env.CENSUS_ROWS_OUT) {
      const rows = {};
      for (const [k, s2] of last) {
        if (!k.includes(":clothing:")) continue;
        const [sec] = k.split(":");
        (rows[sec] ||= []).push({ pid: s2.a.card.pid, name: s2.a.card.name, owners: s2.a.owners || null, dests: s2.row ? s2.row.dests.map((x) => x.id) : null });
      }
      writeFileSync(process.env.CENSUS_ROWS_OUT, JSON.stringify(rows));
    }
    console.log("OWNERSHIP", JSON.stringify(own));
    if (process.env.CENSUS_OUT) writeFileSync(process.env.CENSUS_OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ...out, divisions: Object.fromEntries(Object.entries(out.divisions).map(([k, v]) => [k, { ...v, needsPolicy: v.needsPolicy.length }])) }, null, 1));
    expect(seen.length).toBeGreaterThan(0);
  }, 300000);
});

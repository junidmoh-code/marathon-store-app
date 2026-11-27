// ─── MISSING PRODUCTS — ARE THE NUMBERS RIGHT? (read-only, opt-in) ────────────
// Junid, 24 Nov 2026: "The numbers on Missing Products must be 100% accurate."
// Runs the REAL screen over a saved snapshot and, for every card on both
// divisions and both kinds, compares the "Central N" it shows with the TRUE
// figure computed here, independently, from the raw nodes:
//   free(size) = units at Central − units still owed to OPEN requests that
//                Central supplies (qty − sentQty; shadows never count)
// and the card's true figure is the sum of free(size) over the sizes its
// buttons would send. Writes nothing, reads nothing live. Skipped unless
// ACCURACY_SNAPSHOT names a snapshot (scripts/diag/snapshot-missing-screen.mjs shape,
// with `openRequests` merged into `recentRequests`).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync, writeFileSync } from "fs";

const SNAP = process.env.ACCURACY_SNAPSHOT;
const snap = SNAP ? JSON.parse(readFileSync(SNAP, "utf8")) : null;
const requestsNode = snap ? { ...(snap.recentRequests || {}), ...(snap.openRequests || {}) } : null;
const paths = snap ? {
  stock: snap.stock, stock_targets: snap.targets, refill_requests: requestsNode, "config/refillEngine": snap.config,
  network: snap.network ?? null, "settings/missingProductsHidden": snap.hidden ?? null,
  "settings/concreteOnlyIndex": snap.concreteIdx ?? null, "settings/marathonOnlyIndex": snap.marathonIdx ?? null,
  "refill_engine/seats/marathon-pine": snap.seats?.["marathon-pine"] ?? null, "refill_engine/seats/concrete": snap.seats?.concrete ?? null,
  "settings/stockHold/held": snap.held && Object.keys(snap.held).length ? snap.held : null,
} : {};
const gets = snap ? {
  "config/refillEngine/footwearRunByLocation": snap.config.footwearRunByLocation ?? null,
  "config/refillEngine/policyGroups/footwear-all/policy/hub3": snap.config.policyGroups?.["footwear-all"]?.policy?.hub3 ?? null,
  "config/refillEngine/categoryPolicy/kids-shoes": snap.config.categoryPolicy?.["kids-shoes"] ?? null,
} : {};
vi.mock("firebase/database", () => ({
  query: (r) => r, orderByChild: () => ({}), equalTo: () => ({}),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null }); return () => {}; },
  update: () => { throw new Error("the audit writes nothing"); },
  get: (r) => Promise.resolve({ val: () => gets[r.path] ?? null }),
  push: () => ({ key: "x" }), runTransaction: () => { throw new Error("the audit writes nothing"); },
}));
vi.mock("./solvedLogStore", () => ({ useSolvedLog: () => ({ entries: [], settled: true, error: null, hasMore: false, loadMore: () => {} }), saveSolvedRows: async () => {}, markSolvedUndone: async () => {} }));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "audit" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, functions: {}, auth: { currentUser: { uid: "audit" } } }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "admin" }, isSuperAdmin: true }) }));
vi.mock("../../utils/serverTime", () => ({ serverNowIso: () => snap?.readAt || new Date(0).toISOString(), serverNowMs: () => Date.parse(snap?.readAt || 0) }));
const seen = [];
vi.mock("./missingListCore", async () => {
  const real = await vi.importActual("./missingListCore");
  return {
    ...real,
    decideProductRow: (a) => { const d = real.decideProductRow(a); seen.push({ kind: "clothing", a, row: d.row }); return d; },
    decideSneakerRow: (a) => { const d = real.decideSneakerRow(a); seen.push({ kind: "sneakers", a, row: d.row }); return d; },
  };
});

describe.skipIf(!SNAP)("accuracy of every Missing Products number", () => {
  it("compares each card's Central figure with the true free units", async () => {
    const { default: MissingProductsScreen } = await import("./MissingProductsScreen.jsx");
    const { decodeSizeKey, encodeSizeKey } = await import("../../utils/sizeKey");
    const products = Object.entries(snap.products).map(([id, p]) => ({ id, ...p }));
    let tree;
    await act(async () => { tree = TestRenderer.create(<MissingProductsScreen products={products} onExit={() => {}} />); });
    const counts = () => tree.root.findAll((n) => typeof n.type === "string" && n.props["data-division-count"] !== undefined);
    for (let i = 0; i < 8000 && !counts().every((n) => typeof n.props.children === "number"); i++) { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
    // ── THE TRUTH, from the raw nodes only ──
    const norm = (s) => { const k = String(s ?? "").trim(); return k ? encodeSizeKey(k) : "_"; };
    const centralQty = (pid, size) => {
      let n = 0;
      for (const [k, c] of Object.entries(snap.stock?.central?.[pid] || {})) if (k !== "_meta" && norm(decodeSizeKey(k)) === norm(size)) n += Math.max(Number(c?.qty) || 0, 0);
      return n;
    };
    const routes = snap.config.routes || {};
    const owed = new Map();   // pid|size → units
    for (const r of Object.values(requestsNode)) {
      if (!r || r.status !== "open" || r.shadow || !r.productId) continue;
      const src = (r.createdFrom && typeof r.createdFrom === "object" && r.createdFrom.source) || routes[r.requestingLocation] || "central";
      if (src !== "central") continue;
      const left = Math.max((Number(r.qty) || 0) - (Number(r.sentQty) || 0), 0);
      const k = `${r.productId}|${norm(r.size)}`;
      owed.set(k, (owed.get(k) || 0) + left);
    }
    const free = (pid, size) => Math.max(centralQty(pid, size) - (owed.get(`${pid}|${norm(size)}`) || 0), 0);
    // The settled decision per card.
    const last = new Map();
    for (const s of seen) last.set(`${s.a.section}:${s.kind}:${s.a.card.pid}`, s);
    const out = { readAt: snap.readAt, checked: 0, wrong: 0, byDivision: {}, rows: [] };
    const atSource = (loc, pid, size) => {
      let n = 0;
      for (const [k, c] of Object.entries(snap.stock?.[loc]?.[pid] || {})) if (k !== "_meta" && norm(decodeSizeKey(k)) === norm(size)) n += Math.max(Number(c?.qty) || 0, 0);
      return n;
    };
    for (const [key, s] of last) {
      if (!s.row) continue;
      if (s.row.source !== "central") {
        // A hub-fed clothing card: its number is that hub's units in the sizes it sends.
        const sizes = [...new Set(s.row.dests.flatMap((d) => d.sizes))];
        const truth = sizes.reduce((t, z) => t + atSource(s.row.source, s.row.pid, z), 0);
        const b = (out.byDivision[`${s.a.section === 2 ? "Marathon" : "Concrete"} ${s.kind} (from ${s.row.source})`] ||= { checked: 0, wrong: 0 });
        out.checked += 1; b.checked += 1;
        if (truth !== s.row.stock) { out.wrong += 1; b.wrong += 1; out.rows.push({ key, name: s.row.name, shown: s.row.stock, truth, diff: s.row.stock - truth, source: s.row.source }); }
        continue;
      }
      const sizes = [...new Set(s.row.dests.flatMap((d) => d.sizes))];
      const truth = sizes.reduce((t, z) => t + free(s.row.pid, z), 0);
      const perSize = sizes.map((z) => ({ size: z, free: free(s.row.pid, z), onHand: centralQty(s.row.pid, z), owed: owed.get(`${s.row.pid}|${norm(z)}`) || 0 }));
      const div = s.a.section === 2 ? "Marathon" : "Concrete";
      const b = (out.byDivision[`${div} ${s.kind}`] ||= { checked: 0, wrong: 0 });
      out.checked += 1; b.checked += 1;
      if (truth !== s.row.stock) {
        out.wrong += 1; b.wrong += 1;
        out.rows.push({ key, name: s.row.name, shown: s.row.stock, truth, diff: s.row.stock - truth, perSize });
      }
    }
    // ── NOT LISTED, both divisions: "Central N free · M promised" against the truth ──
    out.notListed = { checked: 0, wrong: 0, rows: [] };
    const host = (attr, v) => tree.root.findAll((n) => typeof n.type === "string" && n.props && (v === undefined ? n.props[attr] !== undefined : n.props[attr] === v));
    const flat = (n) => (n == null || n === false ? "" : typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.children));
    for (const sec of [2, 1]) {
      const btn = host("data-division", sec)[0];
      if (!btn) continue;
      await act(async () => { btn.props.onClick(); });
      for (let i = 0; i < 400 && !host("data-not-listed-line").length; i++) { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
      const line = host("data-not-listed-line")[0];
      if (!line) continue;
      await act(async () => { line.props.onClick(); });
      for (let i = 0; i < 400 && !host("data-not-listed").length && !host("data-not-listed-empty").length; i++) { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
      // every row, not the first page only
      for (let i = 0; i < 50; i++) { const more = host("data-action", "not-listed-more")[0]; if (!more) break; await act(async () => { more.props.onClick(); }); }
      for (const row of host("data-not-listed-row")) {
        const pid = row.props["data-not-listed-row"];
        const text = flat(row.findAll((n) => typeof n.type === "string" && n.props["data-central-free"] !== undefined)[0]?.children);
        let onHand = 0, free = 0, promised = 0;
        const sizes = new Map();
        for (const [k, c] of Object.entries(snap.stock?.central?.[pid] || {})) { if (k === "_meta") continue; const z = norm(decodeSizeKey(k)); sizes.set(z, (sizes.get(z) || 0) + Math.max(Number(c?.qty) || 0, 0)); }
        for (const [z, n] of sizes) { const o = owed.get(`${pid}|${z}`) || 0; onHand += n; free += Math.max(n - o, 0); promised += Math.min(o, n); }
        const want = `Central ${free} free${promised > 0 ? ` · ${promised} promised` : ""}`;
        out.notListed.checked += 1;
        // Before 24 Nov the row said "Central {on hand}": wrong wherever units were promised.
        if (promised > 0) { out.notListed.oldWrong = (out.notListed.oldWrong || 0) + 1; out.notListed.oldOverBy = (out.notListed.oldOverBy || 0) + promised; }
        if (text.trim() !== want) { out.notListed.wrong += 1; out.notListed.rows.push({ sec, pid, shown: text.trim(), truth: want }); }
      }
      const back = host("data-action", "exit")[0];
      await act(async () => { back.props.onClick(); });
    }
    out.counts = Object.fromEntries(counts().map((n) => [n.props["data-division-count"], n.props.children]));
    out.decisions = {};
    for (const [key, s] of last) { const [sec, kind] = key.split(":"); const k = `${sec}:${kind}`; const o = (out.decisions[k] ||= { cards: 0, rows: 0 }); o.cards += 1; if (s.row) o.rows += 1; }
    for (const pid of String(process.env.ACCURACY_PIDS || "").split(",").filter(Boolean)) for (const [k, s2] of last) if (k.endsWith(`:${pid}`)) console.log("PID", k, s2.row ? JSON.stringify({ stock: s2.row.stock, dests: s2.row.dests.map((d) => [d.id, d.sizes.join("/"), d.units]) }) : "no row");
    out.ok = out.wrong === 0 && out.notListed.wrong === 0;
    if (process.env.ACCURACY_OUT) writeFileSync(process.env.ACCURACY_OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ...out, rows: out.rows.slice(0, 15), notListed: { ...out.notListed, rows: out.notListed.rows.slice(0, 15) } }, null, 1));
    expect(out.checked).toBeGreaterThan(0);
  }, 600000);
});

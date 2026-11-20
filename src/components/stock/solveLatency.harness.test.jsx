// ─── SOLVE LATENCY HARNESS — the real NetworkTransfer, real data, real RTTs ──
// Not part of the normal suite: it runs only when MP_SNAPSHOT names a snapshot
// written by scripts/diag/solve-latency-dump.mjs (live /products, /stock,
// /stock_targets, config, /network). Round-trip times come from
// scripts/diag/solve-latency-rtt.mjs (MP_READ_MS / MP_WRITE_MS), and the
// offline mirror's echo of a write back onto the screen from MP_ECHO_MS.
//
// It renders the REAL Missing Products list (Marathon division) over the real
// catalogue, taps Solve then the confirm on the first solvable card, and
// records: every database read and write the real solve() awaits (with the
// measured latency injected per call), the moment the card leaves the screen,
// and the moment the write is acknowledged.
//   MP_SNAPSHOT=… MP_READ_MS=… MP_WRITE_MS=… MP_ECHO_MS=… npx vitest run src/components/stock/solveLatency.harness.test.jsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import TestRenderer, { act } from "react-test-renderer";

const SNAP = process.env.MP_SNAPSHOT;
const READ_MS = Number(process.env.MP_READ_MS || 0);
const WRITE_MS = Number(process.env.MP_WRITE_MS || 0);
const ECHO_MS = Number(process.env.MP_ECHO_MS || 0);
const data = SNAP ? JSON.parse(readFileSync(SNAP, "utf8")) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
let T0 = 0;
const now = () => performance.now() - T0;
const paths = {};
let pushN = 0;
vi.mock("firebase/database", () => ({
  query: (r, ...parts) => ({ path: `${r.path}?${parts.map((p) => p.q).join("&")}` }), orderByChild: (f) => ({ q: `orderBy=${f}` }), equalTo: (v) => ({ q: `equalTo=${v}` }),
  orderByKey: () => ({ q: "orderByKey" }), limitToLast: (n) => ({ q: `limitToLast=${n}` }), endBefore: (k) => ({ q: `endBefore=${k}` }),
  ref: (_db, path) => ({ path: path ?? "" }),
  onValue: (r, cb) => { cb({ val: () => paths[r.path] ?? null, forEach: () => false }); return () => {}; },
  update: async (_r, u) => { const s = now(); await sleep(WRITE_MS); log.push({ op: "update", paths: Object.keys(u).length, start: s, end: now(), u }); },
  get: async (r) => { const s = now(); await sleep(READ_MS); log.push({ op: "get", path: r.path, start: s, end: now() }); return { val: () => null, exists: () => false }; },
  runTransaction: async (r, fn) => { await sleep(WRITE_MS); return { committed: true, snapshot: { val: () => fn(null) } }; },
  push: (r) => ({ key: `-K${String(++pushN).padStart(6, "0")}`, path: `${r?.path}/-K${pushN}` }),
  set: async () => { await sleep(WRITE_MS); },
  serverTimestamp: () => ({ ".sv": "timestamp" }),
}));
vi.mock("firebase/auth", () => ({ onAuthStateChanged: (_a, cb) => { cb({ uid: "u1" }); return () => {}; } }));
vi.mock("../../firebase", () => ({ database: {}, auth: { currentUser: { uid: "u1", displayName: "Junid" } } }));
vi.mock("../PermissionsContext", () => ({ usePermissions: () => ({ permRecord: { stockRole: "admin", displayName: "Junid" }, isSuperAdmin: true, user: { uid: "u1", email: "x@y" } }) }));
vi.mock("./applyMovement", () => ({ applyMovement: vi.fn(() => Promise.resolve({ ok: true })) }));

describe.skipIf(!data)("Solve latency (harness)", () => {
  it("measures tap → card gone and tap → write acknowledged", async () => {
    paths["config/refillEngine"] = data.config;
    paths["network"] = data.network;
    const { decodeSizeKey } = await import("../../utils/sizeKey.js");
    const { default: NetworkTransfer } = await import("./NetworkTransfer.jsx");
    const { computeMissingProducts } = await import("./missingProductsCore.js");
    const { partitionHidden } = await import("./hiddenProductsCore.js");
    const decode = (byP) => Object.fromEntries(Object.entries(byP || {}).map(([pid, c]) => [pid, Object.fromEntries(Object.entries(c || {}).map(([k, v]) => [decodeSizeKey(k), v]))]));
    let stock = Object.fromEntries(Object.entries(data.stock).filter(([, v]) => v).map(([l, v]) => [l, decode(v)]));
    const products = data.products;
    const targets = Object.fromEntries(Object.entries(data.targets).filter(([, v]) => v));
    const build = (st) => partitionHidden(computeMissingProducts({ allStock: st, products }), {}).visible;
    let t = performance.now();
    let cards = build(stock);
    const computeMs = performance.now() - t;
    let tree;
    t = performance.now();
    await act(async () => {
      tree = TestRenderer.create(<NetworkTransfer products={products} category="clothing" allStock={stock} cards={cards} targets={targets} targetsSettled targetsError={false} />);
    });
    const firstRenderMs = performance.now() - t;
    const buttons = () => tree.root.findAll((n) => n.type === "button");
    const solveBtns = buttons().filter((b) => (b.children || []).includes("Solve"));
    const idx = solveBtns.findIndex((b) => !b.props.disabled);
    expect(idx).toBeGreaterThanOrEqual(0);
    const card = cards.filter((c) => c.group === "clothing")[idx];
    await act(async () => { solveBtns[idx].props.onClick(); });
    await act(async () => { await sleep(READ_MS * 4 + 50); });   // the panel's own lock read settles
    const confirm = buttons().find((b) => (b.children || []).some((c) => typeof c === "string" && c.startsWith("Solve —")) && !b.props.disabled);
    expect(confirm).toBeTruthy();
    const { ProductCard } = await import("./healthWidgets.jsx");
    const present = () => tree.root.findAll((n) => n.type === ProductCard && n.props.name === card.name).length > 0;
    log.length = 0;
    T0 = performance.now();
    let goneAt = null;
    await act(async () => { confirm.props.onClick(); });
    if (!present()) goneAt = now();
    // wait for the write to be acknowledged
    for (let i = 0; i < 400 && !log.some((l) => l.op === "update"); i++) await act(async () => { await sleep(10); });
    const upd = log.find((l) => l.op === "update");
    const ackAt = upd ? upd.end : null;
    let echoRenderMs = null;
    if (goneAt == null && upd) {
      // BEFORE: the card leaves only when the write comes back round to
      // allStock (the offline mirror's change feed), and HealthView rebuilds
      // the list from it.
      await act(async () => { await sleep(ECHO_MS); });
      const next = JSON.parse(JSON.stringify(stock));
      for (const [k, v] of Object.entries(upd.u)) {
        const [root, loc, pid, size] = k.split("/");
        if (root !== "stock" || !size) continue;
        ((next[loc] ||= {})[pid] ||= {})[decodeSizeKey(size)] = v;
      }
      const s2 = performance.now();
      const cards2 = build(next);
      await act(async () => { tree.update(<NetworkTransfer products={products} category="clothing" allStock={next} cards={cards2} targets={targets} targetsSettled targetsError={false} />); });
      echoRenderMs = performance.now() - s2;
      if (!present()) goneAt = now();
    }
    const reads = log.filter((l) => l.op === "get");
    // Sequential depth: how many read "waves" the solve awaited one after another.
    const waves = [];
    for (const r of reads.sort((a, b) => a.start - b.start)) {
      const w = waves.find((x) => r.start >= x.end - 1);
      if (waves.length && r.start < waves.at(-1).end - 1) waves.at(-1).n++; else waves.push({ start: r.start, end: r.end, n: 1 });
      waves.at(-1).end = Math.max(waves.at(-1).end, r.end);
      void w;
    }
    const result = {
      card: { pid: card.pid, name: card.name, kind: card.kind },
      cards: cards.length, computeListMs: Math.round(computeMs), firstRenderMs: Math.round(firstRenderMs),
      reads: reads.length, readWaves: waves.length, writePaths: upd?.paths ?? 0,
      tapToCardGoneMs: goneAt == null ? null : Math.round(goneAt),
      tapToWriteAckMs: ackAt == null ? null : Math.round(ackAt),
      echoRebuildAndRenderMs: echoRenderMs == null ? null : Math.round(echoRenderMs),
      injected: { READ_MS, WRITE_MS, ECHO_MS },
    };
    console.log("SOLVE_LATENCY " + JSON.stringify(result));
  }, 120000);
});

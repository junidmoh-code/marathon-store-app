// READ-ONLY investigation (Junid, 28 Nov 2026): AF1 white received onto the
// wrong product. Never writes. Narrow reads only:
//   • /products by the styleCodeNormalised index (two equalTo queries);
//   • /stock_movements by the `ts` index, one SAST day per query, kept only for
//     the two product ids;
//   • /stock/{loc}/{pid} for the two ids at each registry location;
//   • /users/{uid}/displayName for each actor seen.
//
//   node scripts/af1-misreceive-investigate.mjs [--receive-from ISO] [--receive-to ISO]
//        [--manual-day YYYY-MM-DD] [--manual-actor uid …] [--history-from ISO] [--out file.json]
//        [--expected-receive-day YYYY-MM-DD]   (default 2026-11-25, as in the plan script)
//
// Defaults: receive window 22 Nov 00:00 SAST → now (the 21 Nov receive onto
// the wrong product was already reversed by hand the same morning, so it is
// outside); manual day 2026-11-28; history of receives from 1 Oct.
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { restGet } from "./diag/rest-read.mjs";
import { collectFacts, planCorrection, cellsToMap, groupReceiveEvents, sastDay, SAST_OFFSET_MS } from "./lib/af1Misreceive.mjs";

const WRONG = { code: "DD1525100", name: "Nike Air Force 1 White Yellow Logo" };
const RIGHT = { code: "315122111", name: "Nike Air Force 1 White" };
const LOCATIONS = ["central", "studio", "base", "hub1", "hub2", "hub3", "marathon-pe", "trophy", "marathon-pine", "concrete", "in_transit"];

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const opts = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const nowIso = new Date().toISOString();
const receiveFrom = opt("--receive-from", "2026-11-21T22:00:00.000Z");
const receiveTo = opt("--receive-to", nowIso);
const manualDay = opt("--manual-day", "2026-11-28");
const manualActors = opts("--manual-actor");
const historyFrom = opt("--history-from", "2026-09-30T22:00:00.000Z");
const out = opt("--out", join(tmpdir(), "af1-misreceive-facts.json"));

async function resolvePid({ code, name }) {
  const hits = await restGet("products", `orderBy=%22styleCodeNormalised%22&equalTo=%22${code}%22`);
  const exact = Object.entries(hits || {}).filter(([, p]) => (p?.name || "").trim() === name);
  if (exact.length !== 1) throw new Error(`STOP: style code ${code} → ${exact.length} product(s) named "${name}" (of ${Object.keys(hits || {}).length} with that code)`);
  const [pid, p] = exact[0];
  return { pid, name: p.name, styleCode: p.styleCode, sizes: p.sizes || [] };
}

async function ledgerRows(fromIso, toIso, pids) {
  const rows = [];
  // one SAST day per query: a narrow ts range, never the whole ledger
  let start = Date.parse(fromIso);
  const end = Date.parse(toIso);
  while (start < end) {
    const dayEnd = Math.min(Date.parse(new Date(start + SAST_OFFSET_MS).toISOString().slice(0, 10) + "T00:00:00.000Z") - SAST_OFFSET_MS + 86400000, end);
    const page = await restGet("stock_movements", `orderBy=%22ts%22&startAt=%22${new Date(start).toISOString()}%22&endAt=%22${new Date(dayEnd - 1).toISOString()}%22`);
    for (const [id, v] of Object.entries(page || {})) if (v && pids.includes(v.productId)) rows.push({ id, ...v });
    start = dayEnd;
  }
  return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

const wrong = await resolvePid(WRONG);
const right = await resolvePid(RIGHT);
console.log(`WRONG ${wrong.pid} "${wrong.name}" ${wrong.styleCode}`);
console.log(`RIGHT ${right.pid} "${right.name}" ${right.styleCode}`);

const rows = await ledgerRows(receiveFrom, nowIso, [wrong.pid, right.pid]);
const history = (await ledgerRows(historyFrom, receiveFrom, [wrong.pid, right.pid])).filter((r) => r.type === "received" || r.type === "opening");

const cells = {};
for (const pid of [wrong.pid, right.pid]) {
  cells[pid] = {};
  for (const loc of LOCATIONS) {
    const m = cellsToMap(await restGet(`stock/${loc}/${pid}`));
    if (Object.keys(m).length) cells[pid][loc] = m;
  }
}

const userNames = {};
for (const uid of new Set([...rows, ...history].map((r) => r.actor).filter((a) => a && !a.startsWith("system:")))) {
  userNames[uid] = (await restGet(`users/${uid}/displayName`)) || uid;
}

const facts = collectFacts({ wrongPid: wrong.pid, rightPid: right.pid, rows, cells, receiveFrom, receiveTo, manualDay, manualActors: manualActors.length ? manualActors : null, userNames });
const historyEvents = [...groupReceiveEvents(history.filter((r) => r.productId === wrong.pid)), ...groupReceiveEvents(history.filter((r) => r.productId === right.pid))]
  .map((e) => ({ ...e, product: e.productId === wrong.pid ? "wrong" : "right", actorName: userNames[e.actor] || e.actor }))
  .sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1));

writeFileSync(out, JSON.stringify({ generatedAt: nowIso, wrong, right, facts, historyEvents, rows }, null, 1));

// ── print ───────────────────────────────────────────────────────────────────
const sast = (iso) => new Date(Date.parse(iso) + SAST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " SAST";
const showSize = (k) => k.replace(/^(\d+)_(\d+)$/, "$1.$2");
const fmt = (sz) => Object.entries(sz).sort(([a], [b]) => parseFloat(showSize(a)) - parseFloat(showSize(b))).map(([k, v]) => `${showSize(k)}:${v}`).join(" ");
const nested = (o) => Object.entries(o).map(([loc, sz]) => `    ${loc.padEnd(12)} ${fmt(sz)}`).join("\n") || "    (none)";

console.log(`\nWindow ${sast(receiveFrom)} → ${sast(receiveTo)}; ${rows.length} ledger rows on the two products.`);
console.log("\nHISTORY — receives on either product before the window:");
for (const e of historyEvents) console.log(`  ${sast(e.firstTs)} ${e.product.padEnd(5)} ${e.actorName} @${e.location} ${e.units}u  ${fmt(e.sizes)}`);
console.log("\na) R — receives onto WRONG:");
for (const e of facts.receiveEvents) console.log(`  ${e.rows[0]} ${sast(e.firstTs)} by ${e.actorName} @${e.location} ${e.units}u  ${fmt(e.sizes)}`);
console.log("   …and onto RIGHT in the same window:");
for (const e of facts.rightEvents) console.log(`  ${e.rows[0]} ${sast(e.firstTs)} by ${e.actorName} @${e.location} ${e.units}u  ${fmt(e.sizes)}`);
console.log(`   matching pairs (same place, ≥60% sizes equal): ${facts.mirrors.length}`);
for (const m of facts.mirrors) console.log(`    wrong ${m.wrongEvent} (${m.wrongUnits}u) ↔ right ${m.rightEvent} (${m.rightUnits}u) ${(m.share * 100).toFixed(0)}%`);
console.log("\n   pre-receive WRONG level per cell where R sits:");
console.log(nested(facts.preLevels));
console.log("\nb) M — candidate manual adds on RIGHT on " + manualDay + ":");
for (const x of facts.manualCandidates) console.log(`  ${x.id} ${sast(x.ts)} ${x.type} by ${x.actorName} @${x.loc} size ${showSize(x.size)} +${x.qty} ${x.reason || ""}`);
console.log(`   counted as M: ${facts.manualActors ? facts.manualActors.join(", ") : "(none confirmed — pass --manual-actor)"}`);
console.log(nested(facts.M));
console.log("\nc) Ws — RIGHT sales since the receive:");
console.log(nested(facts.Ws));
console.log("\nd) Ys — WRONG sales since the receive:");
for (const l of facts.ysLines) console.log(`  ${l.id} ${sast(l.ts)} @${l.loc} size ${showSize(l.size)} qty ${l.qty} pre-receive ${l.preReceiveLevel}${l.ambiguous ? "  AMBIGUOUS" : ""}`);
console.log("\ne) WRONG transfers since the receive:");
for (const t of facts.transfers) console.log(`  ${sast(t.ts)} ${t.from}→${t.to} size ${showSize(t.size)} qty ${t.qty} (receive units moved ${t.phantomMoved}) ${t.reason || ""}`);
for (const o of facts.otherWrong) console.log(`  other: ${sast(o.ts)} ${o.type} size ${showSize(o.size)} qty ${o.qty} ${o.from || ""}→${o.to || ""} ${o.reason || ""}`);
console.log("   R where it sits now:");
console.log(nested(facts.R));
console.log("\nCells now — WRONG:");
console.log(nested(cells[wrong.pid]));
console.log("Cells now — RIGHT:");
console.log(nested(cells[right.pid]));
const plan = planCorrection(facts, { expectedReceiveDay: opt("--expected-receive-day", "2026-11-25") });
console.log(`\nAmbiguous: ${facts.ambiguous.length}`);
for (const a of facts.ambiguous) console.log(`  ${a.loc} ${a.size}: ${a.note}`);
console.log(`\nPlan status if applied as briefed: ${plan.status}`);
for (const b of plan.blockers) console.log(`  BLOCKER ${b.code}: ${b.text}`);
console.log(`\nFacts written to ${out} (receive days: ${[...new Set(facts.receiveEvents.map((e) => sastDay(e.firstTs)))].join(", ") || "none"})`);

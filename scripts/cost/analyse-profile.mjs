#!/usr/bin/env node
// ─── RTDB PROFILER ANALYSER ───────────────────────────────────────────────────
//
// Turns a raw `firebase database:profile --raw` capture into an attribution of
// every downloaded byte: by path, by client, and by (client × path).
//
// WHY THIS IS A COMMITTED SCRIPT rather than a paste-in snippet: the September
// captures are the only reason any bandwidth claim in
// docs/firebase-cost-sept19.md is checkable, and the Monday trading-hours
// capture runs UNATTENDED on the Mac mini
// (scripts/cost/trading-hours-capture.sh). An unattended job cannot depend on
// someone pasting a Python one-liner.
//
// ─── WHAT COUNTS AS A DOWNLOADED BYTE ────────────────────────────────────────
//
// The profiler emits one record per operation. Only operations that stream data
// OUT of the database are billed as "Outgoing Bandwidth". SKIP below is the
// exclusion list, and it is a DENY-list on purpose: a profiler version that adds
// a new read verb should show up in the per-verb table as an unfamiliar line
// rather than silently vanish from the total.
//
// Writes carry a `bytes` payload too — 2,055,917 B of `realtime-write` in the
// 19 September capture — and counting those as download would have inflated the
// total by 0.3%. The REST write verbs are excluded alongside the realtime ones:
// they did not appear in that capture, but a deny-list that covered one
// transport and not the other would be an accident waiting for the first script
// that writes over REST.
//
// ─── PRIVACY: THIS OUTPUT GETS COMMITTED TO A PUBLIC REPO ────────────────────
//
// The analysed markdown is appended to a report in a PUBLIC repository by an
// unattended job. Raw profiler records carry `remoteAddress` — which for the
// staff phones is a personal device's public IP, and identifying a named
// colleague's phone traffic by address in a public file is not something a cost
// report needs to do. Addresses are therefore reduced to a stable 4-character
// tag by default: enough to say "these two reads came from the same device",
// which is the entire analytical need, and not enough to publish anyone's IP.
// `--raw-addresses` restores them for local use.
//
// Usage: node scripts/cost/analyse-profile.mjs capture.jsonl [--md] [--top N]
//                                              [--raw-addresses] [--exclude IP]

import fs from "node:fs";
import crypto from "node:crypto";

// Not billed as outgoing bandwidth: writes (of either transport), connection
// lifecycle, and the unlisten half of a listen.
const SKIP = new Set([
  "realtime-write", "realtime-update", "realtime-transaction",
  "rest-write", "rest-update", "rest-transaction",
  "on-disconnect-put", "on-disconnect-update", "on-disconnect-cancel",
  "run-on-disconnect",
  "concurrent-connect", "concurrent-disconnect",
  "listener-unlisten",
]);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--exclude" && args[args.indexOf(a) - 1] !== "--top");
const asMarkdown = args.includes("--md");
const rawAddresses = args.includes("--raw-addresses");
const topN = Number(args[args.indexOf("--top") + 1]) || 25;
const excludeAddr = args.includes("--exclude") ? args[args.indexOf("--exclude") + 1] : null;

if (!file) {
  console.error("usage: analyse-profile.mjs <capture.jsonl> [--md] [--top N] [--raw-addresses] [--exclude IP]");
  process.exit(2);
}

const records = [];
let dropped = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const t = line.trim();
  if (!t) continue;
  try {
    records.push(JSON.parse(t));
  } catch {
    // A capture killed at the hour boundary ends in a partial line. Dropping it
    // is right; counting it as 0 bytes is not, because that hides a truncation
    // behind a plausible total.
    dropped += 1;
  }
}
if (dropped) process.stderr.write(`! dropped ${dropped} unparseable line(s) (truncated capture?)\n`);

if (!records.length) {
  console.error("no records — the capture is empty");
  process.exit(1);
}

const tag = (addr) =>
  rawAddresses ? addr : "client-" + crypto.createHash("sha256").update(String(addr)).digest("hex").slice(0, 4);

// The top-level path key. /stock/marathon-pe/p1/9/qty and /stock/hub2 both roll
// up to /stock: the question is "which NODE costs", and the per-read detail is
// in the largest-read column instead.
const topKey = (r) => "/" + ((r.path || [])[0] ?? "(root)");
const fullPath = (r) => "/" + (r.path || []).join("/");
const addrOf = (r) => r.client?.remoteAddress?.address ?? "?";
const clientKey = (r) => {
  const ua = r.client?.userAgent || {};
  return `${tag(addrOf(r))} ${ua.os ?? "?"}/${ua.browser ?? "?"}/${ua.version ?? "?"}`;
};

let total = 0;
let firstTs = Infinity;
let lastTs = -Infinity;
let excludedBytes = 0;
const byPath = new Map();
const byClient = new Map();
const byClientPath = new Map();
const opNames = new Map();
const opBytes = new Map();
// Per top-level path: how many reads carried a query, and how many of those the
// database had to answer WITHOUT an index.
const ranged = new Map();
const unindexed = new Map();

// One accumulator shape everywhere, so the "largest single read" column is
// populated in every table rather than only the first one. (It used to be
// filled in for paths alone, which left the client table printing 0 B.)
const bump = (map, k, bytes, sample) => {
  const cur = map.get(k) || { bytes: 0, reads: 0, max: 0, sample: "" };
  cur.bytes += bytes;
  cur.reads += 1;
  if (bytes > cur.max) { cur.max = bytes; cur.sample = sample; }
  map.set(k, cur);
};

for (const r of records) {
  if (Number.isFinite(r.timestamp)) {
    firstTs = Math.min(firstTs, r.timestamp);
    lastTs = Math.max(lastTs, r.timestamp);
  }
  opNames.set(r.name, (opNames.get(r.name) || 0) + 1);
  opBytes.set(r.name, (opBytes.get(r.name) || 0) + (r.bytes || 0));
  if (SKIP.has(r.name)) continue;

  if (excludeAddr && addrOf(r) === excludeAddr) { excludedBytes += r.bytes || 0; continue; }

  const bytes = r.bytes || 0;
  total += bytes;

  const p = topKey(r);
  bump(byPath, p, bytes, fullPath(r));

  // A read carrying a query is server-side BOUNDED; one the profiler marks
  // `unIndexed` was answered by scanning, which costs the whole node. The two
  // must be distinguishable or an already-ranged path looks as guilty as a
  // whole-node one.
  //
  // The field is `querySet` (an array, on listener-listen records) and the flag
  // is `unIndexed`. An earlier version of this script looked for `querySpec`,
  // `query` and `indexOn`, none of which the profiler emits — so it reported
  // "0 ranged" on every path in every capture, which is exactly the false
  // negative it was added to prevent.
  if (Array.isArray(r.querySet) && r.querySet.length) {
    ranged.set(p, (ranged.get(p) || 0) + 1);
    if (r.unIndexed) unindexed.set(p, (unindexed.get(p) || 0) + 1);
  }

  const c = clientKey(r);
  bump(byClient, c, bytes, p);
  bump(byClientPath, `${c}\u0000${p}`, bytes, fullPath(r));
}

const minutes = (lastTs - firstTs) / 60000;
const GIB = 1024 ** 3;
// The rate the September bill actually implies: $272.13 for 278.81 GiB.
const RATE = 0.97604;

const n = (x) => x.toLocaleString("en-US");
const pct = (x) => (total ? ((x / total) * 100).toFixed(1) + "%" : "—");

const out = [];
const H = (s) => out.push(asMarkdown ? `\n### ${s}\n` : `\n=== ${s} ===`);

out.push(asMarkdown ? `## Capture: ${file}` : `CAPTURE: ${file}`);
out.push(`records: ${n(records.length)}${dropped ? ` (+${dropped} unparseable)` : ""}`);

// A single-record capture, or one whose records carry no usable timestamp,
// gives a zero-length window. Annualising that produces a confident $0.00/day,
// and a false zero in a cost report is worse than no number at all.
const windowUsable = Number.isFinite(firstTs) && Number.isFinite(lastTs) && minutes > 0;
if (windowUsable) {
  out.push(`window: ${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()} (${minutes.toFixed(1)} min)`);
} else {
  out.push(`window: NOT MEASURABLE — the capture spans no time (one record, or no usable timestamps)`);
}
out.push(`downloaded: ${n(total)} B = ${(total / 1e6).toFixed(2)} MB`);
// `--exclude` takes a raw address on the command line, so echoing it back
// would reintroduce exactly the address this script anonymises everywhere else
// — and the excluded client is the one most likely to be somebody's own
// machine. It is tagged like every other client unless --raw-addresses says
// otherwise.
if (excludeAddr) {
  out.push(`excluded (${tag(excludeAddr)}): ${n(excludedBytes)} B = ${(excludedBytes / 1e6).toFixed(2)} MB`);
}
if (windowUsable) {
  const perDayGiB = (total / GIB) * (1440 / minutes);
  out.push(`annualised: ${perDayGiB.toFixed(2)} GiB/day = $${(perDayGiB * RATE).toFixed(2)}/day at $${RATE}/GiB`);
} else {
  out.push(`annualised: n/a — see the window line above`);
}

const rows = (m, label, showQuery) => {
  const sorted = [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, topN);
  if (asMarkdown) {
    out.push(`| ${label} | Bytes | Share | Reads | Largest single read |`);
    out.push(`|---|---:|---:|---:|---:|`);
    for (const [k, v] of sorted) {
      const q = showQuery && ranged.get(k)
        ? ` · ${ranged.get(k)} ranged${unindexed.get(k) ? `, ${unindexed.get(k)} UNINDEXED` : ""}`
        : "";
      out.push(`| \`${k}\` | ${n(v.bytes)} | ${pct(v.bytes)} | ${n(v.reads)}${q} | ${n(v.max)} B |`);
    }
  } else {
    for (const [k, v] of sorted) {
      const q = showQuery && ranged.get(k) ? `  (${ranged.get(k)} ranged${unindexed.get(k) ? `, ${unindexed.get(k)} UNINDEXED` : ""})` : "";
      out.push(`${String(v.bytes).padStart(14)} ${pct(v.bytes).padStart(6)} ${String(v.reads).padStart(7)}r  max ${String(v.max).padStart(10)}  ${k}${q}`);
    }
  }
};

H("By path");
rows(byPath, "Path", true);

H("By client");
rows(byClient, rawAddresses ? "Client (ip os/browser/version)" : "Client (tag os/browser/version)", false);

H("By client × path (top pairs)");
const pairs = [...byClientPath.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, topN);
if (asMarkdown) {
  out.push(`| Client | Path | Bytes | Share |`);
  out.push(`|---|---|---:|---:|`);
  for (const [k, v] of pairs) {
    const [c, p] = k.split("\u0000");
    out.push(`| \`${c}\` | \`${p}\` | ${n(v.bytes)} | ${pct(v.bytes)} |`);
  }
} else {
  for (const [k, v] of pairs) {
    const [c, p] = k.split("\u0000");
    out.push(`${String(v.bytes).padStart(14)} ${pct(v.bytes).padStart(6)}  ${c}  ${p}`);
  }
}

// Every verb, billed or not, with its payload. This is where a profiler that
// starts emitting a new verb becomes visible instead of silently changing the
// total, and it is also the evidence for the two exclusions above being right.
H("Operation verbs (billed as download unless marked)");
if (asMarkdown) {
  out.push(`| Verb | Records | Bytes | Counted? |`);
  out.push(`|---|---:|---:|---|`);
  for (const [k, v] of [...opNames.entries()].sort((a, b) => (opBytes.get(b[0]) || 0) - (opBytes.get(a[0]) || 0))) {
    out.push(`| \`${k}\` | ${n(v)} | ${n(opBytes.get(k) || 0)} | ${SKIP.has(k) ? "no — not a download" : "yes"} |`);
  }
} else {
  for (const [k, v] of [...opNames.entries()].sort((a, b) => (opBytes.get(b[0]) || 0) - (opBytes.get(a[0]) || 0))) {
    out.push(`${String(opBytes.get(k) || 0).padStart(14)} ${String(v).padStart(7)}  ${k}${SKIP.has(k) ? "   (not counted)" : ""}`);
  }
}

console.log(out.join("\n"));

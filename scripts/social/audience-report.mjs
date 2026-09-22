// ─── WHO ACTUALLY FOLLOWS US — READ ONLY ─────────────────────────────────────
//
//   node scripts/social/audience-report.mjs
//
// EVERY CALL IS A GET. This script cannot post, cannot delete, cannot remove a
// follower — and neither can anything else, because the Instagram Graph API
// has no endpoint that removes a follower and no edge that lists them. That is
// not a gap in this script; it is the shape of the API (checked 2026-08-27:
// the IG User node exposes no `followers` edge, and create/update/delete are
// "not supported").
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Followers bought in 2019 are still in the count. The question is how much of
// the base is inert, and the honest answer needs three things the public
// fields cannot give: demographics (where they claim to be), reach (how many
// are actually SERVED a post) and accounts_engaged (how many do anything).
//
// All three live behind `instagram_manage_insights`. If the token lacks it,
// this script says so in one line and prints the estimate it CAN defend rather
// than a number it cannot.

import { createRequire } from "module";
import { readSecret } from "./secrets.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const GRAPH = "https://graph.facebook.com/v21.0";

const token = await readSecret("meta-page-access-token");
const IG = await readSecret("meta-ig-user-id");
if (!token || !IG) { console.error("Meta is not connected — run scripts/social/meta-token.mjs"); process.exit(2); }

async function get(path, params = {}) {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    try {
      const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { ok: r.ok, status: r.status, json, text };
    } catch (e) { if (i === 2) return { ok: false, status: 0, text: String(e.message) }; }
  }
}

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(2) : "0.00");
const bar = (n, max, w = 28) => "█".repeat(Math.max(0, Math.round((n / (max || 1)) * w)));

// ── 1. the public facts ──────────────────────────────────────────────────────
const acct = await get(IG, { fields: "username,followers_count,follows_count,media_count" });
if (!acct.ok) { console.error("could not read the account:", acct.text.slice(0, 200)); process.exit(1); }
const A = acct.json;
console.log(`\n@${A.username}`);
console.log(`  followers ${A.followers_count}   following ${A.follows_count}   posts ${A.media_count}`);
console.log(`  ratio ${(A.followers_count / Math.max(1, A.follows_count)).toFixed(0)}:1   followers per lifetime post ${(A.followers_count / Math.max(1, A.media_count)).toFixed(0)}`);

// ── 2. engagement actually observed, per post ────────────────────────────────
const media = await get(`${IG}/media`, { fields: "timestamp,media_type,like_count,comments_count", limit: 100 });
const posts = media.ok ? (media.json.data || []) : [];
const engagement = posts.map((m) => (m.like_count || 0) + (m.comments_count || 0));
const total = engagement.reduce((s, n) => s + n, 0);
const best = Math.max(0, ...engagement);
console.log(`\nENGAGEMENT OBSERVED  (${posts.length} posts readable)`);
console.log(`  total actions ${total}   best single post ${best}   mean ${(total / Math.max(1, posts.length)).toFixed(1)}`);
console.log(`  mean engagement rate ${pct(total / Math.max(1, posts.length), A.followers_count)}% of followers`);

// ── THE ESTIMATE, AND ITS HONEST BOUNDS ──────────────────────────────────────
// The API never says WHO engaged, so the engaged pool can only be bracketed:
// if every action came from a different account it is `total`; if the same
// people act every time it is at least `best`. Both bounds are printed because
// quoting one number here would be inventing precision.
console.log(`\n  accounts that have EVER been observed engaging: between ${best} and ${total}`);
console.log(`  i.e. never observed engaging: ${A.followers_count - total} to ${A.followers_count - best}` +
  `  (${pct(A.followers_count - total, A.followers_count)}%–${pct(A.followers_count - best, A.followers_count)}%)`);
console.log(`  NOTE: "never liked a post" is not "fake". It is an upper bound on dead, not a count of it.`);

// ── 3. the three metrics that would settle it ────────────────────────────────
const demo = await get(`${IG}/insights`, {
  metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: "country" });

if (!demo.ok && /permission/i.test(demo.text)) {
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`INSIGHTS ARE LOCKED. The token has no instagram_manage_insights,`);
  console.log(`so demographics, reach and accounts_engaged cannot be read and the`);
  console.log(`numbers above are the most that can be said honestly.`);
  console.log(`Fix: re-mint with the sixth scope — SOCIAL-SETUP.md §3a.`);
  console.log(`──────────────────────────────────────────────────────────────\n`);
  process.exit(0);
}

const rows = demo.ok
  ? (demo.json.data?.[0]?.total_value?.breakdowns?.[0]?.results || [])
      .map((r) => ({ key: r.dimension_values[0], value: r.value }))
      .sort((a, b) => b.value - a.value)
  : [];
if (rows.length) {
  const max = rows[0].value;
  console.log(`\nFOLLOWERS BY COUNTRY  (top 15 of ${rows.length})`);
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.key.padEnd(4)} ${String(r.value).padStart(6)}  ${pct(r.value, A.followers_count).padStart(5)}%  ${bar(r.value, max)}`);
  }
  const za = rows.find((r) => r.key === "ZA")?.value || 0;
  console.log(`\n  home market (ZA): ${za} (${pct(za, A.followers_count)}%)`);
  console.log(`  everywhere else : ${A.followers_count - za} (${pct(A.followers_count - za, A.followers_count)}%)`);
  console.log(`  A store that ships one country and follows 45 accounts has no organic`);
  console.log(`  reason for a large foreign share. That share is the bought-follower shape.`);
}

// ── 4. reach and engaged accounts, last 30 days ──────────────────────────────
const since = now - 30 * DAY;
const reach = await get(`${IG}/insights`, { metric: "reach", period: "day", since, until: now });
if (reach.ok) {
  const vals = (reach.json.data?.[0]?.values || []).map((v) => v.value || 0);
  const peak = Math.max(0, ...vals);
  console.log(`\nREACH, LAST 30 DAYS`);
  console.log(`  best day ${peak}  (${pct(peak, A.followers_count)}% of the follower count)`);
  console.log(`  mean day ${(vals.reduce((s, n) => s + n, 0) / Math.max(1, vals.length)).toFixed(0)}`);
  console.log(`  Reach is the number that matters: a follower never served a post is`);
  console.log(`  not in the audience, whatever the count says.`);
}
const eng = await get(`${IG}/insights`, {
  metric: "accounts_engaged", metric_type: "total_value", period: "day", since, until: now });
if (eng.ok) {
  const v = eng.json.data?.[0]?.total_value?.value ?? 0;
  console.log(`\nACCOUNTS ENGAGED, LAST 30 DAYS: ${v}  (${pct(v, A.followers_count)}% of followers)`);
  console.log(`  THIS is the real number for how much of the base is alive.`);
}
console.log();
process.exit(0);

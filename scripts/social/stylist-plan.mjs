// ─── WHAT THE STYLIST WOULD PICK TODAY, PER LOOK — NOTHING GENERATED ─────────
// Reads the lookbook's candidates and their cached style tags exactly as
// makeLookbook does (an untagged product is read from its name here; nothing
// is tagged and nothing is written), then prints, for each named look in
// docs/style-guide.md, the best outfit inside the price band: its rows, each
// piece's tags, the score and its parts, and why. Free: no model is called.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json \
//     node scripts/social/stylist-plan.mjs [--look <key>] [--json]
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = require("firebase-admin");
const lookbook = require("./lib/social-lookbook.cjs");
const guide = require("./lib/style-guide.json");
const { loadLookbookCandidates, loadLookbookHistory } = require("./lookbook/load.cjs");
const { ensureStyleTags } = require("./lookbook/style-tags-io.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const nowMs = Date.now();
const saDate = saDateStringFromMs(nowMs);
const month = Number(saDate.slice(5, 7));

const [{ candidates, reads }, history] = await Promise.all([loadLookbookCandidates(db, { nowMs }), loadLookbookHistory(db)]);
const recent = lookbook.recentLookbookPids(history);
const blocked = lookbook.pidsWithinDays(history, saDate, 14);
const t = await ensureStyleTags(db, candidates.map((c) => ({ pid: c.pid, product: c.product, websiteName: c.name })), {}, { nowMs });
console.log(`${candidates.length} candidates (${reads.products} product reads) · tags: ${t.tags.size - t.named} cached, ${t.named} from names · ${blocked.size} blocked (14 days)`);

const out = [];
for (const look of [null, ...guide.looks.map((l) => l.key)].filter((k) => !arg("look") || k === arg("look"))) {
  const p = lookbook.pickLookbookOutfit(candidates, { recent, blocked, tags: t.tags, month, look });
  if (p.reason) { console.log(`\n${look || "ANY"}: ${p.reason}`); out.push({ look, reason: p.reason }); continue; }
  const c = lookbook.chooseLookbookOutfit(p, "", { month });
  const tags = Object.fromEntries(c.styled.pieces.map((x) => [x.pid, x.tags]));
  console.log(`\n${look || "ANY"} → ${c.look.name || "no named look"} · ${c.styled.score}/100 · ${c.total} · shortlist ${p.shortlist.length}`);
  for (const r of c.rows) {
    const g = tags[r.pid];
    console.log(`  ${r.slot.padEnd(9)} ${`${r.brandLine} ${r.nameLine}`.slice(0, 52).padEnd(52)} ${r.priceText.padStart(7)}  ${g.dominant}${g.secondary ? `/${g.secondary}` : ""} · ${g.pattern} · ${g.silhouette} · ${g.family} · f${g.formality} · ${g.season}${g.source === "name" ? " (name)" : ""}`);
  }
  console.log(`  parts: ${JSON.stringify(c.styled.parts)}`);
  console.log(`  why: ${c.styled.reasoning}`);
  out.push({ look, name: c.look.name, score: c.styled.score, total: c.total, rows: c.rows.map((r) => ({ slot: r.slot, pid: r.pid, name: `${r.brandLine} ${r.nameLine}`, price: r.price, tags: tags[r.pid] })), parts: c.styled.parts, reasoning: c.styled.reasoning });
}
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
process.exit(0);

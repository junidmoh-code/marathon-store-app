// ─── THE LOCAL STYLIST, ON THE MAC MINI ──────────────────────────────────────
// Junid, 1 Nov 2026: every full outfit deliberately styled, South African
// streetwear, variety across days, chosen by a free local model.
//
//   1. the whole website-ready catalogue (lookbook/load.cjs with no read cap),
//      offered exactly as the cloud offers it (fitOffer / fitOfferForOutfit:
//      menswear, in season, in stock in two sizes, real website names);
//   2. the variety ledger (~/.marathon-stylist/ledger.json), reconciled with
//      what really went out: nothing worn in 14 days (pid, colourway, or a
//      photo Fashion-CLIP reads as the same garment), no top + bottoms pair
//      twice in 30;
//   3. Fashion-CLIP (stylist/embed.py) reads each photo: colour, style,
//      statement, embedding; lib/local-stylist shortlists outfits with one hero
//      colour, no two statements, coherent style, under R2,000 (R1,400–R1,800
//      preferred);
//   4. Gemma 4 (Ollama, localhost) sees one photo collage per shortlisted
//      outfit, follows the rulebooks (functions/lib/fit-rulebook.md +
//      stylist/rulebook.md) and picks one, naming it and writing the caption;
//   5. the validator re-checks everything and reruns with the problems;
//   6. the pick goes to social_stylist/picks/{saDate}/{kind}; the ledger is
//      written and printed.
//
//   node stylist/run.mjs                    today: lookbook (on a lookbook day) + outfit
//   node stylist/run.mjs --date 2026-11-02 --kinds lookbook --force
//   node stylist/run.mjs --review 7 --out ~/Desktop/stylist-review   seven in a row, offline, nothing written
//   --dry   nothing written to the database or the ledger
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatJSON, modelReady } from "./ollama.mjs";
import { send as sendMail } from "./mail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "../functions/package.json"));
const admin = require("firebase-admin");
const sharp = require("sharp");
const lookbook = require("./lib/social-lookbook.cjs");
const socialStylist = require("./lib/social-stylist.cjs");
const ls = require("./lib/local-stylist.cjs");
const fr = require("./lib/fit-rules.cjs");
const stylist = require("./lib/stylist.cjs");
const { loadLookbookCandidates } = require("./lookbook/load.cjs");
const { historySlots } = require("./lookbook/lookbook.cjs");
const { ensureStyleTags } = require("./lookbook/style-tags-io.cjs");
const { saDateStringFromMs } = require("./lib/sa-time.cjs");

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const HOME = process.env.STYLIST_HOME || path.join(os.homedir(), ".marathon-stylist");
const PY = process.env.STYLIST_PYTHON || path.join(HOME, "venv/bin/python");
const MODEL = process.env.STYLIST_MODEL || arg("model") || ls.LOCAL_MODEL_DEFAULT;
const LEDGER = arg("ledger") || path.join(HOME, "ledger.json");
const REVIEW = Number(arg("review", 0)) || 0;
const DRY = flag("dry") || REVIEW > 0;
const MAX_TRIES = 4;
// The scheduled run must finish before the 06:00 reels read the outfit pick:
// past 05:55 SAST no new model call starts (a manual --date/--force run has no deadline).
const DEADLINE_MS = (() => {
  if (REVIEW || flag("force") || arg("date")) return Infinity;
  const d = new Date(); const sast = new Date(d.getTime() + 2 * 3600000);
  return Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate(), 3, 55);
})();
const log = (m) => console.log(`[stylist ${new Date().toISOString()}] ${m}`);

if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

// ── helpers ─────────────────────────────────────────────────────────────────
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return { entries: [] }; } };
const writeLedger = (l) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(`${LEDGER}.tmp`, JSON.stringify(l, null, 1)); fs.renameSync(`${LEDGER}.tmp`, LEDGER); };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function embed(items) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [path.join(HERE, "embed.py")], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", (code) => { if (code) return reject(new Error(`embed.py exited ${code}`)); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    p.stdin.end(JSON.stringify({ items, colours: ls.COLOURS, styles: ls.STYLES }));
  });
}

const photoCache = new Map();
async function photo(url) {
  if (!photoCache.has(url)) {
    photoCache.set(url, (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`photo ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    })());
  }
  return photoCache.get(url);
}

/** One outfit as one picture: its pieces left to right, labelled. */
async function collage(option, n, tile = 360) {
  const tiles = [];
  for (const p of option.pieces) {
    let buf;
    try { buf = await sharp(await photo(p.photoUrl)).resize(tile, tile, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer(); } catch { buf = await sharp({ create: { width: tile, height: tile, channels: 3, background: "#eeeeee" } }).png().toBuffer(); }
    tiles.push(buf);
  }
  const W = tile * tiles.length, H = tile + 44;
  const label = Buffer.from(`<svg width="${W}" height="44" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="14" y="30" font-family="Helvetica" font-size="24" fill="#fff">OUTFIT ${n}  ·  R${option.total}  ·  ${option.pieces.map((p) => p.slot).join(" / ")}</text></svg>`);
  return sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite([{ input: label, top: 0, left: 0 }, ...tiles.map((t, i) => ({ input: t, top: 44, left: i * tile }))])
    .jpeg({ quality: 86 }).toBuffer();
}

// ── the catalogue, once per run ──────────────────────────────────────────────
async function loadWorld(nowMs, saDate) {
  const month = Number(saDate.slice(5, 7));
  const season = stylist.seasonOf(month);
  const t0 = Date.now();
  const { candidates, reads } = await loadLookbookCandidates(db, { nowMs, readsPerSlot: 5000,
    skipHeadwear: ["beanie", "bucket", "visor"].filter((k) => !stylist.seasonRulesFor(season).headwear.includes(k)) });
  const tags = (await ensureStyleTags(db, candidates.map((c) => ({ pid: c.pid, product: c.product, websiteName: c.name })), {}, { nowMs, maxNew: 0 })).tags;
  log(`catalogue: ${candidates.length} live website-ready products (${reads.products} records read, ${Math.round((Date.now() - t0) / 1000)} s)`);
  const byPid = new Map(candidates.map((c) => [c.pid, c]));
  const historySnap = await db.ref("social_lookbook/history").orderByKey().limitToLast(30).once("value");
  const history = historySnap.val() || {};
  const posts = (await db.ref("social_posts").orderByKey().limitToLast(300).once("value")).val() || {};
  return { candidates, tags, byPid, history, posts, month, season };
}

// The style guide's palette names → the stylist's colours (null: not mappable).
const PALETTE_TO = { charcoal: "black", "off-white": "white", "light-grey": "grey", stone: "beige", camel: "tan", sand: "beige", "denim-light": "blue denim", "denim-mid": "blue denim", "denim-dark": "blue denim", "sky-blue": "light blue", "royal-blue": "light blue", "forest-green": "green", maroon: "burgundy", wine: "burgundy", lilac: "purple", mint: "green", sage: "green", gold: "yellow", silver: "grey", multi: null };
function paletteColour(name) {
  const k = String(name || "").toLowerCase().trim().replace(/\s+/g, "-");
  if (!k) return null;
  if (k in PALETTE_TO) return PALETTE_TO[k];
  const plain = k.replace(/-/g, " ");
  return ls.COLOURS.includes(plain) ? plain : null;
}
const familyOf = (c) => c && c.product ? lookbook.styleFamily(c.product.name, lookbook.posterBrand(c.product) || c.product.brand || "") : null;

/** The ledger reconciled with what really went out (lookbook history + outfit/lookbook posts). */
async function reconcile(ledger, world, today) {
  const real = new Map();
  const put = (date, kind, pids, theme) => {
    const key = `${date}|${kind}`;
    if (!real.has(key)) real.set(key, { date, kind, pids: new Set(), theme });
    for (const p of pids) real.get(key).pids.add(p);
  };
  for (const [date, e] of Object.entries(world.history)) {
    const pids = Array.isArray(e && e.pids) ? e.pids : Object.values((e && e.pids) || {});
    put(date, "lookbook", pids.filter((x) => typeof x === "string"), e && e.formula);
  }
  for (const p of Object.values(world.posts)) {
    // Samples count too: Junid sees them, and the Diesel Grey cargo jean he
    // called "the same jeans" was worn in seven samples, never in a post.
    if (!p || !["outfit", "lookbook"].includes(p.kind) || !["approved", "posting", "posted", "sample"].includes(p.status)) continue;
    const at = Number(p.createdAt || p.scheduledAt) || 0;
    if (!at) continue;
    put(saDateStringFromMs(at), p.kind, (p.products || []).map((x) => x && x.pid).filter(Boolean), p.look && p.look.key);
  }
  const unknown = [...new Set([...real.values()].flatMap((r) => [...r.pids]).filter((pid) => !world.byPid.has(pid)))];
  const famOther = new Map();
  await Promise.all(unknown.map(async (pid) => { const f = await lookbook.familiesOf(db, [pid]); if (f.size) famOther.set(pid, [...f][0]); }));
  let entries = ((ledger && ledger.entries) || []).filter((e) => !(e.status === "planned" && e.date < today));
  for (const r of real.values()) {
    const pieces = [...r.pids].map((pid) => {
      const c = world.byPid.get(pid);
      return { pid, slot: c ? lookbook.lookbookSlot(c.product) : null, family: c ? familyOf(c) : famOther.get(pid) || null, price: c ? c.retailPrice : 0 };
    });
    const e = ls.ledgerEntry(r.date, r.kind, pieces, { status: "posted", theme: r.theme || null });
    entries = ls.ledgerWith({ entries }, e).entries;
  }
  return { entries };
}

// ── one pick ────────────────────────────────────────────────────────────────
async function pickOne(world, kind, saDate, ledger, { used = new Set(), avoidFormulas = [] } = {}) {
  const { candidates, tags, month, season } = world;
  let offer, why;
  if (kind === "lookbook") {
    const noHeadwear = lookbook.headwearRests(await historySlots(db, world.history, saDate), saDate);
    const o = lookbook.fitOffer(candidates, { tags, month, noHeadwear, used });
    offer = o.offer; why = o.reason;
    if (noHeadwear) log("lookbook: no headwear today (one lookbook in three)");
  } else {
    const o = socialStylist.fitOfferForOutfit(candidates.filter((c) => !used.has(c.pid)), { tags, month });
    offer = o.offer; why = o.reason;
  }
  if (!offer) return { ok: false, reason: why };
  const blocks = ls.ledgerBlocks(ledger, saDate);
  const pieces = offer.pieces.map((p) => ({ ...p, family: familyOf(world.byPid.get(p.pid)), photoUrl: p.photoUrl || (p.ref && p.ref.photoUrl) || (p.row && p.row.photoUrl) }));
  // Fashion-CLIP: every offered piece, and the recent ones still live (for the near-duplicate rule).
  const recentPids = [...blocks.pids].filter((pid) => world.byPid.has(pid));
  const want = [...pieces.map((p) => ({ pid: p.pid, url: p.photoUrl, slot: p.slot })),
    ...recentPids.map((pid) => { const c = world.byPid.get(pid); return { pid, url: c.photoUrl, slot: lookbook.lookbookSlot(c.product) }; })]
    .filter((x) => x.url);
  const emb = world.emb || (world.emb = {});
  const missing = want.filter((x) => !emb[x.pid]);
  if (missing.length) Object.assign(emb, await embed(missing));
  // Fashion-CLIP's plain-vs-loud reading is bimodal (median 0.96 on 1 Nov):
  // a statement is the loudest quarter of its own slot. Light-blue or navy
  // bottoms are denim, a neutral.
  const loud = new Map();
  for (const s of ls.SLOT_ORDER) {
    const xs = pieces.filter((p) => p.slot === s && emb[p.pid]).sort((a, b) => emb[a.pid].statement - emb[b.pid].statement);
    xs.forEach((p, i) => loud.set(p.pid, xs.length > 1 ? i / (xs.length - 1) : 0));
  }
  // The colour: the product's photo tag (a vision model asked for the colour
  // covering most of it) when there is one, else Fashion-CLIP's. CLIP read
  // white shorts with a black graffiti print as black (1 Nov review run).
  for (const p of pieces) {
    const e = emb[p.pid];
    if (!e) { p.emb = null; continue; }
    const tagged = p.tags && p.tags.source !== "name" ? paletteColour(p.tags.dominant) : null;
    let colour = tagged || e.colour;
    if (p.slot === "bottoms" && ["light blue", "navy"].includes(colour)) colour = "blue denim";
    p.emb = { ...e, colour, colourFrom: tagged ? "tag" : "clip", statement: loud.has(p.pid) && loud.get(p.pid) >= 0.75 ? 0.9 : 0.1 };
  }
  const recentVecs = recentPids.filter((pid) => emb[pid]).map((pid) => ({ slot: lookbook.lookbookSlot(world.byPid.get(pid).product), vec: emb[pid].vec }));
  const { pool, relaxed, removed } = ls.poolOf(pieces.filter((p) => p.emb), blocks, { recentVecs, saDate });
  log(`${kind}: pool ${pool.length} of ${pieces.length} offered (${removed} kept out by the ledger)${relaxed.length ? `; RELAXED for ${relaxed.join(", ")}: nothing unworn in 14 days, the least recently worn are offered` : ""}`);
  const relaxedPids = new Set(pool.filter((p) => relaxed.includes(p.slot)).map((p) => p.pid));
  const checkBlocks = { ...blocks, pids: new Set([...blocks.pids].filter((p) => !relaxedPids.has(p))), families: new Set([...blocks.families].filter((f) => !pool.some((p) => relaxedPids.has(p.pid) && p.family === f))) };
  const extrasAllowed = ls.EXTRAS.filter((s) => offer.slots.includes(s) && !(s === "jacket" && season === "summer" && kind !== "lookbook"));
  const { options, considered, refused } = ls.shortlistOutfits(pool, { blocks, saDate, kind, extrasAllowed, minPieces: offer.minPieces, maxPieces: offer.maxPieces });
  log(`${kind}: ${considered} combinations considered, ${options.length} shortlisted; refused: ${Object.entries(refused).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join("; ") || "none"}`);
  if (!options.length) return { ok: false, reason: "no outfit passes the palette, price and variety rules" };
  const images = [];
  for (let i = 0; i < options.length; i++) images.push((await collage(options[i], i + 1)).toString("base64"));
  const system = `You are the menswear stylist for Marathon Club, an online sneaker and streetwear store in Durban, South Africa.\n\n${fr.rulebook().text}\n\n${fs.readFileSync(path.join(HERE, "rulebook.md"), "utf8")}`;
  const formulas = fr.formulasFor(season).map((f) => f.key);
  const feedback = [];
  // An outfit Gemma chose that failed twice leaves the table: the next try
  // must choose another (a small model can loop on one option's caption).
  const fails = new Map();
  let live = options.map((o, i) => ({ o, img: images[i] }));
  for (let t = 1; t <= MAX_TRIES + 1; t++) {
    if (Date.now() > DEADLINE_MS) { feedback.push("past the 05:55 deadline"); break; }
    let ans;
    try {
      ans = await chatJSON({ model: MODEL, system, prompt: ls.localPrompt({ options: live.map((x) => x.o), kind, season, formulas, avoidFormulas, feedback }), images: live.map((x) => x.img), schema: ls.LOCAL_SCHEMA, temperature: Math.min(0.9, 0.4 + 0.12 * (t - 1)) });
    } catch (e) { feedback.push(String(e.message).slice(0, 200)); log(`${kind}: try ${t} failed — ${e.message}`); continue; }
    const v = ls.validateLocal(ans.json, live.map((x) => x.o), offer, { blocks: checkBlocks });
    // Variety across days: the previous post's formula again is sent back while tries remain.
    if (v.ok && avoidFormulas[0] && v.answer.formula === avoidFormulas[0] && t < MAX_TRIES) { v.ok = false; v.problems.push(`the last post was ${avoidFormulas[0]}: choose a different outfit or formula`); }
    log(`${kind}: try ${t} (${Math.round(ans.ms / 1000)} s) chose outfit ${ans.json.option} — ${(v.answer && v.answer.theme) || ans.json.theme} — ${v.ok ? "VALID" : `rejected: ${v.problems.join("; ")}`}`);
    if (v.ok) return { ok: true, option: v.option, answer: v.answer, json: ans.json, attempts: t, options, relaxed, offer };
    feedback.push(v.problems.join("; "));
    if (v.option) {
      fails.set(v.option, (fails.get(v.option) || 0) + 1);
      if (fails.get(v.option) >= 2 && live.length > 1) {
        live = live.filter((x) => x.o !== v.option);
        feedback.length = 0;
        feedback.push("That outfit kept failing and has been removed; the outfits are renumbered.");
        log(`${kind}: outfit dropped after two failed answers; ${live.length} left`);
      }
    }
  }
  return { ok: false, reason: `no valid answer from ${MODEL} after ${MAX_TRIES} tries: ${feedback.slice(-1)[0]}` };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!(await modelReady(MODEL).catch(() => false))) {
    const why = `${MODEL} is not available on ${process.env.OLLAMA_URL || "127.0.0.1:11434"}`;
    if (!DRY) await alert("Stylist: the local model is not running", `${why}.\n\nNo outfit was picked; the lookbook day posts the current style and the outfit post is skipped. launchd (com.marathon.ollama) restarts the server by itself; the 05:40 retry tries again.`);
    throw new Error(why);
  }
  const nowMs = Date.now();
  const today = arg("date") || saDateStringFromMs(nowMs);
  const world = await loadWorld(nowMs, today);
  let ledger = await reconcile(readLedger(), world, today);
  if (!DRY) writeLedger(ledger);

  if (REVIEW) return review(world, today, ledger);

  const days = lookbook.parseLookbookDays(process.env.LOOKBOOK_DAYS);
  const kinds = arg("kinds") ? arg("kinds").split(",") : [...(days.includes(lookbook.weekdayOf(today)) ? ["lookbook"] : []), "outfit"];
  // Pieces already spoken for: anything waiting in the queue (draft, approved,
  // posting: one product, one queue item) and anything posted today. The 07:00
  // lookbook refuses them, so the pick never uses them (architect review).
  const used = new Set();
  const dayStart = Date.parse(`${today}T00:00:00+02:00`);
  for (const p of Object.values(world.posts)) {
    if (!p || p.status === "sample") continue;
    const at = Number(p.createdAt || p.scheduledAt) || 0;
    if (["draft", "approved", "posting"].includes(p.status) || at >= dayStart) for (const x of p.products || []) if (x && x.pid) used.add(x.pid);
  }
  log(`${used.size} piece(s) already in the queue or posted today are not offered`);
  const missed = [];
  for (const kind of kinds) {
    const ref = db.ref(`${ls.PICKS_PATH}/${today}/${kind}`);
    const have = (await ref.once("value")).val();
    if (have && !flag("force")) { log(`${kind}: ${today} already picked (${have.answer && have.answer.theme}) — use --force to pick again`); for (const p of ls.pickPids(have, today)) used.add(p); continue; }
    const r = await pickOne(world, kind, today, ledger, { used, avoidFormulas: lookbook.recentFormulas(world.history, 3) });
    if (!r.ok) { log(`${kind}: NO PICK — ${r.reason}. The cloud falls back (lookbook → current style; outfit → skipped).`); missed.push(`${kind}: ${r.reason}`); continue; }
    const rec = ls.pickRecord({ saDate: today, kind, model: MODEL, answer: r.answer, option: r.option, json: r.json, attempts: r.attempts, ledgerSize: ledger.entries.length, relaxed: r.relaxed, atMs: Date.now() });
    if (!DRY) await ref.set(rec);
    for (const p of r.option.pieces) used.add(p.pid);
    ledger = ls.ledgerWith(ledger, ls.ledgerEntry(today, kind, r.option.pieces, { status: "planned", theme: r.answer.theme }));
    if (!DRY) writeLedger(ledger);
    log(`${kind}: PICKED ${r.answer.theme} R${r.option.total} — ${r.option.pieces.map((p) => `${p.slot}: ${p.brand} ${p.name} R${p.price}`).join(" | ")}`);
    log(`${kind}: note — ${r.answer.why}`);
  }
  log(`variety ledger (${LEDGER}), last ${ls.PAIR_DAYS} days:`);
  for (const l of ls.ledgerLines(ledger, today)) console.log(`   ${l}`);
  if (missed.length && !DRY) await alert(`Stylist: no outfit picked for ${today}`, [`The local stylist on the Mac mini made no pick for ${today}:`, "", ...missed, "", "The lookbook (if today is a lookbook day) posts the current style instead, and the outfit post is skipped. No paid model stood in.", `Log: ~/.marathon-stylist/logs/stylist-${today}.log on the Mac mini.`].join("\n"));
}

/** Tell Junid by email; never fails the run. */
async function alert(subject, text) {
  try { const i = await sendMail({ subject, text }); log(`alert emailed (${i.messageId})`); } catch (e) { log(`alert NOT emailed: ${e.message}`); }
}

/** N outfits on N consecutive days, offline, each one added to a scratch ledger. */
async function review(world, start, ledger) {
  const out = arg("out") || path.join(os.homedir(), "Desktop", `stylist-review-${start}`);
  fs.mkdirSync(out, { recursive: true });
  const rows = [];
  let scratch = ledger;
  const seen = { tee: new Set(), bottoms: new Set(), sneakers: new Set() };
  for (let i = 0; i < REVIEW; i++) {
    const date = addDays(start, i);
    const r = await pickOne(world, "lookbook", date, scratch, { avoidFormulas: rows.filter((x) => x.answer).slice(-3).reverse().map((x) => x.answer.formula) }); // newest first, as recentFormulas
    if (!r.ok) { log(`review ${i + 1}: NO PICK — ${r.reason}`); rows.push({ date, error: r.reason }); continue; }
    scratch = ls.ledgerWith(scratch, ls.ledgerEntry(date, "lookbook", r.option.pieces, { status: "planned", theme: r.answer.theme }));
    const repeats = r.option.pieces.filter((p) => seen[p.slot] && seen[p.slot].has(p.pid));
    if (repeats.length) log(`review ${i + 1}: REPEAT ${repeats.map((p) => `${p.slot} ${p.pid}`).join(", ")} (a relaxed slot)`);
    for (const p of r.option.pieces) if (seen[p.slot]) seen[p.slot].add(p.pid);
    const file = `${String(i + 1).padStart(2, "0")}-${date}.jpg`;
    fs.writeFileSync(path.join(out, file), await collage(r.option, i + 1, 480));
    rows.push({ date, file, answer: r.answer, total: r.option.total, scores: r.json.scores, captionTheme: r.json.caption_theme, attempts: r.attempts,
      pieces: r.option.pieces.map((p) => ({ slot: p.slot, pid: p.pid, brand: p.brand, name: p.name, price: p.price, colour: p.emb && p.emb.colour, photoUrl: p.photoUrl })) });
    fs.writeFileSync(path.join(out, "review.json"), JSON.stringify({ model: MODEL, start, rows, partial: true }, null, 1));
    log(`review ${i + 1}/${REVIEW} ${date}: ${r.answer.theme} R${r.option.total} — ${r.option.pieces.map((p) => `${p.brand} ${p.name}`).join(" | ")}`);
  }
  fs.writeFileSync(path.join(out, "review.json"), JSON.stringify({ model: MODEL, start, rows }, null, 1));
  log(`review written to ${out}`);
}

main().then(() => process.exit(0), (e) => { log(`FAILED: ${e && e.stack || e}`); process.exit(1); });

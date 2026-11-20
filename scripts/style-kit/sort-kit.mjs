#!/usr/bin/env node
// ─── STYLE KIT CLEANUP — keep only the right scenes in a kit (Junid, 20 Nov 2026) ─
// Looks at every reference photo in one kit (default: the Sneaker kit), asks a
// cheap vision model what the MAIN product on display is, and moves each photo
// whose product belongs to another catalogue kit (a bag, a cap, a perfume …)
// into that kit. Sneaker scenes stay. A box or a shopping bag hung ABOVE a shoe
// is part of a sneaker scene and stays.
//
// Each move is ONE multi-path RTDB update (the entry leaves this kit and lands
// in the other in the same write) — the photo file itself is not copied or
// deleted, so the upload spot and every "first 6 sent" badge keep working.
//
//   GOOGLE_APPLICATION_CREDENTIALS=… GEMINI_API_KEY=… node scripts/style-kit/sort-kit.mjs [--kit sneaker] [--apply]
// Dry run by default: prints what it would move.
import { adminRequire } from "../adminRequire.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const KIT = args.includes("--kit") ? args[args.indexOf("--kit") + 1] : "sneaker";
const MODEL = "gemini-3.7-flash";
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("GEMINI_API_KEY is not set"); process.exit(2); }

// What the model may answer, and the kit each answer belongs in. "sneaker" for the Sneaker kit means stay.
const KIT_OF = { sneaker: "sneaker", "soccer-boot": "sneaker", slide: "slides", boot: "boots", bag: "bags", cap: "caps", beanie: "beanies", sunglasses: "sunglasses", perfume: "perfumes", belt: "belts", watch: "watches", jewellery: "jewellery", garment: "clothing", other: null };
const PROMPT = [
  "This is a reference photo from a shop's product studio. What is the MAIN product on display — the item the photo is of?",
  "A retail box, a shoe box or a branded shopping bag shown together with a shoe is packaging, NOT the main product: then the answer is the shoe.",
  "Sneakers, trainers, running shoes and high-tops are \"sneaker\"; football/soccer cleats are \"soccer-boot\"; \"boot\" is only a leather, work, winter or fashion boot.",
  `Answer with JSON only: {"main":"${Object.keys(KIT_OF).join("|")}","why":"<few words>"}`,
].join(" ");

async function classify(url) {
  const img = Buffer.from(await (await fetch(url)).arrayBuffer());
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "image/jpeg", data: img.toString("base64") } }] }],
      generationConfig: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const v = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  return { main: Object.prototype.hasOwnProperty.call(KIT_OF, v.main) ? v.main : "other", why: String(v.why || "") };
}

const admin = adminRequire(import.meta.url)("firebase-admin");
admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const refs = (await db.ref(`aiAssistant/styleKit/${KIT}/refs`).once("value")).val() || {};
const moves = {};
let stay = 0;
for (const [id, r] of Object.entries(refs).sort(([, a], [, b]) => (a.addedAt || 0) - (b.addedAt || 0))) {
  if (!r?.url) continue;
  let c;
  try { c = await classify(r.url); } catch (e) { console.log(`  ${id}: could not check (${e.message}) — left in ${KIT}`); continue; }
  const to = KIT_OF[c.main];
  if (!to || to === KIT) { stay++; console.log(`  ${id}: ${c.main} (${c.why}) — stays`); continue; }
  console.log(`  ${id}: ${c.main} (${c.why}) — ${APPLY ? "moving" : "would move"} to ${to}`);
  moves[`${to}/refs/${id}`] = { ...r, movedFrom: KIT, movedAt: Date.now(), movedBy: "sort-kit.mjs" };
  moves[`${KIT}/refs/${id}`] = null;
}
const n = Object.keys(moves).length / 2;
console.log(`${KIT}: ${stay} stay, ${n} ${APPLY ? "moved" : "to move"}.`);
if (APPLY && n) await db.ref("aiAssistant/styleKit").update(moves);
process.exit(0);

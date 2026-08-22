// ── BRAND SCAN — every pushed field, every product, lexicon-independent ──────
// The compliance chokepoint (src/utils/shopifyTriggers.js) can only refuse what
// it KNOWS. This script exists to find what it does not know: it reads every
// field Marathon Club pushes to Shopify and surfaces proper-noun-looking tokens
// REGARDLESS of whether the lexicon recognises them.
//
//   node scripts/shopify/brand-scan.mjs            live Shopify products
//   node scripts/shopify/brand-scan.mjs --catalog  every /products record too
//   node scripts/shopify/brand-scan.mjs --json out.json
//
// READ-ONLY. Nothing is written to Shopify or RTDB.
//
// WHY IT CANNOT JUST USE THE LEXICON. A keyword list is a closed set; the risk
// is the open one. So the method is inverted: strip everything the catalogue is
// ALLOWED to say — colours, garments, materials, sizes, conditions, numbers —
// and report the residue. A brand that nobody has thought of survives that
// subtraction; a lexicon lookup would not have found it.
//
// FIELDS COVERED — the full pushed surface (compliance.mjs validatePayload):
//   title · handle · vendor · productType · tags · descriptionHtml
//   SEO title (global.title_tag) · SEO description (global.description_tag)
//   media alt text
//   and, for collections: title · handle · descriptionHtml · seo.title/description
import { writeFileSync } from "fs";
import { graphql } from "./client.mjs";
import { triggersInText } from "../../src/utils/shopifyTriggers.js";

const flags = process.argv.slice(2);
const WANT_CATALOG = flags.includes("--catalog");
const jsonIdx = flags.indexOf("--json");
const JSON_OUT = jsonIdx !== -1 ? flags[jsonIdx + 1] : null;

// ── The permitted vocabulary ────────────────────────────────────────────────
// Everything a compliant listing is allowed to be made of. Anything outside
// this, and outside the lexicon, is a candidate. Deliberately generous: a false
// candidate costs a moment's reading, a missed one is the whole problem.
const ALLOWED = new Set(`
a an and the of in with for on at by to from is are
black white grey gray navy blue red green orange yellow pink purple brown beige
cream ivory tan khaki olive maroon burgundy teal turquoise gold silver bronze
charcoal stone sand rust mint lilac lavender coral peach plum wine mustard
multi multicolour multicolor colourway colorway two tone twotone
light dark deep pale bright neon pastel matte gloss metallic
sneaker sneakers shoe shoes trainer trainers boot boots sandal sandals slide
slides slipper slippers cleat cleats runner running walking court low high mid
top tops tee tees tshirt shirt shirts polo polos jersey jerseys hoodie hoodies
sweatshirt sweatshirts sweater jumper cardigan jacket jackets coat coats vest
gilet tracksuit tracksuits set sets pant pants trouser trousers jean jeans
denim short shorts skirt dress cap caps hat hats beanie beanies visor bucket
bag bags backpack rucksack tote crossbody sling duffel holdall pouch wallet
belt belts sock socks glove gloves scarf mask balaclava
perfume fragrance cologne eau parfum toilette edt edp ml oz spray
leather suede canvas mesh nylon knit cotton wool fleece linen satin silk
polyester ripstop corduroy denim velvet rubber
size sizes one onesize free small medium large xl xxl xxxl
club marathon curated sourced clearance factory surplus pre loved preloved each piece limited rarely restocked every item checked hand before listing original packaging isnt always included day exchange anything faulty full detail returns our page com stock accordingly low mid high top low-top mid-top high-top home away third goalkeeper kit national team soccer football raw cargo woven bomber golf sport premium waterproof inch indoor outdoor winter summer motion speed field elite active chunky textured slip all star play over tongue firm ground
mens womens unisex kids junior youth adult boys girls men women
new used preloved vintage retro classic original genuine
excellent very good condition wear visible cosmetic marks priced accordingly
lightweight heavyweight oversized slim regular fit fitted relaxed cropped
zip zipper button buttons pocket pockets hood hooded collar collared sleeve
sleeves sleeveless long shortsleeve longsleeve full half quarter
logo print printed graphic embroidered stripe striped check checked plaid
camo camouflage floral solid plain patterned panel panelled colourblock
colorblock contrast trim piping
lace laces laced slipon strap strapped buckle velcro
sole soles outsole midsole insole cushioned chunky platform flat
box packaging tag tags label labels
end pic pcs pack piece pieces
`.trim().split(/\s+/));

const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
const stripHtml = (s) => norm(s).replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");

/** Tokens that look like a name rather than a description. */
function candidateTokens(text) {
  const words = stripHtml(text)
    .split(/[^A-Za-z0-9'’&+-]+/)
    .map((w) => w.replace(/^[-'’]+|[-'’]+$/g, ""))
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (ALLOWED.has(lower)) continue;
    if (/^\d[\d.\-/]*$/.test(w)) continue;          // pure sizes / codes
    if (lower.length < 3) continue;                  // "xl", "sm", noise
    if (/^[a-z]\d+$/i.test(w)) continue;             // style codes like f4032
    out.push({ word: w, bigram: words[i + 1] ? `${w} ${words[i + 1]}` : null });
  }
  return out;
}

// ── Pull every live product, every pushed field ─────────────────────────────
async function liveProducts() {
  const all = [];
  let after = null;
  for (;;) {
    const d = await graphql(
      `query($a:String){ products(first:100, after:$a, query:"status:active"){
         pageInfo{hasNextPage endCursor}
         nodes{ id title handle vendor productType tags descriptionHtml
           metafields(first:10){ nodes{ namespace key value } }
           media(first:20){ nodes{ alt } } } } }`,
      { a: after }
    );
    all.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return all;
}

async function liveCollections() {
  const d = await graphql(
    `{ collections(first:100){ nodes{ id title handle descriptionHtml seo{title description} } } }`
  );
  return d.collections.nodes;
}

const FIELDS = (p) => {
  const mf = Object.fromEntries((p.metafields?.nodes ?? []).map((m) => [`${m.namespace}.${m.key}`, m.value]));
  const alts = (p.media?.nodes ?? []).map((m) => m.alt).filter(Boolean);
  return [
    ["title", p.title],
    ["handle", p.handle],
    ["vendor", p.vendor],
    ["productType", p.productType],
    ["tags", (p.tags ?? []).join(" ")],
    ["description", p.descriptionHtml],
    ["seo.title", mf["global.title_tag"]],
    ["seo.description", mf["global.description_tag"]],
    ...alts.map((a, i) => [`media.alt[${i}]`, a]),
  ].filter(([, v]) => v);
};

console.log("reading live Shopify …");
const [products, collections] = await Promise.all([liveProducts(), liveCollections()]);
console.log(`  ${products.length} active products · ${collections.length} collections\n`);

// term -> { count, lexiconKnows, sites:[{product, field}] }
const terms = new Map();
const note = (term, product, field) => {
  const key = term.toLowerCase();
  if (!terms.has(key)) {
    terms.set(key, { term, count: 0, lexicon: triggersInText(term).length > 0, sites: [] });
  }
  const t = terms.get(key);
  t.count++;
  if (t.sites.length < 6) t.sites.push({ product, field });
};

for (const p of products) {
  for (const [field, value] of FIELDS(p)) {
    for (const { word, bigram } of candidateTokens(value)) {
      note(word, p.title, field);
      if (bigram) note(bigram, p.title, field);
    }
  }
}
for (const c of collections) {
  for (const [field, value] of [["title", c.title], ["handle", c.handle],
                                ["description", c.descriptionHtml],
                                ["seo.title", c.seo?.title], ["seo.description", c.seo?.description]]) {
    if (!value) continue;
    for (const { word } of candidateTokens(value)) note(word, `[collection] ${c.handle}`, field);
  }
}

const SINGLE = flags.includes("--bigrams") ? () => true : (t) => !t.term.includes(" ");
const unknown = [...terms.values()].filter((t) => !t.lexicon && SINGLE(t)).sort((a, b) => b.count - a.count);
console.log(`${terms.size} distinct candidate terms · ${unknown.length} the lexicon does NOT know\n`);
console.log("═══ TOP UNKNOWN CANDIDATES (frequency, term, example field) ═══\n");
for (const t of unknown.slice(0, Number(process.env.SCAN_TOP || 400))) {
  const s = t.sites[0];
  console.log(String(t.count).padStart(5), t.term.padEnd(34), `${s.field.padEnd(16)} ${s.product.slice(0, 44)}`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    products: products.length, collections: collections.length,
    unknown: unknown.map((t) => ({ term: t.term, count: t.count, sites: t.sites })),
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(0);

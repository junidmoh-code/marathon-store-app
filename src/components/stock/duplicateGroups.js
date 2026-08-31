// ─── DUPLICATE GROUPS — "do not make me guess which copy to keep" ────────────
// (Owner spec 2026-08-31.)
//
// THE COST THIS EXISTS FOR: two records for one shoe. Staff tap whichever they
// see first, find no sizes under it, and the sale is lost at the till while the
// sizes sit under the other copy. Deactivating the WRONG copy makes it worse,
// so the owner will not deactivate at all until the system says which is which.
//
// It already knows. This module answers, from data only:
//
//   WHICH RECORDS ARE THE SAME SHOE — the NAME, and only the name:
//     a. identical normalised name ("Nike airforce black" × 3), or
//     b. identical token SET (word order only), or
//     c. same token COUNT with exactly ONE token differing, that pair within
//        edit distance 2 and sharing a first letter ("Air foce 1" ↔
//        "Air Force 1").
//     All three are scoped to one BRAND bucket. Nothing looser: "Adidas F50
//     Elite Laceless FG Dark Spark Soccer Boots" and "…Celestial Victory…"
//     differ by two tokens and are NOT grouped — that is the point.
//
//   WHY NOT "SHARED STYLE CODE", WHICH THE BRIEF ASKED FOR FIRST. It was built
//   that way, run against live data, and it is WRONG here: a style code in this
//   catalogue is legitimately shared by COLOURWAY SIBLINGS (the owner's own
//   standing rule — one code, several real products, never merge siblings).
//   Live proof, 2026-08-31: code 315122111 is carried by four genuinely
//   different Air Force 1 colourways; 737SMA0015082 by six different Lacoste
//   models; and junk claims like "MADEINITALY" and "123456789" pulled Gucci,
//   Versace and Bottega Veneta into one 13-member "duplicate group". Grouping
//   on codes would have recommended merging real products. Codes are therefore
//   shown as EVIDENCE on every row, and `codesDiffer` warns when a group's
//   members carry different ones — never used to join.
//
//   WHICH COPY TO KEEP — recommendSurvivor() ranks on evidence, in this order:
//     units in stock, locations held, units sold, has a real photo, carries a
//     style code, longer (more complete) name, older record. It returns the
//     one-line reason the card prints. It is a RECOMMENDATION: the screen
//     pre-selects it and lets the owner swap. NOTHING here merges anything.
//
// PURE — no Firebase, no React. Sales come in as a { pid: {units, lastMs} }
// map the caller builds from /insights_log (joined on productId, the durable
// key; see project_insights_past_days_pattern). Stock comes in as the same
// { loc: { pid: { sizeKey: cell } } } shape every other core here takes.

import { isMergedAway } from "../../utils/mergedProducts.js";
import { isDeactivated } from "../../utils/deactivation.js";
import { identityFor } from "../../utils/labelIdentity.js";
import { totalQty } from "./hubCleanupCore.js";

/** Lowercase, punctuation → space, collapsed. The one normalisation. */
export function normaliseName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const tokensOf = (name) => normaliseName(name).split(" ").filter(Boolean);

/** Brand bucket: the record's brand, else its first name token. Never empty. */
export function brandKey(p) {
  const b = String((p && p.brand) || "").trim().toLowerCase();
  if (b) return b;
  return tokensOf(p && p.name)[0] || "";
}

// Bounded Levenshtein: returns a number > max as soon as it can prove it.
// Used only on single tokens, so the O(n·m) grid is tiny.
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Are these two names "very close"? Rules (b) and (c) above; rule (a) is the
 * identical case rule (b) already covers. Exported so the census and the tests
 * pin exactly what the screen groups.
 */
export function namesAreClose(nameA, nameB) {
  const a = tokensOf(nameA);
  const b = tokensOf(nameB);
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return false;
  // Same token SET (word order only) — sort a copy, never the caller's array.
  const sa = [...a].sort();
  const sb = [...b].sort();
  if (sa.every((t, i) => t === sb[i])) return true;
  // Exactly ONE differing position, and that pair is a near-miss of each other.
  let diffs = 0;
  let x = null;
  let y = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    diffs++;
    if (diffs > 1) return false;
    x = a[i];
    y = b[i];
  }
  if (diffs !== 1) return false;
  // A DIGIT IN THE DIFFERING TOKEN IS A MODEL NUMBER, NOT A TYPO. Live proof,
  // 2026-08-31: "Essentials bag brown #9132" vs "#9165", "T-shirt black GLFS
  // T1023" vs "T1012", "G-Star Raw Jean 921#" vs "922#" — six-member "duplicate"
  // groups of six genuinely different items. Same rule keeps Air Max 95 apart
  // from Air Max 97. Letters may be mistyped; the number is the identity.
  if (/\d/.test(x) || /\d/.test(y)) return false;
  if (x[0] !== y[0]) return false;           // a typo rarely eats the first letter
  return editDistance(x, y, 2) <= 2;
}

// ── UNION–FIND ───────────────────────────────────────────────────────────────
function makeUnion() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union, keys: () => [...parent.keys()] };
}

/** Units on hand and the locations holding them, for one product. */
function stockFor(pid, allStock) {
  const byLoc = [];
  let units = 0;
  for (const [loc, prods] of Object.entries(allStock || {})) {
    const cells = prods && prods[pid];
    if (!cells) continue;
    const qty = totalQty(cells);
    const sizes = Object.entries(cells)
      .filter(([k, c]) => k !== "_meta" && c && typeof c === "object" && typeof c.qty === "number" && c.qty !== 0)
      .map(([k, c]) => ({ sizeKey: k, qty: c.qty }))
      .sort((s1, s2) => s2.qty - s1.qty);
    byLoc.push({ loc, qty, sizes });
    units += qty;
  }
  byLoc.sort((a, b) => b.qty - a.qty || a.loc.localeCompare(b.loc));
  return { units, byLoc, locationsHolding: byLoc.filter((l) => l.qty > 0).length };
}

/**
 * The side-by-side facts for one member of a group — everything the card shows.
 * `sales` is { units, lastMs } for this pid (absent = never sold in the window).
 */
export function memberFacts(product, { allStock, identityMap, sales }) {
  const ident = identityFor(product, identityMap);
  const st = stockFor(product.id, allStock);
  return {
    product,
    id: product.id,
    name: product.name || "",
    photoUrl: product.photoUrl || null,
    hasPhoto: !!product.photoUrl,
    codes: ident.codes,
    aliases: ident.aliases,
    registered: ident.codes.length > 0 || ident.aliases.length > 0,
    deactivated: isDeactivated(product),
    units: st.units,
    byLoc: st.byLoc,
    locationsHolding: st.locationsHolding,
    sold: Math.max(0, Number(sales && sales.units) || 0),
    lastSoldMs: (sales && Number(sales.lastMs)) || 0,
  };
}

// The ranking, most significant first. Each entry returns a number; higher
// wins. Written as a list so the reason line and the sort can never disagree.
const RANK = [
  (m) => m.units,
  (m) => m.locationsHolding,
  (m) => m.sold,
  (m) => (m.hasPhoto ? 1 : 0),
  (m) => (m.codes.length ? 1 : 0),
  (m) => m.name.length,
  (m) => -Number(String(m.id).replace(/^p/, "")) || 0,   // older record wins ties
];

/**
 * Rank the members and explain the winner in ONE line.
 * Returns { survivorId, ordered, reason }. Never mutates the input.
 */
export function recommendSurvivor(members) {
  const ordered = [...members].sort((a, b) => {
    for (const score of RANK) {
      const d = score(b) - score(a);
      if (d) return d;
    }
    return 0;
  });
  const win = ordered[0];
  if (!win) return { survivorId: null, ordered, reason: "" };
  const bits = [];
  if (win.units > 0) bits.push(`has ${win.units} unit${win.units === 1 ? "" : "s"} across ${win.locationsHolding} location${win.locationsHolding === 1 ? "" : "s"}`);
  else bits.push("holds no stock either");
  if (win.sold > 0) bits.push(`${win.sold} sold`);
  if (win.codes.length) bits.push(`code ${win.codes[0]}`);
  if (win.hasPhoto) bits.push("real photo");
  const others = ordered.slice(1);
  if (others.length && others.every((o) => o.name.length < win.name.length)) bits.push("fuller name");
  return { survivorId: win.id, ordered, reason: `keeps: ${bits.join(", ")}` };
}

/**
 * THE BUILDER. Groups of 2+ records that look like the same product, worst
 * first (most units at risk of being stranded under the wrong copy, then most
 * members, then most sold).
 *
 * Merged-away records are never included — they are already gone everywhere
 * else (the useProducts chokepoint) and a group of one survivor plus its own
 * merge losers is not a duplicate, it is a completed merge.
 */
export function buildDuplicateGroups({ products = [], allStock = null, identityMap = null, salesByPid = null } = {}) {
  const live = products.filter((p) => p && p.id && p.name && !isMergedAway(p));
  const byId = new Map(live.map((p) => [p.id, p]));
  const u = makeUnion();

  // THE ONE JOIN — a very close name inside the same brand. Blocked on
  // brand|tokenCount|firstLetter so this never becomes an O(n²) sweep.
  // (Style codes deliberately do NOT join — see the header.)
  const blocks = new Map();
  for (const p of live) {
    const t = tokensOf(p.name);
    if (!t.length) continue;
    const key = `${brandKey(p)}|${t.length}|${t[0][0]}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(p);
  }
  for (const bucket of blocks.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (namesAreClose(bucket[i].name, bucket[j].name)) u.union(bucket[i].id, bucket[j].id);
      }
    }
  }

  const clusters = new Map();
  for (const id of u.keys()) {
    if (!byId.has(id)) continue;
    const root = u.find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  }

  const groups = [];
  for (const [root, ids] of clusters) {
    if (ids.length < 2) continue;
    const members = ids.map((id) => memberFacts(byId.get(id), {
      allStock, identityMap, sales: salesByPid && salesByPid[id],
    }));
    const { survivorId, ordered, reason } = recommendSurvivor(members);
    // EVIDENCE, NOT A JOIN. Different style codes inside one name group is the
    // colourway-sibling shape (the owner's standing rule): the card says so and
    // the operator decides. Members carrying NO code at all are not evidence
    // either way, so they never raise the warning on their own.
    const coded = [...new Set(ordered.flatMap((m) => m.codes))];
    groups.push({
      key: root,
      members: ordered,
      survivorId,
      reason,
      codesDiffer: coded.length > 1,
      codes: coded,
      units: ordered.reduce((t, m) => t + Math.max(0, m.units), 0),
      sold: ordered.reduce((t, m) => t + m.sold, 0),
      // A group where BOTH copies hold stock is the one that actually loses
      // sales — the sizes are genuinely split. It sorts first.
      split: ordered.filter((m) => m.units > 0).length >= 2,
    });
  }
  groups.sort((a, b) =>
    (b.split ? 1 : 0) - (a.split ? 1 : 0)
    || b.units - a.units
    || b.members.length - a.members.length
    || b.sold - a.sold
    || String(a.members[0].name).localeCompare(String(b.members[0].name)));
  return groups;
}

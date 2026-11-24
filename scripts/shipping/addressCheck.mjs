// ── THE ADDRESS SAFETY GATE (Junid, 24 Nov 2026, STANDING RULE) ──────────────
// "No Courier Guy booking unless the waybill's suburb, town and postal code match the customer's address. On a
// mismatch, hold and confirm on WhatsApp."
//
// Why: #2316 (Prosperity, Umlazi, KwaZulu-Natal) typed postal code 1475, which is Vosloorus in Gauteng. The locker was
// placed by that postal code and the parcel went to a Vosloorus locker 600 km from her (waybill 4CWBZS, 20 Nov 2026).
//
// checkAddress(address) asks one question, offline and pure: do the postal code, the suburb/town and the province on
// this address describe the SAME place?
//   the postal code   must be a real South African code (the Post Office's list, data/sa-postcodes.tsv);
//   the suburb/town   some suburb or town named on the address (address2, then city, then the street line) must be
//                     one the Post Office files under that code, or a place within NEAR_KM of the code's own map point
//                     (data/sa-postcode-points.tsv, GeoNames). Spelling is normalised (uMlazi = Umlazi, "Umlazi BB" =
//                     Umlazi, "Ext 9" dropped) and the metro / new names are read as the towns they cover (eThekwini =
//                     Durban, Gqeberha = Port Elizabeth, Tshwane = Pretoria, Ekurhuleni = the East Rand towns …);
//   the province      NOT a reason to hold once the suburb/town and code agree (see checkAddress): it is noted only.
// AMBIGUITY IS A MISMATCH: a code the list does not know, or an address naming no place we can find, is held, never
// guessed. A person (or the customer, through the confirm CLI) can confirm one exact address: addressHold.mjs.
//
// checkLockerArea(locker, check) is the door-to-locker half: the chosen locker must be in the customer's AREA (within
// LOCKER_AREA_KM of the suburb/town the address names), not merely near whatever point the postal code gave.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { postalProvinces, provinceName } from "./bookReturn.mjs";
import { tcgZone } from "../../src/shipping/orderShipment.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// A named place this close to the postal code's own point is the same area (Umlazi to Durban's 4001 is 20 km; the
// Post Office files many townships under the nearest big town's codes). The same 30 km a locker may be from the
// customer's street (lockerDelivery.mjs locker.maxKm).
export const NEAR_KM = 30;
// A locker this close to the customer's suburb/town is in their area.
export const LOCKER_AREA_KM = 35;
// A GeoNames point this far from the middle of its code block is a namesake elsewhere, not the code's place.
const BLOCK_KM = 150;
// A town typed this close to the code still lets the street line's own suburb decide (a metro name over a township).
const FAIR_KM = 80;

const str = (v) => String(v ?? "").trim();

/** Lower case, no accents, letters and digits only, single spaces. Pure. */
export function norm(s) {
  return str(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// Words that name no place on their own (a street line is full of them).
const GENERIC = new Set([
  "north", "south", "east", "west", "central", "centre", "center", "park", "street", "st", "road", "rd", "avenue", "ave", "drive", "dr",
  "ext", "extension", "section", "unit", "flat", "complex", "estate", "village", "township", "location", "farm", "the", "main", "new",
  "old", "city", "town", "view", "heights", "gardens", "garden", "hill", "hills", "close", "crescent", "lane", "way", "place", "court",
  "house", "block", "zone", "phase", "ward", "stand", "plot", "erf", "no", "number", "south africa", "africa", "za", "rsa", "university",
  "hospital", "airport", "station", "mall", "prison", "mine", "school", "college", "police", "camp", "depot", "industrial", "industria",
  "business", "office", "post", "box", "po", "private bag", "bag", "street address", "rural", "area", "metro", "municipality",
  "local municipality", "district", "province", "gauteng", "kwazulu natal", "kzn", "western cape", "eastern cape", "northern cape",
  "free state", "limpopo", "mpumalanga", "north west", "northwest", "southafrica", "kwazulunatal", "westerncape", "easterncape", "northerncape", "freestate", "a", "b", "c", "d", "e", "f", "g", "h", "j", "k", "l", "m", "n", "p", "r", "s",
  "t", "u", "v", "w", "x", "y", "z", "and", "of", "at", "in", "on", "near", "next", "to", "opposite", "behind", "corner", "cnr",
]);

// Metro and new names → the Post Office towns they cover (the list still files places under the old town names).
export const ALIASES = {
  ethekwini: ["durban", "pinetown", "umlazi", "chatsworth", "kwamashu", "amanzimtoti", "westville", "phoenix", "verulam", "isipingo", "umhlanga", "inanda", "ntuzuma", "queensburgh", "kloof", "hillcrest", "tongaat"],
  "durban metro": ["durban"],
  gqeberha: ["port elizabeth"], "nelson mandela bay": ["port elizabeth", "uitenhage", "despatch"], kariega: ["uitenhage"], pe: ["port elizabeth"],
  tshwane: ["pretoria", "centurion", "soshanguve", "mabopane", "atteridgeville", "mamelodi", "ga rankuwa"], "city of tshwane": ["pretoria"], pta: ["pretoria"],
  ekurhuleni: ["germiston", "boksburg", "benoni", "kempton park", "alberton", "springs", "brakpan", "edenvale", "nigel", "tembisa", "katlehong", "vosloorus", "thokoza", "daveyton", "tsakane", "kwa thema", "rusloo", "isando"],
  joburg: ["johannesburg"], jozi: ["johannesburg"], jhb: ["johannesburg"], "city of johannesburg": ["johannesburg", "soweto", "randburg", "sandton", "roodepoort"],
  mbombela: ["nelspruit"], emalahleni: ["witbank"], mahikeng: ["mafikeng", "mmabatho"], makhanda: ["grahamstown"], mthatha: ["umtata"],
  komani: ["queenstown"], gcuwa: ["butterworth"], qonce: ["king williams town"], "king williams town": ["king williams town"], mkhondo: ["piet retief", "pietretief"], kugompo: ["east london"], "kugompo city": ["east london"], "dr pixley ka isaka seme": ["volksrust"], msunduzi: ["pietermaritzburg"], pmb: ["pietermaritzburg"], maritzburg: ["pietermaritzburg"],
  "buffalo city": ["east london"], mangaung: ["bloemfontein"], bloem: ["bloemfontein"], emfuleni: ["vereeniging", "vanderbijlpark"],
  kwadukuza: ["stanger"], "city of cape town": ["cape town"], cpt: ["cape town"], polokwane: ["pietersburg"], mokopane: ["potgietersrus"],
  "bela bela": ["warmbaths"], modimolle: ["nylstroom"], musina: ["messina"], lephalale: ["ellisras"], mookgophong: ["naboomspruit"],
};

let INDEX = null;
const tsv = (file) => readFileSync(join(HERE, "data", file), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));

/** A place name → the forms it may be typed in (whole name, without "Ext 9", without a trailing section code). Pure. */
export function nameForms(name) {
  const n = norm(name);
  if (!n) return [];
  const out = new Set([n]);
  let base = n.replace(/\s+(?:ext|extension|uit|x)\s*\d+.*$/, "").replace(/\s+(?:section|unit|zone|phase|block|ward)\s+[a-z0-9]{1,4}$/, "");
  // "umlazi f11", "umlazi bb", "kwamashu k" → the place itself (a trailing code of letters/digits).
  const toks = base.split(" ");
  while (toks.length > 1 && /^(?:[a-z]{0,3}\d+[a-z]?|[a-z]{1,2})$/.test(toks[toks.length - 1])) toks.pop();
  base = toks.join(" ");
  out.add(base);
  // "kwa mashu" ↔ "kwamashu": the joined form too.
  for (const f of [...out]) if (f.includes(" ")) out.add(f.replace(/ /g, ""));
  return [...out].filter((f) => f.length >= 3 && !GENERIC.has(f) && !/^\d+$/.test(f));
}

const addTo = (map, k, v) => { let s = map.get(k); if (!s) map.set(k, (s = new Set())); s.add(v); };

/** The tables, read once. Exposed for tests. */
export function index() {
  if (INDEX) return INDEX;
  const codeNames = new Map(); // code → Set(form)
  const nameCodes = new Map(); // form → Set(code)
  const codeBases = new Map(); // code → Map(display base → count)  (zipSays)
  const codeTowns = new Map(); // code → Set(town)
  const codeRows = new Map(); // code → count of rows
  for (const [place, box, street, town, placeAf, townAf] of tsv("sa-postcodes.tsv")) {
    for (const code of [box, street].filter(Boolean)) {
      codeRows.set(code, (codeRows.get(code) ?? 0) + 1);
      addTo(codeTowns, code, town);
      for (const nm of [place, town, placeAf, townAf]) for (const f of nameForms(nm)) { addTo(codeNames, code, f); addTo(nameCodes, f, code); }
      const b = nameForms(place)[1] ?? nameForms(place)[0];
      if (b) { let m = codeBases.get(code); if (!m) codeBases.set(code, (m = new Map())); m.set(b, (m.get(b) ?? 0) + 1); }
    }
  }
  const codePts = new Map(); // code → [{lat,lng}]
  for (const [code, name, lat, lng] of tsv("sa-postcode-points.tsv")) {
    const p = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    let a = codePts.get(code); if (!a) codePts.set(code, (a = [])); a.push(p);
    for (const f of nameForms(name)) { addTo(codeNames, code, f); addTo(nameCodes, f, code); }
  }
  // Metro / new names: the codes of every town they cover.
  // Only the codes the Post Office files under that TOWN: a suburb elsewhere that shares the name (a "Kloof" or a
  // "Phoenix" in Gauteng) must never make eThekwini match a Gauteng code.
  const townCodes = new Map();
  for (const [code, towns] of codeTowns) for (const t of towns) addTo(townCodes, norm(t), code);
  for (const [alias, towns] of Object.entries(ALIASES)) {
    const codes = towns.flatMap((t) => [...(townCodes.get(norm(t)) ?? [])]);
    // …and only in the metro's own province (the province most of those codes are in): a same-named town in
    // another province (a "Tongaat" filed in Gauteng) is dropped.
    const count = new Map();
    for (const c of codes) for (const z of postalProvinces(c)) count.set(z, (count.get(z) ?? 0) + 1);
    const home = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const c of codes) if (!home || postalProvinces(c).includes(home)) { addTo(nameCodes, norm(alias), c); addTo(nameCodes, norm(alias).replace(/ /g, ""), c); }
  }
  // GeoNames places some points at a namesake elsewhere (4147 Chatsworth and 4309 Phoenix are put in Gauteng, 1861
  // Naledi in Limpopo, one of 9323's in the Northern Cape). Every point a code has is kept (distances use the nearest),
  // except a point more than BLOCK_KM from the middle of its code block (the first two digits: 41xx is Durban).
  const blocks = new Map();
  for (const [code, pts] of codePts) { let a = blocks.get(code.slice(0, 2)); if (!a) blocks.set(code.slice(0, 2), (a = [])); a.push(...pts); }
  const blockMid = new Map([...blocks].map(([b, pts]) => [b, pts.length >= 3 ? medianPoint(pts) : null]));
  const codePoint = new Map(); // code → [{lat,lng}]
  for (const [code, pts] of codePts) {
    const mid = blockMid.get(code.slice(0, 2));
    const kept = pts.filter((q) => !mid || kmBetween(q, mid) <= BLOCK_KM);
    if (kept.length) codePoint.set(code, kept);
  }
  // A code with no (trusted) point: the nearest code number in the same block (codes run along the Post Office's
  // sorting routes), within 10; else the middle of the codes filed under the same town in the same block.
  const own = new Set(codePoint.keys());
  for (const code of codeNames.keys()) {
    if (codePoint.has(code)) continue;
    let best = null;
    for (let d = 1; d <= 10 && !best; d++) for (const c of [String(Number(code) - d).padStart(4, "0"), String(Number(code) + d).padStart(4, "0")]) if (!best && c.slice(0, 2) === code.slice(0, 2) && own.has(c)) best = codePoint.get(c);
    if (best) { codePoint.set(code, best); continue; }
    const near = [];
    for (const t of codeTowns.get(code) ?? []) for (const c of townCodes.get(norm(t)) ?? []) if (c !== code && c.slice(0, 2) === code.slice(0, 2) && own.has(c)) near.push(...codePoint.get(c));
    if (near.length) codePoint.set(code, [medianPoint(near)]);
  }
  INDEX = { codeNames, nameCodes, codeBases, codeTowns, codePoint };
  return INDEX;
}

const mean = (pts) => ({ lat: pts.reduce((t, p) => t + p.lat, 0) / pts.length, lng: pts.reduce((t, p) => t + p.lng, 0) / pts.length });
const medianPoint = (pts) => {
  const lat = [...pts].map((p) => p.lat).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
  const lng = [...pts].map((p) => p.lng).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
  return pts.reduce((best, p) => (!best || kmBetween(p, { lat, lng }) < kmBetween(best, { lat, lng }) ? p : best), null);
};

/** Great-circle km. Pure. */
export function kmBetween(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** "1475" / "475" / " 4031 " → "1475" | "0475" | "4031"; anything else → "". Pure. */
export function postalCode(v) {
  const s = str(v).replace(/\s+/g, "");
  return /^\d{3,4}$/.test(s) ? s.padStart(4, "0") : "";
}

/** The parts of an address, from the Shopify shape (address1/address2/city/province/zip) or Courier Guy's. Pure. */
export function addressParts(a = {}) {
  const tcgStreet = str(a.street_address);
  return {
    street: str(a.address1 ?? a.street ?? a.line1) || tcgStreet.split(",")[0] || "",
    suburb: str(a.address2 ?? a.suburb ?? a.local_area ?? a.localArea),
    city: str(a.city ?? a.town),
    zone: tcgZone(str(a.zone ?? a.province_code ?? a.province ?? a.provinceCode ?? a.state)),
    code: str(a.code ?? a.zip ?? a.postal_code ?? a.postalCode ?? a.postcode),
  };
}

/** Every known place named in a piece of text → [{ form, raw }] (longest first). Pure apart from the tables. */
export function placesIn(text) {
  const { nameCodes } = index();
  const toks = norm(text).split(" ").filter(Boolean);
  const out = [];
  const seen = new Set();
  for (let n = Math.min(5, toks.length); n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const gram = toks.slice(i, i + n);
      for (const f of [gram.join(" "), n > 1 ? gram.join("") : null].filter(Boolean)) {
        if (seen.has(f) || GENERIC.has(f) || f.length < 3 || /^\d+$/.test(f) || !nameCodes.has(f)) continue;
        // A single word that is only part of a longer place already found ("park" of "zwide park") adds nothing.
        if (out.some((o) => o.form.split(" ").length > 1 && o.form.includes(f))) continue;
        seen.add(f);
        out.push({ form: f, raw: gram.join(" ") });
      }
    }
  }
  return out;
}

const title = (s) => str(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** What the postal code itself says, for people: "1475 (Vosloorus, Gauteng)". Pure apart from the tables. */
export function codeSays(code) {
  const { codeBases, codeTowns } = index();
  const bases = [...(codeBases.get(code) ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const place = bases[0]?.[0] ?? norm([...(codeTowns.get(code) ?? [])][0] ?? "");
  const provs = postalProvinces(code).map(provinceName);
  return { code, place: title(place), province: provs.length === 1 ? provs[0] : provs.join(" or "), text: `${code} (${[title(place), provs.length === 1 ? provs[0] : null].filter(Boolean).join(", ")})` };
}

/** The codes the Post Office files a place under, most used first (a hint for the person confirming). Pure. */
export function codesOf(form, limit = 3) {
  const { nameCodes, codeNames } = index();
  return [...(nameCodes.get(form) ?? [])].sort((a, b) => (codeNames.get(b)?.size ?? 0) - (codeNames.get(a)?.size ?? 0)).slice(0, limit);
}

/**
 * Do the postal code, suburb/town and province of this address agree? Pure (the tables are read once).
 * → { ok: true, how: "listed" | "near", code, areaPoint, matched }
 *   | { ok: false, kind: "bad_code" | "unknown_code" | "mismatch" | "unmatched" | "province", why, code, zipSays, addressSays }
 */
export function checkAddress(address) {
  const { codeNames, codePoint, nameCodes } = index();
  const p = addressParts(address);
  const code = postalCode(p.code);
  const typedArea = [p.suburb, p.city].filter(Boolean).join(", ") || p.street;
  const typedProv = provinceName(p.zone) || str(p.zone);
  const addressSaysOf = (raw) => [title(raw || typedArea), typedProv].filter(Boolean).join(", ");
  if (!code) return { ok: false, kind: "bad_code", code: str(p.code), why: `the postal code "${str(p.code)}" is not a South African postal code`, zipSays: null, addressSays: addressSaysOf("") };
  if (!codeNames.has(code)) return { ok: false, kind: "unknown_code", code, why: `postal code ${code} is not in the Post Office's list`, zipSays: { code, text: code }, addressSays: addressSaysOf("") };
  const zipSays = codeSays(code);
  const Z = codePoint.get(code) ?? [];
  const own = codeNames.get(code);
  const judge = (m) => {
    const codes = nameCodes.get(m.form) ?? new Set();
    if (codes.has(code)) return { ...m, how: "listed", km: 0 };
    let best = null;
    for (const z of Z) for (const c of codes) for (const q of codePoint.get(c) ?? []) { const d = kmBetween(z, q); if (!best || d < best.km) best = { km: d, point: q }; }
    return { ...m, how: best && best.km <= NEAR_KM ? "near" : "far", km: best ? Math.round(best.km) : null, point: best?.point ?? null };
  };
  const subJ = placesIn(p.suburb).map(judge);
  const cityJ = placesIn(p.city).map(judge);
  const areaJ = [...subJ, ...cityJ];
  const streetJ = placesIn(p.street).map(judge);
  // A misspelt name of one of the code's OWN places ("Pietemarizrburg" for Pietermaritzburg 3201, "Randjiesfontein"
  // for Randjesfontein 1682) agrees with the code: only ever matched against that code's places, never used to say
  // the address is somewhere else.
  const typoIn = (t) => typoOf(t, own).map((form) => ({ form, raw: form, how: "listed", km: 0 }));
  const subT = typoIn(p.suburb), cityT = typoIn(p.city);
  const good = [...areaJ.filter((m) => m.how !== "far"), ...subT, ...cityT];
  // THE TOWN must be in the same area whenever it names a known place (architect review, #985): a listed suburb never
  // outvotes a far town ("Newlands, Johannesburg, 7700" or "Umlazi, Johannesburg, 1475" hold). A town within FAIR_KM is
  // the metro-level name over a township and still counts. The suburb line is NOT held to this: it carries complex,
  // building and street names ("Palm Manor", "Athlone Street", "SAPS Denver building"), which tripled false holds on
  // the last 600 orders when it was.
  const fieldOk = (js, ts) => !js.length || ts.length > 0 || js.some((m) => m.how !== "far" || (m.km != null && m.km <= FAIR_KM));
  const fieldsAgree = fieldOk(cityJ, cityT);
  // The suburb/town fields decide; the street line only when they name no known place at all, or when it names a
  // place the code itself files and the town typed is a big name nearby ("848 Khozi Street Naledi Ext 2, Johannesburg,
  // 1861"): never when the town typed is far (#2316's Umlazi is 487 km from 1475).
  const nearish = areaJ.every((m) => m.km != null && m.km <= FAIR_KM);
  const agree = !fieldsAgree ? [] : good.length ? good : !areaJ.length ? streetJ.filter((m) => m.how !== "far") : nearish ? streetJ.filter((m) => m.how === "listed") : [];
  if (agree.length) {
    // THE PROVINCE is not a reason to hold once the suburb/town and the postal code agree: customers pick the wrong
    // one in Shopify's list all the time (#2330 Rooiberg 0500 "Gauteng", #2338 Botshabelo 9781 "Western Cape", #2340
    // Parys 9585 "Gauteng"; 23 of the last 400 orders), Courier Guy routes by the code and suburb, and the only
    // offline province source is the coarse code-range table, which is itself wrong for Vryburg, Taung, Nebo,
    // Burgersfort … It is noted on the result, never decided by.
    const provs = postalProvinces(code);
    const provinceNote = p.zone && provs.length && !provs.includes(p.zone) ? `typed ${typedProv}; postal code ${code} reads as ${provs.map(provinceName).join(" or ")}` : null;
    const pts = [...Z, ...agree.map((m) => m.point)].filter(Boolean);
    return { ok: true, how: agree.some((m) => m.how === "listed") ? "listed" : "near", code, zipSays, matched: [...new Set(agree.map((m) => m.form))], areaPoints: pts, ...(provinceNote ? { provinceNote } : {}) };
  }
  if (areaJ.length) {
    const far = areaJ.filter((m) => m.how === "far").sort((a, b) => (b.km ?? 1e9) - (a.km ?? 1e9))[0] ?? areaJ[0];
    const hint = codesOf(far.form);
    return {
      ok: false, kind: "mismatch", code, zipSays, addressSays: addressSaysOf(far.raw), addressPlace: title(far.raw), addressCodes: hint, km: far.km,
      why: `the address says ${title(far.raw)} but postal code ${zipSays.text} is ${far.km != null ? `${far.km} km away` : "somewhere else"}${hint.length ? ` (${title(far.raw)} is ${hint.join("/")})` : ""}`,
    };
  }
  return { ok: false, kind: "unmatched", code, zipSays, addressSays: addressSaysOf(""), why: `no suburb or town on the address (${typedArea || "none"}) matches postal code ${zipSays.text}` };
}

/** Levenshtein distance, stopping early past `max`. Pure. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The code's own place names a typed field misspells (one slip in 6+ letters, two in 9+). Pure. */
export function typoOf(text, own) {
  const toks = norm(text).split(" ").filter(Boolean);
  const out = [];
  for (let n = 1; n <= Math.min(3, toks.length); n++) {
    for (let i = 0; i + n <= toks.length; i++) {
      const g = toks.slice(i, i + n).join(" ");
      if (g.length < 6 || GENERIC.has(g)) continue;
      for (const f of own ?? []) {
        if (f.length < 6 || Math.abs(f.length - g.length) > 2) continue;
        const allow = Math.min(g.length, f.length) >= 9 ? 2 : 1;
        if (f[0] === g[0] && editDistance(g, f, allow) <= allow) out.push(f);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Is the chosen locker in the customer's area (within LOCKER_AREA_KM of the suburb/town the address names, or the
 * postal code's own point)? Only asked of an address checkAddress passed. Pure.
 * → { ok: true, km } | { ok: false, why, km }
 */
export function checkLockerArea(locker, check, { maxKm = LOCKER_AREA_KM } = {}) {
  const { codePoint, codeNames } = index();
  const pts = (check?.areaPoints ?? []).filter(Boolean);
  const name = str(locker?.name) || str(locker?.id) || "the locker";
  const lockerCode = postalCode(locker?.tcgAddress?.code);
  const pointOf = Number.isFinite(Number(locker?.lat)) && Number.isFinite(Number(locker?.lng)) ? { lat: Number(locker.lat), lng: Number(locker.lng) } : null;
  // The locker's own postal code is the customer's: in their area.
  if (lockerCode && lockerCode === check?.code) return { ok: true, km: 0, by: "code" };
  // Chosen by distance from the customer's OWN point (Shopify's validated point or their street on the map, not a
  // postal-code or town guess like #2316's): that distance is the customer's, and it is within the limit.
  if (["shopify", "street"].includes(str(locker?.placedBy)) && Number.isFinite(Number(locker?.km)) && Number(locker.km) <= maxKm) return { ok: true, km: Math.round(Number(locker.km)), by: "placed" };
  // Names are only trusted for a locker with NO map point (an older record): a "Rosebank" locker in Cape Town is not
  // a Johannesburg Rosebank customer's area (architect review, #985). With a point, the distance decides.
  if (!pointOf && lockerCode && (check?.matched ?? []).some((f) => codeNames.get(lockerCode)?.has(f))) return { ok: true, km: 0, by: "code" };
  // The locker's own suburb/town (Courier Guy's record of it) is one the address names, or one the code files.
  const { nameCodes } = index();
  // (An older locker record has only its one-line address: "Ext.9 Ext.9, Sam Sekoati Avenue, Vosloorus".)
  const lockerText = [locker?.tcgAddress?.local_area, locker?.tcgAddress?.city].map(str).filter(Boolean).join(", ");
  const lockerPlaces = placesIn(lockerText || str(locker?.address).split(",").slice(-2).join(","));
  if (!pointOf && lockerPlaces.some((m) => (check?.matched ?? []).includes(m.form) || nameCodes.get(m.form)?.has(check?.code))) return { ok: true, km: 0, by: "name" };
  const at = [
    pointOf,
    ...(lockerCode ? codePoint.get(lockerCode) ?? [] : []),
    // Neither a point nor a code: the places its address names (every place of that name: the nearest is used).
    ...(!pointOf && !lockerCode ? lockerPlaces.flatMap((m) => [...(nameCodes.get(m.form) ?? [])].flatMap((c) => codePoint.get(c) ?? [])) : []),
  ].filter(Boolean);
  if (!at.length || !pts.length) return { ok: false, km: null, why: `${name} could not be placed against the customer's area (no map point), so it cannot be shown to be near them` };
  const km = Math.round(Math.min(...at.flatMap((a) => pts.map((q) => kmBetween(a, q)))));
  if (km <= maxKm) return { ok: true, km, by: "distance" };
  return { ok: false, km, why: `${name} is ${km} km from the customer's area (${(check.matched ?? []).map(title).join(", ") || check.code})` };
}

/** A fingerprint of the address as typed: a confirmation holds only for this exact address. Pure. */
export function addressFingerprint(address) {
  const p = addressParts(address);
  return [p.street, p.suburb, p.city, p.zone, postalCode(p.code) || p.code].map(norm).join("|");
}

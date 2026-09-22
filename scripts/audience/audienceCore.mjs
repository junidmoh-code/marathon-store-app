// ─── MERGING THREE CUSTOMER BOOKS INTO ONE AUDIENCE ─────────────────────────
//
// PURE. No files, no RTDB, no network — so the merge rules can be tested
// against fabricated people instead of real ones, and nobody has to run this
// over live customer data to know what it does.
//
// ── THE THREE SOURCES, AND WHAT THEY ACTUALLY CONTAIN ────────────────────────
// Profiled 2026-08-27, because the plan assumed things that are not true:
//
//   shopify   proven online buyers, real email addresses. THE BEST RECORDS —
//             and currently unreadable: the app has neither read_orders nor
//             read_customers. Nothing here is guessed in their absence; the
//             source simply contributes zero rows until the scope exists.
//   pos       8,093 records. phone 100%, name 99.9%, orderCount/lastOrderAt
//             96.5% — and ZERO emails. The recency data is the valuable part.
//   oldpos    2,469 rows across three Lightspeed exports. mobile 98.9%,
//             first_name 99.8%, last_name 24.9%, email 2.6%, and city, gender
//             and date_of_birth are entirely EMPTY columns. Phone-only people.
//
// So the audience is overwhelmingly phone-matched. That is the single biggest
// determinant of the match rate and it is a property of the data, not of this
// code — which is why estimateMatchRate below keys on which fields a row
// actually has rather than quoting a number from a blog.
//
// ── IDENTITY: PHONE FIRST, THEN EMAIL ───────────────────────────────────────
// The same person appears in more than one book. Email would be the better
// key and is present on 2.6% of one source and 0% of another, so phone is the
// only key that can actually join these three. Normalised to +27 E.164 through
// functions/lib/sa-phone.cjs — the SAME rule that decides whether a WhatsApp
// message may be sent, because a number too broken to message is too broken
// to upload.
//
// A row whose phone will not normalise is NOT dropped: if it has an email it
// still joins on that. It is dropped only when it has no usable key at all.

// Meta's documented Custom Audience columns. Anything not on this list is not
// a match key and does not belong in the upload.
export const META_COLUMNS = ["email", "phone", "fn", "ln", "ct", "st", "zip", "country"];

/** "Junid Mohammed" → { fn: "junid", ln: "mohammed" }. */
export function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: "", ln: "" };
  if (parts.length === 1) return { fn: parts[0].toLowerCase(), ln: "" };
  return { fn: parts[0].toLowerCase(), ln: parts.slice(1).join(" ").toLowerCase() };
}

/**
 * Meta hashes these itself, but it normalises FIRST and documents how: lower
 * case, trimmed, no punctuation in names. Doing it here means what we upload
 * is what they hash, rather than relying on their cleaner to guess.
 */
export function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : "";
}
export function normName(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-zÀ-ɏ' -]/g, "").trim();
}

/**
 * A timestamp, from whatever the source stored.
 *
 * /customers keeps lastOrderAt as an ISO STRING ("2026-06-05T12:48:48.421Z");
 * Shopify's createdAt is ISO too; anything epoch-shaped arrives as a number.
 * The first version of this coerced with Number(), which turns an ISO string
 * into NaN, then into null — and every single customer was filed as "undated"
 * and dropped out of the recency segments. The build looked like it worked:
 * 9,611 people, one bucket, no error anywhere.
 */
export function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== "" && !/[-:TZ]/.test(String(v))) return n;
  const p = Date.parse(String(v));
  return Number.isFinite(p) ? p : null;
}

/**
 * One person, from one source. `phone` must already be E.164 or empty —
 * normalisation is the caller's job because it needs the shared rule.
 */
export function makeRow({ source, phone = "", email = "", fn = "", ln = "", ct = "", st = "", country = "ZA", orderCount = 0, lastOrderAt = null, firstOrderAt = null }) {
  return {
    source, phone,
    email: normEmail(email),
    fn: normName(fn), ln: normName(ln),
    ct: normName(ct), st: normName(st),
    country: String(country || "").trim().toUpperCase() || "ZA",
    orderCount: Number(orderCount) || 0,
    lastOrderAt: toMs(lastOrderAt),
    firstOrderAt: toMs(firstOrderAt),
  };
}

/** Does this row carry anything Meta can match on at all? */
export function hasKey(r) { return Boolean(r.phone || r.email); }

/**
 * Merge across sources.
 *
 * Joined on phone, then on email for rows with no usable phone. The merged
 * record keeps the UNION of every field — that is the whole point of merging:
 * the old POS knows a first name, the POS knows the order history, Shopify
 * knows the email, and a person who appears in all three uploads with all of
 * them. More keys is a better match, and Meta scores on the best key that hits.
 *
 * Field-level preference is by SOURCE RANK, not by arrival order: shopify data
 * is a customer typing their own details into a checkout, pos is a cashier
 * typing at a till, oldpos is the same from a system nobody has maintained
 * since 2019. Arrival order would make the answer depend on which file was
 * read first, which is exactly the kind of thing that changes silently.
 */
export const SOURCE_RANK = { shopify: 3, pos: 2, oldpos: 1 };

export function mergeRows(rows) {
  const byPhone = new Map(), byEmail = new Map(), out = [];
  const attach = (existing, r) => {
    existing.sources.add(r.source);
    for (const f of ["phone", "email", "fn", "ln", "ct", "st"]) {
      const incoming = r[f];
      if (!incoming) continue;
      // Fill a gap always; overwrite only from a better source.
      if (!existing[f] || SOURCE_RANK[r.source] > SOURCE_RANK[existing._for[f]]) {
        existing[f] = incoming;
        existing._for[f] = r.source;
      }
    }
    existing.orderCount += r.orderCount;
    if (r.lastOrderAt && (!existing.lastOrderAt || r.lastOrderAt > existing.lastOrderAt)) existing.lastOrderAt = r.lastOrderAt;
    if (r.firstOrderAt && (!existing.firstOrderAt || r.firstOrderAt < existing.firstOrderAt)) existing.firstOrderAt = r.firstOrderAt;
    if (r.country && r.country !== "ZA") existing.country = r.country;
  };

  for (const r of rows) {
    if (!hasKey(r)) continue;
    const hit = (r.phone && byPhone.get(r.phone)) || (r.email && byEmail.get(r.email)) || null;
    if (hit) { attach(hit, r); }
    else {
      const rec = { ...r, sources: new Set([r.source]), _for: Object.fromEntries(["phone","email","fn","ln","ct","st"].map((f) => [f, r.source])) };
      out.push(rec);
    }
    // Index AFTER merging, so a row that arrives with a phone and an email
    // links the two identities for everything that follows it.
    const rec = hit || out[out.length - 1];
    if (rec.phone) byPhone.set(rec.phone, rec);
    if (rec.email) byEmail.set(rec.email, rec);
  }
  return out.map((r) => { const { _for, sources, ...rest } = r; return { ...rest, sources: [...sources].sort() }; });
}

// ── SEGMENTS ────────────────────────────────────────────────────────────────
// "A 2025 online buyer is a much better pattern than a 2019 walk-in" — owner,
// 2026-08-27. A Lookalike is only as good as the seed, so the seed must be one
// coherent group rather than everyone who ever gave a phone number.
export const RECENT_MONTHS = 18;

export function segmentOf(r, nowMs) {
  const online = r.sources.includes("shopify");
  const cutoff = nowMs - RECENT_MONTHS * 30.44 * 86400000;
  const recent = Boolean(r.lastOrderAt && r.lastOrderAt >= cutoff);
  if (online) return recent ? "online-recent" : "online-old";
  // A record with no order history at all is not "old" — it is UNDATED, and
  // calling it old would quietly bury anyone the POS never stamped.
  if (!r.lastOrderAt) return "instore-undated";
  return recent ? "instore-recent" : "instore-old";
}

/**
 * The expected match rate, from the keys the rows ACTUALLY carry.
 *
 * Deliberately a RANGE and deliberately conservative. Meta publishes no
 * guarantee and the real number depends on how many of these people use
 * Facebook under these details. What is defensible is the shape: an email
 * match beats a phone match, a phone with a name beats a bare phone, and a
 * South African mobile in E.164 is a good key because it is how people
 * register. Anything quoted more precisely than this would be invented.
 */
export function estimateMatchRate(rows) {
  const withEmail = rows.filter((r) => r.email).length;
  const phoneOnly = rows.filter((r) => r.phone && !r.email).length;
  const withName = rows.filter((r) => r.phone && (r.fn || r.ln)).length;
  const lo = Math.round(withEmail * 0.55 + phoneOnly * 0.35);
  const hi = Math.round(withEmail * 0.80 + phoneOnly * 0.60);
  return {
    rows: rows.length, withEmail, phoneOnly, withName,
    lo, hi,
    loPct: rows.length ? +(lo / rows.length * 100).toFixed(1) : 0,
    hiPct: rows.length ? +(hi / rows.length * 100).toFixed(1) : 0,
  };
}

/** Meta-ready CSV. Only match keys — no segment column, no internal ids. */
export function toCsv(rows) {
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [META_COLUMNS.join(","), ...rows.map((r) => META_COLUMNS.map((c) => esc(r[c] ?? "")).join(","))].join("\n") + "\n";
}

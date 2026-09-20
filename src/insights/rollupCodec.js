// ─── THE DAY ROLLUP CODEC — THE BROWSER HALF ────────────────────────────────
//
// A byte-identical twin of the shared block in
// functions/insightsRollup/rollupCodec.cjs. The writer is a Cloud Function
// (CommonJS) and the reader is this bundle (ESM); one file cannot be both
// without a build step, and a build step is more machinery than a hundred
// lines of pure functions is worth.
//
// rollupCodecTwin.test.js fails if the two blocks differ by one character, so
// "keep them in sync" is not a thing anybody has to remember. Edit either one,
// run the test, copy across.
//
// Nothing outside the markers is shared: the module syntax below is this
// file's own.

/* ─── SHARED:BEGIN ─────────────────────────────────────────────────────────
   Everything between these markers is duplicated verbatim in
   src/insights/rollupCodec.js. Edit one, run the twin test, copy across. */

// Bump when the row layout changes. A reader that meets a shape it does not
// know must fall back to the log rather than guess: an older reader silently
// mapping a new column onto an old field would put one product's numbers under
// another product's name, which looks like data rather than like a bug.
const ROLLUP_SHAPE = 1;

// The row layout. Index into a dictionary, or a literal where a dictionary
// would cost more than it saves. -1 means "the field was absent", which is NOT
// the same as the empty string: `size: undefined` and `size: ""` classify
// differently in inferProductType.
const COL = {
  ACTION: 0,        // index into dict.a
  TS: 1,            // ms offset from the day's epoch anchor
  NAME: 2,          // index into dict.p (productName)
  PID: 3,           // index into dict.i (productId)
  SIZE: 4,          // index into dict.s
  TYPE: 5,          // index into dict.t (productType)
  CAT: 6,           // index into dict.c (productCategory)
  ORDER: 7,         // index into dict.o (orderNumber — a STRING in the log)
  HUB: 8,           // index into dict.h (placedAtHub)
  SHOP: 9,          // index into dict.d (destShop)
  QTY: 10,          // literal integer, -1 when absent
  CNAME: 11,        // index into dict.n (customerName)
  CPHONE: 12,       // index into dict.f (customerPhone)
  REFILLED: 13,     // index into dict.r (displayRefilledBy)
};
const COL_COUNT = 14;

// dictionary key -> the event field it encodes. The order here IS the
// serialisation order of the dictionaries; adding one means a new ROLLUP_SHAPE.
const DICTS = [
  ["a", "action"],
  ["p", "productName"],
  ["i", "productId"],
  ["s", "size"],
  ["t", "productType"],
  ["c", "productCategory"],
  ["o", "orderNumber"],
  ["h", "placedAtHub"],
  ["d", "destShop"],
  ["n", "customerName"],
  ["f", "customerPhone"],
  ["r", "displayRefilledBy"],
];

const COL_OF_DICT = {
  a: COL.ACTION, p: COL.NAME, i: COL.PID, s: COL.SIZE, t: COL.TYPE,
  c: COL.CAT, o: COL.ORDER, h: COL.HUB, d: COL.SHOP, n: COL.CNAME,
  f: COL.CPHONE, r: COL.REFILLED,
};

/** The fields a row carries. Everything else in an event — autoRefill, source,
 *  saleId, the duplicate-audit fields — is dropped, because no screen served
 *  from this node reads it. Adding a reader means adding the column here and
 *  bumping ROLLUP_SHAPE; it does NOT mean reading around the rollup. */
const KEPT_FIELDS = [
  "action", "timestamp", "productName", "productId", "size", "productType",
  "productCategory", "orderNumber", "placedAtHub", "destShop", "qty",
  "customerName", "customerPhone", "displayRefilledBy",
];

/**
 * Compact one SA day's events.
 *
 * @param {Array<object>} events the day's raw log rows, in the order they
 *        should be expanded back into (the writer passes them in KEY order,
 *        which is arrival order — `groupCount`'s tie-break depends on it).
 * @param {{date: string, anchorMs: number, cursorEnd?: string}} meta
 */
function compactDay(events, meta) {
  const dicts = {};
  const index = {};
  for (const [k] of DICTS) { dicts[k] = []; index[k] = new Map(); }

  // Interning returns -1 for absent (null/undefined) so the expander can put
  // the field back as absent rather than as "".
  const intern = (k, value) => {
    if (value === null || value === undefined) return -1;
    const s = String(value);
    const seen = index[k].get(s);
    if (seen !== undefined) return seen;
    const at = dicts[k].length;
    dicts[k].push(s);
    index[k].set(s, at);
    return at;
  };

  const anchorMs = Number(meta.anchorMs) || 0;
  const rows = [];
  // Timestamps that are absent, unparseable, or outside the day are kept
  // VERBATIM in `odd` rather than as an offset: the offset encoding is only
  // lossless for a real instant near the anchor, and a screen filters on the
  // timestamp string, not on a number.
  const odd = {};

  events.forEach((e, i) => {
    if (!e) return;
    const row = new Array(COL_COUNT).fill(-1);
    for (const [k, field] of DICTS) row[COL_OF_DICT[k]] = intern(k, e[field]);
    row[COL.QTY] = typeof e.qty === "number" && Number.isFinite(e.qty) ? e.qty : -1;

    const ts = e.timestamp;
    const ms = typeof ts === "string" ? Date.parse(ts) : NaN;
    // Round-trip check: only an ISO string that reproduces itself from its own
    // epoch value may be stored as an offset. "2026-09-18T10:00:00+02:00" and
    // "2026-09-18T08:00:00.000Z" are the same instant and different strings,
    // and a screen comparing `e.timestamp >= filterStart` compares STRINGS.
    if (Number.isFinite(ms) && new Date(ms).toISOString() === ts) {
      row[COL.TS] = ms - anchorMs;
    } else {
      row[COL.TS] = 0;
      odd[String(rows.length)] = ts === undefined ? null : ts;
    }
    rows.push(row);
    void i;
  });

  return {
    v: ROLLUP_SHAPE,
    date: meta.date,
    anchorMs,
    cursorEnd: meta.cursorEnd || null,
    n: rows.length,
    byStore: countByStore(events),
    dict: dicts,
    odd,
    rows,
  };
}

/**
 * The exact inverse. Returns plain event objects carrying only KEPT_FIELDS,
 * with absent fields absent — ready for the production selectors.
 */
function expandDay(node) {
  if (!node || node.v !== ROLLUP_SHAPE) return null;
  // ── AN EMPTY DAY IS A DAY, NOT A BROKEN NODE ────────────────────────────
  // RTDB cannot store an empty array or an empty object: writing one removes
  // the key, and it reads back as absent. A day on which the shop logged
  // nothing therefore comes back with no `rows` and no `dict` at all — and
  // treating that as corruption meant every window containing it did a
  // needless live read and warned about a node that was perfectly correct.
  // Found by scripts/verify-insights-rollup.mjs on 2026-06-30, which is
  // genuinely empty. (The same trap as reference-rtdb-cannot-store-empty-arrays.)
  //
  // The check that this is an empty day and not a mangled one is `n`: the
  // writer always stamps it, and a node claiming rows while carrying none is
  // still refused.
  if (node.rows === undefined || node.rows === null) {
    return (Number(node.n) || 0) === 0 ? [] : null;
  }
  if (!Array.isArray(node.rows)) return null;
  const dicts = node.dict || {};
  const anchorMs = Number(node.anchorMs) || 0;
  const odd = node.odd || {};
  const out = [];

  for (let i = 0; i < node.rows.length; i++) {
    const row = node.rows[i];
    if (!row) continue;
    const e = {};
    for (const [k, field] of DICTS) {
      const at = row[COL_OF_DICT[k]];
      if (at !== undefined && at !== null && at >= 0) {
        const table = dicts[k];
        // A dictionary index with no entry behind it is corruption, not an
        // absent field. Refusing the whole day is right: half a day of events
        // renders as a quiet day, which is the failure mode this codec exists
        // to avoid.
        if (!table || table[at] === undefined) return null;
        e[field] = table[at];
      }
    }
    const q = row[COL.QTY];
    if (typeof q === "number" && q >= 0) e.qty = q;

    const key = String(i);
    if (Object.prototype.hasOwnProperty.call(odd, key)) {
      const raw = odd[key];
      if (raw !== null) e.timestamp = raw;
    } else {
      e.timestamp = new Date(anchorMs + (Number(row[COL.TS]) || 0)).toISOString();
    }
    out.push(e);
  }
  return out;
}

// ─── THE STORE BUCKETS ──────────────────────────────────────────────────────
//
// The Insights sidebar shows "N events in view", and it is NOT the window's
// count — it is every event this store has ever logged, sliced by the store
// filter. A reader that fetched only the days in the window could not produce
// it, so the day node carries the three counts and the reader adds up the days
// without downloading them.
//
// The predicates are `matchesStore` from App.jsx, transcribed. They partition:
// every event falls in exactly one of the three, so "all" is their sum and the
// reader never has to re-derive it.
function storeBucketOf(e) {
  if (!e) return null;
  if (e.destShop === "marathon-pine" || e.placedAtHub === "hub3") return "pine";
  if (e.destShop === "trophy") return "trophy";
  if (e.destShop === "marathon-pe" || (e.destShop == null && e.placedAtHub !== "hub3")) return "pe";
  // A destShop nobody listed. It belongs to no filter — which is exactly what
  // the screen does with it today — but it is still IN the "all" total, so it
  // is counted separately rather than dropped or folded into a store.
  return "other";
}

function countByStore(events) {
  const out = { pe: 0, trophy: 0, pine: 0, other: 0 };
  for (const e of events || []) {
    const b = storeBucketOf(e);
    if (b) out[b] += 1;
  }
  return out;
}

/** The event, reduced to what a rollup row can carry — what equivalence is
 *  measured against. An absent field stays absent. */
function keptFieldsOf(event) {
  const out = {};
  if (!event) return out;
  for (const f of KEPT_FIELDS) {
    if (event[f] !== undefined && event[f] !== null) out[f] = event[f];
  }
  // orderNumber and the rest are strings in the log but nothing guarantees it;
  // the codec stringifies, so the comparison must too.
  for (const f of KEPT_FIELDS) {
    if (f !== "qty" && out[f] !== undefined) out[f] = String(out[f]);
  }
  if (typeof event.qty === "number" && Number.isFinite(event.qty)) out.qty = event.qty;
  else delete out.qty;
  return out;
}

/* ─── SHARED:END ────────────────────────────────────────────────────────── */

export {
  ROLLUP_SHAPE, COL, COL_COUNT, DICTS, KEPT_FIELDS,
  compactDay, expandDay, keptFieldsOf, storeBucketOf, countByStore,
};

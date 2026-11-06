// ── THE COURIER RECONCILIATION LOOP (Junid, 6 Nov 2026) ─────────────────────
// After delivery, what Courier Guy actually charged for each waybill is read
// back and kept on the order; a charge more than 5% off our quote is logged;
// TCG's own measurements of our parcels correct the parcel table when they
// point the same way often enough; and once a week Junid gets one WhatsApp
// line: bookings, our quotes vs invoiced, overpaid.
//
//   reconcileOrder   pure: an order + TCG's shipment → the invoiced record, the
//                    diff (if > 5%) and the measurement sample (if TCG
//                    dimensioned the parcel)
//   learnCalibration pure: the samples of one parcel class → the new factor,
//                    or null. DOWN ONLY: Junid's rule is "no multiplier or
//                    safety margin that inflates size", so a class TCG keeps
//                    measuring BIGGER than we declare is reported, never
//                    padded automatically
//   weeklyLine       pure: a week of TCG shipments → the one line
//   runReconcile     the runner's body (scripts/shipping/courier-recon.mjs):
//                    reads, writes, sends. Rates and reads only at TCG.
//
// WHAT "INVOICED" IS. TCG charges the quote at booking; after its hub has
// measured and weighed the parcel it reverses that charge and charges the
// re-rated amount (TCG200369959T: R355.68 at 12:55, reversed and re-charged
// R249.60 at 18:40). The shipment's `rate` is that final amount: for every
// one of the 221 bookings audited (docs/courier-rate-audit.md) it equals the
// net of the account's billing transactions for that shipment.
import { calibrationFactor, parcelClass, CALIBRATION_MIN } from "../../src/shipping/estimateParcel.js";

export const RECON_PATH = "shipping_recon";
export const DIFF_SHARE = 0.05;
// The calibration rule: the latest SAMPLE_WINDOW measured parcels of a class;
// at least MIN_SAMPLES of them; every one more than 5% the same way.
export const MIN_SAMPLES = 3;
export const SAMPLE_WINDOW = 5;
export const CONSISTENT_SHARE = 0.05;
// Only parcels declared by the no-padding rule (bookShipment ESTIMATE_RULE_VERSION
// 4, 6 Nov 2026) teach the table: the old padded declarations (18 cm clothing
// boxes, the empty stack slot) were already corrected by the rule itself, and
// learning from them would correct twice (Sonnet review of #853).
export const MIN_SAMPLE_RULE_VERSION = 4;
// A waybill still not delivered + invoiced this long after booking stops being asked for.
export const GIVE_UP_AFTER_MS = 45 * 86400e3;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const vol = (d) => (d && [d[0], d[1], d[2]].every((x) => Number(x) > 0) ? d[0] * d[1] * d[2] : null);

/** TCG's shipment is final once delivered AND invoiced. */
export function isFinal(shipment) {
  return shipment?.status === "delivered" && shipment?.has_been_invoiced === true && num(shipment?.rate) !== null;
}

/** The quote we booked at: our recorded cost, else what TCG says the original rate was. */
export function quotedRand(order, shipment) {
  return num(order?.shipping?.priced?.quoted) ?? num(order?.shipping?.cost) ?? num(shipment?.original_rate);
}

/**
 * Pure. → { invoiced, diff | null, sample | null } for an order whose waybill
 * TCG has delivered and invoiced; null when it is not final yet.
 */
export function reconcileOrder(orderId, order, shipment, now) {
  if (!isFinal(shipment)) return null;
  const s = order?.shipping ?? {};
  const waybill = s.waybill ?? shipment.short_tracking_reference ?? null;
  const tcg = Array.isArray(shipment.parcels) ? shipment.parcels[0] ?? {} : {};
  const measured = tcg.has_been_dimensioned
    ? [num(tcg.actual_length_cm), num(tcg.actual_width_cm), num(tcg.actual_height_cm), num(tcg.actual_weight_kg)]
    : null;
  const quoted = quotedRand(order, shipment);
  const rand = num(shipment.rate);
  const invoiced = {
    rand,
    quoted,
    chargedKg: num(shipment.charged_weight),
    volumetricKg: num(shipment.volumetric_weight),
    actualKg: num(shipment.actual_weight),
    service: shipment.service_level_code ?? null,
    measured,
    alternativeRef: tcg.alternative_tracking_reference ?? null,
    at: now,
  };
  const share = quoted ? (rand - quoted) / quoted : null;
  const declaredP = s.parcel?.parcels?.[0] ?? null;
  const declared = declaredP ? [num(declaredP.lengthCm), num(declaredP.widthCm), num(declaredP.heightCm), num(declaredP.actualKg)] : null;
  const cls = declaredP ? declaredP.calibrationClass ?? parcelClass(declaredP) : null;
  const diff = share !== null && Math.abs(share) > DIFF_SHARE
    ? { orderId, waybill, quoted, invoiced: rand, share: round2(share), class: cls, declared, measured, chargedKg: invoiced.chargedKg, at: now }
    : null;
  // A measurement sample: what TCG measured ÷ what we declared, by volume —
  // times the factor the declaration carried, so the sample says how far the
  // UNCALIBRATED table is off (the learning never compounds on itself).
  const dv = vol(declared), mv = vol(measured);
  const current = (num(s.parcel?.ruleVersion) ?? 0) >= MIN_SAMPLE_RULE_VERSION;
  // Ordered by when TCG delivered it (a first pass reconciles many at once).
  const at = Date.parse(shipment.delivered_date) || now;
  const sample = current && dv && mv && cls
    ? { orderId, waybill, class: cls, ratio: round2(mv / dv), implied: round2((mv / dv) * (num(declaredP.calibrationFactor) ?? 1)), at }
    : null;
  return { invoiced, diff, sample };
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Pure. The samples of ONE class (any order) and its current calibration
 * entry → { factor, from, samples } to write, { report: "bigger", median }
 * when TCG keeps measuring that class bigger than declared, or null.
 */
export function learnCalibration(samples, current) {
  const latest = [...(samples ?? [])].filter((x) => num(x?.implied) > 0).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, SAMPLE_WINDOW);
  if (latest.length < MIN_SAMPLES) return null;
  const implied = latest.map((x) => Number(x.implied));
  const now = calibrationFactor({ c: current }, "c");
  const med = median(implied);
  const allSmaller = implied.every((r) => r < 1 - CONSISTENT_SHARE);
  // Back toward 1 when an earlier correction now under-declares consistently.
  const allAboveCurrent = now < 1 && implied.every((r) => r > now * (1 + CONSISTENT_SHARE));
  if (allSmaller || allAboveCurrent) {
    const factor = round2(Math.min(1, Math.max(CALIBRATION_MIN, med)));
    if (Math.abs(factor - now) < 0.02) return null;
    return { factor, samples: latest.length, from: latest.map((x) => x.waybill).filter(Boolean) };
  }
  if (implied.every((r) => r > 1 + CONSISTENT_SHARE)) return { report: "bigger", median: round2(med), samples: latest.length };
  return null;
}

// ── the weekly line ─────────────────────────────────────────────────────────
const SAST_MS = 2 * 3600e3;
const DAY = 86400e3;
// R1,234.56 — written out, never the machine's locale (en-ZA prints a decimal comma).
const R = (n) => {
  const [whole, cents] = Math.abs(Number(n) || 0).toFixed(2).split(".");
  return `${Number(n) < 0 ? "-" : ""}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayWords = (ms) => { const d = new Date(ms + SAST_MS); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

/** The SAST Monday 00:00 (as epoch ms) of the week before the one `nowMs` is in. Pure. */
export function lastWeekStart(nowMs) {
  const d = new Date(nowMs + SAST_MS);
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  const thisMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY - SAST_MS;
  return thisMonday - 7 * DAY;
}

/** True any time except Monday before 08:00 SAST; with the per-week key the line goes on the first pass after Monday 08:00. Pure. */
export function weeklyDue(nowMs) {
  const d = new Date(nowMs + SAST_MS);
  // Any time in the week except Monday before 08:00; the per-week key sends it once.
  return !(d.getUTCDay() === 1 && d.getUTCHours() < 8);
}

/**
 * Pure. TCG shipments (GET /shipments rows) → the one line for the week
 * starting `weekStartMs`. Only bookings this system made (created_by our API
 * key), cancelled ones left out. "Overpaid" = what our quotes were charged
 * above the final invoice (TCG refunds it on re-rating, after the money sat
 * off the prepaid balance); "under" = re-rated up.
 */
export function weeklyLine(shipments, weekStartMs, { createdBy = "marathon-pos" } = {}) {
  const end = weekStartMs + 7 * DAY;
  const rows = (shipments ?? []).filter((s) => s?.created_by === createdBy && s.status !== "cancelled"
    && Date.parse(s.time_created) >= weekStartMs && Date.parse(s.time_created) < end);
  let quoted = 0, invoiced = 0, nInvoiced = 0, over = 0, nOver = 0, under = 0, nUnder = 0;
  for (const s of rows) {
    const q = num(s.original_rate) ?? num(s.rate) ?? 0;
    quoted += q;
    if (s.has_been_invoiced) {
      const f = num(s.rate) ?? q;
      invoiced += f; nInvoiced++;
      if (q - f > 0.005) { over += q - f; nOver++; }
      if (f - q > 0.005) { under += f - q; nUnder++; }
    }
  }
  const span = `${dayWords(weekStartMs)}–${dayWords(end - DAY)}`;
  if (!rows.length) return `Courier ${span}: no bookings.`;
  const inv = nInvoiced === rows.length ? `invoiced ${R(invoiced)}` : `invoiced ${R(invoiced)} (${nInvoiced} of ${rows.length} invoiced so far)`;
  const overWords = nOver ? `overpaid ${R(over)} on ${nOver} (re-rated down by TCG)` : "overpaid R0.00";
  const underWords = nUnder ? `, under-quoted ${R(under)} on ${nUnder}` : "";
  return `Courier ${span}: ${rows.length} booking${rows.length === 1 ? "" : "s"}, our quotes ${R(quoted)} vs ${inv}; ${overWords}${underWords}.`;
}

// ── the runner's body ───────────────────────────────────────────────────────
/**
 * One pass. deps: { db (admin), client (courier-client), sendJunid(text, ref)
 * → Promise<boolean>, now, log }. Every step is independent: one failing
 * order never stops the others, and nothing here books or cancels.
 */
export async function runReconcile({ db, client, sendJunid, now = Date.now(), log = () => {} }) {
  const out = { reconciled: 0, diffs: 0, learned: [], lines: 0, weekly: null };

  // 1. Delivered waybills not yet reconciled. THE OPEN SET: the poller adds
  // every live booking to /shipping_recon/open/{orderId} (poll.mjs); the very
  // first pass seeds it from /online_orders once. After that a pass reads only
  // the open orders' shipping nodes, never all of /online_orders (bandwidth).
  const openRef = db.ref(`${RECON_PATH}/open`);
  if (!(await db.ref(`${RECON_PATH}/seededAt`).get()).exists()) {
    // ONE full read, filtered here: /online_orders has no .indexOn for
    // shipping/provider, and the live database REFUSES that query outright
    // ("Index not defined" — the first --dry run on the mini, 6 Nov 2026).
    const all = (await db.ref("online_orders").get()).val() ?? {};
    const seed = {};
    for (const [id, o] of Object.entries(all)) if (o?.shipping?.provider === "courier_guy" && o?.shipping?.waybill && !o.shipping.invoiced && !o.shipping.cancelledAt) seed[id] = Number(o.shipping.bookedAt) || now;
    await openRef.set(seed);
    await db.ref(`${RECON_PATH}/seededAt`).set(now);
  }
  const open = (await openRef.get()).val() ?? {};
  for (const id of Object.keys(open)) {
    const s = (await db.ref(`online_orders/${id}/shipping`).get()).val() ?? {};
    const order = { shipping: s };
    const ref = s.trackingReference || s.waybill;
    const close = () => db.ref(`${RECON_PATH}/open/${id}`).remove();
    if (!ref || s.invoiced || s.cancelledAt) { await close(); continue; }
    if (Number(s.bookedAt) > 0 && now - Number(s.bookedAt) > GIVE_UP_AFTER_MS) {
      await db.ref(`online_orders/${id}/shipping/invoiced`).set({ unreconciled: "not delivered and invoiced within 45 days", at: now });
      await close();
      continue;
    }
    try {
      const res = await client.getShipments({ tracking_reference: ref });
      // Exactly this waybill, never "the first one TCG listed".
      const shipment = (res?.shipments ?? []).find((x) => x.short_tracking_reference === ref || x.custom_tracking_reference === ref);
      if (!shipment) continue;
      const r = reconcileOrder(id, order, shipment, now);
      if (!r) continue;
      const writes = { [`online_orders/${id}/shipping/invoiced`]: r.invoiced };
      const key = String(s.waybill || ref).replace(/[^A-Za-z0-9_-]/g, "-");
      if (r.diff) { writes[`${RECON_PATH}/diffs/${key}`] = r.diff; out.diffs++; log(`recon ${id} ${key} quoted R${r.diff.quoted} invoiced R${r.diff.invoiced} (${Math.round(r.diff.share * 100)}%)`); }
      if (r.sample) writes[`${RECON_PATH}/samples/${r.sample.class.replace(/[^A-Za-z0-9_-]/g, "_")}/${key}`] = r.sample;
      writes[`${RECON_PATH}/open/${id}`] = null;
      await db.ref().update(JSON.parse(JSON.stringify(writes)));
      out.reconciled++;
    } catch (e) {
      log(`recon ${id} ${ref} skipped: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  // 2. Learn the parcel table from the samples (down only; a "bigger" class is reported).
  const samples = (await db.ref(`${RECON_PATH}/samples`).get()).val() ?? {};
  const calibration = (await db.ref("config/shipping/calibration").get()).val() ?? {};
  for (const [clsKey, rows] of Object.entries(samples)) {
    const list = Object.values(rows ?? {});
    const cls = list[0]?.class ?? clsKey;
    const learned = learnCalibration(list, calibration[cls]);
    if (!learned) continue;
    if (learned.report) {
      await db.ref(`${RECON_PATH}/bigger/${clsKey}`).set({ class: cls, median: learned.median, samples: learned.samples, at: now });
      continue;
    }
    // Writing /config/shipping changes estimateSig, so the poller re-estimates every open order on its next tick.
    await db.ref(`config/shipping/calibration/${cls}`).set({ factor: learned.factor, samples: learned.samples, from: learned.from, at: now });
    await db.ref(`${RECON_PATH}/log/${now}_${clsKey}`).set({ class: cls, factor: learned.factor, from: learned.from, at: now });
    out.learned.push({ class: cls, factor: learned.factor });
    log(`recon calibration ${cls} → ×${learned.factor} from ${learned.from.join(", ")}`);
  }

  // 3. Lines for Junid (over-ceiling bookings), each once.
  const lines = (await db.ref(`${RECON_PATH}/junidLines`).get()).val() ?? {};
  for (const [k, l] of Object.entries(lines)) {
    if (!l?.text || l.sentAt) continue;
    // Claimed BEFORE the send: a crash after it can lose a line, never send it twice.
    const mark = db.ref(`${RECON_PATH}/junidLines/${k}/sentAt`);
    await mark.set(now);
    if (await sendJunid(l.text, `courier-ceiling-${k}`)) out.lines++;
    else await mark.remove();
  }

  // 4. The weekly line, Monday from 08:00 SAST, once per week.
  if (weeklyDue(now)) {
    const start = lastWeekStart(now);
    const weekKey = new Date(start + SAST_MS).toISOString().slice(0, 10);
    const sent = (await db.ref(`${RECON_PATH}/weekly/${weekKey}/sentAt`).get()).val();
    if (!sent) {
      const shipments = [];
      const startDate = new Date(start + SAST_MS).toISOString().slice(0, 10);
      // Until an EMPTY page: TCG may cap a page below what was asked.
      for (let offset = 0; offset < 5000;) {
        const page = (await client.getShipments({ limit: 100, offset, start_date: startDate }))?.shipments ?? [];
        if (!page.length) break;
        shipments.push(...page);
        offset += page.length;
      }
      const line = weeklyLine(shipments, start);
      const mark = db.ref(`${RECON_PATH}/weekly/${weekKey}`);
      await mark.set({ line, sentAt: now });
      if (await sendJunid(line, `courier-week-${weekKey}`)) out.weekly = line;
      else await mark.remove();
    }
  }
  return out;
}

// ── Which Courier Guy service to book — pure ────────────────────────────────
// Shared by bookShipment and the quote runner, so the card's "Booking would
// choose …" line is the same decision booking makes.
//
// THE RULE. A parcel the drop-box rule calls eligible (estimateParcel's
// dropBoxEligible) is booked on the CHEAPEST locker service TCG quotes for it
// — normally the locker size the estimate named; if TCG does not offer that
// size (its own weight limits move), the cheapest locker it does offer. If TCG
// offers no locker at all, it falls back to the door. A parcel above every
// locker threshold is booked on the cheapest DOOR service, never one in
// `excludeServiceCodes` (SDX by default — R1,200+ same-day).

/** TCG's /rates response → [{code, name, rate, chargedKg, serviceLevelId, group}] */
export function normalizeRates(res) {
  return (Array.isArray(res?.rates) ? res.rates : [])
    .filter((r) => r?.service_level?.code && Number.isFinite(Number(r.rate)))
    .map((r) => ({
      code: r.service_level.code,
      name: r.service_level.name ?? "",
      rate: Number(r.rate),
      chargedKg: r.charged_weight ?? null,
      serviceLevelId: r.service_level.id ?? null,
      group: r.service_level.group_code ?? null,
      breakdown: rateBreakdown(r),
    }));
}

// What the price is made of (incl. VAT, as TCG lists each charge): the base,
// every surcharge ("High risk", "Outlying area") and adjustment (fuel), and
// the weights TCG charged on. Kept on the booking so the >R250 email
// (scripts/shipping/costAlert.mjs) can say WHY a waybill is expensive.
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const charges = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && Number(c.charge) > 0)
  .map((c) => ({ name: String(c.name || "charge"), charge: Number(c.charge) }));
function rateBreakdown(r) {
  return {
    base: num(r.base_rate?.charge),
    surcharges: charges(r.surcharges),
    adjustments: charges([...(r.rate_adjustments || []), ...(r.time_based_rate_adjustments || []), ...(r.extras || [])]),
    chargedKg: num(r.charged_weight),
    actualKg: num(r.actual_weight),
    volumetricKg: num(r.volumetric_weight),
  };
}

const cheapest = (rates) => rates.reduce((best, r) => (!best || r.rate < best.rate ? r : best), null);

/**
 * @param {{locker?: Array|null, door?: Array|null}} quoted  normalised rates
 * @param {{dropBoxEligible: boolean}} parcel
 * @param {{excludeServiceCodes?: string[]}} config
 * @returns {{mode: "locker"|"door", rate: object} | null}
 */
export function chooseRate(quoted, parcel, config = {}) {
  const exclude = new Set(config.excludeServiceCodes ?? []);
  const locker = (quoted?.locker ?? []).filter((r) => !exclude.has(r.code));
  const door = (quoted?.door ?? []).filter((r) => !exclude.has(r.code));
  if (parcel?.dropBoxEligible && locker.length) return { mode: "locker", rate: cheapest(locker) };
  if (door.length) return { mode: "door", rate: cheapest(door) };
  return null;
}

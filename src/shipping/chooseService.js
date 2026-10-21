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
    }));
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

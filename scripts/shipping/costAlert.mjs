// ── THE EXPENSIVE-WAYBILL EMAIL — pure ──────────────────────────────────────
// Junid, 30 Oct 2026: the courier ceiling stays OFF (maxChargeRand 0) — every
// order books itself — and instead he is emailed once for each waybill above
// R250, with the order, the box and WHY it cost that much, so a wrong box or a
// surcharge is spotted. The poller (onlineOrders/poll.mjs) sends it right after
// a live booking; this file only decides and writes the words.
//
// The "why" is read off what Courier Guy quoted (shipping.priced, kept by
// bookShipment from the chosen rate) and the parcel the estimate built:
//   • box size   — charged on the box's volume, well above what the goods weigh
//   • weight     — the goods themselves are heavy
//   • surcharges — each one TCG added ("High risk", "Outlying area", …)
//   • estimates  — items/boxes whose sizes are defaults, not measured
// When nothing stands out, the base rate is the reason (distance/service).

export const DEFAULT_COST_ALERT_RAND = 250;

/** /config/shipping/costAlertRand (a positive number) or R250. */
export function costAlertThreshold(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COST_ALERT_RAND;
}

const R = (n) => `R${Number(n).toFixed(2)}`;
const kg = (n) => `${Math.round(Number(n) * 100) / 100} kg`;
const finite = (n) => Number.isFinite(Number(n)) && n !== null;
const contentKind = (c) => (typeof c === "string" ? c : c?.kind) || "item";

function boxWords(p) {
  const dims = [p?.lengthCm, p?.widthCm, p?.heightCm].every(finite) ? ` ${p.lengthCm}×${p.widthCm}×${p.heightCm} cm` : "";
  const name = p?.kind === "shoebox" ? (Number(p.pairs) > 1 ? `${p.pairs} shoeboxes` : "shoebox") : `${p?.boxCode || "custom"} box`;
  const n = {};
  for (const c of Array.isArray(p?.contents) ? p.contents : []) n[contentKind(c)] = (n[contentKind(c)] || 0) + 1;
  const what = Object.entries(n).map(([k, c]) => `${c} × ${k}`).join(", ");
  return `${name}${dims}${what ? ` — ${what}` : ""}`;
}

/** Why this waybill costs what it does → [sentence]. Never empty. */
export function expensiveWhy(shipping) {
  const s = shipping || {};
  const pr = s.priced || {};
  const parcel = s.parcel || s.booking?.parcel || {};
  const parcels = Array.isArray(parcel.parcels) ? parcel.parcels : [];
  const actual = finite(pr.actualKg) ? Number(pr.actualKg) : finite(parcel.actualKg) ? Number(parcel.actualKg) : null;
  const vol = finite(pr.volumetricKg) ? Number(pr.volumetricKg) : parcels.reduce((t, p) => t + (Number(p.volumetricKg) || 0), 0) || null;
  const charged = finite(pr.chargedKg) ? Number(pr.chargedKg) : finite(parcel.chargeableKg) ? Number(parcel.chargeableKg) : null;
  const why = [];

  if (vol && actual && vol >= actual * 1.5 && (!charged || charged >= vol * 0.95)) {
    why.push(`Box size: charged on ${kg(charged ?? vol)} because of the box's volume, while the goods weigh only ${kg(actual)}. A smaller box would cut this.`);
  } else if (actual && charged && actual >= charged * 0.95 && actual >= 5) {
    why.push(`Weight: the goods themselves weigh ${kg(actual)}.`);
  }
  for (const c of Array.isArray(pr.surcharges) ? pr.surcharges : []) {
    why.push(`Surcharge: ${c.name} ${R(c.charge)}.`);
  }
  const unmeasured = (Array.isArray(parcel.unmeasured) ? parcel.unmeasured : []).map((u) => String(u).replace(/^item:/, "").replace(/^box:/, "box "));
  if (unmeasured.length) why.push(`Estimated, not measured: ${unmeasured.join(", ")} — the real size or weight may differ.`);
  if (!why.length || (why.length === 1 && unmeasured.length)) {
    const base = finite(pr.base) ? `the base rate ${R(pr.base)}` : "the base rate";
    why.unshift(`Distance/service: no box or surcharge problem — ${base} for ${s.service || "this service"} to this address is the cost.`);
  }
  return why;
}

/**
 * The email for one booked waybill, or null when it is at or under the
 * threshold (or not a real booking).
 */
export function costAlertMail(order, shipping, threshold = DEFAULT_COST_ALERT_RAND) {
  const s = shipping || {};
  const cost = Number(s.cost);
  if (!s.waybill || !Number.isFinite(cost) || cost <= threshold) return null;
  const label = order?.shopifyName || (order?.orderNumber ? `#${order.orderNumber}` : order?.ref || order?.key || "order");
  const a = s.address || order?.shipping?.address || {};
  const where = [a.city, a.province].filter(Boolean).join(", ");
  const parcel = s.parcel || s.booking?.parcel || {};
  const parcels = Array.isArray(parcel.parcels) ? parcel.parcels : [];
  const pr = s.priced || {};
  const why = expensiveWhy(s);
  const extras = [...(pr.surcharges || []), ...(pr.adjustments || [])];
  const priceLine = finite(pr.base)
    ? `Price: base ${R(pr.base)}${extras.map((c) => ` + ${c.name} ${R(c.charge)}`).join("")} = ${R(cost)} (incl. VAT).`
    : `Price: ${R(cost)} (incl. VAT).`;
  const weights = [finite(pr.actualKg) && `goods ${kg(pr.actualKg)}`, finite(pr.volumetricKg) && `box volume ${kg(pr.volumetricKg)}`, finite(pr.chargedKg) && `charged on ${kg(pr.chargedKg)}`].filter(Boolean).join(", ");
  const firstWhy = why[0].replace(/:.*/, "").toLowerCase();
  return {
    subject: `Waybill ${R(cost)} for ${label} — ${firstWhy}${parcels[0] ? ` (${parcels[0].boxCode || parcels[0].kind || "box"})` : ""}`,
    text: [
      `Website order ${label}${order?.customer?.name ? ` for ${order.customer.name}` : ""} was booked at ${R(cost)} — over your R${threshold} alert.`,
      "",
      "Why it's expensive:",
      ...why.map((w) => `• ${w}`),
      "",
      `Waybill: ${s.waybill}${s.service ? ` (${s.service})` : ""}${where ? ` to ${where}` : ""}.`,
      ...parcels.map((p, i) => `${parcels.length > 1 ? `Parcel ${i + 1}` : "Box"}: ${boxWords(p)}.`),
      ...(weights ? [`Weights: ${weights}.`] : []),
      priceLine,
      "",
      "Already booked — nothing to do unless the box or the surcharge looks wrong.",
    ].join("\n"),
  };
}

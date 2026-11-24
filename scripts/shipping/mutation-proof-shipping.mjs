// ─── MUTATION PROOF HARNESS — Courier Guy shipping ───────────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. Same discipline as scripts/mutation-proof-push-notify.mjs:
// ERROR is not FAIL, unique anchors, signal-safe restore from captured bytes,
// clean-tree preflight.
//
// The guard Junid named: with /config/shipping/live false, NO code path may
// reach a shipment call (L1–L6). The rest pin the estimator's arithmetic and
// the rate choice, because a wrong parcel is a wrong price on every order.
//
// SAFETY (2026-10-07: a test run once reached the LIVE database). The child
// test runs get FIREBASE_DATABASE_EMULATOR_HOST pinned to a dead port and a
// dummy COURIER_GUY_API_KEY, and the suite stubs fetch to throw — a mutation
// that bypassed the injected fakes would fail loudly, never touch prod.
// Run it from a separate worktree, never beside uncommitted work.
//
// Run:  node scripts/shipping/mutation-proof-shipping.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "../lib/mutationPreflight.mjs";

const BOOK = "scripts/shipping/bookShipment.mjs";
const CLIENT = "scripts/shipping/courier-client.mjs";
const EST = "src/shipping/estimateParcel.js";
const CHOOSE = "src/shipping/chooseService.js";
const CARD = "src/components/admin/ShippingCard.jsx";
const REC = "scripts/shipping/reconcile.mjs";
const ORDER = "src/shipping/orderShipment.js";
const LOCKER = "scripts/shipping/lockerDelivery.mjs";
const REBOOK = "scripts/shipping/rebook-locker.mjs";
const UNK = "scripts/shipping/unknownBooking.mjs";
const BRET = "scripts/shipping/bookReturn.mjs";
const TESTS = ["src/shipping", "scripts/shipping", "src/components/admin/ShippingCard.gate.test.jsx"];

const CHILD_ENV = {
  ...process.env,
  FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9",
  COURIER_GUY_API_KEY: "mutation-harness-dummy-key",
  GOOGLE_APPLICATION_CREDENTIALS: "/dev/null",
};

const MUTATIONS = [
  // ── THE LIVE-FLAG GUARD ──────────────────────────────────────────────────
  { id: "L1", file: BOOK, guard: "only the BOOLEAN true is live — a truthy string/number is a dry run",
    from: "return snap.exists() && snap.val() === true;", to: "return snap.exists() && !!snap.val();" },
  { id: "L2", file: BOOK, guard: "live is READ, never assumed",
    from: "return snap.exists() && snap.val() === true;", to: "return true;" },
  { id: "L3", file: BOOK, guard: "bookShipment returns the dry run when live is off",
    from: "  ]);\n  if (!live) {\n    log(`bookShipment", to: "  ]);\n  if (false) {\n    log(`bookShipment" },
  { id: "L4", file: BOOK, guard: "cancelShipment returns the dry run when live is off",
    from: "  const live = await readLive(db);\n  if (!live) {\n    log(`cancelShipment", to: "  const live = await readLive(db);\n  if (false) {\n    log(`cancelShipment" },
  { id: "L5", file: BOOK, guard: "an order already carrying a shipmentId is never booked again",
    from: "if (order?.shipping?.shipmentId) {", to: "if (false) {" },
  { id: "L6", file: BOOK, guard: "a held booking claim blocks a second booking",
    from: "if (cur && cur.state !== \"failed\") return undefined;", to: "if (false) return undefined;" },
  { id: "L7", file: BOOK, guard: "a 5xx/timeout leaves the claim UNKNOWN (TCG may have booked it)",
    from: "const lost = !(err?.status >= 400 && err?.status < 500) || err?.status === 408;", to: "const lost = false;" },
  { id: "L8", file: BOOK, guard: "live refuses without a collection contact / with no box",
    from: "  if (plan.liveBlockers.length) {", to: "  if (false) {" },
  { id: "L9", file: ORDER, guard: "the order code is never used as the /online_orders key",
    from: "return first(order?.key, order?.id, gidTail);", to: "return first(order?.key, order?.id, gidTail, order?.ref);" },
  { id: "L10", file: BOOK, guard: "live is re-read AFTER the claim — a switch-off mid-quote stops the booking",
    from: "  if (!(await readLive(db))) {\n    await claimRef.set(", to: "  if (false) {\n    await claimRef.set(" },
  { id: "L11", file: BOOK, guard: "the spend ceiling blocks a live booking quoted above it",
    from: "chosen.rate.rate > ceiling)", to: "chosen.rate.rate > ceiling * 1000)" },
  { id: "L12", file: BOOK, guard: "booking never mints an order node — the order must exist at its key",
    from: "if (!(orderExists ?? (await db.ref(`online_orders/${key}/${existsField}`).get()).exists())) {", to: "if (false) {" },
  { id: "L13", file: BOOK, guard: "a create response naming no shipment is UNKNOWN, never 'booked'",
    from: "(res.id == null && !res.short_tracking_reference && !res.custom_tracking_reference)", to: "(false)" },
  { id: "C1", file: CLIENT, guard: "a create is NEVER retried on 5xx (a retry could book twice)",
    from: "createShipment: (body) => call(\"POST\", \"/shipments\", { body, retry5xx: false }),", to: "createShipment: (body) => call(\"POST\", \"/shipments\", { body, retry5xx: true })," },
  { id: "C2", file: CLIENT, guard: "the API key is redacted from every log line",
    from: "  if (key) s = s.split(key).join(\"[REDACTED]\");\n", to: "\n" },
  { id: "C3", file: CLIENT, guard: "a 4xx is not retried",
    from: "if (res.status >= 500 && attempt < attempts) {", to: "if (res.status >= 400 && attempt < attempts) {" },

  // ── DOOR-TO-LOCKER (Junid, 20 Nov 2026) ──────────────────────────────────
  { id: "D1", file: BOOK, guard: "deliveryMode \"door\" restores door-to-door",
    from: "const toLocker = cfg.deliveryMode !== \"door\";", to: "const toLocker = true;" },
  { id: "D2", file: LOCKER, guard: "a locker beyond the distance limit is never booked (no locker → door-to-door since 24 Nov 2026, never that locker)",
    from: "l.km <= limit && !avoid.has(l.id)", to: "l.km <= limit * 1000 && !avoid.has(l.id)" },
  { id: "D3", file: LOCKER, guard: "the spend ceiling blocks a door-to-locker booking quoted above it",
    from: "rate.rate > ceiling) {", to: "rate.rate > ceiling * 1000) {" },
  { id: "D4", file: LOCKER, guard: "one order is ONE shipment however many pairs (only a person's count splits it)",
    from: "return Number.isInteger(set) && set >= 1 ? set : 1;", to: "return Number.isInteger(set) && set >= 1 ? set : 2;" },
  { id: "D5", file: LOCKER, guard: "the CHEAPEST door-to-locker service is booked",
    from: "(!best || r.rate < best.rate ? r : best)", to: "(!best || r.rate > best.rate ? r : best)" },
  { id: "D6", file: BOOK, guard: "every parcel of a split is its own shipment",
    from: "for (let i = made.length; i < payloads.length; i++) {", to: "for (let i = made.length; i < Math.min(payloads.length, 1); i++) {" },
  { id: "D7", file: BOOK, guard: "cancelling a split cancels every shipment",
    from: "for (const r of refs) { await client.cancelShipment(r); cancelled.push(r); }", to: "for (const r of refs.slice(0, 1)) { await client.cancelShipment(r); cancelled.push(r); }" },
  { id: "D8", file: REBOOK, guard: "a collected parcel is never rebooked",
    from: "if (!UNCOLLECTED.test(status)) return", to: "if (false) return" },
  { id: "D9", file: REBOOK, guard: "rebook-locker is a dry run unless --book AND live",
    from: "  if (!book || !live) {", to: "  if (false) {" },
  { id: "D10", file: LOCKER, guard: "the shipment carries the delivery pickup point",
    from: "    delivery_pickup_point_id: found.locker.id,\n", to: "" },
  { id: "D11", file: REC, guard: "the billed-vs-booked adjustment is billed minus booked",
    from: "billed: rand, diff: round2(rand - booked), pct: booked ? Math.round(((rand - booked) / booked) * 1000) / 10 : null, declared", to: "billed: rand, diff: 0, pct: booked ? Math.round(((rand - booked) / booked) * 1000) / 10 : null, declared" },
  { id: "D15", file: BOOK, guard: "a half-booked split is never finished as a different plan (mode switched, locker changed)",
    from: "if (partial && (plan.locker?.id !== partial.locker.id || payloads.length < partial.shipments.length)) {", to: "if (false) {" },
  { id: "D16", file: BOOK, guard: "a checkpoint that could not be written holds the claim (no blind re-book of parcel 1)",
    from: "state: ambiguous || !kept ? \"unknown\" : \"failed\"", to: "state: ambiguous ? \"unknown\" : \"failed\"" },
  { id: "D17", file: LOCKER, guard: "no customer mobile number, no locker booking (the PIN goes by SMS)",
    from: "if (!str(contact?.mobile_number)) blockers.push(", to: "if (false) blockers.push(" },
  { id: "D18", file: REBOOK, guard: "one rebook at a time per order",
    from: "(cur && now() - Number(cur.at) < REBOOK_LOCK_MS ? undefined :", to: "(false ? undefined :" },
  { id: "D12", file: LOCKER, guard: "an address placed only by its town gets the tighter limit",
    from: "const limit = byStreet ? pos(lk.maxKm, 30) : pos(lk.maxTownKm, 20);", to: "const limit = pos(lk.maxKm, 30);" },
  { id: "D13", file: LOCKER, guard: "every parcel is declared as one shoe, never the estimate",
    from: "    parcels: [tcgParcel(shoe)],\n    service_level_code: rate.code,", to: "    parcels: (estimate?.parcels ?? []).map((p) => tcgParcel(p)),\n    service_level_code: rate.code," },
  { id: "D14", file: BOOK, guard: "a split interrupted mid-way books only the rest on retry",
    from: "const made = partial ? [...partial.shipments] : [];", to: "const made = [];" },

  // ── NO LOCKER → DOOR-TO-DOOR (Junid, 24 Nov 2026) ─────────────────────────
  { id: "F1", file: BOOK, guard: "only a NO-LOCKER refusal goes door-to-door (an unplaceable address, a failed lookup still refuse)",
    from: "if (!lockerPlan || lockerPlan.ok || !DOOR_FALLBACK_KINDS.includes(lockerPlan.noLockerKind)) return null;", to: "if (!lockerPlan || lockerPlan.ok) return null;" },
  { id: "F2", file: BOOK, guard: "a locker a person named / ruled out / split, or a half-booked split, is never swapped for door-to-door",
    from: "if (cfg?.locker?.doorFallback === false || lockerSteered(order)) return null;", to: "if (cfg?.locker?.doorFallback === false) return null;" },
  { id: "F3", file: BOOK, guard: "no locker near → the door-to-door plan is booked (never left unbooked)",
    from: "    if (!fallback) return lockerPlan;", to: "    if (true) return lockerPlan;" },
  { id: "F4", file: BOOK, guard: "an order refused for no locker is handed back ONCE (shipping/doorRetry)",
    from: "if (s.shipmentId != null || s.waybill || s.doorRetry || s.booking?.doorTried) return null;", to: "if (s.shipmentId != null || s.waybill || s.booking?.doorTried) return null;" },
  { id: "F5", file: BOOK, guard: "the door-to-door booking says so on the order (deliveryMode door + doorFallback)",
    from: "...(plan.doorFallback && !plan.locker ? { deliveryMode: \"door\", doorFallback: plain({ ...plan.doorFallback, at: now() }) } : {}),", to: "" },
  { id: "F10", file: BOOK, guard: "the once is re-checked on the order as it is NOW (a changed order is never booked from a stale listing)",
    from: "    if (!why) return undefined;\n    const marked", to: "    const marked" },
  { id: "F11", file: BOOK, guard: "the hand-back after a booking never undoes a fulfilment that moved on",
    from: "doorHandBackDue(cur) ? handedBack(cur, at) : undefined", to: "handedBack(cur, at)" },
  { id: "F6", file: BRET, guard: "a return's door collection is OFF unless switched on (Jimmy still says \"drop it at the locker\")",
    from: "const doorOn = doorCollection === true || (doorCollection == null && cfg.returnDoorCollection === true);", to: "const doorOn = doorCollection !== false;" },
  { id: "F7", file: BRET, guard: "the spend ceiling blocks a door collection quoted above it",
    from: "doorRate.rate > max) doorBlockers.push(", to: "doorRate.rate > max * 1000) doorBlockers.push(" },
  { id: "F8", file: BRET, guard: "a door collection carries no drop-off reference",
    from: "dropOffRef: door ? null : (res.custom_tracking_reference || null),", to: "dropOffRef: res.custom_tracking_reference || null," },
  { id: "F9", file: BRET, guard: "a locker-rate lookup that FAILED is retried later, never turned into a door collection",
    from: "if (!lockers.length) return quoted.error ? { ok: false, transient: true, reason: `no locker rate (${quoted.error})`, parcel } : noLocker(", to: "if (!lockers.length) return noLocker(" },

  // ── AN "UNKNOWN" BOOKING, CHECKED AT COURIER GUY (#2181, 21 Nov 2026) ─────
  { id: "U1", file: UNK, guard: "the claim moves only while it is the very unknown claim that was checked (never twice)",
    from: "const sameClaim = (cur) => cur && cur.state === \"unknown\" && Number(cur.at) === claimAt;", to: "const sameClaim = (cur) => !!cur;" },
  { id: "U2", file: BOOK, guard: "Courier Guy's geocode 500 is recognised (the locker-address fallback)",
    from: "  if (!(status >= 400 && status < 600) || status === 408) return false;", to: "  return false;" },
  { id: "U3", file: BOOK, guard: "a geocode refusal is a definite failure, never \"unknown\"",
    from: "const ambiguous = lost && !isGeocodeRefusal(err);", to: "const ambiguous = lost;" },
  { id: "U4", file: UNK, guard: "at most one automatic re-book",
    from: "if (Number(claim.rebooks) >= MAX_AUTO_REBOOKS) {", to: "if (false) {" },
  { id: "U5", file: UNK, guard: "a cancelled shipment is not the order's booking",
    from: ".filter((s) => !/cancel/i.test(str(s?.status)))", to: ".filter(() => true)" },
  { id: "U6", file: UNK, guard: "the reference matches exactly (#1941 is never #1941-EX)",
    from: "return !!want && (r === want || r.startsWith(`${want} (`));", to: "return !!want && r.startsWith(want);" },
  { id: "U7", file: UNK, guard: "an answer that is not a shipment list is an error, never \"no shipment\"",
    from: "if (!res || !Array.isArray(res.shipments)) throw", to: "if (false) throw" },
  { id: "U8", file: UNK, guard: "an ignored offset is an error, never \"no shipment\"",
    from: "if (page > 0 && keys.every((k) => seen.has(k))) throw", to: "if (false) throw" },
  { id: "U9", file: UNK, guard: "the page cap with a full last page is an error",
    from: "if (page >= maxPages) throw", to: "if (page >= maxPages) break; if (false) throw" },
  { id: "U10", file: UNK, guard: "the parcels an earlier attempt booked are merged in (no second waybill for parcel 1)",
    from: "const made = mergeMade(earlier, found);", to: "const made = mergeMade([], found);" },
  { id: "U11", file: UNK, guard: "more shipments than the order needs go to attention",
    from: "if (made.length > wanted) return flag(", to: "if (false) return flag(" },
  { id: "U12", file: UNK, guard: "a claim from before this change is never attached on a guess",
    from: "const legacy = claim.shipments == null;", to: "const legacy = false;" },
  { id: "U13", file: UNK, guard: "nothing is released while live is off",
    from: "if (!(await readLive(db))) return { action: \"live_off\" };", to: "" },
  { id: "U14", file: UNK, guard: "the claim carries the waybill before the order's fields (the attach crash)",
    from: "const ok = await moveClaim(plain({ state: \"booked\", at: t, recovered: true, shipmentId: first.shipmentId, waybill: first.waybill,", to: "const ok = await moveClaim(plain({ state: \"booked\", at: t, recovered: true, shipmentId: null, waybill: null," },
  { id: "U15", file: BOOK, guard: "a re-book is counted once it reaches a create",
    from: "rebooks: (ambiguous || !kept) ? prior.rebooks + 1 : prior.rebooks", to: "rebooks: prior.rebooks" },
  { id: "U16", file: BRET, guard: "an OpenStreetMap hit in another province is never used",
    from: "  if (state) return allowed.includes(state);", to: "  if (state) return true;" },
  { id: "U19", file: BRET, guard: "the postal code's province counts beside the typed one (customers pick the wrong province)",
    from: "...(PROVINCES[typed] ? [typed] : []), ...postalProvinces(address?.code)", to: "...(PROVINCES[typed] ? [typed] : [])" },
  { id: "U20", file: BRET, guard: "a residential area counts as a place (Rooiberg)",
    from: " || (hit.class === \"landuse\" && hit.type === \"residential\");", to: ";" },
  { id: "U17", file: BRET, guard: "the town tries take only a place, never a street",
    from: "export const isPlace = (hit) => !hit?.class || hit.class === \"place\" || hit.class === \"boundary\" || (hit.class === \"landuse\" && hit.type === \"residential\");", to: "export const isPlace = () => true;" },
  { id: "U18", file: LOCKER, guard: "Shopify's point in another province is not used",
    from: "(await pointInProvince(geo, address, { fetchImpl })) !== false", to: "true" },

  // ── THE ESTIMATOR ────────────────────────────────────────────────────────
  { id: "E1", file: EST, guard: "chargeable = max(actual, volumetric)",
    from: "chargeableKg: Math.max(parcel.actualKg, volumetricKg)", to: "chargeableKg: parcel.actualKg" },
  { id: "E2", file: EST, guard: "a size band includes its upper edge",
    from: "bands.find((b) => n <= b.upToSize)", to: "bands.find((b) => n < b.upToSize)" },
  { id: "E3", file: EST, guard: "fit is tested in any orientation",
    from: "const a = sortDesc(inner), b = sortDesc(outer);", to: "const a = inner, b = outer;" },
  { id: "E4", file: EST, guard: "a locker takes a parcel AT its weight threshold",
    from: "actualKg <= Number(lk.maxKg)", to: "actualKg < Number(lk.maxKg)" },
  { id: "E5", file: EST, guard: "the SMALLEST fitting box wins across layouts",
    from: "if (!best || v < best.v) best = { box, block, v };", to: "if (!best || v > best.v) best = { box, block, v };" },
  { id: "E6", file: EST, guard: "EU kids sizes are kids shoes",
    from: "return n >= 16 && n <= 35;", to: "return false;" },
  { id: "E7", file: EST, guard: "items in a column STACK (heights add)",
    from: "    c.h += it.h;", to: "    c.h = Math.max(c.h, it.h);" },
  { id: "E8", file: EST, guard: "the box's own weight is counted",
    from: "items.reduce((t, it) => t + it.kg, 0) + (best ? Number(best.box.tareKg) || 0 : 0)", to: "items.reduce((t, it) => t + it.kg, 0)" },
  { id: "E9", file: EST, guard: "volumetric uses the configured divisor",
    from: "round2((parcel.lengthCm * parcel.widthCm * parcel.heightCm) / divisor)", to: "round2((parcel.lengthCm * parcel.widthCm * parcel.heightCm) / 5000)" },
  { id: "E10", file: EST, guard: "a disabled drop box means door, always",
    from: "  if (!dropBox?.enabled) return null;\n", to: "\n" },
  { id: "E11", file: EST, guard: "each unit is its own item (qty expands)",
    from: "for (let i = 0; i < qty; i++) items.push(", to: "for (let i = 0; i < Math.min(qty, 1); i++) items.push(" },

  // ── THE PARCEL RULE (ONE parcel, never split — 2026-10-23) ──
  { id: "B1", file: EST, guard: "soft goods stuff the shoeboxes only up to the fill budget",
    from: "if (stuffedKg + it.kg <= budget + 1e-9) stuffedKg += it.kg;", to: "if (true) stuffedKg += it.kg;" },
  { id: "B2", file: EST, guard: "the parcel weighs everything in it",
    from: "const actualKg = round2(items.reduce((t, it) => t + it.kg, 0));", to: "const actualKg = round2(pairs.reduce((t, it) => t + it.kg, 0));" },
  { id: "B3", file: EST, guard: "every pair is in the stack (never a second parcel, never a dropped pair)",
    from: "const stack = shoeboxStack(pairs.length, sb);", to: "const stack = shoeboxStack(1, sb);" },
  { id: "B4", file: EST, guard: "the arrangement with the smallest LONGEST side wins",
    from: "if (!best || longest < best.longest || (longest === best.longest && v < best.v)) best = { columns, rows, dims, longest, v };", to: "if (!best) best = { columns, rows, dims, longest, v };" },
  { id: "B5", file: EST, guard: "what lies on top adds its own flat thickness",
    from: "heightCm: round1(stack.heightCm + onTopCm),", to: "heightCm: round1(stack.heightCm),", },

  // ── NO PADDING (Junid, 6 Nov 2026 — TCG200369959T) ──
  { id: "P1", file: EST, guard: "a stack never declares an empty slot (5 pairs = 34×46×32.5, not 39)",
    from: "const dims = [l, w * columns, round1((h * pairs) / columns)];", to: "const dims = [l, w * columns, h * rows];" },
  { id: "P2", file: EST, guard: "clothing with no footwear ships in the flat bag, not a box",
    from: "parcel = { ...(flatBagParcel(items, cfg, divisor) ?? flatParcel(items, cfg, divisor)),", to: "parcel = { ...(flatParcel(items, cfg, divisor)),", },
  { id: "P3", file: EST, guard: "a cap after the first nests into it",
    from: "t += caps++ === 0 ? own : Number.isFinite(nest) && nest >= 0 ? nest : own;", to: "t += own; caps++;" },
  { id: "P4", file: EST, guard: "the bag is never below its minimum height",
    from: "const heightCm = round1(Math.max(Number(bag.minHeightCm) || 0, thick));", to: "const heightCm = round1(thick);" },
  { id: "P5", file: EST, guard: "a learned factor scales the declared height",
    from: "if (factor !== 1) parcel = finish({ ...parcel, heightCm: round1(parcel.heightCm * factor) }, divisor);", to: "" },
  { id: "P6", file: REC, guard: "calibration is DOWN only — a bigger class is reported, never padded",
    from: "const factor = round2(Math.min(1, Math.max(CALIBRATION_MIN, med)));", to: "const factor = round2(Math.max(CALIBRATION_MIN, med));" },
  { id: "P7", file: REC, guard: "calibration needs a consistent pattern",
    from: "const allSmaller = implied.every((r) => r < 1 - CONSISTENT_SHARE);", to: "const allSmaller = implied.some((r) => r < 1 - CONSISTENT_SHARE);" },
  { id: "P8", file: REC, guard: "a diff is logged only beyond 5%",
    from: "Math.abs(share) > DIFF_SHARE", to: "Math.abs(share) >= 0" },
  { id: "P9", file: BOOK, guard: "a booking over the ceiling is refused (one line to Junid)",
    from: "liveBlockers.push(`quote R${chosen.rate.rate.toFixed(2)} is over the R${ceiling} ceiling`);", to: "" },

  // ── THE RATE CHOICE ──────────────────────────────────────────────────────
  { id: "R1", file: CHOOSE, guard: "an excluded service (SDX) is never chosen",
    from: "const door = (quoted?.door ?? []).filter((r) => !exclude.has(r.code));", to: "const door = (quoted?.door ?? []);" },
  { id: "R2", file: CHOOSE, guard: "a locker is chosen ONLY for a drop-box-eligible parcel",
    from: "if (parcel?.dropBoxEligible && locker.length)", to: "if (locker.length)" },
  { id: "R3", file: CHOOSE, guard: "the CHEAPEST rate is chosen",
    from: "(!best || r.rate < best.rate ? r : best)", to: "(!best || r.rate > best.rate ? r : best)" },

  // ── THE CARD ─────────────────────────────────────────────────────────────
  { id: "K1", file: CARD, guard: "Save never writes /config/shipping/live",
    from: "for (const k of EDITABLE_KEYS) out[k] = cfg[k];", to: "for (const k of EDITABLE_KEYS) out[k] = cfg[k]; out.live = live;" },
  { id: "K2", file: CARD, guard: "the live switch is disabled",
    from: "checked={live} disabled readOnly", to: "checked={live} readOnly" },
  { id: "K3", file: CARD, guard: "an order ref is validated before any read",
    from: "try { seg = assertSafeSegment(refInput.trim(), \"order ref\"); }", to: "try { seg = refInput.trim(); }" },
  { id: "K4", file: CARD, guard: "a stale quote request registers no listener once the order changed",
    from: "    if (!current()) return; // the order changed", to: "    // the order changed" },
];

function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", env: CHILD_ENV, maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+ failed/.test(out) || /Test Files\s+\d+ failed/.test(out)) {
      if (/SyntaxError|Failed to load|Cannot find module/.test(out) && !/Tests\s+\d+ failed/.test(out)) return "ERROR(load crash)";
      return "FAIL";
    }
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

// --only=F runs just the guards whose id starts with F (the whole list takes minutes).
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const results = [];
for (const m of MUTATIONS.filter((x) => !ONLY || x.id.startsWith(ONLY))) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, mutated: hits ? "ANCHOR-AMBIGUOUS" : "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR ${hits ? `FOUND ${hits}×` : "NOT FOUND"} in ${m.file}`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runVitest(TESTS);
    restore();
    restored = runVitest(TESTS);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

// A typo in --only would otherwise prove "0/0" and exit 0 (CodeRabbit, #984).
if (!results.length) { console.error(`no mutation id starts with --only=${ONLY}`); process.exit(1); }
const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}

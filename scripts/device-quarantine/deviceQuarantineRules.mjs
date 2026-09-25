// ─── DEVICE QUARANTINE, ENFORCED BY THE DATABASE — THE RULES PATCH ───────────
//
// database.rules.json in this repo is STALE and console-managed; it is never
// deployed. This takes a rules document and returns it with three additions,
// which print-device-quarantine-rules.mjs prints for Junid to paste and
// prove-device-quarantine-rules.mjs proves on the emulator first.
//
// WHY. On 25 Sep 2026 one phone falsely marked four Hub 2 orders Out of Stock
// (#197, #202, #204, #208). Junid can quarantine a phone from the Mirror Fleet
// screen (#640, /mirror_switch/quarantine/{deviceId}), but until now that only
// covered the phone's SCREEN with a message — the app on it decided whether to
// obey. A phone on its own login (Ayob's, here) is also outside the device
// enrolment gate (#647), which only covers MC's shared login.
//
// 1. orders/$id/stamps/$stamp and refill_requests/$refillId/stamps/$stamp gain
//    a ".validate" (STAMP_OK). Since #647 every order and request action
//    carries a NEW stamp { deviceId, personName, atMs, action } written in the
//    same update as the action itself (src/device/deviceStamp.js). The rule
//    refuses the whole write when that new stamp's deviceId — or the signed
//    deviceId claim of an enrolled session — is quarantined. So a quarantined
//    phone running this app (every build since #647 stamps every order and
//    request write) cannot reject, send, or otherwise change an order or a
//    request, even if its own quarantine check failed open.
//
//    WHAT IT DOES NOT COVER, honestly: a write with NO stamp (a build from
//    before #647 still cached on a phone, or a hand-made REST call) is judged
//    as before, and a browser whose storage was cleared mints a NEW device id
//    that is not on the list. Stock cells and movements carry no such rule:
//    "moves no stock" is the app-side check (src/device/deviceRejects.js),
//    which asks BEFORE any transfer — if that read fails open, the order
//    write is still refused here but the transfer before it has happened.
//
//    `data.exists() ||` first: a stamp that is ALREADY on the record passes
//    untouched. A transaction or set() rewrites the whole record, old stamps
//    included, and without this guard one old stamp from a phone that is now
//    quarantined would lock every other phone out of that order for good.
//
//    A write with no stamp, or a stamp with no deviceId (a browser with no
//    storage), is judged exactly as before. The rule can only ever REFUSE more.
//
// 2. A new /device_rejects node: the per-device reject log the app writes
//    (src/device/deviceRejects.js) and the Mirror Fleet screen counts. Read by
//    the owner only. Written once per entry by any signed-in staff session, as
//    ITSELF (uid === auth.uid), at the server's time (±10 min), under a day and
//    device key of the right shape. An entry can never be edited or deleted
//    from a client.
//
// Compose with the device enrolment patch AFTER this one:
//     patchDeviceEnrolmentRules(patchDeviceQuarantineRules(live).doc)
// so the enrolment condition is ANDed onto the new node's rules too. Pasting
// the two as separate whole documents would make the second paste erase the
// first. Idempotent: applying it to its own output changes nothing.

export const OWNER_EMAIL = "gunidmoh@gmail.com";

const Q = "root.child('mirror_switch').child('quarantine')";
// #640's verdict, in rules: `true`, or an object with on === true.
const flagged = (id) => `(${Q}.child(${id}).val() === true || ${Q}.child(${id}).child('on').val() === true)`;
const STAMP_ID = "newData.child('deviceId').val()";

export const STAMP_OK =
  `data.exists() || (` +
    `(!newData.child('deviceId').isString() || ${STAMP_ID} === '' || !${flagged(STAMP_ID)})` +
    ` && (auth == null || auth.token.deviceId == null || !${flagged("auth.token.deviceId")})` +
  `)`;

export const STAMPS_NODE = { $stamp: { ".validate": STAMP_OK } };

export const DEVICE_REJECTS_NODE = {
  ".read": `auth != null && auth.token.email === '${OWNER_EMAIL}'`,
  $day: {
    $deviceId: {
      $entry: {
        ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous' && !data.exists()",
        ".validate":
          "newData.hasChildren(['at', 'uid', 'kind'])" +
          " && newData.child('uid').val() === auth.uid" +
          " && newData.child('at').isNumber() && newData.child('at').val() >= now - 600000 && newData.child('at').val() <= now + 600000" +
          " && newData.child('kind').isString() && newData.child('kind').val().length <= 20" +
          " && $day.matches(/^20[0-9][0-9]-[01][0-9]-[0-3][0-9]$/)" +
          " && $deviceId.matches(/^[A-Za-z0-9_-]{8,64}$/)",
      },
    },
  },
};

// Where the stamps rule goes: top-level node → its record wildcard.
const STAMPED = [["orders", "$id"], ["refill_requests", "$refillId"]];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @returns {{ doc, added: string[] }} the patched document and every path added
 *          (empty when the document already carries all of it).
 */
export function patchDeviceQuarantineRules(input) {
  if (!input || typeof input !== "object" || !input.rules || typeof input.rules !== "object") {
    throw new Error("not a rules document (no top-level \"rules\")");
  }
  const doc = JSON.parse(JSON.stringify(input));
  const added = [];
  for (const [top, wild] of STAMPED) {
    const rec = doc.rules[top]?.[wild];
    if (!rec || typeof rec !== "object") {
      throw new Error(`/${top}/${wild} is not in this rules document — refusing to guess where the stamps rule goes`);
    }
    if (rec.stamps === undefined) {
      rec.stamps = JSON.parse(JSON.stringify(STAMPS_NODE));
      added.push(`/${top}/${wild}/stamps/$stamp`);
    } else if (!same(rec.stamps, STAMPS_NODE)) {
      throw new Error(`/${top}/${wild}/stamps already holds a different rule — refusing to guess`);
    }
  }
  const existing = doc.rules.device_rejects;
  if (existing === undefined) {
    doc.rules.device_rejects = JSON.parse(JSON.stringify(DEVICE_REJECTS_NODE));
    added.push("/device_rejects");
  } else if (!same(unwrapEnrolment(existing), DEVICE_REJECTS_NODE)) {
    throw new Error("the rules already hold a different /device_rejects node — refusing to guess");
  }
  return { doc, added };
}

// After the enrolment patch has run, the node's .read/.write carry its
// condition ANDed on; compare what is underneath.
function unwrapEnrolment(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === ".read" || k === ".write") && typeof v === "string") {
      const m = v.match(/^\((.*)\) && \(auth == null \|\| root\.child\('users'\)/s);
      out[k] = m ? m[1] : v;
    } else out[k] = typeof v === "object" ? unwrapEnrolment(v) : v;
  }
  return out;
}

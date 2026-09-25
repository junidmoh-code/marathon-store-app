// ─── DEVICE ENROLMENT — THE RULES PATCH, AS A PURE FUNCTION ──────────────────
//
// database.rules.json in this repo is STALE and console-managed; it is never
// deployed. This takes the LIVE rules document and returns it with two changes,
// which print-device-enrolment-rules.mjs prints for Junid to paste and
// prove-device-enrolment-rules.mjs proves on the emulator first:
//
// 1. EVERY ".write" in the document gains one more condition, DEVICE_OK:
//
//      the writer's login does not need a device code
//      OR this session's token names a device whose enrolment is still live
//
//    "Needs a code" is /users/{uid}/deviceCodeRequired === true (MC's login).
//    "Still live" is /users/{uid}/deviceGate/{auth.token.deviceId} ===
//    auth.token.eid — the entry enrolDevice writes and a revoke deletes. The
//    token claims come from the custom token enrolDevice signs, so no client
//    can make them up. For every other login (Mike, the POS tills, Junid, the
//    Admin SDK) the condition is true at its first test and changes nothing.
//
//    Why every write and not a list: the same login reaches ~120 write rules.
//    A list would be one forgotten path away from a former employee still
//    moving stock. ANDing a condition can only ever REFUSE more, never grant.
//    ".write": "false" is left as it is (it refuses everything already).
//
// 2. A new /device_enrolment node. It has no ".read" (so only the Admin SDK,
//    i.e. the admin callable, can list it). An enrolled device may write two
//    leaves of its OWN record: lastSeenAtMs (the server clock, give or take
//    five minutes) and rejectCount (only ever +1).
//
// Idempotent: applying it to its own output changes nothing.

export const OWNER_EMAIL = "gunidmoh@gmail.com";

const USER = "root.child('users').child(auth.uid)";
const LIVE_DEVICE = `auth.token.deviceId != null && auth.token.eid != null && ${USER}.child('deviceGate').child(auth.token.deviceId).val() === auth.token.eid`;

// The one condition. `auth == null ||` first so an unauthenticated write is
// judged by the original rule alone, never by an error in this one.
export const DEVICE_OK = `(auth == null || ${USER}.child('deviceCodeRequired').val() !== true || (${LIVE_DEVICE}))`;

// The device writing its own record, and only while its enrolment is live.
// newData.exists() because a delete never runs .validate — without it a device
// could wipe its own reject count.
const OWN_LIVE_DEVICE = `newData.exists() && auth != null && auth.token.deviceId === $deviceId && auth.token.eid != null && ${USER}.child('deviceGate').child($deviceId).val() === auth.token.eid`;

export const DEVICE_ENROLMENT_NODE = {
  devices: {
    $deviceId: {
      lastSeenAtMs: {
        ".write": OWN_LIVE_DEVICE,
        ".validate": "newData.isNumber() && newData.val() >= now - 300000 && newData.val() <= now + 300000",
      },
      rejectCount: {
        ".write": OWN_LIVE_DEVICE,
        ".validate": "newData.isNumber() && newData.val() === (data.exists() ? data.val() : 0) + 1",
      },
    },
  },
};

function wrap(expr) {
  if (expr === false || expr === "false") return expr;
  if (typeof expr === "string" && expr.includes(DEVICE_OK)) return expr;
  if (expr === true || expr === "true") return DEVICE_OK;
  if (typeof expr !== "string") throw new Error(`unexpected .write value: ${JSON.stringify(expr)}`);
  return `(${expr}) && ${DEVICE_OK}`;
}

function walk(node, path, out) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const next = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === ".write") {
      const w = wrap(v);
      if (w !== v) out.push(path || "/");
      next[k] = w;
    } else if (k.startsWith(".")) {
      next[k] = v;
    } else {
      next[k] = walk(v, `${path}/${k}`, out);
    }
  }
  return next;
}

/**
 * @returns {{ doc, wrapped: string[] }} the patched document and every path
 *          whose .write gained the condition.
 */
export function patchDeviceEnrolmentRules(live) {
  if (!live || typeof live !== "object" || !live.rules || typeof live.rules !== "object") {
    throw new Error("not a rules document (no top-level \"rules\")");
  }
  const existing = live.rules.device_enrolment;
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(DEVICE_ENROLMENT_NODE)) {
    throw new Error("the live rules already hold a different /device_enrolment node — refusing to guess");
  }
  const wrapped = [];
  const { device_enrolment: _skip, ...rest } = live.rules;
  const rules = walk(rest, "", wrapped);
  rules.device_enrolment = DEVICE_ENROLMENT_NODE;
  return { doc: { ...live, rules }, wrapped };
}

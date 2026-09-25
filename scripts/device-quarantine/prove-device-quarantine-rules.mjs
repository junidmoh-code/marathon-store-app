// ─── DEVICE QUARANTINE RULES, PROVEN ON THE RTDB EMULATOR ────────────────────
//
// Runs the real rules engine (the emulator jar the CLI ships) against the LIVE
// rules document with BOTH patches applied — device quarantine, then device
// enrolment (#647) — exactly the document print-device-quarantine-rules.mjs
// writes, and fails unless every case below holds. Identities are unsigned
// JWTs in ?auth= (the emulator's "you are this user"). Never an Authorization:
// Bearer header on an assertion: that is the ADMIN bypass and would pass every
// case while proving nothing — it is used only to seed.
//
// #647's own prover should ALSO pass on this document's quarantine half:
//   node scripts/device-quarantine/prove-device-quarantine-rules.mjs live.json --emit-intermediate q.json
//   node scripts/device-enrolment/prove-device-enrolment-rules.mjs q.json
//
// Run:  node scripts/device-quarantine/prove-device-quarantine-rules.mjs <live-rules.json>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchDeviceQuarantineRules, OWNER_EMAIL } from "./deviceQuarantineRules.mjs";
import { patchDeviceEnrolmentRules } from "../device-enrolment/deviceEnrolmentRules.mjs";

const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9593);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR ||
  join(process.env.HOME, ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || "/opt/homebrew/opt/openjdk/bin/java";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
const as_ = (uid, email, provider = "password", extra = {}) =>
  jwt({ iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, uid, email,
        auth_time: 1, iat: 1, exp: 9999999999, firebase: { sign_in_provider: provider, identities: {} }, ...extra });

const BAD = "2964c145-ecad-4f61-9f7a-304231af0e01";    // quarantined as { on: true }
const BAD2 = "0badbad0-0000-4000-8000-000000000002";    // quarantined as a bare `true`
const OFF = "0ff0ff00-0000-4000-8000-000000000003";     // was quarantined, released ({ on: false })
const GOOD = "600d600d-0000-4000-8000-000000000004";
const MC_DEV = "aaaaaaaa-1111-4111-8111-111111111111";

const AYOB = as_("ayob", "ayob@marathon.internal");                        // own login, not enrolled
const MIKE = as_("mike", "mike@marathon.internal");
const MC_ENROLLED_BAD = as_("mc", "mc@marathon.internal", "custom", { deviceId: BAD, eid: "e9", personName: "X" });
const MC_ENROLLED_OK = as_("mc", "mc@marathon.internal", "custom", { deviceId: MC_DEV, eid: "e1", personName: "Sipho" });
const OWNER = as_("owner", OWNER_EMAIL, "google.com");
const ANON = as_("anon", null, "anonymous");

const OWNER_HDR = { Authorization: "Bearer owner" };
const url = (path, auth) => `${HOST}/${path}.json?ns=${NS}${auth ? `&auth=${auth}` : ""}`;
const put = (p, v) => fetch(url(p), { method: "PUT", headers: OWNER_HDR, body: JSON.stringify(v) });
const read = async (p) => (await fetch(url(p), { headers: OWNER_HDR })).json();
async function as(auth, method, path, value) {
  const r = await fetch(url(path, auth), { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { ok: r.ok, status: r.status };
}
let passed = 0;
const failures = [];
async function allowed(label, p) {
  const r = await p;
  if (r.ok) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(`${label} — expected ALLOWED, got ${r.status}`); console.log(`  ✗ ${label} (${r.status})`); }
}
async function denied(label, p) {
  const r = await p;
  if (r.status === 401 || r.status === 403) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(`${label} — expected DENIED, got ${r.status}`); console.log(`  ✗ ${label} (got ${r.status})`); }
}
function check(label, ok) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(label); console.log(`  ✗ ${label}`); }
}

const [inFile, flag, emitFile] = process.argv.slice(2);
if (!inFile) { console.error("usage: prove-device-quarantine-rules.mjs <live-rules.json> [--emit-intermediate out.json]"); process.exit(2); }
const live = JSON.parse(readFileSync(inFile, "utf8"));
const { doc: quarantineOnly } = patchDeviceQuarantineRules(live);
if (flag === "--emit-intermediate" && emitFile) writeFileSync(emitFile, JSON.stringify(quarantineOnly, null, 2));
const { doc: candidate } = patchDeviceEnrolmentRules(quarantineOnly);

// Pure checks first: idempotent, and composing in either state gives one answer.
check("quarantine patch is idempotent", JSON.stringify(patchDeviceQuarantineRules(quarantineOnly).doc) === JSON.stringify(quarantineOnly));
check("quarantine patch over an already-combined document changes nothing",
  JSON.stringify(patchDeviceQuarantineRules(candidate).doc) === JSON.stringify(candidate));
check("…and with #647 pasted FIRST, the combined result is the same document",
  JSON.stringify(patchDeviceEnrolmentRules(patchDeviceQuarantineRules(patchDeviceEnrolmentRules(live).doc).doc).doc) === JSON.stringify(candidate));

const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
let emuLog = "";
emu.stdout.on("data", (d) => { emuLog += d; });
emu.stderr.on("data", (d) => { emuLog += d; });
const stop = () => { try { emu.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
for (let i = 0; ; i++) {
  try { const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { headers: OWNER_HDR }); if (r.ok) break; throw new Error(String(r.status)); }
  catch { if (i > 150) { console.error("emulator did not start:\n" + emuLog); process.exit(2); } await new Promise((r) => setTimeout(r, 200)); }
}
const loadRules = async (d) => {
  const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: OWNER_HDR, body: JSON.stringify(d) });
  if (!r.ok) { console.error(`could not load rules: ${r.status} ${await r.text()}`); stop(); process.exit(2); }
};

const stamp = (deviceId, action = "out_of_stock") => ({ deviceId, personName: null, atMs: Date.now(), action });
const k = (deviceId) => `${Date.now()}_${String(deviceId).slice(0, 8)}_${Math.random().toString(36).slice(2, 6)}`;
const oos = (deviceId) => ({ status: "out_of_stock", outOfStockAt: "2026-09-25T12:22:45.065Z", [`stamps/${k(deviceId)}`]: stamp(deviceId) });
const seed = async () => {
  await put("users/ayob", { username: "ayob", role: "warehouse", stockRole: "warehouse" });
  await put("users/mike", { username: "mike", stockRole: "admin" });
  await put("users/mc", { username: "mc", stockRole: "admin", deviceCodeRequired: true, deviceGate: { [BAD]: "e9", [MC_DEV]: "e1" } });
  await put("users/owner", { role: "admin" });
  await put("mirror_switch/quarantine", { [BAD]: { on: true, at: 1, by: OWNER_EMAIL }, [BAD2]: true, [OFF]: { on: false } });
  for (const id of ["197", "202", "204", "208", "300"]) {
    await put(`orders/${id}`, { id, status: "incoming", placedAtHub: "hub2", stamps: { "1_placed": stamp(GOOD, "placed") } });
  }
  // An order a now-quarantined phone touched EARLIER — its old stamp stays.
  await put("orders/400", { id: "400", status: "ready", stamps: { "1_oldbad": stamp(BAD, "ready") } });
  await put("refill_requests/r1", { status: "open", productId: "p1", size: "M" });
  await put("refill_requests/r2", { status: "open", productId: "p1", size: "L", stamps: { "1_oldbad": stamp(BAD, "send-part") } });
};

// ── PHASE 0: today's rules — the gap is real ─────────────────────────────────
await loadRules(live);
await seed();
console.log("── TODAY, on the live rules: a quarantined phone can still reject (these SHOULD succeed) ──");
await allowed("TODAY: the quarantined phone marks #197 Out of Stock", as(AYOB, "PATCH", "orders/197", oos(BAD)));
await denied("TODAY: /device_rejects does not exist yet (default deny)", as(AYOB, "POST", `device_rejects/2026-09-25/${GOOD}`, { at: Date.now(), uid: "ayob", kind: "order" }));

await loadRules(candidate);
{
  const c = await as(ANON, "GET", "shopify_sync/x");
  if (c.status !== 401 && c.status !== 403) { console.error(`CONTROL FAILED: /shopify_sync answered ${c.status}; rules not enforced`); stop(); process.exit(2); }
}
await seed();
console.log("\ncandidate loaded (quarantine + enrolment)\n");

console.log("── a QUARANTINED phone cannot reject or send ──");
await denied("quarantined ({on:true}) — order Out of Stock", as(AYOB, "PATCH", "orders/197", oos(BAD)));
await denied("quarantined (bare true) — order Out of Stock", as(AYOB, "PATCH", "orders/202", oos(BAD2)));
await denied("quarantined — order Ready (fulfil)", as(AYOB, "PATCH", "orders/204", { status: "ready", [`stamps/${k(BAD)}`]: stamp(BAD, "ready") }));
await denied("quarantined — clothing Reject", as(AYOB, "PATCH", "orders/208", { clothingRefillStatus: "rejected", [`stamps/${k(BAD)}`]: stamp(BAD, "clothingRefillStatus") }));
await denied("quarantined — refill request Out of Stock (transaction writes the whole record)",
  as(MIKE, "PUT", "refill_requests/r1", { status: "cancelled", productId: "p1", size: "M", stamps: { [k(BAD)]: stamp(BAD, "reject") } }));
await denied("quarantined — refill request Send (multi-path root update)",
  as(MIKE, "PATCH", "", { "refill_requests/r1/status": "fulfilled", [`refill_requests/r1/stamps/${k(BAD)}`]: stamp(BAD, "fulfil") }));
await denied("quarantined — the whole multi-path update fails, not just the stamp",
  as(MIKE, "PATCH", "", { "orders/300/status": "ready", [`orders/300/stamps/${k(BAD)}`]: stamp(BAD, "ready") }));
check("…and #300's status did not change", (await read("orders/300/status")) === "incoming");
await denied("enrolled session whose SIGNED deviceId is quarantined, stamp claims another phone",
  as(MC_ENROLLED_BAD, "PATCH", "orders/300", { status: "out_of_stock", [`stamps/${k(GOOD)}`]: stamp(GOOD) }));
await denied("quarantined — placing a new order (set() of a new record)",
  as(AYOB, "PUT", "orders/500", { id: "500", status: "incoming", stamps: { [k(BAD)]: stamp(BAD, "placed") } }));

console.log("\n── every other phone works as before ──");
await allowed("healthy phone — order Out of Stock", as(AYOB, "PATCH", "orders/197", oos(GOOD)));
await allowed("healthy phone — order Ready", as(MIKE, "PATCH", "orders/204", { status: "ready", [`stamps/${k(GOOD)}`]: stamp(GOOD, "ready") }));
await allowed("released phone ({on:false}) — order Out of Stock", as(AYOB, "PATCH", "orders/202", oos(OFF)));
await allowed("a write with no stamp at all (old build)", as(AYOB, "PATCH", "orders/208", { status: "ready" }));
await allowed("a stamp with no deviceId (browser without storage)", as(AYOB, "PATCH", "orders/300", { status: "ready", [`stamps/${k("x")}`]: { deviceId: null, atMs: Date.now(), action: "ready" } }));
await allowed("a stamp with an empty deviceId", as(AYOB, "PATCH", "orders/300", { status: "incoming", [`stamps/${k("y")}`]: { deviceId: "", atMs: Date.now(), action: "incoming" } }));
await allowed("an enrolled, non-quarantined MC phone", as(MC_ENROLLED_OK, "PATCH", "orders/300", { status: "ready", [`stamps/${k(MC_DEV)}`]: stamp(MC_DEV, "ready") }));
await allowed("healthy phone rewrites an order that CARRIES an old quarantined stamp (whole record)",
  as(AYOB, "PUT", "orders/400", { id: "400", status: "collected", stamps: { "1_oldbad": stamp(BAD, "ready"), [k(GOOD)]: stamp(GOOD, "collected") } }));
await allowed("healthy phone's transaction on a request carrying an old quarantined stamp",
  as(MIKE, "PUT", "refill_requests/r2", { status: "cancelled", productId: "p1", size: "L", stamps: { "1_oldbad": stamp(BAD, "send-part"), [k(GOOD)]: stamp(GOOD, "reject") } }));
await allowed("the owner releases the phone", as(OWNER, "PUT", `mirror_switch/quarantine/${BAD}`, null));
await allowed("…and the same phone may reject again at once", as(AYOB, "PATCH", "orders/208", oos(BAD)));
await put(`mirror_switch/quarantine/${BAD}`, { on: true, at: 2, by: OWNER_EMAIL });
await denied("a staff account cannot release a quarantine itself", as(AYOB, "PUT", `mirror_switch/quarantine/${BAD}`, null));
await denied("anonymous is still refused an order write", as(ANON, "PATCH", "orders/300", { status: "ready" }));

console.log("\n── the per-device reject log ──");
const day = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
const entry = (uid, extra = {}) => ({ at: Date.now(), uid, kind: "order", ref: "197", hub: "hub2", pid: "p1", size: "6", ...extra });
await allowed("staff logs its own reject", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("ayob")));
await allowed("server-time stamp", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("ayob", { at: { ".sv": "timestamp" } })));
await denied("logged as SOMEONE ELSE's account", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("mike")));
await allowed("a reject pressed offline, flushed 3 hours later", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("ayob", { at: Date.now() - 3 * 3600e3 })));
await denied("a time two days old", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("ayob", { at: Date.now() - 2 * 864e5 })));
await denied("a time an hour in the future", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, entry("ayob", { at: Date.now() + 3600e3 })));
await allowed("an enrolled phone logs under its OWN signed device id", as(MC_ENROLLED_OK, "POST", `device_rejects/${day}/${MC_DEV}`, entry("mc")));
await denied("an enrolled phone logs under ANOTHER phone's id", as(MC_ENROLLED_OK, "POST", `device_rejects/${day}/${GOOD}`, entry("mc")));
await denied("a malformed day key", as(AYOB, "POST", `device_rejects/yesterday/${GOOD}`, entry("ayob")));
await denied("a malformed device key", as(AYOB, "POST", `device_rejects/${day}/short`, entry("ayob")));
await denied("an entry without a kind", as(AYOB, "POST", `device_rejects/${day}/${GOOD}`, { at: Date.now(), uid: "ayob" }));
await put(`device_rejects/${day}/${GOOD}/fixed`, entry("ayob"));
await denied("editing an entry", as(AYOB, "PUT", `device_rejects/${day}/${GOOD}/fixed`, entry("ayob", { kind: "clothing" })));
await denied("deleting an entry", as(AYOB, "DELETE", `device_rejects/${day}/${GOOD}/fixed`));
await denied("deleting a whole day", as(AYOB, "DELETE", `device_rejects/${day}`));
await denied("anonymous", as(ANON, "POST", `device_rejects/${day}/${GOOD}`, entry("anon")));
await denied("staff reading the log", as(AYOB, "GET", "device_rejects"));
await allowed("the owner reads the log", as(OWNER, "GET", "device_rejects"));
await allowed("the owner reads a key range (the Mirror Fleet query)",
  fetch(`${HOST}/device_rejects.json?ns=${NS}&auth=${OWNER}&orderBy=%22$key%22&startAt=%222026-09-19%22`).then((r) => ({ ok: r.ok, status: r.status })));

stop();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log("PROVEN — the candidate rules may be pasted.");

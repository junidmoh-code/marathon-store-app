// ─── DEVICE ENROLMENT RULES, PROVEN ON THE RTDB EMULATOR ─────────────────────
//
// Runs the real rules engine (the emulator jar the CLI ships) against the LIVE
// rules document with patchDeviceEnrolmentRules applied, and fails unless every
// case below holds. The identities are unsigned JWTs in ?auth= — the emulator's
// "you are this user" — carrying exactly the claims a real session has: MC on a
// password session has no device claims; MC after enrolDevice signs in with a
// custom token (sign_in_provider "custom") carrying deviceId + eid.
// Never an Authorization: Bearer header on an assertion: that is the emulator's
// ADMIN bypass and would pass every case while proving nothing.
//
// Run:  node scripts/device-enrolment/prove-device-enrolment-rules.mjs <live-rules.json>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchDeviceEnrolmentRules, OWNER_EMAIL } from "./deviceEnrolmentRules.mjs";

const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9592);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR ||
  join(process.env.HOME, ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || "/opt/homebrew/opt/openjdk/bin/java";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
const as_ = (uid, email, provider = "password", extra = {}) =>
  jwt({ iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, uid, email,
        auth_time: 1, iat: 1, exp: 9999999999, firebase: { sign_in_provider: provider, identities: {} }, ...extra });

const DEV_A = "aaaaaaaa-1111-4111-8111-111111111111";
const DEV_B = "bbbbbbbb-2222-4222-8222-222222222222";
const MC_PW = as_("mc", "mc@marathon.internal");                                   // any phone that knows the PIN
const MC_DEV = as_("mc", "mc@marathon.internal", "custom", { deviceId: DEV_A, eid: "e1", personName: "Sipho" });
const MC_REVOKED = as_("mc", "mc@marathon.internal", "custom", { deviceId: DEV_B, eid: "e2", personName: "Gone" });
const MC_OLD_EID = as_("mc", "mc@marathon.internal", "custom", { deviceId: DEV_A, eid: "e0", personName: "Sipho" });
const MIKE = as_("mike", "mike@marathon.internal");
const TILL = as_("till", "pe@marathon.internal");
const OWNER = as_("owner", OWNER_EMAIL, "google.com");
const ANON = as_("anon", null, "anonymous");

const OWNER_HDR = { Authorization: "Bearer owner" };
const url = (path, auth) => `${HOST}/${path}.json?ns=${NS}${auth ? `&auth=${auth}` : ""}`;
const put = (p, v) => fetch(url(p), { method: "PUT", headers: OWNER_HDR, body: JSON.stringify(v) });
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

const inFile = process.argv[2];
if (!inFile) { console.error("usage: prove-device-enrolment-rules.mjs <live-rules.json>"); process.exit(2); }
const live = JSON.parse(readFileSync(inFile, "utf8"));
const { doc: candidate, wrapped, readsWrapped } = patchDeviceEnrolmentRules(live);

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

const seed = async () => {
  await put("users/mc", { username: "mc", stockRole: "admin", deviceCodeRequired: true, deviceGate: { [DEV_A]: "e1" } });
  await put("users/mike", { username: "mike", stockRole: "admin" });
  await put("users/till", { stockRole: "pos" });
  await put("users/owner", { role: "admin" });
  await put("products/p1", { id: "p1", name: "Test Tee" });
  await put("locations/hub2", { name: "Hub 2" });
  await put("refill_requests/r1", { status: "open", productId: "p1" });
};
const mv = (actor, id) => ["stock_movements/" + id, { type: "adjustment", productId: "p1", size: "M", qty: 1, actor, ts: "2026-09-25T10:00:00.000Z", reason: "recount", from: "hub2" }];
const cell = { qty: 3, v: 0, mv: "m1", lastType: "adjustment" };

// ── PHASE 0: today's rules — the gap is real ─────────────────────────────────
await loadRules(live);
await seed();
console.log("── TODAY, on the live rules: any phone with MC's PIN can write (these SHOULD succeed) ──");
await allowed("TODAY: MC on a password session writes an order", as(MC_PW, "PUT", "orders/o0", { status: "ready", destShop: "trophy" }));
await allowed("TODAY: MC on a password session writes a stock movement", as(MC_PW, "PUT", ...mv("mc", "mv0")));

await loadRules(candidate);
{
  const c = await as(MC_PW, "GET", "shopify_sync/x");
  if (c.status !== 401 && c.status !== 403) { console.error(`CONTROL FAILED: /shopify_sync answered ${c.status}; rules not enforced`); stop(); process.exit(2); }
}
await seed();
console.log(`\ncandidate loaded (${wrapped.length} write and ${readsWrapped.length} read rules carry the device condition)\n`);

console.log("── an UNENROLLED phone on MC's login is refused everywhere ──");
await denied("password session: order write", as(MC_PW, "PUT", "orders/o1", { status: "ready", destShop: "trophy" }));
await denied("password session: order status patch", as(MC_PW, "PATCH", "orders/o0", { status: "collected" }));
await denied("password session: stock movement", as(MC_PW, "PUT", ...mv("mc", "mv1")));
await denied("password session: stock cell", as(MC_PW, "PUT", "stock/hub2/p1/M", cell));
await denied("password session: refill request refusal", as(MC_PW, "PATCH", "refill_requests/r1", { status: "cancelled" }));
await denied("password session: transfer", as(MC_PW, "PUT", "transfers/t1", { status: "dispatched", from: "hub2", to: "hub2" }));
await denied("password session: multi-path root update", as(MC_PW, "PATCH", "", { "orders/o2/status": "ready", "refill_requests/r1/status": "open" }));
await denied("password session: device telemetry", as(MC_PW, "PUT", `mirror_devices/${DEV_B}`, { deviceId: DEV_B }));

console.log("\n── …and cannot READ anything but the code screen needs ──");
await put("mirror_switch/enabled", true);
await denied("password session: read orders", as(MC_PW, "GET", "orders/o0"));
await denied("password session: read a product", as(MC_PW, "GET", "products/p1"));
await denied("password session: read stock", as(MC_PW, "GET", "stock/hub2"));
await denied("password session: read refill requests", as(MC_PW, "GET", "refill_requests/r1"));
await allowed("password session: read its own /users record (the code screen needs it)", as(MC_PW, "GET", "users/mc"));
await allowed("password session: read /mirror_switch (quarantine, mirror switch)", as(MC_PW, "GET", "mirror_switch/enabled"));

console.log("\n── an ENROLLED phone on MC's login works as before ──");
await allowed("enrolled: read orders", as(MC_DEV, "GET", "orders/o0"));
await allowed("enrolled: read a product", as(MC_DEV, "GET", "products/p1"));
await allowed("enrolled: order write", as(MC_DEV, "PUT", "orders/o3", { status: "ready", destShop: "trophy" }));
await allowed("enrolled: stock movement", as(MC_DEV, "PUT", ...mv("mc", "mv3")));
await allowed("enrolled: stock cell", as(MC_DEV, "PUT", "stock/hub2/p1/M", cell));
await allowed("enrolled: refill request", as(MC_DEV, "PATCH", "refill_requests/r1", { status: "cancelled" }));
await allowed("enrolled: multi-path root update", as(MC_DEV, "PATCH", "", { "orders/o3/status": "collected", "refill_requests/r1/status": "open" }));
await allowed("enrolled: own device telemetry", as(MC_DEV, "PUT", `mirror_devices/${DEV_A}`, { deviceId: DEV_A }));
await allowed("enrolled: last seen (server clock)", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/lastSeenAtMs`, { ".sv": "timestamp" }));
await allowed("enrolled: last seen (a client time within 5 minutes)", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/lastSeenAtMs`, Date.now() - 60e3));
await allowed("enrolled: reject count 0 → 1", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/rejectCount`, 1));
await allowed("enrolled: reject count 1 → 2 (server increment)", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/rejectCount`, { ".sv": { increment: 1 } }));

console.log("\n── a device record cannot be forged or tampered with ──");
await denied("last seen from yesterday", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/lastSeenAtMs`, Date.now() - 86400e3));
await denied("reject count jumps by 2", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/rejectCount`, 4));
await denied("reject count reset", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/rejectCount`, null));
await denied("another device's last seen", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_B}/lastSeenAtMs`, Date.now()));
await denied("a device record's status", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/status`, "active"));
await denied("reading the enrolment records", as(MC_DEV, "GET", "device_enrolment"));
await denied("reading the codes", as(MC_DEV, "GET", "device_enrolment/codes"));
await denied("an enrolled device adds itself a gate entry", as(MC_DEV, "PUT", `users/mc/deviceGate/${DEV_B}`, "e2"));
await denied("an enrolled device switches the code off", as(MC_DEV, "PUT", "users/mc/deviceCodeRequired", false));
await denied("password session: last seen", as(MC_PW, "PUT", `device_enrolment/devices/${DEV_A}/lastSeenAtMs`, Date.now()));

console.log("\n── revoked, stale or mismatched enrolments are refused ──");
await denied("a device with no gate entry (revoked)", as(MC_REVOKED, "PUT", "orders/o4", { status: "ready", destShop: "trophy" }));
await denied("an old enrolment id on a re-enrolled device", as(MC_OLD_EID, "PUT", "orders/o4", { status: "ready", destShop: "trophy" }));
await put(`users/mc/deviceGate/${DEV_A}`, null);                  // Junid revokes Sipho's phone
await denied("the SAME session, the moment it is revoked (no reload)", as(MC_DEV, "PUT", "orders/o5", { status: "ready", destShop: "trophy" }));
await denied("…and its last-seen write", as(MC_DEV, "PUT", `device_enrolment/devices/${DEV_A}/lastSeenAtMs`, Date.now()));
await denied("…and its reads", as(MC_DEV, "GET", "orders/o0"));
await put(`users/mc/deviceGate/${DEV_A}`, "e1");

console.log("\n── every other login is untouched ──");
await allowed("Mike (own login) writes an order", as(MIKE, "PUT", "orders/o6", { status: "ready", destShop: "trophy" }));
await allowed("Mike writes a stock movement", as(MIKE, "PUT", ...mv("mike", "mv6")));
await allowed("a POS till writes an order", as(TILL, "PUT", "orders/o7", { status: "ready", destShop: "pe" }));
await allowed("Mike reads orders", as(MIKE, "GET", "orders/o6"));
await allowed("a POS till reads a product", as(TILL, "GET", "products/p1"));
await allowed("the owner writes /users", as(OWNER, "PUT", "users/mc/deviceCodeRequired", true));
await allowed("the owner writes an order", as(OWNER, "PUT", "orders/o8", { status: "ready", destShop: "pe" }));
await denied("anonymous is still refused an order write", as(ANON, "PUT", "orders/o9", { status: "ready" }));

console.log("\n── switched off, MC's login behaves exactly as today ──");
await put("users/mc/deviceCodeRequired", null);
await allowed("password session writes again once the flag is removed", as(MC_PW, "PUT", "orders/o10", { status: "ready", destShop: "trophy" }));
await allowed("…and reads again", as(MC_PW, "GET", "orders/o10"));

stop();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log("PROVEN — the candidate rules may be pasted.");

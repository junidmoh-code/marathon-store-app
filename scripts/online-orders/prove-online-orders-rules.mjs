// ─── ONLINE-ORDER RULES, PROVEN ON THE RTDB EMULATOR ─────────────────────────
// The real rules engine (the emulator jar the CLI ships) runs the rules
// document with patchOnlineOrdersRules applied, and every client read and
// write the feature makes is asserted — allowed for the person it is for,
// denied for everyone else. Identities are unsigned JWTs in ?auth= (the
// emulator's "you are this user"); the Bearer header is the ADMIN bypass and
// seeds only — the Mac mini poller and the callables write as admin.
//
// Run:  node scripts/online-orders/prove-online-orders-rules.mjs [rules.json]
//       (default: database.rules.json — check it against the live rules first)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchOnlineOrdersRules, OWNER_EMAIL } from "./onlineOrdersRules.mjs";

const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9594);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR || join(process.env.HOME, ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || "/opt/homebrew/opt/openjdk/bin/java";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
const who = (uid, email, provider = "password", extra = {}) =>
  jwt({ iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, uid, email,
        auth_time: 1, iat: 1, exp: 9999999999, firebase: { sign_in_provider: provider, identities: {} }, ...extra });

const OWNER = who("owner", OWNER_EMAIL, "google.com", { email_verified: true });
const FAKE_OWNER = who("faker", OWNER_EMAIL, "password", { email_verified: false });
const PACKER = who("yasmin", "yasmin@marathon.internal");
const STAFF = who("hubstaff", "hub@marathon.internal");
const CASHIER = who("cashier", "till@marathon.internal");
const ANON = who("anon", null, "anonymous");

const ADMIN = { Authorization: "Bearer owner" };
const url = (path, auth, q = "") => `${HOST}/${path}.json?ns=${NS}${auth ? `&auth=${auth}` : ""}${q}`;
const put = (p, v) => fetch(url(p), { method: "PUT", headers: ADMIN, body: JSON.stringify(v) });
const read = async (p) => (await fetch(url(p), { headers: ADMIN })).json();
async function as(auth, method, path, value, q = "") {
  const r = await fetch(url(path, auth, q), { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { ok: r.ok, status: r.status };
}
let passed = 0;
const failures = [];
async function allowed(label, p) { const r = await p; if (r.ok) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(`${label} — expected ALLOWED, got ${r.status}`); console.log(`  ✗ ${label} (${r.status})`); } }
async function denied(label, p) { const r = await p; if (r.status === 401 || r.status === 403) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(`${label} — expected DENIED, got ${r.status}`); console.log(`  ✗ ${label} (got ${r.status})`); } }
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failures.push(label); console.log(`  ✗ ${label}`); } }

const base = JSON.parse(readFileSync(process.argv[2] || new URL("../../database.rules.json", import.meta.url), "utf8"));
const candidate = patchOnlineOrdersRules(base);
check("patch is idempotent", JSON.stringify(patchOnlineOrdersRules(candidate)) === JSON.stringify(candidate));
check("the existing config children are kept", Object.keys(base.rules.config || {}).every((k) => k in candidate.rules.config));

const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
let emuLog = "";
emu.stdout.on("data", (d) => { emuLog += d; });
emu.stderr.on("data", (d) => { emuLog += d; });
const stop = () => { try { emu.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stop);
for (let i = 0; ; i++) {
  try { const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { headers: ADMIN }); if (r.ok) break; throw new Error(String(r.status)); }
  catch { if (i > 150) { console.error("emulator did not start:\n" + emuLog); process.exit(2); } await new Promise((r) => setTimeout(r, 200)); }
}
{
  const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(candidate) });
  if (!r.ok) { console.error(`could not load rules: ${r.status} ${await r.text()}`); stop(); process.exit(2); }
}

const NOW = 1792570000000;
const order = (over = {}) => ({
  ref: "WEB-1801", status: "picking", customer: { name: "Thandi", phone: "082" },
  lines: [
    { lineId: "l0", pid: "P", size: "8", sizeKey: "8", qty: 1, source: { locationId: "hub1", status: "pick", entryKey: "online_picks/9001_0" } },
    { lineId: "l1", pid: "T", size: "M", sizeKey: "M", qty: 1, source: { locationId: "marathon-pe", status: "display", entryKey: "displayChecks_active/marathon-pe/online__9001__1" } },
  ],
  ...over,
});
const seed = async () => {
  await put("users/owner", { role: "admin", stockRole: "admin" });
  await put("users/yasmin", { stockRole: "pos", permissions: ["online_orders"], permFlags: { online_orders: true } });
  await put("users/hubstaff", { stockRole: "warehouse" });
  await put("users/cashier", { stockRole: "pos" });
  await put("online_orders/9001", order());
  await put("online_orders/9002", order({ status: "packed" }));
  await put("online_reservations/P/8", { 9001: { qty: 1, ref: "WEB-1801", locs: { hub1: 1 } } });
  await put("online_reservations/T/M", { 9001: { qty: 1, ref: "WEB-1801", locs: { "marathon-pe": 1 } } });
  await put("online_picks/9001_0", { kind: "online_pick", orderId: "9001", lineIndex: 0, locationId: "hub1", locStatus: "hub1|open", status: "open" });
  await put("online_picks/9001_9", { kind: "online_pick", orderId: "9001", lineIndex: 0, locationId: "hub1", locStatus: "hub1|cancelled", status: "cancelled" });
  await put("config/onlineOrders", { enabled: false });
};
await seed();
{
  const c = await as(ANON, "GET", "online_orders");
  if (c.status !== 401 && c.status !== 403) { console.error(`CONTROL FAILED: anonymous read answered ${c.status}; rules not enforced`); stop(); process.exit(2); }
}

console.log("── reads ──");
await allowed("packer lists open orders (indexed status query)", as(PACKER, "GET", "online_orders", undefined, `&orderBy="status"&equalTo="picking"`));
await allowed("Junid lists Needs Attention (indexed attentionOpen query)", as(OWNER, "GET", "online_orders", undefined, `&orderBy="attentionOpen"&equalTo=true`));
await denied("hub staff cannot read orders (customer details)", as(STAFF, "GET", "online_orders/9001"));
await denied("a cashier cannot list orders", as(CASHIER, "GET", "online_orders", undefined, `&orderBy="status"&equalTo="picking"`));
await denied("an unverified claim of Junid's email cannot read orders", as(FAKE_OWNER, "GET", "online_orders/9001"));
await allowed("a cashier reads ONE order's lines (the walk-in override)", as(CASHIER, "GET", "online_orders/9001/lines"));
await allowed("a cashier reads one reservation cell (the walk-in guard)", as(CASHIER, "GET", "online_reservations/P/8"));
await denied("…but never a product's whole reservation node", as(CASHIER, "GET", "online_reservations/P"));
await denied("…nor all reservations", as(CASHIER, "GET", "online_reservations"));
await allowed("hub staff list their open picks (indexed locStatus query)", as(STAFF, "GET", "online_picks", undefined, `&orderBy="locStatus"&equalTo="hub1|open"`));
await allowed("anyone signed in reads the switch", as(CASHIER, "GET", "config/onlineOrders/enabled"));
await denied("anonymous reads nothing", as(ANON, "GET", "online_reservations/P/8"));

console.log("\n── hub: Handed over ──");
await allowed("one update flips the pick and the order line to handed", as(STAFF, "PATCH", "", {
  "online_picks/9001_0/status": "handed", "online_picks/9001_0/locStatus": "hub1|handed",
  "online_picks/9001_0/handedAt": NOW, "online_picks/9001_0/handedBy": "hubstaff",
  "online_orders/9001/lines/0/source/status": "handed", "online_orders/9001/lines/0/source/handedAt": NOW, "online_orders/9001/lines/0/source/handedBy": "hubstaff",
}));
check("…and both landed", (await read("online_picks/9001_0/status")) === "handed" && (await read("online_orders/9001/lines/0/source/status")) === "handed");
await denied("a cancelled pick cannot be handed over", as(STAFF, "PATCH", "", { "online_picks/9001_9/status": "handed", "online_picks/9001_9/locStatus": "hub1|handed" }));
await denied("a handed pick cannot be reopened", as(STAFF, "PATCH", "online_picks/9001_0", { status: "open" }));

// ── Escalation (docs/ONLINE-ORDERS.md § Escalation) ──
await put("online_escalations/9001_0", { orderId: "9001", lineIndex: 0, phase: "await" });
await allowed("Junid reads the escalations list", as(OWNER, "GET", "online_escalations"));
await denied("hub staff cannot read the escalations list", as(STAFF, "GET", "online_escalations"));
await denied("nobody but the server writes the escalations list", as(OWNER, "PUT", "online_escalations/9001_0/phase", "done"));
await allowed("Junid sets a line's escalation override", as(OWNER, "PUT", "online_orders/9001/lines/0/escalationOverride", { kind: "unavailable", by: "owner", at: NOW }));
await denied("hub staff cannot set an escalation override", as(STAFF, "PUT", "online_orders/9001/lines/0/escalationOverride", { kind: "unavailable", by: "hubstaff", at: NOW }));
await put("online_orders/9012", { ref: "ZZZ", status: "closed", lines: [{ lineId: "l0", pid: "P", qty: 1, source: { status: "resolved" } }] });
await denied("a closed order cannot be put back to needs_attention by staff", as(STAFF, "PUT", "online_orders/9012/status", "needs_attention"));
await denied("handedBy must be the person tapping", as(STAFF, "PATCH", "online_orders/9001/lines/1/source", { status: "handed", handedBy: "someoneelse" }));
await denied("staff cannot mark a line packed", as(STAFF, "PATCH", "online_orders/9001/lines/1/source", { status: "packed" }));
await denied("staff cannot move a line elsewhere", as(STAFF, "PATCH", "online_orders/9001/lines/1/source", { locationId: "trophy" }));
await denied("staff cannot write a pick's location", as(STAFF, "PATCH", "online_picks/9001_0", { locationId: "hub2" }));

console.log("\n── till: walk-in override (manager PIN) ──");
await allowed("the override, the line, the attention and the status in one update", as(CASHIER, "PATCH", "", {
  "online_orders/9001/overrides/o1": { by: "mgr", byName: "Manager", at: NOW, storeId: "pe", tillId: "t1", cashierUid: "cashier", productId: "T", size: "M", loc: "marathon-pe" },
  "online_orders/9001/lines/1/source/status": "needs_attention",
  "online_orders/9001/attention": { kind: "walkin_override", reason: "Walk-in sale…", at: NOW },
  "online_orders/9001/attentionOpen": true,
  "online_orders/9001/status": "needs_attention",
}));
await denied("an override row cannot be rewritten", as(CASHIER, "PUT", "online_orders/9001/overrides/o1", { by: "x", at: 1, productId: "T", loc: "x" }));
await denied("an override row must say who, when, what, where", as(CASHIER, "PUT", "online_orders/9001/overrides/o2", { by: "mgr" }));
await denied("a cashier cannot set any other status", as(CASHIER, "PUT", "online_orders/9001/status", "packed"));
await denied("…nor raise any other kind of attention", as(CASHIER, "PUT", "online_orders/9001/attention", { kind: "no_stock", reason: "x", at: NOW }));
await denied("…nor clear an attention", as(CASHIER, "PUT", "online_orders/9001/attentionOpen", null));
await denied("…nor flag an order already packed", as(CASHIER, "PUT", "online_orders/9002/status", "needs_attention"));
await denied("…nor release a hold", as(CASHIER, "PUT", "online_reservations/P/8/9001", null));
await denied("…nor touch the basket", as(CASHIER, "PUT", "online_orders/9001/basket/0", true));

console.log("\n── POS: basket, pack, retry ──");
await allowed("the packer ticks a line into the basket", as(PACKER, "PUT", "online_orders/9001/basket/0", true));
await allowed("…and takes it out again", as(PACKER, "PUT", "online_orders/9001/basket/0", null));
await allowed("the pack claim (transaction write)", as(PACKER, "PUT", "online_orders/9001/packClaim", { saleId: "S1", by: "yasmin", at: NOW }));
await allowed("the pack: holds released, packed, fulfil pending — one update", as(PACKER, "PATCH", "", {
  "online_reservations/P/8/9001": null, "online_reservations/T/M/9001": null,
  "online_orders/9001/status": "packed", "online_orders/9001/pack": { saleId: "S1", receiptNumber: "S-P00001", by: "yasmin", at: NOW },
  "online_orders/9001/fulfilState": "pending", "online_orders/9001/fulfil": { state: "pending", attempts: 0, requestedAt: NOW },
}));
check("…and the holds are gone", (await read("online_reservations/P/8")) === null && (await read("online_reservations/T/M")) === null);
await denied("the packer can only ever RELEASE a hold, never write one", as(PACKER, "PUT", "online_reservations/P/8/9001", { qty: 5, ref: "WEB-1801" }));
await allowed("Retry puts a failed fulfilment back to pending", as(PACKER, "PATCH", "online_orders/9001", { fulfilState: "pending", "fulfil/state": "pending" }));
await denied("a cashier without the permission cannot pack", as(CASHIER, "PATCH", "", { "online_orders/9001/status": "packed" }));

console.log("\n── a pack can never land on a closed order (reviewer finding) ──");
await put("online_orders/9003", order({ status: "cancelled" }));
await put("online_orders/9004", order({ status: "release_requested" }));
await put("online_orders/9005", order({ status: "fulfilled_elsewhere" }));
for (const id of ["9003", "9004", "9005"]) {
  await denied(`the whole pack update is refused on a ${(await read(`online_orders/${id}/status`))} order`, as(PACKER, "PATCH", "", {
    [`online_orders/${id}/status`]: "packed", [`online_orders/${id}/pack`]: { saleId: "S9", by: "yasmin", at: NOW },
  }));
}
await denied("…nor can Junid's own client reopen a packed order", as(OWNER, "PUT", "online_orders/9002/status", "new"));
await allowed("…but rewriting the same status is harmless", as(PACKER, "PUT", "online_orders/9002/status", "packed"));

console.log("\n── Settings → Online orders (Junid) ──");
await allowed("Junid turns the staff switch on", as(OWNER, "PUT", "config/onlineOrders", { enabled: true, updatedAt: NOW, updatedBy: "owner" }));
await denied("nobody else can", as(PACKER, "PUT", "config/onlineOrders/enabled", false));
await denied("…not even an unverified claim of his email", as(FAKE_OWNER, "PUT", "config/onlineOrders/enabled", false));
await put("online_orders/9007", order({ status: "needs_attention", attentionOpen: true, attention: { kind: "no_stock", reason: "x", at: 1 } }));
await allowed("Resolve: lines back to reroute, attention cleared, status new", as(OWNER, "PATCH", "online_orders/9007", {
  "lines/1/source/status": "reroute", attention: null, attentionOpen: null, status: "new",
}));
await put("online_orders/9006", order({ status: "picking" }));
await allowed("Rung by hand at a till: an open order → release_requested", as(OWNER, "PUT", "online_orders/9006/status", "release_requested"));
await denied("staff cannot Resolve", as(STAFF, "PATCH", "online_orders/9007", { attention: null, attentionOpen: null, status: "new" }));
check("the existing config children still have their own rules", JSON.stringify(candidate.rules.config.transit) === JSON.stringify(base.rules.config.transit));

stop();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }

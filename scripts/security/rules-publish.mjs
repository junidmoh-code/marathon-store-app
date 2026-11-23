// ─── PUBLISH A RULES PATCH THE SAFE WAY (live → backup → test db → live) ─────
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/security/rules-publish.mjs <patch> [--dry-run]
//
//   <patch>  user-record   scripts/security/rulesRequireUserRecord.mjs
//            money         scripts/security/rulesMoneyPaths.mjs
//
// 1. Pull the LIVE rules of marathon-club-default-rtdb, save a dated backup
//    (~/marathon-rollbacks/rules-<db>-<stamp>.json).
// 2. Apply the patch in memory. No change → stop.
// 3. Prove it on marathon-club-rulestest with REAL tokens (stranger account,
//    anonymous session, a real cashier, a real owner) — then put the test
//    database's own rules back.
// 4. Health check LIVE as staff / till / TV / owner / poller — must pass.
// 5. Publish to LIVE. Re-run the health check and the stranger check. Any
//    failure → the backup is restored automatically and re-checked.
//
// Every write names the database it goes to. Reads are bounded
// (limitToFirst=1); no token, uid or row content is printed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo"; // public web key
const LIVE = { name: "marathon-club-default-rtdb", url: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" };
const TEST = { name: "marathon-club-rulestest", url: "https://marathon-club-rulestest.europe-west1.firebasedatabase.app" };
const IDT = "https://identitytoolkit.googleapis.com/v1";
const OWNER_EMAILS = ["gunidmoh@gmail.com"];
const [, , patchName, ...rest] = process.argv;
const DRY = rest.includes("--dry-run");
const PATCHES = {
  "user-record": async () => (await import("./rulesRequireUserRecord.mjs")).patchRequireUserRecord,
  money: async () => (await import("./rulesMoneyPaths.mjs")).patchMoneyPaths,
};
if (patchName === "health") PATCHES.health = async () => null;
if (!PATCHES[patchName]) { console.error(`usage: rules-publish.mjs <${Object.keys(PATCHES).join("|")}> [--dry-run]`); process.exit(2); }

function ownerToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi", "-d", "grant_type=refresh_token",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  return JSON.parse(out).access_token;
}
const OWNER = ownerToken();
const H = { Authorization: `Bearer ${OWNER}` };
const ownerGet = async (u) => (await fetch(u, { headers: H })).json();
const getRules = async (db) => { const r = await fetch(`${db.url}/.settings/rules.json`, { headers: H }); if (!r.ok) throw new Error(`read rules ${db.name} ${r.status}`); return r.text(); };
async function putRules(db, text) {
  console.log(`  → WRITING RULES TO ${db.name}`);
  const r = await fetch(`${db.url}/.settings/rules.json`, { method: "PUT", headers: H, body: text });
  if (!r.ok) throw new Error(`publish to ${db.name} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const back = await getRules(db);
  if (back !== text) throw new Error(`${db.name}: rules read back differ from what was published`);
}

const idt = async (path, body) => { const r = await fetch(`${IDT}/${path}?key=${API_KEY}`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
function customToken(uid) {
  const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const u = `${b({ alg: "RS256", typ: "JWT" })}.${b({ iss: sa.client_email, sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 3600, uid })}`;
  const s = createSign("RSA-SHA256"); s.update(u); return `${u}.${s.sign(sa.private_key, "base64url")}`;
}
const signInAs = async (uid) => (await idt("accounts:signInWithCustomToken", { token: customToken(uid), returnSecureToken: true })).json.idToken;

async function findUids() {
  const uids = Object.keys(await ownerGet(`${LIVE.url}/users.json?shallow=true`) || {});
  const out = {};
  for (const u of uids) {
    if (out.cashier && out.manager) break;
    const role = await ownerGet(`${LIVE.url}/users/${u}/posAccess/role.json`);
    const act = await ownerGet(`${LIVE.url}/users/${u}/posAccess/isActive.json`);
    if (act === true && role === "cashier" && !out.cashier) out.cashier = u;
    if (act === true && role === "manager" && !out.manager) out.manager = u;
  }
  const look = await fetch(`${IDT}/projects/marathon-club/accounts:lookup`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAILS }) }).then((r) => r.json());
  out.owner = look.users?.[0]?.localId;
  out.poller = "card-recon-email-poller";
  CASHIER_SHOP = await ownerGet(`${LIVE.url}/users/${out.cashier}/destShop.json`);
  return out;
}

const created = [];
async function personas(uids) {
  const p = {};
  for (const [k, u] of Object.entries(uids)) p[k] = await signInAs(u);
  const s = await idt("accounts:signUp", { email: `sec-probe-${Date.now()}@marathon.internal`, password: `P-${randomBytes(12).toString("hex")}`, returnSecureToken: true });
  p.stranger = s.json.idToken || null; if (s.json.idToken) created.push(s.json);
  const a = await idt("accounts:signUp", { returnSecureToken: true });
  p.anon = a.json.idToken || null; if (a.json.idToken) created.push(a.json);
  return p;
}
async function cleanup() {
  for (const c of created) {
    await idt("accounts:delete", { idToken: c.idToken });
    const look = await fetch(`${IDT}/projects/marathon-club/accounts:lookup`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ localId: [c.localId] }) }).then((r) => r.json());
    console.log(`  probe account deleted: ${look.users ? "NO — STILL PRESENT" : "yes (owner lookup finds none)"}`);
  }
}
let CASHIER_SHOP = null;
const read = async (db, path, tok, who) => {
  // a shop-pinned till reads orders the way the app does: filtered to its shop
  const q = path === "orders" && who === "cashier" && CASHIER_SHOP
    ? `orderBy=${encodeURIComponent('"destShop"')}&equalTo=${encodeURIComponent(JSON.stringify(CASHIER_SHOP))}&limitToFirst=1`
    : `orderBy=${encodeURIComponent('"$key"')}&limitToFirst=1`;
  const r = await fetch(`${db.url}/${path}.json?${q}&auth=${tok}`);
  await r.arrayBuffer(); return r.status === 200;
};

// What must work, and what a stranger must not get, on LIVE.
const HEALTH = [
  ["cashier", "products", true], ["cashier", "stock", true], ["cashier", "orders", true], ["cashier", "settings", true],
  ["cashier", "locations", true], ["cashier", "config", true], ["cashier", "laybys", true], ["cashier", "pos_meta", true],
  ["manager", "products", true], ["manager", "users", true],
  ["owner", "eft_pool", true], ["owner", "card_batches", true], ["owner", "online_orders", true], ["owner", "users", true],
  ["poller", "card_batch_intake", true],
  ["anon", "settings", true], ["anon", "orders", true],
  ["cashier", "pos/storeCredits", true], ["cashier", "pos/sales", true], ["cashier", "customers", true],
  ["cashier", "pos_manager_pins", false], ["owner", "pos_manager_pins", false],
];
const STRANGER_DENY = ["users", "products", "stock", "laybys", "config", "pos_meta", "customers_meta"];
async function healthCheck(db, p, { strangerMustBeDenied }) {
  let bad = 0;
  for (const [who, path, want] of HEALTH) {
    if (!p[who]) { console.log(`  ✗ ${who}: could not sign in`); bad++; continue; }
    const got = await read(db, path, p[who], who);
    if (got !== want) { bad++; console.log(`  ✗ ${who} read ${path}: ${got ? "allowed" : "DENIED"} (want ${want ? "allowed" : "denied"})`); }
  }
  if (strangerMustBeDenied) {
    if (!p.stranger) console.log("  (stranger account could not be created — sign-up closed)");
    else for (const path of STRANGER_DENY) if (await read(db, path, p.stranger)) { bad++; console.log(`  ✗ stranger can still read ${path}`); }
  }
  console.log(`  ${db.name}: ${bad === 0 ? "HEALTHY" : `${bad} FAILURE(S)`}`);
  return bad === 0;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (patchName === "health") {
  // health only: live checks as cashier / manager / owner / poller / TV, and a
  // stranger must get nothing. Used before and after every deploy.
  const p = await personas(await findUids());
  let good = false;
  try { good = await healthCheck(LIVE, p, { strangerMustBeDenied: true }); } finally { await cleanup(); }
  process.exit(good ? 0 : 1);
}
const patch = await PATCHES[patchName]();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const live = await getRules(LIVE);
mkdirSync(join(homedir(), "marathon-rollbacks"), { recursive: true });
const backup = join(homedir(), "marathon-rollbacks", `rules-${LIVE.name}-${stamp}.json`);
writeFileSync(backup, live);
console.log(`backup of LIVE ${LIVE.name}: ${backup}`);
const next = patch(live);
if (next === live) { console.log("patch makes no change — live rules already carry it."); process.exit(0); }
JSON.parse(next.replace(/^\s*\/\/.*$/gm, "")); // must still be one JSON document (comment lines aside)

const uids = await findUids();
const p = await personas(uids);
let ok = false;
try {
  // 3. rulestest
  const testBefore = await getRules(TEST);
  writeFileSync(join(homedir(), "marathon-rollbacks", `rules-${TEST.name}-${stamp}.json`), testBefore);
  console.log(`proving on ${TEST.name}`);
  await putRules(TEST, next);
  // seed the test db with record shapes the rules read (no real data)
  const seed = { [`users/${uids.cashier}`]: { stockRole: "pos", ...(CASHIER_SHOP ? { destShop: CASHIER_SHOP } : {}), posAccess: { isActive: true, role: "cashier" } },
    [`users/${uids.manager}`]: { stockRole: "pos", posAccess: { isActive: true, role: "manager" } },
    [`users/${uids.owner}`]: { stockRole: "admin" }, [`users/${uids.poller}`]: { isService: true, permFlags: { card_recon: true } },
    "settings/probe": 1, "orders/probe": { status: "probe", destShop: CASHIER_SHOP || "pe" }, "products/probe": { name: "probe" }, "stock/probe": 1,
    "locations/probe": 1, "config/probe": 1, "laybys/probe": 1, "pos_meta/probe": 1, "eft_pool/probe": 1, "card_batches/probe": 1,
    "online_orders/probe": 1, "card_batch_intake/probe": 1, "customers_meta/probe": 1,
    "pos/storeCredits/probe": { remainingAmount: 1, status: "active" }, "pos/sales/probe": { total: 1, type: "sale" }, "customers/probe": { name: "probe" } };
  console.log(`  → SEEDING ${TEST.name} (probe rows only)`);
  await fetch(`${TEST.url}/.json`, { method: "PATCH", headers: H, body: JSON.stringify(seed) });
  const testOk = await healthCheck(TEST, p, { strangerMustBeDenied: true });
  console.log(`  → CLEARING ${TEST.name} probe rows and restoring its rules`);
  await fetch(`${TEST.url}/.json`, { method: "PATCH", headers: H, body: JSON.stringify(Object.fromEntries(Object.keys(seed).map((k) => [k, null]))) });
  await putRules(TEST, testBefore);
  if (!testOk) throw new Error("test database proof failed — LIVE untouched");
  // 4. live health before
  console.log(`health check LIVE ${LIVE.name} BEFORE`);
  if (!(await healthCheck(LIVE, p, { strangerMustBeDenied: false }))) throw new Error("live is not healthy BEFORE the change — not publishing");
  if (DRY) { console.log("--dry-run: stopping before publishing to LIVE"); ok = true; }
  else {
    // 5. publish + re-check, auto-restore
    await putRules(LIVE, next);
    console.log(`health check LIVE ${LIVE.name} AFTER`);
    const after = await healthCheck(LIVE, p, { strangerMustBeDenied: true });
    if (!after) {
      console.log("✗ AFTER check failed — RESTORING BACKUP");
      await putRules(LIVE, live);
      await healthCheck(LIVE, p, { strangerMustBeDenied: false });
      throw new Error("rolled back");
    }
    ok = true;
    console.log(`PUBLISHED to ${LIVE.name}. Backup: ${backup}`);
  }
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);

// ─── PROOF: THE "/users RECORD REQUIRED" PATCH CHANGES NOTHING FOR STAFF ─────
//
// Runs the LIVE rules document and the PATCHED one through the real rules
// engine (RTDB emulator) and walks EVERY path the rules tree names ($vars
// filled with probe ids), for every persona, reading and writing:
//
//   MUST BE IDENTICAL before/after: owner (Google, verified, has record),
//     staff cashier, POS manager, POS device on PE till-2 (fresh device
//     session — the online_orders gate), anonymous TV, card-recon poller
//     service identity.
//   MUST GAIN NOTHING BEYOND ANONYMOUS after: stranger (password, no record),
//     stranger with a Google account, stranger claiming an owner email
//     unverified. (Anything an anonymous session can do, anyone can do —
//     anonymous sign-up has to stay open for the TV boards.)
//
// Exit 0 only if every assertion holds. Nothing touches production.
//
//   node scripts/security/prove-user-record-rules.mjs [--rules-file live.json]
import { readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { patchRequireUserRecord, countPatch } from "./rulesRequireUserRecord.mjs";
import { patchMoneyPaths } from "./rulesMoneyPaths.mjs";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const NS = "marathon-club-default-rtdb";
const PROJECT = "marathon-club";
const PORT = Number(process.env.RULES_TEST_PORT || 9594);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = join(homedir(), ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || ["/opt/homebrew/opt/openjdk/bin/java", "/opt/homebrew/opt/openjdk@21/bin/java"].find((p) => existsSync(p));
const args = process.argv.slice(2);

function ownerToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi", "-d", "grant_type=refresh_token",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  return JSON.parse(out).access_token;
}
export async function liveRulesText() {
  if (args.includes("--rules-file")) return readFileSync(args[args.indexOf("--rules-file") + 1], "utf8");
  const r = await fetch(`${DB}/.settings/rules.json`, { headers: { Authorization: `Bearer ${ownerToken()}` } });
  if (!r.ok) throw new Error(`live rules read failed ${r.status}`);
  return r.text();
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (uid, email, provider, extra = {}) => `${b64({ alg: "none", typ: "JWT" })}.${b64({
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid, email, auth_time: 1, iat: 1,
  exp: 9999999999, firebase: { sign_in_provider: provider, identities: {} }, ...extra })}.`;
const P = {
  owner: jwt("owner-uid", "gunidmoh@gmail.com", "google.com", { email_verified: true }),
  owner2: jwt("owner2-uid", "jafermohammed340@gmail.com", "google.com", { email_verified: true }),
  staff: jwt("staff-uid", "cashier1@marathon.internal", "password"),
  manager: jwt("mgr-uid", "manager1@marathon.internal", "password"),
  posDevice: jwt("till-uid", "till2@marathon.internal", "password"),
  poller: jwt("card-recon-email-poller", undefined, "custom"),
  anon: jwt("anon-uid", undefined, "anonymous"),
  stranger: jwt("stranger-uid", "rule-probe@marathon.internal", "password"),
  strangerGoogle: jwt("google-uid", "someone@gmail.com", "google.com", { email_verified: true }),
  fakeOwner: jwt("fake-owner-uid", "gunidmoh@gmail.com", "password", { email_verified: false }),
};
const MUST_MATCH = ["owner", "owner2", "staff", "manager", "posDevice", "poller", "anon"];
const STRANGERS = ["stranger", "strangerGoogle", "fakeOwner"];

function stripComments(t) {
  // RTDB rules allow // and /* */ comments outside strings
  let o = "", i = 0, inS = false;
  while (i < t.length) {
    const c = t[i];
    if (inS) { o += c; if (c === "\\") { o += t[i + 1]; i += 2; continue; } if (c === '"') inS = false; i++; continue; }
    if (c === '"') { inS = true; o += c; i++; continue; }
    if (c === "/" && t[i + 1] === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "/" && t[i + 1] === "*") { i = t.indexOf("*/", i + 2) + 2; continue; }
    o += c; i++;
  }
  return o;
}
export function rulePaths(text, maxDepth = 5) {
  const tree = JSON.parse(stripComments(text)).rules;
  const out = [];
  const walk = (node, path, d) => {
    if (!node || typeof node !== "object" || d > maxDepth) return;
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith(".")) continue;
      const seg = k.startsWith("$") ? `p${k.slice(1).replace(/[^A-Za-z0-9]/g, "")}` : k;
      const p = path ? `${path}/${seg}` : seg;
      out.push(p);
      walk(v, p, d + 1);
    }
  };
  walk(tree, "", 1);
  return out;
}

async function boot() {
  const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
  process.on("exit", () => { try { emu.kill("SIGKILL"); } catch { /* gone */ } });
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { headers: { Authorization: "Bearer owner" } }); if (r.ok) break; } catch { /* */ }
    if (i > 200) throw new Error("emulator did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  return emu;
}
const admin = (m, p, v) => fetch(`${HOST}/${p}.json?ns=${NS}`, { method: m, headers: { Authorization: "Bearer owner" },
  ...(v === undefined ? {} : { body: JSON.stringify(v) }) });
async function seed() {
  await admin("DELETE", "");
  const now = Date.now();
  await admin("PATCH", "", {
    "users/owner-uid": { stockRole: "admin", email: "gunidmoh@gmail.com" },
    "users/owner2-uid": { stockRole: "admin" },
    "users/staff-uid": { stockRole: "pos", posAccess: { isActive: true, role: "cashier" } },
    "users/mgr-uid": { stockRole: "pos", posAccess: { isActive: true, role: "manager" } },
    "users/till-uid": { stockRole: "pos", destShop: "pe", posAccess: { isActive: true, role: "cashier" } },
    "users/card-recon-email-poller": { isService: true, name: "poller", permFlags: { card_recon: true } },
    "pos/device_sessions/till-uid": { deviceId: "dev1", at: now, storeId: "pe", tillId: "till-2" },
  });
}
async function as(tok, method, path, body) {
  const r = await fetch(`${HOST}/${path}.json?ns=${NS}&auth=${tok}${method === "GET" ? "&shallow=true" : ""}`,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await r.arrayBuffer();
  return r.status === 200;
}
async function matrix(rulesText, paths) {
  const load = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: { Authorization: "Bearer owner" }, body: rulesText });
  if (!load.ok) throw new Error(`rules load failed: ${await load.text()}`);
  const res = {};
  for (const p of paths) {
    res[p] = {};
    for (const [name, tok] of Object.entries(P)) {
      await seed();
      const read = await as(tok, "GET", p);
      const w1 = await as(tok, "PUT", `${p}/zz_probe`, "x");
      await seed();
      const w2 = await as(tok, "PUT", p, { probe: true, total: 1, type: "sale" });
      res[p][name] = `${read ? "R" : "-"}${w1 || w2 ? "W" : "-"}`;
    }
  }
  return res;
}

// --patch money: the money-path rules. Only these paths may change, and only
// by losing a grant; the targeted cases below say exactly how.
const PATCH = args.includes("--patch") ? args[args.indexOf("--patch") + 1] : "user-record";
const MONEY_CHANGED = ["pos/shopifyCreditDebits", "pos/shopifyCreditDebitsOpen", "pos/storeCredits/pcreditId/status"];
async function moneyCases(rulesText) {
  await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: { Authorization: "Bearer owner" }, body: rulesText });
  const out = {};
  const seedCredit = async () => { await seed(); await admin("PUT", "pos/storeCredits/c1", { remainingAmount: 500, status: "active" }); await admin("PUT", "pos/storeCredits/c2", { remainingAmount: 0, status: "voided" }); };
  await seedCredit(); out.tillDepletes = await as(P.staff, "PUT", "pos/storeCredits/c1/status", "depleted");
  await seedCredit(); out.tillRevivesVoided = await as(P.staff, "PUT", "pos/storeCredits/c2/status", "active");
  await seedCredit(); out.tillSpends = await as(P.staff, "PUT", "pos/storeCredits/c1/remainingAmount", 200);
  await seedCredit(); out.tillForgesDebit = await as(P.staff, "PUT", "pos/shopifyCreditDebits/k1", { state: "done", accountId: "a", amountCents: 99999 });
  await seedCredit(); out.tillReadsDebits = await as(P.staff, "GET", "pos/shopifyCreditDebits");
  await seedCredit(); out.tillWritesOtherPos = await as(P.staff, "PUT", "pos/someOtherNode/x", { a: 1 });
  await seedCredit(); out.staffReadsPinHashes = await as(P.staff, "GET", "pos_manager_pins");
  await seedCredit(); out.ownerReadsPinHashes = await as(P.owner, "GET", "pos_manager_pins");
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && PATCH === "money") {
  const live = await liveRulesText();
  const patched = patchMoneyPaths(live);
  const paths = [...rulePaths(live), "pos/shopifyCreditDebits", "pos/shopifyCreditDebitsOpen", "pos_manager_pins"];
  console.log(`paths walked: ${paths.length}`);
  const emu = await boot();
  const before = await matrix(live, paths), after = await matrix(patched, paths);
  const cb = await moneyCases(live), ca = await moneyCases(patched);
  emu.kill("SIGKILL");
  let fail = 0;
  for (const p of paths) for (const who of Object.keys(P)) {
    if (before[p][who] === after[p][who]) continue;
    const allowed = MONEY_CHANGED.some((m) => p === m || p.startsWith(`${m}/`));
    const lostOnly = [0, 1].every((i) => !(after[p][who][i] !== "-" && before[p][who][i] === "-"));
    if (!allowed || !lostOnly) { fail++; console.log(`FAIL ${who} at ${p}: ${before[p][who]} → ${after[p][who]}`); }
  }
  const want = { tillDepletes: [true, true], tillRevivesVoided: [true, false], tillSpends: [true, true], tillForgesDebit: [true, false],
    tillReadsDebits: [true, false], tillWritesOtherPos: [true, true], staffReadsPinHashes: [false, false], ownerReadsPinHashes: [false, false] };
  for (const [k, [b, a]] of Object.entries(want)) {
    const ok = cb[k] === b && ca[k] === a;
    if (!ok) fail++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${k}: before ${cb[k] ? "ALLOW" : "deny"} → after ${ca[k] ? "ALLOW" : "deny"}`);
  }
  console.log(fail === 0 ? "PASS" : `FAIL (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}
if (isMain && PATCH === "user-record") {
  const live = await liveRulesText();
  const patched = patchRequireUserRecord(live);
  const counts = countPatch(live, patched);
  console.log("patch:", JSON.stringify(counts));
  const paths = rulePaths(live);
  console.log(`paths walked: ${paths.length}`);
  const emu = await boot();
  const before = await matrix(live, paths);
  const after = await matrix(patched, paths);
  emu.kill("SIGKILL");
  let fail = 0, closed = 0;
  const closedPaths = new Set();
  for (const p of paths) {
    for (const who of MUST_MATCH) {
      if (before[p][who] !== after[p][who]) { fail++; console.log(`FAIL ${who} changed at ${p}: ${before[p][who]} → ${after[p][who]}`); }
    }
    for (const who of STRANGERS) {
      const a = after[p][who], anon = after[p].anon;
      const beyond = (a[0] === "R" && anon[0] !== "R") || (a[1] === "W" && anon[1] !== "W");
      if (beyond) { fail++; console.log(`FAIL ${who} still beyond anonymous at ${p}: ${a} (anon ${anon})`); }
      if (before[p][who] !== a) { closed++; closedPaths.add(p.split("/")[0]); }
    }
  }
  console.log(`staff/owner/till/poller/anon unchanged on every path: ${fail === 0 ? "YES" : "NO"}`);
  console.log(`stranger permissions removed: ${closed} (persona×path) across ${closedPaths.size} top-level nodes`);
  console.log(fail === 0 ? "PASS" : `FAIL (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

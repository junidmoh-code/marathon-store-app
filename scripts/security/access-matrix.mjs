// ─── WHO CAN READ / WRITE WHAT — THE LIVE ACCESS MAP ─────────────────────────
//
// Two halves, deliberately different:
//
//   READS  are probed LIVE with real ID tokens, one bounded request per
//          top-level node (orderBy="$key"&limitToFirst=1, body discarded —
//          only the HTTP status is kept). Personas:
//            stranger  an email/password account created with the public web
//                      key, exactly as anyone on the internet could (only if
//                      client sign-up is open — if it is closed, the stranger
//                      row is recorded as "cannot exist")
//            anon      an anonymous session, what every TV board holds
//            staff     an ordinary active cashier, signed in by custom token
//   WRITES are NEVER attempted against live data. The LIVE rules document is
//          loaded into the RTDB emulator (the real rules engine) and every
//          persona attempts a junk write one level under each node. A DENY for
//          a junk payload can still be an ALLOW for a correctly-shaped one
//          (.validate), so the report says "junk denied" rather than "safe".
//
// Every probe account this creates is deleted, and the deletion is confirmed
// by an owner lookup that must return no user.
//
// Prints nothing secret: no token, no uid, no email, no row content.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/security/access-matrix.mjs [--rules <file>] > out.md
//
// --rules lets the emulator half run a CANDIDATE document instead of the live
// one (used to prove a rules change before it is published).
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo"; // public web config key (src/firebase.js)
const PROJECT = "marathon-club";
const DBS = {
  main: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  jamie: "https://marathon-jamie.europe-west1.firebasedatabase.app",
};
const BUCKET = "marathon-club.firebasestorage.app";
const IDT = "https://identitytoolkit.googleapis.com/v1";
const args = process.argv.slice(2);
const CANDIDATE = args.includes("--rules") ? args[args.indexOf("--rules") + 1] : null;
const SKIP_LIVE = args.includes("--emulator-only");

// ── owner access token (Firebase CLI login) — admin, used only for listing
// keys, reading rules, and confirming probe accounts are gone ──────────────
function ownerToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi", "-d", "grant_type=refresh_token",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  const t = JSON.parse(out).access_token;
  if (!t) throw new Error("owner token refresh failed");
  return t;
}
const OWNER = ownerToken();
const ownerGet = async (u) => (await fetch(u, { headers: { Authorization: `Bearer ${OWNER}` } })).json();

const post = async (path, body) => {
  const r = await fetch(`${IDT}/${path}?key=${API_KEY}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ── custom token for the staff persona (signed with the SA key locally) ─────
function customToken(uid) {
  const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b({ alg: "RS256", typ: "JWT" })}.${b({ iss: sa.client_email, sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now, exp: now + 3600, uid })}`;
  const s = createSign("RSA-SHA256"); s.update(unsigned);
  return `${unsigned}.${s.sign(sa.private_key, "base64url")}`;
}

async function pickCashierUid() {
  const uids = Object.keys(await ownerGet(`${DBS.main}/users.json?shallow=true`) || {});
  for (const u of uids) {
    const pa = await ownerGet(`${DBS.main}/users/${u}/posAccess/role.json`);
    const act = await ownerGet(`${DBS.main}/users/${u}/posAccess/isActive.json`);
    const sr = await ownerGet(`${DBS.main}/users/${u}/stockRole.json`);
    if (pa === "cashier" && act === true && sr === "pos") return u;
  }
  throw new Error("no ordinary cashier found");
}

const rows = [];
const created = [];
const log = (...a) => console.error(...a);

async function liveReads() {
  // personas
  const personas = {};
  const email = `sec-probe-${Date.now()}@marathon.internal`;
  const su = await post("accounts:signUp", { email, password: `P-${randomBytes(12).toString("hex")}`, returnSecureToken: true });
  if (su.json.idToken) { personas.stranger = su.json.idToken; created.push({ id: su.json.localId, tok: su.json.idToken, kind: "stranger" }); }
  else personas.stranger = null;
  const strangerSignup = su.json.idToken ? "OPEN (account created)" : `CLOSED (${su.json.error?.message || su.status})`;
  const an = await post("accounts:signUp", { returnSecureToken: true });
  if (an.json.idToken) { personas.anon = an.json.idToken; created.push({ id: an.json.localId, tok: an.json.idToken, kind: "anon" }); }
  else personas.anon = null;
  const anonSignup = an.json.idToken ? "works" : `FAILED (${an.json.error?.message || an.status})`;
  const ct = await post("accounts:signInWithCustomToken", { token: customToken(await pickCashierUid()), returnSecureToken: true });
  personas.staff = ct.json.idToken || null;

  const out = { strangerSignup, anonSignup, staffSignin: personas.staff ? "works" : "FAILED", db: {}, storage: {} };
  for (const [name, base] of Object.entries(DBS)) {
    let keys = Object.keys(await ownerGet(`${base}/.json?shallow=true`) || {}).sort();
    if (name === "jamie") keys = Object.keys(await ownerGet(`${base}/jamie.json?shallow=true`) || {}).sort().map((k) => `jamie/${k}`);
    out.db[name] = {};
    for (const k of keys) {
      out.db[name][k] = {};
      for (const [p, tok] of Object.entries(personas)) {
        if (!tok) { out.db[name][k][p] = "n/a"; continue; }
        const u = `${base}/${k}.json?orderBy=${encodeURIComponent('"$key"')}&limitToFirst=1&auth=${tok}`;
        const r = await fetch(u); await r.arrayBuffer();
        out.db[name][k][p] = r.status === 200 ? "READ" : r.status === 401 ? "denied" : String(r.status);
      }
    }
  }
  // storage: top-level prefixes
  const top = await ownerGet(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?delimiter=/&maxResults=1000`);
  const prefixes = (top.prefixes || []).map((p) => p.replace(/\/$/, ""));
  for (const pre of prefixes) {
    out.storage[pre] = {};
    for (const [p, tok] of Object.entries({ none: "", ...personas })) {
      if (tok === null) { out.storage[pre][p] = "n/a"; continue; }
      const r = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?prefix=${encodeURIComponent(pre + "/")}&maxResults=1`,
        { headers: tok ? { Authorization: `Firebase ${tok}` } : {} });
      await r.arrayBuffer();
      out.storage[pre][p] = r.status === 200 ? "LIST" : r.status === 403 || r.status === 401 ? "denied" : String(r.status);
    }
  }
  return out;
}

async function cleanup() {
  const res = [];
  for (const c of created) {
    const d = await post("accounts:delete", { idToken: c.tok });
    const look = await fetch(`${IDT}/projects/${PROJECT}/accounts:lookup`, { method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ localId: [c.id] }) }).then((r) => r.json());
    res.push(`${c.kind}: delete http=${d.status}, owner lookup finds ${look.users ? look.users.length : 0} user(s)`);
  }
  return res;
}

// ── emulator write matrix ────────────────────────────────────────────────────
const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9593);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR || join(homedir(), ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || ["/opt/homebrew/opt/openjdk/bin/java", "/opt/homebrew/opt/openjdk@21/bin/java"].find((p) => existsSync(p));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (uid, email, provider, extra = {}) => `${b64({ alg: "none", typ: "JWT" })}.${b64({
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid, email, auth_time: 1, iat: 1, exp: 9999999999,
  firebase: { sign_in_provider: provider, identities: {} }, ...extra })}.`;
export const EMU_PERSONAS = {
  stranger: jwt("stranger-uid", "anyone@marathon.internal", "password"),
  strangerGoogle: jwt("google-uid", "someone@gmail.com", "google.com", { email_verified: true }),
  anon: jwt("anon-uid", undefined, "anonymous"),
  staff: jwt("staff-uid", "cashier1@marathon.internal", "password"),
};

export async function startEmulator(rulesText) {
  const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
  process.on("exit", () => { try { emu.kill("SIGKILL"); } catch { /* gone */ } });
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { headers: { Authorization: "Bearer owner" } }); if (r.ok) break; } catch { /* not yet */ }
    if (i > 200) throw new Error("emulator did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: { Authorization: "Bearer owner" }, body: rulesText });
  if (!r.ok) throw new Error(`rules load failed ${r.status} ${await r.text()}`);
  // the staff persona's /users record, shaped like a real cashier
  await fetch(`${HOST}/users/staff-uid.json?ns=${NS}`, { method: "PUT", headers: { Authorization: "Bearer owner" },
    body: JSON.stringify({ stockRole: "pos", posAccess: { isActive: true, role: "cashier", displayName: "C" } }) });
  return emu;
}
export const emuAs = async (tok, method, path, body, qs = "") => {
  const r = await fetch(`${HOST}/${path}.json?ns=${NS}${qs ? `&${qs}` : ""}${tok ? `&auth=${tok}` : ""}`,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await r.arrayBuffer();
  return r.status;
};

async function emulatorWrites(rulesText, keys) {
  const emu = await startEmulator(rulesText);
  const out = {};
  for (const k of keys) {
    out[k] = {};
    for (const [p, tok] of Object.entries(EMU_PERSONAS)) {
      const s1 = await emuAs(tok, "PUT", `${k}/__probe__/x`, "probe");
      const s2 = s1 === 200 ? 200 : await emuAs(tok, "PUT", `${k}/__probe__`, { probe: true });
      const rd = await emuAs(tok, "GET", k, undefined, `orderBy=${encodeURIComponent('"$key"')}&limitToFirst=1`);
      out[k][p] = { w: (s1 === 200 || s2 === 200) ? "WRITE" : "junk denied", r: rd === 200 ? "READ" : "denied" };
      // undo, so one persona's write does not create data the next one's rule depends on
      await fetch(`${HOST}/${k}/__probe__.json?ns=${NS}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
    }
  }
  emu.kill("SIGKILL");
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const liveRulesText = await (await fetch(`${DBS.main}/.settings/rules.json`, { headers: { Authorization: `Bearer ${OWNER}` } })).text();
  const rulesText = CANDIDATE ? readFileSync(CANDIDATE, "utf8") : liveRulesText;
  let live = null, cleaned = [];
  try { if (!SKIP_LIVE) live = await liveReads(); }
  finally { cleaned = await cleanup(); }
  const keys = live ? Object.keys(live.db.main) : Object.keys(await ownerGet(`${DBS.main}/.json?shallow=true`) || {}).sort();
  const writes = await emulatorWrites(rulesText, keys);

  const L = [];
  L.push(`Generated ${new Date().toISOString()} — rules: ${CANDIDATE ? `CANDIDATE ${CANDIDATE}` : "LIVE marathon-club-default-rtdb"}`);
  if (live) {
    L.push("", `- Stranger sign-up with the public web key: **${live.strangerSignup}**`,
      `- New anonymous (TV) session: **${live.anonSignup}**`, `- Staff (cashier) sign-in: **${live.staffSignin}**`);
  }
  L.push("", "Probe accounts cleaned up:", ...cleaned.map((c) => `- ${c}`));
  L.push("", "### marathon-club-default-rtdb", "",
    "Live read = real token, bounded GET. Emulator = live rules in the real rules engine (strangerG = a Google account with no /users record).", "",
    "| node | live read stranger | live read anon | live read staff | write stranger | write strangerG | write anon | write staff |",
    "|---|---|---|---|---|---|---|---|");
  for (const k of keys) {
    const lr = live?.db.main[k] || {};
    const w = writes[k];
    L.push(`| ${k} | ${lr.stranger ?? "-"} | ${lr.anon ?? "-"} | ${lr.staff ?? "-"} | ${w.stranger.w} | ${w.strangerGoogle.w} | ${w.anon.w} | ${w.staff.w} |`);
  }
  if (live) {
    L.push("", "### marathon-jamie (live reads; writes per rules: all need email_verified + owner/staff list)", "",
      "| node | stranger | anon | staff |", "|---|---|---|---|");
    for (const [k, v] of Object.entries(live.db.jamie)) L.push(`| ${k} | ${v.stranger} | ${v.anon} | ${v.staff} |`);
    L.push("", `### Storage (${BUCKET}) — live list probe`, "", "| prefix | no auth | stranger | anon | staff |", "|---|---|---|---|---|");
    for (const [k, v] of Object.entries(live.storage)) L.push(`| ${k} | ${v.none} | ${v.stranger} | ${v.anon} | ${v.staff} |`);
  }
  console.log(L.join("\n"));
  writeFileSync(join(mkdtempSync(join(tmpdir(), "matrix-")), "raw.json"), JSON.stringify({ live, writes }));
}

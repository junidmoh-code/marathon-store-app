// ─── PUBLISH storage.rules SAFELY (backup → rules-engine proof → live → verify) ─
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/security/storage-rules-publish.mjs [--dry-run]
//
// 1. Back up the LIVE Storage ruleset (its name and source) to ~/marathon-rollbacks.
// 2. Prove repo storage.rules with Google's rules engine (firebaserules projects:test)
//    for stranger / Google stranger / unverified-owner / anonymous TV / staff /
//    owner / card-recon personas.
// 3. LIVE before-check: public read of a product photo; staff (real cashier,
//    custom token) can create and the probe file is removed again.
// 4. Release the new ruleset; re-run the live checks plus "a stranger cannot
//    create". Any failure → the previous ruleset is released again.
// No token, uid or email is printed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT = "marathon-club";
const BUCKET = "marathon-club.firebasestorage.app";
const RELEASE = `projects/${PROJECT}/releases/firebase.storage/${BUCKET}`;
const API_KEY = "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo";
const DRY = process.argv.includes("--dry-run");
const RULES = readFileSync(new URL("../../storage.rules", import.meta.url), "utf8");

function ownerToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const out = execFileSync("curl", ["-sS", "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", "client_id=563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    "-d", "client_secret=j9iVZfS8kkCEFUPaAeJV0sAi", "-d", "grant_type=refresh_token",
    "--data-urlencode", `refresh_token=${cfg.tokens.refresh_token}`], { encoding: "utf8" });
  return JSON.parse(out).access_token;
}
const OT = ownerToken();
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${OT}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};
const RAPI = "https://firebaserules.googleapis.com/v1";

// ── 2. rules-engine proof ────────────────────────────────────────────────────
const tok = (uid, email, prov = "password", extra = {}) => ({ uid, token: { firebase: { sign_in_provider: prov }, email_verified: false, ...(email ? { email } : {}), ...extra } });
const P = { anon: tok("a", null, "anonymous"), stranger: tok("s", "x@marathon.internal"), strangerG: tok("g", "someone@gmail.com", "google.com", { email_verified: true }),
  fakeOwner: tok("f", "gunidmoh@gmail.com"), staff: tok("st", "c@marathon.internal", "password", { staff: true }),
  owner: tok("o", "gunidmoh@gmail.com", "google.com", { email_verified: true }), cardRecon: tok("cr", "c2@marathon.internal", "password", { staff: true, card_recon: true }) };
const STAFFISH = ["staff", "owner", "cardRecon"];
const cases = [];
for (const path of ["products/x.jpg", "tv_ads/current.jpg"]) {
  for (const p of ["none", ...Object.keys(P)]) cases.push([p, "get", path, true]);
  for (const p of Object.keys(P)) cases.push([p, "create", path, STAFFISH.includes(p)]);
}
for (const p of Object.keys(P)) cases.push([p, "create", "logs/t/2026-11-23/a.gz", STAFFISH.includes(p)], [p, "get", "logs/t/2026-11-23/a.gz", STAFFISH.includes(p)]);
cases.push(["staff", "update", "logs/t/2026-11-23/a.gz", false]);
for (const p of Object.keys(P)) cases.push([p, "get", "cardRecon/d/photo-0.jpg", ["owner", "cardRecon"].includes(p)], [p, "create", "aiStudio/x.jpg", p === "owner"],
  [p, "create", "broadcast-media/x.jpg", p === "owner"], [p, "get", "eftProofs/x.jpg", false], [p, "create", "cardRecon/x.jpg", false]);
const testCases = cases.map(([p, m, path, allow]) => ({ expectation: allow ? "ALLOW" : "DENY",
  request: { path: `/b/${BUCKET}/o/${path}`, method: m, ...(p !== "none" ? { auth: P[p] } : {}), ...(m !== "get" ? { resource: { size: 1000, contentType: "image/jpeg", name: path } } : {}) },
  ...(m !== "create" ? { resource: { name: path, size: 1000, contentType: "image/jpeg" } } : {}) }));
const proof = await api("POST", `${RAPI}/projects/${PROJECT}:test`, { source: { files: [{ name: "storage.rules", content: RULES }] }, testSuite: { testCases } });
const bad = (proof.testResults || []).map((r, i) => [r.state, cases[i]]).filter(([s]) => s !== "SUCCESS");
console.log(`rules-engine proof: ${cases.length - bad.length}/${cases.length}`);
if (bad.length) { for (const [, c] of bad) console.log("  ✗", c.slice(0, 3).join(" ")); process.exit(1); }

// ── personas on LIVE ─────────────────────────────────────────────────────────
const idt = async (path, body) => (await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
function customToken(uid) {
  const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const now = Math.floor(Date.now() / 1000);
  const u = `${b({ alg: "RS256", typ: "JWT" })}.${b({ iss: sa.client_email, sub: sa.client_email, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 3600, uid })}`;
  const s = createSign("RSA-SHA256"); s.update(u); return `${u}.${s.sign(sa.private_key, "base64url")}`;
}
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const uids = Object.keys(await (await fetch(`${DB}/users.json?shallow=true`, { headers: { Authorization: `Bearer ${OT}` } })).json());
let cashier = null;
for (const u of uids) { const r = await (await fetch(`${DB}/users/${u}/posAccess/role.json`, { headers: { Authorization: `Bearer ${OT}` } })).json(); if (r === "cashier") { cashier = u; break; } }
const staffTok = (await idt("accounts:signInWithCustomToken", { token: customToken(cashier), returnSecureToken: true })).idToken;
const s = await idt("accounts:signUp", { email: `sec-probe-${Date.now()}@marathon.internal`, password: `P-${randomBytes(12).toString("hex")}`, returnSecureToken: true });
const strangerTok = s.idToken;

const firstProduct = (await api("GET", `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?prefix=products/&maxResults=1`)).items?.[0]?.name;
async function liveCheck(label, { strangerMustFail }) {
  let ok = true;
  const pub = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(firstProduct)}`); await pub.arrayBuffer();
  if (pub.status !== 200) { ok = false; console.log(`  ✗ public read of a product photo: ${pub.status}`); }
  const name = `products/__security_probe__/${Date.now()}.txt`;
  const up = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Firebase ${staffTok}`, "Content-Type": "text/plain" }, body: "probe" });
  await up.arrayBuffer();
  if (up.status !== 200) { ok = false; console.log(`  ✗ staff upload to products/: ${up.status}`); }
  else await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`, { method: "DELETE", headers: { Authorization: `Bearer ${OT}` } });
  if (strangerMustFail && strangerTok) {
    const n2 = `products/__security_probe__/s${Date.now()}.txt`;
    const su = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?name=${encodeURIComponent(n2)}`, { method: "POST", headers: { Authorization: `Firebase ${strangerTok}`, "Content-Type": "text/plain" }, body: "probe" });
    await su.arrayBuffer();
    if (su.status === 200) { ok = false; console.log("  ✗ a stranger can still upload to products/"); await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(n2)}`, { method: "DELETE", headers: { Authorization: `Bearer ${OT}` } }); }
  }
  console.log(`  ${label}: ${ok ? "HEALTHY" : "FAILED"}`);
  return ok;
}

let exit = 1;
try {
  const rel = await api("GET", `${RAPI}/${RELEASE}`);
  const prevSet = rel.rulesetName;
  const prevSrc = await api("GET", `${RAPI}/${prevSet}`);
  mkdirSync(join(homedir(), "marathon-rollbacks"), { recursive: true });
  const bk = join(homedir(), "marathon-rollbacks", `storage-rules-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(bk, JSON.stringify({ rulesetName: prevSet, source: prevSrc.source }, null, 2));
  console.log(`backup of LIVE storage ruleset: ${bk}`);
  if (!(await liveCheck("LIVE before", { strangerMustFail: false }))) throw new Error("live not healthy before — not publishing");
  if (DRY) { console.log("--dry-run: not releasing"); exit = 0; }
  else {
    const created = await api("POST", `${RAPI}/projects/${PROJECT}/rulesets`, { source: { files: [{ name: "storage.rules", content: RULES }] } });
    console.log(`  → RELEASING new ruleset to ${BUCKET}`);
    await api("PATCH", `${RAPI}/${RELEASE}`, { release: { name: RELEASE, rulesetName: created.name } });
    await new Promise((r) => setTimeout(r, 15000)); // release propagation
    if (await liveCheck("LIVE after", { strangerMustFail: true })) { exit = 0; console.log("PUBLISHED storage rules."); }
    else {
      console.log("✗ RESTORING previous ruleset");
      await api("PATCH", `${RAPI}/${RELEASE}`, { release: { name: RELEASE, rulesetName: prevSet } });
      await new Promise((r) => setTimeout(r, 15000));
      await liveCheck("LIVE after restore", { strangerMustFail: false });
    }
  }
} finally {
  if (strangerTok) {
    await idt("accounts:delete", { idToken: strangerTok });
    const look = await api("POST", `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [s.localId] });
    console.log(`  probe account deleted: ${look.users ? "NO — STILL PRESENT" : "yes"}`);
  }
}
process.exit(exit);

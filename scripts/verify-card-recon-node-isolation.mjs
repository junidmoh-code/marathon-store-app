// ─── PROVE THE MOVE ACTUALLY WITHHOLDS THE RECORDS ───────────────────────────
// The point of moving /pos/card_batches to top-level /card_batches was that no
// parent grant should reach it. "The rule says owner-only" is not the same
// claim as "a cashier is refused", and only one of them is testable.
//
// This loads a SNAPSHOT OF THE LIVE RULES into the real Firebase rules engine
// (the RTDB emulator) and asks it, as three different callers:
//   • an ordinary signed-in staff account   → must be REFUSED on all three nodes
//   • the same account under /pos           → must still be ALLOWED (proving the
//     token is genuinely a signed-in staff member and the refusals above are
//     about the node, not about the token)
//   • the owner                             → must be ALLOWED
//
// It also pins what is TRUE of the abandoned /pos/card_* paths: no client can
// write them, and — since /pos's blanket read was pushed down to its children
// on 2026-08-29 — no client can read them either.
//
//   node scripts/verify-card-recon-node-isolation.mjs
//
// It runs the live rules with ONE deliberate modification: `".read": "false"`
// spliced onto /pos/card_batches and /pos/card_batch_drafts, so the assertions
// about those two paths test the actual claim (that such a rule is inert)
// rather than a weaker one that would pass anyway.
//
// Needs Java (the emulator is a JVM binary); set JAVA_HOME_BIN if it is not on
// PATH. Fetches the live rules read-only with the Firebase CLI's own
// credentials — it writes nothing to production.
//
// THE TRAP THIS AVOIDS: the RTDB emulator treats ANY `Authorization: Bearer`
// header as its ADMIN BYPASS and skips rules entirely. Tokens go in the
// `?auth=` query parameter, and the self-check below refuses to report anything
// unless a known-denied write is denied AND a known-allowed one is allowed.

import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PORT = 9421, NS = "marathon-club-default-rtdb", HOST = `http://127.0.0.1:${PORT}`;
const OWNER = "gunidmoh@gmail.com";

function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token, grant_type: "refresh_token",
  }).toString();
  return JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-",
    { input: body, encoding: "utf8" })).access_token;
}

const live = await (await fetch(`${DB}/.settings/rules.json?access_token=${accessToken()}`)).text();

// ── HISTORY, KEPT SHORT ─────────────────────────────────────────────────────
// This script used to splice `".read": "false"` onto the two abandoned /pos
// card nodes and assert it did NOTHING — because RTDB read grants cascade down
// from /pos and cannot be revoked by a deeper rule. That was the finding, and
// it is why the obvious one-line fix was never applied.
//
// It is now moot: /pos's blanket `.read` was removed on 2026-08-29 (pushed down
// to each child that needs it, `$other` included), so those nodes have no read
// grant to inherit and are denied outright. The assertions below say that
// plainly. Do not re-add a `".read": "false"` there expecting it to be what
// denies — it would be decoration.
const doc = JSON.parse(live);
const candidate = JSON.stringify(doc, null, 2);

const dir = mkdtempSync(join(tmpdir(), "node-isolation-"));
writeFileSync(join(dir, "rules.json"), candidate);
writeFileSync(join(dir, "firebase.json"), JSON.stringify({
  database: { rules: "rules.json" },
  emulators: { database: { port: PORT, host: "127.0.0.1" }, ui: { enabled: false } },
}));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (uid, email) => `${b64({ alg: "none", typ: "JWT" })}.${b64({
  iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, email,
  firebase: { sign_in_provider: "password", identities: {} },
  iat: (Date.now() / 1e3) | 0, exp: ((Date.now() / 1e3) | 0) + 3600,
})}.`;
const STAFF = tokenFor("staff-uid-1", "cashier@marathon.internal");
const OWNER_TOKEN = tokenFor("owner-uid", OWNER);

async function req(method, path, { as, body } = {}) {
  const auth = as === "owner-admin" ? "" : `&auth=${as}`;
  const res = await fetch(`${HOST}/${path}.json?ns=${NS}${auth}`, {
    method,
    headers: { "Content-Type": "application/json", ...(as === "owner-admin" ? { Authorization: "Bearer owner" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

let pass = 0, fail = 0;
const check = (name, expected, got) => {
  const ok = expected === got;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${expected ? "ALLOW" : "DENY "}  ${name}${ok ? "" : `  (got ${got ? "ALLOW" : "DENY"})`}`);
};

const emu = spawn(process.env.FIREBASE_BIN || "firebase",
  ["emulators:start", "--only", "database", "--project", "marathon-club"],
  { cwd: dir, env: { ...process.env, PATH: `${process.env.JAVA_HOME_BIN || "/opt/homebrew/opt/openjdk/bin"}:${process.env.PATH}` },
    stdio: ["ignore", "ignore", "ignore"] });
const deadline = Date.now() + 90000; let up = false;
while (!up && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  try { const p = await fetch(`${HOST}/.json?ns=${NS}`); if (p.status < 500) up = true; } catch { /* not up */ }
}
if (!up) { emu.kill("SIGTERM"); console.error("emulator did not start"); process.exit(2); }

const NODES = ["card_batches", "card_batch_drafts", "card_batch_overrides"];
try {
  // Seed a record at each node with the admin bypass, so a refusal below is
  // about permission and not about an empty node.
  for (const n of NODES) await req("PUT", `${n}/pe/TID1/1`, { as: "owner-admin", body: { batchNo: 1, probe: true } });
  await req("PUT", "pos/sales/_probe", { as: "owner-admin", body: { total: 1, type: "sale" } });

  console.log("\n── SELF-CHECK (a green run means nothing without this) ──────────");
  const mustAllow = await req("GET", "pos/sales/_probe", { as: STAFF });
  check("this staff token really is a signed-in staff member: /pos is readable", true, mustAllow.ok);
  const mustDeny = await req("PUT", "pos/card_batches/pe/T/1", { as: STAFF, body: { x: 1 } });
  check("and rules ARE being evaluated: a \".write\": false path refuses", false, mustDeny.ok);

  console.log("\n── THE POINT OF THE MOVE ────────────────────────────────────────");
  for (const n of NODES) check(`staff CANNOT read /${n}`, false, (await req("GET", n, { as: STAFF })).ok);
  for (const n of NODES) check(`staff CANNOT read a leaf inside /${n}`, false, (await req("GET", `${n}/pe/TID1/1`, { as: STAFF })).ok);
  for (const n of NODES) check(`staff CANNOT write /${n}`, false, (await req("PUT", `${n}/pe/TID1/2`, { as: STAFF, body: { x: 1 } })).ok);

  console.log("\n── …and the owner still can ─────────────────────────────────────");
  for (const n of NODES) check(`the owner CAN read /${n}`, true, (await req("GET", n, { as: OWNER_TOKEN })).ok);

  console.log("\n── the abandoned /pos paths ─────────────────────────────────────");
  // Seed them with the admin bypass so the read assertions below are about
  // permission and not about an empty node.
  await req("PUT", "pos/card_batches/pe/TID1/1", { as: "owner-admin", body: { batchNo: 1, probe: true } });
  await req("PUT", "pos/card_batch_drafts/u1/d1", { as: "owner-admin", body: { probe: true } });

  // NOTHING CAN BE PUT THERE. This is the control that actually holds.
  check("staff cannot write the abandoned /pos/card_batches", false,
    (await req("PUT", "pos/card_batches/pe/T/9", { as: STAFF, body: { x: 1 } })).ok);
  check("staff cannot write the abandoned /pos/card_batch_drafts", false,
    (await req("PUT", "pos/card_batch_drafts/u/9", { as: STAFF, body: { x: 1 } })).ok);

  // THE THIRD ONE IS CLOSED TOO. It used to have no `.write` of its own; its
  // $storeId/$dayYmd/$tillId rule granted create to any signed-in staff member,
  // gated only by naming an ACTIVE MANAGER as authoriser — so a cashier could
  // attribute an authorisation to a manager who never gave one. The deep rule
  // was removed on 2026-08-29 and the node left NAMED with `.write`: `false`,
  // which matters: deleting it outright would drop it back under /pos/$other,
  // and that grants write.
  //
  // Note the fix could NOT have been a `.write`: `false` layered above the deep
  // rule — write grants cascade downward exactly like read grants, so a
  // shallower `false` cannot revoke a deeper grant. The deep rule had to go.
  const override = (authorizedByUid, tillId) => ({
    reason: "a reason long enough to pass validation", storeId: "pe", tillId,
    dayYmd: "2026-08-29", byUid: "staff-uid-1", authorizedByUid, at: Date.now(),
  });
  // ASSERT THE SEED. The next check claims a write is refused even when it names
  // a REAL active manager — a claim that only means something if the manager
  // actually exists. Discarding this result would let the check pass because the
  // seed silently failed, proving only that an unknown uid is refused.
  // (CodeRabbit, PR #506.)
  const seeded = await req("PUT", "users/mgr-uid/posAccess", { as: "owner-admin", body: { role: "manager", isActive: true } });
  check("the manager fixture actually seeded (else the next check proves nothing)", true, seeded.ok);
  check("a cashier cannot self-authorise an override", false,
    (await req("PUT", "pos/card_batch_overrides/pe/2026-08-29/till-1", { as: STAFF, body: override("staff-uid-1", "till-1") })).ok);
  check("…nor by naming a REAL active manager, which used to be accepted", false,
    (await req("PUT", "pos/card_batch_overrides/pe/2026-08-29/till-2", { as: STAFF, body: override("mgr-uid", "till-2") })).ok);
  check("staff cannot read /pos/card_batch_overrides either", false,
    (await req("GET", "pos/card_batch_overrides", { as: STAFF })).ok);

  // THE RESIDUAL IS CLOSED. These used to expect ALLOWED, with a long comment
  // explaining that a deeper `.read`:`false` could not deny them. /pos's
  // blanket read is gone, so there is nothing to inherit and they are denied
  // because NO rule grants them — which is the only way it could ever have
  // worked.
  check("staff cannot read the abandoned /pos/card_batches", false,
    (await req("GET", "pos/card_batches", { as: STAFF })).ok);
  check("staff cannot read the abandoned /pos/card_batch_drafts", false,
    (await req("GET", "pos/card_batch_drafts", { as: STAFF })).ok);
  check("…nor a leaf inside one", false,
    (await req("GET", "pos/card_batches/pe/TID1/1", { as: STAFF })).ok);
  // …while everything a till actually uses is still readable, from the child
  // grants that replaced the parent's.
  check("but /pos/sales is still readable — the grant moved, it did not vanish", true,
    (await req("GET", "pos/sales", { as: STAFF })).ok);
  check("and so is an UNNAMED /pos child, via $other", true,
    (await req("GET", "pos/some_future_node", { as: STAFF })).ok);
  check("the `.write`:`false` beside it DOES deny", false,
    (await req("PUT", "pos/card_batches/pe/TID1/9", { as: STAFF, body: { x: 1 } })).ok);

  // …which is why the real control is that the paths are DEAD: write-denied to
  // every client, and named by no code in either repo (pinned by
  // functions/test/card-recon-paths.test.cjs here and recordPath.test.js there).
  // The live emptiness check lives outside this emulator run — see the report
  // and scripts/check-abandoned-card-paths.mjs.
} finally { emu.kill("SIGTERM"); }

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

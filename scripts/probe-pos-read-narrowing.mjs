// ─── DECISION SUPPORT: COULD /pos's READ BE NARROWED SAFELY? ─────────────────
// APPLIES NOTHING. Reads the live rules, builds a candidate in memory, and runs
// it through the real rules engine. Nothing is written to production.
//
//   node scripts/probe-pos-read-narrowing.mjs
//
// WHY IT EXISTS. /pos/card_batches and /pos/card_batch_drafts still inherit
// /pos's `.read` — every signed-in staff member. Adding `".read": "false"` to
// them does NOTHING: RTDB read grants cascade downward and cannot be revoked by
// a deeper rule (proved separately). The only real closure is removing /pos's
// own `.read` and pushing it down to the children that need it, which was
// rejected as "re-granting child by child across a block three shops trade
// through". This measures that risk instead of estimating it.
//
// WHAT IT DOES NOT COVER: callers outside these two repos, and anything that
// reads /pos as a whole rather than a child of it. The second is asserted
// below; the first is why this stays a probe and not an apply.
//
// COULD the /pos read grant be narrowed WITHOUT enumerating every reader?
// The rejected framing was "re-grant /pos read child by child", which is scary
// because a missed reader breaks selling. But /pos carries a `$other` wildcard,
// and a wildcard can carry a `.read` too — so the unknowns are covered by one
// entry, not by remembering them.
//
// The candidate: give the 5 named children that currently inherit, plus $other,
// the SAME predicate /pos has today; then delete /pos's own `.read`. Every
// child kept it except the three explicitly-named card nodes, which have no
// `.read` of their own and are outside $other's reach precisely because they
// are named.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { homedir } from "node:os"; import process from "node:process";
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const PORT = 9441, NS = "marathon-club-default-rtdb", HOST = `http://127.0.0.1:${PORT}`;
function accessToken() {
  const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, "utf8"));
  const body = new URLSearchParams({
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
    refresh_token: cfg.tokens.refresh_token, grant_type: "refresh_token" }).toString();
  return JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-", { input: body, encoding: "utf8" })).access_token;
}
const doc = JSON.parse(await (await fetch(`${DB}/.settings/rules.json?access_token=${accessToken()}`)).text());
const pos = doc.rules.pos;
const PRED = pos[".read"];
const INHERITORS = Object.keys(pos).filter((k) => !k.startsWith(".") && pos[k][".read"] === undefined);
const CARD = ["card_batches", "card_batch_drafts", "card_batch_overrides"];
const NEEDS_READ = INHERITORS.filter((k) => !CARD.includes(k));
console.log("children that inherit /pos .read:", INHERITORS.join(", "));
console.log("would get their own .read:      ", NEEDS_READ.join(", "));
console.log("would be left without one:      ", CARD.join(", "), "\n");
for (const k of NEEDS_READ) pos[k][".read"] = PRED;
delete pos[".read"];

const dir = mkdtempSync(join(tmpdir(), "posnarrow-"));
writeFileSync(join(dir, "rules.json"), JSON.stringify(doc, null, 2));
writeFileSync(join(dir, "firebase.json"), JSON.stringify({ database: { rules: "rules.json" },
  emulators: { database: { port: PORT, host: "127.0.0.1" }, ui: { enabled: false } } }));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const STAFF = `${b64({alg:"none",typ:"JWT"})}.${b64({iss:`https://securetoken.google.com/${NS}`,aud:NS,sub:"s1",user_id:"s1",
  email:"cashier@marathon.internal",firebase:{sign_in_provider:"password",identities:{}},iat:(Date.now()/1e3)|0,exp:((Date.now()/1e3)|0)+3600})}.`;
const req = async (m, p, o = {}) => { const admin = o.as === "admin";
  const r = await fetch(`${HOST}/${p}.json?ns=${NS}${admin ? "" : `&auth=${STAFF}`}`, { method: m,
    headers: { "Content-Type": "application/json", ...(admin ? { Authorization: "Bearer owner" } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { ok: r.ok, status: r.status }; };
const emu = spawn("firebase", ["emulators:start","--only","database","--project","marathon-club"],
  { cwd: dir, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk/bin:${process.env.PATH}` }, stdio: ["ignore","ignore","ignore"] });
const dl = Date.now()+90000; let up=false;
while(!up && Date.now()<dl){ await new Promise(r=>setTimeout(r,500)); try{const p=await fetch(`${HOST}/.json?ns=${NS}`); if(p.status<500) up=true;}catch{} }
if(!up){emu.kill();console.error("emulator did not start");process.exit(2);}
let pass=0, fail=0;
const check=(n,e,g)=>{const ok=e===g;ok?pass++:fail++;console.log(`  ${ok?"ok  ":"FAIL"} ${e?"ALLOW":"DENY "}  ${n}${ok?"":`  (got ${g?"ALLOW":"DENY"})`}`);};
try {
  for (const p of ["pos/sales/s1","pos/paymentEvents/e1","pos/storeCredits/c1","pos/audit/a1","pos/storeCreditQueue/q1",
                   "pos/cash_sessions/x1","pos/devices/d1","pos/noReceiptReturns/n1","pos/some_future_node/f1",
                   "pos/card_batches/pe/T/1","pos/card_batch_drafts/u/d","pos/card_batch_overrides/pe/2026-08-29/till-1"])
    await req("PUT", p, { as: "admin", body: { probe: true } });
  console.log("EVERY READER THAT MUST KEEP WORKING:");
  for (const p of ["pos/sales","pos/paymentEvents","pos/storeCredits","pos/audit","pos/storeCreditQueue",
                   "pos/cash_sessions","pos/devices"])
    check(`staff read /${p}`, true, (await req("GET", p)).ok);
  check("staff read an UNNAMED future /pos child (covered by $other)", true, (await req("GET","pos/some_future_node")).ok);

  // THE NODES THAT ONLY $other COVERS, and that both apps really use. These are
  // not hypothetical: /pos/cashups, /pos/config, /pos/creditLedger and
  // /pos/pinAttempts have no rule of their own, so WITHOUT a `.read` on $other
  // this change would have taken out the cash-up, the POS config, the credit
  // ledger behind store credit and on-account, and the PIN throttle — all at
  // once, and only on the shop floor. Enumerated by grepping every "pos/<child>"
  // literal in both repos, not by memory.
  for (const child of ["cashups", "config", "creditLedger", "pinAttempts"]) {
    await req("PUT", `pos/${child}/probe`, { as: "admin", body: { probe: true } });
    check(`staff read /pos/${child} (no rule of its own — $other or nothing)`, true,
      (await req("GET", `pos/${child}`)).ok);
  }

  // THE PARENT-LEVEL READ. Child grants do not authorise a read AT /pos, or a
  // listener/query attached there — so pushing `.read` down would break any
  // caller that subscribes to the whole block. This is the one case child-path
  // checks cannot tell you about. (CodeRabbit, PR #504.)
  //
  // Expected DENY, and that is fine ONLY because nothing does it: neither repo
  // contains a `ref(database, "pos")` or an equivalent parent-level
  // subscription — grepped both `src/` trees. If that ever changes, this
  // narrowing stops being safe and this assertion is where you find out.
  check("a read AT /pos itself is denied once .read moves down", false, (await req("GET", "pos")).ok);
  // THE ONE BEHAVIOURAL CHANGE, and it is not a break — it is a rule that has
  // never worked starting to work. /pos/noReceiptReturns carries its own
  // `.read` restricting it to the owner or an ACTIVE MANAGER. That rule is dead
  // today: /pos's broader grant lets every staff member read straight past it,
  // exactly as it lets them read the card nodes. Remove the parent grant and
  // the restriction its author intended finally applies.
  //
  // Expected DENY here for an ordinary cashier. Whether that is desirable is
  // Junid's call, not this script's — but it should be a decision rather than a
  // surprise on the day.
  console.log("\nTHE ONE BEHAVIOURAL CHANGE (a dead rule waking up):");
  check("an ordinary cashier reads /pos/noReceiptReturns", false, (await req("GET","pos/noReceiptReturns")).ok);

  console.log("\nAND THE THREE THAT SHOULD GO DARK:");
  for (const n of CARD) check(`staff read /pos/${n}`, false, (await req("GET", `pos/${n}`)).ok);
  console.log("\nWRITES MUST BE UNAFFECTED:");
  check("staff can still write a sale", true, (await req("PUT","pos/sales/s2",{body:{total:1,type:"sale"}})).ok);
  check("staff still cannot write /pos/card_batches", false, (await req("PUT","pos/card_batches/pe/T/2",{body:{x:1}})).ok);
} finally { emu.kill("SIGTERM"); }
console.log(`\n${fail===0?"ALL GREEN":"FAILURES"} — ${pass} passed, ${fail} failed`);

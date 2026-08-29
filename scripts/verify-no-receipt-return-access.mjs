// ─── WHO CAN SEE AND MAKE A NO-RECEIPT RETURN ────────────────────────────────
// A no-receipt return hands out store credit with no proof of purchase — the
// one flow in the POS with no receipt behind it. Its RTDB node carried a
// manager-only `.read` that NEVER APPLIED: /pos's blanket `.read` let every
// signed-in staff member read straight past it, the same way it made a
// `.read`: `false` on the card nodes inert. Removing that blanket grant on
// 2026-08-29 made the restriction its author wrote finally take effect.
//
// This asserts what changed and what did not, against the LIVE rules:
//   • the WRITE was always manager-or-owner only — a cashier never could, and
//     still cannot. Nothing about who can MAKE a no-receipt return moved.
//   • the READ is now manager-or-owner only too, matching the write.
//   • the marker still commits inside the multi-path update it rides in.
//
//   node scripts/verify-no-receipt-return-access.mjs
//
// Needs Java (the emulator is a JVM binary); set JAVA_HOME_BIN if not on PATH.
// Reads the live rules; writes nothing to production.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { homedir } from "node:os"; import process from "node:process";
const DB="https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app", PORT=9461, NS="marathon-club-default-rtdb", HOST=`http://127.0.0.1:${PORT}`;
const cfg=JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`,"utf8"));
const tk=JSON.parse(execSync("curl -sS -X POST https://oauth2.googleapis.com/token -d @-",{input:new URLSearchParams({client_id:"563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",client_secret:"j9iVZfS8kkCEFUPaAeJV0sAi",refresh_token:cfg.tokens.refresh_token,grant_type:"refresh_token"}).toString(),encoding:"utf8"})).access_token;
const live=await (await fetch(`${DB}/.settings/rules.json?access_token=${tk}`)).text();
const dir=mkdtempSync(join(tmpdir(),"nrr-"));
writeFileSync(join(dir,"rules.json"),live);
writeFileSync(join(dir,"firebase.json"),JSON.stringify({database:{rules:"rules.json"},emulators:{database:{port:PORT,host:"127.0.0.1"},ui:{enabled:false}}}));
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const T=(uid,email)=>`${b64({alg:"none",typ:"JWT"})}.${b64({iss:`https://securetoken.google.com/${NS}`,aud:NS,sub:uid,user_id:uid,email,firebase:{sign_in_provider:"password",identities:{}},iat:(Date.now()/1e3)|0,exp:((Date.now()/1e3)|0)+3600})}.`;
const CASHIER=T("cashier-uid","c@marathon.internal"), MGR=T("mgr-uid","m@marathon.internal"), OWNER=T("owner-uid","gunidmoh@gmail.com");
const req=async(m,p,{as,body}={})=>{const admin=as==="admin";const r=await fetch(`${HOST}/${p}.json?ns=${NS}${admin?"":`&auth=${as}`}`,{method:m,headers:{"Content-Type":"application/json",...(admin?{Authorization:"Bearer owner"}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {ok:r.ok};};
const emu=spawn("firebase",["emulators:start","--only","database","--project","marathon-club"],{cwd:dir,env:{...process.env,PATH:`/opt/homebrew/opt/openjdk/bin:${process.env.PATH}`},stdio:["ignore","ignore","ignore"]});
const dl=Date.now()+90000;let up=false;
while(!up&&Date.now()<dl){await new Promise(r=>setTimeout(r,500));try{const p=await fetch(`${HOST}/.json?ns=${NS}`);if(p.status<500)up=true;}catch{}}
if(!up){emu.kill();console.error("emulator did not start");process.exit(2);}
let pass=0,fail=0;const check=(n,e,g)=>{const ok=e===g;ok?pass++:fail++;console.log(`  ${ok?"ok  ":"FAIL"} ${e?"ALLOW":"DENY "}  ${n}`);};
try{
  await req("PUT","users/mgr-uid/posAccess",{as:"admin",body:{role:"manager",isActive:true}});
  const marker=(saleId,uid)=>({ saleId, creditId:"cr-1", authorizedBy:uid, totalCents:5000, at:Date.now() });
  // The WRITE was already manager/owner-gated — a plain cashier never could.
  // So the read restriction activating does not narrow who can use the feature;
  // it aligns read with write, which is what its author wrote in the first place.
  check("a plain cashier could never write it either (unchanged)", false,
    (await req("PUT","pos/noReceiptReturns/SALE-NRR-0",{as:CASHIER,body:marker("SALE-NRR-0","cashier-uid")})).ok);
  check("an active MANAGER can still WRITE the marker", true,
    (await req("PUT","pos/noReceiptReturns/SALE-NRR-1",{as:MGR,body:marker("SALE-NRR-1","mgr-uid")})).ok);
  check("…and the whole multi-path update it rides in still commits", true,
    (await req("PATCH","",{as:MGR,body:{
      "pos/sales/SALE-NRR-2":{total:-5000,type:"no_receipt_return"},
      "pos/noReceiptReturns/SALE-NRR-2":marker("SALE-NRR-2","mgr-uid"),
    }})).ok);
  console.log("\n  the read, which is the part that changed:");
  check("a cashier can no longer READ it (the rule its author wrote, finally live)", false,
    (await req("GET","pos/noReceiptReturns",{as:CASHIER})).ok);
  check("an active MANAGER can read it", true, (await req("GET","pos/noReceiptReturns",{as:MGR})).ok);
  check("the owner can read it", true, (await req("GET","pos/noReceiptReturns",{as:OWNER})).ok);
}finally{emu.kill("SIGTERM");}
console.log(`\n${fail===0?"ALL GREEN":"FAILURES"} — ${pass} passed, ${fail} failed`);

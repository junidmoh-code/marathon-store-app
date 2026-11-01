# Mutation proof for the scan-only guards (PR #833). Run in a THROWAWAY worktree
# with node_modules linked; commit first. Each guard is broken once; its test must
# go red and green again when restored. (M-HOLD: run with -t "a hold raises NOTHING"
# — the gate file also holds a test that already fails on main.)
import subprocess,sys,os
os.environ["FIREBASE_DATABASE_EMULATOR_HOST"]="127.0.0.1:9"
M=[
("M-SPOOF-SCAN","functions/lib/request-source.cjs",'if (rr.requestSource === REQUEST_SOURCE.SCAN) return cf.engine === true ? REQUEST_SOURCE.SCAN : null;','if (rr.requestSource === REQUEST_SOURCE.SCAN) return REQUEST_SOURCE.SCAN;',"node"),
("M-REJECT-UNKNOWN","functions/lib/request-source.cjs",'  if (rr.requestSource != null) return null;   // an unknown tag is not a pass\n','',"node"),
("M-TOUCHED","functions/lib/request-source.cjs",'  if (Number(cur.sentQty) > 0 || cur.fulfilledBy || cur.picking) return undefined;\n','',"node"),
("M-ESC-START","scripts/shopify/onlineOrders/escalate.mjs",'&& (SCAN_ONLY_REQUESTS ? settles :','&& (SCAN_ONLY_REQUESTS ? (settles || FAILED_LINE.has(st)) :',"vit"),
("M-ESC-STOP","scripts/shopify/onlineOrders/escalate.mjs",'  if (SCAN_ONLY_REQUESTS && line.escalation && (line.escalation.phase === ESC_PHASE.RAISE','  if (false && line.escalation && (line.escalation.phase === ESC_PHASE.RAISE',"vit"),
("M-ESC-RAISE+START","scripts/shopify/onlineOrders/escalate.mjs",'      if (SCAN_ONLY_REQUESTS) return null;\n','',"vitpair"),
("M-HOLD","src/App.jsx",'    // ── RELEASING a hold withdraws its still-open refill ask','    if (status === STATUS.COMING_TOMORROW) { const plan = onHoldRefillPlan(order, { nowIso: now, saDate: getSADateString() }); }\n    // ── RELEASING a hold withdraws its still-open refill ask',"gate"),
("M-SOLVE-TAG","src/components/stock/firstBatchCore.js",'      requestSource: "solve",   // a Solve, not a request (refillRequestSourceGuard, 1 Nov 2026)\n','',"fb"),
]
def run(kind):
  if kind=="node": c="cd functions && node --test test/request-source.test.cjs"
  elif kind=="gate": c="npx vitest run src/signedInPillAndHoldMerge.gate.test.js"
  elif kind=="fb": c="npx vitest run src/components/stock/firstBatchCore.test.js"
  else: c="npx vitest run scripts/shopify/onlineOrders/escalate.test.mjs scripts/shopify/onlineOrders/poll.test.mjs"
  return subprocess.run(c,shell=True,capture_output=True).returncode==0
for mid,f,a,b,kind in M:
  s=open(f).read()
  if s.count(a)!=1: print(mid,"ANCHOR",s.count(a)); continue
  if kind=="vitpair":
    s2=s.replace(a,b).replace('&& (SCAN_ONLY_REQUESTS ? settles :','&& (SCAN_ONLY_REQUESTS ? (settles || FAILED_LINE.has(st)) :'); kind="vit"
  else: s2=s.replace(a,b)
  open(f,'w').write(s2); mut=run(kind); open(f,'w').write(s); rest=run(kind)
  print(mid, "mutated:"+("PASS" if mut else "FAIL"), "restored:"+("PASS" if rest else "FAIL"), "PROVEN" if (not mut and rest) else "NOT PROVEN")

#!/usr/bin/env python3
# ── Online orders: mutation check across BOTH repos ─────────────────────────
# Breaks each guarded behaviour on purpose and requires the suites to fail.
# NEVER run it in a working checkout (it edits files; memory: a mutation once
# leaked into a commit). Make throwaway worktrees at the commits under test:
#
#   git -C <store-app> worktree add --detach ../oo-mutate HEAD && ln -s <store-app>/node_modules ../oo-mutate/node_modules
#   git -C <pos-app>   worktree add --detach ../pos-oo-mutate HEAD && ln -s <pos-app>/node_modules ../pos-oo-mutate/node_modules
#   STORE_ROOT=…/oo-mutate POS_ROOT=…/pos-oo-mutate python3 scripts/online-orders/mutation-check.py [n]
#
# Every line must read KILLED. Each file is restored after its run.
import subprocess, sys, os
STORE = os.environ["STORE_ROOT"]
POS = os.environ["POS_ROOT"]
ST = ["npx","vitest","run","scripts/shopify/onlineOrders","scripts/shopify/onlineHolds.test.mjs"]
PT = ["npx","vitest","run","src/onlineOrders","src/stock/__tests__/saleStockMovements.deductFrom.test.js","src/sale/__tests__/onlineTender.test.js"]
M = [
 ("routing: no split (take everything at the first place)", STORE, "scripts/shopify/onlineOrders/routing.mjs", "const take = Math.min(remaining, units(available[step.locationId]));", "const take = units(available[step.locationId]) > 0 ? remaining : 0;", ST),
 ("routing: Trophy before PE", STORE, "scripts/shopify/onlineOrders/routing.mjs", 'Object.freeze({ locationId: "marathon-pe", status: "display" }),\n  Object.freeze({ locationId: "trophy", status: "display" }),', 'Object.freeze({ locationId: "trophy", status: "display" }),\n  Object.freeze({ locationId: "marathon-pe", status: "display" }),', ST),
 ("routing: remainder silently dropped", STORE, "scripts/shopify/onlineOrders/routing.mjs", '  pieces.push({ qty: remaining, locationId: null, status: "no_stock" });\n  return pieces;', '  return pieces;', ST),
 ("routing: own hold counts against itself", STORE, "scripts/shopify/onlineOrders/routing.mjs", "if (oid === orderId || !row", "if (!row", ST),
 ("holds: subtract the whole reservation (double count)", STORE, "scripts/shopify/inventorySync.mjs", "return gone + Math.max(0, r - gone - c);", "return r;", ST),
 ("holds: released holds netted against committed", STORE, "scripts/shopify/inventorySync.mjs", "const gone = Math.min(r, Math.max(0, Number(released) || 0));", "const gone = 0;", ST),
 ("holds: push ignores reservations", STORE, "scripts/shopify/inventorySync.mjs", "onlineHoldAdjustment(reserved?.[i.sizeKey], committed?.get?.(i.inventoryItemId), released?.[i.sizeKey])", "0", ST),
 ("holds: a packed order still holds", STORE, "scripts/shopify/onlineOrders/orderModel.mjs", "  if (!HOLDING_STATUSES.includes(order?.status)) return rows;\n", "", ST),
 ("holds: no write-then-verify on a pack race", STORE, "scripts/shopify/onlineOrders/poll.mjs", "for (const key of Object.keys(want)) await db.ref(`${ONLINE_RESERVATIONS_PATH}/${key}/${id}`).set(null);", "void want;", ST),
 ("ingest: unpaid/part-fulfilled orders pulled in", STORE, "scripts/shopify/onlineOrders/poll.mjs", "if (existing || !isIngestible(node)) return;", "if (existing) return;", ST),
 ("pack: a handed-by-hand order can be packed", POS, "src/onlineOrders/orderView.js", "  if (!OPEN_STATUSES.includes(order.status)) return", "  if (false) return", PT),
 ("guard: boundary (=0 blocks)", POS, "src/onlineOrders/walkinGuard.js", "if (left >= 0) return { block: false, reason: \"free\" };", "if (left > 0) return { block: false, reason: \"free\" };", PT),
 ("guard: ignores the hold's location", POS, "src/onlineOrders/walkinGuard.js", "const q = Number(row.locs?.[loc]);", "const q = Number(row.qty);", PT),
 ("pack: sale without the hold release", POS, "src/onlineOrders/packDraft.js", "for (const k of keys) out[`${ONLINE_RESERVATIONS_PATH}/${l.pid}/${k}/${orderId}`] = null;", "void keys;", PT),
 ("pack: hold release without the sale (separate, earlier write)", POS, "src/sale/engine.js", "    mergeExtraUpdates(updates, extra);", "    await update(ref(database), extra);", PT),
 ("pack: riders dropped from the sale update", POS, "src/sale/engine.js", "    mergeExtraUpdates(updates, extra);", "    void extra;", PT),
 ("deduct: per-line location ignored", POS, "src/stock/saleStockMovements.js", "locOverride: l.deductFrom ?? routeFor(routes, l)", "locOverride: routeFor(routes, l)", PT),
]
only = sys.argv[1:] and int(sys.argv[1])
results = []
for i, (name, root, f, a, b, cmd) in enumerate(M):
    if only and i+1 != only: continue
    p = os.path.join(root, f); s = open(p).read()
    if s.count(a) != 1:
        results.append((name, f"TARGET NOT FOUND ({s.count(a)})")); continue
    open(p, "w").write(s.replace(a, b))
    try:
        r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=600)
        killed = r.returncode != 0
        tail = [l for l in r.stdout.splitlines() if "Tests " in l]
        results.append((name, ("KILLED " if killed else "SURVIVED ") + (tail[-1].strip() if tail else "")))
    finally:
        open(p, "w").write(s)
for n, v in results: print(f"{v:60}  {n}")

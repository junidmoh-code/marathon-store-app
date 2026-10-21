#!/usr/bin/env python3
# ── Escalation, partial pack and the customer agent: mutation check ─────────
# Breaks each guarded behaviour on purpose and requires the suites to fail.
# NEVER run it in a working checkout (it edits files). Throwaway worktrees:
#
#   git -C <store-app> worktree add --detach ../esc-mutate HEAD && ln -s <store-app>/node_modules ../esc-mutate/node_modules && ln -s <store-app>/functions/node_modules ../esc-mutate/functions/node_modules
#   git -C <pos-app>   worktree add --detach ../pos-esc-mutate HEAD && ln -s <pos-app>/node_modules ../pos-esc-mutate/node_modules
#   STORE_ROOT=…/esc-mutate POS_ROOT=…/pos-esc-mutate python3 scripts/online-orders/mutation-check-escalation.py [n]
#
# Every line must read KILLED. Each file is restored after its run.
import subprocess, sys, os
STORE = os.environ["STORE_ROOT"]
POS = os.environ["POS_ROOT"]
ENV = {**os.environ, "FIREBASE_DATABASE_EMULATOR_HOST": "127.0.0.1:9"}  # a test can never reach the live database
ST = (["npx","vitest","run","scripts/shopify/onlineOrders","scripts/online","src/utils/onlineEscalation.test.js","src/components/onlineOrders"], "")
FT = (["node","--test","test/refill-satisfied.test.cjs"], "functions")
PT = (["npx","vitest","run","src/onlineOrders"], "")
E = "src/utils/onlineEscalation.js"
IO = "scripts/shopify/onlineOrders/escalate.mjs"
CORE = "scripts/online/agent/core.mjs"
RUN = "scripts/online/agent/run.mjs"
M = [
 # ── the chains ──
 ("footwear round 2 ignores how round 1 ended", STORE, E, "    return centralRejected\n      ? [{ step: STEP.RECHECK, at: home }]\n      : [{ step: STEP.REFILL, from: CENTRAL, to: home }];", "    return [{ step: STEP.REFILL, from: CENTRAL, to: home }];", ST),
 ("no round 2 at all", STORE, E, "  if (esc.round === 1) {", "  if (false) {", ST),
 ("non-footwear round 2 without the CHECK PROPERLY re-check", STORE, E, "    return round === 1 ? r1 : [{ step: STEP.RECHECK, at: home }, ...r1];", "    return r1;", ST),
 ("round 2 asks the shop with no CHECK PROPERLY flag", STORE, E, "deliverAt: step.at, checkProperly: true,", "deliverAt: step.at, checkProperly: false,", ST),
 ("fulfilled request delivered at once (no next-day wait)", STORE, E, "waitUntil: nextDeliveryAt(sentAt)", "waitUntil: sentAt", ST),
 ("Sunday counted as a working day", STORE, E, "  if (new Date(t).getUTCDay() === 0) t += 24 * 3600 * 1000; // Sunday → Monday\n", "", ST),
 ("a person's Out of Stock not read as a rejection", STORE, E, '    if (r == null || r === "first_batch_central_declined") return { outcome: "rejected" };', '    if (r === "first_batch_central_declined") return { outcome: "rejected" };', ST),
 ("a repeated 'raised' skips a step", STORE, E, '      if (event.type !== "raised" || !step) return esc;', '      if (!step) return esc;', ST),
 # ── restart safety / primitives ──
 ("intent ignored: a crash re-draws the R-number", STORE, IO, "let pending = esc.pending && esc.pending.escKey === escKey ? esc.pending : null;", "let pending = null;", ST),
 ("a recycled R-number's card is overwritten", STORE, IO, "const res = await db.ref(`orders/${pending.key}`).transaction((cur) => (cur == null ? card : undefined));", "const res = await db.ref(`orders/${pending.key}`).transaction(() => card);", ST),
 ("escalation does not take over the attention (Junid emailed)", STORE, IO, "  if (changed) await clearEscalatedAttention(ctx, orderId, now);", "  void clearEscalatedAttention;", ST),
 ("no second pass after keep: a hub Out of Stock is emailed", STORE, "scripts/shopify/onlineOrders/poll.mjs", "if (fresh && linesOf(fresh).some(needsEscalationStart) && await escalateOrder(ctx, id, fresh, escalationHelpers(ctx))) {", "if (false) {", ST),
 ("the switch does not gate escalation", STORE, "scripts/shopify/onlineOrders/poll.mjs", "  ctx.escalate = ctx.enabled && (await get(`${ONLINE_ORDERS_CONFIG_PATH}/escalationOff`)) !== true;", "  ctx.escalate = true;", ST),
 ("a packed order stops holding its resolving line", STORE, "scripts/shopify/onlineOrders/orderModel.mjs", "    if (packed && st !== LINE_STATUS.RESOLVING) continue;", "    if (packed) continue;", ST),
 ("engine withdraws an escalation row as already_in_stock", STORE, "functions/lib/refill-engine.cjs", '      if (r.createdFrom && r.createdFrom.via === "online_escalation") continue;\n', "", FT),
 # ── partial pack ──
 ("POS: parked lines go into the sale", POS, "src/onlineOrders/packDraft.js", "  const packed = entries.filter(([, l]) => !isParkedLine(l));", "  const packed = entries;", PT),
 ("POS: Pack waits for parked lines' basket tick", POS, "src/onlineOrders/orderView.js", "  for (const [i, l] of entries) {\n    if (isParkedLine(l)) continue;", "  for (const [i, l] of entries) {", PT),
 ("POS: the parcel's lines are not named for Shopify", POS, "src/onlineOrders/packDraft.js", "  out[`${base}/packedLines`] = packedLines;", "  void packedLines;", PT),
 ("POS: a resolving line's hold released by the pack", POS, "src/onlineOrders/packDraft.js", "    if (!l.pid || keep.has(`${l.pid}|${stockSizeKey(l.size)}`)) continue;", "    if (!l.pid) continue;", PT),
 ("store: a partial pack fulfils the whole order", STORE, "scripts/shopify/onlineOrders/partialFulfil.mjs", "  if (!partial) return null;", "  return null;", ST),
 ("store: baseline ignored (a 502 that applied is fulfilled twice)", STORE, "scripts/shopify/onlineOrders/shopifyOrders.mjs", "    const owe = (Number(baseline?.[li.id]) || 0) + (Number(packed[li.id]) || 0) - fulfilledNow(li);", "    const owe = (Number(packed[li.id]) || 0);", ST),
 # ── the agent's guards ──
 ("credit AND refund on one line", STORE, CORE, "  if (money) return { ok: false, why: `this line already has a ${money.kind} (${rands(money.amountCents)}) — never both, never twice` };\n", "", ST),
 ("more than the paid value", STORE, CORE, "  if (amountCents > paid) return", "  if (false) return", ST),
 ("outbound cap lifted", STORE, CORE, "  return (Number(conversation?.outbound) || 0) < MAX_OUTBOUND;", "  return (Number(conversation?.outbound) || 0) < 99;", ST),
 ("send without reserving a slot", STORE, RUN, "    if (!c || !canSend(c)) return undefined;", "    if (!c) return undefined;", ST),
 ("a dearer swap is allowed (customer charged more)", STORE, CORE, "  if (cost > paid) return", "  if (false) return", ST),
 ("the same reply acted on twice", STORE, RUN, "      if (!c || c.seen?.[r.key]) return undefined;", "      if (!c) return undefined;", ST),
 ("model text with links/money accepted", STORE, CORE, "  if (LINK_OR_MONEY.test(t)) return null;\n", "", ST),
 ("a second conversation on a line", STORE, RUN, "    if (cur.resolution?.conversation) return undefined;\n    return { ...cur, resolution: { ...(cur.resolution || {}), conversation: {", "    return { ...cur, resolution: { ...(cur.resolution || {}), conversation: {", ST),
 ("a swapped item failing again re-opens the customer", STORE, RUN, '  if (conv.state === "closed" && line.source?.status === LINE_STATUS.UNAVAILABLE) {', "  if (false) {", ST),
]
only = sys.argv[1:] and int(sys.argv[1])
results = []
for i, (name, root, f, a, b, (cmd, sub)) in enumerate(M):
    if only and i+1 != only: continue
    p = os.path.join(root, f); s = open(p).read()
    if s.count(a) != 1:
        results.append((name, f"TARGET NOT FOUND ({s.count(a)})")); continue
    open(p, "w").write(s.replace(a, b))
    try:
        r = subprocess.run(cmd, cwd=os.path.join(root, sub), capture_output=True, text=True, timeout=900, env=ENV)
        killed = r.returncode != 0
        tail = [l for l in (r.stdout + r.stderr).splitlines() if "Tests " in l or l.startswith("# fail")]
        results.append((name, ("KILLED " if killed else "SURVIVED ") + (tail[-1].strip() if tail else "")))
    finally:
        open(p, "w").write(s)
for n, v in results: print(f"{v:60}  {n}")
print(f"\n{sum(1 for _, v in results if v.startswith('KILLED'))}/{len(results)} killed")

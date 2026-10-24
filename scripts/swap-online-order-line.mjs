#!/usr/bin/env node
// Swap one line of a website order for another product, on the live records the till app reads
// (scripts/lib/swap-line.mjs has the rules and is what the dm-agent calls in-process).
//
//   node scripts/swap-online-order-line.mjs --order <orderKey> --line <index> --pid <newPid> --size <size|_> [--dry] [--allow-higher]
//
// Prints Junid's one line: "#1776 updated: <old> → <new>, pick raised at <place>".
import { swapOnlineOrderLine } from "./lib/swap-line.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null)).filter(Boolean));
if (!args.order || args.line == null || !args.pid) {
  console.error("usage: --order <orderKey> --line <index> --pid <newPid> --size <size|_> [--dry] [--allow-higher]");
  process.exit(2);
}
const r = await swapOnlineOrderLine({ orderKey: String(args.order), lineIndex: Number(args.line), newPid: String(args.pid), size: args.size ?? "_", dry: args.dry === "true", allowHigher: args["allow-higher"] === "true", log: (m) => console.log(m) });
console.log(r.summary);
if (r.plan) {
  const p = r.plan;
  console.log(`  stock (on hand / free): ${Object.entries(p.stock).map(([l, s]) => `${l} ${s.onHand}/${s.free}`).join(", ")}`);
  console.log(`  route: ${p.route.status} at ${p.route.place}; price paid R${p.price.paidCents / 100} → R${p.price.newCents / 100}${p.price.creditCents ? ` (R${p.price.creditCents / 100} back as store credit, not issued here)` : ""}`);
  if (p.oldSource) console.log(`  old line state: ${JSON.stringify(p.oldSource)}${p.oldEscalation ? `; escalation ${p.oldEscalation.phase}${p.oldEscalation.request ? ` (${p.oldEscalation.request.kind} ${p.oldEscalation.request.key} ${p.oldEscalation.request.from} → ${p.oldEscalation.request.to})` : ""}` : ""}`);
  if (p.willRemoveHubOrders?.length) console.log(`  hub order(s) to remove: ${p.willRemoveHubOrders.join(", ")} (a pair already sent is left for the shop to return)`);
  if (p.willTombstoneEntry) console.log(`  display entry to close: ${p.willTombstoneEntry}`);
  if (p.willWithdrawRequest) console.log(`  escalation request to withdraw: ${p.willWithdrawRequest.kind} ${p.willWithdrawRequest.key}`);
  console.log("  Shopify: the order's line item is not edited (no write_orders scope); the pack fulfils the original line item.");
}
for (const n of r.notes || []) console.log(`  ${n}`);
process.exit(r.ok ? 0 : 1);

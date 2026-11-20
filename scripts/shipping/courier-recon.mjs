// ── The courier reconciliation runner (Mac mini, launchd com.marathon.courierrecon)
// Every 3 hours: scripts/shipping/reconcile.mjs runReconcile — invoiced amount
// per delivered waybill onto its order, the >5% diffs, the parcel-table
// calibration, Junid's over-ceiling lines and the Monday weekly line.
// READS ONLY at Courier Guy (GET /shipments); it never books or cancels.
//
// JUNID'S LINES go through Jamie's own WhatsApp session: this queues each one
// with marathon-dm-agent's bin/jimmy-send.mjs --kind junid (the gate sends it
// to Junid's number on its next tick; nothing is sent from here). The
// dm-agent checkout defaults to ~/marathon-dm-agent (COURIER_JIMMY_DIR).
//
//   node scripts/shipping/courier-recon.mjs            one pass (what launchd runs)
//   node scripts/shipping/courier-recon.mjs --dry      one pass, nothing written or sent
//   node scripts/shipping/courier-recon.mjs --adjustments   READ ONLY: every order Courier Guy billed differently
//                                                      from what was booked (/shipping_recon/adjustments), newest first
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createCourierClient, fileLogger } from "./courier-client.mjs";
import { adminDb } from "./adminDb.mjs";
import { runReconcile } from "./reconcile.mjs";

export const JUNID_WHATSAPP = "27813995333";

/** Queue one line for Junid through Jamie. → true when jimmy-send accepted it. */
export function jimmySender({ dir = process.env.COURIER_JIMMY_DIR || join(homedir(), "marathon-dm-agent"), log = () => {}, run = execFile } = {}) {
  const bin = join(dir, "bin", "jimmy-send.mjs");
  return (text, ref) => new Promise((resolve) => {
    if (!existsSync(bin)) { log(`recon: no ${bin} — line kept for the next pass: ${text}`); return resolve(false); }
    run(process.execPath, [bin, "--kind", "junid", "--to", JUNID_WHATSAPP, "--text", text, "--ref", ref], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) { log(`recon: jimmy-send refused (${String(stderr || err.message).trim().slice(0, 200)}) — kept for the next pass`); return resolve(false); }
      log(`recon: line queued for Junid (${ref}): ${text}`);
      resolve(true);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--adjustments")) {
    const rows = Object.values((await adminDb().ref("shipping_recon/adjustments").get()).val() ?? {}).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    for (const line of adjustmentLines(rows)) console.log(line);
    process.exit(0);
  }
  const dry = process.argv.includes("--dry");
  const log = (line) => { console.log(line); fileLogger()(line); };
  const real = adminDb();
  const db = dry ? dryDb(real) : real;
  const sendJunid = dry ? async (text, ref) => { log(`DRY would send (${ref}): ${text}`); return false; } : jimmySender({ log });
  const out = await runReconcile({ db, client: createCourierClient({ log: fileLogger() }), sendJunid, now: Date.now(), log });
  log(`courier-recon ${dry ? "DRY " : ""}${JSON.stringify(out)}`);
  process.exit(0);
}

/** The --adjustments listing. Pure. */
export function adjustmentLines(rows) {
  if (!rows.length) return ["No billed-vs-booked adjustments recorded yet (an order is reconciled once delivered and invoiced)."];
  const r2 = (n) => `R${Number(n).toFixed(2)}`;
  const total = rows.reduce((t, a) => t + (Number(a.diff) || 0), 0);
  return [
    ...rows.map((a) => `${new Date(a.at).toISOString().slice(0, 10)}  order ${a.orderId}  ${(a.waybills ?? []).join("+")}  booked ${r2(a.booked)}  billed ${r2(a.billed)}  ${a.diff > 0 ? "+" : "-"}${r2(Math.abs(a.diff))}` +
      (a.measured ? `  measured ${a.measured.slice(0, 3).join("x")} cm ${a.measured[3]} kg` : "")),
    `${rows.length} adjusted order(s), net ${total > 0 ? "+" : "-"}${r2(Math.abs(total))} against what was booked.`,
  ];
}

// Reads pass through; every write is logged and dropped.
function dryDb(db) {
  const wrap = (ref, path) => new Proxy(ref, {
    get(t, k) {
      if (["set", "update", "push", "remove"].includes(k)) return async (v) => { console.log(`DRY ${String(k)} ${path} ${JSON.stringify(v)?.slice(0, 300)}`); };
      const v = t[k];
      if (["orderByChild", "equalTo", "child"].includes(k)) return (...a) => wrap(v.apply(t, a), path);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ref: (p = "") => wrap(db.ref(p), p) };
}

#!/usr/bin/env node
// Add "hub" and "placedAtHub" to /orders' .indexOn in the LIVE, console-managed
// marathon-club RTDB rules (Junid, 26 Nov 2026). Additive only. Dry run by
// default; writes only with --apply. Never touches database.rules.json.
//
//   node scripts/rules/apply-orders-hub-index.mjs           # show the change
//   node scripts/rules/apply-orders-hub-index.mjs --apply   # backup + write + verify
//
// Same method as apply-shopify-publish-updatedat-index.mjs: GET live → backup
// (~/marathon-rollbacks) → add to ONE array in memory → re-GET and refuse if the
// document moved → PUT → re-GET → verify the array landed AND every other byte is
// identical, else restore the backup. An .indexOn is a query-planning hint: it is
// never evaluated against a read or a write and cannot refuse either.
//
// WHAT IT BUYS: the hub Orders card can ask for one hub's orders
// (orderByChild("hub"/"placedAtHub").equalTo(hub)) instead of the whole node.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const ADD = ["hub", "placedAtHub"];

async function token() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/configstore/firebase-tools.json"), "utf8"));
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: cfg.tokens.refresh_token,
    client_id: "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
    client_secret: "j9iVZfS8kkCEFUPaAeJV0sAi",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  return (await r.json()).access_token;
}
const getRules = async (t) => {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`);
  if (!r.ok) throw new Error(`GET rules failed: ${r.status}`);
  return r.json();
};
const putRules = async (t, body) => {
  const r = await fetch(`${DB}/.settings/rules.json?access_token=${t}`, { method: "PUT", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PUT failed: ${r.status} ${await r.text()}`);
};
const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);

const t = await token();
const live = await getRules(t);
const node = live.rules?.orders;
if (!node || typeof node !== "object") throw new Error("live rules have no /orders node — refusing to guess");
const cur = asList(node[".indexOn"]);
const next = [...cur, ...ADD.filter((f) => !cur.includes(f))];
console.log("current /orders .indexOn:", JSON.stringify(node[".indexOn"] ?? null));
console.log("new     /orders .indexOn:", JSON.stringify(next));
if (next.length === cur.length) { console.log("already applied — nothing to do"); process.exit(0); }
if (!APPLY) { console.log("dry run — re-run with --apply"); process.exit(0); }

const dir = path.join(os.homedir(), "marathon-rollbacks");
fs.mkdirSync(dir, { recursive: true });
const backup = path.join(dir, `rtdb-rules-live-before-orders-hub-index-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(backup, JSON.stringify(live, null, 2));
console.log(`backup: ${backup}`);

const proposed = JSON.parse(JSON.stringify(live));
proposed.rules.orders[".indexOn"] = next;
const again = await getRules(t);
if (JSON.stringify(again) !== JSON.stringify(live)) throw new Error("live rules changed while preparing — nothing written, re-run");
await putRules(t, proposed);
const after = await getRules(t);
const strip = (doc) => { const c = JSON.parse(JSON.stringify(doc)); delete c.rules.orders[".indexOn"]; return JSON.stringify(c); };
const ok = JSON.stringify(after.rules?.orders?.[".indexOn"]) === JSON.stringify(next) && strip(after) === strip(live);
if (!ok) {
  console.error("VERIFY FAILED — restoring the backup");
  await putRules(t, live);
  process.exit(1);
}
console.log("applied and verified: only /orders .indexOn changed. Restore with: PUT the backup file to /.settings/rules.json");

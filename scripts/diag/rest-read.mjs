// READ-ONLY helper: one narrow REST GET against the live RTDB (never a write).
//   node scripts/diag/rest-read.mjs '<path>' ['<query string>']
// REST refuses an unindexed query instead of downloading the node, so a
// query here can never turn into a whole-node read by accident.
// Auth: the machine's application-default credentials, exchanged for a
// short-lived token directly (no firebase-admin needed in a worktree).
import { readFileSync } from "fs";
import { homedir } from "os";
async function accessToken() {
  const adc = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS || `${homedir()}/.config/gcloud/application_default_credentials.json`, "utf8"));
  if (adc.type !== "authorized_user") throw new Error(`unsupported credential type ${adc.type}`);
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: adc.client_id, client_secret: adc.client_secret, refresh_token: adc.refresh_token }) });
  const j = await res.json();
  if (!j.access_token) throw new Error(`token exchange failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}
const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
let token = null;
export async function restGet(path, qs = "") {
  if (!token) token = await accessToken();
  const url = `${DB}/${String(path).replace(/^\/+/, "")}.json${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
if (process.argv[1] && process.argv[1].endsWith("rest-read.mjs")) {
  const out = await restGet(process.argv[2], process.argv[3] || "");
  const s = JSON.stringify(out, null, 1);
  console.log(s.length > 6000 ? `${s.slice(0, 6000)}\n… (${s.length} bytes)` : s);
}

// ─── READS SHARED BY THE PRODUCT-TYPE SCRIPTS ────────────────────────────────
// Per-path REST reads with an owner token (curl — node on Junid's Mac cannot
// reach Google). No top-level side effects: safe to import.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandDay } from "../../src/insights/rollupCodec.js";

const DB = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";
const TOKEN = () => {
  const t = process.env.ACCESS_TOKEN;
  if (!t) throw new Error("ACCESS_TOKEN is required");
  return t;
};

export function rest(path, { method = "GET", body, qs = "" } = {}) {
  const args = ["-s", "-X", method, `${DB}/${path}.json${qs ? `?${qs}` : ""}`, "-H", `Authorization: Bearer ${TOKEN()}`];
  if (body !== undefined) args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  const out = execFileSync("curl", args, { maxBuffer: 256e6 }).toString();
  const j = JSON.parse(out || "null");
  if (j && typeof j === "object" && j.error) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
}

export function orderHistory(pidSet, cacheDir) {
  const days = Object.keys(rest("insights_rollup/days", { qs: "shallow=true" }) || {}).sort();
  const out = {};
  for (const d of days) {
    const f = cacheDir ? join(cacheDir, `${d}.json`) : null;
    let day;
    if (f && existsSync(f)) day = JSON.parse(readFileSync(f, "utf8"));
    else { day = rest(`insights_rollup/days/${d}`); if (f) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(f, JSON.stringify(day)); } }
    for (const r of Object.values(expandDay(day))) {
      if (!pidSet.has(r.productId)) continue;
      const h = (out[r.productId] ||= { sizes: {}, hubs: {}, types: {}, firstMs: null, lastMs: null });
      if (r.size != null) h.sizes[r.size] = (h.sizes[r.size] || 0) + 1;
      if (r.placedAtHub) h.hubs[r.placedAtHub] = (h.hubs[r.placedAtHub] || 0) + 1;
      if (r.productType) {
        const t = (h.types[r.productType] ||= { n: 0, firstDay: d, lastDay: d });
        t.n += 1; t.lastDay = d;
      }
    }
  }
  return out;
}

export function cellsOf(pid, locs) {
  const out = {};
  for (const l of locs) {
    const v = rest(`stock/${l}/${pid}`);
    if (v && typeof v === "object") out[l] = Array.isArray(v) ? Object.fromEntries(v.map((c, i) => [String(i), c]).filter(([, c]) => c)) : v;
  }
  return out;
}


// CREATE-IF-ABSENT for one path (Firebase REST conditional request): read the
// ETag, write only if it is still the ETag of nothing. A cell somebody else
// created in between is kept, never overwritten. Returns "created" | "exists".
export function createIfAbsent(path, value) {
  const head = execFileSync("curl", ["-s", "-i", `${DB}/${path}.json`, "-H", `Authorization: Bearer ${TOKEN()}`, "-H", "X-Firebase-ETag: true"]).toString();
  const etag = (head.match(/^etag:\s*(.+)$/im) || [])[1]?.trim();
  const body = head.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
  if (body !== "null") return "exists";
  if (!etag) throw new Error(`no ETag for ${path}`);
  const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", `${DB}/${path}.json`,
    "-H", `Authorization: Bearer ${TOKEN()}`, "-H", `if-match: ${etag}`, "-H", "Content-Type: application/json",
    "--data-binary", JSON.stringify(value)]).toString();
  if (code === "412") return "exists";
  if (code !== "200") throw new Error(`PUT ${path} → HTTP ${code}`);
  return "created";
}

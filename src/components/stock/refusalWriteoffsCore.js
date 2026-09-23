// ─── "WRITTEN OFF AFTER REFUSAL" — what the super-admin card shows ───────────
// The records are written by the hourly scan (functions/lib/refusal-writeoff.cjs)
// at /refill_engine/refusalWriteoffs/{id} whenever a location refused one size
// on four different days and its pre-refusal count was erased. This file turns
// them into card rows: product, size, location, units, who refused and when.
// Pure — the screen only draws what this returns, and the test pins that it
// reads exactly the fields the engine writes.

const LOC = { hub1: "Hub 1", hub2: "Hub 2", central: "Central", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const locName = (l) => LOC[l] || l || "—";
export const dayLabel = (d) => {
  const [, m, day] = String(d || "").split("-");
  return m ? `${Number(day)} ${MON[Number(m) - 1]}` : String(d || "");
};

// Who said no, in words. The Central queue records the account; so does
// Hub 2's "out of stock" on a shop order since 2026-09-23 (the scan copies it
// into resolvedBy). Refusals from before then recorded only the hub — name the
// hub and say no person was recorded, rather than invent a name.
export function refuserLabel(r, loc) {
  if (r?.byName) return r.byName;
  if (r?.byRole) return `${r.byRole} account`;
  const where = r?.byLoc || loc;
  return where ? `${locName(where)} staff (no name recorded)` : "no name recorded";
}

export function writeoffRows(value) {
  const list = Object.entries(value || {})
    .map(([id, r]) => (r && typeof r === "object" ? { ...r, id: r.id || id } : null))
    .filter(Boolean);
  const rows = list.map((r) => {
    const refusals = Array.isArray(r.refusals) ? r.refusals.filter(Boolean) : Object.values(r.refusals || {}).filter(Boolean);
    return {
      id: r.id,
      pid: r.pid,
      productName: r.productName || r.pid,
      size: r.size && r.size !== "_" && r.size !== "Free Size" ? r.size : "one size",
      location: locName(r.loc),
      units: Number(r.qty) || 0,
      left: typeof r.after === "number" ? r.after : null,
      writtenAtMs: Number(r.writtenAtMs) || Date.parse(r.writtenAt || "") || 0,
      refusals: refusals.map((x) => ({
        when: dayLabel(x.day), who: refuserLabel(x, r.loc), forShop: x.dest ? locName(x.dest) : null,
      })),
    };
  });
  rows.sort((a, b) => b.writtenAtMs - a.writtenAtMs || a.productName.localeCompare(b.productName));
  return rows;
}

// Headline for the stat card: write-offs in the last `days` days.
export function recentCount(rows, nowMs, days = 30) {
  return rows.filter((r) => nowMs - r.writtenAtMs <= days * 864e5).length;
}

// ─── THE DAILY EMAIL'S STATUS (2026-09-23) ────────────────────────────────────
// The 23 Sep digest was logged as sent and never arrived — and nothing said
// so. The digest function now asks Google whether the email left and records
// the answer at /refill_engine/refusalWriteoffDigestStatus; this turns it into
// the one line the card shows. tone: "ok" | "warn" | "fail" (fail = red on
// the Health stat card too). Google gives no inbox receipt for these emails —
// on 23 Sep it raised the alert and the email still never came — so the best
// "ok" says exactly what is known: Google raised the email alert, and no more.
const DIGEST_STALE_MS = 26 * 3600e3;   // the digest runs daily at 19:40
function sastStamp(ms) {
  const d = new Date(ms + 2 * 3600e3);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
export function digestStatusLine(status, nowMs) {
  if (!status || typeof status !== "object" || !Number(status.atMs)) {
    return { tone: "warn", text: "The daily email has not been checked yet — the check runs with the next digest at 19:40." };
  }
  const at = sastStamp(Number(status.atMs));
  if (nowMs - Number(status.atMs) > DIGEST_STALE_MS) {
    return { tone: "fail", text: `The daily email has not run since ${at} — nothing has been sent since then.` };
  }
  if (status.outcome === "error") return { tone: "fail", text: `The daily email failed on ${at}: ${status.why || "unknown error"}. Nothing was sent.` };
  if (status.outcome !== "sent") return { tone: "ok", text: `Nothing new to email on ${at}.` };
  const d = status.delivery || {};
  const n = Number(status.count) || 0;
  const what = `${n} write-off${n === 1 ? "" : "s"}`;
  if (d.state === "alert_raised") {
    const sentAt = Date.parse(d.alertRaisedAt || "") || Number(status.atMs);
    return { tone: "ok", text: `Google raised the email with ${what} to ${d.to} at ${sastStamp(sentAt)}. Google does not confirm it reached the inbox — if it is not there, look in spam for “Written off after refusal”.` };
  }
  if (d.state === "checking") {
    if (nowMs - Number(status.atMs) > 15 * 60e3) {
      return { tone: "fail", text: `The ${at} email check never finished — the run was cut off, so whether the email left is unknown.` };
    }
    return { tone: "warn", text: `Checking whether the ${at} email with ${what} left Google…` };
  }
  if (d.state === "not_sent") return { tone: "fail", text: `The ${at} email with ${what} did NOT go out: ${d.why || "unknown"}. The full list is below.` };
  return { tone: "warn", text: `Could not confirm the ${at} email with ${what} left Google: ${d.why || "no answer"}.` };
}

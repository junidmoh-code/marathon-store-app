// ─── COST WATCH — WHAT FIREBASE IS COSTING, AND WHO IS SPENDING IT ───────────
//
// Super-admin only. Today and yesterday in dollars, a live ranking by device
// and by cause, and for each suggested fix a ready-to-paste Claude Code prompt
// behind a copy button.
//
// ─── THIS CARD MUST NOT BE EXPENSIVE ─────────────────────────────────────────
//
// It is a card about the cost of reading the database, so it reads as little
// as it possibly can. Three small nodes, by exact path, with `get()` rather
// than `onValue`: /cost_watch/daily/<today>, /cost_watch/daily/<yesterday> and
// /cost_watch/suggestions. Each is a few KB, written by the watcher on the Mac
// mini, already summarised — the per-hour detail with its full tables and
// largest-read lists is at /cost_watch/hourly and is deliberately NOT read
// here.
//
// A live subscription would have been the house style, and it is the wrong
// choice here: opening `onValue` on /cost_watch/daily would re-download both
// days every time the watcher republished, which is every ten minutes, for as
// long as the card is open. A manual Refresh costs one read when the person
// looking actually wants one.
//
// ─── WHY IT CAN SAY "NO PERMISSION" AND THAT IS FINE ─────────────────────────
//
// The watcher writes /cost_watch with an admin credential, which bypasses
// rules. Reading it from here needs a rule that the watcher is forbidden to
// add — it prints it and keeps going. Until somebody adds it, this card shows
// the rule it needs rather than an error, and everything else the watcher does
// carries on working.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDatabase, ref, get } from "firebase/database";
import { ADMIN_EMAIL } from "../PermissionsContext";

const SAST_OFFSET_MS = 2 * 3600 * 1000;
const sastDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + SAST_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${(100 * Number(n || 0)).toFixed(0)}%`;

const RULE_TEXT = `"cost_watch": {
  ".read": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
  ".write": false
}`;

/** Copy that works without the clipboard API, which is absent on http origins. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function Bar({ share }) {
  return (
    <div style={{ height: 4, background: "#2c2c2e", borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
      <div style={{ height: "100%", width: `${Math.max(2, Math.min(100, 100 * share))}%`, background: "#0a84ff" }} />
    </div>
  );
}

function Ranking({ title, rows, total }) {
  if (!rows || !rows.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, color: "#8e8e93", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>{title}</div>
      {rows.map((r) => (
        <div key={r.key} style={{ padding: "8px 0", borderBottom: "1px solid #1c1c1e" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <span style={{ fontSize: 14, color: "#f2f2f7", wordBreak: "break-word", flex: 1 }}>{r.key}</span>
            <strong style={{ fontSize: 14, color: "#f2f2f7", whiteSpace: "nowrap" }}>{money(r.usd)}</strong>
          </div>
          <Bar share={total ? r.usd / total : 0} />
        </div>
      ))}
    </div>
  );
}

function Suggestion({ item }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(item.prompt || "");
    setCopied(ok ? "copied" : "could not copy — open it and select the text");
    setTimeout(() => setCopied(false), 2600);
  };
  return (
    <div style={{ border: "1px solid #2c2c2e", borderRadius: 10, padding: 12, marginTop: 10, background: "#1c1c1e" }}>
      <div style={{ fontSize: 14, color: "#f2f2f7", fontWeight: 600 }}>{item.title}</div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 6 }}>
        Costs {money(item.costNowUsdPerDay)}/day · saves about <strong style={{ color: "#30d158" }}>{money(item.savingUsdPerDay)}/day</strong> ({money(item.savingUsdPerMonth)}/month)
      </div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>Risk: {item.riskShort || item.risk}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          onClick={onCopy}
          style={{ background: "#0a84ff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" }}
        >
          {copied ? (copied === "copied" ? "Copied ✓" : copied) : "Copy prompt"}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: "transparent", color: "#0a84ff", border: "1px solid #0a84ff", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" }}
        >
          {open ? "Hide" : "Show"} prompt
        </button>
      </div>
      {open && (
        <pre style={{ marginTop: 10, padding: 10, background: "#000", borderRadius: 8, color: "#d1d1d6", fontSize: 11, lineHeight: 1.45, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {item.prompt}
        </pre>
      )}
    </div>
  );
}

export default function CostWatchCard({ authUser, onExit }) {
  // ── THE COMPONENT'S OWN GATE ───────────────────────────────────────────────
  // Re-checked here, independently of the route gate that mounted it, on the
  // same email condition. Deleting either leaves a working gate. The card
  // reads nothing that is not already super-admin-only, but a cost breakdown
  // names people's devices and it should not render for anyone else.
  const isSuperAdmin = String(authUser?.email || "").toLowerCase() === ADMIN_EMAIL;

  const [state, setState] = useState({ loading: true });
  const today = useMemo(() => sastDate(0), []);
  const yesterday = useMemo(() => sastDate(-1), []);

  const load = useCallback(async () => {
    if (!isSuperAdmin) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const db = getDatabase();
      const [t, y, sg] = await Promise.all([
        get(ref(db, `cost_watch/daily/${today}`)),
        get(ref(db, `cost_watch/daily/${yesterday}`)),
        get(ref(db, "cost_watch/suggestions")),
      ]);
      setState({
        loading: false,
        today: t.exists() ? t.val() : null,
        yesterday: y.exists() ? y.val() : null,
        suggestions: sg.exists() ? sg.val() : null,
      });
    } catch (e) {
      // A missing rule reads as PERMISSION_DENIED. That is a known, expected
      // state with a known fix, so it is shown as the fix rather than as an
      // error somebody has to decode.
      const denied = /permission_denied/i.test(String(e?.message || e));
      setState({ loading: false, error: denied ? "denied" : String(e?.message || e) });
    }
  }, [isSuperAdmin, today, yesterday]);

  useEffect(() => { load(); }, [load]);

  if (!isSuperAdmin) {
    return (
      <div style={{ padding: 24, color: "#8e8e93", background: "#000", minHeight: "100vh" }}>
        This card is for the account owner only.
        <div><button onClick={onExit} style={{ marginTop: 16, background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px" }}>Back</button></div>
      </div>
    );
  }

  const t = state.today;
  const y = state.yesterday;
  const delta = t && y ? t.usd - y.usd : null;

  return (
    <div style={{ background: "#000", minHeight: "100vh", color: "#f2f2f7", padding: "16px 16px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Cost Watch</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} style={{ background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" }}>Refresh</button>
          <button onClick={onExit} style={{ background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" }}>Back</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>
        Firebase Realtime Database download, measured continuously on the Mac mini.
      </div>

      {state.loading && <div style={{ marginTop: 24, color: "#8e8e93" }}>Reading…</div>}

      {state.error === "denied" && (
        <div style={{ marginTop: 20, border: "1px solid #ff9f0a", borderRadius: 10, padding: 14, background: "#1c1c1e" }}>
          <div style={{ color: "#ff9f0a", fontWeight: 600, fontSize: 14 }}>The database rule for /cost_watch has not been added yet</div>
          <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 8 }}>
            The watcher writes this data with an admin credential, which bypasses rules, so it is being collected
            normally. Reading it from this card needs one rule, which the watcher is not allowed to add for itself.
            Add this inside <code>"rules"</code> in <code>database.rules.json</code> and deploy rules:
          </div>
          <pre style={{ marginTop: 10, padding: 10, background: "#000", borderRadius: 8, color: "#d1d1d6", fontSize: 12, overflowX: "auto" }}>{RULE_TEXT}</pre>
        </div>
      )}

      {state.error && state.error !== "denied" && (
        <div style={{ marginTop: 20, color: "#ff453a", fontSize: 14 }}>Could not read the cost data: {state.error}</div>
      )}

      {!state.loading && !state.error && !t && !y && (
        <div style={{ marginTop: 20, color: "#8e8e93", fontSize: 14 }}>
          No measured days yet. The watcher publishes its first summary within about an hour of starting.
        </div>
      )}

      {!state.loading && !state.error && (t || y) && (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            {[{ label: "Today", d: t }, { label: "Yesterday", d: y }].map(({ label, d }) => (
              <div key={label} style={{ flex: 1, border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e" }}>
                <div style={{ fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
                <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{d ? money(d.usd) : "—"}</div>
                {d && (
                  <div style={{ fontSize: 12, color: d.coverage < 0.995 ? "#ff9f0a" : "#8e8e93", marginTop: 4 }}>
                    {/* Coverage is stated on the face of the number, not in a
                        footnote. A low figure from a half-watched day must
                        never be mistaken for a cheap day. */}
                    {pct(d.coverage)} of the day measured
                    {d.coverage < 0.995 && d.hoursMissing?.length ? ` · ${d.hoursMissing.length}h missing` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>

          {delta != null && (
            <div style={{ marginTop: 10, fontSize: 13, color: delta > 0 ? "#ff453a" : "#30d158" }}>
              {delta > 0 ? "Up" : "Down"} {money(Math.abs(delta))} on yesterday
              {(t.coverage < 0.995 || y.coverage < 0.995) && " — but the two days were measured for different lengths of time, so this is not like for like"}
            </div>
          )}

          <Ranking title="By device" rows={t?.byDevice || y?.byDevice} total={(t || y)?.usd} />
          <Ranking title="By cause" rows={t?.byCause || y?.byCause} total={(t || y)?.usd} />

          {(t || y)?.unattributedShare > 0.05 && (
            <div style={{ marginTop: 14, fontSize: 13, color: "#ff9f0a" }}>
              {pct((t || y).unattributedShare)} of the bytes could not be attributed to a known device or cause.
              They are inside the totals above, shown here rather than hidden.
            </div>
          )}

          {state.suggestions?.items?.length > 0 && (
            <div style={{ marginTop: 26 }}>
              <div style={{ fontSize: 13, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 }}>
                Suggested fixes — copy a prompt and paste it into Claude Code
              </div>
              {state.suggestions.items.map((item) => <Suggestion key={item.id} item={item} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

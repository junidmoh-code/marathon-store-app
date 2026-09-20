// ─── MIRROR FLEET — EVERY DEVICE, AND THE ONE SWITCH THAT STOPS THEM ─────────
//
// Super-admin only. Every device that has ever reported, newest first: whether
// its copy is complete, when it last synced, how many bytes it has spent
// today, which build it is on, and any guard that has tripped. Each device
// writes its own record (src/offline/deviceHealth.js); this reads the lot.
//
// ── THE KILL SWITCH LIVES HERE TOO ──────────────────────────────────────────
//
// On a bad night the fastest possible path from "the mirror is wrong about a
// number" to "every device is reading live again" must not be "find the
// Firebase console, find the right database, find the node, type false". It is
// one button on this screen, behind one confirmation. The RTDB rule on
// /mirror_switch is what actually enforces who may press it — this gate, like
// every other one in this app, only decides what is worth rendering.
//
// ── IT MUST NOT BE EXPENSIVE ────────────────────────────────────────────────
//
// It is a screen about the cost of reading the database. /mirror_devices is
// read ONCE with get() on mount and on Refresh, never subscribed: a couple of
// dozen records of about 300 bytes is a few KB, and an onValue on it would
// re-download the lot every time any device in the shop reported. The switch
// itself IS subscribed, because it is five bytes and the one thing on this
// screen that must never be stale.

import { useCallback, useEffect, useState } from "react";
import { getDatabase, ref, get, set, onValue } from "firebase/database";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { DEVICES_ROOT } from "../../offline/deviceHealth";
import { MIRROR_SWITCH_PATH, switchVerdict } from "../../offline/killSwitch";

const RULE_TEXT = `"mirror_switch": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "auth != null && auth.token.email === '${ADMIN_EMAIL}'"
},
"mirror_devices": {
  ".read": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
  "$deviceId": {
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'"
  }
}`;

const MB = (b) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);

// "3 minutes ago" beats a timestamp for the one question this screen answers.
export function ago(at, now = Date.now()) {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// A device is only as trustworthy as its last report. One that has not been
// heard from since before the last trading day is not "healthy", it is silent,
// and the two must not look the same — that is the whole lesson of the status
// dot and of the social silence alarm.
export const STALE_MS = 6 * 3600 * 1000;

export function deviceState(d, now = Date.now()) {
  if (!d) return { tone: "#8e8e93", text: "no report" };
  if (now - (d.at ?? 0) > STALE_MS) return { tone: "#8e8e93", text: `silent · last heard ${ago(d.at, now)}` };
  if (d.guard) return { tone: "#ff453a", text: `${d.guard.leg}: ${d.guard.reason}` };
  if (!d.switchOn) return { tone: "#8e8e93", text: "reading live — switch off" };
  if (d.downloading) return { tone: "#ff9f0a", text: "downloading its copy" };
  if (!d.complete) return { tone: "#ff9f0a", text: "copy incomplete — reading live" };
  if (d.pending > 0) return { tone: "#ff9f0a", text: `${d.pending} write(s) still going up` };
  return { tone: "#30d158", text: "serving from its own copy" };
}

function DeviceRow({ d, now }) {
  const s = deviceState(d, now);
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid #1c1c1e" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontSize: 14, color: "#f2f2f7", flex: 1, wordBreak: "break-word" }}>{d.label || d.deviceId}</span>
        <strong style={{ fontSize: 14, color: "#f2f2f7", whiteSpace: "nowrap" }}>{MB(d.bytesToday || 0)} today</strong>
      </div>
      <div style={{ fontSize: 12.5, color: s.tone, marginTop: 3 }}>{s.text}</div>
      <div style={{ fontSize: 12, color: "#8e8e93", marginTop: 3 }}>
        {(d.rows || 0).toLocaleString()} records
        {d.photos != null && ` · ${d.photos.toLocaleString()} pictures`}
        {` · synced ${ago(d.lastSyncAt, now)}`}
        {` · reported ${ago(d.at, now)}`}
        {d.build ? ` · build ${String(d.build).slice(0, 12)}` : " · build unknown"}
      </div>
    </div>
  );
}

export default function MirrorFleetCard({ authUser, onExit }) {
  // ── THE COMPONENT'S OWN GATE ──────────────────────────────────────────────
  // Re-checked here, independently of the route gate that mounted it, on the
  // same strict, case-sensitive email condition the RTDB rule uses. A
  // lowercasing comparison would fail safe here and then be refused by the
  // rule, turning a clean "not for you" into a PERMISSION_DENIED nobody can
  // explain.
  const isSuperAdmin = authUser?.email === ADMIN_EMAIL;

  const [state, setState] = useState({ loading: true, devices: [] });
  const [switchOn, setSwitchOn] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [flipError, setFlipError] = useState(null);
  const now = Date.now();

  const load = useCallback(async () => {
    if (!isSuperAdmin) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const snap = await get(ref(getDatabase(), DEVICES_ROOT));
      const val = snap.exists() ? snap.val() : null;
      const devices = Object.values(val || {})
        .filter((d) => d && typeof d === "object")
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      setState({ loading: false, devices });
    } catch (e) {
      const denied = /permission_denied/i.test(String(e?.message || e));
      setState({ loading: false, devices: [], error: denied ? "denied" : String(e?.message || e) });
    }
  }, [isSuperAdmin]);

  useEffect(() => { load(); }, [load]);

  // The switch, live. Five bytes, and the one thing on this screen that must
  // never be stale — a person about to press a kill button has to be looking
  // at the current state of it.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const unsub = onValue(
      ref(getDatabase(), MIRROR_SWITCH_PATH),
      (snap) => setSwitchOn(switchVerdict(snap.exists() ? snap.val() : null)),
      () => setSwitchOn(null),
    );
    return () => unsub && unsub();
  }, [isSuperAdmin]);

  const flip = useCallback(async (to) => {
    setFlipping(true);
    setFlipError(null);
    try {
      await set(ref(getDatabase(), MIRROR_SWITCH_PATH), to);
      setConfirming(false);
    } catch (e) {
      setFlipError(String(e?.message || e));
    }
    setFlipping(false);
  }, []);

  if (!isSuperAdmin) {
    return (
      <div style={{ padding: 24, color: "#8e8e93", background: "#000", minHeight: "100vh" }}>
        This screen is for the account owner only.
        <div><button onClick={onExit} style={btn}>Back</button></div>
      </div>
    );
  }

  const devices = state.devices || [];
  const serving = devices.filter((d) => deviceState(d, now).text === "serving from its own copy").length;
  const bytes = devices.reduce((n, d) => n + (d.bytesToday || 0), 0);
  const tripped = devices.filter((d) => d.guard);

  return (
    <div style={{ background: "#000", minHeight: "100vh", color: "#f2f2f7", padding: "16px 16px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Mirror Fleet</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} style={btn}>Refresh</button>
          <button onClick={onExit} style={btn}>Back</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4 }}>
        Each device reports its own health. Nothing here is a live subscription
        except the switch below.
      </div>

      {/* ── THE SWITCH ───────────────────────────────────────────────────── */}
      <div style={{ marginTop: 18, border: `1px solid ${switchOn === false ? "#ff9f0a" : "#2c2c2e"}`, borderRadius: 10, padding: 14, background: "#1c1c1e" }}>
        <div style={{ fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 }}>The fleet switch</div>
        <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4, color: switchOn === false ? "#ff9f0a" : "#30d158" }}>
          {switchOn === null && "Cannot read it — the rule below may not be pasted"}
          {switchOn === true && "ON — devices serve from their own copy"}
          {switchOn === false && "OFF — every device is reading live"}
        </div>
        <div style={{ fontSize: 12.5, color: "#8e8e93", marginTop: 6 }}>
          A change takes effect on every open device within a second. No reload,
          no deploy. A device that is offline keeps serving the copy it has
          until it can hear otherwise.
        </div>
        {switchOn !== null && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            style={{ ...btn, marginTop: 12, background: switchOn ? "#ff453a" : "#30d158", color: "#fff" }}
          >
            {switchOn ? "Turn the mirror OFF for every device" : "Turn the mirror back ON"}
          </button>
        )}
        {confirming && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: "#f2f2f7" }}>
              {switchOn
                ? "Every device drops to live reads immediately. Nothing is deleted — the copies stay on the devices, so turning it back on costs nobody another download."
                : "Every device goes back to serving from the copy it already holds."}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => flip(!switchOn)} disabled={flipping} style={{ ...btn, background: switchOn ? "#ff453a" : "#30d158", color: "#fff" }}>
                {flipping ? "…" : (switchOn ? "Yes, turn it off" : "Yes, turn it on")}
              </button>
              <button onClick={() => setConfirming(false)} style={btn}>Cancel</button>
            </div>
          </div>
        )}
        {flipError && <div style={{ marginTop: 10, color: "#ff453a", fontSize: 13 }}>Could not change it: {flipError}</div>}
      </div>

      {state.error === "denied" && (
        <div style={{ marginTop: 20, border: "1px solid #ff9f0a", borderRadius: 10, padding: 14, background: "#1c1c1e" }}>
          <div style={{ color: "#ff9f0a", fontWeight: 600, fontSize: 14 }}>The database rules for the mirror fleet are not pasted yet</div>
          <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 8 }}>
            Without them no device can read the switch — and a device that has
            never read it does not mirror at all, so the fleet is simply
            reading live. Add this beside <code>"insights_log"</code>:
          </div>
          <pre style={{ marginTop: 10, padding: 10, background: "#000", borderRadius: 8, color: "#d1d1d6", fontSize: 12, overflowX: "auto" }}>{RULE_TEXT}</pre>
        </div>
      )}

      {state.error && state.error !== "denied" && (
        <div style={{ marginTop: 20, color: "#ff453a", fontSize: 14 }}>Could not read the fleet: {state.error}</div>
      )}

      {!state.loading && !state.error && devices.length === 0 && (
        <div style={{ marginTop: 20, color: "#8e8e93", fontSize: 14 }}>
          No device has reported yet. A device reports once its copy is complete,
          and then a few times a day.
        </div>
      )}

      {devices.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Tile label="Devices" value={devices.length} />
            <Tile label="Serving locally" value={serving} tone={serving === devices.length ? "#30d158" : "#ff9f0a"} />
            <Tile label="Bytes today" value={MB(bytes)} />
          </div>
          {tripped.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: "#ff453a" }}>
              {tripped.length} device(s) have a guard tripped — they are NOT
              serving the affected leg, and are reading it live until it
              downloads again.
            </div>
          )}
          <div style={{ marginTop: 18 }}>
            {devices.map((d) => <DeviceRow key={d.deviceId} d={d} now={now} />)}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone = "#f2f2f7" }) {
  return (
    <div style={{ flex: 1, border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e" }}>
      <div style={{ fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: tone }}>{value}</div>
    </div>
  );
}

const btn = {
  background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8,
  padding: "8px 14px", fontSize: 14, cursor: "pointer",
};

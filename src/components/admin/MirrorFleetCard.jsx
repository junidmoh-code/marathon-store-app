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
//
// ── QUARANTINE: FIND ONE PHONE ──────────────────────────────────────────────
//
// Accounts are shared, so the only thing that names one handset is its device
// id. Each row has one button: Quarantine puts a full-screen "Show this screen
// to Junid" on that device only (src/device/quarantine.js), Release takes it
// down. The flag list, /mirror_switch/quarantine, is subscribed too: it holds
// one small record per quarantined device, normally none, and the button has
// to show what the device is being told right now.
//
// ── EVICTING DEVICES ────────────────────────────────────────────────────────
//
// A device whose browser keeps deleting its copy used to look "downloading".
// It now says so, in red, with how many times today and whether its storage
// is protected (src/offline/storageHealth.js).

import { useCallback, useEffect, useState } from "react";
import { getDatabase, ref, get, set, remove, onValue } from "firebase/database";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { DEVICES_ROOT } from "../../offline/deviceHealth";
import { MIRROR_SWITCH_PATH, switchVerdict } from "../../offline/killSwitch";
import { DEVICE_OFF_ROOT, deviceOffPath, deviceOffVerdict } from "../../offline/deviceOff";
import {
  QUARANTINE_NODE, quarantinePath, quarantineRecord, quarantineVerdict,
} from "../../device/quarantine";

const RULE_TEXT = `"mirror_switch": {
  ".read": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
  ".write": "auth != null && auth.token.email === '${ADMIN_EMAIL}'"
},
"mirror_devices": {
  ".read": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
  "$deviceId": {
    ".write": "auth != null && auth.token.firebase.sign_in_provider != 'anonymous'",
    ".validate": "newData.child('deviceId').val() === $deviceId"
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

// ── NOT HEARD FROM IN A WEEK: NOT IN USE ────────────────────────────────────
// Every browser a person has ever signed in on is its own device here, so an
// old laptop tab or a replaced phone stays on the list for ever. After a week
// of silence a device is greyed into its own list and left out of the totals
// (owner decision, 21 Sep 2026). It comes back the moment it reports again.
export const INACTIVE_MS = 7 * 24 * 3600 * 1000;
export const isInactive = (d, now = Date.now()) => now - (d?.at ?? 0) > INACTIVE_MS;

// "Was this device serving from its own copy when it last reported?" Silence
// is shown on the row; it does not un-count a device that was serving, or
// every tablet would drop out of the total overnight.
export const reportedServing = (d) =>
  !!d && d.switchOn === true && d.complete === true && !d.guard;

// A guard's reason is health.js's vocabulary, and this screen is read by the
// owner, who is operationally savvy and not a programmer. "products: shrank"
// is a grep term; "the catalogue copy came back short — downloading it again"
// is a sentence somebody can act on.
// Every one of these is a SINGULAR noun phrase, so it agrees with the verbs
// below whichever way they are paired: "the stock copy does not match", never
// "the stock numbers does not match".
const LEG_WORDS = Object.freeze({
  products: "the catalogue", stock: "the stock copy", orders: "the orders copy",
  customers: "the customer list", insights: "the order history",
  movements: "the stock-movement copy", refills: "the refill-request copy",
  restockLog: "the out-of-stock log", restockRequests: "the source-request copy",
  returnsLog: "the returns copy", users: "the staff list",
  locations: "the locations copy", taxonomy: "the category list",
  displaySlots: "the displays copy", displayRows: "the display-row copy",
  displayRegister: "the display register",
});
const GUARD_WORDS = Object.freeze({
  shrank: "came back short, so the copy already here was kept",
  "count-drift": "does not match the server's count — downloading it again",
  empty: "came back empty, which it cannot be — the copy here was kept",
  "did-not-land": "did not save properly — downloading it again",
  "cursor-expired": "fell too far behind to catch up — downloading it again",
  "timed-out": "timed out — it will try again",
  "gave-up": "kept failing, so this device stopped trying until the app is reopened",
  "cursor-stuck": "could not move past one page — stopped rather than read it again",
  "re-paging": "was taken by the old downloader — downloading it again",
  "feed-stuck": "stopped receiving changes, so it is read live until the app is reopened",
});
export function guardWords(guard) {
  if (!guard) return null;
  const what = LEG_WORDS[guard.leg] ?? guard.leg;
  const why = GUARD_WORDS[guard.reason] ?? guard.reason;
  return `${what} ${why}`;
}

// "Is this device's browser throwing its copy away?" — wiped at least once
// today, by the device's own count.
export const isEvicting = (d) => (d?.storage?.wipesToday ?? 0) > 0;

export function storageWords(st, now = Date.now()) {
  if (!st) return null;
  const parts = [];
  if (st.persisted === true) parts.push("storage protected");
  else if (st.persisted === false) parts.push("storage NOT protected — the browser may delete the copy");
  if (st.wipes > 0) {
    parts.push(`wiped ${st.wipesToday || 0}× today, ${st.wipes}× in all, last ${ago(st.lastWipeAt, now)}`);
  }
  if (st.usageMB != null && st.quotaMB != null) parts.push(`${st.usageMB} of ${st.quotaMB} MB used`);
  return parts.length ? parts.join(" · ") : null;
}

export function deviceState(d, now = Date.now(), mirrorOff = false) {
  if (!d) return { tone: "#8e8e93", text: "no report" };
  // RANKED ABOVE SILENCE, and that is deliberate. Switching a device off stops
  // its mirror runtime, and the health beacon is part of that runtime — so the
  // very device this was made for stops reporting and would otherwise show as
  // "silent · last heard 11:02", sending somebody to look for a broken handset
  // that is doing exactly what it was told. The last-heard time is kept in the
  // line, because a device that is excused AND silent is still worth seeing.
  if (mirrorOff) {
    return { tone: "#0a84ff", text: `mirror OFF for this device — reading live by instruction · last heard ${ago(d.at, now)}` };
  }
  if (now - (d.at ?? 0) > STALE_MS) return { tone: "#8e8e93", text: `silent · last heard ${ago(d.at, now)}` };
  // Before "downloading": an evicting device IS downloading, again, and that
  // is exactly the lie this line exists to stop telling.
  if (isEvicting(d)) {
    const n = d.storage.wipesToday;
    return {
      tone: "#ff453a",
      text: `the browser keeps deleting this device's copy — wiped ${n}× today${d.storage.persisted === false ? ", storage not protected" : ""}`,
    };
  }
  if (d.guard) return { tone: "#ff453a", text: guardWords(d.guard) };
  if (!d.switchOn) return { tone: "#8e8e93", text: "reading live — switch off" };
  if (d.downloading) return { tone: "#ff9f0a", text: "downloading its copy" };
  if (!d.complete) return { tone: "#ff9f0a", text: "copy incomplete — reading live" };
  // A save still being confirmed is not a problem with the copy: it clears in
  // at most three minutes (pendingWrites.PENDING_TTL_MS), and a tablet that
  // went to sleep right after a save used to sit orange for hours.
  if (d.pending > 0) return { tone: "#30d158", text: `serving from its own copy · ${d.pending} save(s) confirming` };
  return { tone: "#30d158", text: "serving from its own copy" };
}

function DeviceRow({ d, now, mirrorOff, onToggleOff, busy, quarantined = false, onQuarantine = null, qBusy = false }) {
  const s = deviceState(d, now, mirrorOff);
  const storage = storageWords(d.storage, now);
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid #1c1c1e" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontSize: 14, color: "#f2f2f7", flex: 1, wordBreak: "break-word" }}>{d.label || d.deviceId}</span>
        <strong style={{ fontSize: 14, color: "#f2f2f7", whiteSpace: "nowrap" }}>{MB(d.bytesToday || 0)} today</strong>
      </div>
      {quarantined && (
        <div style={{ fontSize: 12.5, color: "#ffd60a", marginTop: 3, fontWeight: 600 }}>
          QUARANTINED — this device shows "Show this screen to Junid" until released
        </div>
      )}
      <div style={{ fontSize: 12.5, color: s.tone, marginTop: 3 }}>{s.text}</div>
      {storage && <div style={{ fontSize: 12, color: isEvicting(d) ? "#ff453a" : "#8e8e93", marginTop: 3 }}>{storage}</div>}
      <div style={{ fontSize: 12, color: "#8e8e93", marginTop: 3 }}>
        {(d.rows || 0).toLocaleString()} records
        {d.photos != null && ` · ${d.photos.toLocaleString()} pictures`}
        {` · synced ${ago(d.lastSyncAt, now)}`}
        {` · reported ${ago(d.at, now)}`}
        {Array.isArray(d.failing) && d.failing.length > 0 && (
          ` · failing: ${d.failing.map((f) => `${LEG_WORDS[f.leg] ?? f.leg} ×${f.attempts}${f.benched ? " (stopped)" : ""}${f.message ? ` — ${f.message}` : ""}`).join("; ")}`
        )}
        {d.build ? ` · build ${String(d.build).slice(0, 12)}` : " · build unknown"}
        {` · ${d.email || "no account"} · id ${d.deviceId}`}
      </div>
      <div style={{ marginTop: 6 }}>
        <button
          onClick={() => onToggleOff(d.deviceId, !mirrorOff)}
          disabled={busy}
          style={{
            background: "transparent", border: `1px solid ${mirrorOff ? "#30d158" : "#3a3a3c"}`,
            color: mirrorOff ? "#30d158" : "#8e8e93", borderRadius: 7,
            padding: "4px 10px", fontSize: 12, cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "saving…" : mirrorOff ? "Allow this device to mirror again" : "Stop this device mirroring"}
        </button>
      </div>
      {onQuarantine && (
        <button
          onClick={() => onQuarantine(d.deviceId, !quarantined)}
          disabled={qBusy}
          style={{ ...btn, marginTop: 8, padding: "6px 12px", fontSize: 13, background: quarantined ? "#30d158" : "#3a3a3c", color: "#fff" }}
        >
          {qBusy ? "…" : (quarantined ? "Release this device" : "Quarantine this device")}
        </button>
      )}
    </div>
  );
}

export default function MirrorFleetCard({ authUser, onExit }) {
  // deviceId -> raw flag value, read with the device list.
  const [offMap, setOffMap] = useState({});
  const [offBusy, setOffBusy] = useState(null);
  const [offError, setOffError] = useState(null);
  // ── THE COMPONENT'S OWN GATE ──────────────────────────────────────────────
  // Re-checked here, independently of the route gate that mounted it, on the
  // same strict, case-sensitive email condition the RTDB rule uses. A
  // lowercasing comparison would fail safe here and then be refused by the
  // rule, turning a clean "not for you" into a PERMISSION_DENIED nobody can
  // explain.
  const isSuperAdmin = authUser?.email === ADMIN_EMAIL;

  const [state, setState] = useState({ loading: true, devices: [] });
  const [switchOn, setSwitchOn] = useState(null);
  // "Not answered yet" and "refused" are different things, and showing the
  // paste-the-rule warning during the half-second before the first answer
  // taught whoever opened this screen to ignore it.
  const [denied, setDenied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const [flipError, setFlipError] = useState(null);
  // Which devices are flagged right now: { [deviceId]: record }.
  const [flags, setFlags] = useState({});
  const [flagBusy, setFlagBusy] = useState(null);
  const [flagError, setFlagError] = useState(null);
  const now = Date.now();

  const load = useCallback(async () => {
    if (!isSuperAdmin) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const offSnap = await get(ref(getDatabase(), DEVICE_OFF_ROOT));
      // One flat map of deviceId -> flag. It is a handful of bytes even when
      // every device is off, and it is read with the devices rather than
      // subscribed: this screen is about the cost of reading the database.
      setOffMap(offSnap.exists() ? (offSnap.val() || {}) : {});
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
      (snap) => { setDenied(false); setSwitchOn(switchVerdict(snap.exists() ? snap.val() : null)); },
      () => { setDenied(true); setSwitchOn(null); },
    );
    return () => unsub && unsub();
  }, [isSuperAdmin]);

  // ── ONE DEVICE, NOT THE FLEET ─────────────────────────────────────────────
  // Writes /mirror_switch/off/<deviceId>. Setting it stops that handset
  // mirroring within a second, live, with no reload and no deploy; clearing it
  // (a REMOVE, not a `false`) lets it mirror again on the same terms as every
  // other device. Removing rather than writing false keeps the node to the
  // devices that are actually excused, so the list stays readable and the
  // absence of a row means exactly what it says.
  const toggleOff = useCallback(async (deviceId, to) => {
    setOffBusy(deviceId);
    setOffError(null);
    try {
      await set(ref(getDatabase(), deviceOffPath(deviceId)), to ? true : null);
      setOffMap((m) => {
        const next = { ...m };
        if (to) next[deviceId] = true; else delete next[deviceId];
        return next;
      });
    } catch (e) {
      setOffError(`${deviceId}: ${String(e?.message || e)}`);
    }
    setOffBusy(null);
  }, []);

  // The quarantine flags, live — normally an empty node, one small record per
  // flagged device otherwise.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const unsub = onValue(
      ref(getDatabase(), QUARANTINE_NODE),
      (snap) => setFlags(snap.exists() && snap.val() && typeof snap.val() === "object" ? snap.val() : {}),
      () => setFlags({}),
    );
    return () => unsub && unsub();
  }, [isSuperAdmin]);

  // One tap. Only ever ONE device's own path — quarantinePath refuses anything
  // that is not a device id, so this can never write the list itself.
  const setQuarantine = useCallback(async (deviceId, on) => {
    const path = quarantinePath(deviceId);
    if (!path) return;
    setFlagBusy(deviceId);
    setFlagError(null);
    try {
      if (on) await set(ref(getDatabase(), path), quarantineRecord({ by: authUser?.email ?? null }));
      else await remove(ref(getDatabase(), path));
    } catch (e) {
      setFlagError(String(e?.message || e));
    }
    setFlagBusy(null);
  }, [authUser]);

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

  const everyDevice = state.devices || [];
  const devices = everyDevice.filter((d) => !isInactive(d, now));
  const inactive = everyDevice.filter((d) => isInactive(d, now));
  const serving = devices.filter(reportedServing).length;
  const bytes = devices.reduce((n, d) => n + (d.bytesToday || 0), 0);
  const tripped = devices.filter((d) => d.guard);
  const evicting = devices.filter(isEvicting);
  const isFlagged = (id) => quarantineVerdict(flags?.[id]);
  const known = new Set(everyDevice.map((d) => d.deviceId));
  const flaggedUnknown = Object.keys(flags || {}).filter((id) => isFlagged(id) && !known.has(id));
  const rowProps = (d) => ({
    quarantined: isFlagged(d.deviceId), onQuarantine: setQuarantine, qBusy: flagBusy === d.deviceId,
  });

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
          {switchOn === null && (denied ? "Cannot read it — the rule below is not pasted yet" : "Reading…")}
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
        {/* A per-device toggle that failed must say so HERE, where the person
            who pressed it is looking. Without this the button simply springs
            back and the device carries on mirroring, which looks like the
            flag not working rather than the write being refused. */}
        {offError && <div style={{ marginTop: 10, color: "#ff453a", fontSize: 13 }}>Could not change that device: {offError}</div>}
      </div>

      {flagError && <div style={{ marginTop: 12, color: "#ff453a", fontSize: 13 }}>Could not change the quarantine: {flagError}</div>}
      {flaggedUnknown.length > 0 && (
        <div style={{ marginTop: 16, border: "1px solid #ffd60a", borderRadius: 10, padding: 12, background: "#1c1c1e" }}>
          <div style={{ fontSize: 13, color: "#ffd60a", fontWeight: 600 }}>Quarantined, but not in the list below</div>
          {flaggedUnknown.map((id) => (
            <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 8 }}>
              <code style={{ fontSize: 12, color: "#d1d1d6", wordBreak: "break-all" }}>{id}</code>
              <button onClick={() => setQuarantine(id, false)} disabled={flagBusy === id} style={{ ...btn, padding: "6px 12px", fontSize: 13 }}>Release</button>
            </div>
          ))}
        </div>
      )}

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

      {!state.loading && !state.error && everyDevice.length === 0 && (
        <div style={{ marginTop: 20, color: "#8e8e93", fontSize: 14 }}>
          No device has reported yet. A device reports as soon as its copy has
          finished downloading, and then a few times a day.
        </div>
      )}

      {everyDevice.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Tile label="Devices" value={devices.length} />
            <Tile label="Serving locally" value={serving} tone={devices.length > 0 && serving === devices.length ? "#30d158" : "#ff9f0a"} />
            <Tile label="Bytes today" value={MB(bytes)} />
            <Tile label="Evicting" value={evicting.length} tone={evicting.length ? "#ff453a" : "#30d158"} />
          </div>
          {evicting.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: "#ff453a" }}>
              {evicting.length} device(s) had their copy deleted by the browser
              today and are downloading it again: {evicting.map((d) => d.label || d.deviceId).join(", ")}.
            </div>
          )}
          {tripped.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: "#ff453a" }}>
              {tripped.length} device(s) found something wrong with part of
              their copy. They are reading that part live from the database
              until it downloads again — nothing is lost and nothing is wrong
              on their screens.
            </div>
          )}
          <div style={{ marginTop: 18 }}>
            {devices.map((d) => (
              <DeviceRow key={d.deviceId} d={d} now={now}
                mirrorOff={deviceOffVerdict(offMap[d.deviceId])}
                onToggleOff={toggleOff} busy={offBusy === d.deviceId} {...rowProps(d)} />
            ))}
          </div>
        </>
      )}

      {inactive.length > 0 && (
        <div style={{ marginTop: 24, opacity: 0.45 }}>
          <div style={{ fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 }}>
            Not heard from in a week ({inactive.length}) — not counted above
          </div>
          {inactive.map((d) => (
            <DeviceRow key={d.deviceId} d={d} now={now}
              mirrorOff={deviceOffVerdict(offMap[d.deviceId])}
              onToggleOff={toggleOff} busy={offBusy === d.deviceId} {...rowProps(d)} />
          ))}
        </div>
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

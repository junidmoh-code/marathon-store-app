// ─── DEVICE CODES — WHO IS ON WHICH DEVICE, AND THE CODES THAT PUT THEM THERE ─
//
// Junid's (and MC's) screen for the device enrolment described in
// src/device/enrolment.js. Three things:
//
//   Make a code  — type a person's name (or a shop device's, e.g. "Hub 2
//                  tablet"), get a random 4-digit code, hand it over. It is
//                  shown ONCE: the list never carries it again.
//   People       — each person or shared device, how many devices their code
//                  is on, and one tap to revoke them (every device off, the
//                  code dead).
//   Devices      — each enrolled device: whose it is, what it is, when it was
//                  enrolled, when it was last seen, how many rejects it has
//                  pressed. One tap revokes just that device.
//
// A revoke takes effect on that device's next action: its gate entry on the
// /users record is deleted, so the rules refuse its next write and its screen
// drops to the code entry, live.
//
// Everything goes through the deviceEnrolmentAdmin callable. The client reads
// nothing under /device_enrolment itself — that node has no read rule — and
// the callable decides who may do what (Junid, or an enrolled code-maker).

import { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

const adminCall = httpsCallable(functions, "deviceEnrolmentAdmin");
const defaultCall = async (data) => (await adminCall(data)).data;

const SAST_OFFSET_MS = 2 * 3600e3;
export function when(ms, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = new Date(ms + SAST_OFFSET_MS);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

function errText(e) {
  return String(e?.message || e || "That did not work.").replace(/^.*?:\s*/, "");
}

const btn = {
  background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8,
  padding: "8px 14px", fontSize: 14, cursor: "pointer",
};
const danger = { ...btn, background: "#3a1414", color: "#ff6961" };
const box = { border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e", marginTop: 16 };
const label = { fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 };

export default function DeviceCodesCard({ isOwner, onExit, call = defaultCall }) {
  const [list, setList] = useState({ loading: true, people: [], devices: [], email: null, error: null });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("person");
  const [maker, setMaker] = useState(false);
  const [busy, setBusy] = useState(null);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setList((l) => ({ ...l, loading: true, error: null }));
    try {
      const r = await call({ action: "list" });
      setList({ loading: false, people: r.people || [], devices: r.devices || [], email: r.email || null, error: null });
    } catch (e) {
      setList({ loading: false, people: [], devices: [], email: null, error: errText(e) });
    }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e?.preventDefault?.();
    if (!name.trim() || busy) return;
    setBusy("create"); setErr(null); setMade(null);
    try {
      const r = await call({ action: "createCode", name, kind, canManageCodes: isOwner && kind === "person" && maker });
      setMade({ code: r.code, name: r.person?.name || name.trim(), kind });
      setName(""); setMaker(false);
      load();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (action, id) => {
    if (busy) return;
    setBusy(`${action}:${id}`); setErr(null);
    try {
      await call(action === "device" ? { action: "revokeDevice", deviceId: id } : { action: "revokePerson", personId: id });
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const activeDevices = list.devices.filter((d) => d.status === "active");
  const oldDevices = list.devices.filter((d) => d.status !== "active");

  return (
    <div data-device-codes="" style={{ background: "#000", minHeight: "100vh", color: "#f2f2f7", padding: "16px 16px 60px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Device codes</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} style={btn}>Refresh</button>
          <button onClick={onExit} style={btn}>Back</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginTop: 4, lineHeight: 1.45 }}>
        Every phone on MC's login needs its own code. A person's code works on up to 2 devices;
        a shop device's code on 1.
      </div>
      {list.email && (
        <div data-email-status="" style={{ fontSize: 12.5, color: "#8e8e93", marginTop: 6 }}>
          Emails to Junid: last sent {when(list.email.lastSentAtMs, now)}
          {list.email.queued ? ` · ${list.email.queued} waiting (they go out together, at most every 31 minutes)` : ""}
        </div>
      )}

      {/* ── MAKE A CODE ───────────────────────────────────────────────────── */}
      <form onSubmit={create} style={box}>
        <div style={label}>Make a code</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {[["person", "A person"], ["shared", "A shop device"]].map(([k, t]) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              style={{ ...btn, background: kind === k ? "#0a84ff" : "#2c2c2e" }}>{t}</button>
          ))}
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
          placeholder={kind === "shared" ? "Device name, e.g. Hub 2 tablet" : "Person's name"}
          aria-label={kind === "shared" ? "Device name" : "Person's name"}
          style={{ width: "100%", boxSizing: "border-box", marginTop: 10, padding: "10px 12px", fontSize: 16,
            background: "#000", color: "#fff", border: "1px solid #3a3a3c", borderRadius: 8 }} />
        {isOwner && kind === "person" && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 14, color: "#d1d1d6" }}>
            <input type="checkbox" checked={maker} onChange={(e) => setMaker(e.target.checked)} />
            Can make and revoke codes (for MC)
          </label>
        )}
        <button type="submit" disabled={!name.trim() || !!busy}
          style={{ ...btn, marginTop: 12, background: "#0a84ff", opacity: !name.trim() || busy ? 0.5 : 1 }}>
          {busy === "create" ? "Making…" : "Make code"}
        </button>
        {made && (
          <div role="status" style={{ marginTop: 14, padding: 14, borderRadius: 10, background: "#0b2a14", border: "1px solid #30d158" }}>
            <div style={{ fontSize: 14, color: "#d1d1d6" }}>Code for <b>{made.name}</b></div>
            <div data-new-code="" style={{ fontSize: 44, fontWeight: 800, letterSpacing: 8, margin: "6px 0", fontFamily: "ui-monospace, Menlo, monospace" }}>
              {made.code}
            </div>
            <div style={{ fontSize: 13, color: "#a1a1a6", lineHeight: 1.45 }}>
              Give this to {made.name}. It is shown only now — write it down or hand it over before you leave this screen.
              {made.kind === "shared" ? " It works on one device." : " It works on up to 2 devices."}
            </div>
            <button type="button" onClick={() => setMade(null)} style={{ ...btn, marginTop: 10 }}>Done</button>
          </div>
        )}
      </form>

      {err && <div role="alert" style={{ ...box, borderColor: "#ff453a", color: "#ff6961" }}>{err}</div>}
      {list.error && <div role="alert" style={{ ...box, borderColor: "#ff453a", color: "#ff6961" }}>{list.error}</div>}

      {/* ── DEVICES ───────────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={label}>Devices ({activeDevices.length})</div>
        {list.loading && !list.devices.length && <div style={{ marginTop: 10, color: "#8e8e93" }}>Loading…</div>}
        {!list.loading && !activeDevices.length && <div style={{ marginTop: 10, color: "#8e8e93" }}>No devices enrolled yet.</div>}
        {activeDevices.map((d) => (
          <div key={d.deviceId} data-device-row={d.deviceId} style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderTop: "1px solid #2c2c2e", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: "1 1 220px" }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{d.personName || "—"}{d.kind === "shared" ? " (shop device)" : ""}</div>
              <div style={{ fontSize: 13, color: "#a1a1a6", marginTop: 2 }}>{d.deviceType || "Unknown device"}</div>
              <div style={{ fontSize: 12.5, color: "#8e8e93", marginTop: 2 }}>
                Enrolled {when(d.enrolledAtMs, now)} · Last seen {when(d.lastSeenAtMs, now)} · {d.rejectCount} reject{d.rejectCount === 1 ? "" : "s"}
              </div>
            </div>
            <button type="button" onClick={() => revoke("device", d.deviceId)} disabled={!!busy} style={danger}>
              {busy === `device:${d.deviceId}` ? "Revoking…" : "Revoke device"}
            </button>
          </div>
        ))}
      </div>

      {/* ── PEOPLE ────────────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={label}>People and shop devices</div>
        {!list.loading && !list.people.length && <div style={{ marginTop: 10, color: "#8e8e93" }}>No codes made yet.</div>}
        {list.people.map((p) => (
          <div key={p.personId} data-person-row={p.personId} style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderTop: "1px solid #2c2c2e", flexWrap: "wrap", opacity: p.status === "active" ? 1 : 0.55 }}>
            <div style={{ minWidth: 0, flex: "1 1 220px" }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                {p.name}{p.kind === "shared" ? " (shop device)" : ""}{p.canManageCodes ? " · makes codes" : ""}
              </div>
              <div style={{ fontSize: 12.5, color: "#8e8e93", marginTop: 2 }}>
                {p.status === "active"
                  ? `Code on ${p.devices} of ${p.maxDevices} device${p.maxDevices === 1 ? "" : "s"} · made ${when(p.createdAtMs, now)}${p.createdBy ? ` by ${p.createdBy}` : ""}`
                  : `Revoked ${when(p.revokedAtMs, now)}`}
              </div>
            </div>
            {p.status === "active" && (
              <button type="button" onClick={() => revoke("person", p.personId)} disabled={!!busy} style={danger}>
                {busy === `person:${p.personId}` ? "Revoking…" : "Revoke person"}
              </button>
            )}
          </div>
        ))}
      </div>

      {oldDevices.length > 0 && (
        <div style={box}>
          <div style={label}>Revoked devices ({oldDevices.length})</div>
          {oldDevices.map((d) => (
            <div key={d.deviceId} style={{ padding: "10px 0", borderTop: "1px solid #2c2c2e", fontSize: 13, color: "#8e8e93" }}>
              {d.personName || "—"} · {d.deviceType || "Unknown device"} · revoked {when(d.revokedAtMs, now)}{d.revokedBy ? ` by ${d.revokedBy}` : ""} · {d.rejectCount} reject{d.rejectCount === 1 ? "" : "s"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

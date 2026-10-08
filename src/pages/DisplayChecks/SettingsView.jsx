// ─── DISPLAY CHECKS — SETTINGS TAB (manager) ─────────────────────────────────
// Per-store config the engine actually consumes:
//   /displayChecks_settings/{store}/config  { wakeDelayMinutes, repeatWindowMinutes, closeTime }
//       read by functions/displayChecks/wakeHeldChecks.js
//   /displayChecks_settings/{store}/roster  { locked, days:{mon…sun:{uid,name}} }
//       read by functions/displayChecks/onClothingSale.js + wakeHeldChecks.js
//
// Writes are gated to super-admin by the displayChecks_settings RTDB rule
// (deployed 2026-07-21). The weekday roster assigns who a store's checks land on;
// staff choices are the store's own people (users with destShop === store).

import { useEffect, useMemo, useState } from "react";
import { ref, get, set } from "firebase/database";
import { database } from "../../firebase";
import { SHOP_LABELS } from "../../utils/stores";
import { DISPLAY_SCOPES, DISPLAY_SCOPE_LABELS, displayCheckSwitchOf, isDisplayChecksStoreEnabled, noteDisplayCheckSwitches } from "../../config/displayChecks";
import { FONT, MONO, BLUE, BLUE_SOFT, AMBER, INK, GLASS_BG, GLASS_BORDER, PANEL, META } from "./tokens";

const DEFAULTS = { wakeDelayMinutes: 20, repeatWindowMinutes: 30, closeTime: "18:00" };
const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];

function Field({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ ...META, color: "rgba(233,238,255,.55)" }}>{label}</div>
      {children}
      {hint && <div style={{ fontFamily: FONT, fontSize: 11.5, color: "rgba(233,238,255,.4)" }}>{hint}</div>}
    </div>
  );
}

const inputStyle = {
  fontFamily: MONO, fontSize: 16, color: INK, background: GLASS_BG, border: GLASS_BORDER,
  borderRadius: 10, padding: "11px 13px", outline: "none", width: "100%", boxSizing: "border-box",
};
const selectStyle = {
  fontFamily: FONT, fontSize: 12.5, color: INK, background: "#12141c", border: GLASS_BORDER,
  borderRadius: 9, padding: "8px 8px", outline: "none", width: "100%", boxSizing: "border-box", cursor: "pointer",
};

export default function SettingsView({ store, wide, active, isSuper = false }) {
  // THE STORE'S SWITCH (owner only): /displayChecks_settings/{store}/enabled
  // and /scope. Read with the rest of the settings; written one field each.
  const [sw, setSw] = useState({ enabled: null, scope: "clothing" });
  const [swMsg, setSwMsg] = useState(null);
  const [savingSw, setSavingSw] = useState(false);
  const [cfg, setCfg] = useState(DEFAULTS);
  const [roster, setRoster] = useState({ locked: false, days: {} });
  const [staff, setStaff] = useState([]);
  const [staffError, setStaffError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingRoster, setSavingRoster] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rosterMsg, setRosterMsg] = useState(null);

  useEffect(() => {
    // The view stays mounted-but-hidden in the module; only read when it's the
    // active tab, so managers don't pay 3 reads (incl. the whole /users node) on
    // every module open they never visit Settings.
    if (!store || active === false) return;
    let alive = true;
    setLoaded(false);
    Promise.all([
      get(ref(database, `displayChecks_settings/${store}/config`)).then((s) => s.val()).catch(() => null),
      get(ref(database, `displayChecks_settings/${store}/roster`)).then((s) => s.val()).catch(() => null),
      get(ref(database, "users")).then((s) => ({ ok: true, val: s.val() })).catch(() => ({ ok: false, val: null })),
      get(ref(database, `displayChecks_settings/${store}/enabled`)).then((s) => s.val()).catch(() => null),
      get(ref(database, `displayChecks_settings/${store}/scope`)).then((s) => s.val()).catch(() => null),
    ]).then(([c, r, usersRes, en, sc]) => {
      if (!alive) return;
      setSw(displayCheckSwitchOf(store, { [store]: { enabled: en, scope: sc } }));
      setCfg({ ...DEFAULTS, ...(c || {}) });
      setRoster({ locked: !!r?.locked, days: r?.days || {} });
      // The store's own people — destShop === store — are the assignable staff.
      if (usersRes.ok) {
        const list = Object.entries(usersRes.val || {})
          .filter(([, u]) => u && u.destShop === store)
          .map(([uid, u]) => ({ uid, name: u.displayName || u.username || uid }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setStaff(list); setStaffError(false);
      } else { setStaff([]); setStaffError(true); }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [store, active]);

  const saveConfig = async () => {
    setSaving(true); setMsg(null);
    const payload = {
      wakeDelayMinutes: Math.max(0, Math.round(Number(cfg.wakeDelayMinutes) || 0)),
      repeatWindowMinutes: Math.max(0, Math.round(Number(cfg.repeatWindowMinutes) || 0)),
      closeTime: /^\d{2}:\d{2}$/.test(cfg.closeTime) ? cfg.closeTime : DEFAULTS.closeTime,
    };
    try {
      await set(ref(database, `displayChecks_settings/${store}/config`), payload);
      setMsg({ ok: true, text: "Saved. The engine picks this up on its next run." });
      setCfg((c) => ({ ...c, ...payload }));
    } catch (e) {
      setMsg({ ok: false, text: /permission/i.test(e?.message || "") ? "Permission denied — sign in as super-admin." : `Could not save: ${e?.message || "error"}` });
    } finally { setSaving(false); }
  };

  const setDay = (dayKey, uid) => {
    setRoster((r) => {
      const days = { ...r.days };
      if (!uid) delete days[dayKey];
      else { const s = staff.find((x) => x.uid === uid); days[dayKey] = { uid, name: s?.name || uid }; }
      return { ...r, days };
    });
  };

  const saveRoster = async () => {
    setSavingRoster(true); setRosterMsg(null);
    try {
      await set(ref(database, `displayChecks_settings/${store}/roster`), { locked: !!roster.locked, days: roster.days || {} });
      setRosterMsg({ ok: true, text: "Roster saved." });
    } catch (e) {
      setRosterMsg({ ok: false, text: /permission/i.test(e?.message || "") ? "Permission denied — sign in as super-admin." : `Could not save: ${e?.message || "error"}` });
    } finally { setSavingRoster(false); }
  };

  const saveSwitch = async (next) => {
    setSavingSw(true); setSwMsg(null);
    try {
      await Promise.all([
        set(ref(database, `displayChecks_settings/${store}/enabled`), next.enabled === true),
        set(ref(database, `displayChecks_settings/${store}/scope`), next.scope),
      ]);
      const saved = { enabled: next.enabled === true, scope: next.scope };
      setSw(saved);
      noteDisplayCheckSwitches({ [store]: saved });
      setSwMsg({ ok: true, text: "Saved. Sales pick this up within a minute." });
    } catch (e) {
      setSwMsg({ ok: false, text: /permission/i.test(e?.message || "") ? "Permission denied — sign in as super-admin." : `Could not save: ${e?.message || "error"}` });
    } finally { setSavingSw(false); }
  };

  if (!store) return <div style={{ ...META, color: "rgba(233,238,255,.4)" }}>NO STORE SELECTED</div>;
  if (!loaded) return <div style={{ ...META, color: "rgba(233,238,255,.4)", padding: "20px 0" }}>READING SETTINGS…</div>;

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ ...META, color: "rgba(233,238,255,.5)" }}>{SHOP_LABELS[store]?.toUpperCase() || "—"}</div>

      {/* The store's switch and scope — owner only */}
      {isSuper && (
        <div style={{ ...PANEL, padding: 20, display: "flex", flexDirection: "column", gap: 14 }} data-testid="dc-switch">
          <div style={{ ...META, color: BLUE_SOFT }}>DISPLAY CHECK AT THIS STORE</div>
          <div style={{ fontFamily: FONT, fontSize: 13, color: "rgba(233,238,255,.6)" }}>
            {sw.enabled === null
              ? `Not set — following the store's network setting (${isDisplayChecksStoreEnabled(store, undefined, {}) ? "on" : "off"}).`
              : `Set by you: ${sw.enabled ? "on" : "off"}.`}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[[true, "On"], [false, "Off"]].map(([v, label]) => (
              <button key={label} type="button" disabled={savingSw} aria-pressed={sw.enabled === v}
                      onClick={() => saveSwitch({ enabled: v, scope: sw.scope })}
                      style={{ ...META, cursor: "pointer", padding: "8px 14px", borderRadius: 999,
                               background: sw.enabled === v ? "rgba(74,127,255,.18)" : GLASS_BG, border: sw.enabled === v ? `1px solid ${BLUE}` : GLASS_BORDER,
                               color: sw.enabled === v ? BLUE_SOFT : "rgba(233,238,255,.5)" }}>{label}</button>
            ))}
          </div>
          <Field label="WHAT GOES ON THE CHECK" hint="Which sold items create a display check at this store.">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {DISPLAY_SCOPES.map((sc) => (
                <button key={sc} type="button" disabled={savingSw} aria-pressed={sw.scope === sc}
                        onClick={() => saveSwitch({ enabled: sw.enabled === null ? isDisplayChecksStoreEnabled(store, undefined, {}) : sw.enabled, scope: sc })}
                        style={{ ...META, cursor: "pointer", padding: "8px 14px", borderRadius: 999,
                                 background: sw.scope === sc ? "rgba(74,127,255,.18)" : GLASS_BG, border: sw.scope === sc ? `1px solid ${BLUE}` : GLASS_BORDER,
                                 color: sw.scope === sc ? BLUE_SOFT : "rgba(233,238,255,.5)" }}>{DISPLAY_SCOPE_LABELS[sc]}</button>
              ))}
            </div>
          </Field>
          {swMsg && <div style={{ fontFamily: FONT, fontSize: 12.5, color: swMsg.ok ? BLUE_SOFT : AMBER }}>{swMsg.text}</div>}
        </div>
      )}

      {/* Config */}
      <div style={{ ...PANEL, padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ ...META, color: BLUE_SOFT }}>CHECK ENGINE</div>
        <div style={{ display: "grid", gridTemplateColumns: wide ? "1fr 1fr" : "1fr", gap: 16 }}>
          <Field label="WAKE DELAY (MINUTES)" hint="How long a held check waits before it re-opens after stock reappears.">
            <input type="number" min="0" value={cfg.wakeDelayMinutes} onChange={(e) => setCfg((c) => ({ ...c, wakeDelayMinutes: e.target.value }))} style={inputStyle} />
          </Field>
          <Field label="REPEAT WINDOW (MINUTES)" hint="Re-sell of the same size inside this window won't raise a second check.">
            <input type="number" min="0" value={cfg.repeatWindowMinutes} onChange={(e) => setCfg((c) => ({ ...c, repeatWindowMinutes: e.target.value }))} style={inputStyle} />
          </Field>
          <Field label="CLOSE TIME" hint="Store close (SAST). Outstanding checks roll over after this.">
            <input type="time" value={cfg.closeTime} onChange={(e) => setCfg((c) => ({ ...c, closeTime: e.target.value }))} style={inputStyle} />
          </Field>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={saveConfig} disabled={saving} style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 700, cursor: saving ? "default" : "pointer", color: "#fff", background: saving ? "rgba(74,127,255,.4)" : BLUE, border: "none", borderRadius: 10, padding: "11px 22px" }}>{saving ? "Saving…" : "Save"}</button>
          {msg && <span style={{ fontFamily: FONT, fontSize: 12.5, color: msg.ok ? "#4ADE80" : "rgba(255,140,140,.95)" }}>{msg.text}</span>}
        </div>
      </div>

      {/* Roster — editable */}
      <div style={{ ...PANEL, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ ...META, color: BLUE_SOFT }}>WEEKLY ROSTER</div>
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", ...META, color: roster.locked ? AMBER : "rgba(233,238,255,.5)" }}>
            <input type="checkbox" checked={roster.locked} onChange={(e) => setRoster((r) => ({ ...r, locked: e.target.checked }))} />
            {roster.locked ? "LOCKED" : "DRAFT"}
          </label>
        </div>

        {staffError ? (
          <div style={{ fontFamily: FONT, fontSize: 12.5, color: "rgba(255,140,140,.95)", padding: "6px 0 14px" }}>
            Couldn't load the staff list — reopen Settings to retry.
          </div>
        ) : staff.length === 0 ? (
          <div style={{ fontFamily: FONT, fontSize: 12.5, color: "rgba(255,180,120,.9)", padding: "6px 0 14px" }}>
            No staff are scoped to this store (destShop = {store}) yet, so there's no one to assign. Set their store in User Management first.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(7,1fr)" : "repeat(2,1fr)", gap: 8 }}>
            {DAYS.map(([k, label]) => (
              <div key={k} style={{ background: GLASS_BG, border: GLASS_BORDER, borderRadius: 10, padding: "9px 8px" }}>
                <div style={{ ...META, color: "rgba(233,238,255,.4)", marginBottom: 6, textAlign: "center" }}>{label.toUpperCase()}</div>
                <select value={roster.days?.[k]?.uid || ""} disabled={roster.locked} onChange={(e) => setDay(k, e.target.value)} style={{ ...selectStyle, opacity: roster.locked ? 0.5 : 1 }}>
                  <option value="">—</option>
                  {staff.map((s) => <option key={s.uid} value={s.uid}>{s.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
          <button onClick={saveRoster} disabled={savingRoster || staff.length === 0} style={{ fontFamily: FONT, fontSize: 13.5, fontWeight: 700, cursor: (savingRoster || !staff.length) ? "default" : "pointer", color: "#fff", background: (savingRoster || !staff.length) ? "rgba(74,127,255,.4)" : BLUE, border: "none", borderRadius: 10, padding: "11px 22px" }}>{savingRoster ? "Saving…" : "Save roster"}</button>
          {rosterMsg && <span style={{ fontFamily: FONT, fontSize: 12.5, color: rosterMsg.ok ? "#4ADE80" : "rgba(255,140,140,.95)" }}>{rosterMsg.text}</span>}
        </div>
        <div style={{ fontFamily: FONT, fontSize: 11.5, color: "rgba(233,238,255,.4)", marginTop: 12 }}>
          Whoever's set for a weekday gets that day's checks. Lock freezes the week; cover-for-a-day is the next slice.
        </div>
      </div>
    </div>
  );
}

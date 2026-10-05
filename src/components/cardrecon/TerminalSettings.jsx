// ─── TERMINAL SETTINGS — THE ESTATE, CHANGED FROM THE SCREEN ─────────────────
// Owner only (gunidmoh@gmail.com): opened from the settings icon on the Card
// machines page. Lists every card terminal and adds, edits, retires,
// reinstates and replaces them — the changes that used to need a Claude Code
// session and scripts/apply-terminal-registry-*.mjs.
//
// THIS FILE WRITES NOTHING. Every change goes to the cardTerminalAdmin callable
// (functions/cardRecon/cardTerminalAdmin.js), which re-checks all of it with
// the Admin SDK; the registry itself arrives here from the screen's own live
// read, so a change shows up the moment it lands.
//
// WHAT CAN BE TYPED, AND WHAT CANNOT:
//   • TID — the only typed identity, [A-Z0-9]{4,16}, uppercased as typed.
//   • Store and till — PICKED from the POS's own list (the callable's
//     "options"). The store key joins to /pos/paymentEvents; a key the POS
//     never writes would make every variance 100% short.
//   • Label (display only) and MID (optional) — typed.
//   • Capture — Email, Photo or Both. An Email-only card shows its tick and
//     never the camera.
//
// A TID IS NEVER OVERWRITTEN OR DELETED — batches are keyed by it. A swapped
// speedpoint is "Replace TID": the old one is retired and the new one takes
// its till, in one action. A store never changes in place (see
// lib/card-terminal-admin.cjs for why).
//
// A MACHINE CARRIED TO ANOTHER TILL — this shop's or another's — is "Moved":
// the till it went to and the time it moved (SAST). That writes a placement
// (lib/card-terminal-placements.cjs); the owner's Card Recon reconciles every
// transaction on the till its machine stood on at that moment, and a batch
// that spans the move is split, or combined across the tills when the slip is
// only a summary. 5 Oct 2026: PE Till 1 ↔ Trophy Till 1, entered as two moves.
//
// No window.confirm — a browser dialog blocks the page. Retire asks inline.

import React, { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT } from "./cardReconStyles";
import { captureMode, isRetiredTerminal } from "./terminalRegistry";
import { serverNowMs } from "../../utils/serverTime";

const adminFn = httpsCallable(functions, "cardTerminalAdmin", { timeout: 60000 });

export const TID_PATTERN = /^[A-Z0-9]{4,16}$/;
const CAPTURE_LABEL = { email: "Email", photo: "Photo", typed: "Typed", both: "Both" };

// SAST is UTC+2 all year. The time typed is SAST whatever the phone is set to.
const SAST_MS = 2 * 60 * 60 * 1000;
export const sastInputValue = (ms) => new Date(ms + SAST_MS).toISOString().slice(0, 16);
export const sastInputMs = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v || "") ? Date.parse(`${v}:00+02:00`) : NaN);
const sastWhen = (ms) => new Date(ms + SAST_MS).toISOString().slice(0, 16).replace("T", " ");

/** A row's placements, oldest first (mirror of functions/lib/card-terminal-placements.cjs). */
function placementsOf(row) {
  return Object.values(row?.placements || {})
    .filter((p) => p && p.storeId && p.tillId && Number.isFinite(Number(p.effectiveFrom)))
    .sort((a, b) => Number(a.effectiveFrom) - Number(b.effectiveFrom));
}

/**
 * MOVED — the machine was carried to another till. Store and till are picked
 * (any store: the filing store stays as it is), the time is when it moved.
 */
function MoveForm({ base, stores, busy, onSubmit, onCancel }) {
  const [storeId, setStoreId] = useState("");
  const [tillId, setTillId] = useState("");
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState(() => sastInputValue(serverNowMs()));
  const store = stores.find((s) => s.storeId === storeId);
  const tills = store ? store.tills : [];
  const atMs = sastInputMs(when);
  const ready = storeId && tills.some((t) => t.tillId === tillId) && label.trim() && Number.isFinite(atMs);
  const pickTill = (id) => {
    setTillId(id);
    const name = tills.find((t) => t.tillId === id)?.name;
    if (name && !label.trim()) setLabel(`${storeId === "pe" ? "Marathon" : store.label} ${name}`.slice(0, 40));
  };
  return (
    <form style={U.form} onSubmit={(e) => { e.preventDefault(); if (ready && !busy) onSubmit({ tid: base.tid, storeId, tillId, label: label.trim(), effectiveFrom: atMs }); }}>
      <div style={{ ...U.name, fontSize: 15 }}>{`Moved ${base.label || base.tid} (${base.tid})`}</div>
      <div style={U.note}>The machine itself went to another till. Its batches stay filed where they are; card recon puts each transaction on the till it was on at that moment.</div>
      <label style={U.label} htmlFor="tm-store">Now in store</label>
      <select id="tm-store" style={U.input} value={storeId} onChange={(e) => { setStoreId(e.target.value); setTillId(""); }}>
        <option value="">Pick the store…</option>
        {stores.map((s) => <option key={s.storeId} value={s.storeId}>{s.label}</option>)}
      </select>
      <label style={U.label} htmlFor="tm-till">Now on till</label>
      <select id="tm-till" style={U.input} value={tillId} disabled={!store} onChange={(e) => pickTill(e.target.value)}>
        <option value="">{store ? "Pick the till…" : "Pick the store first"}</option>
        {tills.map((t) => <option key={t.tillId} value={t.tillId}>{t.name}</option>)}
      </select>
      <label style={U.label} htmlFor="tm-when">Moved at (SAST)</label>
      <input id="tm-when" type="datetime-local" style={U.input} value={when} onChange={(e) => setWhen(e.target.value)} />
      <label style={U.label} htmlFor="tm-label">Label from then</label>
      <input id="tm-label" style={U.input} value={label} maxLength={40} placeholder="e.g. Trophy Till 1" onChange={(e) => setLabel(e.target.value)} />
      <button type="submit" style={{ ...U.primary, opacity: ready && !busy ? 1 : 0.45 }} disabled={!ready || busy}>{busy ? "Saving…" : "Save the move"}</button>
      <button type="button" style={{ ...U.chip, width: "100%", marginTop: 8 }} onClick={onCancel} disabled={busy}>Cancel</button>
    </form>
  );
}

const U = {
  wrap: { marginTop: 22 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  h2: { fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: "-0.3px" },
  close: { appearance: "none", border: 0, background: "transparent", color: "rgba(233,238,255,.6)", fontFamily: FONT,
           fontSize: 15, fontWeight: 600, minHeight: 44, padding: "0 4px", cursor: "pointer" },
  row: { padding: "14px 16px", borderRadius: 16, background: "rgba(255,255,255,.045)",
         border: "1px solid rgba(255,255,255,.075)", marginTop: 10 },
  rowRetired: { opacity: 0.55 },
  name: { fontSize: 16, fontWeight: 600 },
  meta: { fontSize: 13, color: "rgba(233,238,255,.5)", marginTop: 3, lineHeight: 1.5, wordBreak: "break-word" },
  actions: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: { appearance: "none", minHeight: 38, padding: "0 14px", borderRadius: 11, cursor: "pointer", fontFamily: FONT,
          fontSize: 13.5, fontWeight: 600, color: "rgba(233,238,255,.85)", background: "rgba(255,255,255,.06)",
          border: "1px solid rgba(255,255,255,.14)" },
  danger: { color: "#FFB3B3", border: "1px solid rgba(255,107,107,.35)", background: "rgba(255,107,107,.07)" },
  primary: { appearance: "none", width: "100%", minHeight: 48, borderRadius: 13, cursor: "pointer", fontFamily: FONT,
             fontSize: 15, fontWeight: 700, color: "#D7E3FF", background: "rgba(74,127,255,.2)",
             border: "1px solid rgba(74,127,255,.55)", marginTop: 14 },
  form: { padding: 16, borderRadius: 16, background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.28)", marginTop: 12 },
  label: { display: "block", fontSize: 12.5, fontWeight: 600, color: "rgba(233,238,255,.55)", margin: "12px 0 5px" },
  input: { width: "100%", boxSizing: "border-box", minHeight: 44, borderRadius: 11, padding: "0 12px", fontFamily: FONT,
           fontSize: 16, color: "#E9EEFF", background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.16)" },
  fixed: { fontSize: 15, padding: "10px 0 2px", color: "rgba(233,238,255,.8)" },
  seg: { display: "flex", gap: 6 },
  segBtn: { flex: 1, minHeight: 42, borderRadius: 11, cursor: "pointer", fontFamily: FONT, fontSize: 14, fontWeight: 600,
            color: "rgba(233,238,255,.7)", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.14)" },
  segOn: { color: "#D7E3FF", background: "rgba(74,127,255,.22)", border: "1px solid rgba(74,127,255,.6)" },
  note: { fontSize: 12.5, color: "rgba(233,238,255,.45)", marginTop: 6, lineHeight: 1.5 },
  err: { fontSize: 13.5, lineHeight: 1.5, color: "#FFB3B3", background: "rgba(255,107,107,.07)",
         border: "1px solid rgba(255,107,107,.28)", borderRadius: 12, padding: "10px 12px", marginTop: 12 },
  ok: { fontSize: 13.5, lineHeight: 1.5, color: "#8FE3A8", background: "rgba(52,199,89,.07)",
        border: "1px solid rgba(52,199,89,.25)", borderRadius: 12, padding: "10px 12px", marginTop: 12 },
  quiet: { fontSize: 13, color: "rgba(233,238,255,.4)", marginTop: 18 },
};

const storeName = (stores, id) => stores.find((s) => s.storeId === id)?.label || id;
const tillName = (stores, storeId, tillId) =>
  stores.find((s) => s.storeId === storeId)?.tills.find((t) => t.tillId === tillId)?.name || tillId;

/** The callable's refusal (or a thrown error) as one sentence. */
function sentenceOf(err) {
  const msg = String(err?.message || "").trim();
  return msg && /\s/.test(msg) ? msg : "That did not save, and no reason came back. Nothing changed — try again.";
}

/**
 * The form for add / edit / replace. `mode` decides which fields are typed:
 *   add     — TID, store, till, label, MID, capture
 *   edit    — till, label, MID, capture (TID and store fixed)
 *   replace — the NEW TID, label, MID, capture (store and till carried over)
 */
function TerminalForm({ mode, base, stores, busy, onSubmit, onCancel }) {
  const [tid, setTid] = useState(mode === "edit" ? base.tid : "");
  const [storeId, setStoreId] = useState(base?.storeId || "");
  const [tillId, setTillId] = useState(base?.tillId || "");
  const [label, setLabel] = useState(base?.label || "");
  const [mid, setMid] = useState(mode === "replace" ? "" : (base?.mid || ""));
  const [capture, setCapture] = useState(base ? captureMode(base) : "both");

  const store = stores.find((s) => s.storeId === storeId);
  const tills = store ? store.tills : [];
  const tidOk = TID_PATTERN.test(tid);
  const ready = tidOk && storeId && tills.some((t) => t.tillId === tillId) && label.trim();

  const submit = (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    onSubmit({ tid, storeId, tillId, label: label.trim(), mid: mid.trim(), capture });
  };

  return (
    <form style={U.form} onSubmit={submit}>
      <div style={{ ...U.name, fontSize: 15 }}>
        {mode === "add" ? "Add a terminal" : mode === "edit" ? `Edit ${base.label || base.tid}` : `Replace ${base.label || base.tid} (${base.tid})`}
      </div>

      {mode !== "edit" ? (
        <>
          <label style={U.label} htmlFor="ts-tid">{mode === "replace" ? "New TID" : "TID"}</label>
          <input id="ts-tid" style={U.input} value={tid} autoCapitalize="characters" autoComplete="off"
                 spellCheck={false} inputMode="text" maxLength={16} placeholder="As printed after TID: on the slip"
                 onChange={(e) => setTid(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          {tid && !tidOk && <div style={U.note}>4 to 16 letters and digits.</div>}
        </>
      ) : (
        <><div style={U.label}>TID</div><div style={U.fixed}>{base.tid}</div></>
      )}

      {mode === "add" ? (
        <>
          <label style={U.label} htmlFor="ts-store">Store</label>
          <select id="ts-store" style={U.input} value={storeId}
                  onChange={(e) => { setStoreId(e.target.value); setTillId(""); }}>
            <option value="">Pick the store…</option>
            {stores.map((s) => <option key={s.storeId} value={s.storeId}>{s.label}</option>)}
          </select>
        </>
      ) : (
        <>
          <div style={U.label}>Store</div>
          <div style={U.fixed}>{storeName(stores, storeId)}</div>
          {mode === "edit" && <div style={U.note}>A terminal never changes store — its batches are filed under this one. Moving shop is retire here, add there.</div>}
        </>
      )}

      {mode === "replace" ? (
        <><div style={U.label}>Till</div><div style={U.fixed}>{tillName(stores, storeId, tillId)}</div></>
      ) : (
        <>
          <label style={U.label} htmlFor="ts-till">Till</label>
          <select id="ts-till" style={U.input} value={tillId} disabled={!store}
                  onChange={(e) => setTillId(e.target.value)}>
            <option value="">{store ? "Pick the till…" : "Pick the store first"}</option>
            {tills.map((t) => <option key={t.tillId} value={t.tillId}>{t.name}</option>)}
          </select>
          {mode === "edit" && base.tillId && tillId && tillId !== base.tillId && (
            <div style={U.note}>Moving tills is recorded, and the one batch that spans the move is flagged on its record.</div>
          )}
        </>
      )}

      <label style={U.label} htmlFor="ts-label">Label</label>
      <input id="ts-label" style={U.input} value={label} maxLength={40} placeholder="e.g. Trophy Till 2"
             onChange={(e) => setLabel(e.target.value)} />

      <label style={U.label} htmlFor="ts-mid">MID (optional)</label>
      <input id="ts-mid" style={U.input} value={mid} inputMode="numeric" autoComplete="off" maxLength={24}
             onChange={(e) => setMid(e.target.value.replace(/[^\d ]/g, ""))} />

      <div style={U.label}>Capture</div>
      <div style={U.seg} role="radiogroup" aria-label="Capture">
        {["email", "photo", "typed", "both"].map((m) => (
          <button type="button" key={m} role="radio" aria-checked={capture === m}
                  style={{ ...U.segBtn, ...(capture === m ? U.segOn : null) }} onClick={() => setCapture(m)}>
            {CAPTURE_LABEL[m]}
          </button>
        ))}
      </div>
      <div style={U.note}>
        {capture === "email" ? "The card shows its tick when the report arrives by email — no camera."
          : capture === "photo" ? "The card opens the camera; this machine does not email."
          : capture === "typed" ? "The card opens one box for the total — no camera and no email. For a machine that cannot send its report and does not print its total, where there is nothing to photograph. The figure is the whole record, so nothing can be checked against paper afterwards: set this only where a readable slip genuinely does not exist."
          : "Ticks by email, and the camera is there when the email does not come."}
      </div>

      <button type="submit" style={{ ...U.primary, opacity: ready && !busy ? 1 : 0.45 }} disabled={!ready || busy}>
        {busy ? "Saving…" : mode === "add" ? "Add terminal" : mode === "edit" ? "Save" : "Replace TID"}
      </button>
      <button type="button" style={{ ...U.chip, width: "100%", marginTop: 8 }} onClick={onCancel} disabled={busy}>Cancel</button>
    </form>
  );
}

export default function TerminalSettings({ terminals, onClose }) {
  const [stores, setStores] = useState(null);     // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [form, setForm] = useState(null);         // { mode, tid? }
  const [confirmRetire, setConfirmRetire] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);           // { ok, text }

  useEffect(() => {
    let live = true;
    adminFn({ action: "options" })
      .then(({ data }) => { if (live) setStores(data.stores || []); })
      .catch((err) => { if (live) setLoadErr(sentenceOf(err)); });
    return () => { live = false; };
  }, []);

  const rows = useMemo(() => Object.entries(terminals || {})
    .filter(([, r]) => r && typeof r === "object")
    .map(([tid, r]) => ({ ...r, tid }))
    .sort((a, b) => (isRetiredTerminal(a) - isRetiredTerminal(b))
      || String(a.label || a.tid).localeCompare(String(b.label || b.tid))), [terminals]);

  const call = async (payload, done) => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await adminFn(payload);
      if (!data?.ok) { setMsg({ ok: false, text: data?.reason || sentenceOf(null) }); return; }
      setMsg({ ok: true, text: done });
      setForm(null); setConfirmRetire(null);
    } catch (err) {
      setMsg({ ok: false, text: sentenceOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const base = form && form.tid ? rows.find((r) => r.tid === form.tid) : null;

  return (
    <div style={U.wrap}>
      <div style={U.head}>
        <h2 style={U.h2}>Terminals</h2>
        <button style={U.close} onClick={onClose}>Done</button>
      </div>

      {loadErr && <div style={U.err}>The POS till list could not be loaded, so terminals cannot be changed right now. {loadErr}</div>}
      {!loadErr && stores === null && <div style={U.quiet}>Loading…</div>}
      {msg && <div style={msg.ok ? U.ok : U.err}>{msg.text}</div>}

      {stores && !form && (
        <button style={U.primary} onClick={() => { setMsg(null); setForm({ mode: "add" }); }}>Add a terminal</button>
      )}
      {stores && form && form.mode === "move" && base && (
        <MoveForm key={`move:${form.tid}`} base={base} stores={stores} busy={busy} onCancel={() => setForm(null)}
          onSubmit={(t) => call({ action: "move", terminal: t },
            `${t.tid} is on ${storeName(stores, t.storeId)} ${tillName(stores, t.storeId, t.tillId)} from ${sastWhen(t.effectiveFrom)} SAST.`)} />
      )}
      {stores && form && form.mode !== "move" && (
        <TerminalForm
          key={`${form.mode}:${form.tid || ""}`}
          mode={form.mode} base={base} stores={stores} busy={busy}
          onCancel={() => setForm(null)}
          onSubmit={(t) => {
            if (form.mode === "replace") {
              call({ action: "replace", oldTid: form.tid, terminal: { tid: t.tid, label: t.label, mid: t.mid, capture: t.capture } },
                `${form.tid} is retired and ${t.tid} now takes its till.`);
            } else {
              call({ action: form.mode, terminal: t }, form.mode === "add" ? `${t.tid} added.` : `${t.tid} saved.`);
            }
          }} />
      )}

      {stores && rows.map((r) => {
        const retired = isRetiredTerminal(r);
        return (
          <div key={r.tid} style={{ ...U.row, ...(retired ? U.rowRetired : null) }}>
            <div style={U.name}>{r.label || r.tid}</div>
            <div style={U.meta}>
              {r.tid} · {storeName(stores, r.storeId)} · {tillName(stores, r.storeId, r.tillId)} · {CAPTURE_LABEL[captureMode(r)]}
              {r.mid ? ` · MID ${r.mid}` : ""}
              {retired ? ` · retired${r.replacedBy ? `, replaced by ${r.replacedBy}` : ""}` : ""}
            </div>
            {placementsOf(r).length > 1 && (
              <div style={U.meta} data-testid={`ts-placements-${r.tid}`}>
                {placementsOf(r).slice(1).map((p) => (
                  <div key={p.effectiveFrom}>Moved {sastWhen(Number(p.effectiveFrom))} SAST → {storeName(stores, p.storeId)} · {tillName(stores, p.storeId, p.tillId)}</div>
                ))}
              </div>
            )}
            {!form && (
              <div style={U.actions}>
                {!retired && <button style={U.chip} disabled={busy} onClick={() => { setMsg(null); setForm({ mode: "edit", tid: r.tid }); }}>Edit</button>}
                {!retired && <button style={U.chip} disabled={busy} onClick={() => { setMsg(null); setForm({ mode: "move", tid: r.tid }); }}>Moved</button>}
                {!retired && <button style={U.chip} disabled={busy} onClick={() => { setMsg(null); setForm({ mode: "replace", tid: r.tid }); }}>Replace TID</button>}
                {!retired && confirmRetire !== r.tid && (
                  <button style={{ ...U.chip, ...U.danger }} disabled={busy} onClick={() => setConfirmRetire(r.tid)}>Retire</button>
                )}
                {!retired && confirmRetire === r.tid && (
                  <>
                    <button style={{ ...U.chip, ...U.danger }} disabled={busy}
                            onClick={() => call({ action: "retire", terminal: { tid: r.tid } }, `${r.tid} retired. Its history stays.`)}>
                      {busy ? "Retiring…" : `Yes, retire ${r.tid}`}
                    </button>
                    <button style={U.chip} disabled={busy} onClick={() => setConfirmRetire(null)}>Keep it</button>
                  </>
                )}
                {retired && !r.replacedBy && (
                  <button style={U.chip} disabled={busy}
                          onClick={() => call({ action: "reinstate", terminal: { tid: r.tid } }, `${r.tid} reinstated.`)}>Reinstate</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

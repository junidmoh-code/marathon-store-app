// ─── NETWORK — SECTIONS, LIVE SWITCHES, CONCRETE'S BACK STOCK, CREDIT SCOPE ──
//
// Junid's card for the network registry (/network, src/utils/networkRegistry.js).
//
//   Solve           on/off per store and hub. ON = Solve may seed it, send
//                   it a first batch and route stock to it by hand. OFF =
//                   visible, countable and reportable only.
//   Auto-refill     off / solved products only / all products, per store
//                   and hub. "Solved products only" = the engine arms and
//                   refills TRUSTED cells only (arrived through Solve or a
//                   refill, or confirmed by a count). "All" = every cell, as
//                   Marathon's four always were. No deploy for either.
//   Concrete        its back stock is Hub 3, like Pine's (there is no
//                   Concrete Stockroom — removed 8 Oct 2026).
//   Credit scope    shared (credit spendable anywhere) or section (only in the
//                   section that issued it).
//   Concrete at the till   takes cash, cashier price edits, which till is the
//                   recycler — the POS's per-store switches.
//   Division names  each section's name ("Marathon", "Concrete"), shown in
//                   both apps wherever a section is named.
//
// OWNER ONLY, three layers: the tile, the route, and this component's own
// check — and the RTDB rule on /network is what actually refuses the write.
// A refused viewer reads nothing under /network or /locations: both hooks
// below are disabled for them.
import { useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { useNetwork } from "../../utils/useNetwork";
import { usePathState } from "../stock/useStock";
import { serverNowMs } from "../../utils/serverTime";
import { listLocations, sectionName, sectionsInOrder } from "../../utils/networkRegistry";
import {
  solveUpdate, autoRefillUpdate, AUTO_REFILL_LABELS, creditScopeUpdate, seedUpdate,
  sectionNameUpdate, SECTION_NAME_MAX,
  POS_FLAGS, posSwitchState, posFlagUpdate, recyclerTillUpdate,
} from "./networkSettingsCore";

const page = { minHeight: "100vh", background: "#000", color: "#f2f2f7", padding: 16, maxWidth: 760, margin: "0 auto", fontFamily: "-apple-system, system-ui, sans-serif" };
const box = { border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e", marginTop: 16 };
const label = { fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 };
const btn = { background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" };
const on = { ...btn, background: "#123a1e", color: "#30d158" };
const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: "1px solid #2c2c2e" };

const defaultWrite = (updates) => update(ref(database), updates);

// The one plain question asked before a switch moves.
export function switchQuestion({ name, kind, to }) {
  if (kind === "solve") {
    return to
      ? `Switch Solve ON for ${name}? Solve may then seed products here, send it their first batch from Central, and route stock to it by hand. The engine is a separate switch (Auto-refill).`
      : `Switch Solve OFF for ${name}? Solve will no longer offer it. Stock already there stays, and Auto-refill is unchanged.`;
  }
  if (to === "all") {
    return `Auto-refill ALL PRODUCTS for ${name}? The engine arms and refills every cell here, counted or not, and the location joins everything that runs for fully live locations: the stock audit, display checks, the refusal write-off (which can erase a count that keeps being refused), hub clean-up and the network totals. Only do this after its count.`;
  }
  if (to === "solved") {
    return `Auto-refill SOLVED PRODUCTS ONLY for ${name}? The engine arms and refills only trusted cells — stock that arrived through Solve or a refill, or was confirmed by a count. Uncounted legacy stock is ignored until it is counted.`;
  }
  return `Auto-refill OFF for ${name}? The engine will not arm or refill anything here. Stock already there stays.`;
}

function Choice({ value, options, onPick, busy }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      {options.map((o) => (
        <button key={o.value} type="button" disabled={busy} aria-pressed={value === o.value}
          style={value === o.value ? on : btn} onClick={() => value !== o.value && onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export default function NetworkSettingsCard({ authUser, products = [], onExit, write = defaultWrite, now = serverNowMs }) {
  const isOwner = !!authUser && authUser.email === ADMIN_EMAIL;
  const { registry, settled, error, raw } = useNetwork(isOwner);
  const stockLocs = usePathState("locations", isOwner);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // A switch change awaiting confirmation: { id, name, kind: "solve"|"autoRefill", to } or null.
  const [confirmSwitch, setConfirmSwitch] = useState(null);
  // The division whose name is being edited: { section, text } or null.
  const [naming, setNaming] = useState(null);


  if (!isOwner) {
    return (
      <div style={page}>
        <p>This screen is for Junid only.</p>
        <button type="button" style={btn} onClick={onExit}>Back</button>
      </div>
    );
  }

  const send = async (built, done) => {
    if (!built.ok) { setMsg({ bad: true, text: built.error }); return; }
    if (built.nothingToDo) { setMsg({ text: "Already set up." }); return; }
    setBusy(true);
    try {
      await write(built.updates);
      setMsg({ text: done });
    } catch (e) {
      setMsg({ bad: true, text: `Not saved: ${String(e?.message || e)}` });
    } finally {
      setBusy(false);
    }
  };
  const uid = authUser.uid;
  // Offered whenever ANYTHING the rules or the apps need is missing — not only
  // when /network is absent (a live flip made first creates the node without
  // its sections).
  const needsSeed = settled && !error && stockLocs.settled && !stockLocs.error
    && !seedUpdate(raw, stockLocs.value, 0, uid).nothingToDo;

  const pos = posSwitchState(registry, raw);

  return (
    <div style={page}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Network</h2>
        <button type="button" style={btn} onClick={onExit}>Done</button>
      </div>
      {error && <p style={{ color: "#ff6961" }}>The network settings could not be read. Nothing here can be changed until the database rule for /network is in place.</p>}
      {msg && <p role="status" style={{ color: msg.bad ? "#ff6961" : "#30d158" }}>{msg.text}</p>}

      {needsSeed && (
        <div style={box}>
          <div style={label}>First-time setup</div>
          <p>Something the apps need is not registered yet (Concrete, or the two division names). This adds only what is missing — new locations switched off — and changes nothing for Marathon PE, Trophy, Hub 1 or Hub 2.</p>
          <button type="button" style={btn} disabled={busy}
            onClick={() => send(seedUpdate(raw, stockLocs.value, now(), uid), "Network registered.")}>
            Set up the network
          </button>
        </div>
      )}

      {sectionsInOrder(registry).map((section) => (
        <div style={box} key={section} data-section={section}>
          {naming && naming.section === section ? (
            <form style={{ display: "flex", gap: 8, alignItems: "center" }}
              onSubmit={(e) => { e.preventDefault(); const nm = naming.text; send(sectionNameUpdate(section, nm, now(), uid), `Division named ${nm.trim()}.`); setNaming(null); }}>
              <input aria-label={`Name of division ${section}`} value={naming.text} maxLength={SECTION_NAME_MAX} autoFocus
                onChange={(e) => setNaming({ section, text: e.target.value })}
                style={{ ...btn, flex: 1, cursor: "text" }} />
              <button type="submit" style={on} disabled={busy || !naming.text.trim()}>Save</button>
              <button type="button" style={btn} onClick={() => setNaming(null)}>Cancel</button>
            </form>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={label}>{sectionName(registry, section)}</div>
              <button type="button" style={btn} disabled={busy} aria-label={`Rename ${sectionName(registry, section)}`}
                onClick={() => setNaming({ section, text: sectionName(registry, section) })}>Rename</button>
            </div>
          )}
          {listLocations(registry, { section }).map((l) => (
            <div style={{ ...row, flexWrap: "wrap" }} key={l.id} data-loc={l.id} data-solve={l.solve ? "on" : "off"} data-auto-refill={l.autoRefill}>
              <span>
                <strong>{l.name}</strong>
                <span style={{ color: "#8e8e93" }}> · {l.type === "store" ? `store · ${l.tills.length} till${l.tills.length === 1 ? "" : "s"}` : "hub"}</span>
              </span>
              <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span style={{ ...label, fontSize: 11 }}>Solve</span>
                  <button type="button" disabled={busy} aria-pressed={l.solve} aria-label={`Solve for ${l.name}`} style={l.solve ? on : btn}
                    onClick={() => setConfirmSwitch({ id: l.id, name: l.name, kind: "solve", to: !l.solve })}>
                    {l.solve ? "On" : "Off"}
                  </button>
                </span>
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span style={{ ...label, fontSize: 11 }}>Auto-refill</span>
                  <span role="group" aria-label={`Auto-refill for ${l.name}`}>
                    <Choice value={l.autoRefill} busy={busy}
                      options={["off", "solved", "all"].map((m) => ({ value: m, label: AUTO_REFILL_LABELS[m] }))}
                      onPick={(m) => setConfirmSwitch({ id: l.id, name: l.name, kind: "autoRefill", to: m })} />
                  </span>
                </span>
              </span>
            </div>
          ))}
        </div>
      ))}

      {confirmSwitch && (
        <div style={{ ...box, borderColor: "#ff9f0a" }} role="alertdialog">
          <p>{switchQuestion(confirmSwitch)}</p>
          <button type="button" style={on} disabled={busy}
            onClick={() => {
              const c = confirmSwitch; setConfirmSwitch(null);
              const built = c.kind === "solve" ? solveUpdate(registry, c.id, c.to, now(), uid) : autoRefillUpdate(registry, c.id, c.to, now(), uid);
              send(built, c.kind === "solve" ? `${c.name}: Solve ${c.to ? "on" : "off"}.` : `${c.name}: Auto-refill ${AUTO_REFILL_LABELS[c.to].toLowerCase()}.`);
            }}>
            Yes, change it
          </button>{" "}
          <button type="button" style={btn} onClick={() => setConfirmSwitch(null)}>Cancel</button>
        </div>
      )}

      <div style={box}>
        <div style={label}>Concrete — at the till</div>
        {POS_FLAGS.map((f) => (
          <div style={row} key={f.key} data-pos={f.key}>
            <span>{f.label}</span>
            <Choice value={pos.flags[f.key]} busy={busy} options={[{ value: true, label: "On" }, { value: false, label: "Off" }]}
              onPick={(v) => send(posFlagUpdate(registry, f.key, v, now(), uid), `${f.label}: ${v ? "on" : "off"}.`)} />
          </div>
        ))}
        <div style={row} data-pos="recyclerTill">
          <span>Cash recycler till</span>
          <Choice value={pos.recyclerTill} busy={busy}
            options={[{ value: null, label: "None" }, ...pos.tills.map((t) => ({ value: t.tillId, label: t.name }))]}
            onPick={(t) => send(recyclerTillUpdate(registry, t, now(), uid), t ? "Recycler till set." : "No recycler till.")} />
        </div>
        <p style={{ color: "#8e8e93", fontSize: 13 }}>Concrete starts with all of these off: card-only, manager-only price edits, no recycler. A till picks a change up without a restart.</p>
      </div>

      <div style={box}>
        <div style={label}>Store credit, laybys and owed money</div>
        <div style={row}>
          <span>Where can credit be spent?</span>
          <Choice value={registry.creditScope} busy={busy}
            options={[{ value: "shared", label: "Any store" }, { value: "section", label: "Its own section only" }]}
            onPick={(scope) => send(creditScopeUpdate(scope, now(), uid, raw?.creditScopeSince > 0 ? registry.creditScope : null), scope === "shared" ? "Credit is spendable at any store." : "Credit is spendable only in the section that issued it.")} />
        </div>
        <p style={{ color: "#8e8e93", fontSize: 13 }}>Credit issued before sections existed carries no section and stays spendable everywhere.</p>
      </div>
    </div>
  );
}

// ─── NETWORK — SECTIONS, LIVE SWITCHES, CONCRETE'S BACK STOCK, CREDIT SCOPE ──
//
// Junid's card for the network registry (/network, src/utils/networkRegistry.js).
//
//   Live            one switch per store and hub. OFF = visible, countable and
//                   reportable, but nothing automatic routes stock to or from
//                   it. Flip it on after the location's count. No deploy.
//   Concrete        per category: Hub 3 or the Concrete Stockroom. Plus an
//                   optional override for one product.
//   Credit scope    shared (credit spendable anywhere) or section (only in the
//                   section that issued it).
//   Concrete at the till   takes cash, cashier price edits, which till is the
//                   recycler — the POS's per-store switches.
//
// OWNER ONLY, three layers: the tile, the route, and this component's own
// check — and the RTDB rule on /network is what actually refuses the write.
// A refused viewer reads nothing under /network or /locations: both hooks
// below are disabled for them.
import { useMemo, useState } from "react";
import { ref, update } from "firebase/database";
import { database } from "../../firebase";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { useNetwork } from "../../utils/useNetwork";
import { usePathState } from "../stock/useStock";
import { serverNowMs } from "../../utils/serverTime";
import { listLocations, locationName } from "../../utils/networkRegistry";
import { allCategories } from "../../utils/productTaxonomy";
import { useTaxonomy } from "./useTaxonomy";
import {
  liveUpdate, categoryHubUpdate, productOverrideUpdate, creditScopeUpdate, seedUpdate, categoryRows,
  SWITCHABLE_STORE, SWITCHABLE_HUBS,
  POS_FLAGS, posSwitchState, posFlagUpdate, recyclerTillUpdate,
} from "./networkSettingsCore";

const page = { minHeight: "100vh", background: "#000", color: "#f2f2f7", padding: 16, maxWidth: 760, margin: "0 auto", fontFamily: "-apple-system, system-ui, sans-serif" };
const box = { border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e", marginTop: 16 };
const label = { fontSize: 12, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6 };
const btn = { background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" };
const on = { ...btn, background: "#123a1e", color: "#30d158" };
const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: "1px solid #2c2c2e" };

const defaultWrite = (updates) => update(ref(database), updates);

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
  const { registry: taxonomy } = useTaxonomy();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [confirmLive, setConfirmLive] = useState(null);
  const [search, setSearch] = useState("");

  const categories = useMemo(() => allCategories(taxonomy), [taxonomy]);
  const hubOptions = SWITCHABLE_HUBS.map((h) => ({ value: h, label: locationName(registry, h) }));
  const byId = useMemo(() => Object.fromEntries((products || []).filter((p) => p && p.id).map((p) => [p.id, p])), [products]);

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

  const overrides = registry.productOverrides[SWITCHABLE_STORE] || {};
  const pos = posSwitchState(registry, raw);
  const q = search.trim().toLowerCase();
  const matches = q.length >= 2
    ? products.filter((p) => p && p.id && !overrides[p.id] && String(p.name || "").toLowerCase().includes(q)).slice(0, 8)
    : [];

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
          <p>Concrete and the Concrete Stockroom are not registered yet. This adds them, switched off, and changes nothing for Marathon PE, Trophy, Hub 1 or Hub 2.</p>
          <button type="button" style={btn} disabled={busy}
            onClick={() => send(seedUpdate(raw, stockLocs.value, now(), uid), "Network registered.")}>
            Set up the network
          </button>
        </div>
      )}

      {[1, 2].map((section) => (
        <div style={box} key={section}>
          <div style={label}>Section {section}</div>
          {listLocations(registry, { section }).map((l) => (
            <div style={row} key={l.id} data-loc={l.id}>
              <span>
                <strong>{l.name}</strong>
                <span style={{ color: "#8e8e93" }}> · {l.type === "store" ? `store · ${l.tills.length} till${l.tills.length === 1 ? "" : "s"}` : "hub"}</span>
              </span>
              <button type="button" disabled={busy} aria-pressed={l.live} style={l.live ? on : btn}
                onClick={() => setConfirmLive({ id: l.id, name: l.name, to: !l.live })}>
                {l.live ? "Live" : "Not live"}
              </button>
            </div>
          ))}
        </div>
      ))}

      {confirmLive && (
        <div style={{ ...box, borderColor: "#ff9f0a" }} role="alertdialog">
          <p>
            {confirmLive.to
              ? `Switch ${confirmLive.name} LIVE? Refills, Solve and automatic orders will start routing stock to and from it. It also joins everything else that only runs for live locations: the stock audit, display checks, the refusal write-off (which can erase a count that keeps being refused), hub clean-up, and the network totals. Only do this after its count.`
              : `Switch ${confirmLive.name} off? Nothing automatic will route stock to or from it. Stock already there stays.`}
          </p>
          <button type="button" style={on} disabled={busy}
            onClick={() => { const c = confirmLive; setConfirmLive(null); send(liveUpdate(registry, c.id, c.to, now(), uid), `${c.name} is ${c.to ? "live" : "not live"}.`); }}>
            Yes, {confirmLive.to ? "go live" : "switch off"}
          </button>{" "}
          <button type="button" style={btn} onClick={() => setConfirmLive(null)}>Cancel</button>
        </div>
      )}

      <div style={box}>
        <div style={label}>Concrete — where each category's back stock sits</div>
        {categoryRows(registry, categories).map((r) => (
          <div style={row} key={r.key} data-cat={r.key}>
            <span>{r.label}{r.inherits && <span style={{ color: "#8e8e93" }}> · follows the default</span>}</span>
            <Choice value={r.hub} options={hubOptions} busy={busy}
              onPick={(hub) => send(categoryHubUpdate(registry, r.key, hub, now(), uid), `${r.label}: ${locationName(registry, hub)}.`)} />
          </div>
        ))}
      </div>

      <div style={box}>
        <div style={label}>Concrete — one product kept somewhere else</div>
        {Object.keys(overrides).map((pid) => (
          <div style={row} key={pid} data-override={pid}>
            <span>{byId[pid]?.name || pid} · {locationName(registry, overrides[pid])}</span>
            <button type="button" style={btn} disabled={busy}
              onClick={() => send(productOverrideUpdate(registry, pid, null, now(), uid), "Override removed.")}>Remove</button>
          </div>
        ))}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a product"
          style={{ ...btn, width: "100%", boxSizing: "border-box", marginTop: 10, cursor: "text" }} />
        {matches.map((p) => (
          <div style={row} key={p.id}>
            <span>{p.name}</span>
            <Choice value={null} options={hubOptions} busy={busy}
              onPick={(hub) => { setSearch(""); send(productOverrideUpdate(registry, p.id, hub, now(), uid), `${p.name}: ${locationName(registry, hub)}.`); }} />
          </div>
        ))}
      </div>

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
            onPick={(scope) => send(creditScopeUpdate(scope, now(), uid), scope === "shared" ? "Credit is spendable at any store." : "Credit is spendable only in the section that issued it.")} />
        </div>
        <p style={{ color: "#8e8e93", fontSize: 13 }}>Credit issued before sections existed carries no section and stays spendable everywhere.</p>
      </div>
    </div>
  );
}

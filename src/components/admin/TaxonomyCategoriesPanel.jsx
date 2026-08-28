// ─── TAXONOMY TAB — CATEGORIES PANEL ─────────────────────────────────────────
// Create a category from BEHAVIOUR, not from legacy fields: name, group, size
// run, refill lane, display checks. The legacy category/subcategory/productType
// triple is DERIVED by utils/taxonomyCategoryCreate.js (same contract the Add
// Product form enforces via isLegalLegacy) and shown in a plain-English
// preview BEFORE save. Editing an existing category is limited to its label
// and its size run — legacy fields and keys are never editable here, and
// nothing in this panel can retire or delete a category.
//
// Writes go to /settings/productTaxonomy/cats/{key} through a transaction that
// refuses to overwrite an existing key, so two devices creating the same name
// cannot clobber each other. Rendering is gated read-only by the parent when
// the registry is on the seed fallback (see TaxonomyTab header).

import { useMemo, useState } from "react";
import { ref, runTransaction, update, serverTimestamp } from "firebase/database";
import { database } from "../../firebase.js";
import { TAXONOMY_TOPS } from "../../utils/productTaxonomy.js";
import { sizeRunsOf, runSizes } from "../../utils/sizeRuns.js";
import { deriveNewCategory, checksChoiceForLane, REFILL_LANES } from "../../utils/taxonomyCategoryCreate.js";

const REGISTRY = "settings/productTaxonomy";

const card = {
  background: "rgba(4,5,10,1)", border: "1px solid rgba(60,110,255,.14)",
  borderRadius: 16, padding: "18px 18px 16px", marginBottom: 14,
};
const fieldLabel = {
  fontSize: 11, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase",
  color: "rgba(233,238,255,.5)", marginBottom: 7,
};
const textField = {
  background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 10,
  padding: "10px 12px", color: "#fff", fontSize: 14, fontWeight: 700, outline: "none",
  width: "100%", boxSizing: "border-box",
};
const choiceBtn = (on) => ({
  background: on ? "rgba(74,127,255,.16)" : "rgba(255,255,255,.04)",
  border: on ? "2px solid rgba(74,127,255,.7)" : "1px solid rgba(255,255,255,.14)",
  color: on ? "#9DBCFF" : "rgba(233,238,255,.6)",
  borderRadius: 10, padding: "9px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer",
});

const LANE_LABEL = { clothing: "Clothing lane", sneaker: "Sneaker lane", none: "No refill" };

export default function CategoriesPanel({ registry, live }) {
  const runs = useMemo(() => sizeRunsOf(registry), [registry]);
  const cats = useMemo(
    () => Object.values((registry && registry.cats) || {})
      .filter((c) => c && typeof c === "object" && c.key)
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.label).localeCompare(String(b.label))),
    [registry],
  );

  return (
    <div>
      <CreateCard registry={registry} runs={runs} live={live} />
      <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.5)", margin: "18px 2px 10px", fontWeight: 700 }}>
        Existing categories ({cats.length})
      </div>
      {cats.map((c) => <CatRow key={c.key} cat={c} runs={runs} live={live} />)}
    </div>
  );
}

// ─── CREATE ──────────────────────────────────────────────────────────────────
function CreateCard({ registry, runs, live }) {
  const [label, setLabel] = useState("");
  const [top, setTop] = useState("clothing");
  const [oneSize, setOneSize] = useState(false);
  const [sizeRunKey, setSizeRunKey] = useState("apparel");
  const [lane, setLane] = useState("clothing");
  const [checks, setChecks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);       // {kind:'ok'|'err', text}

  const forced = checksChoiceForLane(lane);
  const derived = useMemo(
    () => (label.trim().length >= 2
      ? deriveNewCategory({ label, top, oneSize, sizeRunKey, refillLane: lane, displayChecks: checks }, registry)
      : null),
    [label, top, oneSize, sizeRunKey, lane, checks, registry],
  );

  const create = async () => {
    if (!live || busy || !derived || !derived.ok) return;
    setBusy(true); setMsg(null);
    try {
      // Never overwrite: the transaction aborts if the key appeared meanwhile.
      const res = await runTransaction(ref(database, `${REGISTRY}/cats/${derived.key}`), (cur) => {
        if (cur !== null) return undefined;
        return derived.record;
      });
      if (!res.committed) {
        setMsg({ kind: "err", text: `"${derived.key}" already exists — nothing was written.` });
      } else {
        await update(ref(database, REGISTRY), { updatedAt: serverTimestamp(), updatedBy: "taxonomy-tab" });
        setMsg({ kind: "ok", text: `Created "${derived.record.label}". It is live in the Add Product form now.` });
        setLabel("");
      }
    } catch (e) {
      setMsg({ kind: "err", text: e && e.message ? `Write failed: ${e.message}` : "Write failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, borderColor: "rgba(74,222,128,.25)" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 14 }}>New category</div>

      <div style={fieldLabel}>Name</div>
      <input value={label} onChange={(e) => { setLabel(e.target.value); setMsg(null); }} placeholder="e.g. Scarves"
             disabled={!live || busy} style={{ ...textField, maxWidth: 340 }} />

      <div style={{ ...fieldLabel, marginTop: 16 }}>Group (picker heading only)</div>
      <div style={{ display: "flex", gap: 8 }}>
        {Object.values(TAXONOMY_TOPS).map((t) => (
          <button key={t.key} onClick={() => setTop(t.key)} style={choiceBtn(top === t.key)}>{t.label}</button>
        ))}
      </div>

      <div style={{ ...fieldLabel, marginTop: 16 }}>Sizes</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setOneSize(true)} style={choiceBtn(oneSize)}>One size</button>
        {Object.values(runs).map((r) => (
          <button key={r.key} onClick={() => { setOneSize(false); setSizeRunKey(r.key); }}
                  style={choiceBtn(!oneSize && sizeRunKey === r.key)}>
            {r.label || r.key}
          </button>
        ))}
      </div>
      {!oneSize && runs[sizeRunKey] && (
        <div style={{ marginTop: 7, fontSize: 11.5, color: "rgba(233,238,255,.42)" }}>
          {runSizes(runs[sizeRunKey]).join(" · ")}
        </div>
      )}

      <div style={{ ...fieldLabel, marginTop: 16 }}>Refill lane — how the engine treats these products</div>
      <div style={{ display: "flex", gap: 8 }}>
        {REFILL_LANES.map((l) => (
          <button key={l} onClick={() => setLane(l)} style={choiceBtn(lane === l)}>{LANE_LABEL[l]}</button>
        ))}
      </div>

      <div style={{ ...fieldLabel, marginTop: 16 }}>Display checks — does a sale ask the floor to check the display?</div>
      {forced.forced == null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setChecks(true)} style={choiceBtn(checks)}>Yes</button>
          <button onClick={() => setChecks(false)} style={choiceBtn(!checks)}>No</button>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.55)", lineHeight: 1.5 }}>
          <b style={{ color: forced.forced ? "#4ADE80" : "rgba(233,238,255,.75)" }}>{forced.forced ? "Yes" : "No"}</b> — {forced.why}
        </div>
      )}

      {derived && !derived.ok && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>{derived.message}</div>
      )}
      {derived && derived.ok && (
        <div style={{ marginTop: 16, background: "rgba(74,222,128,.05)", border: "1px solid rgba(74,222,128,.25)", borderRadius: 12, padding: "13px 15px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: "#4ADE80", marginBottom: 8 }}>
            What saving will do
          </div>
          {derived.preview.map((line, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "rgba(233,238,255,.72)", lineHeight: 1.55, marginTop: i ? 5 : 0 }}>{line}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <button onClick={create} disabled={!live || busy || !derived || !derived.ok}
          style={{ background: derived && derived.ok && live ? "#4ADE80" : "rgba(255,255,255,.06)",
                   color: derived && derived.ok && live ? "#04220f" : "rgba(233,238,255,.35)",
                   border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 13.5, fontWeight: 800,
                   cursor: derived && derived.ok && live ? "pointer" : "default" }}>
          {busy ? "Creating…" : "Create category"}
        </button>
        {msg && <span style={{ fontSize: 12.5, fontWeight: 700, color: msg.kind === "ok" ? "#4ADE80" : "#F87171" }}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ─── EXISTING CATEGORY ROW — edit label + size run, nothing else ─────────────
function CatRow({ cat, runs, live }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(cat.label || cat.key);
  const [runKey, setRunKey] = useState(cat.sizeRunKey || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const oneSize = cat.sizeMode === "one";

  const save = async () => {
    if (!live || busy) return;
    const nextLabel = label.trim();
    if (nextLabel.length < 2) { setErr("Label too short."); return; }
    setBusy(true); setErr(null);
    try {
      const updates = { [`cats/${cat.key}/label`]: nextLabel, updatedAt: serverTimestamp(), updatedBy: "taxonomy-tab" };
      if (!oneSize && runKey && runKey !== cat.sizeRunKey && runs[runKey]) {
        updates[`cats/${cat.key}/sizeRunKey`] = runKey;
        // Keep the literal fallback snapshot coherent with the newly chosen run
        // — it is only ever read when the run itself cannot be resolved.
        updates[`cats/${cat.key}/sizes`] = runSizes(runs[runKey]);
      }
      await update(ref(database, REGISTRY), updates);
      setEditing(false);
    } catch (e) {
      setErr(e && e.message ? e.message : "Write failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, padding: "13px 16px", marginBottom: 8, opacity: cat.active === false ? 0.55 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy}
                 style={{ ...textField, maxWidth: 240, padding: "7px 10px" }} />
        ) : (
          <span style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{cat.label || cat.key}</span>
        )}
        <span style={{ fontSize: 11, color: "rgba(233,238,255,.35)", fontWeight: 600 }}>{cat.key}</span>
        {cat.active === false && (
          <span style={{ fontSize: 10.5, fontWeight: 800, color: "#FBBF24", border: "1px solid rgba(251,191,36,.4)", borderRadius: 8, padding: "1px 7px" }}>retired</span>
        )}
        <span style={{ flex: 1 }} />
        {editing && !oneSize && (
          <select value={runKey} onChange={(e) => setRunKey(e.target.value)} disabled={busy}
                  style={{ background: "#08090C", color: "#fff", border: "1px solid rgba(74,127,255,.4)", borderRadius: 8, padding: "6px 8px", fontSize: 12.5, fontWeight: 700 }}>
            {!cat.sizeRunKey && <option value="">custom sizes (no run)</option>}
            {Object.values(runs).map((r) => <option key={r.key} value={r.key}>{r.label || r.key}</option>)}
          </select>
        )}
        {!editing && (
          <span style={{ fontSize: 11.5, color: "rgba(233,238,255,.45)" }}>
            {oneSize ? "one size" : cat.sizeRunKey ? `run: ${cat.sizeRunKey}` : "custom sizes"}
          </span>
        )}
        {live && (editing ? (
          <>
            <button onClick={save} disabled={busy} style={{ ...choiceBtn(true), padding: "6px 12px" }}>{busy ? "Saving…" : "Save"}</button>
            <button onClick={() => { setEditing(false); setLabel(cat.label || cat.key); setRunKey(cat.sizeRunKey || ""); setErr(null); }}
                    disabled={busy} style={{ ...choiceBtn(false), padding: "6px 12px" }}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setEditing(true)} style={{ ...choiceBtn(false), padding: "6px 12px" }}>Edit</button>
        ))}
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 12, color: "#F87171", fontWeight: 600 }}>{err}</div>}
    </div>
  );
}

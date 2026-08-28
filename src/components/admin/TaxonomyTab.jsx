// ─── ADMIN TAXONOMY TAB — sizes and categories become owner-editable data ────
// The owner's screen for growing the taxonomy WITHOUT a code change: add a size
// to a size run (XXXL / 4XL and whatever comes after), and create categories.
// Everything here writes /settings/productTaxonomy — the same registry the Add
// Product form already reads live — never /products, never /stock.
//
// GATE — LAYER 2 OF 2. The route into this tab is already double-gated (the
// Admin tile via hasPermission, and guard(ROLES.ADMIN) on the view), but this
// component ALSO re-checks the permission itself, exactly like UserManagement
// does. Neither layer relies on the other; deleting either one leaves a
// working gate. That was the DisplayRegister defect — the tile was the only
// gate — and it is not repeated here. Mutation-proved by the tests.
//
// SIZES ARE ADD-ONLY, EVERYWHERE IN THIS FILE. Sizes are /stock cell keys and
// barcode-catalog keys: renaming, reordering or deleting one would orphan live
// stock silently. The ONLY size write in this tab goes through addSizeToRun,
// whose append proves the old list survives byte-for-byte, and whose
// validation blocks duplicates AND near-duplicate spellings ("XXXXL" when
// "4XL" exists) across every run — two spellings of one physical size would
// split stock into two cells with nothing on screen to say so.
//
// WRITES ONLY WHEN THE LIVE REGISTRY IS IN HAND. If useTaxonomy fell back to
// the checked-in seed (offline / rules / not seeded), everything renders
// read-only: a write layered on the fallback could fork the live registry.

import { useMemo, useState } from "react";
import { ref, runTransaction, update, serverTimestamp } from "firebase/database";
import { database } from "../../firebase.js";
import { usePermissions } from "../PermissionsContext.jsx";
import {
  sizeRunsOf, validateNewSize, appendSizeToRun,
} from "../../utils/sizeRuns.js";
import { labelForKey } from "../../utils/productTaxonomy.js";
import CategoriesPanel from "./TaxonomyCategoriesPanel.jsx";

const REGISTRY = "settings/productTaxonomy";

const card = {
  background: "rgba(4,5,10,1)", border: "1px solid rgba(60,110,255,.14)",
  borderRadius: 16, padding: "18px 18px 16px", marginBottom: 14,
};
const chip = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 44, minHeight: 36, padding: "0 10px", borderRadius: 9,
  background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)",
  color: "rgba(233,238,255,.82)", fontSize: 13.5, fontWeight: 800,
};

export default function TaxonomyTab({ registry, source }) {
  // ── The component's OWN permission gate (layer 2 — see header) ────────────
  const { hasPermission, isSuperAdmin } = usePermissions();
  const allowed = isSuperAdmin || hasPermission("product_admin");
  const [panel, setPanel] = useState("sizes");

  if (!allowed) {
    return (
      <div style={{ ...card, textAlign: "center", padding: "34px 18px" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#F87171" }}>No access</div>
        <div style={{ marginTop: 8, fontSize: 13, color: "rgba(233,238,255,.55)", lineHeight: 1.5 }}>
          The Taxonomy screen needs the product-admin permission. Ask an admin to update your account.
        </div>
      </div>
    );
  }

  const live = source === "live";
  return (
    <div>
      {!live && (
        <div style={{ ...card, borderColor: "rgba(251,191,36,.4)" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#FBBF24" }}>Read-only — live registry not loaded</div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: "rgba(233,238,255,.55)", lineHeight: 1.5 }}>
            You are looking at the built-in fallback list ({source === "loading" ? "still loading" : "read failed or not seeded"}).
            Adding sizes or categories is disabled until the live registry loads — a change written over the fallback could fork the real data.
          </div>
        </div>
      )}
      {/* Panel switch: Sizes ↔ Categories */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["sizes", "Size runs"], ["categories", "Categories"]].map(([key, label]) => {
          const on = panel === key;
          return (
            <button key={key} onClick={() => setPanel(key)}
              style={{ flex: "0 0 auto", background: on ? "#4A7FFF" : "rgba(255,255,255,.05)", color: on ? "#fff" : "rgba(255,255,255,.6)",
                       border: "1px solid " + (on ? "#4A7FFF" : "rgba(255,255,255,.1)"), borderRadius: 10, padding: "9px 16px",
                       fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              {label}
            </button>
          );
        })}
      </div>
      {panel === "sizes"
        ? <SizesPanel registry={registry} live={live} />
        : <CategoriesPanel registry={registry} live={live} />}
    </div>
  );
}

// ─── SIZES PANEL ──────────────────────────────────────────────────────────────
// Per run: the current sizes READ-ONLY, and one "Add size" input. Nothing else
// — no rename, no reorder, no retire, no delete. The one-size "_" sentinel is
// not a run and never appears here.
function SizesPanel({ registry, live }) {
  const runs = useMemo(() => sizeRunsOf(registry), [registry]);
  // Which categories resolve through each run — so the owner can see the blast
  // radius of an addition BEFORE making it. From the registry, never /products.
  const usedBy = useMemo(() => {
    const map = {};
    for (const [ck, cat] of Object.entries((registry && registry.cats) || {})) {
      if (cat && typeof cat === "object" && cat.sizeRunKey && cat.active !== false) {
        (map[cat.sizeRunKey] = map[cat.sizeRunKey] || []).push(labelForKey(registry, ck));
      }
    }
    for (const k of Object.keys(map)) map[k].sort();
    return map;
  }, [registry]);

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.5)", lineHeight: 1.55, marginBottom: 14 }}>
        A size run is the size breakdown a category offers on the Add Product form. Adding a size here makes it
        available to every category on that run, immediately, on every device. Existing sizes can never be renamed,
        reordered or removed — they are live stock keys.
      </div>
      {Object.values(runs).map((run) => (
        <RunCard key={run.key} runKey={run.key} run={run} runs={runs} usedBy={usedBy[run.key] || []} live={live} />
      ))}
    </div>
  );
}

function RunCard({ runKey, run, runs, usedBy, live }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);   // last size added, for the flash
  const [error, setError] = useState(null); // write-path failure

  // Live validation as the operator types — the block happens BEFORE the
  // button, with the message naming the existing size that collides.
  const verdict = input.trim() ? validateNewSize(runs, runKey, input) : null;

  const add = async () => {
    if (!live || busy || !verdict || !verdict.ok) return;
    setBusy(true); setError(null);
    try {
      const size = verdict.size;
      // Transaction on the PARENT sizeRuns node, not the single run — so the
      // FULL validation (in-run duplicates AND the cross-run spelling check)
      // re-runs against the fresh server value on every retry. A child-level
      // transaction could only re-check its own run, leaving a race where two
      // devices land "4XL" and "XXXXL" in two different runs at once — exactly
      // the two-spellings split this screen exists to block.
      const res = await runTransaction(ref(database, `${REGISTRY}/sizeRuns`), (cur) => {
        // Resolve exactly like the UI does (seed fallback for absent runs).
        const resolved = sizeRunsOf({ sizeRuns: cur && typeof cur === "object" ? cur : {} });
        const target = resolved[runKey];
        if (!target) return undefined;                        // unknown run vanished — abort
        const v = validateNewSize(resolved, runKey, size);
        if (!v.ok) return undefined;                          // raced duplicate — abort
        return {
          ...Object.fromEntries(Object.entries(resolved).map(([k, r]) => [k, { key: k, label: r.label || k, sizes: r.sizes }])),
          [runKey]: { key: runKey, label: target.label || runKey, sizes: appendSizeToRun(target.sizes, v.size) },
        };
      });
      if (!res.committed) {
        setError("Not added — that size already exists (someone else may have just added it).");
      } else {
        await update(ref(database, REGISTRY), { updatedAt: serverTimestamp(), updatedBy: "taxonomy-tab" });
        setDone(size); setInput("");
        setTimeout(() => setDone(null), 4000);
      }
    } catch (e) {
      setError(e && e.message ? `Write failed: ${e.message}` : "Write failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{run.label || runKey}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: "rgba(233,238,255,.35)", fontWeight: 600 }}>{runKey}</span>
        </div>
        <span style={{ fontSize: 11.5, color: "rgba(233,238,255,.4)" }}>{run.sizes.length} sizes</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 12 }}>
        {run.sizes.map((sz) => <span key={sz} style={chip}>{sz}</span>)}
      </div>
      {usedBy.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "rgba(233,238,255,.42)", lineHeight: 1.5 }}>
          Used by: {usedBy.join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="Add size (e.g. 5XL)"
          disabled={!live || busy}
          style={{ flex: "0 1 190px", background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 10,
                   padding: "10px 12px", color: "#fff", fontSize: 14, fontWeight: 700, outline: "none", minWidth: 0 }} />
        <button onClick={add} disabled={!live || busy || !verdict || !verdict.ok}
          style={{ background: verdict && verdict.ok && live ? "#4A7FFF" : "rgba(255,255,255,.06)",
                   color: verdict && verdict.ok && live ? "#fff" : "rgba(233,238,255,.35)",
                   border: "none", borderRadius: 10, padding: "11px 18px", fontSize: 13, fontWeight: 800,
                   cursor: verdict && verdict.ok && live ? "pointer" : "default" }}>
          {busy ? "Adding…" : "Add size"}
        </button>
      </div>
      {verdict && !verdict.ok && (
        <div style={{ marginTop: 9, fontSize: 12.5, color: "#F87171", fontWeight: 600, lineHeight: 1.5 }}>{verdict.message}</div>
      )}
      {verdict && verdict.ok && (
        <div style={{ marginTop: 9, fontSize: 12, color: "rgba(233,238,255,.5)", lineHeight: 1.5 }}>
          Will be added as <b style={{ color: "#B7F0CC" }}>{verdict.size}</b>, in sort position — every category on this run gets it.
        </div>
      )}
      {error && <div style={{ marginTop: 9, fontSize: 12.5, color: "#F87171", fontWeight: 600 }}>{error}</div>}
      {done && <div style={{ marginTop: 9, fontSize: 12.5, color: "#4ADE80", fontWeight: 700 }}>Added {done} ✓</div>}
    </div>
  );
}

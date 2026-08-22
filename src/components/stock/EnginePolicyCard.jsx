// ─── ENGINE POLICY ────────────────────────────────────────────────────────────
// What each category keeps at every location, and when the engine asks for
// more. The owner-facing face of /config/refillEngine/categoryPolicy and
// /config/refillEngine/policyGroups.
//
// ── WHY THIS SCREEN WAS REBUILT ──────────────────────────────────────────────
// The shipped version put the location label, its carriage caption and three
// number inputs in ONE grid row. At phone width the label wrapped to three
// lines — "Hub" / "1" / "1 carried · 0 units" — and collided with the inputs.
// That is not a padding problem, so it is not fixed with padding: the row now
// has ONE line of label (icon plus name, nothing else) and the numbers live in
// their own track, which stacks BELOW the label at phone width instead of
// competing with it. The carriage detail moved to the stat block, where a
// two-line answer has room to be two lines.
//
// The structure is now: header (image, name, chips, headline numbers) → a 2×2
// stat block that is never more than two columns at phone width → the location
// table → the legend → the next-scan preview → the footer actions.
//
// ── THE FOUR THINGS THIS SCREEN IS TRYING TO PREVENT ─────────────────────────
//
//   1. ARMING A STORE THAT DOES NOT CARRY THE CATEGORY. A mapped product is
//      managed at a mapped location UNCONDITIONALLY — refill-engine.cjs
//      managedPids has no carriage gate, deliberately, so a script-imported
//      perfume with no cell anywhere still resolves its buffer. The consequence
//      is that arming an uncarried store does not quietly do nothing; it
//      invents demand for EVERY product in the category at a shop that has
//      never stocked one. So "not carried" is a refusal with its own separate
//      action, not a warning next to an editable box.
//
//   2. SAVING WITHOUT KNOWING WHAT THE NEXT SCAN WILL DO. Save stays disabled
//      until a preview has run against the values currently on screen, and any
//      edit invalidates it — including an edit to one size inside a run.
//
//   3. NOT KNOWING WHOSE NUMBERS THESE ARE. A category can be governed by its
//      own entry or by a GROUP it belongs to. The chip says which, because
//      editing a grouped category's numbers here gives it an entry of its own
//      and takes it out of the group — a bigger change than the numbers look.
//
//   4. TREATING A HAND-MADE ROW AS A PROBLEM. Junid has armed clothing by hand
//      over months: 7,797 explicit /stock_targets rows on 1,666 products,
//      measured live 2026-08-22. Those rows are the SOURCE OF TRUTH for the
//      products that carry them. The chip reads "N with their own rows" and is
//      a LINK THAT OPENS THEM FOR EDITING — not a warning, and not a "clear
//      them" button. Nothing on this screen deletes a row.
//
// ── ACCESS ───────────────────────────────────────────────────────────────────
// Super-admin only, through three independent gates: the home tile does not
// render (App.jsx), the route refuses to mount this component (App.jsx), and
// setCategoryPolicy re-checks the caller's email server-side. THE COMPONENT IS
// SPLIT so the default export holds ZERO hooks — a refused viewer must open no
// subscription and start no fetch, and a hook cannot live below a conditional
// return without changing the hook count between renders.
//
// NONE OF THAT IS A SECURITY BOUNDARY YET. Checked 2026-08-21 via
// /.settings/rules.json: there is no root ".read" or ".write" (unmatched paths
// DENY), /config is readable by any non-anonymous signed-in account, and
// /config/refillEngine is writable by any account whose /users record carries
// stockRole 'admin' — four of them live today. Those four can write the policy
// node straight from a tablet and never reach any of these gates. The console
// rule printed by scripts/print-engine-policy-rule.mjs narrows them to one; it
// is not live. Do not describe these gates as security until it is.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, BG, BORDER, GLASS, RADIUS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bGhost, bRed, input } from "./ui";
import {
  COLUMN_LABELS, FIELD_ORDER, armedLocations, editorRows, draftFromEntry, seedLocation,
  onTargetChanged, policyFromDraft, validateDraft, previewKey, canSave, changedFields,
  nextScanAt, previewVerdict, lastChange, defaultMinQty,
  isPerSizeRow, fillAllSizes, seedPerSizeLocation, bySizeRank, sizeLabel,
} from "./enginePolicyCore";
import { serverNowMs } from "../../utils/serverTime";
import { enginePolicyVisibleForViewer } from "../../config/enginePolicy";

const setCategoryPolicyFn = () => httpsCallable(functions, "setCategoryPolicy");

const LOC_LABELS = { hub2: "Hub 2", hub1: "Hub 1", hub3: "Hub 3", central: "Central", "marathon-pe": "Marathon PE", "marathon-pine": "Marathon Pine", trophy: "Trophy" };
const locLabel = (l) => LOC_LABELS[l] || l;
// A hub and a shop are different kinds of place and the row is one line, so the
// only thing left to distinguish them with is the glyph. Deliberately two
// glyphs, not seven: a per-location icon set would be decoration.
const locIcon = (l) => (/^hub|^central/.test(l) ? "🏬" : "🏪");

// ── CATEGORY IMAGERY ─────────────────────────────────────────────────────────
// A studio photograph per category, generated once by
// scripts/generate-category-images.mjs and cached on the taxonomy registry entry
// as `imageUrl`. EMOJI IS THE FALLBACK, not the plan: a category with no image
// yet, or one whose image fails to load, gets its glyph and the screen carries
// on. Nothing is generated at render time.
const ICONS = {
  "caps-beanies": "🧢", "fitted-caps": "🧢", visors: "🧢", perfumes: "🌸", bags: "👜", belts: "🎗️",
  "t-shirts": "👕", hoodies: "🧥", jackets: "🧥", pants: "👖", shorts: "🩳", sneakers: "👟",
  slides: "🩴", "soccer-boots": "⚽", "soccer-jerseys": "👕", tracksuits: "🎽", "ladies-tracksuits": "🎽",
  watches: "⌚", sunglasses: "🕶️", "chains-bracelets": "📿", underwear: "🩲", dresses: "👗",
  suits: "🤵", shirts: "👔", "golf-t-shirts": "👕", "baseball-shirts": "👕", "basketball-vests": "🎽",
  gloves: "🧤", "designer-shoes": "👞", boots: "🥾", "cargo-pants": "👖", "kids-shoes": "👟",
  loafers: "👞", "running-shoes": "👟", jeans: "👖", sweaters: "🧥", packaging: "📦",
};
const iconFor = (k) => ICONS[k] || "📦";

function CategoryImage({ category, size = 44 }) {
  const [failed, setFailed] = useState(false);
  const url = category?.imageUrl;
  const box = {
    width: size, height: size, borderRadius: Math.round(size * 0.22), flex: `0 0 ${size}px`,
    display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    background: "rgba(255,255,255,.05)", border: BORDER, fontSize: Math.round(size * 0.5),
  };
  if (!url || failed) return <div style={box} aria-hidden="true">{iconFor(category?.key)}</div>;
  return (
    <div style={box}>
      <img src={url} alt="" loading="lazy" onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    </div>
  );
}

const fmtWhen = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return d.toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};

// ── THE ONLY CSS IN THIS FILE, AND WHY IT IS CSS ─────────────────────────────
// Everything else here is an inline style, matching the rest of the Stock
// section. These rules are not, because they are MEDIA QUERIES, and an inline
// style cannot express one. The layout requirement they carry is specific — the
// stat block is never more than two columns at phone width, and the numeric
// columns stack below the location name rather than beside it — and expressing
// it in JavaScript would mean measuring the viewport and re-rendering on
// resize, which is a worse version of what the browser already does.
const CSS = `
.ep-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
@media (min-width:720px){ .ep-stats { grid-template-columns:repeat(4,minmax(0,1fr)); } }

/* The row that used to collide. The label track is minmax(0,1fr) so it SHRINKS
   and ellipses instead of wrapping; the numbers sit in their own fixed track. */
.ep-loc { display:grid; grid-template-columns:minmax(0,1fr); gap:6px 10px; align-items:center;
          padding:10px 0; border-bottom:1px solid rgba(255,255,255,.05); }
.ep-loc-name { display:flex; align-items:center; gap:8px; min-width:0; }
.ep-loc-name > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ep-nums { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
@media (min-width:560px){
  .ep-loc { grid-template-columns:minmax(0,1fr) 260px; }
  .ep-nums { grid-template-columns:repeat(3,76px); justify-content:end; }
}
.ep-num-head { display:none; }
@media (min-width:560px){
  .ep-num-head { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:10px; }
}
.ep-size { display:grid; grid-template-columns:minmax(0,54px) 1fr; gap:8px; align-items:center; padding:4px 0; }
@media (min-width:560px){ .ep-size { grid-template-columns:minmax(0,1fr) 260px; } }
.ep-cat { display:flex; align-items:center; gap:12px; width:100%; text-align:left;
          background:transparent; border:none; color:inherit; font:inherit; padding:0; cursor:pointer; min-width:0; }
.ep-chips { display:flex; flex-wrap:wrap; gap:6px; }
`;

// ═════════════════════════════════════════════════════════════════════════════
// GATE 2b — THE COMPONENT'S OWN CHECK, AND WHY IT HOLDS NO HOOKS
// ═════════════════════════════════════════════════════════════════════════════
// This is the whole default export. It has no useState, no useEffect and opens
// nothing, so a viewer who is refused causes not one read, not one callable
// invocation, and no listener. That is the point of the split: an early
// `return` placed after the hooks would still have run them, and a hook cannot
// be moved below a conditional return without changing the hook count between
// renders and crashing React.
//
// The route mount in App.jsx checks the same condition independently and never
// renders this component for a non-super-admin. Both layers are real; neither
// relies on the other. Deleting either one must fail tests — see
// scripts/mutation-proof-engine-policy.mjs (M-TILE, M-ROUTE, M-COMPONENT).
export default function EnginePolicyCard({ viewer, onExit }) {
  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;
  return <EnginePolicyAuthed viewer={viewer} onExit={onExit} />;
}

function Refused({ onExit }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "2rem 1rem" }}>
      <div style={{ ...GLASS, maxWidth: 420, margin: "12vh auto", padding: "1.5rem" }}>
        <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>Engine Policy is owner-only</div>
        <div style={{ marginTop: ".6rem", color: GRAY, fontSize: ".9rem", lineHeight: 1.5 }}>
          These settings decide what every shop keeps on its shelves. They are not
          part of any staff role.
        </div>
        <button onClick={onExit} style={{ ...bGhost, marginTop: "1.2rem" }}>Back</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs ONLY for a verified super-admin.
// ═════════════════════════════════════════════════════════════════════════════
function EnginePolicyAuthed({ viewer, onExit }) {
  const [census, setCensus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState("");     // the category on the detail screen
  const [draft, setDraft] = useState({});
  const [preview, setPreview] = useState(null);   // { key, model, before, changes }
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);         // { kind, text }
  const [panel, setPanel] = useState("");         // "" | "rows" | "history" | "groups"
  const [rows, setRows] = useState(null);         // the explicit-row list, when opened
  const [rowDraft, setRowDraft] = useState({});

  // The timer is held and cleared, rather than fired and forgotten. Two real
  // consequences of the naive version: a second message inside the window
  // inherited the first one's timer and vanished early, and an unmount left a
  // pending setNote to run against a dead tree.
  const flashTimer = useRef(null);
  const flash = useCallback((kind, text) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setNote({ kind, text });
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setNote(null); }, 9000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // ONE call, on mount, for the whole list. The counts it returns are derived
  // from /products and /stock, and a browser that read those would download the
  // catalogue and the stock tree onto a phone on a shop network at the owner's
  // expense — so the server pages them and sends back a few kilobytes.
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const res = await setCategoryPolicyFn()(refresh ? { action: "census", refresh: true } : { action: "census" });
      setCensus(res.data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => {
    const list = census?.categories || [];
    // Governed first (they are what somebody came to change), then anything
    // with products or rows, then the empty rest — alphabetical inside each.
    return [...list].sort((a, b) => {
      const band = (c) => (c.armedEffective?.length ? 0 : (c.products > 0 || c.ownRowCells > 0) ? 1 : 2);
      return band(a) - band(b) || String(a.label).localeCompare(String(b.label));
    });
  }, [census]);

  const open = categories.find((c) => c.key === openKey) || null;
  const destinations = census?.destinations || [];
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const keyNow = useMemo(() => previewKey(openKey, draft, { perSize: open?.perSize }), [openKey, draft, open]);
  const proposed = useMemo(() => policyFromDraft(draft, { perSize: open?.perSize }), [draft, open]);
  const banner = useMemo(() => changedFields(open?.entry || null, proposed), [open, proposed]);
  const saveable = canSave({ preview, previewKeyNow: keyNow, errors, busy: !!busy });
  const scan = nextScanAt(serverNowMs());
  const stamp = lastChange(census?.history);

  const openCategory = (c) => {
    setOpenKey(c.key);
    setPreview(null);
    setPanel("");
    // A GROUPED category's editor opens on the GROUP'S numbers, because those
    // are the numbers in force. Saving them writes an entry of its own, which
    // takes the category out of the group — said plainly in the detail header
    // rather than discovered afterwards.
    setDraft(draftFromEntry({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations }));
  };
  const closeCategory = () => { setOpenKey(""); setDraft({}); setPreview(null); setPanel(""); setRows(null); };

  const setField = (loc, field, value, sizeKey = null) => {
    setPreview(null);   // belt to the previewKey's braces: any edit invalidates
    setDraft((d) => {
      const row = d[loc];
      if (sizeKey) {
        const sizes = { ...(row?.sizes || {}) };
        const sr = sizes[sizeKey] || { target: "", minQty: "", reorderPoint: "" };
        sizes[sizeKey] = field === "target" ? onTargetChanged(sr, value) : { ...sr, [field]: value };
        return { ...d, [loc]: { sizes } };
      }
      const base = row && !isPerSizeRow(row) ? row : seedLocation(null);
      return { ...d, [loc]: field === "target" ? onTargetChanged(base, value) : { ...base, [field]: value } };
    });
  };

  // "Same across all sizes" — a typing aid. It writes each size individually
  // into the draft, and the save writes each one as its own stored entry. See
  // fillAllSizes: nothing anywhere stores "they are all 4".
  const quickFill = (loc, sizeRun) => {
    setPreview(null);
    setDraft((d) => {
      const sizes = d[loc]?.sizes || {};
      // The first size that has a number is the template. If none has one, the
      // button is not offered.
      const from = Object.keys(sizes).sort(bySizeRank).map((k) => sizes[k]).find((r) => String(r?.target ?? "").trim() !== "");
      if (!from) return d;
      return { ...d, [loc]: fillAllSizes(sizeRun, from) };
    });
  };

  // Arming a store that does not carry the category is its own deliberate act,
  // with its own confirmation, because it invents demand rather than adjusting
  // it. See the header note.
  const armStore = (loc, carries) => {
    if (!carries) {
      const ok = window.confirm(
        `${locLabel(loc)} does not stock ${open?.label} today.\n\n` +
        `Arming it tells the engine to keep this category there — it will start asking ` +
        `for every product in the category at ${locLabel(loc)}, not only ones it has sold.\n\n` +
        `Arm it anyway?`);
      if (!ok) return;
    }
    setPreview(null);
    const run = open?.sizeRun || [];
    setDraft((d) => ({ ...d,
      [loc]: open?.perSize && run.length
        ? seedPerSizeLocation(run)
        : seedLocation(open?.effectiveEntry?.[loc]?.target ?? null) }));
  };

  const dropStore = (loc) => {
    setPreview(null);
    setDraft((d) => { const n = { ...d }; delete n[loc]; return n; });
  };

  // Switch one leg between "one number for the whole shop" and "a number per
  // size". Only offered where the category is per-size AND has a derived run —
  // a run that cannot be derived is a STOP, not a guessed list.
  const switchShape = (loc, toPerSize, sizeRun) => {
    setPreview(null);
    setDraft((d) => {
      const row = d[loc];
      if (toPerSize) {
        const seed = row && !isPerSizeRow(row) ? row : { target: "", minQty: "", reorderPoint: "" };
        return { ...d, [loc]: fillAllSizes(sizeRun, seed) };
      }
      const sizes = row?.sizes || {};
      const first = Object.keys(sizes).sort(bySizeRank).map((k) => sizes[k])
        .find((r) => String(r?.target ?? "").trim() !== "") || { target: "", minQty: "", reorderPoint: "" };
      return { ...d, [loc]: { ...first } };
    });
  };

  const runPreview = async () => {
    if (busy || Object.keys(errors).length) return;
    setBusy("preview");
    const forKey = keyNow;
    try {
      const res = await setCategoryPolicyFn()({ categoryKey: openKey, policy: proposed, dryRun: true });
      // The preview is stamped with the key of the values it was computed FROM.
      // If the owner edited a field while it was in flight, this preview is
      // about numbers that are no longer on screen and must not enable Save.
      setPreview({ key: forKey, model: res.data.preview.after, before: res.data.preview.before, changes: res.data.changes });
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!saveable) return;
    setBusy("save");
    try {
      const res = await setCategoryPolicyFn()({
        categoryKey: openKey,
        policy: proposed,
        // The exact entry this editor was opened on. The server refuses the
        // write if live no longer matches it, so a change somebody else made
        // while this was open is never silently discarded. A GROUPED category
        // has no entry of its own, so the expectation is null — which is true,
        // and which the server checks.
        expectedBefore: open?.entry ?? null,
      });
      if (res.data.noChange) flash("ok", "Nothing to save — these are the numbers already live.");
      else flash("ok", `Saved. The next scan (${scan.label}) uses these numbers.`);
      closeCategory();
      await load(true);
    } catch (e) {
      flash("bad", e?.message || String(e));
      if (/changed while/i.test(e?.message || "")) await load(true);
    } finally {
      setBusy("");
    }
  };

  const revert = async (h) => {
    if (busy) return;
    if (h.kind === "rows" || h.kind === "group") {
      flash("bad", "Row edits and group changes are not reverted from here yet — the entry above records exactly what they were.");
      return;
    }
    const ok = window.confirm(
      `Put ${h.categoryKey} back to how it was before this change?\n\n` +
      (h.changes || []).map((c) => `  ${c.loc || ""} ${c.field}: ${c.to ?? "not set"} -> ${c.from ?? "not set"}`).join("\n"));
    if (!ok) return;
    setBusy("revert");
    try {
      await setCategoryPolicyFn()({ categoryKey: h.categoryKey, policy: h.before ?? null, expectedBefore: h.after ?? null });
      flash("ok", `${h.categoryKey} put back to how it was on ${fmtWhen(h.at)}.`);
      closeCategory();
      await load(true);
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  // ── THE EXPLICIT-ROW LIST ─────────────────────────────────────────────────
  // Opened from the "N with their own rows" chip. These rows are the source of
  // truth for the products that carry them; this reads them and lets them be
  // edited in place. NOTHING HERE DELETES ONE — the server refuses it, and
  // there is no control for it either.
  const openRows = async (key) => {
    setPanel("rows"); setRows(null); setRowDraft({});
    setBusy("rows");
    try {
      const res = await setCategoryPolicyFn()({ action: "rows", categoryKey: key });
      setRows(res.data.rows || []);
    } catch (e) {
      flash("bad", e?.message || String(e));
      setPanel("");
    } finally {
      setBusy("");
    }
  };

  const saveRows = async () => {
    const edits = Object.entries(rowDraft).map(([id, r]) => {
      const [loc, pid, sizeKey] = id.split("::");
      // `expected` is REQUIRED by the server — it is what this list was
      // rendered from, and it is how a change somebody else made while the list
      // was open gets refused instead of silently reverted. A row that is not
      // in `rows` cannot have been edited here, so it is dropped rather than
      // sent without one.
      const src = (rows || []).find((x) => `${x.loc}::${x.pid}::${x.sizeKey}` === id);
      if (!src) return null;
      const n = (v) => { const t = String(v ?? "").trim(); return /^\d+$/.test(t) ? Number(t) : null; };
      return {
        loc, pid, sizeKey, target: n(r.target), minQty: n(r.minQty), reorderPoint: n(r.reorderPoint),
        expected: { target: src.target, minQty: src.minQty, reorderPoint: src.reorderPoint },
      };
    }).filter(Boolean);
    if (!edits.length) return;
    setBusy("rows-save");
    try {
      const res = await setCategoryPolicyFn()({ action: "setRows", categoryKey: openKey, rows: edits });
      flash("ok", res.data.noChange ? "Nothing to save — those are the numbers already on the rows."
        : `${res.data.rowCount} ${res.data.rowCount === 1 ? "row" : "rows"} updated.`);
      setRowDraft({});
      await openRows(openKey);
      await load(true);
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  const governed = categories.filter((c) => (c.armedEffective || []).length).length;

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "1rem 1rem 4rem" }}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        {note && (
          <div style={{ ...GLASS, padding: ".8rem 1rem", marginBottom: "1rem",
            border: `1px solid ${note.kind === "ok" ? "rgba(74,222,128,.45)" : "rgba(248,113,113,.45)"}`,
            color: note.kind === "ok" ? GREEN : RED, fontSize: ".9rem", lineHeight: 1.5 }}>{note.text}</div>
        )}

        {open ? (
          <CategoryDetail
            category={open} destinations={destinations} draft={draft} errors={errors}
            census={census} banner={banner} preview={preview} keyNow={keyNow} busy={busy}
            scan={scan} saveable={saveable} panel={panel} rows={rows} rowDraft={rowDraft}
            onField={setField} onArm={armStore} onDrop={dropStore} onQuickFill={quickFill}
            onSwitchShape={switchShape} onPreview={runPreview} onSave={save} onBack={closeCategory}
            onPanel={setPanel} onOpenRows={() => openRows(open.key)} onRowField={(id, f, v) =>
              setRowDraft((d) => ({ ...d, [id]: { ...(d[id] || rowSeed(rows, id)), [f]: v } }))}
            onSaveRows={saveRows} onRevert={revert}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>Engine Policy</h1>
                <div style={{ marginTop: 6, color: GRAY, fontSize: ".92rem", lineHeight: 1.45 }}>
                  What each category keeps at every location, and when the engine asks for more
                </div>
                <div style={{ marginTop: 6, color: "#6b7280", fontSize: ".8rem" }}>
                  {stamp
                    ? `Last changed ${fmtWhen(stamp.at)} by ${stamp.by} — ${stamp.categoryKey || stamp.groupKey || "rows"}`
                    : "No changes recorded yet"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => load(true)} disabled={loading} style={{ ...bGhost, opacity: loading ? .5 : 1 }}>
                  {loading ? "…" : "Refresh"}
                </button>
                <button onClick={onExit} style={bGhost}>Back</button>
              </div>
            </div>

            <div className="ep-stats" style={{ marginBottom: "1.2rem" }}>
              <Tile label="Governed" value={loading ? "…" : `${governed} of ${categories.length}`}
                sub="the rest fall through to the engine's own rules" />
              <Tile label="Next scan" value={scan.at ? scan.label : "—"}
                sub={scan.at ? "every 15 min, 07:00–19:00" : scan.label} />
              <Tile label="Refills per scan" value={census?.cap ?? "…"}
                sub="shared across every category" />
              <Tile label="Groups" value={Object.keys(census?.groups || {}).length}
                sub={groupsSub(census?.groups)} />
            </div>

            {loading && <div style={{ color: GRAY, padding: "2rem 0" }}>Reading the policy…</div>}
            {error && (
              // A failed read used to hide the entire list with no way back
              // except leaving the screen and returning — on a shop network,
              // where a dropped call is the common case, not the rare one.
              <div style={{ ...GLASS, padding: "1rem", border: "1px solid rgba(248,113,113,.45)" }}>
                <div style={{ color: RED, fontSize: ".9rem" }}>Could not read the policy: {error}</div>
                <button onClick={() => load(true)} style={{ ...bGray, marginTop: ".8rem" }}>Try again</button>
              </div>
            )}

            {!loading && !error && <Groups groups={census?.groups} cap={census?.cap} />}

            {!loading && !error && categories.map((c) => (
              <CategoryRow key={c.key} category={c} onOpen={() => openCategory(c)} />
            ))}

            {!loading && !error && <History entries={census?.history} onRevert={revert} busy={busy} />}

            <div style={{ marginTop: "2rem", color: "#4b5563", fontSize: ".75rem", lineHeight: 1.6 }}>
              These numbers are read live by the refill engine — no deploy, no restart.
              Deleting a category's policy entirely puts it back on the engine's own rules.
              Products with their own rows keep those rows; nothing on this screen removes one.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const rowSeed = (rows, id) => {
  const r = (rows || []).find((x) => `${x.loc}::${x.pid}::${x.sizeKey}` === id) || {};
  return { target: r.target == null ? "" : String(r.target), minQty: r.minQty == null ? "" : String(r.minQty),
    reorderPoint: r.reorderPoint == null ? "" : String(r.reorderPoint) };
};

const groupsSub = (groups) => {
  const g = Object.values(groups || {});
  if (!g.length) return "none yet";
  const armed = g.filter((x) => x?.armed === true).length;
  return armed ? `${armed} armed` : "none armed";
};

function Tile({ label, value, sub }) {
  return (
    <div style={{ ...GLASS, padding: ".85rem .9rem", minWidth: 0 }}>
      <div style={{ color: GRAY, fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: 4 }}>{value}</div>
      <div style={{ color: "#6b7280", fontSize: ".72rem", marginTop: 2, lineHeight: 1.35 }}>{sub}</div>
    </div>
  );
}

// ── CHIPS ────────────────────────────────────────────────────────────────────
// The whole state of a category in one line of small pills, because the row is
// one line now and a sentence would not fit.
function Chip({ tone = "gray", children, onClick, title }) {
  const tones = {
    gray:  { bg: "rgba(255,255,255,.05)", bd: "rgba(255,255,255,.14)", fg: "#c9d3e6" },
    green: { bg: "rgba(74,222,128,.12)",  bd: "rgba(74,222,128,.4)",   fg: GREEN },
    amber: { bg: "rgba(251,191,36,.1)",   bd: "rgba(251,191,36,.35)",  fg: AMBER },
    blue:  { bg: "rgba(74,127,255,.12)",  bd: "rgba(74,127,255,.4)",   fg: BLUE_L },
    red:   { bg: "rgba(248,113,113,.1)",  bd: "rgba(248,113,113,.35)", fg: RED },
  }[tone];
  const style = {
    display: "inline-block", background: tones.bg, border: `1px solid ${tones.bd}`, color: tones.fg,
    borderRadius: 999, padding: "3px 9px", fontSize: ".7rem", fontWeight: 700, whiteSpace: "nowrap",
    fontFamily: FONT, lineHeight: 1.5,
  };
  if (!onClick) return <span style={style} title={title}>{children}</span>;
  return <button type="button" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}
    style={{ ...style, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>{children}</button>;
}

function categoryChips(c) {
  const out = [];
  out.push({ tone: "gray", text: c.perSize ? "per size" : "one size" });
  if (c.policySource === "group") out.push({ tone: "blue", text: `in ${c.groupLabel || c.groupKey}` });
  if ((c.armedEffective || []).length) out.push({ tone: "green", text: `armed at ${c.armedEffective.length}` });
  else out.push({ tone: "gray", text: "no policy" });
  if (c.ownRowCells > 0) {
    out.push({ tone: "amber", text: `${c.ownRowProducts} with their own rows`, rows: true });
  }
  if (c.refused) out.push({ tone: "red", text: "no policy by decision" });
  if (c.rowOnly) out.push({ tone: "gray", text: "not in the taxonomy" });
  return out;
}

// ── THE LIST ROW ─────────────────────────────────────────────────────────────
function CategoryRow({ category: c, onOpen }) {
  return (
    <div style={{ ...GLASS, marginBottom: 8, padding: ".8rem .9rem" }}>
      <button type="button" className="ep-cat" onClick={onOpen}
        aria-label={`Open ${c.label}`}>
        <CategoryImage category={c} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: "1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.label}
          </div>
          <div style={{ color: GRAY, fontSize: ".78rem", marginTop: 2 }}>
            {c.products} {c.products === 1 ? "product" : "products"} · {c.units} on hand
          </div>
          <div className="ep-chips" style={{ marginTop: 6 }}>
            {categoryChips(c).map((ch, i) => <Chip key={i} tone={ch.tone}>{ch.text}</Chip>)}
          </div>
        </div>
        <div style={{ color: "#4b5563", fontSize: "1.2rem", flex: "0 0 auto" }} aria-hidden="true">›</div>
      </button>
    </div>
  );
}

// ── GROUPS ───────────────────────────────────────────────────────────────────
// Read and explain, on this build. A group is created and edited by the
// callable (setGroup); the one thing this panel deliberately does NOT offer is
// an Arm button for a group the model says is over the per-scan cap — the
// server refuses it anyway, and offering a control that always fails is worse
// than not offering it.
function Groups({ groups, cap }) {
  const list = Object.entries(groups || {});
  if (!list.length) return null;
  return (
    <div style={{ marginBottom: "1.2rem" }}>
      <div style={{ color: GRAY, fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>
        Groups
      </div>
      {list.map(([key, g]) => (
        <div key={key} style={{ ...GLASS, padding: ".8rem .9rem", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, fontSize: ".95rem", flex: 1, minWidth: 0 }}>{g?.label || key}</div>
            <Chip tone={g?.armed === true ? "green" : "gray"}>{g?.armed === true ? "armed" : "not armed"}</Chip>
          </div>
          <div style={{ color: GRAY, fontSize: ".78rem", marginTop: 6, lineHeight: 1.5 }}>
            {(g?.memberCategoryKeys || []).length} categories: {(g?.memberCategoryKeys || []).join(", ")}
          </div>
          {g?.armed !== true && (
            <div style={{ color: "#6b7280", fontSize: ".75rem", marginTop: 6, lineHeight: 1.5 }}>
              Not armed. A group that is not armed is not in the engine's resolution at all —
              it cannot produce a single refill, whatever numbers it holds. Arming it is refused
              while it would ask for more than the {cap ?? "per-scan"} refills a scan allows,
              which is shared with every other category.
            </div>
          )}
          <div style={{ color: "#4b5563", fontSize: ".72rem", marginTop: 6, lineHeight: 1.5 }}>
            A category with numbers of its own ignores its group entirely — grouping never
            overrides a setting somebody made on purpose.
          </div>
        </div>
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CATEGORY DETAIL SCREEN
// ═════════════════════════════════════════════════════════════════════════════
function CategoryDetail({
  category: c, destinations, draft, errors, census, banner, preview, keyNow, busy, scan,
  saveable, panel, rows, rowDraft, onField, onArm, onDrop, onQuickFill, onSwitchShape,
  onPreview, onSave, onBack, onPanel, onOpenRows, onRowField, onSaveRows, onRevert,
}) {
  const armed = c.armedEffective || [];
  const locRows = editorRows({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations });
  const headline = armed.length
    ? armed.map((l) => `${locLabel(l)} ${headlineNumber(c.effectiveEntry?.[l])}`).join(" · ")
    : "No policy — the engine's own rules decide";

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
        <CategoryImage category={c} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>{c.label}</h1>
          <div className="ep-chips" style={{ marginTop: 8 }}>
            {categoryChips(c).map((ch, i) => (
              <Chip key={i} tone={ch.tone} onClick={ch.rows ? onOpenRows : undefined}
                title={ch.rows ? "Open these rows and edit them" : undefined}>{ch.text}</Chip>
            ))}
          </div>
          <div style={{ marginTop: 8, color: GRAY, fontSize: ".85rem", lineHeight: 1.5 }}>{headline}</div>
        </div>
        <button onClick={onBack} style={bGhost}>Back</button>
      </div>

      {c.policySource === "group" && (
        <div style={{ ...GLASS, padding: ".8rem 1rem", marginBottom: "1rem",
          border: "1px solid rgba(74,127,255,.35)", color: "#dbe6ff", fontSize: ".85rem", lineHeight: 1.55 }}>
          These numbers come from the <b>{c.groupLabel || c.groupKey}</b> group, not from this
          category. Saving them here gives {c.label} numbers of its own — which takes it out of
          the group, so a later change to the group stops reaching it.
        </div>
      )}

      <div className="ep-stats" style={{ marginBottom: "1.2rem" }}>
        <Tile label="On hand" value={c.units} sub="units across every location" />
        <Tile label="Products" value={c.products} sub="in this category" />
        <Tile label="Locations" value={carriedCount(c)} sub="carry it today" />
        <Tile label="Own rows" value={c.ownRowProducts || 0}
          sub={c.ownRowCells ? `${c.ownRowCells} rows the engine reads first` : "none"} />
      </div>

      {panel === "rows" ? (
        <RowsPanel category={c} rows={rows} rowDraft={rowDraft} busy={busy}
          onRowField={onRowField} onSave={onSaveRows} onClose={() => onPanel("")} />
      ) : panel === "history" ? (
        <div>
          <button onClick={() => onPanel("")} style={{ ...bGhost, marginBottom: ".8rem" }}>Back to the policy</button>
          <History entries={(census?.history || []).filter((h) => !h.categoryKey || h.categoryKey === c.key)}
            onRevert={onRevert} busy={busy} />
        </div>
      ) : (
        <>
          <LocationTable
            category={c} rows={locRows} draft={draft} errors={errors}
            onField={onField} onArm={onArm} onDrop={onDrop}
            onQuickFill={onQuickFill} onSwitchShape={onSwitchShape}
          />

          <Legend />

          {banner.length > 0 && (
            <div style={{ marginTop: "1rem", padding: ".8rem 1rem", borderRadius: RADIUS,
              background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)" }}>
              <div style={{ color: AMBER, fontWeight: 700, fontSize: ".85rem", marginBottom: 6 }}>
                {banner.length} {banner.length === 1 ? "change" : "changes"} not yet saved
              </div>
              {banner.slice(0, 40).map((ch, i) => (
                <div key={i} style={{ fontSize: ".82rem", color: "#e5e7eb", lineHeight: 1.6 }}>
                  <b>{locLabel(ch.loc)}</b> — {ch.text || `${ch.label}: ${ch.from} -> ${ch.to}`}
                </div>
              ))}
              {banner.length > 40 && (
                <div style={{ fontSize: ".8rem", color: "#9ca3af", marginTop: 4 }}>
                  …and {banner.length - 40} more
                </div>
              )}
            </div>
          )}

          <PreviewPanel preview={preview} keyNow={keyNow} cap={census?.cap} busy={busy}
            category={c} errors={errors} onRun={onPreview} />

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "1rem" }}>
            <button onClick={onSave} disabled={!saveable}
              style={{ ...bGreen, opacity: saveable ? 1 : .35, cursor: saveable ? "pointer" : "default" }}>
              {busy === "save" ? "Saving…" : "Save policy"}
            </button>
            <button onClick={() => onPanel("history")} style={bGray}>Policy history</button>
          </div>
        </>
      )}
    </>
  );
}

const carriedCount = (c) => Object.values(c.carriage || {}).filter((v) => v?.carries).length;

// The one number a leg is summarised by in the header. A per-size leg has no
// single number, so it says how many sizes it names rather than inventing one.
function headlineNumber(entry) {
  if (!entry || typeof entry !== "object") return "—";
  if (entry.sizes && typeof entry.sizes === "object") {
    const n = Object.keys(entry.sizes).length;
    return `${n} ${n === 1 ? "size" : "sizes"}`;
  }
  return typeof entry.target === "number" ? String(entry.target) : "—";
}

// ── THE LOCATION TABLE ───────────────────────────────────────────────────────
// One row per location: icon plus name, nothing else on that line. Three
// colour-coded numeric columns. A location with a policy shows its numbers; one
// without shows an em dash and the reason.
const COL_TONE = { target: BLUE_L, minQty: AMBER, reorderPoint: GREEN };

function LocationTable({ category: c, rows, draft, errors, onField, onArm, onDrop, onQuickFill, onSwitchShape }) {
  const sizeRun = c.sizeRun || [];
  const canPerSize = c.perSize && sizeRun.length > 0;
  return (
    <div style={{ ...GLASS, padding: ".6rem .9rem" }}>
      <div className="ep-num-head" style={{ color: GRAY, fontSize: ".68rem", textTransform: "uppercase",
        letterSpacing: ".05em", padding: "4px 0 6px" }}>
        <div>Location</div>
        <div className="ep-nums">
          {FIELD_ORDER.map((f) => (
            <div key={f} style={{ textAlign: "center", color: COL_TONE[f] }}>{COLUMN_LABELS[f]}</div>
          ))}
        </div>
      </div>

      {rows.map((r) => {
        const row = draft[r.loc];
        const inDraft = !!row;
        const perSize = isPerSizeRow(row);
        return (
          <div key={r.loc}>
            <div className="ep-loc">
              <div className="ep-loc-name">
                <span aria-hidden="true" style={{ fontSize: "1rem" }}>{locIcon(r.loc)}</span>
                <span style={{ fontWeight: 600, fontSize: ".93rem" }}>{locLabel(r.loc)}</span>
              </div>
              {inDraft && !perSize ? (
                <div className="ep-nums">
                  {FIELD_ORDER.map((f) => (
                    <input key={f} inputMode="numeric" value={row?.[f] ?? ""}
                      onChange={(e) => onField(r.loc, f, e.target.value)}
                      placeholder={f === "reorderPoint" ? "—" : ""}
                      aria-label={`${locLabel(r.loc)} ${COLUMN_LABELS[f]}`}
                      style={{ ...input, textAlign: "center", padding: "9px 4px", minWidth: 0, width: "100%",
                        borderLeft: `3px solid ${COL_TONE[f]}`,
                        border: errors[r.loc] ? "1px solid rgba(248,113,113,.6)" : input.border }} />
                  ))}
                </div>
              ) : inDraft && perSize ? (
                <div style={{ color: GRAY, fontSize: ".78rem", textAlign: "right" }}>
                  size by size, below
                </div>
              ) : (
                // NO POLICY HERE. An em dash for each column, and the reason
                // underneath — the two reasons are different and lead to
                // different actions.
                <div className="ep-nums">
                  {FIELD_ORDER.map((f) => (
                    <div key={f} style={{ textAlign: "center", color: "#4b5563", fontSize: "1rem" }}>—</div>
                  ))}
                </div>
              )}
            </div>

            {!inDraft && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                padding: "0 0 10px", marginTop: -6 }}>
                <span style={{ color: r.carries ? "#6b7280" : AMBER, fontSize: ".76rem" }}>
                  {r.carries
                    ? `not stocked by the engine here — ${r.productsCarried} carried, ${r.unitsHeld} units`
                    : "not carried — this store does not stock this category"}
                </span>
                <button onClick={() => onArm(r.loc, r.carries)}
                  style={{ ...(r.carries ? bGray : bRed), padding: "5px 10px", fontSize: ".73rem" }}>
                  {r.carries ? "Stock here" : "Arm this store"}
                </button>
              </div>
            )}

            {inDraft && perSize && (
              <SizeRows loc={r.loc} row={row} sizeRun={sizeRun} errors={errors}
                onField={onField} onQuickFill={onQuickFill} />
            )}

            {inDraft && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 0 10px", marginTop: -4 }}>
                {canPerSize && (
                  <button onClick={() => onSwitchShape(r.loc, !perSize, sizeRun)}
                    style={{ ...bGhost, padding: "5px 10px", fontSize: ".73rem" }}>
                    {perSize ? "One number for the whole shop" : "Set it size by size"}
                  </button>
                )}
                <button onClick={() => onDrop(r.loc)}
                  style={{ ...bGhost, padding: "5px 10px", fontSize: ".73rem" }}>Stop stocking here</button>
              </div>
            )}

            {errors[r.loc] && <div style={{ color: RED, fontSize: ".78rem", padding: "0 0 8px" }}>{errors[r.loc]}</div>}
          </div>
        );
      })}

      {c.perSize && !sizeRun.length && (
        // THE STOP. A category the registry calls sized whose run cannot be
        // worked out from live data does not get a guessed list of sizes.
        <div style={{ color: AMBER, fontSize: ".8rem", padding: "8px 0", lineHeight: 1.5 }}>
          No size run can be worked out for this category from the live data — no product
          declares a size, no cell exists and no row exists. Setting numbers size by size here
          would be a guess, so it is not offered.
        </div>
      )}

      {(c.sizeRunExtra || []).length > 0 && (
        <div style={{ color: "#4b5563", fontSize: ".75rem", padding: "8px 0", lineHeight: 1.5 }}>
          This category also holds cells at {c.sizeRunExtra.map(sizeLabel).join(", ")}, which are not
          sizes it comes in. Those are old rows — they still refill on their own numbers, and they are
          edited in the "with their own rows" list, not here.
        </div>
      )}
    </div>
  );
}

// A location's size run, one row each. The quick-fill copies the first size
// that has a number into every size — as its own row, which is the point.
function SizeRows({ loc, row, sizeRun, errors, onField, onQuickFill }) {
  const keys = [...new Set([...(sizeRun || []), ...Object.keys(row.sizes || {})])].sort(bySizeRank);
  const anyFilled = Object.values(row.sizes || {}).some((r) => String(r?.target ?? "").trim() !== "");
  return (
    <div style={{ padding: "2px 0 10px 8px", borderLeft: "2px solid rgba(255,255,255,.07)", marginLeft: 6 }}>
      {keys.map((k) => {
        const sr = row.sizes?.[k] || { target: "", minQty: "", reorderPoint: "" };
        const err = errors[`${loc}::${k}`];
        return (
          <div key={k}>
            <div className="ep-size">
              <div style={{ color: GRAY, fontSize: ".8rem", fontWeight: 600 }}>{sizeLabel(k)}</div>
              <div className="ep-nums">
                {FIELD_ORDER.map((f) => (
                  <input key={f} inputMode="numeric" value={sr[f] ?? ""}
                    onChange={(e) => onField(loc, f, e.target.value, k)}
                    placeholder={f === "reorderPoint" ? "—" : ""}
                    aria-label={`${locLabel(loc)} ${sizeLabel(k)} ${COLUMN_LABELS[f]}`}
                    style={{ ...input, textAlign: "center", padding: "7px 4px", minWidth: 0, width: "100%",
                      fontSize: ".85rem", borderLeft: `3px solid ${COL_TONE[f]}`,
                      border: err ? "1px solid rgba(248,113,113,.6)" : input.border }} />
                ))}
              </div>
            </div>
            {err && <div style={{ color: RED, fontSize: ".75rem", padding: "0 0 4px" }}>{err}</div>}
          </div>
        );
      })}
      {anyFilled && (
        <button onClick={() => onQuickFill(loc, sizeRun)}
          style={{ ...bGhost, padding: "5px 10px", fontSize: ".73rem", marginTop: 6 }}>
          Same across all sizes
        </button>
      )}
      <div style={{ color: "#4b5563", fontSize: ".72rem", marginTop: 6, lineHeight: 1.5 }}>
        Each size is stored on its own. "Same across all sizes" fills them all in one tap and
        every one stays editable afterwards.
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ marginTop: ".9rem", padding: ".8rem 1rem", borderRadius: RADIUS, background: "rgba(255,255,255,.02)",
      border: BORDER, fontSize: ".8rem", lineHeight: 1.7, color: "#c9d3e6" }}>
      <div><b style={{ color: BLUE_L }}>Keep</b> — how many the shelf should hold when it is full.</div>
      <div><b style={{ color: AMBER }}>Minimum</b> — below this a refill card shows as urgent; it changes nothing else.</div>
      <div><b style={{ color: GREEN }}>Ask at</b> — hold the request back until the shelf drops to this number; blank means top up as soon as anything sells.</div>
    </div>
  );
}

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
// Four numbers and a button. Save stays off until it has run against the values
// currently on screen, and any edit — including one size inside a run —
// invalidates it.
function PreviewPanel({ preview, keyNow, cap, busy, category, errors, onRun }) {
  const stale = preview && preview.key !== keyNow;
  const blocked = !!busy || !!Object.keys(errors || {}).length;
  const RunButton = () => (
    <button onClick={onRun} disabled={blocked} style={{ ...bGray, marginTop: ".8rem", opacity: blocked ? .5 : 1 }}>
      {busy === "preview" ? "Working…" : preview && !stale ? "Preview again" : "Preview"}
    </button>
  );
  if (!preview || stale) {
    return (
      <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
        background: "rgba(255,255,255,.02)", border: BORDER }}>
        <div style={{ fontWeight: 700, fontSize: ".9rem" }}>What happens on the next scan</div>
        <div style={{ color: GRAY, fontSize: ".85rem", marginTop: 6, lineHeight: 1.5 }}>
          {stale
            ? "These numbers changed since the last preview. Run it again before saving."
            : busy === "preview" ? "Working it out…" : "Run a preview to see what the next scan would do. Save stays off until you have."}
        </div>
        <RunButton />
      </div>
    );
  }
  const m = preview.model;
  return (
    <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
      background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.3)" }}>
      <div style={{ fontWeight: 700, fontSize: ".9rem", color: BLUE_L }}>What happens on the next scan</div>
      <div className="ep-stats" style={{ margin: ".8rem 0" }}>
        <Stat label="Refills asked for" value={m.totalRequests} of={cap != null ? `of ${cap} per scan` : ""} warn={cap != null && m.totalRequests > cap} />
        <Stat label="Units wanted" value={m.totalUnits} of={`Central holds ${m.centralOnHand}`} warn={m.totalUnits > m.centralOnHand} />
        <Stat label="Below target, unfillable" value={(m.legs || []).reduce((n, l) => n + (l.parked || 0), 0)} of="nothing upstream" />
        <Stat label="On their own rows" value={m.overriddenProducts} of="these numbers do not reach them" warn={m.overriddenProducts > 0} />
      </div>
      <div style={{ fontSize: ".85rem", lineHeight: 1.55, color: "#e5e7eb" }}>
        {previewVerdict(m, { cap })}
      </div>
      <div style={{ marginTop: ".7rem", fontSize: ".74rem", color: "#4b5563", lineHeight: 1.5 }}>
        This is a ceiling. The scan holds back anything already on its way, anything a
        shop recently said no to, and anything over the per-scan limit — so it can ask
        for less than this, never more.
        {category.ownRowProducts > 0 && ` ${category.ownRowProducts} products in this category carry their own rows; the engine reads those first, so these numbers do not reach them.`}
      </div>
      <RunButton />
    </div>
  );
}

function Stat({ label, value, of, warn }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: "1.35rem", fontWeight: 700, color: warn ? AMBER : "#fff" }}>{value}</div>
      <div style={{ color: GRAY, fontSize: ".74rem" }}>{label}</div>
      {of && <div style={{ color: "#4b5563", fontSize: ".7rem", lineHeight: 1.35 }}>{of}</div>}
    </div>
  );
}

// ── "N WITH THEIR OWN ROWS" ──────────────────────────────────────────────────
// The list the chip opens. These are Junid's hand-made /stock_targets rows —
// the source of truth for the products that carry them, and the reason a map
// edit can look like it did nothing. They are EDITED IN PLACE here.
//
// There is no delete control, and there is no "clear them all" button. The
// server refuses both; this panel does not offer them either, because a control
// that always fails is worse than no control.
function RowsPanel({ category: c, rows, rowDraft, busy, onRowField, onSave, onClose }) {
  const dirty = Object.keys(rowDraft).length;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: ".8rem" }}>
        <button onClick={onClose} style={bGhost}>Back to the policy</button>
        <div style={{ flex: 1 }} />
        {dirty > 0 && (
          <button onClick={onSave} disabled={!!busy}
            style={{ ...bGreen, opacity: busy ? .5 : 1 }}>
            {busy === "rows-save" ? "Saving…" : `Save ${dirty} ${dirty === 1 ? "row" : "rows"}`}
          </button>
        )}
      </div>

      <div style={{ ...GLASS, padding: ".9rem 1rem", marginBottom: ".8rem", fontSize: ".84rem",
        color: "#c9d3e6", lineHeight: 1.6 }}>
        These products carry their own numbers, set by hand. The engine reads a row like this
        BEFORE it reads the category policy, so for these products the numbers on the previous
        screen do nothing. That is not a fault — a row is the more specific answer, and it wins
        on purpose. Change one here and it takes effect on the next scan.
        <div style={{ color: "#4b5563", fontSize: ".76rem", marginTop: 8 }}>
          Rows are never deleted from this screen. Clearing a row is a bulk change to
          /stock_targets and needs its own preview and its own rollback file.
        </div>
      </div>

      {!rows && <div style={{ color: GRAY, padding: "1rem 0" }}>Reading the rows…</div>}
      {rows && !rows.length && <div style={{ color: GRAY, padding: "1rem 0" }}>No rows on this category.</div>}

      {rows && rows.length > 0 && (
        <div style={{ ...GLASS, padding: ".6rem .9rem" }}>
          <div className="ep-num-head" style={{ color: GRAY, fontSize: ".68rem", textTransform: "uppercase",
            letterSpacing: ".05em", padding: "4px 0 6px" }}>
            <div>Product</div>
            <div className="ep-nums">
              {FIELD_ORDER.map((f) => <div key={f} style={{ textAlign: "center", color: COL_TONE[f] }}>{COLUMN_LABELS[f]}</div>)}
            </div>
          </div>
          {rows.map((r) => {
            const id = `${r.loc}::${r.pid}::${r.sizeKey}`;
            const d = rowDraft[id];
            const v = (f) => (d ? d[f] : (r[f] == null ? "" : String(r[f])));
            return (
              <div key={id} className="ep-loc">
                <div className="ep-loc-name">
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontWeight: 600, fontSize: ".88rem" }}>{r.name || r.pid}</span>
                  <Chip tone="gray">{locLabel(r.loc)}</Chip>
                  <Chip tone="gray">{r.sizeKey === "_" ? "one size" : sizeLabel(r.sizeKey)}</Chip>
                </div>
                <div className="ep-nums">
                  {FIELD_ORDER.map((f) => (
                    <input key={f} inputMode="numeric" value={v(f)}
                      onChange={(e) => onRowField(id, f, e.target.value)}
                      placeholder={f === "reorderPoint" ? "—" : ""}
                      aria-label={`${r.name || r.pid} ${locLabel(r.loc)} ${COLUMN_LABELS[f]}`}
                      style={{ ...input, textAlign: "center", padding: "8px 4px", minWidth: 0, width: "100%",
                        fontSize: ".85rem", borderLeft: `3px solid ${COL_TONE[f]}` }} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function History({ entries, onRevert, busy }) {
  const list = (entries || []).slice(0, 20);
  if (!list.length) return null;
  return (
    <div style={{ marginTop: "2rem" }}>
      <div style={{ color: GRAY, fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>
        Change history
      </div>
      {list.map((h) => (
        <div key={h.id} style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: ".86rem", fontWeight: 600 }}>
              {h.categoryKey || h.groupKey || "rows"}
              {h.kind === "group" && <Chip tone="blue">group</Chip>}
              {h.kind === "rows" && <Chip tone="amber">{h.rowCount} rows</Chip>}
              {h.status !== "applied" && (
                <span style={{ color: h.status === "aborted_on_drift" ? AMBER : RED, fontWeight: 700, fontSize: ".72rem", marginLeft: 8 }}>
                  {h.status === "aborted_on_drift" ? "not applied — changed underneath" : h.status}
                </span>
              )}
            </div>
            <div style={{ color: "#6b7280", fontSize: ".74rem", marginTop: 2, lineHeight: 1.45 }}>
              {fmtWhen(h.at)} · {h.by} · {(h.changes || []).slice(0, 6).map((ch) =>
                `${ch.loc || ""}${ch.size ? ` ${sizeLabel(ch.size)}` : ""} ${ch.field} ${ch.from ?? "not set"} -> ${ch.to ?? "not set"}`).join(", ") || "no field changes"}
              {(h.changes || []).length > 6 && ` … +${h.changes.length - 6}`}
            </div>
          </div>
          {h.status === "applied" && !h.kind && (
            <button onClick={() => onRevert(h)} disabled={!!busy}
              style={{ ...bGhost, padding: "6px 10px", fontSize: ".75rem", opacity: busy ? .5 : 1 }}>Revert</button>
          )}
        </div>
      ))}
    </div>
  );
}

export { defaultMinQty };

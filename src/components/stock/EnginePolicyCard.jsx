// ─── ENGINE POLICY ────────────────────────────────────────────────────────────
// What each category keeps at every location, and when the engine asks for
// more. The owner-facing face of /config/refillEngine/categoryPolicy and
// /config/refillEngine/policyGroups.
//
// ── THE STANDING RULE FOR THIS SCREEN: NO PARAGRAPH ANYWHERE ─────────────────
// Numbers, labels, chips and controls. One short line at most per control, and
// only where a number alone would be ambiguous. Every explanation that used to
// live on the screen lives in this file's comments instead. The tests pin it:
// no rendered text node on the list, the detail, the preview or the rows
// panel is longer than one line's worth.
//
// ── WHAT THE SCREEN IS ───────────────────────────────────────────────────────
//   LIST      one row per category — and ONE row per GROUP, sorted in with the
//             rest, its members folded inside it (mainListEntries). A photo,
//             the counts, a chip row, the armed state.
//   DETAIL    the same screen for a category and a group: header (photo, name,
//             chips, headline numbers) → for a group, its member list → a 2×2
//             stat block, label and number only → ONE BORDERED BOX PER
//             LOCATION, each with its own Keep / Minimum / Ask at header row
//             directly above its inputs → the unsaved-changes list → the
//             next-scan preview → Save and History.
//
// ── THE FOUR THINGS THIS SCREEN IS TRYING TO PREVENT ─────────────────────────
//
//   1. ARMING A STORE THAT DOES NOT CARRY THE CATEGORY. A mapped product is
//      managed at a mapped location UNCONDITIONALLY — refill-engine.cjs
//      managedPids has no carriage gate, deliberately — so arming an uncarried
//      store invents demand for EVERY product in the category at a shop that
//      has never stocked one. "Arm this store" is its own button with its own
//      confirmation; a carried-but-unarmed one gets "Stock here".
//
//   2. SAVING WITHOUT KNOWING WHAT THE NEXT SCAN WILL DO. Save stays disabled
//      until a preview has run against the values currently on screen, and any
//      edit invalidates it — including an edit to one size inside a run.
//
//   3. NOT KNOWING WHOSE NUMBERS THESE ARE. A category is governed by its own
//      entry or by a GROUP. A group's members are reached from inside the
//      group; a member's own numbers beat the group's, and that is said in one
//      line above the member list and one line on the member's own screen.
//
//   4. TREATING A HAND-MADE ROW AS A PROBLEM. 7,693 explicit /stock_targets
//      rows on 1,650 products (2026-08-22) are the SOURCE OF TRUTH for the
//      products that carry them. The "N old rows" chip OPENS THEM FOR EDITING.
//      Nothing on this screen deletes one, and the tests assert no button says
//      clear, remove or delete.
//
// ── ACCESS ───────────────────────────────────────────────────────────────────
// Super-admin only, through three independent gates: the home tile does not
// render (App.jsx), the route refuses to mount this component (App.jsx), and
// setCategoryPolicy re-checks the caller's email server-side. THE COMPONENT IS
// SPLIT so the default export holds ZERO hooks — a refused viewer must open no
// subscription and start no fetch.
//
// NONE OF THAT IS A SECURITY BOUNDARY YET. /config/refillEngine is writable by
// any stockRole 'admin' account (four live). The console rule printed by
// scripts/print-engine-policy-rule.mjs narrows them to one; it is not live.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, BG, BORDER, GLASS, RADIUS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bGhost, bRed, input, tabOn, tabOff } from "./ui";
import {
  COLUMN_LABELS, FIELD_ORDER, editorRows, draftFromEntry, seedLocation,
  onTargetChanged, policyFromDraft, validateDraft, previewKey, canSave, changedFields,
  nextScanAt, previewVerdict, firstSentence, lastChange, defaultMinQty,
  isPerSizeRow, fillAllSizes, seedPerSizeLocation, bySizeRank, sizeLabel,
  mainListEntries, previewFromArmModel,
} from "./enginePolicyCore";
import { serverNowMs } from "../../utils/serverTime";
import SeatingTab from "./SeatingTab";
import { enginePolicyVisibleForViewer } from "../../config/enginePolicy";

// 300s to match the function's own timeoutSeconds. The Firebase JS SDK defaults
// httpsCallable to 70,000ms; the census, the row list and the group model can
// run longer, and a save whose response was never received looks like a save
// that did not happen. (CodeRabbit, PR #401.)
const CALLABLE_TIMEOUT_MS = 300000;
const setCategoryPolicyFn = () => httpsCallable(functions, "setCategoryPolicy", { timeout: CALLABLE_TIMEOUT_MS });

const LOC_LABELS = { hub2: "Hub 2", hub1: "Hub 1", hub3: "Hub 3", central: "Central", "marathon-pe": "Marathon PE", "marathon-pine": "Marathon Pine", trophy: "Trophy" };
const locLabel = (l) => LOC_LABELS[l] || l;
// A hub and a shop are different kinds of place; the glyph is the only thing
// left to say so with once the line is one line. Two glyphs, not seven.
const locIcon = (l) => (/^hub|^central/.test(l) ? "🏬" : "🏪");

// ── CATEGORY IMAGERY ─────────────────────────────────────────────────────────
// A studio photograph per category, generated once (scripts/generate-
// category-images.mjs) and cached on the taxonomy entry as `imageUrl`. A group
// borrows its biggest member's. EMOJI IS THE FALLBACK: a category with no image
// yet, or one whose image fails to load, gets its glyph. Nothing is generated
// at render time.
const ICONS = {
  "caps-beanies": "🧢", "fitted-caps": "🧢", visors: "🧢", perfumes: "🌸", bags: "👜", belts: "🎗️",
  "t-shirts": "👕", hoodies: "🧥", jackets: "🧥", pants: "👖", shorts: "🩳", sneakers: "👟",
  slides: "🩴", "soccer-boots": "⚽", "soccer-jerseys": "👕", tracksuits: "🎽", "ladies-tracksuits": "🎽",
  watches: "⌚", sunglasses: "🕶️", "chains-bracelets": "📿", underwear: "🩲", dresses: "👗",
  suits: "🤵", shirts: "👔", "golf-t-shirts": "👕", "baseball-shirts": "👕", "basketball-vests": "🎽",
  gloves: "🧤", "designer-shoes": "👞", boots: "🥾", "cargo-pants": "👖", "kids-shoes": "👟",
  loafers: "👞", "running-shoes": "👟", jeans: "👖", sweaters: "🧥", packaging: "📦",
};
const iconFor = (k) => ICONS[k] || (String(k || "").startsWith("group:") ? "👟" : "📦");

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

// "22 Aug at 12:24" — the stamp's exact wording. Africa/Johannesburg is UTC+2
// year-round, so the offset is a constant.
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtWhen = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + SA_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} at ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

// ── THE ONLY CSS IN THIS FILE, AND WHY IT IS CSS ─────────────────────────────
// Everything else is an inline style, matching the rest of the Stock section.
// These are MEDIA QUERIES and grid tracks an inline style cannot express:
//
//   .ep-stats  the stat block is never more than two columns at phone width
//   .ep-box    ONE BORDERED BOX PER LOCATION, visually separated from the next
//   .ep-cols   the Keep / Minimum / Ask at header row — THE SAME three tracks
//              as .ep-nums, so each label sits over its own input
//   .ep-size   a size row: the size label in a narrow track, the three numbers
//              in the rest — and the header row above uses the same track so
//              the labels stay over the inputs in a run too
//   .ep-loc    the rows panel's row (product | numbers)
const CSS = `
.ep-stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
@media (min-width:720px){ .ep-stats { grid-template-columns:repeat(4,minmax(0,1fr)); } }

.ep-box { border:1px solid rgba(255,255,255,.14); border-radius:14px; padding:10px 12px; margin-bottom:10px;
          background:rgba(255,255,255,.02); display:flex; flex-direction:column; gap:8px; }
.ep-box-head { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }
.ep-loc-name { display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 auto; }
.ep-loc-name > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ep-box-actions { display:flex; gap:6px; flex-wrap:wrap; margin-left:auto; }

.ep-cols { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.ep-nums { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
@media (min-width:560px){
  .ep-cols, .ep-nums { grid-template-columns:repeat(3,96px); }
}
.ep-size { display:grid; grid-template-columns:minmax(0,54px) 1fr; gap:8px; align-items:center; }
.ep-err { color:#F87171; font-size:.78rem; line-height:1.4; }

.ep-loc { display:grid; grid-template-columns:minmax(0,1fr); gap:6px 10px; align-items:center;
          padding:10px 0; border-bottom:1px solid rgba(255,255,255,.05); }
@media (min-width:560px){ .ep-loc { grid-template-columns:minmax(0,1fr) 300px; } .ep-loc .ep-nums { justify-content:end; } }
.ep-num-head { display:none; }
@media (min-width:560px){ .ep-num-head { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:10px; } }

.ep-cat { display:flex; align-items:center; gap:12px; width:100%; text-align:left;
          background:transparent; border:none; color:inherit; font:inherit; padding:0; cursor:pointer; min-width:0; }
.ep-chips { display:flex; flex-wrap:wrap; gap:6px; }
`;

// ═════════════════════════════════════════════════════════════════════════════
// GATE 2b — THE COMPONENT'S OWN CHECK, AND WHY IT HOLDS NO HOOKS
// ═════════════════════════════════════════════════════════════════════════════
// This is the whole default export. It has no useState, no useEffect and opens
// nothing, so a viewer who is refused causes not one read, not one callable
// invocation, and no listener. An early `return` placed after the hooks would
// still have run them, and a hook cannot be moved below a conditional return
// without changing the hook count between renders. The route mount in App.jsx
// checks the same condition independently. Deleting either one must fail
// tests — see scripts/mutation-proof-engine-policy.mjs (M-TILE, M-ROUTE,
// M-COMPONENT).
export default function EnginePolicyCard({ viewer, products, onExit }) {
  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;
  return <EnginePolicyAuthed viewer={viewer} products={products} onExit={onExit} />;
}

function Refused({ onExit }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "2rem 1rem" }}>
      <div style={{ ...GLASS, maxWidth: 420, margin: "12vh auto", padding: "1.5rem" }}>
        <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>Engine Policy is owner-only</div>
        <button onClick={onExit} style={{ ...bGhost, marginTop: "1.2rem" }}>Back</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs ONLY for a verified super-admin.
// ═════════════════════════════════════════════════════════════════════════════
function EnginePolicyAuthed({ viewer, products, onExit }) {
  const [census, setCensus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState("");     // the category (or group) on the detail screen
  const [parentKey, setParentKey] = useState(""); // the group a member was opened FROM, so Back returns to it
  const [draft, setDraft] = useState({});
  const [preview, setPreview] = useState(null);   // { key, model, before, changes }
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);         // { kind, text }
  const [panel, setPanel] = useState("");         // "" | "rows" | "history"
  // ── THE TABS ───────────────────────────────────────────────────────────────
  // "categories" is what this card has always been. "seating" is the same
  // policy question asked per PRODUCT instead of per category — which shop
  // carries this line — so it belongs here rather than on a surface of its own.
  // The tab renders inside EnginePolicyAuthed, which only ever mounts for a
  // verified super-admin, and it re-checks that condition for itself below:
  // three independent gates, exactly as the card's other contents have.
  const [tab, setTab] = useState("categories");
  const [rows, setRows] = useState(null);         // the explicit-row list, when opened
  const [rowsMeta, setRowsMeta] = useState(null); // { total, truncated, limit, loc, locations, byLocation }
  const [rowDraft, setRowDraft] = useState({});
  // After a MEMBER is saved the list reloads and the member is folded back
  // into its group — so the screen returns to the GROUP, not to a list the
  // member is not on. The key is held here and honoured when the fresh census
  // arrives. (Adversarial review, PR #405.)
  const reopenAfterLoad = useRef("");

  // The timer is held and cleared, rather than fired and forgotten: a second
  // message inside the window used to inherit the first one's timer, and an
  // unmount left a pending setNote to run against a dead tree.
  const flashTimer = useRef(null);
  const flash = useCallback((kind, text) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setNote({ kind, text });
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setNote(null); }, 9000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // ONE call, on mount, for the whole list. The counts are derived from
  // /products and /stock server-side; a browser that read those would download
  // the catalogue onto a phone on a shop network.
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

  // THE MAIN LIST: categories and groups sorted in together, a group's members
  // folded into the group's entry. See mainListEntries.
  const categories = useMemo(() => mainListEntries(census), [census]);
  // EVERY entry, members included — the detail screen can open a member from
  // inside its group even though the main list does not show it.
  const allEntries = useMemo(() => [...(census?.categories || []), ...(census?.groupEntries || [])], [census]);

  const open = allEntries.find((c) => c.key === openKey) || null;
  const parent = parentKey ? allEntries.find((c) => c.key === parentKey) || null : null;
  const destinations = census?.destinations || [];
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const keyNow = useMemo(() => previewKey(openKey, draft, { perSize: open?.perSize }), [openKey, draft, open]);
  const proposed = useMemo(() => policyFromDraft(draft, { perSize: open?.perSize }), [draft, open]);
  const banner = useMemo(() => changedFields(open?.entry || null, proposed), [open, proposed]);
  const saveable = canSave({ preview, previewKeyNow: keyNow, errors, busy: !!busy });
  const scan = nextScanAt(serverNowMs());
  const stamp = lastChange(census?.history);

  useEffect(() => {
    const key = reopenAfterLoad.current;
    if (!key || !census) return;
    reopenAfterLoad.current = "";
    const entry = (census.groupEntries || []).find((c) => c.key === key) || (census.categories || []).find((c) => c.key === key);
    if (entry) openCategory(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [census]);

  const openCategory = (c, from = null) => {
    setOpenKey(c.key);
    setParentKey(from ? from.key : "");
    setPreview(null);
    setPanel("");
    setRows(null);
    // A GROUPED category's editor opens on the GROUP'S numbers, because those
    // are the numbers in force. Saving them writes an entry of its own, which
    // takes the category out of the group — said in one line on its screen.
    // A GROUP opens on its own policy.
    setDraft(draftFromEntry({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations }));
  };
  // Back from a member returns to its group; Back from anything else to the list.
  const closeCategory = () => {
    if (parent) { openCategory(parent); return; }
    closeAll();
  };
  const closeAll = () => { setOpenKey(""); setParentKey(""); setDraft({}); setPreview(null); setPanel(""); setRows(null); };

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

  // "Same for every size" — a typing aid. It writes each size individually
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
      // THE UNION THE PANEL RENDERS, not the derived run alone: a stored size
      // can fall outside the current run once the run shrinks, and filling
      // from the run alone discarded it. (CodeRabbit, PR #401.)
      const union = [...new Set([...(sizeRun || []), ...Object.keys(sizes)])].sort(bySizeRank);
      return { ...d, [loc]: fillAllSizes(union, from) };
    });
  };

  // Arming a store that does not carry the category is its own deliberate act,
  // with its own confirmation, because it invents demand rather than adjusting
  // it. See the header note.
  const armStore = (loc, carries) => {
    if (!carries) {
      // A DISARMED GROUP's numbers reach nothing until the group is armed, so
      // the warning says that instead of promising demand that will not come.
      const dormant = open?.isGroup && !open.armed;
      const ok = window.confirm(
        `${locLabel(loc)} does not stock ${open?.label} today.\n\n` +
        (dormant
          ? `These numbers do nothing while the group is not armed. Once it is armed, the engine will ask ` +
            `for every product in its ${(open.memberCategoryKeys || []).length} categories at ${locLabel(loc)}, not only ones it has sold.\n\n`
          : `Arming it tells the engine to keep this category there — it will start asking ` +
            `for every product in the category at ${locLabel(loc)}, not only ones it has sold.\n\n`) +
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

  // Toggle a leg's carriage scope. `carriedOnly: true` rides on the draft row
  // (either shape) and policyFromDraft writes it into the location entry;
  // clearing it DELETES the key rather than writing false, so an unscoped
  // entry keeps yesterday's byte shape exactly.
  const setCarriedOnly = (loc, v) => {
    setPreview(null);
    setDraft((d) => {
      const row = d[loc];
      if (!row) return d;
      const next = { ...row };
      if (v) next.carriedOnly = true; else delete next.carriedOnly;
      return { ...d, [loc]: next };
    });
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

  // The group object a save or preview sends: the live group with ONLY its
  // policy replaced. label, members and armed go back exactly as they came —
  // this screen edits numbers; arming is a separate deliberate act and is not
  // offered here.
  const groupFor = (g, policy) => ({ ...(g.group || {}), policy: policy === null ? null : policy });

  const runPreview = async () => {
    if (busy || Object.keys(errors).length) return;
    setBusy("preview");
    const forKey = keyNow;
    try {
      if (open?.isGroup) {
        // A group previews through setGroup's dry run, which models every
        // member as if the group were armed and writes nothing.
        const res = await setCategoryPolicyFn()({ action: "setGroup", groupKey: open.groupKey, group: groupFor(open, proposed), dryRun: true });
        setPreview({ key: forKey, model: previewFromArmModel(res.data.armModel, { armed: open.armed }), before: null, changes: banner });
      } else {
        const res = await setCategoryPolicyFn()({ categoryKey: openKey, policy: proposed, dryRun: true });
        // The preview is stamped with the key of the values it was computed FROM.
        // If the owner edited a field while it was in flight, this preview is
        // about numbers that are no longer on screen and must not enable Save.
        setPreview({ key: forKey, model: res.data.preview.after, before: res.data.preview.before, changes: res.data.changes });
      }
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!saveable) return;
    // A MEMBER that has no entry of its own gets one here — and leaves its
    // group's governance for good, even if the numbers typed are the group's
    // own. That is a bigger change than the numbers look, so it is confirmed.
    if (open && !open.isGroup && open.memberOfGroup && !open.entry && typeof window !== "undefined" && window.confirm) {
      const ok = window.confirm(
        `${open.label} will get its own numbers and stop following ${parent?.label || open.groupLabel || "its group"}.\n\nContinue?`);
      if (!ok) return;
    }
    const backTo = parent ? parent.key : "";
    setBusy("save");
    try {
      const res = open?.isGroup
        // A GROUP saves through setGroup: the live group with only its policy
        // replaced, and the live group as the expectation — armed stays what
        // it was.
        ? await setCategoryPolicyFn()({ action: "setGroup", groupKey: open.groupKey, group: groupFor(open, proposed), expectedBefore: open.group ?? null })
        : await setCategoryPolicyFn()({
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
      else if (open?.isGroup && !open.armed) flash("ok", "Saved. The group is not armed, so the next scan asks for nothing from it.");
      else flash("ok", `Saved. The next scan (${scan.label}) uses these numbers.`);
      closeAll();
      reopenAfterLoad.current = backTo;
      await load(true);
    } catch (e) {
      // A reload that failed after a successful write must not leave the
      // reopen armed for some later, unrelated refresh. (Delta review, #405.)
      reopenAfterLoad.current = "";
      flash("bad", e?.message || String(e));
      if (/changed while/i.test(e?.message || "")) await load(true);
    } finally {
      setBusy("");
    }
  };

  const revert = async (h) => {
    if (busy) return;
    if (h.kind === "rows") {
      flash("bad", "Row edits are not reverted from here — the entry records exactly what they were.");
      return;
    }
    const what = h.kind === "group" ? h.groupKey : h.categoryKey;
    const ok = window.confirm(
      `Put ${what} back to how it was before this change?\n\n` +
      (h.kind === "group"
        ? `label ${h.after?.label ?? "—"} -> ${h.before?.label ?? "—"}, armed ${String(h.after?.armed ?? "—")} -> ${String(h.before?.armed ?? "—")}`
        : (h.changes || []).map((c) => `  ${c.loc || ""} ${c.field}: ${c.to ?? "not set"} -> ${c.from ?? "not set"}`).join("\n")));
    if (!ok) return;
    setBusy("revert");
    try {
      if (h.kind === "group") {
        // The group's previous state, whole, with the state it became as the
        // expectation — same drift discipline as a category revert. A revert
        // that would re-ARM a group goes through the same cap gate as any
        // other arming write; the server refuses it over the cap.
        await setCategoryPolicyFn()({ action: "setGroup", groupKey: h.groupKey, group: h.before ?? null, expectedBefore: h.after ?? null });
      } else {
        await setCategoryPolicyFn()({ categoryKey: h.categoryKey, policy: h.before ?? null, expectedBefore: h.after ?? null });
      }
      flash("ok", `${what} put back to how it was on ${fmtWhen(h.at)}.`);
      closeAll();
      await load(true);
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  // ── THE EXPLICIT-ROW LIST ─────────────────────────────────────────────────
  // Opened from the "N old rows" chip. These rows are the source of truth for
  // the products that carry them; this reads them and lets them be edited in
  // place. NOTHING HERE DELETES ONE — the server refuses it, and there is no
  // control for it either.
  const openRows = async (key, loc = null) => {
    // NARROWING THROWS THE DRAFT AWAY, so it asks first. (Delta review, #401.)
    if (Object.keys(rowDraft).length) {
      const n = Object.keys(rowDraft).length;
      const ok = window.confirm(
        `You have ${n} unsaved ${n === 1 ? "row" : "rows"}.\n\nChanging which rows are shown discards ${n === 1 ? "it" : "them"}. Continue?`);
      if (!ok) return;
    }
    setPanel("rows"); setRows(null); setRowDraft({});
    setBusy("rows");
    try {
      // A GROUP's rows are every member's rows — the server sums them the same
      // way the chip did.
      const who = open?.isGroup ? { groupKey: open.groupKey } : { categoryKey: key };
      const res = await setCategoryPolicyFn()(loc ? { action: "rows", ...who, loc } : { action: "rows", ...who });
      setRows(res.data.rows || []);
      // The server caps the list. Held separately from `rows` so the panel can
      // say "showing N of M" honestly rather than silently rendering a prefix.
      setRowsMeta({ total: res.data.total, matching: res.data.matching ?? res.data.total,
        truncated: !!res.data.truncated, narrowingHelps: !!res.data.narrowingHelps, limit: res.data.limit,
        loc: res.data.loc || null, locations: res.data.locations || [], byLocation: res.data.byLocation || {} });
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
      const res = await setCategoryPolicyFn()(open?.isGroup
        ? { action: "setRows", groupKey: open.groupKey, rows: edits }
        : { action: "setRows", categoryKey: openKey, rows: edits });
      flash("ok", res.data.noChange ? "Nothing to save — those are the numbers already on the rows."
        : `${res.data.rowCount} ${res.data.rowCount === 1 ? "row" : "rows"} updated.`);
      setRowDraft({});
      await openRows(openKey, rowsMeta?.loc || null);
      await load(true);
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  // Counted over EVERY category, members included — a member with its own
  // armed entry is governed even though the list folds it into its group.
  // (Architecture review, PR #405.)
  const allCats = census?.categories || [];
  const governed = allCats.filter((c) => (c.armedEffective || []).length).length;
  const oldRows = (census?.categories || []).reduce((n, c) => n + (c.ownRowCells || 0), 0);

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "1rem 1rem 4rem" }}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        {note && (
          <div style={{ ...GLASS, padding: ".8rem 1rem", marginBottom: "1rem",
            border: `1px solid ${note.kind === "ok" ? "rgba(74,222,128,.45)" : "rgba(248,113,113,.45)"}`,
            color: note.kind === "ok" ? GREEN : RED, fontSize: ".9rem", lineHeight: 1.5 }}>{note.text}</div>
        )}

        {/* ── TABS ────────────────────────────────────────────────────────
            Hidden while a category detail is open: the detail IS the
            categories tab, and a tab strip over it would offer to leave an
            unsaved draft with no warning. */}
        {!open && (
          <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
            <button onClick={() => setTab("categories")} style={tab === "categories" ? tabOn : tabOff}>Categories</button>
            <button onClick={() => setTab("seating")} style={tab === "seating" ? tabOn : tabOff}>Seating</button>
          </div>
        )}

        {tab === "seating" && !open ? (
          // GATE 2c. EnginePolicyAuthed already only mounts for a verified
          // super-admin, and App.jsx gates the tile and the route. This is a
          // fourth, independent check on the tab itself, so that deleting any
          // one of them leaves the others working — mutation-proved, not
          // asserted.
          enginePolicyVisibleForViewer(viewer) ? (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>Seating</h1>
                  <div style={{ marginTop: 6, color: "#6b7280", fontSize: ".8rem" }}>Where a product sits</div>
                </div>
                <button onClick={onExit} style={bGhost}>Back</button>
              </div>
              <SeatingTab products={products} viewer={viewer} flash={flash} />
            </>
          ) : <Refused onExit={onExit} />
        ) : open ? (
          <CategoryDetail
            category={open} parent={parent} destinations={destinations} draft={draft} errors={errors}
            census={census} banner={banner} preview={preview} keyNow={keyNow} busy={busy}
            scan={scan} saveable={saveable} panel={panel} rows={rows} rowsMeta={rowsMeta} rowDraft={rowDraft}
            onField={setField} onArm={armStore} onDrop={dropStore} onQuickFill={quickFill}
            onSwitchShape={switchShape} onScope={setCarriedOnly} onPreview={runPreview} onSave={save} onBack={closeCategory}
            onPanel={setPanel} onOpenRows={(loc) => openRows(open.key, loc || null)} onRowField={(id, f, v) =>
              setRowDraft((d) => ({ ...d, [id]: { ...(d[id] || rowSeed(rows, id)), [f]: v } }))}
            onSaveRows={saveRows} onRevert={revert}
            onOpenMember={(m) => { const e = allEntries.find((c) => c.key === m.key); if (e) openCategory(e, open); }}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>Engine Policy</h1>
                <div style={{ marginTop: 6, color: "#6b7280", fontSize: ".8rem" }}>
                  {stamp ? `Last changed ${fmtWhen(stamp.at)}` : "No changes recorded yet"}
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
              <Tile label="Governed" value={loading ? "…" : `${governed} of ${allCats.length}`} />
              <Tile label="Next scan" value={scan.label} />
              <Tile label="Refills per scan" value={census?.cap ?? "…"} />
              <Tile label="Old rows" value={loading ? "…" : oldRows} />
            </div>

            {loading && <div style={{ color: GRAY, padding: "2rem 0" }}>Reading the policy…</div>}
            {error && (
              // A failed read must not hide the list with no way back except
              // leaving the screen — on a shop network a dropped call is the
              // common case.
              <div style={{ ...GLASS, padding: "1rem", border: "1px solid rgba(248,113,113,.45)" }}>
                <div style={{ color: RED, fontSize: ".9rem" }}>Could not read the policy: {error}</div>
                <button onClick={() => load(true)} style={{ ...bGray, marginTop: ".8rem" }}>Try again</button>
              </div>
            )}

            {!loading && !error && categories.map((c) => (
              <CategoryRow key={c.key} category={c} onOpen={() => openCategory(c)} />
            ))}

            {!loading && !error && <History entries={census?.history} onRevert={revert} busy={busy} />}
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

// A stat card: label and number. Nothing under it.
function Tile({ label, value }) {
  return (
    <div style={{ ...GLASS, padding: ".85rem .9rem", minWidth: 0 }}>
      <div style={{ color: GRAY, fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

// ── CHIPS ────────────────────────────────────────────────────────────────────
// The whole state of a category in one line of small pills.
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
  // A GROUP is one entry with a small count of what it holds. Its armed state
  // is the group's flag: a disarmed group with numbers in it is "not armed",
  // never "armed at N" — the numbers are not in the engine's resolution.
  if (c.isGroup) {
    const n = (c.memberCategoryKeys || []).length;
    out.push({ tone: "blue", text: `${n} ${n === 1 ? "category" : "categories"}` });
    if (c.armed === true && (c.armedEffective || []).length) out.push({ tone: "green", text: `armed at ${c.armedEffective.length}` });
    else out.push({ tone: "gray", text: "not armed" });
  } else {
    if (c.policySource === "group") out.push({ tone: "blue", text: `in ${c.groupLabel || c.groupKey}` });
    else if (c.memberOfGroup && !c.entry) out.push({ tone: "blue", text: "in its group" });
    if ((c.armedEffective || []).length) out.push({ tone: "green", text: `armed at ${c.armedEffective.length}` });
    else out.push({ tone: "gray", text: "no policy" });
  }
  // "N old rows" — the explicit /stock_targets rows the engine reads first. A
  // LINK that opens them for editing; never a count of something to clear.
  if (c.ownRowCells > 0) out.push({ tone: "amber", text: `${c.ownRowCells} old ${c.ownRowCells === 1 ? "row" : "rows"}`, rows: true });
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

// ═════════════════════════════════════════════════════════════════════════════
// THE DETAIL SCREEN — one screen for a category and for a group
// ═════════════════════════════════════════════════════════════════════════════
function CategoryDetail({
  category: c, parent, destinations, draft, errors, census, banner, preview, keyNow, busy, scan,
  saveable, panel, rows, rowsMeta, rowDraft, onField, onArm, onDrop, onQuickFill, onSwitchShape,
  onScope, onPreview, onSave, onBack, onPanel, onOpenRows, onRowField, onSaveRows, onRevert, onOpenMember,
}) {
  const armed = c.armedEffective || [];
  const locRows = editorRows({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations });
  const headline = armed.length
    ? armed.map((l) => `${locLabel(l)} ${headlineNumber(c.effectiveEntry?.[l])}`).join(" · ")
    : "No policy";

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
        <CategoryImage category={c} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>{c.label}</h1>
          <div className="ep-chips" style={{ marginTop: 8 }}>
            {categoryChips(c).map((ch, i) => (
              <Chip key={i} tone={ch.tone} onClick={ch.rows ? () => onOpenRows(null) : undefined}
                title={ch.rows ? "Open these rows and edit them" : undefined}>{ch.text}</Chip>
            ))}
          </div>
          <div style={{ marginTop: 8, color: GRAY, fontSize: ".85rem" }}>{headline}</div>
        </div>
        <button onClick={onBack} style={bGhost}>{parent ? `Back to ${parent.label}` : "Back"}</button>
      </div>

      {/* A MEMBER opened from inside its group: one line, because it is the
          one thing about this screen that is not obvious from the numbers. */}
      {!c.isGroup && c.memberOfGroup && (
        <div style={{ color: "#dbe6ff", fontSize: ".82rem", marginBottom: ".9rem" }}>
          Saving here gives {c.label} its own numbers — they beat {parent?.label || c.groupLabel || "the group"}'s.
        </div>
      )}

      {c.isGroup && <MemberList group={c} onOpen={onOpenMember} />}

      <div className="ep-stats" style={{ marginBottom: "1.2rem" }}>
        <Tile label="On hand" value={c.units} />
        <Tile label="Products" value={c.products} />
        <Tile label="Locations" value={carriedCount(c)} />
        <Tile label="Old rows" value={c.ownRowCells || 0} />
      </div>

      {panel === "rows" ? (
        <RowsPanel category={c} rows={rows} meta={rowsMeta} rowDraft={rowDraft} busy={busy}
          onRowField={onRowField} onSave={onSaveRows} onClose={() => onPanel("")} onNarrow={onOpenRows} />
      ) : panel === "history" ? (
        <div>
          <button onClick={() => onPanel("")} style={{ ...bGhost, marginBottom: ".8rem" }}>Back to the policy</button>
          <History entries={(census?.history || []).filter((h) => c.isGroup
            ? (h.groupKey === c.groupKey || (c.memberCategoryKeys || []).includes(h.categoryKey))
            : (!h.categoryKey || h.categoryKey === c.key))}
            onRevert={onRevert} busy={busy} />
        </div>
      ) : (
        <>
          <LocationBoxes
            category={c} rows={locRows} draft={draft} errors={errors}
            onField={onField} onArm={onArm} onDrop={onDrop}
            onQuickFill={onQuickFill} onSwitchShape={onSwitchShape} onScope={onScope}
          />

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

// ── THE MEMBERS OF A GROUP ───────────────────────────────────────────────────
// Compact and tappable: any member can still be given numbers of its own, and
// the one rule that makes grouping safe is stated in ONE line above the list.
function MemberList({ group: g, onOpen }) {
  const members = g.members || [];
  return (
    <div style={{ ...GLASS, padding: ".6rem .9rem", marginBottom: "1.2rem" }}>
      <div style={{ color: GRAY, fontSize: ".78rem", padding: "2px 0 6px" }}>
        A category's own numbers beat the group's.
      </div>
      {members.map((m) => (
        <button key={m.key} type="button" className="ep-cat" onClick={() => onOpen(m)}
          aria-label={`Open member ${m.label}`}
          style={{ padding: "6px 0", borderTop: "1px solid rgba(255,255,255,.05)" }}>
          <CategoryImage category={m} size={28} />
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: ".88rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
            <span style={{ color: GRAY, fontSize: ".76rem", whiteSpace: "nowrap" }}>
              {m.products} {m.products === 1 ? "product" : "products"} · {m.units} on hand
            </span>
            {m.ownPolicy && <Chip tone="green">own numbers</Chip>}
          </div>
          <div style={{ color: "#4b5563", fontSize: "1.1rem", flex: "0 0 auto" }} aria-hidden="true">›</div>
        </button>
      ))}
    </div>
  );
}

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

// ── THE LOCATION BOXES ───────────────────────────────────────────────────────
// ONE BORDERED BOX PER LOCATION, visually separated from the next. Inside every
// box, directly above its three inputs, a three-column header row — Keep,
// Minimum, Ask at — each aligned over its input and coloured to match that
// input's accent border. It repeats in every box; it is never collapsed into a
// legend elsewhere. Validation errors render INSIDE the box they belong to, in
// normal flow below the inputs, so they can never overlap the control below.
const COL_TONE = { target: BLUE_L, minQty: AMBER, reorderPoint: GREEN };

function ColumnHeads() {
  return (
    <div className="ep-cols" role="row" aria-label="Keep, Minimum, Ask at">
      {FIELD_ORDER.map((f) => (
        <div key={f} className="ep-col-head" style={{ textAlign: "center", color: COL_TONE[f], fontSize: ".68rem",
          textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{COLUMN_LABELS[f]}</div>
      ))}
    </div>
  );
}

function NumInputs({ row, err, onChange, ariaPrefix, small = false }) {
  return (
    <div className="ep-nums">
      {FIELD_ORDER.map((f) => (
        <input key={f} inputMode="numeric" value={row?.[f] ?? ""}
          onChange={(e) => onChange(f, e.target.value)}
          placeholder={f === "reorderPoint" ? "—" : ""}
          aria-label={`${ariaPrefix} ${COLUMN_LABELS[f]}`}
          style={{ ...input, textAlign: "center", padding: small ? "7px 4px" : "9px 4px", minWidth: 0, width: "100%",
            fontSize: small ? ".85rem" : input.fontSize,
            border: err ? "1px solid rgba(248,113,113,.6)" : input.border,
            borderLeft: `3px solid ${COL_TONE[f]}` }} />
      ))}
    </div>
  );
}

function LocationBoxes({ category: c, rows, draft, errors, onField, onArm, onDrop, onQuickFill, onSwitchShape, onScope }) {
  const sizeRun = c.sizeRun || [];
  const canPerSize = c.perSize && sizeRun.length > 0;
  const smallBtn = { padding: "5px 10px", fontSize: ".73rem" };
  return (
    <div>
      {rows.map((r) => {
        const row = draft[r.loc];
        const inDraft = !!row;
        const perSize = isPerSizeRow(row);
        return (
          <div key={r.loc} className="ep-box" data-loc={r.loc}>
            <div className="ep-box-head">
              <div className="ep-loc-name">
                <span aria-hidden="true" style={{ fontSize: "1rem" }}>{locIcon(r.loc)}</span>
                <span style={{ fontWeight: 600, fontSize: ".93rem" }}>{locLabel(r.loc)}</span>
              </div>
              <div className="ep-box-actions">
                {/* Carriage scope (2026-08-25). "Carried only" = this leg speaks
                    ONLY for products the location already holds a stock cell
                    for; "All products" = the map's standing promise (the whole
                    category is armed here, carriage or not). The engine is what
                    enforces it — categoryPolicyEntry's carriedOnly gate. */}
                {inDraft && (
                  <button onClick={() => onScope(r.loc, !row.carriedOnly)}
                    title={row.carriedOnly
                      ? "Only products this location already stocks get these numbers. Tap for every product in the category."
                      : "Every product in the category gets these numbers here. Tap to limit it to products this location already stocks."}
                    style={{ ...(row.carriedOnly ? bGray : bGhost), ...smallBtn }}>
                    {row.carriedOnly ? "Carried only" : "All products"}
                  </button>
                )}
                {inDraft && canPerSize && (
                  <button onClick={() => onSwitchShape(r.loc, !perSize, sizeRun)} style={{ ...bGhost, ...smallBtn }}>
                    {perSize ? "One number" : "Size by size"}
                  </button>
                )}
                {inDraft && (
                  <button onClick={() => onDrop(r.loc)} style={{ ...bGhost, ...smallBtn }}>Stop stocking here</button>
                )}
                {!inDraft && (
                  <button onClick={() => onArm(r.loc, r.carries)} style={{ ...(r.carries ? bGray : bRed), ...smallBtn }}>
                    {r.carries ? "Stock here" : "Arm this store"}
                  </button>
                )}
              </div>
            </div>

            {inDraft && !perSize && (
              <>
                <ColumnHeads />
                <NumInputs row={row} err={!!errors[r.loc]} ariaPrefix={locLabel(r.loc)}
                  onChange={(f, v) => onField(r.loc, f, v)} />
                {errors[r.loc] && <div className="ep-err">{errors[r.loc]}</div>}
              </>
            )}

            {inDraft && perSize && (
              <SizeRows loc={r.loc} row={row} sizeRun={sizeRun} partial={c.sizeRunPartial || []} extra={c.sizeRunExtra || []}
                memberCount={c.sizeRunMembersWithRun ?? (c.memberCategoryKeys || []).length} errors={errors}
                onField={onField} onQuickFill={onQuickFill} />
            )}

            {!inDraft && (
              <>
                <div className="ep-nums">
                  {FIELD_ORDER.map((f) => (
                    <div key={f} style={{ textAlign: "center", color: "#4b5563", fontSize: "1rem" }}>—</div>
                  ))}
                </div>
                <div style={{ color: r.carries ? "#6b7280" : AMBER, fontSize: ".76rem" }}>
                  {r.carries ? `${r.productsCarried} carried · ${r.unitsHeld} units` : "not carried here"}
                </div>
              </>
            )}
          </div>
        );
      })}

      {c.perSize && !sizeRun.length && (
        // THE STOP. A category the registry calls sized whose run cannot be
        // worked out from live data does not get a guessed list of sizes.
        <div style={{ color: AMBER, fontSize: ".8rem", padding: "4px 0" }}>
          No size run can be worked out from live data — size by size is not offered.
        </div>
      )}
    </div>
  );
}

// A location's size run inside its box, one row per size. The column header
// sits above the run in the same tracks, so Keep / Minimum / Ask at stay over
// their inputs. A size only SOME of a group's members carry is marked ◐. The
// quick-fill copies the first size that has a number into every size — as its
// own row, which is the point.
function SizeRows({ loc, row, sizeRun, partial, extra, memberCount, errors, onField, onQuickFill }) {
  const keys = [...new Set([...(sizeRun || []), ...Object.keys(row.sizes || {})])].sort(bySizeRank);
  const anyFilled = Object.values(row.sizes || {}).some((r) => String(r?.target ?? "").trim() !== "");
  const partialSet = new Set(partial || []);
  const anyPartial = keys.some((k) => partialSet.has(k));
  return (
    <>
      <div className="ep-size">
        <div />
        <ColumnHeads />
      </div>
      {keys.map((k) => {
        const sr = row.sizes?.[k] || { target: "", minQty: "", reorderPoint: "" };
        const err = errors[`${loc}::${k}`];
        return (
          <React.Fragment key={k}>
            <div className="ep-size">
              <div style={{ color: GRAY, fontSize: ".8rem", fontWeight: 600, whiteSpace: "nowrap" }}>
                {sizeLabel(k)}{partialSet.has(k) && <span title="only some categories carry this size" aria-label="only some categories carry this size"> ◐</span>}
              </div>
              <NumInputs row={sr} err={!!err} small ariaPrefix={`${locLabel(loc)} ${sizeLabel(k)}`}
                onChange={(f, v) => onField(loc, f, v, k)} />
            </div>
            {err && <div className="ep-size"><div /><div className="ep-err">{err}</div></div>}
          </React.Fragment>
        );
      })}
      {errors[loc] && <div className="ep-err">{errors[loc]}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {anyFilled && (
          <button onClick={() => onQuickFill(loc, sizeRun)} style={{ ...bGhost, padding: "5px 10px", fontSize: ".73rem" }}>
            Same for every size
          </button>
        )}
        {anyPartial && (
          <span style={{ color: "#6b7280", fontSize: ".72rem" }}>{`◐ only some of the ${memberCount} categories carry this size`}</span>
        )}
      </div>
      {/* Sizes OUTSIDE the run cannot be named here and fall through to the
          engine's rules — said once, because "same for every size" does not
          reach them. */}
      {(extra || []).length > 0 && (
        <div style={{ color: "#6b7280", fontSize: ".72rem" }}>
          {`${extra.length} ${extra.length === 1 ? "size" : "sizes"} outside the run (${extra.slice(0, 6).map(sizeLabel).join(", ")}${extra.length > 6 ? "…" : ""}) not set here — they follow the engine's rules`}
        </div>
      )}
    </>
  );
}

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
// Four numbers, one line and a button. Save stays off until it has run against
// the values currently on screen, and any edit — including one size inside a
// run — invalidates it.
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
        <div style={{ fontWeight: 700, fontSize: ".9rem" }}>Next scan</div>
        <div style={{ color: GRAY, fontSize: ".85rem", marginTop: 6 }}>
          {stale ? "Numbers changed — preview again before saving." : busy === "preview" ? "Working it out…" : "Preview before saving."}
        </div>
        <RunButton />
      </div>
    );
  }
  const m = preview.model;
  if (m?.ifArmed) {
    // A GROUP. The model is what arming it would cost; the honest headline for
    // a disarmed group is that the next scan asks for nothing from it.
    return (
      <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
        background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.3)" }}>
        <div style={{ fontWeight: 700, fontSize: ".9rem", color: BLUE_L }}>
          {m.armed ? "Next scan" : "Not armed — the next scan asks for nothing from this group"}
        </div>
        <div className="ep-stats" style={{ margin: ".8rem 0" }}>
          <Stat label={m.armed ? "Refills asked for" : "Refills if armed"} value={m.totalRequests} of={cap != null ? `of ${cap} per scan` : ""} warn={cap != null && m.totalRequests > cap} />
          <Stat label="Units wanted" value={m.totalUnits} />
          <Stat label="Categories" value={(m.perMember || []).length} />
          <Stat label="Old rows" value={m.overriddenProducts} warn={m.overriddenProducts > 0} />
        </div>
        <RunButton />
      </div>
    );
  }
  // The verdict's FIRST sentence only — the number that constrains the outcome.
  // Cut WITHOUT a lookbehind: see firstSentence in enginePolicyCore.js. An
  // unsupported lookbehind is a parse-time SyntaxError that takes the whole
  // bundle down on Safari before 16.4, not a broken line.
  const line = firstSentence(previewVerdict(m, { cap }));
  return (
    <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
      background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.3)" }}>
      <div style={{ fontWeight: 700, fontSize: ".9rem", color: BLUE_L }}>Next scan</div>
      <div className="ep-stats" style={{ margin: ".8rem 0" }}>
        <Stat label="Refills asked for" value={m.totalRequests} of={cap != null ? `of ${cap} per scan` : ""} warn={cap != null && m.totalRequests > cap} />
        <Stat label="Units wanted" value={m.totalUnits} of={`Central holds ${m.centralOnHand}`} warn={m.totalUnits > m.centralOnHand} />
        <Stat label="Below target, unfillable" value={(m.legs || []).reduce((n, l) => n + (l.parked || 0), 0)} />
        <Stat label="On their own rows" value={m.overriddenProducts} warn={m.overriddenProducts > 0} />
      </div>
      <div style={{ fontSize: ".85rem", color: "#e5e7eb" }}>{line}</div>
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

// ── "N OLD ROWS" ─────────────────────────────────────────────────────────────
// The list the chip opens. Junid's hand-made /stock_targets rows — the source
// of truth for the products that carry them, and the reason a map edit can
// look like it did nothing. They are EDITED IN PLACE here. There is no delete
// control and no "clear them all" button; the server refuses both.
function RowsPanel({ category: c, rows, meta, rowDraft, busy, onRowField, onSave, onClose, onNarrow }) {
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

      {/* THE LIST IS CAPPED, AND IT SAYS SO, in one line. t-shirts has 1,870
          rows; a prefix shown silently would be worse than one shown honestly. */}
      {rows && meta?.truncated && (
        <div style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: ".8rem",
          border: "1px solid rgba(251,191,36,.35)", color: AMBER, fontSize: ".82rem" }}>
          Showing {rows.length} of {meta.matching} rows{meta.loc ? ` at ${locLabel(meta.loc)}` : ""}{meta.narrowingHelps ? " — narrow to one location for the rest" : ""}
        </div>
      )}
      {rows && (meta?.locations || []).length > 1 && (
        <div className="ep-chips" style={{ marginBottom: ".8rem" }}>
          {/* Every count here is the FULL count for that location, whatever is
              currently narrowed to. */}
          <Chip tone={meta.loc ? "gray" : "blue"} onClick={meta.loc ? () => onNarrow(null) : undefined}>
            All {meta.total != null ? `(${meta.total})` : ""}
          </Chip>
          {meta.locations.map((l) => (
            <Chip key={l} tone={meta.loc === l ? "blue" : "gray"}
              onClick={meta.loc === l ? undefined : () => onNarrow(l)}>
              {locLabel(l)}{meta.byLocation?.[l] != null ? ` (${meta.byLocation[l]})` : ""}
            </Chip>
          ))}
        </div>
      )}

      {!rows && <div style={{ color: GRAY, padding: "1rem 0" }}>Reading the rows…</div>}
      {rows && !rows.length && <div style={{ color: GRAY, padding: "1rem 0" }}>No rows on {c.label}.</div>}

      {rows && rows.length > 0 && (
        <div style={{ ...GLASS, padding: ".6rem .9rem" }}>
          <div className="ep-num-head" style={{ padding: "4px 0 6px" }}>
            <div style={{ color: GRAY, fontSize: ".68rem", textTransform: "uppercase", letterSpacing: ".05em" }}>Product</div>
            <ColumnHeads />
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
                <NumInputs row={{ target: v("target"), minQty: v("minQty"), reorderPoint: v("reorderPoint") }} small
                  ariaPrefix={`${r.name || r.pid} ${locLabel(r.loc)}`} onChange={(f, val) => onRowField(id, f, val)} />
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
            <div style={{ color: "#6b7280", fontSize: ".74rem", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fmtWhen(h.at)} · {(h.changes || []).slice(0, 3).map((ch) =>
                `${ch.loc || ""}${ch.size ? ` ${sizeLabel(ch.size)}` : ""} ${ch.field} ${ch.from ?? "not set"} -> ${ch.to ?? "not set"}`).join(", ") || (h.kind === "group" ? "group" : "no field changes")}
              {(h.changes || []).length > 3 && ` +${h.changes.length - 3}`}
            </div>
          </div>
          {h.status === "applied" && h.kind !== "rows" && (
            <button onClick={() => onRevert(h)} disabled={!!busy}
              style={{ ...bGhost, padding: "6px 10px", fontSize: ".75rem", opacity: busy ? .5 : 1 }}>Revert</button>
          )}
        </div>
      ))}
    </div>
  );
}

export { defaultMinQty };

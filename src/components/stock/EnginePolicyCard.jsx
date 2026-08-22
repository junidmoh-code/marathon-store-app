// ─── ENGINE POLICY ────────────────────────────────────────────────────────────
// The owner-facing face of /config/refillEngine/categoryPolicy and
// /config/refillEngine/policyGroups.
//
// ── THE THIRD PASS: ONE LIST, AND NO PROSE ───────────────────────────────────
// A GROUP IS NOT A SECTION. The seven footwear categories are one Sneakers
// policy, and it sits in the same list as every category, sorted in with them,
// carrying a photo, the combined counts, a "7 categories" chip and its armed
// state. Its members are reachable from inside it and appear nowhere else — a
// category listed both beside its group and inside it was what the separate
// GROUPS section, and its three explanatory paragraphs, actually cost.
//
// AND THERE IS NO PARAGRAPH ANYWHERE. One short line per control, only where a
// number alone would be ambiguous. What was deleted, exactly: the header
// subtitle, the "by <email> — <key>" tail under the timestamp, every
// explanatory sub-line under every stat card, the whole GROUPS block, the grey
// note about legacy size cells (now a chip that OPENS them), and the
// Keep / Minimum / Ask at legend.
//
// The legend is gone because the three names are now over the three inputs, in
// EVERY location box — a legend at the bottom of a long screen is a legend
// nobody can see from the third shop. Each location is its own bordered box
// with its own repeated column headers, and a validation error renders on its
// own row INSIDE that box: the old layout floated the message under an input
// with a negative margin above the next control, so "Keep is required" printed
// on top of the row below it.
//
// The structure is: header (image, name, chips, headline numbers) → a 2×2 stat
// block that is never more than two columns at phone width → one box per
// location → (for a group) its member list → the next-scan preview → the
// footer actions.
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
  nextScanAt, previewVerdict, previewVerdictParts, lastChange, defaultMinQty,
  isPerSizeRow, fillAllSizes, seedPerSizeLocation, bySizeRank, sizeLabel,
} from "./enginePolicyCore";
import { serverNowMs } from "../../utils/serverTime";
import { enginePolicyVisibleForViewer } from "../../config/enginePolicy";

// 300s to match the function's own timeoutSeconds. The Firebase JS SDK defaults
// httpsCallable to 70,000ms, so without this the three heavy actions — the
// census, the explicit-row list, and the model that runs before a group may be
// armed — could fail on the client with deadline-exceeded while the function
// carried on running to completion. The owner reads that as "the screen is
// broken", and worse, a save whose response was never received looks like a
// save that did not happen. (CodeRabbit, PR #401.)
const CALLABLE_TIMEOUT_MS = 300000;
const setCategoryPolicyFn = () => httpsCallable(functions, "setCategoryPolicy", { timeout: CALLABLE_TIMEOUT_MS });

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

/* ── ONE BORDERED BOX PER LOCATION ──────────────────────────────────────────
   The previous screen ran every location together as one continuous column of
   stacked text, so where one shop's numbers ended and the next began was a
   judgement call made from spacing alone. Each location is its own box now,
   with its own border, and the three-column header repeats inside every one of
   them: a header drawn once at the top of a long list is a header nobody can
   see by the time they reach the third shop. */
.ep-box { border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:10px 12px 12px;
          margin-bottom:10px; background:rgba(255,255,255,.02); }
.ep-box-head { display:flex; align-items:center; gap:8px; min-width:0; margin-bottom:8px; }
.ep-box-head > .ep-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
/* Header cells and inputs share ONE column template, so each label sits over
   its own input at every width. Three equal columns, never collapsed. */
.ep-nums { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.ep-colhead { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:4px; }
/* A size run indents its rows behind the size label; the header row carries the
   same leading cell so the columns still line up over the inputs. */
.ep-sized { display:grid; grid-template-columns:minmax(44px,56px) minmax(0,1fr); gap:8px; align-items:center; }
/* Errors get their OWN row inside the box. The old layout floated the message
   under an input with a negative margin above the next control, so "Keep is
   required" printed on top of the row below it. */
.ep-err { grid-column:1 / -1; color:#f87171; font-size:.78rem; line-height:1.4; padding-top:6px; }

/* The explicit-rows panel keeps the older two-track row: it is a long list of
   products, not a handful of locations, and a box each would be a page of
   borders. */
.ep-loc { display:grid; grid-template-columns:minmax(0,1fr); gap:6px 10px; align-items:center;
          padding:10px 0; border-bottom:1px solid rgba(255,255,255,.05); }
.ep-loc-name { display:flex; align-items:center; gap:8px; min-width:0; }
.ep-loc-name > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (min-width:560px){
  .ep-loc { grid-template-columns:minmax(0,1fr) 260px; }
}
.ep-num-head { display:none; }
@media (min-width:560px){
  .ep-num-head { display:grid; grid-template-columns:minmax(0,1fr) 260px; gap:10px; }
}
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
  const [rowsMeta, setRowsMeta] = useState(null); // { total, truncated, limit, loc, locations, byLocation }
  const [rowDraft, setRowDraft] = useState({});
  const [cameFrom, setCameFrom] = useState("");   // the group a member was opened from

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

  // ── ONE LIST ─────────────────────────────────────────────────────────────
  // Group entries and category entries in the SAME list, sorted together. A
  // group's member categories are left out of it: they are reachable from
  // inside the group entry, and a category that appeared both beside its group
  // and inside it was the separate GROUPS section this pass deleted.
  const categories = useMemo(() => {
    const list = [
      ...(census?.groupEntries || []),
      ...(census?.categories || []).filter((c) => !c.memberOfGroup),
    ];
    // Governed first (they are what somebody came to change), then anything
    // with products or rows, then the empty rest — alphabetical inside each.
    return [...list].sort((a, b) => {
      const band = (c) => (c.armedEffective?.length ? 0 : (c.products > 0 || c.ownRowCells > 0) ? 1 : 2);
      return band(a) - band(b) || String(a.label).localeCompare(String(b.label));
    });
  }, [census]);

  // A member category opened from inside its group is not in `categories` (the
  // group hides it), so the lookup falls back to the full census list.
  const open = categories.find((c) => c.key === openKey)
    || (census?.categories || []).find((c) => c.key === openKey) || null;
  const destinations = census?.destinations || [];
  const errors = useMemo(() => validateDraft(draft), [draft]);
  // ── perSize IS A PROPERTY OF WHAT IS ON SCREEN, NOT ONLY OF WHAT IS STORED ─
  // A category given size-by-size numbers for the first time has a per-size
  // DRAFT and a scalar stored entry; keying `perSize` off the stored entry
  // alone would write a size map with no perSize:true beside it, which the
  // engine refuses outright (a per-size map outside per-size mode arms
  // nothing). (Fable review, PR #404.)
  const draftIsPerSize = useMemo(() => Object.values(draft || {}).some(isPerSizeRow), [draft]);
  const perSizeNow = !!open?.perSize || draftIsPerSize;
  const keyNow = useMemo(() => previewKey(openKey, draft, { perSize: perSizeNow }), [openKey, draft, perSizeNow]);
  const proposed = useMemo(() => policyFromDraft(draft, { perSize: perSizeNow }), [draft, perSizeNow]);
  const banner = useMemo(() => changedFields(open?.entry || null, proposed), [open, proposed]);
  // ── A LEG THE EDITOR NEVER RENDERED MUST NOT BE SAVED AWAY ────────────────
  // The save .set()s the whole entry, so anything absent from the draft is
  // deleted. The card and the census answer "is this leg armed?" with slightly
  // different tests — the client refuses a size map without perSize:true or a
  // target of 0, the census accepts any well-formed shape — and /config is
  // writable by Admin SDK and the console, so such a leg can exist. It would
  // have been silently deleted by the next save, and the drift check could not
  // see it: live still matched what was rendered. (Adversarial review, #404.)
  const unrenderedLegs = useMemo(() => {
    const named = open?.isGroup ? (open.policyLocations || []) : Object.keys(open?.entry || {}).filter((k) => k !== "perSize");
    return named.filter((loc) => !(loc in (draft || {})));
  }, [open, draft]);
  const saveable = canSave({ preview, previewKeyNow: keyNow, errors, busy: !!busy })
    && unrenderedLegs.length === 0;
  const scan = nextScanAt(serverNowMs());
  const stamp = lastChange(census?.history);

  // Opening one of a group's categories from inside it. The member is not in
  // `categories` (the group hides it), so it is looked up in the full census.
  const openMember = (key) => {
    const c = (census?.categories || []).find((x) => x.key === key);
    if (!c) return;
    // Remember where this was opened from, so Back returns to the group rather
    // than to the top of the list. (Fable review, PR #404.)
    const from = openKey;
    openCategory(c);
    setCameFrom(from);
  };

  const openCategory = (c) => {
    setOpenKey(c.key);
    setPreview(null);
    setPanel("");
    // A GROUPED category's editor opens on the GROUP'S numbers, because those
    // are the numbers in force. Saving them writes an entry of its own, which
    // takes the category out of the group — said plainly in the detail header
    // rather than discovered afterwards.
    //
    // ── AND THE GROUP'S SIZES ARE NOT NECESSARILY ITS SIZES ──────────────────
    // The group's run is the UNION of its members', so a member opened from
    // inside it was seeded with sizes it does not carry — and the server, which
    // validates a category write against THAT CATEGORY'S run, refused the save
    // outright ("13 is not one of this category's sizes"). The documented way
    // out of a group could not be executed at all. The seed is narrowed to the
    // member's own run here. (Adversarial review, #404.)
    setDraft(narrowToOwnRun(
      draftFromEntry({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations }), c));
  };
  const closeCategory = () => {
    const back = cameFrom;
    setCameFrom("");
    setPreview(null); setPanel(""); setRows(null);
    if (back) {
      const g = (census?.groupEntries || []).find((x) => x.key === back);
      if (g) { openCategory(g); return; }
    }
    setOpenKey(""); setDraft({});
  };

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
      // THE UNION THE PANEL RENDERS, not the derived run alone. SizeRows draws
      // sizeRun ∪ the draft's own keys, because a stored size can fall outside
      // the current run once the run shrinks. Filling from sizeRun alone
      // DISCARDED those sizes: the owner saw one, typed a number into it,
      // tapped "Same across all sizes", and watched it vanish — and the save
      // then un-armed it. (CodeRabbit, PR #401.)
      const union = [...new Set([...(sizeRun || []), ...Object.keys(sizes)])].sort(bySizeRank);
      return { ...d, [loc]: fillAllSizes(union, from) };
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

  // The group's policy is written through setGroup, so both the preview and the
  // save need the whole group object with its numbers replaced — never a
  // reconstructed one. `armed` and `memberCategoryKeys` are carried through
  // untouched: editing numbers is not arming, and it does not change who is in.
  const groupPayload = (policy) => ({
    label: open?.label, memberCategoryKeys: open?.memberCategoryKeys,
    armed: open?.armedGroup === true, ...(policy === null ? {} : { policy }),
  });
  // THE LIVE NODE AS THE SERVER READ IT, never a rebuild: a reconstructed
  // {label, memberCategoryKeys, armed, policy} compares unequal to a live node
  // that lacks a key or carries an extra one, and every save would then fail
  // the drift check with a message that is false. (Adversarial review, #404.)
  const groupBefore = () => (open?.isGroup ? (open.rawGroup ?? null) : null);

  const runPreview = async () => {
    if (busy || Object.keys(errors).length) return;
    setBusy("preview");
    const forKey = keyNow;
    try {
      if (open?.isGroup) {
        const res = await setCategoryPolicyFn()({
          action: "setGroup", groupKey: open.groupKey, group: groupPayload(proposed), dryRun: true });
        // A DISARMED group is modelled as "if this were armed" — the server
        // says so, and the panel repeats it rather than presenting a number
        // about a world that does not exist as though it did.
        // POSITIVELY TRUE. Defaulting to hypothetical meant a client running
        // ahead of the function (no `hypothetical` in the response) headed an
        // ARMED group's real preview "If this were armed" — the one label that
        // must never be wrong. (Adversarial review, #404.)
        setPreview({ key: forKey, model: null, hypothetical: res.data.hypothetical === true,
          armModel: res.data.armModel, changes: [] });
        return;
      }
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
      if (open?.isGroup) {
        const res = await setCategoryPolicyFn()({
          action: "setGroup", groupKey: open.groupKey, group: groupPayload(proposed),
          // The exact group this editor was opened on. The server refuses the
          // write if live no longer matches it.
          expectedBefore: groupBefore(),
        });
        if (res.data.noChange) flash("ok", "Nothing to save — these are the numbers already live.");
        else flash("ok", `Saved. ${open.label} stays ${open.armedGroup ? "armed" : "off"}.`);
        closeCategory();
        await load(true);
        return;
      }
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
  const openRows = async (key, loc = null) => {
    // NARROWING THROWS THE DRAFT AWAY, so it asks first. The panel renders
    // "Save N rows" directly above the location chips; tapping one used to
    // clear the edits with no warning at all. (Delta review, PR #401.)
    if (Object.keys(rowDraft).length) {
      const n = Object.keys(rowDraft).length;
      const ok = window.confirm(
        `You have ${n} unsaved ${n === 1 ? "row" : "rows"}.\n\nChanging which rows are shown discards ${n === 1 ? "it" : "them"}. Continue?`);
      if (!ok) return;
    }
    setPanel("rows"); setRows(null); setRowDraft({});
    setBusy("rows");
    try {
      const res = await setCategoryPolicyFn()(loc
        ? { action: "rows", categoryKey: key, loc }
        : { action: "rows", categoryKey: key });
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
      const res = await setCategoryPolicyFn()({ action: "setRows", categoryKey: openKey, rows: edits });
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
            scan={scan} saveable={saveable} unrenderedLegs={unrenderedLegs} panel={panel} rows={rows} rowsMeta={rowsMeta} rowDraft={rowDraft}
            onField={setField} onArm={armStore} onDrop={dropStore} onQuickFill={quickFill}
            onSwitchShape={switchShape} onPreview={runPreview} onSave={save} onBack={closeCategory}
            onOpenMember={openMember}
            onPanel={setPanel} onOpenRows={(loc) => openRows(open.key, loc || null)} onRowField={(id, f, v) =>
              setRowDraft((d) => ({ ...d, [id]: { ...(d[id] || rowSeed(rows, id)), [f]: v } }))}
            onSaveRows={saveRows} onRevert={revert}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>Engine Policy</h1>
                {/* The stamp, and nothing else. The subtitle that used to sit
                    here described the screen to somebody already on it, and the
                    "by <email> — <key>" tail repeated what the change history
                    below says in full. */}
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

            {/* LABEL AND NUMBER. Every stat card used to carry a line of
                explanation under it; four of them stacked read as a paragraph
                broken into pieces, and none of them changed what anybody did. */}
            <div className="ep-stats" style={{ marginBottom: "1.2rem" }}>
              <Tile label="Governed" value={loading ? "…" : `${governed} of ${categories.length}`} />
              <Tile label="Next scan" value={scan.at ? scan.label : "—"} />
              <Tile label="Refills per scan" value={census?.cap ?? "…"} />
              <Tile label="Locations" value={destinations.length} />
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

// Drop from a draft every size the category itself does not carry. Only ever
// applied when the numbers came from a GROUP (a category's own entry is already
// about its own sizes, and narrowing it would silently discard the owner's
// work). A leg left with no sizes at all falls back to a blank row rather than
// disappearing, so the location is still visible and still editable.
function narrowToOwnRun(draft, c) {
  if (!c || c.isGroup || c.policySource !== "group") return draft;
  const run = new Set(c.sizeRun || []);
  if (!run.size) return draft;
  const out = {};
  for (const [loc, row] of Object.entries(draft || {})) {
    if (!isPerSizeRow(row)) { out[loc] = row; continue; }
    const sizes = {};
    for (const k of Object.keys(row.sizes)) if (run.has(k)) sizes[k] = row.sizes[k];
    out[loc] = Object.keys(sizes).length ? { sizes } : seedPerSizeLocation([...run]);
  }
  return out;
}

const rowSeed = (rows, id) => {
  const r = (rows || []).find((x) => `${x.loc}::${x.pid}::${x.sizeKey}` === id) || {};
  return { target: r.target == null ? "" : String(r.target), minQty: r.minQty == null ? "" : String(r.minQty),
    reorderPoint: r.reorderPoint == null ? "" : String(r.reorderPoint) };
};

function Tile({ label, value }) {
  return (
    <div style={{ ...GLASS, padding: ".85rem .9rem", minWidth: 0 }}>
      <div style={{ color: GRAY, fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: 4 }}>{value}</div>
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
  // A GROUP LEADS WITH HOW MANY CATEGORIES IT IS. It is one policy in the list
  // now, and the only thing that distinguishes it from a category is that it
  // speaks for seven of them.
  if (c.isGroup) out.push({ tone: "blue", text: `${c.memberCategoryKeys.length} categories` });
  out.push({ tone: "gray", text: c.perSize ? "per size" : "one size" });
  if (!c.isGroup && c.policySource === "group") out.push({ tone: "blue", text: `in ${c.groupLabel || c.groupKey}` });
  if ((c.armedEffective || []).length) out.push({ tone: "green", text: `armed at ${c.armedEffective.length}` });
  // A DISARMED GROUP HOLDING NUMBERS IS "off", NOT "no policy". It has a full
  // per-size policy at N locations; it is simply not in the engine's resolution
  // until somebody arms it, and "no policy" said the opposite of that.
  // (Fable review, PR #404.)
  else if (c.isGroup && (c.policyLocations || []).length) {
    out.push({ tone: "amber", text: `off — numbers at ${c.policyLocations.length}` });
  } else out.push({ tone: "gray", text: "no policy" });
  // ── THE ROW CHIPS ARE NOT TAPPABLE ON A GROUP ────────────────────────────
  // The explicit-row list is keyed by categoryKey, and a group is not one. A
  // tappable chip here would have called the server with "group:footwear-all"
  // and rendered an empty list — a control that silently does nothing. The
  // counts still SHOW (they are the members' rows added up, and the map's
  // numbers do not reach those products), and each member's own chip opens its
  // own rows from inside the group. (Architecture review, PR #404.)
  if (c.ownRowCells > 0) {
    out.push({ tone: "amber", text: `${c.ownRowProducts} with their own rows`, rows: !c.isGroup });
  }
  // ── "N OLD ROWS" ─────────────────────────────────────────────────────────
  // Replaces the grey paragraph that used to sit under the location table
  // explaining that a category "also holds cells at S, M, L…". It is a chip
  // that OPENS those rows, in the same list every other row is edited in.
  // The count is of ROWS, not of sizes, and the chip only appears when there
  // are rows to open. (Fable review, PR #404.)
  if ((c.extraSizeRowCells || 0) > 0) {
    out.push({ tone: "amber", text: `${c.extraSizeRowCells} old rows`, rows: !c.isGroup,
      title: `Rows at ${(c.sizeRunExtra || []).map(sizeLabel).join(", ")} — sizes this category does not come in` });
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

// ═════════════════════════════════════════════════════════════════════════════
// THE CATEGORY DETAIL SCREEN
// ═════════════════════════════════════════════════════════════════════════════
function CategoryDetail({
  category: c, destinations, draft, errors, census, banner, preview, keyNow, busy, scan,
  saveable, unrenderedLegs, panel, rows, rowsMeta, rowDraft, onField, onArm, onDrop, onQuickFill, onSwitchShape,
  onPreview, onSave, onBack, onPanel, onOpenRows, onRowField, onSaveRows, onRevert, onOpenMember,
}) {
  const armed = c.armedEffective || [];
  const locRows = editorRows({ entry: c.effectiveEntry || c.entry, carriage: c.carriage, destinations });
  // The locations to summarise: what the ENGINE acts on, or — for a disarmed
  // group — the locations its policy holds numbers for. Reporting "No policy"
  // for a group that holds a full per-size policy was simply untrue.
  const summarised = armed.length ? armed : (c.isGroup ? (c.policyLocations || []) : []);
  const headline = summarised.length
    ? `${summarised.map((l) => `${locLabel(l)} ${headlineNumber(c.effectiveEntry?.[l])}`).join(" · ")}${armed.length ? "" : " — not armed"}`
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
                title={ch.title || (ch.rows ? "Open these rows and edit them" : undefined)}>{ch.text}</Chip>
            ))}
          </div>
          <div style={{ marginTop: 8, color: GRAY, fontSize: ".85rem", lineHeight: 1.5 }}>{headline}</div>
        </div>
        <button onClick={onBack} style={bGhost}>Back</button>
      </div>

      {!c.isGroup && c.policySource === "group" && (
        // ONE LINE. Saving here takes the category out of its group, which is a
        // bigger change than the numbers look — that is the whole content, and
        // the paragraph that used to say it three times is gone.
        <div style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: "1rem",
          border: "1px solid rgba(74,127,255,.35)", color: "#dbe6ff", fontSize: ".85rem" }}>
          These numbers come from <b>{c.groupLabel || c.groupKey}</b> — saving here takes {c.label} out of it.
        </div>
      )}

      <div className="ep-stats" style={{ marginBottom: "1.2rem" }}>
        <Tile label="On hand" value={c.units} />
        <Tile label="Products" value={c.products} />
        <Tile label="Locations" value={carriedCount(c)} />
        <Tile label="Own rows" value={c.ownRowProducts || 0} />
      </div>

      {panel === "rows" ? (
        <RowsPanel category={c} rows={rows} meta={rowsMeta} rowDraft={rowDraft} busy={busy}
          onRowField={onRowField} onSave={onSaveRows} onClose={() => onPanel("")} onNarrow={onOpenRows} />
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

          {c.isGroup && <MemberList group={c} onOpenMember={onOpenMember} />}

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
            {(unrenderedLegs || []).length > 0 && (
              <div style={{ color: RED, fontSize: ".8rem", width: "100%" }}>
                {unrenderedLegs.map(locLabel).join(", ")} holds numbers this editor cannot show — saving is blocked so it is not deleted.
              </div>
            )}
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

// ── THE LOCATIONS ────────────────────────────────────────────────────────────
// ONE BORDERED BOX PER LOCATION, and inside every one of them the three column
// headers sit directly over their own inputs, coloured to match each input's
// accent. That repetition is the point: the shipped screen drew the headers
// once at the top and a legend once at the bottom, so by the third shop nobody
// could see either, and the middle column was a number with no name.
//
// Validation errors render INSIDE the box they belong to, on their own row.
// They used to float under an input with a negative margin above the next
// control, which put "Keep is required" on top of the row below it.
const COL_TONE = { target: BLUE_L, minQty: AMBER, reorderPoint: GREEN };

function ColumnHeads({ lead = false }) {
  const heads = (
    <div className="ep-colhead">
      {FIELD_ORDER.map((f) => (
        <div key={f} style={{ textAlign: "center", color: COL_TONE[f], fontSize: ".68rem",
          fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{COLUMN_LABELS[f]}</div>
      ))}
    </div>
  );
  if (!lead) return heads;
  // A size run indents its rows behind the size label, so the header row needs
  // the same leading cell or every label sits one column to the left of the
  // input it names.
  return <div className="ep-sized"><div /><div>{heads}</div></div>;
}

function LocationTable({ category: c, rows, draft, errors, onField, onArm, onDrop, onQuickFill, onSwitchShape }) {
  const sizeRun = c.sizeRun || [];
  // A DERIVED RUN IS THE ONLY CONDITION. It used to also require the stored
  // policy to already be perSize, so a category that had never been given a
  // size-by-size policy could never be given one from this screen — the editor
  // existed and was reachable only where a script had already written the
  // shape. A one-size category still has no run, and still gets no editor.
  // (Fable review, PR #404.)
  const canPerSize = sizeRun.length > 0;
  return (
    <div>
      {rows.map((r) => {
        const row = draft[r.loc];
        const inDraft = !!row;
        const perSize = isPerSizeRow(row);
        return (
          <div key={r.loc} className="ep-box">
            <div className="ep-box-head">
              <span aria-hidden="true" style={{ fontSize: "1rem" }}>{locIcon(r.loc)}</span>
              <span className="ep-name" style={{ fontSize: ".95rem" }}>{locLabel(r.loc)}</span>
            </div>

            {inDraft && !perSize && (
              <>
                <ColumnHeads />
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
                {errors[r.loc] && <div className="ep-err">{errors[r.loc]}</div>}
              </>
            )}

            {inDraft && perSize && (
              <SizeRows loc={r.loc} row={row} sizeRun={sizeRun} errors={errors} category={c}
                onField={onField} onQuickFill={onQuickFill} />
            )}

            {!inDraft && (
              <>
                <ColumnHeads />
                <div className="ep-nums">
                  {FIELD_ORDER.map((f) => (
                    <div key={f} style={{ textAlign: "center", color: "#4b5563", fontSize: "1rem" }}>—</div>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                  <span style={{ color: r.carries ? "#6b7280" : AMBER, fontSize: ".76rem" }}>
                    {r.carries
                      ? `${r.productsCarried} carried, ${r.unitsHeld} units`
                      : "not carried here"}
                  </span>
                  <button onClick={() => onArm(r.loc, r.carries)}
                    style={{ ...(r.carries ? bGray : bRed), padding: "5px 10px", fontSize: ".73rem" }}>
                    {r.carries ? "Stock here" : "Arm this store"}
                  </button>
                </div>
              </>
            )}

            {inDraft && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
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
          </div>
        );
      })}

      {c.perSize && !sizeRun.length && (
        // THE STOP, in one line. A category the registry calls sized whose run
        // cannot be worked out from live data does not get a guessed list.
        <div style={{ color: AMBER, fontSize: ".8rem", padding: "4px 0 8px" }}>
          No size run can be worked out from the live data — size-by-size is not offered.
        </div>
      )}
    </div>
  );
}

// A location's size run, one row each, inside that location's box. The
// quick-fill copies the first size that has a number into every size — as its
// own row, which is the point.
function SizeRows({ loc, row, sizeRun, errors, category, onField, onQuickFill }) {
  const keys = [...new Set([...(sizeRun || []), ...Object.keys(row.sizes || {})])].sort(bySizeRank);
  const anyFilled = Object.values(row.sizes || {}).some((r) => String(r?.target ?? "").trim() !== "");
  const carriedBy = category?.sizeRunCarriedBy || null;
  const memberCount = (category?.memberCategoryKeys || []).length;
  return (
    <div>
      <ColumnHeads lead />
      {keys.map((k) => {
        const sr = row.sizes?.[k] || { target: "", minQty: "", reorderPoint: "" };
        const err = errors[`${loc}::${k}`];
        // A size only SOME of a group's categories carry is marked where it is
        // typed, not explained underneath. A number here reaches fewer products
        // than the size next to it, and that is worth one glyph.
        const partial = carriedBy && carriedBy[k] && carriedBy[k].length < memberCount;
        return (
          <div key={k}>
            <div className="ep-sized">
              <div style={{ color: GRAY, fontSize: ".8rem", fontWeight: 600 }}>
                {sizeLabel(k)}{partial ? <span title={`only ${carriedBy[k].join(", ")}`} style={{ color: AMBER }}> *</span> : null}
              </div>
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
            {err && <div className="ep-err">{err}</div>}
          </div>
        );
      })}
      {errors[loc] && <div className="ep-err">{errors[loc]}</div>}
      {anyFilled && (
        <button onClick={() => onQuickFill(loc, sizeRun)}
          style={{ ...bGhost, padding: "5px 10px", fontSize: ".73rem", marginTop: 8 }}>
          Same for every size
        </button>
      )}
    </div>
  );
}

// ── THE CATEGORIES INSIDE A GROUP ────────────────────────────────────────────
// Compact, tappable, and one short line above them for the only rule that is
// not visible from the numbers: a category with its own numbers ignores these
// entirely. Opening one gives it numbers of its own.
function MemberList({ group, onOpenMember }) {
  const members = group.members || [];
  if (!members.length) return null;
  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ color: GRAY, fontSize: ".75rem", marginBottom: 8 }}>
        A category with its own numbers ignores these.
      </div>
      <div className="ep-chips">
        {members.map((m) => (
          <button key={m.key} type="button" onClick={() => onOpenMember(m.key)}
            style={{ ...bGhost, padding: "6px 10px", fontSize: ".78rem", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{m.label}</span>
            <span style={{ color: "#6b7280" }}>{m.products ?? 0}</span>
            {m.ownRowCells > 0 && <Chip tone="amber">{m.ownRowCells} rows</Chip>}
            {m.hasOwnPolicy && <Chip tone="green">own numbers</Chip>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── THE PREVIEW ──────────────────────────────────────────────────────────────
// Four numbers and a button. Save stays off until it has run against the values
// currently on screen, and any edit — including one size inside a run —
// invalidates it.
function PreviewPanel({ preview, keyNow, cap, busy, category, errors, onRun }) {
  const stale = preview && preview.key !== keyNow;
  // A GROUP IS PREVIEWED AS "IF THIS WERE ARMED". The Sneakers group is
  // disarmed and stays disarmed, so its preview is explicitly about a world
  // that does not exist yet — said in the heading rather than left for somebody
  // to infer from a number.
  if (preview && !stale && preview.armModel) {
    const m = preview.armModel;
    const over = m.cap != null && m.totalRequests > m.cap;
    return (
      <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
        background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.3)" }}>
        <div style={{ fontWeight: 700, fontSize: ".9rem", color: BLUE_L }}>
          {preview.hypothetical ? "If this were armed" : "What happens on the next scan"}
        </div>
        <div className="ep-stats" style={{ margin: ".8rem 0" }}>
          <Stat label="Refills asked for" value={m.totalRequests} of={m.cap != null ? `of ${m.cap} per scan` : ""} warn={over} />
          <Stat label="Units wanted" value={m.totalUnits} />
          <Stat label="Categories" value={(m.perMember || []).length} />
          <Stat label="Over the limit" value={over ? "yes" : "no"} warn={over} />
        </div>
        <div style={{ fontSize: ".82rem", color: "#e5e7eb", lineHeight: 1.5 }}>
          {(m.perMember || []).filter((x) => x.requests > 0)
            .map((x) => `${x.key} ${x.requests}`).join(" · ") || "No category asks for anything."}
        </div>
        <button onClick={onRun} disabled={!!busy} style={{ ...bGray, marginTop: ".8rem", opacity: busy ? .5 : 1 }}>
          {busy === "preview" ? "Working…" : "Preview again"}
        </button>
      </div>
    );
  }
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
  // A GROUP WITH NO NUMBERS HAS NOTHING TO MODEL. Clearing a group's only leg
  // and pressing Preview returned armModel: null (the server only models a
  // policy that exists), and this function then read totalRequests off it and
  // white-screened the detail view. (Fable review, PR #404.)
  if (!m) {
    return (
      <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
        background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)" }}>
        <div style={{ fontWeight: 700, fontSize: ".9rem", color: AMBER }}>No numbers left</div>
        <div style={{ color: "#e5e7eb", fontSize: ".85rem", marginTop: 6 }}>
          Saving removes this policy — the engine falls back to its own rules.
        </div>
        <RunButton />
      </div>
    );
  }
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
      {previewVerdictParts(m, { cap }).map((line, i) => (
        <div key={i} style={{ fontSize: ".85rem", lineHeight: 1.5, color: "#e5e7eb", marginTop: i ? 4 : 0 }}>{line}</div>
      ))}
      <div style={{ marginTop: ".7rem", fontSize: ".74rem", color: "#4b5563", lineHeight: 1.5 }}>
        A ceiling — the scan can ask for less, never more.
        {category.ownRowProducts > 0 && ` ${category.ownRowProducts} products have their own rows and are not reached by these numbers.`}
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

      {/* One line each. The paragraph that used to sit here said the same thing
          four ways, and the standing rule for this screen is one short line per
          control, only where a number alone would be ambiguous. */}
      <div style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: ".8rem", fontSize: ".84rem", color: "#c9d3e6" }}>
        The engine reads a row before the category policy, so these numbers win.
        <div style={{ color: "#4b5563", fontSize: ".76rem", marginTop: 6 }}>Rows are never deleted here.</div>
      </div>

      {/* THE LIST IS CAPPED, AND IT SAYS SO. t-shirts has 1,870 rows; sending
          them all and drawing three inputs each was five and a half thousand
          inputs on a phone. A prefix shown silently would be worse than a
          prefix shown honestly. */}
      {rows && meta?.truncated && (
        <div style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: ".8rem",
          border: "1px solid rgba(251,191,36,.35)", color: AMBER, fontSize: ".82rem", lineHeight: 1.5 }}>
          Showing the first {rows.length} of {meta.matching} rows
          {meta.loc ? ` at ${locLabel(meta.loc)}` : ""}.{" "}
          {meta.narrowingHelps
            ? "Narrow to one location to see the rest."
            : "There is no further way to narrow this list yet — the rest are edited with a reviewed script."}
        </div>
      )}
      {rows && (meta?.locations || []).length > 1 && (
        <div className="ep-chips" style={{ marginBottom: ".8rem" }}>
          {/* Every count here is the FULL count for that location, whatever is
              currently narrowed to — the server counts all locations and
              narrows only the rows it returns. */}
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
